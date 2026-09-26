import { GeneratedFile } from '../dist/types';
import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildRepoContext, retrieveSupportingContext } from '../dist/indexer';
import { writeGeneratedFiles, FileTransaction } from '../dist/writer';
import { executeAgent } from '../dist/agent';
import { loadPageMap, extractPageMappings } from '../dist/pageMap';
import { validateWithTsc } from '../dist/validator';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root: string, file: string, content: string) {
  const full = path.join(root, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
const file = (name: string, content: string, mode: GeneratedFile['mode'] = 'create'): GeneratedFile => ({ path: name, content, mode });
const opts = (root: string) => ({ workspaceRoot: root, codegenSource: 'await page.goto("/login")', conventionsFile: 'conventions.md' });
test('local RAG retrieves all pages, conventions, provider, base and transitive imports', async t => {
  const root = await fixture(t);
  await put(root, 'pages/login/login.page.ts', 'import { BasePage } from "../../shared/base"; export class LoginPage extends BasePage {}');
  await put(root, 'pages/home/home.page.ts', 'export class HomePage {}');
  await put(root, 'shared/base.ts', 'import { helper } from "./helper"; export class BasePage {}');
  await put(root, 'shared/helper.ts', 'export const helper = 1;');
  await put(root, 'utils/data.ts', 'export const dataProviderTest = () => {};');
  await put(root, 'utils/unrelated.ts', 'const secret = 1;');
  await put(root, 'conventions.md', 'Use semantic actions.');
  await put(root, 'node_modules/ignored.ts', 'export class BasePage {}');
  const ctx = await buildRepoContext(root, 'pages', 'conventions.md');
  assert.equal(ctx.existingPages.length, 2);
  assert.equal(ctx.conventions, 'Use semantic actions.');
  ctx.supportingFiles = await retrieveSupportingContext(root, ctx);
  assert.deepEqual(ctx.supportingFiles.map(f => f.relativePath).sort(), ['shared/base.ts', 'shared/helper.ts', 'utils/data.ts']);
});

test('missing optional context is empty', async t => {
  assert.deepEqual(await buildRepoContext(await fixture(t), 'pages', 'conventions.md'), { existingPages: [], conventions: null });
});
test('merges preserve existing members, initialize new locators and are idempotent', async t => {
  const root = await fixture(t);
  const target = 'pages/login/login.locators.ts';
  const original = 'import type { Page, Locator } from "@playwright/test";\nexport class LoginLocators {\n readonly userInput: Locator;\n constructor(page: Page) { this.userInput = page.getByRole("textbox"); }\n old() { return 7; }\n}\n';
  await put(root, target, original);
  const fragment = 'readonly submitBtn: Locator;\nconstructor(page: Page) { this.submitBtn = page.getByRole("button"); }\nold() { return 9; }\nasync submit() { await this.submitBtn.click(); }';
  const generated = [file(target, fragment, 'merge')];
  await writeGeneratedFiles(root, generated);
  const merged = await fs.readFile(path.join(root, target), 'utf8');
  assert.match(merged, /return 7/);
  assert.doesNotMatch(merged, /return 9/);
  assert.match(merged, /this.submitBtn = page.getByRole/);
  assert.equal((merged.match(/constructor\(/g) || []).length, 1);
  assert.deepEqual(await writeGeneratedFiles(root, generated), []);
  assert.equal(await fs.readFile(path.join(root, target), 'utf8'), merged);
});

test('stages whole batch before writing; refuses overwrite and out-of-scope paths', async t => {
  const root = await fixture(t);
  await put(root, 'pages/existing.ts', 'export class Existing {}');
  for (const invalid of ['../outside.ts', '/outside.ts', 'C:/outside.ts', 'pages/../../outside.ts', '.vscode/settings.json', 'pages/no.js']) {
    await assert.rejects(writeGeneratedFiles(root, [file('pages/new.ts', 'export class New {}'), file(invalid, '{}')]));
    await assert.rejects(fs.access(path.join(root, 'pages/new.ts')));
  }
  await assert.rejects(writeGeneratedFiles(root, [file('pages/existing.ts', 'overwrite')]));
  assert.equal(await fs.readFile(path.join(root, 'pages/existing.ts'), 'utf8'), 'export class Existing {}');
});

test('rejects class-fragment escape and constructor side effects', async t => {
  const root = await fixture(t);
  await put(root, 'pages/a.ts', 'class A { constructor(page: string) {} }');
  await assert.rejects(writeGeneratedFiles(root, [file('pages/a.ts', '}\nprocess.exit();\nclass Evil {', 'merge')]));
  await assert.rejects(writeGeneratedFiles(root, [file('pages/a.ts', 'constructor(page: string) { doSomething(); }', 'merge')]));
});

test('rejects directory junctions escaping the workspace', async t => {
  const root = await fixture(t);
  const external = await fixture(t);
  await fs.symlink(external, path.join(root, 'pages'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeGeneratedFiles(root, [file('pages/escape.ts', 'export {}')]));
  await assert.rejects(fs.access(path.join(external, 'escape.ts')));
});

test('rollback restores originals and removes creations', async t => {
  const root = await fixture(t);
  const original = 'export class A {}';
  await put(root, 'pages/a.ts', original);
  const transaction = new FileTransaction();
  await writeGeneratedFiles(root, [file('pages/a.ts', 'hello() {}', 'merge'), file('tests/a.spec.ts', 'export {}')], transaction);
  await transaction.rollback();
  assert.equal(await fs.readFile(path.join(root, 'pages/a.ts'), 'utf8'), original);
  await assert.rejects(fs.access(path.join(root, 'tests/a.spec.ts')));
});

test('rollback preserves concurrent edits and reports conflict', async t => {
  const root = await fixture(t);
  const transaction = new FileTransaction();
  await writeGeneratedFiles(root, [file('pages/a.ts', 'export class A {}')], transaction);
  await put(root, 'pages/a.ts', 'user changes');
  await assert.rejects(transaction.rollback(), /changed externally/);
  assert.equal(await fs.readFile(path.join(root, 'pages/a.ts'), 'utf8'), 'user changes');
});
test('local validation failure rolls back without a model call or repair retry', async t => {
  const root = await fixture(t);
  let generations = 0, checks = 0;
  await assert.rejects(executeAgent(opts(root), {
    local: () => { generations++; return { reason: 'Local output', result: { files: [file('pages/a.ts', 'export class A {}')], summary: 'Generated locally' } }; },
    validate: async () => ++checks === 1 ? { ok: true, errors: '' } : { ok: false, errors: 'TS2322' },
  }), /rolled back.*TS2322/);
  assert.equal(generations, 1); assert.equal(checks, 2);
  await assert.rejects(fs.access(path.join(root, 'pages/a.ts')));
  assert.deepEqual(await loadPageMap(root), {});
});

test('map extraction reads full merged class and respects custom directories', async t => {
  const root = await fixture(t);
  const files = [file('app/screens/login/login.page.ts', 'export class LoginPage {}')];
  await writeGeneratedFiles(root, files, undefined, { pagesDir: 'app/screens', testsDir: 'e2e', testDataDir: 'fixtures' });
  assert.deepEqual(await extractPageMappings(root, files), { '/login': 'LoginPage' });
});

test('real TypeScript validation reports errors and accepts corrected code', async t => {
  const root = await fixture(t);
  await put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, include: ['pages/**/*.ts'] }));
  await put(root, 'node_modules/typescript/bin/tsc', `require(${JSON.stringify(require.resolve('typescript/lib/tsc.js'))});`);
  await put(root, 'pages/a.ts', 'const value: number = "wrong";');
  const failed = await validateWithTsc(root);
  assert.equal(failed.ok, false);
  assert.match(failed.errors, /TS2322/);
  await put(root, 'pages/a.ts', 'const value: number = 7;');
  assert.equal((await validateWithTsc(root)).ok, true);
  await put(root, 'tests/excluded.spec.ts', 'const invalid: number = "excluded";');
  const excluded = await validateWithTsc(root, [path.join(root, 'tests/excluded.spec.ts')]);
  assert.equal(excluded.ok, false);
  assert.match(excluded.errors, /excluded by tsconfig/);
});
