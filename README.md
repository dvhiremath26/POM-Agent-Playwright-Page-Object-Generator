# POM Agent

Convert Playwright Codegen recordings into page objects, locator classes, tests, and JSON test data. **GitHub Copilot groups actions into logical screens and chooses names; POM Agent builds and validates the code locally.** Copilot organization is enabled by default. Each uncached run uses at most one request, with no automatic retry or repair. Local only remains available with zero requests.

## Install

Install `pom-agent-1.0.4.vsix` using **Extensions → … → Install from VSIX**, then reload VS Code. Click **POM Agent** in the Activity Bar, or use **POM Agent: Open Dashboard**. Sign in to GitHub Copilot in VS Code to use Copilot organization.

Open a trusted Playwright workspace with a root `tsconfig.json`, locally installed TypeScript, `@playwright/test`, and Node types. Include generated pages/tests in the TypeScript configuration. Set `"useDefineForClassFields": false` under `compilerOptions` for locator initializers that use the constructor's page parameter. The extension checks compatibility without modifying project configuration.

Development requires Node.js 22+ and VS Code 1.96+:

```sh
npm ci
npm test
npm run package
```

## Use

1. **Choose a recording.** Browse for a local .ts file, use the open file, or use selected complete statements. The original recording is preserved; keep it separate from generated tests.
2. **Describe the test (optional).** Paste English steps or load a .txt/.md file. Loaded text is editable. Without notes, Copilot infers names from action/selector descriptions.
3. **Choose the generation mode and output folders.** GitHub Copilot organization groups logical screens and interprets flexible English for clearer locator/method/data names. Local only groups by navigation URL and uses simple naming rules. Output defaults are pages, tests, and test-data; paths are relative to the recording's workspace.
4. **Check readiness and generate.** Save files and resolve setup errors, then click Generate page objects. Follow progress, cancel, and open generated results from the sidebar.

For a recording split into two portions, generate the first portion normally. For the second portion, enter the first generated test's workspace-relative path in **Continuation spec file**, for example `tests/buyer-flow/buyer-flow.spec.ts`. The second portion may begin directly with an interaction; it does not need to repeat `page.goto()`. POM Agent adds a marked continuation block to the selected test, adds only the required page-object members, and refuses an invalid or missing spec path.

The right-click and Command Palette file/selection commands remain available and use workspace settings. The sidebar adapts to VS Code themes and narrow widths and supports keyboard use. It loads no remote UI assets. Sidebar options apply to the current sidebar session.

## Copilot and request costs

On an uncached Copilot run, POM Agent first checks that it can preserve the recording, then opens a model picker before making one request through the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model). You choose which eligible model to use, even when only one is available. An optional preferred model ID appears first when available but does not bypass the picker. An unavailable preference lets you choose another model; no model is selected automatically. Cancelling the picker sends no request and writes no generated files. The chosen model appears in Run details. VS Code may also request GitHub sign-in or Copilot access consent.

Cached results and Local only runs use no model picker or request. The 0.6.1 upgrade invalidates earlier run-cache entries so the first generation lets you choose a model again. To try another model after a successful cached run, change the preferred model ID in Output folders & options (or pomAgent.copilotModel); changing it invalidates that run's cache and puts the preference first in the picker. The logical-screen grouping and naming improvements remain enabled.

Only GitHub Copilot models are used. Claude/Anthropic, auto routing, and known internal utility/dictation endpoints are excluded. If no eligible model is available, generation stops with a sign-in/access explanation instead of a picker. A model advertised as available may still reject an extension request; POM Agent reports the error without retrying another model. Charges depend on the selected model and your Copilot plan; the extension does not promise a free model.

Local retrieval selects relevant existing page files, then extracts class/member names. The prompt includes those names, ordered action/selector descriptions, English notes, and naming conventions. Recorded fill/select/press values and navigation URLs are omitted; selector text and any sensitive values you include in notes or conventions can still be sent. The default input budget is 6,000 tokens. Oversized inputs stop before sending. Responses are limited to a validated naming plan, not code. Changed wording can produce different names; unchanged validated output uses the local cache with zero requests.

Copilot assigns each action a logical screen/component as well as a name. This can split a flow with just one `page.goto()` into Login, Navigation, Project List, and RFI Creation, each with its own page class and locator class. Frame chains remain complete within each locator; an iframe alone does not force a new class. A transition click stays on the screen that contains its control. The generated test creates the required page objects and calls their methods in the original order. Returning to a screen reuses its page object. All objects share the recorded Playwright page; splitting classes does not add navigation.

For a login → menus → project list → RFI creation flow, an example structure is:

```text
pages/
  base.page.ts
  login/login.page.ts
  login/login.locators.ts
  navigation/navigation.page.ts
  navigation/navigation.locators.ts
  project-list/project-list.page.ts
  project-list/project-list.locators.ts
  rfi-creation/rfi-creation.page.ts
  rfi-creation/rfi-creation.locators.ts
```

Exact group names depend on the recording, English steps and Copilot response. A genuinely single-screen flow remains one class. Describe the screen names in your English steps to guide grouping. Missing or invalid group assignments retain the current screen, falling back to the navigation route, and show a visible notice. Arbitrary file paths and reserved class/folder names are not accepted from the model.

Upgrading from 0.5.x invalidates the old generation cache so the flow can be organized again. Earlier single-class files and tests are preserved; the new generated test imports the split classes. Existing members within each matching screen class retain their names for compatibility. This release does not delete or rewrite older tests or generate arbitrary custom architectures from prose.

Naming responses are matched by one-based recording indices. Extra metadata is ignored, ordinary punctuation in labels is normalized, and fenced JSON is accepted. Missing, duplicate, ambiguous or incompatible entries use local English/recording-based names; malformed naming JSON also falls back locally. A visible notice reports how many action names came from Copilot and survives cache reuse. The action sequence, values and selectors always come from the recording, never the naming response. No additional request is made to repair a naming response. Authentication, unavailable models, request limits and cancellation still report their own errors.

## English naming guidance

Use a title and one simple step per recorded action, including navigation, in order:

```text
Test: Buyer signs in
1. Open login page
2. Enter buyer username
3. Enter buyer password
4. Click Continue
```

For a matching recording this names a new locator `BUYER_USERNAME_FIELD`, method `enterBuyerUsername()`, data key `buyerUsername`, and test `Buyer signs in`. Test/data filenames start with `buyer-signs-in` and include a hash to retain different flows. The recording supplies the selectors, values, and action sequence; notes never replace them.

In Copilot mode, flexible wording, typos and omitted intermediate steps are interpreted into names for the complete action list. In Local only, accepted phrases include Open, Go to, Enter, Fill, Click, Check, Uncheck, Select, Press, and assertions such as `Verify welcome message is visible`. Test:/Scenario:/Title: or a Markdown heading supplies the title. Numbered lists and Markdown bullets are accepted. When counts differ, ordered control-name matches anchor the mapping. Unmatched actions retain recording-based names with a visible notice. Explicit titles are retained in both modes. Unsupported Codegen operations still stop safely before any request.

Existing locators and methods retain their names so other tests remain compatible. New data keys, titles, and flow files use the notes. Changing notes invalidates the cache and preserves earlier flow files. Notes are an in-memory snapshot; only their hash and a generic naming notice are cached, not raw note content; switching to a different recording clears them.

Imports support UTF-8 and BOM-marked UTF-16 Notepad files, up to 64 KB / 12,000 characters. Loading does not modify the notes file. Notes are sent only when running in Copilot mode.

## Locator and page layout

```ts
import { Locator, Page } from '@playwright/test';

export class LoginLocators {
  constructor(private page: Page) {}

  readonly USERNAME_FIELD: Locator = this.page.getByRole('textbox', { name: 'Login' });

  readonly PASSWORD_FIELD: Locator = this.page.getByRole('textbox', { name: 'Password' });

  readonly LOGIN_BUTTON: Locator = this.page.getByRole('button', { name: 'Login' });
}
```

New page classes use two-space indentation, multiline constructors/methods, one statement per line, and blank lines between members. Locator declarations are separated by a blank line, with comments directly above the locator they describe. Merged locator files get the same spacing; valid cache hits refresh locator spacing locally without another Copilot request. Identical selectors reuse existing names. Distinct selectors with the same label receive numeric suffixes. Existing methods keep their content during additive merges; whitespace differences alone do not prevent reuse.

## Iframes and local conversion

The full frame chain is retained, including the selector-free cross-frame search:

```ts
readonly CONTINUE_LINK: Locator = this.page
  .frameLocator()
  .locator("iframe[id='xyz123']")
  .contentFrame()
  .getByRole('link', { name: 'Continue' });
```

Removing frameLocator() changes the search scope. POM Agent now supports it locally and does not remove it to satisfy older Playwright types. The workspace must use a Playwright version supporting the recorded API. See [Playwright's frameLocator documentation](https://playwright.dev/docs/api/class-page#page-frame-locator).

When two or more locators in the same locator class use the identical completed iframe scope, POM Agent declares that scope once as a `FrameLocator` and chains the element locators from it. For example:

```ts
readonly FRAME_28FA358BD9: FrameLocator = this.page
  .locator('[data-testid="iframe"]')
  .contentFrame()
  .locator('iframe[name="frmMain"]')
  .contentFrame();

readonly SEARCH_LINK: Locator = this.FRAME_28FA358BD9.getByRole('link', { name: 'Search' });

readonly NEW_LINK: Locator = this.FRAME_28FA358BD9.getByRole('link', { name: 'New' });
```

The optimization is scoped to each page class and only applies to repeated, identical frame paths. One-off frame chains remain inline. Existing generated frame fields are recognized on later runs, so locators and methods are not duplicated.

Local conversion accepts a single plain async test with the page fixture, or awaited statements starting with literal page.goto(). Supported factories include getByRole, getByTestId, getByLabel, getByPlaceholder, getByText, literal locator(), frameLocator(), contentFrame(), and locator first()/last()/nonnegative nth(). It preserves nested scopes and selector strings. CSS/XPath selectors receive a review comment, not an automatic replacement.

Role locators support literal string `name` and `description` filters, together or separately, and boolean `exact`. For example, `page.frameLocator().locator('iframe[name="tabs"]').contentFrame().getByRole('link', { description: 'Search', exact: true })` keeps its complete chain and description filter. The description supplies a naming label only when no name is recorded. Your project's Playwright version must support the recorded APIs; generated code is checked against that project's installed types. Error line numbers refer to the Codegen script, including its blank lines, not the English steps.

Actions include click, fill, press, check, uncheck, and string selectOption. Assertions include toBeVisible, toBeHidden, toBeChecked, toBeEnabled, toBeDisabled, and string toHaveText/toContainText/toHaveValue. The adjacent popup wait → goto → await pattern is retained when its popup handle is unused. A recorded wait still waits even if the site never opens the popup.

Custom fixtures, multiple tests, loops, dynamic arguments, regex selectors, used popup handles, manually authored page interfaces, and unsupported methods/options stop with an explanation before spending credits. No statement is silently discarded. Copilot handles naming and logical-screen grouping; it cannot change selectors, action order, class templates or runtime behavior. In Local only, a nonempty conventions file requiring interpretation must be adapted or omitted from the configured path. Tests use CommonJS require for JSON and must match your TypeScript project setup.

## Validation and output safety

The extension scans page objects locally to reuse matching members. Copilot naming uses bounded local lexical retrieval for relevant naming vocabulary; no hosted RAG service or embedding requests are used.

Output is restricted to configured workspace directories. Junctions/symlinks escaping the workspace, stale selections, unsaved files, and conflicting writes are rejected. TypeScript checks run through the workspace's local compiler, verify generated-file inclusion, and roll back failed writes. There is no automatic AI repair. Cancelled writes roll back before completion. Existing unrelated compiler errors stop generation before output changes.

Successful generation maintains pageMap.json and up to 20 hash/path cache entries in VS Code workspace state. Cached output is revalidated locally. Edited tracked files or changed notes invalidate reuse. The extension never overwrites existing test/data files with different content; older incorrectly generated files need review rather than silent replacement.

## Settings

| Setting | Default |
| --- | --- |
| pomAgent.pagesDir | pages |
| pomAgent.testsDir | tests |
| pomAgent.testDataDir | test-data |
| pomAgent.conventionsFile | conventions.md |
| pomAgent.generationMode | copilot |
| pomAgent.copilotModel | empty (choose in the model picker) |
| pomAgent.maxInputTokens | 6000 |

All paths are relative to the recording's workspace. The extension has no telemetry. Old maxCopilotRequests settings do not override the new mode; choose Local only to disable requests.

## Verification

Tests cover local and mocked Copilot generation/cache, schema validation, token budgets, model filtering, English naming and import handling, full iframe chains, actual generated-code compilation, unchanged action/value sequences, merge compatibility, rollback, cancellation, path restrictions, and sidebar messages. Browser tests check the real sidebar and clicking through nested iframes using generated locators. Set POM_TEST_BROWSER to a Chromium executable where Chrome/Edge is not installed at standard Windows paths. Browser tests are skipped if no executable is available. No live application credentials or paid model calls are used.
