import * as vscode from 'vscode';
import { ChatWebviewProvider } from './ChatWebviewProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatWebviewProvider(context);

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
