import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLocally } from '../dist/localGenerator';
import { parseNamingPlan } from '../dist/copilotNaming';

test('grouped screens are reused when revisited; missing assignments inherit the current screen and goto resets it', () => {
  const source = `await page.goto('/login');
await page.getByRole('button', { name: 'Search' }).click();
await page.getByRole('button', { name: 'New' }).click();
await page.goto('/settings');
await page.getByRole('textbox', { name: 'Username' }).fill('example');`;
  const metadata = generateLocally(source, { existingPages: [], conventions: null }).namingActions!;
  const { namingNotice, ...namingPlan } = parseNamingPlan(JSON.stringify({ steps: [
    { index: 1, page: 'Login', label: 'Login' },
    { index: 2, page: 'ProjectList', label: 'Search' },
    { index: 3, label: 'New' },
    { index: 4, label: 'Settings' },
    { index: 5, page: 'LoginPage', label: 'Username' },
  ] }), metadata);
  assert.match(namingNotice!, /screen groups for 3 of 5/);
  const result = generateLocally(source, { existingPages: [], conventions: null, namingPlan }).result!;
  assert.equal(result.files.filter(file => file.path.endsWith('.locators.ts')).length, 3);
  const flow = result.files.find(file => file.path.endsWith('.spec.ts'))!.content;
  assert.equal((flow.match(/new LoginPage\(page\)/g) ?? []).length, 1);
  const calls = [...flow.matchAll(/await (\w+)\.(\w+)\(/g)].map(match => `${match[1]}.${match[2]}`);
  assert.deepEqual(calls, ['loginPage.openLogin', 'projectListPage.clickSearch', 'projectListPage.clickNew', 'settingsPage.openSettings', 'loginPage.enterUsername']);
  assert.match(result.files.find(file => file.path.endsWith('project-list.locators.ts'))!.content, /readonly NEW_BUTTON/);
  assert.doesNotMatch(result.files.find(file => file.path.endsWith('login.locators.ts'))!.content, /SEARCH_BUTTON|NEW_BUTTON/);
});

test('a single logical screen stays together and instance names do not shadow data or fixtures', () => {
  const source = `await page.goto('/form'); await page.getByLabel('Email').fill('example');`;
  const result = generateLocally(source, { existingPages: [], conventions: null, namingPlan: {
    title: 'Data entry', steps: [{ action: 'goto', label: 'Form', page: 'Data' }, { action: 'fill', label: 'Email', page: 'Data' }],
  } }).result!;
  assert.equal(result.files.filter(file => file.path.endsWith('.locators.ts')).length, 1);
  const flow = result.files.find(file => file.path.endsWith('.spec.ts'))!.content;
  assert.match(flow, /const dataPage = new DataPage\(page\)/);
  assert.match(flow, /await dataPage.enterEmail\(data.email\)/);
});
