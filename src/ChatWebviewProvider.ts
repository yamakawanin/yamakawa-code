import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Attachment, ChatMessage, Provider, streamChatCompletion } from './api';
import {
  extractToolCalls,
  formatAssistantToolBlocks,
  MAX_TOOL_ITERATIONS,
  runTool,
  TOOLS_SYSTEM_PROMPT,
  ToolResult
} from './tools';

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
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
        await this.handleSend(String(msg.text ?? ''), Array.isArray(msg.attachments) ? msg.attachments : []);
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
      case 'pickAttachment':
        await this.pickAttachments();
        return;
    }
  }

  private async pickAttachments(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Attach to Yamakawa Code',
      filters: {
        'All supported': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'html', 'yaml', 'yml', 'toml'],
        'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp'],
        'All files': ['*']
      }
    });
    if (!picked || picked.length === 0) return;
    const attachments: Attachment[] = [];
    for (const uri of picked) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 8 * 1024 * 1024) {
          vscode.window.showWarningMessage(`Skipping ${path.basename(uri.fsPath)}: larger than 8MB.`);
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const name = path.basename(uri.fsPath);
        const ext = path.extname(name).slice(1).toLowerCase();
        const imageExts: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
        if (imageExts[ext]) {
          attachments.push({ kind: 'image', name, mime: imageExts[ext], data: Buffer.from(bytes).toString('base64') });
        } else {
          if (bytes.byteLength > 200 * 1024) {
            vscode.window.showWarningMessage(`Skipping ${name}: text file too large (${bytes.byteLength} bytes).`);
            continue;
          }
          attachments.push({ kind: 'text', name, data: Buffer.from(bytes).toString('utf8') });
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to read ${uri.fsPath}: ${err?.message || err}`);
      }
    }
    if (attachments.length) {
      this.view?.webview.postMessage({
        type: 'attachmentsPicked',
        attachments: attachments.map((a) => ({
          kind: a.kind,
          name: a.name,
          mime: a.mime,
          // For preview only; full payload kept in webview state
          data: a.data,
          size: a.kind === 'image' ? Math.floor(a.data.length * 3 / 4) : a.data.length
        }))
      });
    }
  }

  private async handleSend(text: string, attachments: Attachment[] = []): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (!this.view) return;

    const cfg = vscode.workspace.getConfiguration('yamakawaCode');
    const provider = (cfg.get<string>('provider', 'openai') as Provider) || 'openai';
    const baseUrl = (cfg.get<string>('baseUrl', '') || '').trim() || defaultBaseUrl(provider);
    const model = cfg.get<string>('model', 'gpt-4.1');
    const temperature = cfg.get<number>('temperature', 0.7);
    const userSystemPrompt = cfg.get<string>('systemPrompt', '');
    const workspaceTools = cfg.get<boolean>('workspaceTools', true);
    const configKey = cfg.get<string>('apiKey', '').trim();

    const apiKey = configKey || resolveEnvKey(provider);

    if (!apiKey && provider !== 'ollama') {
      this.view.webview.postMessage({ type: 'error', message: missingKeyMessage(provider) });
      return;
    }

    const systemPrompt = workspaceTools
      ? `${userSystemPrompt}\n\n${TOOLS_SYSTEM_PROMPT}`.trim()
      : userSystemPrompt;

    // Append user turn to history
    this.history.push({ role: 'user', content: trimmed, attachments: attachments.length ? attachments : undefined });
    this.persist();
    this.view.webview.postMessage({
      type: 'userMessage',
      content: trimmed,
      attachments: attachments.map((a) => ({ kind: a.kind, name: a.name, mime: a.mime }))
    });

    // Tool-use loop: assistant -> [maybe tools] -> assistant -> ...
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      this.view.webview.postMessage({ type: 'assistantStart' });

      const messages: ChatMessage[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      for (const m of this.history) {
        messages.push({
          role: m.role,
          content: m.content,
          attachments: m.attachments
        });
      }

      const assembled = await this.runStream({ provider, baseUrl, apiKey, model, temperature, messages });
      if (assembled === null) return; // aborted or errored

      // Parse tool calls
      const toolCalls = workspaceTools ? extractToolCalls(assembled) : [];
      if (toolCalls.length === 0) {
        this.history.push({ role: 'assistant', content: assembled });
        this.persist();
        this.view.webview.postMessage({ type: 'assistantDone' });
        return;
      }

      // Execute each tool, collect results
      const results: ToolResult[] = [];
      for (const call of toolCalls) {
        const r = await runTool(call);
        results.push(r);
      }

      // Store assistant turn with tool blocks rewritten to compact summaries (for history compactness)
      const compactAssistant = formatAssistantToolBlocks(assembled, results);
      this.history.push({ role: 'assistant', content: assembled });
      this.persist();
      this.view.webview.postMessage({ type: 'assistantDone' });

      // Build tool-result user message
      const resultBlocks = toolCalls.map((c, i) => {
        const r = results[i];
        return `[tool-result] ${c.name}\n${r.ok ? '' : '(error) '}${r.output}`;
      }).join('\n\n---\n\n');

      this.history.push({ role: 'user', content: resultBlocks });
      this.persist();
      this.view.webview.postMessage({
        type: 'toolResult',
        summary: toolCalls.map((c, i) => ({ name: c.name, ok: results[i].ok, snippet: results[i].output.slice(0, 200) }))
      });

      void compactAssistant;
    }

    this.view.webview.postMessage({
      type: 'error',
      message: `Stopped after ${MAX_TOOL_ITERATIONS} tool iterations.`
    });
  }

  /** Run one streaming turn. Returns the full assembled text, or null on abort/error. */
  private async runStream(opts: {
    provider: Provider;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    messages: ChatMessage[];
  }): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let assembled = '';
      this.abortCurrent = streamChatCompletion(
        { provider: opts.provider, baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.model, temperature: opts.temperature, messages: opts.messages },
        {
          onDelta: (delta) => {
            assembled += delta;
            this.view?.webview.postMessage({ type: 'assistantDelta', delta });
          },
          onDone: () => {
            this.abortCurrent = undefined;
            resolve(assembled);
          },
          onError: (err) => {
            this.view?.webview.postMessage({ type: 'error', message: err.message || String(err) });
            this.view?.webview.postMessage({ type: 'assistantDone' });
            this.abortCurrent = undefined;
            resolve(null);
          }
        }
      );
    });
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
      <div class="composer-card">
        <div id="attachments" class="attachments" hidden></div>
        <textarea
          id="input"
          rows="1"
          placeholder="How can I help you today?"
          spellcheck="false"
        ></textarea>
        <div class="composer-toolbar">
          <div class="composer-toolbar-left">
            <button type="button" id="attachBtn" class="icon-btn" title="Attach files or images" aria-label="Attach files">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <span class="model-pill" id="statusModel" title="Current model">${escapeAttr(status.model)}</span>
          </div>
          <div class="composer-toolbar-right">
            <span class="statusbar" id="statusbar" aria-hidden="true">
              <span class="dot"></span>
              <span id="statusInfo">ready</span>
            </span>
            <button type="button" id="settingsBtn" class="icon-btn" title="Open settings" aria-label="Open settings">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <button type="button" id="stopBtn" class="send-btn stop-btn" title="Stop" hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
            </button>
            <button type="submit" id="sendBtn" class="send-btn" title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
            </button>
          </div>
        </div>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  /** Picks the first existing icon file in media/, preferring jpg for brand consistency. */
  private resolveLogoUri(webview: vscode.Webview): string | undefined {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const candidates = ['icon.jpg', 'icon.jpeg', 'icon.png', 'icon.svg'];
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
      fontFamily: cfg.get<string>('fontFamily', ''),
      fontSerif: cfg.get<string>('fontSerif', ''),
      fontMono: cfg.get<string>('fontMono', '')
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
    if (theme.fontFamily) lines.push(`--yk-font-ui: ${theme.fontFamily};`);
    if (theme.fontSerif) lines.push(`--yk-font-serif: ${theme.fontSerif};`);
    if (theme.fontMono) lines.push(`--yk-font-mono: ${theme.fontMono};`);
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

function defaultBaseUrl(provider: Provider): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com';
    case 'gemini':    return 'https://generativelanguage.googleapis.com';
    case 'ollama':    return 'http://localhost:11434';
    case 'openai':
    default:          return 'https://apic1.ohmycdn.com/v1';
  }
}

function resolveEnvKey(provider: Provider): string {
  const env = process.env;
  switch (provider) {
    case 'anthropic':
      return (env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || '').trim();
    case 'gemini':
      return (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim();
    case 'ollama':
      return '';
    case 'openai':
    default:
      return (env.OPENAI_API_KEY || env.OHMYGPT_API_KEY || '').trim();
  }
}

function missingKeyMessage(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'No Anthropic API key. Set `ANTHROPIC_API_KEY` env var or configure `yamakawaCode.apiKey` in Settings.';
    case 'gemini':
      return 'No Gemini API key. Set `GEMINI_API_KEY` env var or configure `yamakawaCode.apiKey` in Settings.';
    case 'openai':
    default:
      return 'No API key. Set `OPENAI_API_KEY` / `OHMYGPT_API_KEY` env var or configure `yamakawaCode.apiKey` in Settings.';
  }
}
