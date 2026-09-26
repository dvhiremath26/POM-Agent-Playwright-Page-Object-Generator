export function sidebarHtml(scriptUri: string, styleUri: string, nonce: string, cspSource: string): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(cspSource)}; script-src 'nonce-${escape(nonce)}'; img-src ${escape(cspSource)};">
<link rel="stylesheet" href="${escape(styleUri)}"><title>POM Agent</title></head>
<body><main>
  <header class="hero"><div class="eyebrow"><span class="brand-mark" aria-hidden="true">P</span> PLAYWRIGHT WORKSPACE</div><h1>From recording<br>to reusable tests.</h1><p>Clear names with Copilot. Structured code with every recorded action.</p><span class="badge"><span class="dot"></span> GitHub Copilot · One request at most</span></header>
  <section class="card" aria-labelledby="source-title"><div class="section-heading"><span class="step">01</span><h2 id="source-title">Choose your recording</h2></div>
    <div id="empty-source" class="empty-source"><span class="file-glyph" aria-hidden="true">{ }</span><p>Start with a Codegen file</p><span>Choose a .ts recording from your project.</span><button id="browse" class="secondary full">Choose recording…</button></div>
    <div id="chosen-source" hidden><div class="source-card"><span class="file-glyph" aria-hidden="true">TS</span><div class="source-copy"><strong id="source-name"></strong><span id="source-detail"></span></div><button id="change-source" class="text-button">Change</button></div><p id="source-path" class="muted wrap"></p><details class="preview"><summary>Preview recording <span id="line-count"></span></summary><pre id="source-preview"></pre><button id="open-source" class="text-button">Open in editor ↗</button></details></div>
    <div class="button-pair"><button id="use-file" class="secondary">Use open file</button><button id="use-selection" class="secondary">Use selection</button></div>
    <button id="open-folder" class="text-button">Open a project folder…</button>
  </section>
  <section class="card" aria-labelledby="steps-title"><div class="section-heading"><span class="step">02</span><h2 id="steps-title">Describe your test <span class="muted">(optional)</span></h2></div>
    <label for="test-steps">Test steps in plain English</label>
    <textarea id="test-steps" rows="7" maxlength="12000" aria-describedby="steps-help" placeholder="Test: Buyer signs in&#10;1. Open login page&#10;2. Enter buyer username&#10;3. Enter buyer password&#10;4. Click Continue"></textarea>
    <div class="button-pair"><button id="browse-steps" class="secondary">Load .txt or .md…</button><button id="clear-steps" class="text-button">Clear steps</button></div>
    <p id="steps-info" class="muted wrap" aria-live="polite">0 / 12,000 characters</p>
    <p id="steps-help" class="hint">Describe what your test does and which screens it uses. Copilot groups actions into logical page classes and names locators, methods, test data, and the test. Unmatched suggestions use local rules with a notice, without another AI request. Selectors, iframe chains, and recorded values stay the same. Existing files are preserved.</p>
  </section>
  <section class="card" aria-labelledby="mode-title"><div class="section-heading"><span class="step">03</span><h2 id="mode-title">Organize your code</h2></div>
    <label for="generationMode">Generation mode</label>
    <select id="generationMode"><option value="copilot">GitHub Copilot organization (recommended)</option><option value="local">Local only · Zero AI requests</option></select>
    <p class="hint">Copilot groups logical screens and names actions in one request, even when the recording navigates only once. POM Agent builds and checks the code locally. Local only groups by navigation URL. Unchanged validated results use the cache. No automatic retries. Charges depend on your Copilot plan.</p>
    <p class="hint">Copilot receives action and selector descriptions, your English steps, naming conventions, and relevant existing member names. Recorded action values are kept local. Avoid including secrets in your English steps.</p>
    <details id="options"><summary>Output folders &amp; options</summary><div class="fields">
      <label>Page objects<input id="pagesDir" type="text" value="pages" spellcheck="false"></label>
      <label>Tests<input id="testsDir" type="text" value="tests" spellcheck="false"></label>
      <label>Test data<input id="testDataDir" type="text" value="test-data" spellcheck="false"></label>
      <label>Conventions file<input id="conventionsFile" type="text" value="conventions.md" spellcheck="false"></label>
      <label>Preferred Copilot model ID (optional)<input id="copilotModel" type="text" placeholder="Choose in the model picker before generation" spellcheck="false"></label>
      <p class="hint">Choose the model before each new Copilot request. An available preferred model appears first in the picker; you can still choose another. Cached results use no request or picker. Paths are relative to your project. These choices apply to sidebar runs.</p>
    </div></details>
  </section>
  <section class="run-section"><div id="checks" class="checks" aria-label="Project readiness"></div><details id="setup-help"><summary>Need help with project setup?</summary><p class="hint">Open your Playwright project folder and save your files. Install missing dependencies in that project's terminal:</p><pre>npm install --save-dev typescript @playwright/test @types/node</pre><p class="hint">Add a root tsconfig.json that includes your recordings, page objects, and tests. Inside compilerOptions, set &quot;useDefineForClassFields&quot;: false so locator fields can use the constructor’s page. Then refresh the checks.</p></details><div class="button-pair setup-actions"><button id="save-all" class="text-button">Save workspace files</button><button id="refresh" class="text-button">Refresh checks</button></div><button id="run" class="primary full" disabled>Generate page objects <span aria-hidden="true">→</span></button><button id="cancel" class="secondary full" hidden>Cancel conversion</button><p class="footnote">Your recording is preserved. Generated files are checked before completion.</p></section>
  <section id="activity" class="card activity" hidden aria-labelledby="activity-title"><div class="section-heading"><span id="status-dot" class="dot"></span><h2 id="activity-title">Conversion progress</h2></div><p id="status-message" role="status" aria-live="polite"></p><p id="naming-notice" class="naming-notice" role="status" hidden></p><div id="metrics" class="metrics" hidden></div><div id="result-files" class="result-files"></div><details id="log-details"><summary>Run details</summary><pre id="logs"></pre></details><button id="show-output" class="text-button">Open detailed output ↗</button></section>
  <footer>POM AGENT <span>Bounded AI · No telemetry</span></footer>
</main><script nonce="${escape(nonce)}" src="${escape(scriptUri)}" defer></script></body></html>`;
}
