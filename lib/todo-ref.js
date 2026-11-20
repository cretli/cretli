/**
 * Compact pointer to a saved Cretli todo item.
 * Agents load it with MCP todo_show({ todo_id }) and continue the task.
 *
 * Kept separate from lib/chat-message-ref.js: the `chat=… seq=…` contract has
 * existing clients and must not change.
 */

import { CHAT_MESSAGE_REF_PREFIX } from './chat-message-ref.js';

/** Full uuid or an id prefix of at least 8 hex characters. */
const TODO_REF_ID_RE = /^[0-9a-f]{8,}(?:-[0-9a-f]{1,12})*$/i;
const TODO_REF_LINE_RE = new RegExp(
  `^${CHAT_MESSAGE_REF_PREFIX}\\s+todo=([0-9a-f]{8,}(?:-[0-9a-f]{1,12})*)\\s*$`,
  'i',
);

/**
 * Memo of string -> normalized id. Todo review sync normalizes the same few
 * thousand ids over and over inside nested loops, so the trim/lowercase/regex
 * work is paid once per distinct input. Bounded; cleared wholesale when full.
 */
const NORMALIZE_CACHE_MAX = 8192;
const normalizeCache = new Map();

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTodoRefId(value) {
  if (!value) return '';
  const isString = typeof value === 'string';
  if (isString) {
    const hit = normalizeCache.get(value);
    if (hit !== undefined) return hit;
  }
  const raw = String(value).trim().toLowerCase();
  const result = TODO_REF_ID_RE.test(raw) ? raw : '';
  if (isString) {
    // Very long inputs are not worth retaining as cache keys.
    if (value.length <= 128) {
      if (normalizeCache.size >= NORMALIZE_CACHE_MAX) normalizeCache.clear();
      normalizeCache.set(value, result);
    }
  }
  return result;
}

/**
 * @param {unknown} id
 * @returns {string}
 */
export function formatTodoRef(id) {
  const todoId = normalizeTodoRefId(id);
  if (!todoId) return '';
  return `${CHAT_MESSAGE_REF_PREFIX} todo=${todoId}`;
}

/**
 * Parse a standalone `cretli-ref todo=<id>` line. Returns null for every other
 * line, including the `cretli-ref chat=<uuid> seq=<n>` message pointer.
 *
 * @param {unknown} text
 * @returns {{ todoId: string } | null}
 */
export function parseTodoRef(text) {
  const line = String(text || '').trim();
  const match = TODO_REF_LINE_RE.exec(line);
  if (!match) return null;
  const todoId = normalizeTodoRefId(match[1]);
  if (!todoId) return null;
  return { todoId };
}
