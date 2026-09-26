import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { generateLocally } from '../dist/localGenerator';
import { parseNamingPlan } from '../dist/copilotNaming';
import { enterpriseRecording } from './fixtures/enterpriseRecording';
import { rfiRecording, rfiSteps } from './fixtures/rfiRecording';
import { describedRoleRecording } from './fixtures/describedRoleRecording';

test('generated enterprise flow preserves every recorded action, argument, frame chain, and popup wait order', async () => {
  const result = generateLocally(enterpriseRecording, { existingPages: [], conventions: null }).result;
  assert.ok(result);
  const observe = async (entry: string, sources: Map<string, string>) => {
    const events: unknown[] = [];
    const runs: Promise<void>[] = [];
    const actions = new Set(['click', 'fill', 'check', 'uncheck', 'press', 'selectOption', 'toBeVisible']);
    const chain = (segments: unknown[] = []): unknown => new Proxy({}, {
      get(_target, key) {
        if (key === 'then') return undefined;
        return (...args: unknown[]) => {
          if (key === 'waitForEvent') {
            events.push(['listen', args]);
            return { then(resolve: (value: unknown) => void) { events.push(['awaitPopup']); resolve({}); } };
          }
          if (key === 'goto' || actions.has(String(key))) {
            events.push([key, segments, args]); return Promise.resolve();
          }
          return chain([...segments, [key, args]]);
        };
      },
    });
    const modules = new Map<string, { exports: unknown }>();
    const load = (file: string): unknown => {
      if (modules.has(file)) return modules.get(file)!.exports;
      const code = sources.get(file);
      assert.notEqual(code, undefined, `Unexpected module: ${file}`);
      if (file.endsWith('.json')) return JSON.parse(code!);
      const module = { exports: {} }; modules.set(file, module);
      const requireLocal = (specifier: string): unknown => {
        if (specifier === '@playwright/test') return { expect: (target: unknown) => target, test: (_title: string, callback: (fixtures: unknown) => Promise<void>) => { runs.push(callback({ page: chain() })); } };
        const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        return load(sources.has(candidate) ? candidate : `${candidate}.ts`);
      };
      const javascript = ts.transpileModule(code!, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, useDefineForClassFields: false } }).outputText;
      runInNewContext(`(function(require, module, exports) { ${javascript}\n})`, {})(requireLocal, module, module.exports);
      return module.exports;
    };
    load(entry); await Promise.all(runs);
    // Normalize values across VM realms before comparing their structural content.
    return JSON.parse(JSON.stringify(events));
  };
  const original = await observe('recording.ts', new Map([['recording.ts', enterpriseRecording]]));
  const generated = await observe(result.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(result.files.map(file => [file.path, file.content])));
  assert.deepEqual(generated, original);
  assert.deepEqual(generated.slice(0, 3).map((event: unknown[]) => event[0]), ['listen', 'goto', 'awaitPopup']);
  const named = generateLocally(enterpriseRecording, { existingPages: [], conventions: null, testSteps: 'Test: Buyer creates a sourcing project' }).result!;
  const namedTrace = await observe(named.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(named.files.map(file => [file.path, file.content])));
  assert.deepEqual(namedTrace, original, 'Descriptive names must preserve every recorded value and action');
  const metadata = generateLocally(enterpriseRecording, { existingPages: [], conventions: null }).namingActions!;
  const copilotNamed = generateLocally(enterpriseRecording, { existingPages: [], conventions: null,
    namingPlan: { title: 'Copilot organized flow', steps: metadata.map((action, index) => ({ action: action.action, label: `Meaningful control ${index}`, page: index < 10 ? 'Login' : index < 12 ? 'Navigation' : index < 14 ? 'Project List' : index < 16 ? 'Rfi Creation' : 'Project Details' })) },
  }).result!;
  assert.deepEqual(await observe(copilotNamed.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(copilotNamed.files.map(file => [file.path, file.content]))), original,
    'Copilot may group actions across page classes; executable action/value/frame/popup semantics stay identical');
  assert.equal(copilotNamed.files.filter(file => file.path.endsWith('.locators.ts')).length, 5);
  for (const response of ['invalid response', JSON.stringify({ steps: [{ index: 2, action: 'fill', label: 'Buyer username' }] })]) {
    const { namingNotice, ...namingPlan } = parseNamingPlan(response, metadata);
    assert.ok(namingNotice);
    const recovered = generateLocally(enterpriseRecording, { existingPages: [], conventions: null, namingPlan }).result!;
    assert.deepEqual(await observe(recovered.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(recovered.files.map(file => [file.path, file.content]))), original,
      'Invalid or partial naming must retain all actions, literal values, iframe boundaries and popup waits');
  }
  const rfi = generateLocally(rfiRecording, { existingPages: [], conventions: null, testSteps: rfiSteps }).result!;
  assert.deepEqual(
    await observe(rfi.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(rfi.files.map(file => [file.path, file.content]))),
    await observe('recording.ts', new Map([['recording.ts', rfiRecording]])),
    'Partial English naming must retain the extra Sourcing click and every iframe boundary',
  );
  const described = generateLocally(describedRoleRecording, { existingPages: [], conventions: null }).result!;
  assert.ok(described);
  assert.deepEqual(
    await observe(described.files.find(file => file.path.endsWith('.spec.ts'))!.path, new Map(described.files.map(file => [file.path, file.content]))),
    await observe('recording.ts', new Map([['recording.ts', describedRoleRecording]])),
    'Description filters, all frame scopes, actions and the final assertion must survive conversion unchanged',
  );
});
