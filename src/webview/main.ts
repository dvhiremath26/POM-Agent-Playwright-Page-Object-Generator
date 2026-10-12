/// <reference lib="dom" />
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

(() => {
  const vscode = acquireVsCodeApi();
  type State = import('../sidebarTypes').SidebarState;
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const input = (id: string): HTMLInputElement => get<HTMLInputElement>(id);
  let current: State | undefined;
  let revision = -1;
  let stepsRevision = -1;
  const steps = get<HTMLTextAreaElement>('test-steps');
  const stepsInfo = (file?: string): void => { get('steps-info').textContent = `${file ? `${file} · ` : ''}${steps.value.length.toLocaleString()} / 12,000 characters`; };
  const updateSteps = (): void => { stepsInfo(); vscode.postMessage({ type: 'setTestSteps', text: steps.value }); };
  steps.addEventListener('input', updateSteps);
  get('clear-steps').addEventListener('click', () => { steps.value = ''; updateSteps(); steps.focus(); });
  const send = (type: string): void => vscode.postMessage({ type });
  for (const [id, type] of Object.entries({ browse: 'browse', 'change-source': 'browse', 'use-file': 'useFile', 'use-selection': 'useSelection', cancel: 'cancel', 'open-source': 'openSource', 'show-output': 'showOutput', 'open-folder': 'openFolder', refresh: 'refresh', 'save-all': 'saveAll' })) {
    get(id).addEventListener('click', () => send(type));
  }
  get('browse-steps').addEventListener('click', () => send('browseSteps'));
  get('run').addEventListener('click', () => {
    if (!current || current.busy || !current.source) return;
    const settings = {
      pagesDir: input('pagesDir').value, testsDir: input('testsDir').value, testDataDir: input('testDataDir').value,
      conventionsFile: input('conventionsFile').value,
      generationMode: get<HTMLSelectElement>('generationMode').value,
      copilotModel: input('copilotModel').value,
      continuationSpec: input('continuationSpec').value,
    };
    // Immediately prevent double submissions while the host validates the request.
    get<HTMLButtonElement>('run').disabled = true;
    vscode.postMessage({ type: 'run', settings, testSteps: steps.value });
  });
  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    const state = event.data.state as State;
    current = state;
    if (stepsRevision !== (state.stepsRevision ?? 0)) {
      steps.value = state.testSteps ?? ''; stepsRevision = state.stepsRevision ?? 0; stepsInfo(state.stepsFile);
    }
    steps.disabled = state.busy;
    get<HTMLButtonElement>('browse-steps').disabled = state.busy;
    get<HTMLButtonElement>('clear-steps').disabled = state.busy;
    if (revision !== state.settingsRevision) {
      for (const key of ['pagesDir', 'testsDir', 'testDataDir', 'conventionsFile'] as const) input(key).value = state.settings[key];
      get<HTMLSelectElement>('generationMode').value = state.settings.generationMode ?? 'copilot';
      input('copilotModel').value = state.settings.copilotModel ?? '';
      input('continuationSpec').value = state.settings.continuationSpec ?? '';
      revision = state.settingsRevision;
    }
    get('empty-source').hidden = !!state.source;
    get('chosen-source').hidden = !state.source;
    if (state.source) {
      get('source-name').textContent = state.source.name;
      get('source-path').textContent = state.source.path;
      get('source-detail').textContent = `${state.source.workspace} · ${state.source.kind === 'selection' ? 'Selected code' : 'Whole file'}`;
      get('line-count').textContent = `${state.source.lines} lines`;
      get('source-preview').textContent = state.source.preview;
    }
    for (const id of ['browse', 'change-source', 'use-file', 'use-selection', 'open-folder', 'save-all', 'refresh']) get<HTMLButtonElement>(id).disabled = state.busy;
    document.querySelectorAll<HTMLInputElement>('.fields input').forEach(element => { element.disabled = state.busy; });
    input('continuationSpec').disabled = state.busy;
    get<HTMLSelectElement>('generationMode').disabled = state.busy;
    get<HTMLButtonElement>('run').disabled = state.busy || !state.source || state.checks.some(check => !check.ok);
    get('run').firstChild!.textContent = state.busy ? 'Working… ' : 'Generate page objects ';
    get('cancel').hidden = !state.busy;
    get('checks').replaceChildren(...state.checks.map(check => {
      const span = document.createElement('span'); span.textContent = check.label; span.className = check.ok ? 'check-ok' : 'check-missing'; return span;
    }));
    get('activity').hidden = state.status === 'idle';
    get('activity').dataset.status = state.status;
    get('activity-title').textContent = ({ idle: 'Ready', running: 'Conversion in progress', success: 'Your page objects are ready', error: 'Something needs attention', cancelled: 'Conversion cancelled' })[state.status];
    get('status-message').textContent = state.message;
    get('naming-notice').hidden = !state.result?.namingNotice;
    get('naming-notice').textContent = state.result?.namingNotice ?? '';
    get('logs').textContent = state.logs.join('\n');
    get('metrics').hidden = !state.result;
    if (state.result) {
      get('metrics').replaceChildren(...[[state.result.mode, 'Processing'], [String(state.result.requests), 'AI requests'], [String(state.result.changed), 'Files changed']].map(([value, label]) => {
        const box = document.createElement('div'); box.className = 'metric';
        const strong = document.createElement('strong'); strong.textContent = value;
        const small = document.createElement('span'); small.textContent = label; box.append(strong, small); return box;
      }));
    }
    get('result-files').replaceChildren(...state.files.map((file, index) => {
      const button = document.createElement('button'); button.className = 'result-file'; button.textContent = `${file.name} ↗`;
      const location = document.createElement('span'); location.textContent = file.path; button.append(location);
      button.addEventListener('click', () => vscode.postMessage({ type: 'openFile', index })); return button;
    }));
  });
  send('ready');
})();
