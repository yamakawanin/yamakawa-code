import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export interface Attachment {
  kind: 'image' | 'text';
  /** Display name (basename) */
  name: string;
  /** For images: base64-encoded raw bytes (no data: prefix). For text: utf8 content. */
  data: string;
  /** Image MIME (image/png, image/jpeg, ...) */
  mime?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional attachments — only meaningful on `user` turns. */
  attachments?: Attachment[];
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
  onMeta?: (meta: { model?: string }) => void;
}

export interface ChatCompletionOptions {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatMessage[];
  maxTokens?: number;
}

export function streamChatCompletion(
  opts: ChatCompletionOptions,
  handlers: StreamHandlers
): () => void {
  switch (opts.provider) {
    case 'anthropic': return streamAnthropic(opts, handlers);
    case 'gemini':    return streamGemini(opts, handlers);
    case 'ollama':    return streamOllama(opts, handlers);
    case 'openai':
    default:          return streamOpenAI(opts, handlers);
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------
function streamOpenAI(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/chat/completions');
  const messages = opts.messages.map((m) => {
    if (m.role !== 'user' || !m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content };
    }
    const parts: any[] = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (const a of m.attachments) {
      if (a.kind === 'image') {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${a.mime || 'image/png'};base64,${a.data}` }
        });
      } else {
        parts.push({ type: 'text', text: `\n[Attached file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\`` });
      }
    }
    return { role: m.role, content: parts };
  });
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature: opts.temperature,
    stream: true
  });
  return doRequest(
    endpoint,
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
      'Accept': 'text/event-stream'
    },
    body,
    (raw) => parseSseLines(raw, (data) => {
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const model = typeof json?.model === 'string' ? json.model : undefined;
        if (model) handlers.onMeta?.({ model });
        const delta: string | undefined =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.message?.content;
        if (typeof delta === 'string' && delta.length > 0) handlers.onDelta(delta);
      } catch { /* ignore */ }
    }),
    handlers
  );
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
function streamAnthropic(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/v1/messages');
  const system = opts.messages.find((m) => m.role === 'system')?.content || undefined;
  const messages = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role !== 'user' || !m.attachments || m.attachments.length === 0) {
        return { role: m.role, content: m.content };
      }
      const parts: any[] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const a of m.attachments) {
        if (a.kind === 'image') {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mime || 'image/png', data: a.data }
          });
        } else {
          parts.push({ type: 'text', text: `\n[Attached file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\`` });
        }
      }
      return { role: m.role, content: parts };
    });
  const body = JSON.stringify({
    model: opts.model,
    messages,
    system,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens ?? 4096,
    stream: true
  });
  return doRequest(
    endpoint,
    {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'Accept': 'text/event-stream'
    },
    body,
    (raw) => parseSseLines(raw, (data) => {
      try {
        const json = JSON.parse(data);
        const model = typeof json?.model === 'string' ? json.model : undefined;
        if (model) handlers.onMeta?.({ model });
        if (json?.type === 'content_block_delta' && typeof json?.delta?.text === 'string') {
          handlers.onDelta(json.delta.text);
        }
      } catch { /* ignore */ }
    }),
    handlers
  );
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
function streamGemini(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const endpoint =
    `${base}/v1beta/models/${encodeURIComponent(opts.model)}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;

  const systemMsg = opts.messages.find((m) => m.role === 'system');
  const contents = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.role === 'user' && m.attachments) {
        for (const a of m.attachments) {
          if (a.kind === 'image') {
            parts.push({ inlineData: { mimeType: a.mime || 'image/png', data: a.data } });
          } else {
            parts.push({ text: `\n[Attached file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\`` });
          }
        }
      }
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

  const body = JSON.stringify({
    contents,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
    generationConfig: { temperature: opts.temperature }
  });

  return doRequest(
    endpoint,
    { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body,
    (raw) => parseSseLines(raw, (data) => {
      try {
        const json = JSON.parse(data);
        const model = typeof json?.modelVersion === 'string'
          ? json.modelVersion
          : (typeof json?.model === 'string' ? json.model : undefined);
        if (model) handlers.onMeta?.({ model });
        const parts = json?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === 'string' && p.text.length > 0) handlers.onDelta(p.text);
          }
        }
      } catch { /* ignore */ }
    }),
    handlers
  );
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------
function streamOllama(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/api/chat');
  const messages = opts.messages.map((m) => {
    const base: any = { role: m.role, content: m.content };
    if (m.role === 'user' && m.attachments) {
      const images = m.attachments.filter((a) => a.kind === 'image').map((a) => a.data);
      if (images.length) base.images = images;
      const texts = m.attachments.filter((a) => a.kind === 'text');
      if (texts.length) {
        base.content += '\n\n' + texts.map((a) => `[Attached file: ${a.name}]\n\`\`\`\n${a.data}\n\`\`\``).join('\n\n');
      }
    }
    return base;
  });
  const body = JSON.stringify({
    model: opts.model,
    messages,
    options: { temperature: opts.temperature },
    stream: true
  });
  return doRequest(
    endpoint,
    { 'Content-Type': 'application/json' },
    body,
    (raw) => {
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const json = JSON.parse(t);
          const model = typeof json?.model === 'string' ? json.model : undefined;
          if (model) handlers.onMeta?.({ model });
          const delta: string | undefined = json?.message?.content;
          if (typeof delta === 'string' && delta.length > 0) handlers.onDelta(delta);
        } catch { /* ignore */ }
      }
    },
    handlers,
    '\n'
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
function doRequest(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  onEvent: (raw: string) => void,
  handlers: StreamHandlers,
  chunkSeparator: string = '\n\n'
): () => void {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { handlers.onError(new Error(`Invalid base URL: ${endpoint}`)); return () => {}; }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const req = lib.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    },
    (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        let errBuf = '';
        res.on('data', (c) => (errBuf += c.toString('utf8')));
        res.on('end', () => {
          handlers.onError(new Error(
            `Request failed: ${res.statusCode} ${res.statusMessage}\n${errBuf.slice(0, 1200)}`
          ));
        });
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf(chunkSeparator)) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + chunkSeparator.length);
          onEvent(rawEvent);
        }
      });
      res.on('end', () => {
        if (buffer.trim().length > 0) onEvent(buffer);
        handlers.onDone();
      });
      res.on('error', (err) => handlers.onError(err));
    }
  );
  req.on('error', (err) => handlers.onError(err));
  req.write(body);
  req.end();
  return () => { try { req.destroy(); } catch { /* ignore */ } };
}

function parseSseLines(raw: string, onData: (data: string) => void) {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data) onData(data);
  }
}

function ensurePath(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (b.endsWith(path)) return b;
  return b + (path.startsWith('/') ? path : '/' + path);
}
