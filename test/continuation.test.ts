import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeAgent } from '../dist/agent';
import { validateWithTsc } from '../dist/validator';

test('a Codegen continuation without goto appends safely to a selected generated spec', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-continuation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const first = await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', generationMode: 'local', codegenSource: `await page.goto('https://example.invalid/login');\nawait page.getByRole('button', { name: 'Continue' }).click();` }, { validate: validateWithTsc });
  const spec = path.relative(root, first.files.find(file => file.endsWith('.spec.ts'))!).replace(/\\/g, '/');
  const secondSource = `await page.getByRole('link', { name: 'Open details' }).click();\nawait page.getByRole('button', { name: 'Save' }).click();`;
  const second = await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', generationMode: 'local', continuationSpec: spec, codegenSource: secondSource }, { validate: validateWithTsc });
  assert.match(second.summary, /Extended the selected test/);
  const content = await fs.readFile(path.join(root, spec), 'utf8');
  assert.match(content, /POM Agent continuation/);
  assert.match(content, /ContinuationPage/);
  assert.match(content, /clickOpenDetails/);
  assert.match(content, /clickSave/);
  assert.deepEqual((await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', generationMode: 'local', continuationSpec: spec, codegenSource: secondSource }, { validate: validateWithTsc })).written, []);
});

test('an empty continuation field creates a normal standalone test', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-empty-continuation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', useDefineForClassFields: false, strict: true, skipLibCheck: true, types: ['node'] }, include: ['pages/**/*.ts', 'tests/**/*.ts'] }));
  const result = await executeAgent({ workspaceRoot: root, conventionsFile: 'conventions.md', generationMode: 'local', continuationSpec: '', codegenSource: `await page.goto('https://example.invalid/login');\nawait page.getByRole('button', { name: 'Continue' }).click();` }, { validate: validateWithTsc });
  assert.ok(result.files.some(file => file.endsWith('.spec.ts')));
  assert.match(result.summary, /^Converted/);
});
