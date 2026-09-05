/**
 * Unwrap Codex exec / OpenAI error payloads so the chat UI shows the real
 * rejection instead of CLI stdin noise.
 */

import fs from 'fs';
import path from 'path';

const STDIN_NOISE = /reading prompt from stdin/i;
const FALLBACK_METADATA = /model metadata for .* not found/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function extractEmbeddedJsonObject(text) {
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function readNestedErrorMessage(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (value);
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
 *
 * @param {unknown} text
 * @returns {string}
 */
export function extractCodexApiErrorMessage(text) {
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
 *
 * @param {unknown} text
 * @returns {string}
 */
export function readCodexSessionTurnError(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  let found = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : rec;
    if (payload.type !== 'task_complete') continue;
    const error = payload.error;
    if (!error) continue;
    const message = typeof error === 'object' && error && 'message' in error
      ? extractCodexApiErrorMessage(error.message)
      : extractCodexApiErrorMessage(error);
    if (message) found = message;
  }
  return found;
}

/**
 * @param {string} homeDir
 * @param {string} threadId
 * @returns {string}
 */
export function findCodexSessionLogPath(homeDir, threadId) {
  const id = String(threadId || '').trim();
  const root = path.join(String(homeDir || ''), 'sessions');
  if (!id || !root) return '';
  const needle = `-${id}.jsonl`;
  /** @type {string[]} */
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
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

/**
 * @param {{ execMessage?: string, turnError?: string, homeDir?: string, threadId?: string }} input
 * @returns {string}
 */
export function formatCodexExecFailure(input) {
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
    return 'Codex rejected the request. The selected model may not be available on this ChatGPT account.';
  }
  return execMessage || 'Codex exec failed.';
}
