import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface ChatCompletionOptions {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatMessage[];
  /** Optional max tokens — required by Anthropic, optional elsewhere. */
  maxTokens?: number;
}

/**
 * Stream a chat completion from the configured provider.
 * Returns a function that can be called to abort the request.
 */
export function streamChatCompletion(
  opts: ChatCompletionOptions,
  handlers: StreamHandlers
): () => void {
  switch (opts.provider) {
    case 'anthropic':
      return streamAnthropic(opts, handlers);
    case 'gemini':
      return streamGemini(opts, handlers);
    case 'ollama':
      return streamOllama(opts, handlers);
    case 'openai':
    default:
      return streamOpenAI(opts, handlers);
  }
}

// ---------------------------------------------------------------------------
// OpenAI (and any OpenAI-compatible: OhMyGPT, DeepSeek, Moonshot, Groq,
// OpenRouter, xAI, Together, Azure OpenAI w/ proper baseUrl, etc.)
// ---------------------------------------------------------------------------
function streamOpenAI(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/chat/completions');
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
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
// Anthropic Messages API — separate system field, x-api-key auth, SSE.
// ---------------------------------------------------------------------------
function streamAnthropic(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/v1/messages');
  const system = opts.messages.find((m) => m.role === 'system')?.content || undefined;
  const messages = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
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
        if (json?.type === 'content_block_delta' && typeof json?.delta?.text === 'string') {
          handlers.onDelta(json.delta.text);
        }
      } catch { /* ignore */ }
    }),
    handlers
  );
}

// ---------------------------------------------------------------------------
// Google Gemini — streamGenerateContent w/ SSE.
// baseUrl default: https://generativelanguage.googleapis.com
// ---------------------------------------------------------------------------
function streamGemini(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const endpoint =
    `${base}/v1beta/models/${encodeURIComponent(opts.model)}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;

  const systemMsg = opts.messages.find((m) => m.role === 'system');
  const contents = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

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
// Ollama (local) — /api/chat returns newline-delimited JSON (not SSE).
// baseUrl default: http://localhost:11434
// ---------------------------------------------------------------------------
function streamOllama(opts: ChatCompletionOptions, handlers: StreamHandlers): () => void {
  const endpoint = ensurePath(opts.baseUrl, '/api/chat');
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    options: { temperature: opts.temperature },
    stream: true
  });
  return doRequest(
    endpoint,
    { 'Content-Type': 'application/json' },
    body,
    (raw) => {
      // NDJSON: one JSON object per line
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const json = JSON.parse(t);
          const delta: string | undefined = json?.message?.content;
          if (typeof delta === 'string' && delta.length > 0) handlers.onDelta(delta);
        } catch { /* ignore */ }
      }
    },
    handlers,
    /* chunkSeparator */ '\n'
  );
}

// ---------------------------------------------------------------------------
// Shared HTTP plumbing
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
  try {
    url = new URL(endpoint);
  } catch (err) {
    handlers.onError(new Error(`Invalid base URL: ${endpoint}`));
    return () => {};
  }
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

  return () => {
    try { req.destroy(); } catch { /* ignore */ }
  };
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
