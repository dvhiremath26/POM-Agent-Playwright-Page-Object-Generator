import { buildRepoContext } from './indexer';
import { generateLocally } from './localGenerator';
import { cacheMatches, fingerprint, RunCache, snapshot } from './cache';
import { FileTransaction, writeGeneratedFiles } from './writer';
import { validateWithTsc } from './validator';
import { extractPageMappings, loadPageMap, savePageMap } from './pageMap';
import { defaultDirectories, GenerationResult, OutputDirectories } from './types';
import { resolveInside } from './paths';
import { checkLocatorCompatibility } from './locatorCompatibility';
import { validateTestSteps } from './testSteps';
import { CopilotClient, organizeNames } from './copilotNaming';

export interface AgentOptions {
  workspaceRoot: string; codegenSource: string; conventionsFile: string;
  testSteps?: string;
  generationMode?: 'local' | 'copilot';
  copilotModel?: string;
  copilot?: CopilotClient;
  directories?: OutputDirectories;
  cache?: RunCache;
  report?: (message: string) => void;
  beforeWrite?: (files: GenerationResult['files']) => Promise<void>;
  isCancelled?: () => boolean;
}
export interface AgentResult { summary: string; written: string[]; files: string[]; retried: boolean; mode: 'local' | 'cache' | 'copilot'; aiRequests: number; namingNotice?: string }
export interface AgentDependencies {
  validate: typeof validateWithTsc;
  local?: typeof generateLocally;
}

export async function executeAgent(options: AgentOptions, dependencies: AgentDependencies = { validate: validateWithTsc }): Promise<AgentResult> {
  const { workspaceRoot: root, codegenSource } = options;
  const testSteps = validateTestSteps(options.testSteps ?? '');
  const dirs = options.directories ?? defaultDirectories;
  Object.values(dirs).forEach(dir => resolveInside(root, dir));
  const checkCancelled = (): void => { if (options.isCancelled?.()) throw new Error('Cancelled; no further requests will be made.'); };
  const useCopilot = options.generationMode === 'copilot';
  const cacheKey = fingerprint(JSON.stringify({ version: 10, root, codegenSource, testSteps, dirs, conventionsFile: options.conventionsFile, useCopilot, model: useCopilot ? options.copilotModel ?? '' : '' }));
  checkCancelled();
  const cached = await options.cache?.get(cacheKey);
  if (cached && await cacheMatches(root, cached)) {
    options.report?.('Rechecking unchanged cached output locally; no AI request…');
    const formatting: GenerationResult['files'] = cached.files.filter(file => file.endsWith('.locators.ts')).map(file => ({ path: file, mode: 'merge', content: '' }));
    const transaction = new FileTransaction();
    let written: string[] = [];
    try {
      if (formatting.length) {
        await options.beforeWrite?.(formatting);
        checkCancelled();
        written = await writeGeneratedFiles(root, formatting, transaction, dirs);
      }
      const validation = await dependencies.validate(root, cached.files.map(file => resolveInside(root, file)));
      checkCancelled();
      if (!validation.ok) throw new Error(`Cached output no longer passes TypeScript. Fix the workspace errors before retrying; no AI request was made.\n${validation.errors}`);
    } catch (error) { await transaction.rollback(); throw error; }
    if (written.length) {
      try { await options.cache?.set(cacheKey, { ...cached, hashes: await snapshot(root, Object.keys(cached.hashes)) }); }
      catch { options.report?.('Locator spacing was updated, but the local cache could not be saved.'); }
    }
    if (cached.namingNotice) options.report?.(cached.namingNotice);
    return { summary: written.length ? 'Reused validated output and updated locator spacing locally.' : 'Reused unchanged validated output.', written, files: cached.files.map(file => resolveInside(root, file)), retried: false, mode: 'cache', aiRequests: 0, namingNotice: cached.namingNotice };
  }
  options.report?.('Trying local AST conversion; no AI request…');
  const ctx = await buildRepoContext(root, dirs.pagesDir, options.conventionsFile);
  // Check workspace setup before generating or writing output.
  const baseline = await dependencies.validate(root);
  const noInputsYet = /^error TS18003: No inputs were found[^\n]*\s*$/.test(baseline.errors.trim());
  if (!baseline.ok && !noInputsYet) throw new Error(`The workspace already has TypeScript errors; fix these before generation. No AI request sent.\n${baseline.errors}`);
  checkLocatorCompatibility(root);
  ctx.pageMap = await loadPageMap(root);
  ctx.directories = dirs;
  if (testSteps) { ctx.testSteps = testSteps; options.report?.('Using English test steps as naming guidance; recorded actions and values remain authoritative.'); }
  const generate = dependencies.local ?? generateLocally;
  let local = generate(codegenSource, useCopilot ? { ...ctx, conventions: null } : ctx);
  let aiRequests = 0;
  if (useCopilot) {
    if (!local.result || !local.namingActions?.length) throw new Error(`This recording cannot yet be converted safely: ${local.reason} No Copilot request was made.`);
    if (!options.copilot) throw new Error('GitHub Copilot is not connected. Choose Local only or connect Copilot and try again.');
    checkCancelled();
    options.report?.('Retrieving relevant context locally, then asking GitHub Copilot to group logical screens and organize names (at most one request)…');
    const { namingNotice, ...namingPlan } = await organizeNames(options.copilot, local.namingActions, ctx);
    ctx.namingPlan = namingPlan;
    aiRequests = 1;
    checkCancelled();
    local = generate(codegenSource, ctx);
    if (namingNotice) local.namingNotice = namingNotice;
  }
  const generated = local.result;
  if (!generated) throw new Error(`Local conversion could not complete: ${local.reason} ${aiRequests ? 'Copilot naming was received, but safe code generation could not complete. No automatic retry was made.' : 'No AI request was made.'} Adjust the recording or test steps and try again.`);
  if (local.namingNotice) options.report?.(local.namingNotice);
  if (!generated.files.length) throw new Error(`No files generated: ${generated.summary}`);
  checkCancelled();
  await options.beforeWrite?.(generated.files);
  checkCancelled();
  const transaction = new FileTransaction();
  let written: string[];
  try {
    options.report?.('Merging new members and writing new files…');
    written = await writeGeneratedFiles(root, generated.files, transaction, dirs);
    options.report?.('Checking generated files with TypeScript…');
    const validation = await dependencies.validate(root, generated.files.map(file => resolveInside(root, file.path)));
    if (!validation.ok) throw new Error(validation.errors);
    checkCancelled();
  } catch (error) {
    await transaction.rollback();
    checkCancelled();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated changes were rolled back: ${message}. No AI repair is used.`);
  }
  const mappings = await extractPageMappings(root, generated.files);
  try { await savePageMap(root, { ...mappings, ...await loadPageMap(root) }); }
  catch (error) { throw new Error(`Generated files passed TypeScript validation, but pageMap.json could not be saved: ${String(error)}`); }
  if (options.cache) {
    try {
      const paths = [options.conventionsFile, 'tsconfig.json', 'package.json', 'pageMap.json',
        ...ctx.existingPages.map(file => file.relativePath),
        ...generated.files.map(file => file.path)];
      await options.cache.set(cacheKey, { files: generated.files.map(file => file.path), hashes: await snapshot(root, paths), namingNotice: local.namingNotice });
    } catch { options.report?.('Files validated, but the local cache could not be saved.'); }
  }
  return { summary: generated.summary, written, files: generated.files.map(file => resolveInside(root, file.path)), retried: false, mode: useCopilot ? 'copilot' : 'local', aiRequests, namingNotice: local.namingNotice };
}
