import * as vscode from 'vscode';
import * as path from 'path';

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Maximum auto tool-call iterations per user turn. */
export const MAX_TOOL_ITERATIONS = 8;

/** Prompt fragment that documents the protocol for the model. */
export const TOOLS_SYSTEM_PROMPT = `
You have access to the user's VS Code workspace through workspace tools.
To call a tool, emit a fenced code block tagged \`yk-tool\` containing JSON, e.g.:

\`\`\`yk-tool
{"name": "read_file", "args": {"path": "src/foo.ts"}}
\`\`\`

You may emit multiple tool calls in one reply. After your reply ends, the user
will reply with a message starting with [tool-result] for each call, then you
continue. Stop calling tools when you have enough information.

Available tools:
- list_dir(path: string)            → list entries (relative to workspace root)
- read_file(path: string)           → return file contents (max ~120KB)
- write_file(path: string, content: string) → create or overwrite (user is asked to approve)
- delete_file(path: string)         → delete file or empty dir (user is asked to approve)
- apply_patch(path: string, search: string, replace: string) → replace exact substring once (user-approved)
- glob(pattern: string)             → list workspace files matching a glob

Path rules: relative to the workspace root. Never use absolute paths or "..".
Always read a file before patching it. Show concise diffs/explanations to the user
outside the tool blocks.
`.trim();

const TOOL_BLOCK_RE = /```yk-tool\s*\n([\s\S]*?)```/g;

/** Extract tool calls from an assistant message. */
export function extractToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let m: RegExpExecArray | null;
  TOOL_BLOCK_RE.lastIndex = 0;
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.name === 'string') {
        calls.push({ name: parsed.name, args: parsed.args || {} });
      }
    } catch {
      // ignore malformed
    }
  }
  return calls;
}

/** Replace tool blocks in the assistant text with compact human-readable summaries. */
export function formatAssistantToolBlocks(text: string, results: ToolResult[]): string {
  let i = 0;
  return text.replace(TOOL_BLOCK_RE, (_, raw) => {
    let name = 'tool';
    try { name = JSON.parse(raw).name || name; } catch { /* */ }
    const r = results[i++];
    const status = r ? (r.ok ? '✓' : '✗') : '…';
    return `\n> **${status} tool**: \`${name}\`\n`;
  });
}

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function resolveSafe(rel: string): vscode.Uri | { error: string } {
  const root = workspaceRoot();
  if (!root) return { error: 'No workspace folder open.' };
  if (typeof rel !== 'string' || rel.length === 0) return { error: 'Missing path.' };
  if (path.isAbsolute(rel) || rel.includes('..')) {
    return { error: `Refusing unsafe path: ${rel}` };
  }
  return vscode.Uri.joinPath(root, rel);
}

async function confirm(message: string, detail?: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    'Allow',
    'Deny'
  );
  return choice === 'Allow';
}

const ALWAYS_ALLOW = new Set<string>();
function rememberKey(action: string, target: string) {
  return `${action}::${target}`;
}

export async function runTool(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case 'list_dir':       return await toolListDir(call.args.path ?? '.');
      case 'read_file':      return await toolReadFile(call.args.path);
      case 'write_file':     return await toolWriteFile(call.args.path, call.args.content ?? '');
      case 'delete_file':    return await toolDeleteFile(call.args.path);
      case 'apply_patch':    return await toolApplyPatch(call.args.path, call.args.search, call.args.replace);
      case 'glob':           return await toolGlob(call.args.pattern ?? '**/*');
      default:               return { ok: false, output: `Unknown tool: ${call.name}` };
    }
  } catch (err: any) {
    return { ok: false, output: `Error: ${err?.message || String(err)}` };
  }
}

async function toolListDir(rel: string): Promise<ToolResult> {
  const uri = resolveSafe(rel === '' ? '.' : rel);
  if ('error' in uri) return { ok: false, output: uri.error };
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const lines = entries
    .map(([n, t]) => `${t === vscode.FileType.Directory ? 'dir ' : 'file'}  ${n}`)
    .sort();
  return { ok: true, output: lines.join('\n') || '(empty)' };
}

async function toolReadFile(rel: string): Promise<ToolResult> {
  const uri = resolveSafe(rel);
  if ('error' in uri) return { ok: false, output: uri.error };
  const data = await vscode.workspace.fs.readFile(uri);
  if (data.byteLength > 120 * 1024) {
    return { ok: false, output: `File too large (${data.byteLength} bytes). Read smaller chunks.` };
  }
  return { ok: true, output: Buffer.from(data).toString('utf8') };
}

async function toolWriteFile(rel: string, content: string): Promise<ToolResult> {
  const uri = resolveSafe(rel);
  if ('error' in uri) return { ok: false, output: uri.error };
  const key = rememberKey('write', rel);
  if (!ALWAYS_ALLOW.has(key)) {
    const ok = await confirm(
      `Allow Yamakawa Code to write to "${rel}"?`,
      `Content length: ${content.length} chars`
    );
    if (!ok) return { ok: false, output: 'User denied write.' };
  }
  // Ensure parent dir
  const parent = vscode.Uri.joinPath(uri, '..');
  try { await vscode.workspace.fs.createDirectory(parent); } catch { /* exists */ }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return { ok: true, output: `Wrote ${content.length} chars to ${rel}.` };
}

async function toolDeleteFile(rel: string): Promise<ToolResult> {
  const uri = resolveSafe(rel);
  if ('error' in uri) return { ok: false, output: uri.error };
  const ok = await confirm(`Allow Yamakawa Code to delete "${rel}"?`);
  if (!ok) return { ok: false, output: 'User denied delete.' };
  await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  return { ok: true, output: `Deleted ${rel} (moved to trash).` };
}

async function toolApplyPatch(rel: string, search: string, replace: string): Promise<ToolResult> {
  if (typeof search !== 'string' || search.length === 0) {
    return { ok: false, output: 'search must be a non-empty string.' };
  }
  const uri = resolveSafe(rel);
  if ('error' in uri) return { ok: false, output: uri.error };
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const first = raw.indexOf(search);
  if (first === -1) return { ok: false, output: 'search string not found.' };
  if (raw.indexOf(search, first + 1) !== -1) {
    return { ok: false, output: 'search string is ambiguous (appears multiple times). Make it more specific.' };
  }
  const ok = await confirm(`Allow Yamakawa Code to patch "${rel}"?`, `Replacing ${search.length} chars with ${String(replace).length} chars.`);
  if (!ok) return { ok: false, output: 'User denied patch.' };
  const updated = raw.slice(0, first) + String(replace ?? '') + raw.slice(first + search.length);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
  return { ok: true, output: `Patched ${rel}.` };
}

async function toolGlob(pattern: string): Promise<ToolResult> {
  const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);
  const root = workspaceRoot();
  if (!root) return { ok: false, output: 'No workspace.' };
  const rels = uris.map((u) => path.relative(root.fsPath, u.fsPath)).sort();
  return { ok: true, output: rels.join('\n') || '(no matches)' };
}
