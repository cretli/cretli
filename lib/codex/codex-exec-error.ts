/**
 * Unwrap Codex exec / OpenAI error payloads so the chat UI shows the real
 * rejection instead of CLI stdin noise.
 */

import fs from 'fs';
import path from 'path';

const STDIN_NOISE = /reading prompt from stdin/i;
const FALLBACK_METADATA = /model metadata for .* not found/i;

function tryParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractEmbeddedJsonObject(text: string): string {
  const start = text.indexOf('{"');
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function readNestedErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return '';
  const rec = (value as Record<string, unknown>);
  const nested = rec.error;
  if (nested && typeof nested === 'object') {
    const inner = readNestedErrorMessage(nested);
    if (inner) return inner;
  }
  if (typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
  return '';
}

/**
 * Peel OpenAI / Codex JSON wrappers until a human-readable message remains.
 */
export function extractCodexApiErrorMessage(text: unknown): string {
  let current = typeof text === 'string' ? text.trim() : '';
  if (!current && text && typeof text === 'object') {
    current = readNestedErrorMessage(text);
  }
  if (!current) return '';
  for (let i = 0; i < 5; i += 1) {
    const parsed = tryParseJson(current);
    if (parsed && typeof parsed === 'object') {
      const nested = readNestedErrorMessage(parsed);
      if (nested && nested !== current) {
        current = nested;
        continue;
      }
      break;
    }
    const embedded = extractEmbeddedJsonObject(current);
    if (!embedded || embedded === current) break;
    current = embedded;
  }
  return current.trim();
}

/**
 * Last `task_complete` error in a Codex session jsonl log.
 */
export function readCodexSessionTurnError(text: unknown): string {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  let found = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const record = rec as { payload?: unknown };
    const payload = (record.payload && typeof record.payload === 'object' ? record.payload : rec) as { type?: unknown; error?: unknown };
    if (payload.type !== 'task_complete') continue;
    const error = payload.error;
    if (!error) continue;
    const message = typeof error === 'object' && error && 'message' in error
      ? extractCodexApiErrorMessage((error as { message?: unknown }).message)
      : extractCodexApiErrorMessage(error);
    if (message) found = message;
  }
  return found;
}

export function findCodexSessionLogPath(homeDir: string, threadId: string): string {
  const id = String(threadId || '').trim();
  const root = path.join(String(homeDir || ''), 'sessions');
  if (!id || !root) return '';
  const needle = `-${id}.jsonl`;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(needle)) return full;
    }
  }
  return '';
}

export function formatCodexExecFailure(input: { execMessage?: string, turnError?: string, homeDir?: string, threadId?: string }): string {
  const execMessage = String(input?.execMessage || '').trim();
  const turnError = extractCodexApiErrorMessage(input?.turnError || '');
  let sessionError = '';
  const logPath = findCodexSessionLogPath(input?.homeDir || '', input?.threadId || '');
  if (logPath) {
    try {
      sessionError = readCodexSessionTurnError(fs.readFileSync(logPath, 'utf8'));
    } catch {
      sessionError = '';
    }
  }
  const candidates = [sessionError, turnError, extractCodexApiErrorMessage(execMessage)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (STDIN_NOISE.test(candidate)) continue;
    if (FALLBACK_METADATA.test(candidate)) continue;
    return candidate;
  }
  if (STDIN_NOISE.test(execMessage)) {
    // The CLI only echoed its stdin banner, so the real cause is unknown (most
    // often the process was killed, e.g. by a server restart). Do not guess a
    // provider rejection: that wording would lock a working model for 24 h.
    const exit = describeCodexExit(execMessage);
    return `Codex exited before reporting a cause${exit ? ` (${exit})` : ''}; the process was likely killed or crashed.`;
  }
  return execMessage || 'Codex exec failed.';
}

/**
 * Exit code or signal from a `Codex Exec exited with ...` message.
 */
function describeCodexExit(execMessage: string): string {
  const signal = /\bsignal\s+([A-Z0-9]+)/i.exec(execMessage);
  if (signal) return `signal ${signal[1]}`;
  const code = /exited with code\s+(-?\d+|null)/i.exec(execMessage);
  return code ? `exit code ${code[1]}` : '';
}

/**
 * Message for a Codex run that ended because the Cretli server is stopping.
 * Deliberately free of quota or model wording so no lockout is recorded.
 */
export const CODEX_SERVER_SHUTDOWN_MESSAGE = 'Codex run interrupted: the Cretli server is shutting down.';
