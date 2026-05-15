import * as vscode from 'vscode';
import { ChatMessage, streamChatCompletion } from './api';

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'yamakawaCode.chatView';

  private view?: vscode.WebviewView;
  private history: StoredMessage[] = [];
  private abortCurrent?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = context.workspaceState.get<StoredMessage[]>('yamakawaCode.history', []);
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };

    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));

    view.onDidDispose(() => {
      this.view = undefined;
    });

    // Replay history once the webview is ready
    view.webview.postMessage({ type: 'hydrate', history: this.history });
  }

  public clearChat(): void {
    this.abortCurrent?.();
    this.abortCurrent = undefined;
    this.history = [];
    this.persist();
    this.view?.webview.postMessage({ type: 'cleared' });
  }

  public focusInput(): void {
    this.view?.show?.(true);
    this.view?.webview.postMessage({ type: 'focusInput' });
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.view?.webview.postMessage({ type: 'hydrate', history: this.history });
        return;
      case 'send':
        await this.handleSend(String(msg.text ?? ''));
        return;
      case 'abort':
        this.abortCurrent?.();
        this.abortCurrent = undefined;
        return;
      case 'clear':
        this.clearChat();
        return;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'yamakawaCode');
        return;
    }
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.view) return;

    const cfg = vscode.workspace.getConfiguration('yamakawaCode');
    const baseUrl = cfg.get<string>('baseUrl', 'https://apic1.ohmycdn.com/v1');
    const model = cfg.get<string>('model', 'gpt-5.2-codex');
    const temperature = cfg.get<number>('temperature', 0.7);
    const systemPrompt = cfg.get<string>('systemPrompt', '');
    const configKey = cfg.get<string>('apiKey', '').trim();

    const apiKey =
      configKey ||
      process.env.OPENAI_API_KEY ||
      process.env.OHMYGPT_API_KEY ||
      '';

    if (!apiKey) {
      this.view.webview.postMessage({
        type: 'error',
        message:
          'No API key found. Set `OPENAI_API_KEY` or `OHMYGPT_API_KEY` in your environment, or configure `yamakawaCode.apiKey` in Settings.'
      });
      return;
    }

    // Append user message to history
    this.history.push({ role: 'user', content: trimmed });
    this.persist();
    this.view.webview.postMessage({ type: 'userMessage', content: trimmed });
    this.view.webview.postMessage({ type: 'assistantStart' });

    // Build full message list
    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const m of this.history) messages.push({ role: m.role, content: m.content });

    let assembled = '';

    this.abortCurrent = streamChatCompletion(
      { baseUrl, apiKey, model, temperature, messages },
      {
        onDelta: (delta) => {
          assembled += delta;
          this.view?.webview.postMessage({ type: 'assistantDelta', delta });
        },
        onDone: () => {
          if (assembled) {
            this.history.push({ role: 'assistant', content: assembled });
            this.persist();
          }
          this.view?.webview.postMessage({ type: 'assistantDone' });
          this.abortCurrent = undefined;
        },
        onError: (err) => {
          this.view?.webview.postMessage({
            type: 'error',
            message: err.message || String(err)
          });
          this.view?.webview.postMessage({ type: 'assistantDone' });
          this.abortCurrent = undefined;
        }
      }
    );
  }

  private persist(): void {
    this.context.workspaceState.update('yamakawaCode.history', this.history);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Yamakawa Code</title>
</head>
<body>
  <div class="app">
    <div id="messages" class="messages" role="log" aria-live="polite">
      <div class="empty-state" id="emptyState">
        <div class="empty-logo">⌘</div>
        <h2>Yamakawa Code</h2>
        <p>Ask anything. Built for code, powered by an OpenAI-compatible model.</p>
      </div>
    </div>

    <form id="composer" class="composer" autocomplete="off">
      <div class="composer-inner">
        <textarea
          id="input"
          rows="1"
          placeholder="Ask Yamakawa Code…"
          spellcheck="false"
        ></textarea>
        <div class="composer-actions">
          <span class="hint">⏎ send · ⇧⏎ newline</span>
          <button type="button" id="stopBtn" class="icon-btn stop-btn" title="Stop" hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
          <button type="submit" id="sendBtn" class="send-btn" title="Send">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
