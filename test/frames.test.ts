import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import { generateLocally } from '../dist/localGenerator';
import { executeAgent } from '../dist/agent';
import { validateWithTsc } from '../dist/validator';

const recording = `await page.goto('https://example.invalid');
await page.frameLocator().locator("iframe[id='xyz123']").contentFrame().getByRole('link', { name: 'Continue' }).click();`;

test('empty frameLocator prefix is retained, distinguished from explicit frames, and compiles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-any-frame-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const source = `${recording}\nawait page.frameLocator('#outer').locator("iframe[id='xyz123']").contentFrame().getByRole('link', { name: 'Continue' }).click();`;
  const options = { workspaceRoot: root, codegenSource: source, conventionsFile: 'conventions.md' };
  const result = await executeAgent(options, { validate: validateWithTsc });
  assert.equal(result.aiRequests, 0);
  const locators = await fs.readFile(result.files.find(file => file.endsWith('.locators.ts'))!, 'utf8');
  assert.match(locators, /this.page.frameLocator\(\).locator\("iframe\[id='xyz123'\]"\).contentFrame\(\).getByRole/);
  assert.match(locators, /this.page.frameLocator\("#outer"\).locator/);
  assert.match(locators, /CONTINUE_LINK_2/);
  assert.deepEqual((await executeAgent(options, { validate: validateWithTsc })).written, []);
  const bad = generateLocally(recording.replace('frameLocator()', 'frameLocator(dynamicSelector)'), { existingPages: [], conventions: null });
  assert.equal(bad.result, undefined, 'Unsupported frame syntax must never be dropped');
});

test('generated any-frame locator clicks a link inside nested real iframes', { timeout: 60_000 }, async t => {
  const executablePath = process.env.POM_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if (!executablePath) { t.skip('Set POM_TEST_BROWSER for iframe browser coverage.'); return; }
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000 });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const inner = `<a href="#done" aria-description="Search" onclick="event.preventDefault(); this.textContent+='!'">Continue</a><a href="#other" aria-description="Search projects">Other</a>`;
  const outer = `<iframe id="xyz123" srcdoc="${escape(inner)}"></iframe>`;
  await page.setContent(`<iframe id="outer" srcdoc="${escape(outer)}"></iframe>`);
  assert.equal(await page.locator("iframe[id='xyz123']").count(), 0, 'A shortened chain cannot see the inner iframe');
  const generated = generateLocally(recording, { existingPages: [], conventions: null }).result!;
  const source = generated.files.find(file => file.path.endsWith('.locators.ts'))!.content;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, useDefineForClassFields: false } }).outputText;
  const exports: Record<string, new (page: unknown) => { CONTINUE_LINK: import('@playwright/test').Locator }> = {};
  runInNewContext(js, { exports });
  const Locators = Object.values(exports)[0];
  await new Locators(page).CONTINUE_LINK.click();
  assert.equal(await page.frameLocator('#outer').frameLocator('#xyz123').getByRole('link', { name: 'Continue!' }).innerText(), 'Continue!');
  const described = generateLocally(recording.replace("name: 'Continue'", "description: 'Search', exact: true"), { existingPages: [], conventions: null }).result!;
  const describedSource = described.files.find(file => file.path.endsWith('.locators.ts'))!.content;
  const describedJs = ts.transpileModule(describedSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, useDefineForClassFields: false } }).outputText;
  const describedExports: Record<string, new (page: unknown) => { SEARCH_LINK: import('@playwright/test').Locator }> = {};
  runInNewContext(describedJs, { exports: describedExports });
  const DescribedLocators = Object.values(describedExports)[0];
  await new DescribedLocators(page).SEARCH_LINK.click();
  assert.equal(await page.frameLocator('#outer').frameLocator('#xyz123').getByRole('link', { name: 'Continue!!' }).innerText(), 'Continue!!',
    'The description filter must match the exact description even though the accessible name is different');
});
