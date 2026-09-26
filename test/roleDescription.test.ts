import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateLocally } from '../dist/localGenerator';
import { executeAgent } from '../dist/agent';
import { validateWithTsc } from '../dist/validator';
import { describedRoleRecording } from './fixtures/describedRoleRecording';

test('role description is preserved separately from name and supplies a fallback naming label', () => {
  for (const [options, label] of [
    [`{ description: 'Search', exact: true }`, 'Search'],
    [`{ name: 'Projects', description: 'Search', exact: false }`, 'Projects'],
    [`{ description: 'Search', name: 'Projects' }`, 'Projects'],
  ]) {
    const source = `await page.goto('https://example.invalid'); await page.getByRole('link', ${options}).click();`;
    const generated = generateLocally(source, { existingPages: [], conventions: null });
    assert.ok(generated.result, generated.reason);
    assert.equal(generated.namingActions![1].label, label);
    assert.match(generated.namingActions![1].target!, /"description":"Search"/);
    if (label === 'Projects') assert.match(generated.namingActions![1].target!, /"name":"Projects"/);
  }
  for (const target of [
    `page.getByRole('link', { description: dynamicDescription })`,
    `page.getByRole('link', { description: /Search/ })`,
    `page.getByRole('link', { description: true })`,
    `page.getByRole('link', { description: 'Search', exact: 'true' })`,
    `page.getByText('link', { description: 'Search' })`,
    `page.getByLabel('link', { description: 'Search' })`,
    `page.getByPlaceholder('link', { description: 'Search' })`,
  ]) {
    assert.equal(generateLocally(`await page.goto('https://example.invalid'); await ${target}.click();`, { existingPages: [], conventions: null }).result, undefined);
  }
});

test('reported description/frame flow compiles, supports Copilot grouping and reuses existing members', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-role-description-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const actions = generateLocally(describedRoleRecording, { existingPages: [], conventions: null }).namingActions!;
  assert.equal(actions.length, 12);
  const options = { workspaceRoot: root, codegenSource: describedRoleRecording, conventionsFile: 'conventions.md' };
  const local = await executeAgent(options, { validate: validateWithTsc });
  assert.equal(local.aiRequests, 0);
  assert.deepEqual((await executeAgent(options, { validate: validateWithTsc })).written, []);
  let requests = 0;
  const copilotOptions = { ...options, generationMode: 'copilot' as const, copilot: { complete: async () => {
    requests++;
    return JSON.stringify({ steps: actions.map((action, index) => ({ index: index + 1, action: action.action, label: action.label, page: index < 4 ? 'Login' : index < 7 ? 'Navigation' : 'Project List' })) });
  } } };
  const grouped = await executeAgent(copilotOptions, { validate: validateWithTsc });
  assert.equal(grouped.aiRequests, 1);
  assert.equal(requests, 1);
  assert.equal(grouped.files.filter(file => file.endsWith('.locators.ts')).length, 3);
  const locators = await fs.readFile(grouped.files.find(file => file.endsWith('project-list.locators.ts'))!, 'utf8');
  assert.match(locators, /readonly SEARCH_LINK: Locator = this.page.frameLocator\(\).locator\(.+\).contentFrame\(\).getByRole\("link", \{"description":"Search","exact":true\}\)/);
  assert.deepEqual((await executeAgent(copilotOptions, { validate: validateWithTsc })).written, [], 'Existing described locators and their methods must not be duplicated');
});
