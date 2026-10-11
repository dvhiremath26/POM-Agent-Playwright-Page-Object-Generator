import { OutputDirectories } from './types';
import { maxTestStepsChars } from './testSteps';

export interface RunSettings extends OutputDirectories {
  conventionsFile: string;
  generationMode?: 'copilot' | 'local';
  copilotModel?: string;
  continuationSpec?: string;
}
export interface SidebarState {
  source?: { name: string; path: string; workspace: string; kind: 'file' | 'selection'; lines: number; preview: string };
  settings: RunSettings;
  settingsRevision: number;
  testSteps?: string;
  stepsFile?: string;
  stepsRevision?: number;
  busy: boolean;
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled';
  message: string;
  logs: string[];
  checks: { label: string; ok: boolean }[];
  files: { name: string; path: string }[];
  result?: { mode: string; requests: number; changed: number; namingNotice?: string };
}
export type SidebarMessage = { type: 'ready' | 'browse' | 'browseSteps' | 'useFile' | 'useSelection' | 'cancel' | 'openSource' | 'showOutput' | 'openFolder' | 'refresh' | 'saveAll' }
  | { type: 'setTestSteps'; text: string }
  | { type: 'run'; settings: RunSettings; testSteps?: string }
  | { type: 'openFile'; index: number };

export function parseSidebarMessage(value: unknown): SidebarMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== 'string') return undefined;
  if (['ready', 'browse', 'browseSteps', 'useFile', 'useSelection', 'cancel', 'openSource', 'showOutput', 'openFolder', 'refresh', 'saveAll'].includes(message.type)) return { type: message.type } as SidebarMessage;
  const validSteps = (value: unknown): value is string => typeof value === 'string' && value.length <= maxTestStepsChars && !value.includes('\0');
  if (message.type === 'setTestSteps') return validSteps(message.text) ? { type: 'setTestSteps', text: message.text } : undefined;
  if (message.type === 'openFile' && Number.isInteger(message.index) && (message.index as number) >= 0) return { type: 'openFile', index: message.index as number };
  if (message.type !== 'run' || !message.settings || typeof message.settings !== 'object') return undefined;
  if (message.testSteps !== undefined && !validSteps(message.testSteps)) return undefined;
  const settings = message.settings as Record<string, unknown>;
  if (settings.generationMode !== undefined && !['copilot', 'local'].includes(settings.generationMode as string)) return undefined;
  if (settings.copilotModel !== undefined && (typeof settings.copilotModel !== 'string' || settings.copilotModel.length > 200 || /[\x00-\x1f]/.test(settings.copilotModel))) return undefined;
  if (settings.continuationSpec !== undefined && (typeof settings.continuationSpec !== 'string' || settings.continuationSpec.length > 500 || /[\x00-\x1f]/.test(settings.continuationSpec))) return undefined;
  for (const key of ['pagesDir', 'testsDir', 'testDataDir', 'conventionsFile']) {
    if (typeof settings[key] !== 'string' || (settings[key] as string).length > 500 || !(settings[key] as string).trim()) return undefined;
  }
  return { type: 'run', ...(message.testSteps !== undefined ? { testSteps: message.testSteps as string } : {}), settings: {
    ...(settings.generationMode !== undefined ? { generationMode: settings.generationMode as 'copilot' | 'local' } : {}),
    ...(settings.copilotModel !== undefined ? { copilotModel: (settings.copilotModel as string).trim() } : {}),
    ...(settings.continuationSpec !== undefined ? { continuationSpec: (settings.continuationSpec as string).trim() } : {}),
    pagesDir: (settings.pagesDir as string).trim(), testsDir: (settings.testsDir as string).trim(),
    testDataDir: (settings.testDataDir as string).trim(), conventionsFile: (settings.conventionsFile as string).trim(),
  } };
}
