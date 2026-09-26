import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { ContextFile, RepoContext } from './types';
import { safePath } from './paths';

const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.env', '.codex']);
export async function readOptional(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function walk(root: string, relative: string, result: string[]): Promise<void> {
  const folder = relative ? await safePath(root, relative) : root;
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.')) continue;
    const next = [relative, entry.name].filter(Boolean).join('/');
    if (entry.isDirectory()) await walk(root, next, result);
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(next);
  }
}

export async function buildRepoContext(workspaceRoot: string, pagesDir: string, conventionsFile: string): Promise<RepoContext> {
  const files: string[] = [];
  await walk(workspaceRoot, pagesDir, files);
  const existingPages = await Promise.all(files.map(async relativePath => ({
    relativePath, content: await readFile(await safePath(workspaceRoot, relativePath), 'utf8'),
  })));
  const conventions = await readOptional(await safePath(workspaceRoot, conventionsFile));
  return { existingPages, conventions };
}

/** Local source retrieval: retain all page objects; retrieve utility definitions and import dependencies. */
export async function retrieveSupportingContext(root: string, ctx: RepoContext): Promise<ContextFile[]> {
  const files: string[] = [];
  await walk(root, '', files);
  const known = new Set(ctx.existingPages.map(file => file.relativePath));
  const retrieved: ContextFile[] = [];
  // Pin the provider and base class even when no page imports them yet.
  for (const relativePath of files) {
    if (known.has(relativePath) || /(?:\.spec|\.test|\.d)\.ts$/.test(relativePath)) continue;
    const content = await readFile(await safePath(root, relativePath), 'utf8');
    if (/\b(?:class\s+BasePage|(?:function|const|class)\s+dataProviderTest)\b/.test(content)) {
      retrieved.push({ relativePath, content }); known.add(relativePath);
    }
  }
  const queue = [...ctx.existingPages, ...retrieved];
  for (let i = 0; i < queue.length; i++) {
    for (const match of queue[i].content.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(queue[i].relativePath), match[1]));
      for (const candidate of [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')]) {
        if (!files.includes(candidate) || known.has(candidate)) continue;
        const item = { relativePath: candidate, content: await readFile(await safePath(root, candidate), 'utf8') };
        retrieved.push(item); queue.push(item); known.add(candidate); break;
      }
    }
  }
  const config = await readOptional(await safePath(root, 'tsconfig.json'));
  if (config) retrieved.push({ relativePath: 'tsconfig.json', content: config });
  return retrieved;
}
