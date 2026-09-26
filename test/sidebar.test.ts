import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type * as Vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PomSidebar, SidebarRunOptions } from '../dist/sidebar';
import { RunSettings, SidebarState, parseSidebarMessage } from '../dist/sidebarTypes';
import { AgentResult } from '../dist/agent';
import { sidebarHtml } from '../dist/sidebarHtml';

const defaults: RunSettings = { pagesDir: 'pages', testsDir: 'tests', testDataDir: 'test-data', conventionsFile: 'conventions.md' };

test('webview messages validate paths, notes and Copilot settings', () => {
  assert.equal(parseSidebarMessage({ type: 'openFile', path: 'C:/secret', index: -1 }), undefined);
  assert.equal(parseSidebarMessage({ type: 'run', settings: { ...defaults, pagesDir: '' } }), undefined);
  assert.equal(parseSidebarMessage({ type: 'run', settings: defaults, testSteps: 123 }), undefined);
  assert.equal(parseSidebarMessage({ type: 'setTestSteps', text: 'x'.repeat(12_001) }), undefined);
  assert.deepEqual(parseSidebarMessage({ type: 'run', settings: { ...defaults, maxCopilotRequests: 0 } }), { type: 'run', settings: defaults });
  assert.equal(parseSidebarMessage({ type: 'run', settings: { ...defaults, generationMode: 'claude' } }), undefined);
  assert.equal(parseSidebarMessage({ type: 'run', settings: { ...defaults, copilotModel: 42 } }), undefined);
  const copilotSettings = { ...defaults, generationMode: 'copilot', copilotModel: 'gpt-4o' };
  assert.deepEqual(parseSidebarMessage({ type: 'run', settings: copilotSettings }), { type: 'run', settings: copilotSettings });
});

test('sidebar HTML has restricted resource policy and no injected source data', () => {
  const html = sidebarHtml('https://view.invalid/main.js', 'https://view.invalid/style.css', 'abc123', 'https://view.invalid');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.doesNotMatch(html, /unsafe-inline|onclick=/);
  assert.match(html, /Choose your recording/);
});

async function harness(t: TestContext, run?: (source: string, uri: Vscode.Uri, options: SidebarRunOptions) => Promise<AgentResult>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-sidebar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of ['tsconfig.json', 'node_modules/typescript/bin/tsc', 'node_modules/@playwright/test/package.json', 'pages/login/login.page.ts']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), '{}');
  }
  const uri = (file: string) => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  const rootUri = uri(root);
  const sourceUri = uri(path.join(root, 'recording.spec.ts'));
  let dialogFiles: ReturnType<typeof uri>[] | undefined = [sourceUri];
  const document = { uri: sourceUri, fileName: sourceUri.fsPath, version: 1, isDirty: false, getText: () => 'await page.goto("/login");' };
  const editor = { document, selection: { isEmpty: false } };
  let listener: (message: unknown) => void = () => {};
  let lastState: SidebarState | undefined;
  const opened: string[] = [];
  const calls: SidebarRunOptions[] = [];
  const disposable = () => ({ dispose() {} });
  const api = {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    CancellationTokenSource: class {
      token = { isCancellationRequested: false, onCancellationRequested: disposable };
      cancel() { this.token.isCancellationRequested = true; }
      dispose() {}
    },
    commands: { executeCommand: async () => {} },
    window: {
      activeTextEditor: editor, onDidChangeActiveTextEditor: disposable,
      showOpenDialog: async () => dialogFiles,
      showTextDocument: async (value: { fsPath: string }) => { opened.push(value.fsPath); },
    },
    workspace: {
      fs: { stat: async (value: { fsPath: string }) => fs.stat(value.fsPath), readFile: async (value: { fsPath: string }) => fs.readFile(value.fsPath) },
      isTrusted: true, workspaceFolders: [{ uri: rootUri, name: 'Example project' }], textDocuments: [document],
      getWorkspaceFolder: (value: { fsPath: string }) => value.fsPath.startsWith(root) ? { uri: rootUri, name: 'Example project' } : undefined,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      openTextDocument: async () => document,
      onDidSaveTextDocument: disposable, onDidChangeTextDocument: disposable, onDidChangeWorkspaceFolders: disposable,
      saveAll: async () => { document.isDirty = false; return true; },
    },
  } as unknown as typeof Vscode;
  const provider = new PomSidebar({ extensionUri: rootUri } as unknown as Vscode.ExtensionContext, {
    showOutput() {},
    run: async (source, target, options) => {
      calls.push(options);
      if (run) return run(source, target, options);
      options.report('Checking generated files…');
      const output = path.join(root, 'pages/login/login.page.ts');
      return { summary: 'Converted login.', written: [output], files: [output], mode: 'local', aiRequests: 0, retried: false };
    },
  }, api);
  t.after(() => provider.dispose());
  provider.resolveWebviewView({
    webview: {
      options: {}, html: '', cspSource: 'https://view.invalid', asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: (callback: (message: unknown) => void) => { listener = callback; return disposable(); },
      postMessage: async (message: { state: SidebarState }) => { lastState = structuredClone(message.state); return true; },
    }, onDidDispose: disposable,
  } as unknown as Vscode.WebviewView);
  const send = async (message: unknown) => { listener(message); await new Promise(resolve => setTimeout(resolve, 15)); };
  await send({ type: 'ready' });
  return { send, state: () => lastState!, opened, calls, document, root, setDialog: (file?: string) => { dialogFiles = file ? [uri(file)] : undefined; } };
}

test('sidebar loads editable text/Markdown steps and clears or rejects invalid imports', async t => {
  const app = await harness(t);
  const file = path.join(app.root, 'steps.md');
  await fs.writeFile(file, '# Buyer signs in\n1. Open login page');
  app.setDialog(file);
  await app.send({ type: 'browseSteps' });
  assert.equal(app.state().stepsFile, 'steps.md');
  assert.match(app.state().testSteps!, /Buyer signs in/);
  const revision = app.state().stepsRevision;
  app.setDialog(); await app.send({ type: 'browseSteps' });
  assert.equal(app.state().stepsRevision, revision);
  await app.send({ type: 'setTestSteps', text: 'Test: Edited title\nOpen login page' });
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.calls[0].testSteps, 'Test: Edited title\nOpen login page');
  await app.send({ type: 'setTestSteps', text: '' });
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.calls[1].testSteps, '');
  const utf16 = path.join(app.root, 'notepad.txt');
  await fs.writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Test: Notepad title', 'utf16le')]));
  app.setDialog(utf16); await app.send({ type: 'browseSteps' });
  assert.equal(app.state().testSteps, 'Test: Notepad title');
  await fs.writeFile(file, 'x'.repeat(65_537)); app.setDialog(file); await app.send({ type: 'browseSteps' });
  assert.match(app.state().message, /too large/);
  assert.equal(app.state().testSteps, 'Test: Notepad title');
  app.setDialog(path.join(app.root, 'image.png')); await app.send({ type: 'browseSteps' });
  assert.match(app.state().message, /\.txt or \.md/);
});

test('sidebar selects active source, honors local-only settings, and opens generated output', async t => {
  const app = await harness(t);
  assert.equal(app.state().source?.name, 'recording.spec.ts');
  assert.ok(app.state().checks.every(check => check.ok));
  assert.equal(app.state().settings.generationMode, 'copilot');
  await app.send({ type: 'run', settings: { ...defaults, generationMode: 'local' } });
  assert.equal(app.calls[0].settings.generationMode, 'local');
  assert.equal(app.state().status, 'success');
  assert.equal(app.state().result?.requests, 0);
  await app.send({ type: 'openFile', index: 0 });
  assert.equal(app.opened[0], path.join(app.root, 'pages/login/login.page.ts'));
  await app.send({ type: 'openFile', index: 50 });
  assert.equal(app.opened.length, 1);
  assert.equal(app.state().status, 'error');
});

test('dirty files and stale selections prevent generation', async t => {
  const app = await harness(t);
  app.document.isDirty = true;
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.calls.length, 0);
  await app.send({ type: 'saveAll' });
  await app.send({ type: 'useSelection' });
  app.document.version++;
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.calls.length, 0);
  assert.match(app.state().message, /file changed/);
});

test('sidebar keeps partial naming notices visible on successful results', async t => {
  const notice = '9 of 10 recorded actions were named from the English steps.';
  const app = await harness(t, async () => ({ summary: 'Converted.', written: [], files: [], mode: 'local', aiRequests: 0, retried: false, namingNotice: notice }));
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.state().status, 'success');
  assert.equal(app.state().result?.namingNotice, notice);
});

test('path traversal is rejected before the sidebar invokes generation', async t => {
  const app = await harness(t);
  await app.send({ type: 'run', settings: { ...defaults, pagesDir: '../outside' } });
  assert.equal(app.calls.length, 0);
  assert.match(app.state().message, /inside the workspace/);
});

test('sidebar cancellation reaches the engine and blocks concurrent submissions', async t => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const app = await harness(t, async (_source, _uri, options) => {
    await waiting;
    assert.equal(options.token.isCancellationRequested, true);
    throw new Error('Cancelled; changes rolled back.');
  });
  await app.send({ type: 'run', settings: defaults });
  await app.send({ type: 'run', settings: defaults });
  assert.equal(app.calls.length, 1);
  await app.send({ type: 'cancel' }); release!();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(app.state().status, 'cancelled');
  assert.equal(app.state().busy, false);
});
