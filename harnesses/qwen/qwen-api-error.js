/**
 * Qwen CLI writes API failures as `ui_telemetry` (often only in session jsonl).
 * Weekly token-plan quota is a 429 that the CLI retries instead of ending `query()`.
 */

import fs from 'fs';
import path from 'path';
import { resolveQwenHomeDir } from './qwen-cli.js';

export const QWEN_API_ERROR_WATCH_MS = 1000;

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} cwd
 * @returns {string}
 */
export function sanitizeQwenProjectId(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @param {unknown} cwd
 * @param {unknown} sessionId
 * @returns {string}
 */
export function resolveQwenSessionJsonlPath(cwd, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  return path.join(
    resolveQwenHomeDir(),
    '.qwen',
    'projects',
    sanitizeQwenProjectId(cwd),
    'chats',
    `${id}.jsonl`,
  );
}

/**
 * @param {unknown} event
 * @returns {{
 *   message: string,
 *   errorType: string,
 *   statusCode: number | null,
 *   eventName: string,
 * } | null}
 */
export function readQwenUiTelemetryApiError(event) {
  const rec = asRecord(event);
  if (!rec) return null;
  const name = typeof rec['event.name'] === 'string'
    ? rec['event.name'].trim()
    : (typeof rec.eventName === 'string' ? rec.eventName.trim() : '');
  if (name && name !== 'qwen-code.api_error' && name !== 'api_error') return null;
  const message = typeof rec.error_message === 'string'
    ? rec.error_message.trim()
    : (typeof rec.errorMessage === 'string' ? rec.errorMessage.trim() : '');
  if (!message && name !== 'qwen-code.api_error' && name !== 'api_error') return null;
  if (!message && !name) return null;
  const errorType = typeof rec.error_type === 'string'
    ? rec.error_type.trim()
    : (typeof rec.errorType === 'string' ? rec.errorType.trim() : '');
  const statusRaw = rec.status_code ?? rec.statusCode;
  const statusCode = Number.isFinite(Number(statusRaw)) ? Number(statusRaw) : null;
  if (!message && !errorType && statusCode == null) return null;
  if (!name && !/quota|rate limit|429|unauthorized|api key/i.test(message)) return null;
  return {
    message,
    errorType,
    statusCode,
    eventName: name || 'qwen-code.api_error',
  };
}

/**
 * @param {unknown} message
 * @returns {{
 *   message: string,
 *   errorType: string,
 *   statusCode: number | null,
 *   eventName: string,
 * } | null}
 */
export function readQwenApiErrorFromMessage(message) {
  const rec = asRecord(message);
  if (!rec) return null;
  const type = typeof rec.type === 'string' ? rec.type : '';
  const subtype = typeof rec.subtype === 'string' ? rec.subtype.trim() : '';
  const payload = asRecord(rec.systemPayload) || asRecord(rec.data) || rec;
  const uiEvent = asRecord(payload?.uiEvent) || payload;
  if (type === 'system' && (subtype === 'ui_telemetry' || subtype === '')) {
    const fromTelemetry = readQwenUiTelemetryApiError(uiEvent);
    if (fromTelemetry) return fromTelemetry;
  }
  if (type === 'result') {
    const errRec = asRecord(rec.error);
    const resultMessage = errRec && typeof errRec.message === 'string'
      ? errRec.message.trim()
      : (typeof rec.error === 'string' ? rec.error.trim() : '');
    if (resultMessage && (rec.is_error === true || subtype.startsWith('error'))) {
      return {
        message: resultMessage,
        errorType: errRec && typeof errRec.type === 'string' ? errRec.type : subtype,
        statusCode: null,
        eventName: 'result',
      };
    }
  }
  return readQwenUiTelemetryApiError(uiEvent);
}

/**
 * @param {{ message?: string, errorType?: string, statusCode?: number | null }} error
 * @returns {boolean}
 */
export function isFatalQwenApiError(error) {
  const text = String(error?.message || '').toLowerCase();
  const type = String(error?.errorType || '').toLowerCase();
  const status = Number(error?.statusCode);
  if (status === 401 || status === 403) return true;
  if (type.includes('auth')) return true;
  if (text.includes('quota has been exhausted')) return true;
  if (text.includes('quota will reset')) return true;
  if (text.includes('insufficient_quota')) return true;
  if (text.includes('free allocated quota')) return true;
  if (text.includes('token-plan') && text.includes('quota')) return true;
  if (text.includes('model not exist')) return true;
  if (text.includes('model_not_found')) return true;
  if (status === 404) return true;
  return false;
}

/**
 * @param {{ message?: string, errorType?: string, statusCode?: number | null }} error
 * @returns {string}
 */
export function resolveQwenApiErrorCode(error) {
  const text = String(error?.message || '').toLowerCase();
  const type = String(error?.errorType || '').toLowerCase();
  const status = Number(error?.statusCode);
  if (isFatalQwenApiError(error) && (text.includes('quota') || type.includes('ratelimit'))) {
    return 'qwen_quota';
  }
  if (status === 429 || type.includes('ratelimit') || text.includes('rate limit')) {
    return 'qwen_rate_limit';
  }
  if (status === 401 || status === 403 || type.includes('auth')) return 'qwen_auth';
  return 'qwen_error';
}

/**
 * @param {{ message?: string, errorType?: string, statusCode?: number | null }} error
 * @returns {string}
 */
export function formatQwenApiErrorMessage(error) {
  const message = String(error?.message || '').trim();
  if (message) return message;
  const type = String(error?.errorType || '').trim();
  const status = Number(error?.statusCode);
  if (status && type) return `${status} ${type}`;
  if (type) return type;
  return 'Qwen API error';
}

/**
 * @param {string} filePath
 * @param {{ offset?: number }} state
 * @returns {Array<{ message: string, errorType: string, statusCode: number | null, eventName: string }>}
 */
export function readNewQwenApiErrorsFromJsonl(filePath, state) {
  if (!filePath) return [];
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!st.isFile()) return [];
  const start = Math.max(0, Number(state?.offset) || 0);
  if (st.size <= start) {
    if (state) state.offset = st.size;
    return [];
  }
  const length = st.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  if (state) state.offset = st.size;
  const chunk = buffer.toString('utf8');
  const lines = chunk.split('\n');
  /** @type {Array<{ message: string, errorType: string, statusCode: number | null, eventName: string }>} */
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const error = readQwenApiErrorFromMessage(parsed);
    if (error) out.push(error);
  }
  return out;
}

/**
 * @param {string} filePath
 * @returns {number}
 */
export function readQwenJsonlSize(filePath) {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Qwen Cloud can surface a quota/auth failure as assistant prose — the CLI
 * formats the provider error as its answer instead of emitting `api_error`
 * telemetry or `result.errors`. That prose is often the only place the
 * provider's reset clock exists, so a failed run must treat it as error text.
 * A normal answer never qualifies.
 *
 * @param {unknown} text
 * @returns {string} the prose when it looks like a provider failure, else ''
 */
export function readQwenProviderErrorProse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const probe = { message: trimmed, errorType: 'result', statusCode: null };
  if (isFatalQwenApiError(probe) || resolveQwenApiErrorCode(probe) !== 'qwen_error') return trimmed;
  return '';
}

/**
 * Every error variant of a failed run, de-duplicated: the fatal API error, the
 * normalized result error, the raw result text, and the provider prose a quota
 * failure leaves in an assistant answer. `sdkRunFinished.lastErrorMessages`
 * forwards these to the shared usage-limit parser, which locks the harness
 * until the reset window the provider actually stated instead of the fallback
 * TTL a clock-less text would get.
 *
 * @param {{ fatalErrorMessage?: unknown, resultErrorMessage?: unknown, resultText?: unknown, assistantText?: unknown }} [input]
 * @returns {string[]}
 */
export function collectQwenRunErrorMessages(input = {}) {
  const list = [];
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text && !list.includes(text)) list.push(text);
  };
  push(input.fatalErrorMessage);
  push(input.resultErrorMessage);
  push(input.resultText);
  push(readQwenProviderErrorProse(input.assistantText));
  return list;
}
