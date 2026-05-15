import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

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
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint via SSE.
 * Returns a function that can be called to abort the request.
 */
export function streamChatCompletion(
  opts: ChatCompletionOptions,
  handlers: StreamHandlers
): () => void {
  const endpoint = joinUrl(opts.baseUrl, '/chat/completions');
  const url = new URL(endpoint);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    stream: true
  });

  const req = lib.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(body)
      }
    },
    (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        let errBuf = '';
        res.on('data', (c) => (errBuf += c.toString('utf8')));
        res.on('end', () => {
          handlers.onError(
            new Error(
              `Request failed: ${res.statusCode} ${res.statusMessage}\n${errBuf.slice(0, 800)}`
            )
          );
        });
        return;
      }

      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        // SSE messages are split by double newline
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleEvent(rawEvent, handlers);
        }
      });
      res.on('end', () => {
        if (buffer.trim().length > 0) {
          handleEvent(buffer, handlers);
        }
        handlers.onDone();
      });
      res.on('error', (err) => handlers.onError(err));
    }
  );

  req.on('error', (err) => handlers.onError(err));
  req.write(body);
  req.end();

  return () => {
    try {
      req.destroy();
    } catch {
      /* ignore */
    }
  };
}

function handleEvent(raw: string, handlers: StreamHandlers) {
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      // 'done' will be emitted on stream end
      return;
    }
    try {
      const json = JSON.parse(data);
      const delta: string | undefined =
        json?.choices?.[0]?.delta?.content ??
        json?.choices?.[0]?.message?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        handlers.onDelta(delta);
      }
    } catch {
      // ignore malformed chunks
    }
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  // If base already ends in /chat/completions, do not append again
  if (b.endsWith('/chat/completions')) return b;
  return b + p;
}
