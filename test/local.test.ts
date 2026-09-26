import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateLocally } from '../dist/localGenerator';
import { executeAgent } from '../dist/agent';
import { selectRelevantContext } from '../dist/retrieval';
import { CacheEntry, RunCache } from '../dist/cache';
import { validateWithTsc } from '../dist/validator';
import { RepoContext } from '../dist/types';
import { enterpriseRecording } from './fixtures/enterpriseRecording';

const empty: RepoContext = { existingPages: [], conventions: null };
const recording = `import { test, expect } from '@playwright/test';
test('login flow', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Welcome')).toBeVisible();
});`;
async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-local-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}
const memoryCache = (): RunCache => {
  const entries = new Map<string, CacheEntry>();
  return { get: async key => entries.get(key), set: async (key, entry) => { entries.set(key, entry); } };
};
const okay = async () => ({ ok: true, errors: '' });
const noAI = async (): Promise<never> => { throw new Error('AI must not be called'); };

test('local converter creates complete POM and extracts test values', () => {
  const result = generateLocally(recording, empty).result;
  assert.ok(result);
  assert.equal(result.files.length, 5);
  const testFile = result.files.find(file => file.path.endsWith('.spec.ts'))!;
  assert.doesNotMatch(testFile.content, /getBy|user@example.com|secret|Sign in/);
  const data = JSON.parse(result.files.find(file => file.path.endsWith('.json'))!.content);
  assert.ok(Object.values(data).includes('user@example.com'));
  const page = result.files.find(file => file.path.endsWith('login.page.ts'))!;
  assert.match(page.content, /extends BasePage/);
  assert.match(page.content, /expect\(this.locators/);
});

test('local converter rejects unsupported constructs without dropping steps', () => {
  for (const source of [
    `${recording}\nconsole.log('side effect')`,
    recording.replace("await page.getByRole('button', { name: 'Sign in' }).click();", 'for (const x of rows) { await page.click(x); }'),
    recording.replace("page.getByLabel('Email')", 'page.locator(selectorVariable)'),
    recording.replace(".fill('secret')", '.fill(passwordVariable)'),
    recording.replace("test('login flow'", "test.skip('login flow'"),
    recording.replace("await page.goto('https://example.com/login');", ''),
    recording.replace("page.getByLabel('Email')", "page.getByRole('textbox', { name: /email/i })"),
  ]) assert.equal(generateLocally(source, empty).result, undefined);
});

test('local converter defers custom conventions and existing custom pages', () => {
  assert.equal(generateLocally(recording, { ...empty, conventions: 'Use our fixture.' }).result, undefined);
  assert.equal(generateLocally(recording, { ...empty, existingPages: [{ relativePath: 'pages/login/login.page.ts', content: 'export class LoginPage {}' }] }).result, undefined);
});

test('supported conversion uses zero AI requests and does not perform supporting RAG', async t => {
  const root = await fixture(t);
  const result = await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: recording }, {
    validate: okay,
  });
  assert.equal(result.aiRequests, 0);
  assert.equal(result.mode, 'local');
  assert.equal(result.written.length, 5);
});

test('validated cache avoids both retrieval and generation; modified output invalidates it', async t => {
  const root = await fixture(t);
  const cache = memoryCache();
  const options = { workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: recording, cache };
  const first = await executeAgent(options, { validate: okay });
  const second = await executeAgent(options, { local: () => { throw new Error('Local generator should be skipped'); }, validate: okay });
  assert.equal(second.mode, 'cache');
  assert.equal(second.aiRequests, 0);
  await fs.appendFile(first.written.find(file => file.endsWith('.spec.ts'))!, '// edited\n');
  await assert.rejects(executeAgent(options, { local: () => { throw new Error('Cache invalidated'); }, validate: okay }), /Cache invalidated/);
});

test('local-only setting rejects unsupported input without retrieval or AI', async t => {
  const root = await fixture(t);
  await assert.rejects(executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: 'await customFlow();' }, {
    validate: okay,
  }), /Local conversion could not complete/);
});
test('pre-existing compiler errors stop generation', async t => {
  const root = await fixture(t);
  await assert.rejects(executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: recording }, {
    validate: async () => ({ ok: false, errors: 'Existing TS2322' }),
  }), /already has TypeScript errors/);
});

test('local lexical RAG chooses relevant whole sources and enforces bounds', () => {
  const ctx: RepoContext = { existingPages: [
    { relativePath: 'pages/login/login.page.ts', content: 'export class LoginPage { signIn() {} }' },
    { relativePath: 'pages/billing/billing.page.ts', content: 'export class Invoice { invoiceTotal() {} }' },
  ], conventions: null, pageMap: { '/login': 'LoginPage' } };
  const selected = selectRelevantContext('await page.goto("/login")', ctx, 200, 1);
  assert.deepEqual(selected.existingPages.map(file => file.relativePath), ['pages/login/login.page.ts']);
  assert.equal(selected.omittedContext, 1);
  assert.equal(selectRelevantContext('login', ctx, 1, 1).existingPages.length, 0);
  assert.throws(() => selectRelevantContext('login', { ...ctx, conventions: 'too long' }, 1));
});
test('locally generated POM compiles against actual Playwright and extends idempotently', async t => {
  const root = await fixture(t);
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const options = { workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: recording };
  const first = await executeAgent(options, { validate: validateWithTsc });
  assert.equal(first.mode, 'local');
  const second = await executeAgent(options, { validate: validateWithTsc });
  assert.deepEqual(second.written, []);
  const extended = await executeAgent({ ...options, codegenSource: recording.replace("await expect(page.getByText('Welcome')).toBeVisible();", "await expect(page.getByText('Welcome')).toBeVisible();\nawait page.getByRole('link', { name: 'Settings' }).click();") }, { validate: validateWithTsc });
  assert.equal(extended.aiRequests, 0);
  assert.ok(extended.written.some(file => file.endsWith('login.page.ts')));
});

test('redacted enterprise recording with popup and nested frames compiles locally with zero AI requests', async t => {
  const root = await fixture(t);
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const result = await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: enterpriseRecording }, { validate: validateWithTsc });
  assert.equal(result.aiRequests, 0); assert.equal(result.mode, 'local');
  const pageFile = result.files.find(file => file.endsWith('/loginprocess.page.ts') || file.endsWith('nova52-loginprocess.page.ts'))!;
  const page = await fs.readFile(pageFile, 'utf8');
  assert.match(page, /openAndWaitForPopup/);
  assert.ok(page.indexOf('waitForEvent("popup")') < page.indexOf('await this.page.goto(url)'));
  assert.match(page, /await popupPromise/);
  const locators = await fs.readFile(result.files.find(file => file.endsWith('.locators.ts'))!, 'utf8');
  assert.match(locators, /contentFrame\(\).*contentFrame\(\)/);
  assert.match(locators, /\.first\(\)/);
  assert.match(locators, /Recorded CSS\/XPath retained/);
});

test('unsupported popup usage is never discarded; fallback reason names its line', () => {
  const usedPopup = enterpriseRecording.replace("await page.getByRole('textbox', { name: 'Login' }).fill('test-buyer')", "await page1.getByRole('textbox', { name: 'Login' }).fill('test-buyer')");
  const result = generateLocally(usedPopup, empty);
  assert.equal(result.result, undefined);
  assert.match(result.reason, /line \d+.*VariableStatement/);
  const unsupported = generateLocally("await page.goto('/login');\nawait page.locator(selector).click();", empty);
  assert.match(unsupported.reason, /line 2.*Unsupported locator/);
});
