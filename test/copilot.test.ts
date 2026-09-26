import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as Vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createCopilotClient, isEligibleCopilotModel } from '../dist/copilot';
import { namingPrompt, parseNamingPlan } from '../dist/copilotNaming';
import { generateLocally } from '../dist/localGenerator';
import { executeAgent } from '../dist/agent';
import { CacheEntry } from '../dist/cache';
import { validateWithTsc } from '../dist/validator';
import { rfiRecording, rfiSteps } from './fixtures/rfiRecording';
import { pageGroupSlug } from '../dist/pageGrouping';

const labels = ['SSP SRM', 'Username', 'Password', 'Continue', 'Sourcing', 'Project List', 'Search', 'New', 'e Sourcing RFI', 'Apply'];
const actions = generateLocally(rfiRecording, { existingPages: [], conventions: null }).namingActions!;
const plan = { title: 'Create an RFI', steps: actions.map((action, i) => ({ action: action.action, label: labels[i], page: i < 4 ? 'login' : i < 6 ? 'navigation' : i < 8 ? 'project-list' : 'rfi-creation' })) };

test('Copilot naming suggestions cannot change selectors, actions, count or executable code', () => {
  assert.equal(parseNamingPlan(JSON.stringify(plan), actions).steps[6].label, 'Search');
  for (const variant of [
    { ...plan, files: [] }, { ...plan, steps: plan.steps.slice(1) },
    { ...plan, steps: plan.steps.map((step, i) => i === 1 ? { ...step, action: 'click' } : step) },
    { ...plan, steps: plan.steps.map((step, i) => i === 1 ? { ...step, target: 'page.locator("wrong")' } : step) },
    { ...plan, steps: plan.steps.map((step, i) => i === 1 ? { ...step, label: 'x); malicious()' } : step) },
  ]) {
    const parsed = parseNamingPlan(JSON.stringify(variant), actions);
    assert.deepEqual(parsed.steps.map(step => step.action), actions.map(action => action.action));
    assert.ok(parsed.steps.every(step => Object.keys(step).every(key => ['action', 'label', 'page'].includes(key))));
    assert.ok(parsed.steps.every(step => !/[();]/.test(step.label)));
    assert.equal('files' in parsed, false);
  }
});

test('indexed response accepts metadata, formatting, punctuation and reordered rows without shifting actions', () => {
  const indexed = { ...plan, explanation: 'Naming only', steps: plan.steps.map((step, index) => ({ ...step, index: String(index + 1), explanation: 'label' })).reverse() };
  indexed.steps[1].label = 'e-Sourcing / RFI (checkbox)';
  const parsed = parseNamingPlan(`Here are the names:\n\`\`\`json\n${JSON.stringify(indexed)}\n\`\`\``, actions);
  assert.equal(parsed.namingNotice, undefined);
  assert.equal(parsed.steps[6].label, 'Search');
  assert.equal(parsed.steps[8].label, 'e-Sourcing RFI checkbox');
  assert.deepEqual(parsed.steps.map(step => step.action), actions.map(action => action.action));
});

test('missing, duplicate and wrong-action indices use local names while uniquely matched names survive', () => {
  const parsed = parseNamingPlan(JSON.stringify({ title: 'Partial response', steps: [
    { index: 7, action: 'click', label: 'Search projects' },
    { index: 2, action: 'click', label: 'Wrong action' },
    { index: 3, action: 'fill', label: 'First duplicate' }, { index: 3, action: 'fill', label: 'Second duplicate' },
    { index: 999, action: 'click', label: 'Invented action' }, { action: 'click', label: 'Unindexed action' },
  ] }), actions, { existingPages: [], conventions: null, testSteps: rfiSteps });
  assert.equal(parsed.steps[6].label, 'Search projects');
  assert.equal(parsed.steps[1].label, 'Username'); assert.equal(parsed.steps[2].label, 'Password');
  assert.match(parsed.namingNotice!, /1 of 10/);
  assert.equal(parsed.title, 'SSPSRM_eSourcing_RFI_001 - Verify RFI can be created.');
  assert.deepEqual(parsed.steps.map(step => step.action), actions.map(action => action.action));
});

test('unindexed omissions and malformed responses fall back without guessing alignment or throwing', () => {
  for (const response of ['{}', 'null', 'not JSON', '{"steps": [', JSON.stringify({ ...plan, steps: plan.steps.slice(1) }),
    JSON.stringify({ ...plan, steps: plan.steps.map((step, index) => ({ ...step, index })) }),
    JSON.stringify({ ...plan, steps: plan.steps.map(step => ({ action: step.action, label: {} })) }),
  ]) {
    const parsed = parseNamingPlan(response, actions);
    assert.deepEqual(parsed.steps, actions.map(action => ({ action: action.action, label: action.label })));
    assert.match(parsed.namingNotice!, /0 of 10/);
  }
});

test('naming prompt omits fill values and existing method bodies', () => {
  const prompt = namingPrompt(actions, { existingPages: [{ relativePath: 'pages/sourcing.ts', content: 'class SourcingPage { openSourcing() { const password = "do-not-send"; } }' }], conventions: null, testSteps: rfiSteps });
  assert.match(prompt, /openSourcing/);
  assert.doesNotMatch(prompt, /sample-password|sample-buyer|do-not-send|https:\/\/example/);
});

test('Copilot mode uses one request, keeps explicit title and frame chains, and caches without another request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-copilot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const entries = new Map<string, CacheEntry>();
  let requests = 0;
  const options = { workspaceRoot: root, conventionsFile: 'conventions.md', codegenSource: rfiRecording, testSteps: rfiSteps,
    generationMode: 'copilot' as const, cache: { get: async (key: string) => entries.get(key), set: async (key: string, entry: CacheEntry) => { entries.set(key, entry); } },
    copilot: { complete: async () => { requests++; return JSON.stringify(plan); } } };
  const validate = validateWithTsc;
  const legacy = await executeAgent({ ...options, generationMode: 'local', cache: undefined }, { validate });
  const legacyContents = await Promise.all(legacy.files.map(file => fs.readFile(file, 'utf8')));
  const first = await executeAgent(options, { validate });
  assert.equal(first.mode, 'copilot'); assert.equal(first.aiRequests, 1); assert.equal(first.namingNotice, undefined);
  assert.equal(first.files.filter(file => file.endsWith('.locators.ts')).length, 4);
  assert.match(first.summary, /4 page/);
  const locatorFile = (await Promise.all(first.files.filter(file => file.endsWith('.locators.ts')).map(file => fs.readFile(file, 'utf8')))).join('\n');
  assert.match(locatorFile, /SEARCH_LINK/); assert.match(locatorFile, /PROJECT_LIST_ELEMENT/);
  const originalLocators = generateLocally(rfiRecording, { existingPages: [], conventions: null }).namingActions!.flatMap(action => action.target ? [action.target.replace(/^page\./, 'this.page.')] : []);
  for (const chain of originalLocators) assert.ok(locatorFile.includes(chain));
  const data = JSON.parse(await fs.readFile(first.files.find(file => file.endsWith('.data.json'))!, 'utf8'));
  assert.equal(data.title, 'SSPSRM_eSourcing_RFI_001 - Verify RFI can be created.');
  assert.equal(data.password, 'sample-password');
  assert.match(await fs.readFile(first.files.find(file => file.endsWith('project-list.page.ts'))!, 'utf8'), /async clickSearch\(\): Promise<void> \{\n    await this.locators.SEARCH_LINK.click\(\);\n  \}/);
  const login = await fs.readFile(first.files.find(file => file.endsWith('login.page.ts'))!, 'utf8');
  assert.match(login, /enterPassword/); assert.doesNotMatch(login, /clickSearch|clickNew|checkESourcing/);
  const flow = await fs.readFile(first.files.find(file => file.endsWith('.spec.ts'))!, 'utf8');
  assert.match(flow, /new LoginPage\(page\)/); assert.match(flow, /new NavigationPage\(page\)/);
  assert.match(flow, /new ProjectListPage\(page\)/); assert.match(flow, /new RfiCreationPage\(page\)/);
  assert.doesNotMatch(flow, /Nova52Loginprocess/);
  assert.deepEqual(await Promise.all(legacy.files.map(file => fs.readFile(file, 'utf8'))), legacyContents, 'The old monolithic outputs are preserved; new tests use the grouped classes');
  assert.equal((await executeAgent(options, { validate })).mode, 'cache'); assert.equal(requests, 1);
  assert.deepEqual((await executeAgent({ ...options, cache: undefined }, { validate })).written, [], 'Repeated grouped generation reuses classes and members');
  assert.equal(requests, 2);
  const local = await executeAgent({ ...options, generationMode: 'local' }, { validate });
  assert.equal(local.mode, 'local'); assert.equal(requests, 2, 'local-only never invokes Copilot');
  await assert.rejects(executeAgent({ ...options, codegenSource: 'await customFlow();' }, { validate }), /No Copilot request/);
  assert.equal(requests, 2, 'unsupported source stops before spending credits');
});

test('logical page names are safe and normalized; missing groups are reported instead of silently claiming organization', () => {
  assert.equal(pageGroupSlug('ProjectListPage'), 'project-list');
  assert.equal(pageGroupSlug('RFICreation'), 'rfi-creation');
  for (const name of ['../../outside', 'pages/login.ts', 'BasePage', 'CON', 'nul', '', 'a'.repeat(101)]) assert.equal(pageGroupSlug(name), undefined);
  const parsed = parseNamingPlan(JSON.stringify({ ...plan, steps: plan.steps.map((step, index) => ({ ...step, page: index < 2 ? '../../outside' : step.page })) }), actions);
  assert.equal(parsed.steps[0].page, undefined);
  assert.equal(parsed.steps[6].page, 'project-list');
  assert.match(parsed.namingNotice!, /screen groups for 8 of 10/);
});

test('invalid naming completes locally with a cached notice and no retry; cancellation still prevents writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-copilot-stop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0, cancelled = false;
  const entries = new Map<string, CacheEntry>();
  const options = { workspaceRoot: root, codegenSource: rfiRecording, conventionsFile: 'conventions.md', generationMode: 'copilot' as const,
    testSteps: rfiSteps, cache: { get: async (key: string) => entries.get(key), set: async (key: string, entry: CacheEntry) => { entries.set(key, entry); } },
    isCancelled: () => cancelled, copilot: { complete: async () => { calls++; return '{}'; } } };
  const validate = async () => ({ ok: true, errors: '' });
  const result = await executeAgent(options, { validate });
  assert.match(result.namingNotice!, /0 of 10/); assert.equal(result.aiRequests, 1);
  assert.ok(result.written.length > 0);
  assert.equal(calls, 1);
  const cached = await executeAgent(options, { validate });
  assert.equal(cached.mode, 'cache'); assert.equal(cached.namingNotice, result.namingNotice); assert.equal(calls, 1);
  const before = await Promise.all(result.files.map(file => fs.readFile(file, 'utf8')));
  await assert.rejects(executeAgent({ ...options, cache: undefined, copilot: { complete: async () => { cancelled = true; return JSON.stringify(plan); } },
    beforeWrite: async () => { assert.fail('Cancelled response must never reach writing'); },
  }, { validate }), /Cancelled/);
  assert.deepEqual(await Promise.all(result.files.map(file => fs.readFile(file, 'utf8'))), before);
  cancelled = false;
  await assert.rejects(executeAgent({ ...options, cache: undefined, copilot: { complete: async () => { throw new Error('Copilot authentication failed'); } } }, { validate }), /authentication failed/);
});

function mockApi(ids: string[], options: { fail?: boolean; tokens?: number; chooseId?: string; cancelPicker?: boolean } = {}) {
  let requests = 0;
  const sentModels: string[] = [];
  const picks: string[][] = [];
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const api = {
    lm: { selectChatModels: async () => ids.map(id => ({ id, vendor: 'copilot', family: id, name: id, maxInputTokens: 10000,
      countTokens: async () => options.tokens ?? 100,
      sendRequest: async () => { requests++; sentModels.push(id); if (options.fail) throw new Error('model_not_supported'); return { text: (async function* () { yield JSON.stringify(plan); })() }; },
    })) },
    window: { showQuickPick: async (items: { model: { id: string } }[]) => {
      picks.push(items.map(item => item.model.id));
      return options.cancelPicker ? undefined : options.chooseId ? items.find(item => item.model.id === options.chooseId) : items[0];
    } },
    LanguageModelChatMessage: { User: (content: string) => ({ content }) },
    CancellationTokenSource: class { token = { ...token }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  } as unknown as typeof Vscode;
  return { api, token: token as Vscode.CancellationToken, requests: () => requests, sentModels, picks };
}

test('Copilot selects only public non-Claude Copilot models; unsupported endpoint is not retried', async () => {
  for (const id of ['claude-sonnet', 'anthropic-x', 'auto', 'copilot-utility', 'copilot-utility-small', 'copilot-dictation-cleanup-luna']) {
    assert.equal(isEligibleCopilotModel({ vendor: 'copilot', id, family: id, name: 'GPT' }), false);
  }
  assert.equal(isEligibleCopilotModel({ vendor: 'other', id: 'gpt-4o', family: 'gpt', name: 'GPT' }), false);
  const mock = mockApi(['copilot-utility', 'claude-sonnet', 'gpt-4o', 'gpt-5-mini'], { fail: true, chooseId: 'gpt-5-mini' });
  const client = createCopilotClient({ modelId: '', maxInputTokens: 6000, token: mock.token, report() {} }, mock.api);
  assert.equal(mock.requests(), 0);
  await assert.rejects(client.complete('instruction', 'prompt'), /No automatic retry/);
  assert.deepEqual(mock.sentModels, ['gpt-5-mini']); assert.equal(mock.requests(), 1);
  assert.deepEqual(mock.picks, [['gpt-4o', 'gpt-5-mini']]);
});

test('token budget, configured model, and cancellation checks happen before a Copilot request', async () => {
  const mock = mockApi(['gpt-4o'], { tokens: 5000 });
  const options = { modelId: '', maxInputTokens: 6000, token: mock.token, report() {} };
  await assert.rejects(createCopilotClient(options, mock.api).complete('a', 'b'), /token budget/);
  await assert.rejects(createCopilotClient({ ...options, modelId: 'copilot-utility' }, mock.api).complete('a', 'b'), /token budget/);
  await assert.rejects(createCopilotClient({ ...options, token: { ...mock.token, isCancellationRequested: true } }, mock.api).complete('a', 'b'), /Cancelled/);
  assert.equal(mock.requests(), 0);
});

test('Copilot transport collects a streamed naming response with a single request', async () => {
  const mock = mockApi(['gpt-4o']);
  const reports: string[] = [];
  const result = await createCopilotClient({ modelId: 'gpt-4o', maxInputTokens: 6000, token: mock.token, report: message => reports.push(message) }, mock.api).complete('instructions', 'prompt');
  assert.deepEqual(parseNamingPlan(result, actions), plan);
  assert.equal(mock.requests(), 1); assert.deepEqual(mock.sentModels, ['gpt-4o']);
  assert.deepEqual(mock.picks, [['gpt-4o']], 'A single eligible model still requires selection');
  assert.match(reports[0], /1\/1.*264 input tokens/);
});

test('configured preference appears first but the user controls the model used', async () => {
  const mock = mockApi(['gpt-full', 'gpt-mini', 'gpt-nano'], { chooseId: 'gpt-full' });
  const client = createCopilotClient({ modelId: ' gpt-nano ', maxInputTokens: 6000, token: mock.token, report() {} }, mock.api);
  assert.deepEqual(mock.picks, [], 'No picker until a request is needed');
  await client.complete('a', 'b');
  assert.equal(mock.picks[0][0], 'gpt-nano');
  assert.deepEqual(mock.sentModels, ['gpt-full']);
});

test('missing or blocked saved model requires a user choice rather than automatic substitution', async () => {
  for (const modelId of ['', 'removed-model', 'copilot-utility', 'claude-sonnet']) {
    const mock = mockApi(['gpt-full', 'gpt-mini', 'copilot-utility', 'claude-sonnet'], { chooseId: 'gpt-full' });
    await createCopilotClient({ modelId, maxInputTokens: 6000, token: mock.token, report() {} }, mock.api).complete('a', 'b');
    assert.deepEqual(mock.sentModels, ['gpt-full']);
    assert.deepEqual(mock.picks, [['gpt-full', 'gpt-mini']]);
  }
});

test('cancelling the model picker sends no request, including with a saved preference', async () => {
  for (const modelId of ['', 'gpt-mini']) {
    const mock = mockApi(['gpt-full', 'gpt-mini'], { cancelPicker: true });
    await assert.rejects(createCopilotClient({ modelId, maxInputTokens: 6000, token: mock.token, report() {} }, mock.api).complete('a', 'b'), /selection cancelled; no request sent/);
    assert.equal(mock.picks.length, 1); assert.equal(mock.requests(), 0);
  }
});

test('no eligible Copilot model stops without a request or picker', async () => {
  for (const models of [[], ['auto', 'claude-sonnet', 'copilot-utility-small']]) {
    const mock = mockApi(models);
    await assert.rejects(createCopilotClient({ modelId: '', maxInputTokens: 6000, token: mock.token, report() {} }, mock.api).complete('a', 'b'), /No eligible GitHub Copilot/);
    assert.equal(mock.requests(), 0);
    assert.equal(mock.picks.length, 0);
  }
});

test('Copilot names retain the empty frameLocator prefix exactly', () => {
  const source = `await page.goto('https://example.invalid');
await page.frameLocator().locator("iframe[id='xyz123']").contentFrame().getByRole('link').click();`;
  const result = generateLocally(source, { existingPages: [], conventions: null, namingPlan: {
    title: 'Search projects', steps: [{ action: 'goto', label: 'Application' }, { action: 'click', label: 'Search' }],
  } }).result!;
  assert.match(result.files.find(file => file.path.endsWith('.locators.ts'))!.content,
    /readonly SEARCH_LINK: Locator = this.page.frameLocator\(\).locator\("iframe\[id='xyz123'\]"\).contentFrame\(\).getByRole\("link"\)/);
});
