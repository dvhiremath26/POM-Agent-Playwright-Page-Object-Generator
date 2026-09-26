/// <reference lib="dom" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect as browserExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { sidebarHtml } from '../dist/sidebarHtml';
import { SidebarState } from '../dist/sidebarTypes';

test('sidebar browser flow is responsive, accessible by keyboard, and renders safe results', async t => {
  const executablePath = process.env.POM_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if (!executablePath) { t.skip('Set POM_TEST_BROWSER to a Chromium executable for UI checks.'); return; }
  const root = path.resolve(__dirname, '..');
  const script = await readFile(path.join(root, 'dist/webview/main.js'));
  const css = await readFile(path.join(root, 'media/sidebar.css'));
  let origin = '';
  const server = createServer((request, response) => {
    if (request.url === '/main.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(sidebarHtml(`${origin}/main.js`, `${origin}/style.css`, 'test-nonce', origin)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const messages: unknown[] = [];
  await page.exposeFunction('captureMessage', (message: unknown) => { messages.push(message); });
  await page.addInitScript(() => {
    (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => (window as unknown as { captureMessage: (message: unknown) => void }).captureMessage(message) });
  });
  await page.goto(origin);
  const state: SidebarState = {
    settings: { pagesDir: 'pages', testsDir: 'tests', testDataDir: 'test-data', conventionsFile: 'conventions.md' },
    settingsRevision: 1, busy: false, status: 'idle', message: '', logs: [], files: [],
    checks: [{ label: 'Project open', ok: true }, { label: 'Files saved', ok: true }, { label: 'TypeScript config', ok: true }, { label: 'TypeScript installed', ok: true }, { label: 'Playwright installed', ok: true }],
  };
  const publish = async () => page.evaluate(value => window.postMessage({ type: 'state', state: value }, '*'), state);
  await publish();
  assert.equal(await page.locator('#run').isDisabled(), true);
  await page.getByRole('button', { name: 'Choose recording…' }).click();
  assert.ok(messages.some(message => (message as { type: string }).type === 'browse'));
  state.source = { name: 'login.spec.ts', path: 'recordings/login.spec.ts', workspace: 'Shop tests', kind: 'file', lines: 8, preview: "await page.goto('/login');\nawait page.getByLabel('Email').fill('test@example.com');" };
  await publish();
  const notes = 'Test: Buyer signs in\n1. Open login page';
  await page.getByLabel('Test steps in plain English', { exact: true }).fill(notes);
  assert.ok(messages.some(message => (message as { type: string; text?: string }).type === 'setTestSteps' && (message as { text?: string }).text === notes));
  await publish(); // Progress/readiness updates must not overwrite unsaved typing.
  await browserExpect(page.locator('#test-steps')).toHaveValue(notes);
  await page.getByRole('button', { name: 'Load .txt or .md…' }).click();
  assert.ok(messages.some(message => (message as { type: string }).type === 'browseSteps'));
  state.testSteps = 'Test: Loaded buyer login\n1. Open login page'; state.stepsRevision = 1; state.stepsFile = 'steps.md';
  await publish();
  await browserExpect(page.locator('#test-steps')).toHaveValue(state.testSteps);
  await page.getByRole('button', { name: 'Clear steps' }).click();
  await browserExpect(page.locator('#test-steps')).toHaveValue('');
  await page.locator('#test-steps').fill(notes);
  await browserExpect(page.locator('#generationMode')).toHaveValue('copilot');
  await page.locator('#generationMode').selectOption('local');
  await browserExpect(page.locator('#generationMode')).toHaveValue('local');
  await page.locator('#generationMode').selectOption('copilot');
  await page.locator('#run').focus(); await page.keyboard.press('Enter');
  assert.ok(messages.some(message => { const value = message as { type: string; settings?: { generationMode: string }; testSteps?: string }; return value.type === 'run' && value.settings?.generationMode === 'copilot' && value.testSteps === notes; }));
  state.busy = true; state.status = 'running'; state.message = 'Trying local conversion…'; await publish();
  await browserExpect(page.locator('#pagesDir')).toBeDisabled();
  await browserExpect(page.locator('#generationMode')).toBeDisabled();
  await browserExpect(page.locator('#copilotModel')).toBeDisabled();
  await browserExpect(page.locator('#test-steps')).toBeDisabled();
  await browserExpect(page.locator('#browse-steps')).toBeDisabled();
  await page.locator('#cancel').click();
  assert.ok(messages.some(message => (message as { type: string }).type === 'cancel'));
  state.busy = false; state.status = 'success'; state.message = 'Converted login using local rules.';
  state.result = { mode: 'Local', requests: 0, changed: 4, namingNotice: '9 of 10 recorded actions were named from the English steps. Unmatched actions kept recording-based names; all recorded actions were preserved.' };
  state.files = [
    { name: 'login.page.ts', path: 'pages/login/login.page.ts' }, { name: 'login.locators.ts', path: 'pages/login/login.locators.ts' },
    { name: 'login.spec.ts', path: 'tests/login/login.spec.ts' }, { name: 'login.data.json', path: 'test-data/login/login.data.json' },
  ];
  state.logs = ['Trying local conversion…', 'Checking generated files with TypeScript…', 'Validation passed.'];
  await publish();
  await page.getByRole('button', { name: /login.page.ts/ }).click();
  await browserExpect(page.locator('#naming-notice')).toBeVisible();
  await browserExpect(page.locator('#naming-notice')).toContainText('9 of 10');
  assert.ok(messages.some(message => (message as { type: string; index: number }).type === 'openFile' && (message as { index: number }).index === 0));
  await mkdir(path.join(root, '.qa'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.qa/sidebar.png'), fullPage: true });
  state.files = [{ name: '<img src=x onerror=alert(1)>', path: '<script>bad()</script>' }]; await publish();
  state.result.namingNotice = '<img src=x onerror=alert(1)>'; await publish();
  assert.equal(await page.locator('#naming-notice img').count(), 0);
  state.result.namingNotice = undefined; await publish();
  await browserExpect(page.locator('#naming-notice')).toBeHidden();
  assert.equal(await page.locator('#result-files img, #result-files script').count(), 0);
  await page.setViewportSize({ width: 240, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
});
