import type * as Vscode from 'vscode';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { AgentResult } from './agent';
import { safePath, resolveInside } from './paths';
import { sidebarHtml } from './sidebarHtml';
import { parseSidebarMessage, RunSettings, SidebarState } from './sidebarTypes';
import { validateTestSteps } from './testSteps';

export interface SidebarRunOptions {
  settings: RunSettings;
  testSteps?: string;
  report: (message: string) => void;
  token: Vscode.CancellationToken;
}
export interface SidebarActions {
  run(source: string, uri: Vscode.Uri, options: SidebarRunOptions): Promise<AgentResult>;
  showOutput(): void;
}

export class PomSidebar implements Vscode.WebviewViewProvider, Vscode.Disposable {
  private readonly api: typeof Vscode;
  private view?: Vscode.WebviewView;
  private editor?: Vscode.TextEditor;
  private selected?: { uri: Vscode.Uri; range?: Vscode.Range; version: number };
  private cancellation?: Vscode.CancellationTokenSource;
  private resultPaths: string[] = [];
  private resultRoot?: string;
  private readonly subscriptions: Vscode.Disposable[] = [];
  private refreshVersion = 0;
  private stepsLoadVersion = 0;
  private state: SidebarState = {
    settings: { pagesDir: 'pages', testsDir: 'tests', testDataDir: 'test-data', conventionsFile: 'conventions.md', generationMode: 'copilot', copilotModel: '' },
    settingsRevision: 0, busy: false, status: 'idle', message: '', logs: [], checks: [], files: [],
  };

  constructor(private readonly context: Vscode.ExtensionContext, private readonly actions: SidebarActions, api?: typeof Vscode) {
    this.api = api ?? require('vscode');
    this.editor = this.api.window.activeTextEditor;
    this.subscriptions.push(
      this.api.window.onDidChangeActiveTextEditor(editor => { if (editor) this.editor = editor; }),
      this.api.workspace.onDidSaveTextDocument(() => { void this.refreshChecks(); }),
      this.api.workspace.onDidChangeTextDocument(() => { void this.refreshChecks(); }),
      this.api.workspace.onDidChangeWorkspaceFolders(() => { void this.refreshChecks(); }),
    );
  }

  resolveWebviewView(view: Vscode.WebviewView): void {
    this.view = view;
    const media = this.api.Uri.joinPath(this.context.extensionUri, 'media');
    const scripts = this.api.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
    const script = view.webview.asWebviewUri(this.api.Uri.joinPath(scripts, 'main.js'));
    const style = view.webview.asWebviewUri(this.api.Uri.joinPath(media, 'sidebar.css'));
    view.webview.html = sidebarHtml(script.toString(), style.toString(), randomBytes(24).toString('hex'), view.webview.cspSource);
    this.subscriptions.push(view.webview.onDidReceiveMessage(message => { void this.receive(message); }), view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
  }

  private publish(): void { void this.view?.webview.postMessage({ type: 'state', state: this.state }); }

  private fail(error: unknown): void {
    this.state.status = 'error';
    this.state.message = error instanceof Error ? error.message : String(error);
    this.publish();
  }

  private async receive(raw: unknown): Promise<void> {
    const message = parseSidebarMessage(raw);
    if (!message) { this.fail(new Error('Check the output paths and options, then try again.')); return; }
    if (this.state.busy && !['ready', 'cancel', 'showOutput', 'openSource'].includes(message.type)) return;
    try {
      switch (message.type) {
        case 'ready':
          if (!this.selected && this.editor?.document.uri.scheme === 'file' && this.editor.document.fileName.endsWith('.ts') && this.api.workspace.getWorkspaceFolder(this.editor.document.uri)) {
            await this.choose(this.editor.document.uri);
          }
          await this.refreshChecks(); this.publish(); break;
        case 'browse': {
          const uris = await this.api.window.showOpenDialog({ title: 'Choose a Playwright Codegen recording', canSelectMany: false, filters: { 'TypeScript recordings': ['ts'] }, defaultUri: this.selected?.uri ?? this.api.workspace.workspaceFolders?.[0]?.uri });
          if (uris?.[0]) await this.choose(uris[0]); break;
        }
        case 'useFile': await this.useEditor(false); break;
        case 'browseSteps': await this.browseSteps(); break;
        case 'setTestSteps':
          this.stepsLoadVersion++;
          this.state.testSteps = message.text; this.state.stepsFile = undefined; break;
        case 'useSelection': await this.useEditor(true); break;
        case 'run': await this.run(message.settings, message.testSteps); break;
        case 'cancel':
          this.cancellation?.cancel();
          this.state.message = 'Cancelling… Waiting for the current check to finish and changes to roll back.';
          this.publish(); break;
        case 'showOutput': this.actions.showOutput(); break;
        case 'openFolder': await this.api.commands.executeCommand('vscode.openFolder'); break;
        case 'saveAll': await this.api.workspace.saveAll(false); await this.refreshChecks(); break;
        case 'refresh': await this.refreshChecks(); break;
        case 'openSource': if (this.selected) await this.api.window.showTextDocument(this.selected.uri, { preview: true, selection: this.selected.range }); break;
        case 'openFile': {
          const file = this.resultPaths[message.index];
          if (!file || !this.resultRoot) throw new Error('That result is no longer available.');
          const relative = path.relative(this.resultRoot, file).replace(/\\/g, '/');
          await this.api.window.showTextDocument(this.api.Uri.file(await safePath(this.resultRoot, relative)), { preview: true }); break;
        }
      }
    } catch (error) { this.fail(error); }
  }

  private async useEditor(selection: boolean): Promise<void> {
    const editor = this.api.window.activeTextEditor ?? this.editor;
    if (!editor) throw new Error('Open your Codegen recording in the editor first, or choose a file.');
    if (selection && editor.selection.isEmpty) throw new Error('Select complete Codegen statements in the editor, then click Use selection.');
    await this.choose(editor.document.uri, selection ? editor.selection : undefined);
  }

  private async browseSteps(): Promise<void> {
    const version = ++this.stepsLoadVersion;
    const source = this.selected;
    const uris = await this.api.window.showOpenDialog({ title: 'Load plain-English test steps', canSelectMany: false, filters: { 'Text or Markdown': ['txt', 'md'] } });
    const uri = uris?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file' || !/\.(txt|md)$/i.test(uri.fsPath)) throw new Error('Choose a local .txt or .md file.');
    if ((await this.api.workspace.fs.stat(uri)).size > 65_536) throw new Error('The test-steps file is too large. Use a file below 64 KB and 12,000 characters.');
    const bytes = await this.api.workspace.fs.readFile(uri);
    if (bytes.length > 65_536) throw new Error('The test-steps file is too large.');
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let text: string;
    try { text = validateTestSteps(new TextDecoder(encoding, { fatal: true }).decode(bytes)); }
    catch { throw new Error('Use a UTF-8 or UTF-16 text file with at most 12,000 characters.'); }
    if (!text) throw new Error('The test-steps file is empty.');
    if (version !== this.stepsLoadVersion || this.state.busy || source !== this.selected) return;
    this.state.testSteps = text; this.state.stepsFile = path.basename(uri.fsPath);
    this.state.stepsRevision = (this.state.stepsRevision ?? 0) + 1; this.publish();
  }

  private async choose(uri: Vscode.Uri, range?: Vscode.Range): Promise<void> {
    if (uri.scheme !== 'file' || !uri.fsPath.endsWith('.ts')) throw new Error('Choose a local TypeScript (.ts) recording.');
    const folder = this.api.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Open the project folder containing this recording, then choose it again.');
    const doc = await this.api.workspace.openTextDocument(uri);
    const text = doc.getText(range);
    if (!text.trim()) throw new Error('The recording or selection is empty.');
    if (this.selected && this.selected.uri.toString() !== uri.toString()) {
      this.stepsLoadVersion++; this.state.testSteps = ''; this.state.stepsFile = undefined;
      this.state.stepsRevision = (this.state.stepsRevision ?? 0) + 1;
    }
    this.selected = { uri, range, version: doc.version };
    this.state.source = {
      name: path.basename(uri.fsPath), path: path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/'),
      workspace: folder.name, kind: range ? 'selection' : 'file', lines: text.split(/\r?\n/).length,
      preview: text.slice(0, 5000) + (text.length > 5000 ? '\n… Preview shortened; the full source will be processed.' : ''),
    };
    const config = this.api.workspace.getConfiguration('pomAgent', folder.uri);
    this.state.settings = {
      pagesDir: config.get('pagesDir', 'pages'), testsDir: config.get('testsDir', 'tests'), testDataDir: config.get('testDataDir', 'test-data'),
      conventionsFile: config.get('conventionsFile', 'conventions.md'),
      generationMode: config.get('generationMode', 'copilot'), copilotModel: config.get('copilotModel', ''),
    };
    this.state.settingsRevision++;
    this.state.status = 'idle'; this.state.message = ''; this.state.logs = []; this.state.files = []; this.state.result = undefined;
    this.resultPaths = []; this.resultRoot = undefined;
    await this.refreshChecks();
  }

  private async refreshChecks(): Promise<void> {
    const version = ++this.refreshVersion;
    const folder = this.selected ? this.api.workspace.getWorkspaceFolder(this.selected.uri) : this.api.workspace.workspaceFolders?.[0];
    const root = folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
    const dirty = this.api.workspace.textDocuments.some(doc => doc.isDirty && this.api.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder?.uri.toString());
    const checks = [
      { label: 'Project open', ok: !!root }, { label: 'Files saved', ok: !!root && !dirty },
      { label: 'TypeScript config', ok: !!root && existsSync(path.join(root, 'tsconfig.json')) },
      { label: 'TypeScript installed', ok: !!root && existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')) },
      { label: 'Playwright installed', ok: !!root && existsSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json')) },
    ];
    if (!this.api.workspace.isTrusted) checks.push({ label: 'Workspace trust required', ok: false });
    if (version !== this.refreshVersion) return;
    this.state.checks = checks;
    this.publish();
  }

  private async run(settings: RunSettings, testSteps = this.state.testSteps ?? ''): Promise<void> {
    if (this.state.busy) return;
    if (!this.selected) throw new Error('Choose a recording first.');
    const steps = validateTestSteps(testSteps);
    const folder = this.api.workspace.getWorkspaceFolder(this.selected.uri);
    if (!folder) throw new Error('Reopen the project containing this recording.');
    for (const value of [settings.pagesDir, settings.testsDir, settings.testDataDir, settings.conventionsFile]) resolveInside(folder.uri.fsPath, value);
    const document = await this.api.workspace.openTextDocument(this.selected.uri);
    if (this.selected.range && document.version !== this.selected.version) throw new Error('The file changed after you selected code. Select the intended code again and click Use selection.');
    await this.refreshChecks();
    if (this.state.checks.some(check => !check.ok)) throw new Error('Complete the project checks above. Save pending edits and make sure TypeScript, Playwright, and tsconfig.json are available.');
    if (this.state.busy) return;
    if (this.state.source) {
      const text = document.getText(this.selected.range);
      this.state.source.lines = text.split(/\r?\n/).length;
      this.state.source.preview = text.slice(0, 5000) + (text.length > 5000 ? '\n… Preview shortened; the full source will be processed.' : '');
    }
    this.state.settings = settings;
    this.state.testSteps = steps;
    this.state.busy = true; this.state.status = 'running'; this.state.message = 'Starting with local processing…';
    this.state.logs = []; this.state.files = []; this.state.result = undefined; this.resultPaths = [];
    this.cancellation = new this.api.CancellationTokenSource(); this.publish();
    try {
      const result = await this.actions.run(document.getText(this.selected.range), this.selected.uri, {
        settings, testSteps: steps, token: this.cancellation.token,
        report: message => { this.state.message = message; this.state.logs.push(message); this.state.logs = this.state.logs.slice(-100); this.publish(); },
      });
      this.state.status = 'success'; this.state.message = result.summary;
      this.state.result = { mode: result.mode, requests: result.aiRequests, changed: result.written.length, namingNotice: result.namingNotice };
      this.resultRoot = folder.uri.fsPath; this.resultPaths = result.files;
      this.state.files = result.files.map(file => ({ name: path.basename(file), path: path.relative(folder.uri.fsPath, file).replace(/\\/g, '/') }));
    } catch (error) {
      this.state.status = this.cancellation.token.isCancellationRequested ? 'cancelled' : 'error';
      this.state.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.cancellation.dispose(); this.cancellation = undefined; this.state.busy = false; this.publish();
    }
  }

  dispose(): void { this.cancellation?.cancel(); this.cancellation?.dispose(); this.subscriptions.forEach(item => item.dispose()); }
}
