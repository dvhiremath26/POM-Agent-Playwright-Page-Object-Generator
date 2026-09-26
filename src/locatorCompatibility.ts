import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { ts } from 'ts-morph';

/** Parameter-property-backed initializers require assignment-style class emit. */
export function checkLocatorCompatibility(root: string): void {
  const config = path.join(root, 'tsconfig.json');
  if (!existsSync(config)) return; // Baseline validation reports missing compiler configuration.
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return;
  const options = parsed.options;
  const moduleTarget = options.module === ts.ModuleKind.NodeNext ? ts.ScriptTarget.ESNext
    : options.module === ts.ModuleKind.Node20 ? ts.ScriptTarget.ES2023
      : options.module === ts.ModuleKind.Node16 || options.module === ts.ModuleKind.Node18 ? ts.ScriptTarget.ES2022 : ts.ScriptTarget.ES5;
  const target = options.target ?? moduleTarget;
  if (options.useDefineForClassFields ?? target >= ts.ScriptTarget.ES2022) {
    throw new Error('This locator format initializes fields from constructor(private page: Page). Set "useDefineForClassFields": false inside compilerOptions in your project tsconfig.json so page is assigned before locator fields initialize. No AI request was made.');
  }
}
