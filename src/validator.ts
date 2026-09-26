import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ValidationResult { ok: boolean; errors: string }
export async function validateWithTsc(workspaceRoot: string, generatedPaths: string[] = []): Promise<ValidationResult> {
  // Invoke the workspace compiler directly: equivalent to npx --no-install tsc,
  // without a Windows .cmd shell or an implicit package download.
  const compiler = path.join(workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(compiler)) return { ok: false, errors: 'Install TypeScript in this workspace first (npm install --save-dev typescript).' };
  if (!existsSync(path.join(workspaceRoot, 'tsconfig.json'))) return { ok: false, errors: 'A tsconfig.json is required in the workspace root.' };
  return new Promise(resolve => {
    execFile(process.execPath, [compiler, '--noEmit', '-p', '.', '--pretty', 'false', '--listFiles'], {
      cwd: workspaceRoot, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (error, stdout, stderr) => {
      const normalize = (file: string): string => {
        const normalized = path.resolve(file).replace(/\\/g, '/');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      };
      const checked = new Set(stdout.split(/\r?\n/).filter(line => path.isAbsolute(line)).map(normalize));
      const missing = generatedPaths.filter(file => file.endsWith('.ts') && !checked.has(normalize(file)));
      const diagnostics = stdout.split(/\r?\n/).filter(line => !checked.has(normalize(line))).join('\n');
      resolve({
        ok: !error && missing.length === 0,
        errors: error ? [diagnostics, stderr, !diagnostics.trim() && !stderr ? error.message : ''].filter(Boolean).join('\n')
          : missing.length ? `Generated TypeScript files are excluded by tsconfig.json: ${missing.join(', ')}. Include the output directories in your TypeScript project.` : '',
      });
    });
  });
}
