import * as vscode from 'vscode';
import { ChatWebviewProvider } from './ChatWebviewProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatWebviewProvider(context);

  // Keep yamakawaCode.baseUrl visible in Settings by materializing defaults.
  // If the value is empty, fill with current provider default.
  // If provider changes and baseUrl is still one of known defaults, switch it.
  void syncBaseUrlSetting(false);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yamakawaCode.baseUrl') || e.affectsConfiguration('yamakawaCode.provider')) {
        void syncBaseUrlSetting(e.affectsConfiguration('yamakawaCode.provider'));
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatWebviewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('yamakawaCode.clearChat', () => {
      provider.clearChat();
    }),
    vscode.commands.registerCommand('yamakawaCode.focusInput', () => {
      provider.focusInput();
    })
  );
}

export function deactivate() {}

async function syncBaseUrlSetting(providerChanged: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('yamakawaCode');
  const provider = cfg.get<string>('provider', 'openai');
  const current = (cfg.get<string>('baseUrl', '') || '').trim();
  const next = defaultBaseUrl(provider);

  if (!current) {
    await cfg.update('baseUrl', next, vscode.ConfigurationTarget.Global);
    return;
  }

  if (providerChanged && isKnownDefaultBaseUrl(current) && current !== next) {
    await cfg.update('baseUrl', next, vscode.ConfigurationTarget.Global);
  }
}

function isKnownDefaultBaseUrl(url: string): boolean {
  const s = url.trim();
  return s === defaultBaseUrl('openai')
    || s === defaultBaseUrl('anthropic')
    || s === defaultBaseUrl('gemini')
    || s === defaultBaseUrl('ollama');
}

function defaultBaseUrl(provider: string): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    case 'ollama':
      return 'http://localhost:11434';
    case 'openai':
    default:
      return 'https://apic1.ohmycdn.com/v1';
  }
}
