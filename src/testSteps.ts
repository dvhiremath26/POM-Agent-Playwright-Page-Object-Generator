export const maxTestStepsChars = 12_000;

export interface NamingStep { action: string; label: string; page?: string }
export interface TestStepHints { title?: string; steps: NamingStep[]; reason?: string }
export interface RecordedNamingAction { action?: string; label?: string }

function words(label: string): Set<string> {
  const ignored = new Set(['the', 'a', 'an', 'page', 'menu', 'application', 'icon', 'button', 'link', 'field', 'textbox', 'input', 'checkbox', 'dropdown']);
  return new Set(label.toLowerCase().split(/[^a-z]+/).filter(word => word && !ignored.has(word)).map(word => /^(login|username|user)$/.test(word) ? 'username' : word));
}

/** Use ordered, unambiguous control-name anchors; unnamed gaps need an exact action match. */
export function alignTestSteps(hints: TestStepHints, actions: RecordedNamingAction[]): { steps: (NamingStep | undefined)[]; namingNotice?: string } {
  const steps: (NamingStep | undefined)[] = actions.map(() => undefined);
  const fallback = (reason: string) => ({ steps, namingNotice: `English action names were not applied; names came from the recording. ${hints.title ? 'Your explicit test title was kept. ' : ''}${reason}` });
  if (hints.reason) return fallback(hints.reason);
  if (!hints.steps.length) return { steps };
  if (hints.steps.length === actions.length && hints.steps.every((step, index) => step.action === actions[index].action)) return { steps: [...hints.steps] };
  const anchors: { step: number; action: number }[] = [];
  hints.steps.forEach((step, stepIndex) => {
    const query = words(step.label);
    const ranked = actions.map((action, index) => ({ index, score: action.action === step.action ? [...words(action.label ?? '')].filter(word => query.has(word)).length : 0 }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    if (ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score)) anchors.push({ step: stepIndex, action: ranked[0].index });
  });
  if (anchors.some((anchor, index) => index > 0 && anchor.action <= anchors[index - 1].action)) return fallback('The English control names do not follow the recording order.');
  // Require a real control-name anchor before filling positional gaps in unequal lists.
  if (!anchors.length) return fallback('The English steps could not be matched confidently to the recording.');
  for (const anchor of anchors) steps[anchor.action] = hints.steps[anchor.step];
  const boundaries = [{ step: -1, action: -1 }, ...anchors, { step: hints.steps.length, action: actions.length }];
  for (let i = 1; i < boundaries.length; i++) {
    const before = boundaries[i - 1], after = boundaries[i];
    const count = after.step - before.step - 1;
    if (count !== after.action - before.action - 1) continue;
    const gap = hints.steps.slice(before.step + 1, after.step);
    if (gap.every((step, index) => step.action === actions[before.action + 1 + index].action)) {
      gap.forEach((step, index) => { steps[before.action + 1 + index] = step; });
    }
  }
  const matched = steps.filter(Boolean).length;
  return { steps, namingNotice: `${matched} of ${actions.length} recorded actions were named from the English steps. Unmatched actions kept recording-based names; all recorded actions were preserved.${matched < hints.steps.length ? ` ${hints.steps.length - matched} English step(s) could not be matched.` : ''}` };
}

export function validateTestSteps(value: unknown): string {
  if (typeof value !== 'string' || value.length > maxTestStepsChars || value.includes('\0')) {
    throw new Error('Test steps must be plain text, up to 12,000 characters.');
  }
  return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

/** Only unambiguous, one-action-per-line phrases are interpreted without AI. */
export function parseTestSteps(text: string): TestStepHints {
  const hints: TestStepHints = { steps: [] };
  for (let line of validateTestSteps(text).split('\n').map(line => line.trim()).filter(Boolean)) {
    line = line.replace(/\*\*/g, '');
    if (/^(?:#{1,6}\s*)?(?:english steps|test steps|steps|steps to execute)\s*:?$/i.test(line)) continue;
    const title = line.match(/^(?:#{1,6}\s+|(?:test(?:\s+(?:name|case))?|scenario|title)\s*:\s*)(.+)$/i);
    if (title && !hints.title && !hints.steps.length) { hints.title = title[1].trim(); continue; }
    line = line.replace(/^(?:(?:step\s+)?\d+[.):]\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/i, '').replace(/[.!]$/, '');
    line = line.replace(/^naviagte\b/i, 'Navigate');
    const match = line.match(/^(open|navigate to|go to|visit|enter|fill|type|click(?: on)?|check|uncheck|select|press|verify|expect)\s+(.+)$/i);
    if (!match) { hints.reason = 'Some English steps need interpretation. Use a title and one action per line for local naming.'; return hints; }
    const verb = match[1].toLowerCase();
    let label = match[2];
    let action = ({ open: 'goto', 'navigate to': 'goto', 'go to': 'goto', visit: 'goto', enter: 'fill', fill: 'fill', type: 'fill', 'click on': 'click', select: 'selectOption', verify: 'assert', expect: 'assert' } as Record<string, string>)[verb] ?? verb;
    if (action === 'goto' && /\b(?:menu|tab|link|button)\s*$/i.test(label)) action = 'click';
    if (action === 'fill') {
      const destination = label.match(/^.+?\s+(?:into|in)\s+(.+)$/i);
      label = destination ? destination[1] : label.replace(/\s+with\s+.+$/i, '');
    }
    if (action === 'assert') {
      const assertion = label.match(/^(.+?)\s+is\s+(visible|hidden|checked|enabled|disabled)$/i);
      if (!assertion) { hints.reason = 'The English assertion needs interpretation.'; return hints; }
      label = assertion[1]; action = `toBe${assertion[2][0].toUpperCase()}${assertion[2].slice(1).toLowerCase()}`;
    }
    label = label.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:field|textbox|input|button|link|dropdown|checkbox|menu|tab|icon)$/i, '').trim();
    // Never turn quoted values, URLs, or multi-action prose into guessed identifiers.
    if (!/^[a-z][a-z0-9 _-]{0,79}$/i.test(label) || /\b(?:and|then|using|with)\b/i.test(label)) {
      hints.reason = 'An English step has an ambiguous name. Use a short, single-action phrase.'; return hints;
    }
    hints.steps.push({ action, label });
  }
  if (!hints.title && !hints.steps.length) hints.reason = 'Add a test title or English steps.';
  return hints;
}
