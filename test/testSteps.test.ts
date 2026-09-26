import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateLocally } from '../dist/localGenerator';
import { executeAgent } from '../dist/agent';
import { validateWithTsc } from '../dist/validator';
import { parseTestSteps, validateTestSteps } from '../dist/testSteps';
import { buildRepoContext } from '../dist/indexer';
import { writeGeneratedFiles } from '../dist/writer';
import { CacheEntry } from '../dist/cache';
import { rfiRecording, rfiSteps } from './fixtures/rfiRecording';

const source = `await page.goto('/login');
await page.getByRole('textbox', { name: 'Login' }).fill('sample-buyer');
await page.getByRole('textbox', { name: 'Password' }).fill('sample-password');
await page.getByRole('button', { name: 'Continue' }).click();`;
const notes = `# Buyer signs in
1. Open login page
2. Enter buyer username
3. Enter buyer password
4. Click Continue`;
const empty = { existingPages: [], conventions: null };
const noAI = async (): Promise<never> => { throw new Error('Unexpected AI/retrieval'); };
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-steps-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('English steps name all four outputs locally and generated files compile', async t => {
  const root = await fixture(t);
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const result = await executeAgent({ workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md', testSteps: notes }, { validate: validateWithTsc });
  assert.equal(result.aiRequests, 0);
  assert.ok(result.files.some(file => /buyer-signs-in-\w+\.spec\.ts$/.test(file)));
  const read = async (suffix: string) => fs.readFile(result.files.find(file => file.endsWith(suffix))!, 'utf8');
  assert.match(await read('.locators.ts'), /BUYER_USERNAME_FIELD: Locator = this.page.getByRole\("textbox", \{"name":"Login"\}\)/);
  assert.match(await read('login.page.ts'), /async enterBuyerUsername\(value: string\)/);
  assert.match(await read('.spec.ts'), /login.enterBuyerUsername\(data.buyerUsername\)/);
  assert.deepEqual(JSON.parse(await read('.data.json')), { title: 'Buyer signs in', loginPageUrl: '/login', buyerUsername: 'sample-buyer', buyerPassword: 'sample-password' });
  const again = await executeAgent({ workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md', testSteps: notes }, { validate: validateWithTsc });
  assert.deepEqual(again.written, []);
});

test('notes reuse established locator and method names without renaming existing members', async t => {
  const root = await fixture(t);
  const original = generateLocally(source, empty).result!;
  await writeGeneratedFiles(root, original.files);
  const result = generateLocally(source, { ...await buildRepoContext(root, 'pages', 'conventions.md'), testSteps: notes });
  assert.ok(result.result, result.reason);
  const changed = await writeGeneratedFiles(root, result.result.files);
  assert.ok(changed.every(file => !file.endsWith('.locators.ts') && !file.endsWith('.page.ts')));
  assert.match(result.result.files.find(file => file.path.endsWith('.spec.ts'))!.content, /fillLogin_\w+\(data.buyerUsername\)/);
});
test('ambiguous notes use recorded names with a visible notice and never invoke AI', async t => {
  const root = await fixture(t);
  let requests = 0;
  const options = { workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md', testSteps: 'Sign in as buyer and check the account.', maxCopilotRequests: 2, copilot: { complete: async () => { requests++; return ''; } } };
  const result = await executeAgent(options, { validate: async () => ({ ok: true, errors: '' }) });
  assert.equal(result.mode, 'local');
  assert.match(result.namingNotice!, /names came from the recording/);
  assert.equal(requests, 0);
  for (const text of [notes.replace('Click Continue', 'Enter Continue'), `${notes}\n5. Click Logout`]) {
    const partial = generateLocally(source, { ...empty, testSteps: text });
    assert.ok(partial.result);
    assert.ok(partial.namingNotice);
  }
  assert.ok(result.files.length);
});

test('naming notices survive cache reuse, explicit titles are kept, and invalid code still stops', async t => {
  const root = await fixture(t);
  const entries = new Map<string, CacheEntry>();
  const cache = { get: async (key: string) => entries.get(key), set: async (key: string, entry: CacheEntry) => { entries.set(key, entry); } };
  const opts = { workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md', testSteps: 'Test: Buyer signs in\nSign in using the account and check everything.', cache };
  const deps = { validate: async () => ({ ok: true, errors: '' }) };
  const first = await executeAgent(opts, deps);
  const cached = await executeAgent(opts, deps);
  assert.equal(cached.mode, 'cache'); assert.equal(cached.namingNotice, first.namingNotice);
  assert.match(cached.namingNotice!, /explicit test title was kept/);
  const data = JSON.parse(await fs.readFile(first.files.find(file => file.endsWith('.data.json'))!, 'utf8'));
  assert.equal(data.title, 'Buyer signs in');
  assert.equal(generateLocally('await customAction();', { ...empty, testSteps: opts.testSteps }).result, undefined);
});

test('reported RFI notes handle headings, a navigation typo, menus, and an extra recorded click', async t => {
  const parsed = parseTestSteps(rfiSteps);
  assert.equal(parsed.reason, undefined);
  assert.equal(parsed.steps.length, 9);
  const generated = generateLocally(rfiRecording, { ...empty, testSteps: rfiSteps });
  assert.ok(generated.result, generated.reason);
  assert.match(generated.namingNotice!, /9 of 10 recorded actions/);
  const locators = generated.result.files.find(file => file.path.endsWith('.locators.ts'))!.content;
  const page = generated.result.files.find(file => file.path.endsWith('/nova52-loginprocess.page.ts'))!.content;
  assert.match(locators, /PROJECT_LIST_ELEMENT: Locator = this.page.getByTestId\("project-list-5678"\)/);
  assert.match(locators, /SOURCING_1234_ELEMENT: Locator = this.page.getByTestId\("sourcing-1234"\)/);
  assert.match(locators, /SEARCH_LINK: Locator = this.page.locator.*contentFrame.*first\(\)/);
  assert.match(locators, /E_SOURCING_RFI_CHECKBOX/);
  assert.match(page, /async clickProjectList\(/);
  assert.match(page, /async clickSearch\(/);
  assert.match(page, /await popupPromise/);
  const data = JSON.parse(generated.result.files.find(file => file.path.endsWith('.data.json'))!.content);
  assert.equal(data.title, 'SSPSRM_eSourcing_RFI_001 - Verify RFI can be created.');
  const root = await fixture(t);
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const result = await executeAgent({ workspaceRoot: root, codegenSource: rfiRecording, testSteps: rfiSteps, conventionsFile: 'conventions.md' }, { validate: validateWithTsc });
  assert.equal(result.aiRequests, 0);
  assert.match(result.namingNotice!, /9 of 10/);
});

test('notes invalidate the cache and names do not overwrite another flow', async t => {
  const root = await fixture(t);
  const entries = new Map<string, CacheEntry>();
  const cache = { get: async (key: string) => entries.get(key), set: async (key: string, entry: CacheEntry) => { entries.set(key, entry); } };
  const opts = { workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md', testSteps: notes, cache };
  const deps = { validate: async () => ({ ok: true, errors: '' }) };
  const first = await executeAgent(opts, deps);
  assert.equal((await executeAgent(opts, deps)).mode, 'cache');
  const changed = await executeAgent({ ...opts, testSteps: notes.replace('Buyer signs in', 'Buyer opens their account') }, deps);
  assert.equal(changed.mode, 'local');
  assert.notEqual(first.files.find(file => file.endsWith('.spec.ts')), changed.files.find(file => file.endsWith('.spec.ts')));
  for (const entry of entries.values()) assert.ok(!JSON.stringify(entry).includes('Buyer signs in'));
});

test('step parsing handles Markdown and rejects oversized or ambiguous input', () => {
  assert.equal(parseTestSteps('Test: Sign in\n- [ ] Enter "sample" into buyer username field').steps[0].label, 'buyer username');
  assert.ok(parseTestSteps('1. Enter buyer username and password').reason);
  assert.throws(() => validateTestSteps('x'.repeat(12_001)), /12,000/);
  assert.throws(() => validateTestSteps('binary\0text'), /plain text/);
});
