import * as vscode from 'vscode';
import * as fs from 'fs';
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

    // Push theme + model info on config changes
    const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yamakawaCode')) {
        this.view?.webview.postMessage({
          type: 'themeUpdate',
          theme: this.readThemeConfig(),
          status: this.readStatusConfig()
        });
      }
    });

    view.onDidDispose(() => {
      cfgListener.dispose();
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
    const model = cfg.get<string>('model', 'gpt-4.1');
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
    const logoUri = this.resolveLogoUri(webview);

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    const theme = this.readThemeConfig();
    const status = this.readStatusConfig();
    const themeStyle = this.themeCss(theme);

    const logoMarkup = logoUri
      ? `<img class="hero-logo hero-logo-img" src="${logoUri}" alt="Yamakawa Code" />`
      : `<div class="hero-star" aria-hidden="true">✻</div>`;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <style id="theme-vars">${themeStyle}</style>
  <title>Yamakawa Code</title>
</head>
<body data-logo="${logoUri ?? ''}">
  <div class="app">
    <div id="messages" class="messages" role="log" aria-live="polite">
      <div class="hero" id="hero">
        <div class="hero-banner">
          ${logoMarkup}
          <div class="hero-text">
            <div class="hero-title">Welcome to <span class="brand">Yamakawa Code</span></div>
            <div class="hero-sub">/help for help, /clear to reset · ${escapeAttr(status.model)}</div>
          </div>
        </div>
        <ul class="tips">
          <li><span class="tip-key">Enter</span><span>send message</span></li>
          <li><span class="tip-key">Shift+Enter</span><span>new line</span></li>
          <li><span class="tip-key">/clear</span><span>clear the conversation</span></li>
          <li><span class="tip-key">/settings</span><span>open extension settings</span></li>
        </ul>
        <div class="hero-cwd">cwd: <span id="cwd">${escapeAttr(status.cwd)}</span></div>
      </div>
    </div>

    <form id="composer" class="composer" autocomplete="off">
      <div class="composer-inner">
        <span class="prompt-mark" aria-hidden="true">&gt;</span>
        <textarea
          id="input"
          rows="1"
          placeholder="Try “explain this file” or “refactor selection”"
          spellcheck="false"
        ></textarea>
        <button type="button" id="stopBtn" class="icon-btn stop-btn" title="Stop" hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
        <button type="button" id="settingsBtn" class="icon-btn" title="Open settings" aria-label="Open settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button type="submit" id="sendBtn" class="send-btn" title="Send">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
        </button>
      </div>
      <div class="statusbar" id="statusbar">
        <span class="status-left">
          <span class="dot"></span>
          <span id="statusModel">${escapeAttr(status.model)}</span>
        </span>
        <span class="status-right">
          <span id="statusInfo">ready</span>
        </span>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  /** Picks the first existing icon file in media/, preferring raster for the chat hero. */
  private resolveLogoUri(webview: vscode.Webview): string | undefined {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const candidates = ['icon.png', 'icon.jpg', 'icon.jpeg', 'icon.svg'];
    for (const name of candidates) {
      const fsPath = vscode.Uri.joinPath(mediaRoot, name).fsPath;
      if (fs.existsSync(fsPath)) {
        return webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name)).toString();
      }
    }
    return undefined;
  }

  private readThemeConfig() {
    const cfg = vscode.workspace.getConfiguration('yamakawaCode.theme');
    return {
      accent: cfg.get<string>('accent', '#c96442'),
      background: cfg.get<string>('background', ''),
      foreground: cfg.get<string>('foreground', ''),
      muted: cfg.get<string>('muted', ''),
      border: cfg.get<string>('border', ''),
      fontFamily: cfg.get<string>('fontFamily', '')
    };
  }

  private readStatusConfig() {
    const cfg = vscode.workspace.getConfiguration('yamakawaCode');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '~';
    return {
      model: cfg.get<string>('model', 'gpt-4.1'),
      cwd: folder
    };
  }

  private themeCss(theme: ReturnType<typeof this.readThemeConfig>): string {
    const lines: string[] = [':root {'];
    if (theme.accent) lines.push(`--yk-accent: ${theme.accent};`);
    if (theme.background) lines.push(`--yk-bg: ${theme.background};`);
    if (theme.foreground) lines.push(`--yk-fg: ${theme.foreground};`);
    if (theme.muted) lines.push(`--yk-muted: ${theme.muted};`);
    if (theme.border) lines.push(`--yk-border: ${theme.border};`);
    if (theme.fontFamily) lines.push(`--yk-font: ${theme.fontFamily};`);
    lines.push('}');
    return lines.join('\n');
  }
}

function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
