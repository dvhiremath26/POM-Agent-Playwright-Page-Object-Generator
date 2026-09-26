import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentResult, executeAgent } from './agent';
import { safePath } from './paths';
import { CacheEntry, RunCache } from './cache';
import { PomSidebar, SidebarRunOptions } from './sidebar';
import { createCopilotClient } from './copilot';

const running = new Set<string>();
let output: vscode.OutputChannel;
let cache: RunCache;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('POM Agent');
  cache = {
    get: async key => context.workspaceState.get<CacheEntry>(`run:${key}`),
    set: async (key, entry) => {
      const keys = context.workspaceState.get<string[]>('cacheKeys', []).filter(value => value !== key);
      keys.push(key);
      while (keys.length > 20) await context.workspaceState.update(`run:${keys.shift()}`, undefined);
      await context.workspaceState.update(`run:${key}`, entry);
      await context.workspaceState.update('cacheKeys', keys);
    },
  };
  const sidebar = new PomSidebar(context, { run: runAgent, showOutput: () => output.show(true) });
  context.subscriptions.push(output, sidebar,
    vscode.window.registerWebviewViewProvider('pomAgent.dashboard', sidebar),
    vscode.commands.registerCommand('pomAgent.openDashboard', () => vscode.commands.executeCommand('pomAgent.dashboard.focus')),
    vscode.commands.registerCommand('pomAgent.organizeFile', async (uri?: vscode.Uri) => {
      try {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== 'file' || !target.fsPath.endsWith('.ts')) throw new Error('Open or select a TypeScript Codegen file first.');
        const document = await vscode.workspace.openTextDocument(target);
        await runAgent(document.getText(), target);
      } catch (error) { reportError(error); }
    }),
    vscode.commands.registerCommand('pomAgent.organizeSelection', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty || !editor.document.fileName.endsWith('.ts')) throw new Error('Select some TypeScript Codegen code first.');
        await runAgent(editor.document.getText(editor.selection), editor.document.uri);
      } catch (error) { reportError(error); }
    }),
  );
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(message);
  void vscode.window.showErrorMessage(`POM Agent: ${message.split('\n')[0]}`, 'Show details').then(action => {
    if (action) output.show(true);
  });
}

export async function runAgent(codegenSource: string, sourceUri: vscode.Uri, ui?: SidebarRunOptions): Promise<AgentResult> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running POM Agent.');
  if (!codegenSource.trim()) throw new Error('The Codegen source is empty.');
  const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
  if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local workspace containing this recording first.');
  const root = folder.uri.fsPath;
  if (running.has(root)) throw new Error('A POM Agent run is already active in this workspace.');
  const config = vscode.workspace.getConfiguration('pomAgent', folder.uri);
  // Save output files only from a consistent on-disk workspace; never overwrite dirty editors.
  const ensureSaved = (): void => {
    if (vscode.workspace.textDocuments.some(doc => doc.isDirty && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === folder.uri.toString())) {
      throw new Error('Save your workspace files before running POM Agent.');
    }
  };
  ensureSaved();
  running.add(root);
  try {
    const execute = async (token: vscode.CancellationToken, progress?: vscode.Progress<{ message?: string }>): Promise<AgentResult> => {
      const report = (message: string): void => { progress?.report({ message }); output.appendLine(message); ui?.report(message); };
      return executeAgent({
        workspaceRoot: root, codegenSource, cache, testSteps: ui?.testSteps,
        generationMode: ui?.settings.generationMode ?? config.get<'local' | 'copilot'>('generationMode', 'copilot'),
        copilotModel: ui?.settings.copilotModel ?? config.get<string>('copilotModel', ''),
        copilot: createCopilotClient({ modelId: ui?.settings.copilotModel ?? config.get<string>('copilotModel', ''),
          maxInputTokens: config.get<number>('maxInputTokens', 6000), token, report }),
        isCancelled: () => token.isCancellationRequested,
        conventionsFile: ui?.settings.conventionsFile ?? config.get<string>('conventionsFile', 'conventions.md'),
        directories: {
          pagesDir: ui?.settings.pagesDir ?? config.get<string>('pagesDir', 'pages'), testsDir: ui?.settings.testsDir ?? config.get<string>('testsDir', 'tests'),
          testDataDir: ui?.settings.testDataDir ?? config.get<string>('testDataDir', 'test-data'),
        },
        report,
        beforeWrite: async files => {
          ensureSaved();
          for (const file of files) {
            const target = await safePath(root, file.path);
            const same = process.platform === 'win32' ? target.toLowerCase() === sourceUri.fsPath.toLowerCase() : target === sourceUri.fsPath;
            if (same) throw new Error('The original Codegen recording must be preserved; generate the test at a different path.');
          }
        },
      });
    };
    const result = ui ? await execute(ui.token) : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'POM Agent', cancellable: true }, async (progress, token) => execute(token, progress));
    output.appendLine(`${result.summary}\n${result.written.map(file => path.relative(root, file)).join('\n')}`);
    if (!ui) await vscode.window.showInformationMessage(`POM Agent: ${result.summary} (${result.written.length} files changed; ${result.aiRequests} AI requests; ${result.mode}).`);
    return result;
  } finally { running.delete(root); }
}

export function deactivate(): void { /* Subscriptions are disposed by VS Code. */ }
