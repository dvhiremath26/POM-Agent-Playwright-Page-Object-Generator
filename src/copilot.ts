import type * as Vscode from 'vscode';
import { CopilotClient } from './copilotNaming';

interface CopilotOptions {
  modelId: string; maxInputTokens: number; token: Vscode.CancellationToken;
  report(message: string): void;
}

export function isEligibleCopilotModel(model: Pick<Vscode.LanguageModelChat, 'vendor' | 'id' | 'family' | 'name'>): boolean {
  const identity = `${model.id} ${model.family} ${model.name}`;
  return model.vendor === 'copilot'
    && !/claude|anthropic|(?:^|[\s:/_-])auto(?:$|[\s:/_-])/i.test(identity)
    && !/(?:^|[\s/])copilot-(?:utility|dictation)(?:[\s-]|$)/i.test(identity);
}

/** Discovery and consent are deferred until a user-initiated generation needs one request. */
export function createCopilotClient(options: CopilotOptions, api?: typeof Vscode): CopilotClient {
  return { async complete(instructions, prompt) {
    const vscode: typeof Vscode = api ?? require('vscode');
    if (options.token.isCancellationRequested) throw new Error('Cancelled.');
    const preferredId = options.modelId.trim();
    const models = (await vscode.lm.selectChatModels({ vendor: 'copilot' })).filter(isEligibleCopilotModel)
      .sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!models.length) throw new Error('No eligible GitHub Copilot chat model is available. Sign in to GitHub Copilot in VS Code or choose Local only.');
    if (options.token.isCancellationRequested) throw new Error('Cancelled; no request sent.');
    if (preferredId && !models.some(model => model.id === preferredId)) options.report('The preferred model is unavailable or blocked. Choose another eligible Copilot model.');
    const choice = await vscode.window.showQuickPick(models.map(model => ({
      label: model.name, description: model.id, detail: model.id === preferredId ? 'Your configured preference' : undefined, model,
    })), { title: 'POM Agent: choose a Copilot model', placeHolder: 'Choose a model for this run. One request at most; charges depend on your Copilot plan.' }, options.token);
    if (!choice || options.token.isCancellationRequested) throw new Error('Copilot model selection cancelled; no request sent.');
    const selected = choice.model;
    const messages = [vscode.LanguageModelChatMessage.User(instructions), vscode.LanguageModelChatMessage.User(prompt)];
    let tokens = 64;
    for (const message of messages) tokens += await selected.countTokens(message, options.token);
    const budget = Number.isFinite(options.maxInputTokens) && options.maxInputTokens >= 256 ? options.maxInputTokens : 6000;
    const limit = Math.min(budget, selected.maxInputTokens);
    if (tokens > limit) throw new Error(`Copilot input needs about ${tokens} tokens, above the ${limit} token budget. Shorten the steps or recording, or adjust pomAgent.maxInputTokens. No request sent.`);
    if (options.token.isCancellationRequested) throw new Error('Cancelled; no request sent.');
    options.report(`Copilot request 1/1: ${selected.name} (${selected.id}); approximately ${tokens} input tokens.`);
    const cancellation = new vscode.CancellationTokenSource();
    const subscription = options.token.onCancellationRequested(() => cancellation.cancel());
    const timeout = setTimeout(() => cancellation.cancel(), 120_000);
    try {
      if (options.token.isCancellationRequested) throw new Error('Cancelled; no request sent.');
      const response = await selected.sendRequest(messages, { justification: 'Interpret English test steps, group logical screens and choose descriptive POM names. Code and locator chains are generated locally.' }, cancellation.token);
      let result = '';
      for await (const chunk of response.text) {
        if (cancellation.token.isCancellationRequested) throw new Error('Copilot request cancelled or timed out.');
        result += chunk;
        if (result.length > 32000) throw new Error('Copilot naming response exceeded the output limit.');
      }
      if (cancellation.token.isCancellationRequested) throw new Error('Copilot request cancelled or timed out.');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/model_not_supported|model (?:is )?not supported|requested model is not supported/i.test(message)) {
        throw new Error(`GitHub Copilot rejected ${selected.name} (${selected.id}) for extension chat requests. Check Copilot access in VS Code and choose a different available model on your next run. No automatic retry was made.`);
      }
      throw error;
    } finally { clearTimeout(timeout); subscription.dispose(); cancellation.cancel(); cancellation.dispose(); }
  } };
}
