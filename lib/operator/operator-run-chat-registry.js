/**
 * Process-local index of chats seen by the chats facade, split by identity.
 *
 * Sibling of `scout-chat-registry.js`, deliberately separate: the operator
 * allowlist differs from the Scout one (no `scout_findings` submit, no web, no
 * shell), so `isScoutReadOnlyRow` semantics must not be reused. The facade notes
 * every row it hands out or creates, so a run that executes in this process was
 * necessarily seen here first; `pickPurpose` is host-owned and never rewritten
 * by an update. Dependency-free on purpose (no import cycle with the facade).
 *
 * Identity is tri-state: `operator` | `normal` | `unknown`. A chat the index has
 * not confirmed is `unknown`, and every operator-isolation guard treats unknown
 * like an operator run (deny); only a confirmed `normal` row keeps the regular
 * policy. A chat without an id (external /mcp) is `normal`.
 */

import { OPERATOR_RUN_PICK_PURPOSE } from './operator-constants.js';

/** @typedef {'operator' | 'normal' | 'unknown'} OperatorRunIdentity */

/** @type {Map<string, string>} chat id -> operator run id */
const operatorRunChats = new Map();
/** @type {Set<string>} */
const confirmedNormalChats = new Set();
/** Bumped on reset so callers that cache "already indexed" know the index was emptied. */
let indexGeneration = 0;

/** @returns {number} */
export function getOperatorIndexGeneration() {
  return indexGeneration;
}

/**
 * Trusted-state rule: the host-owned `pickPurpose` of an operator run chat.
 *
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isOperatorRunRow(chat) {
  if (!chat || typeof chat !== 'object') return false;
  return String(/** @type {Record<string, unknown>} */ (chat).pickPurpose || '').trim() === OPERATOR_RUN_PICK_PURPOSE;
}

/**
 * Registers a row (or each row of a list) under its identity. Returns its
 * argument unchanged.
 *
 * @template T
 * @param {T} value a chat row, a list of rows or null
 * @returns {T}
 */
export function noteChatRowsForOperatorIndex(value) {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const id = /** @type {any} */ (row)?.id;
    if (typeof id !== 'string' || !id) continue;
    if (isOperatorRunRow(row)) {
      operatorRunChats.set(id, String(/** @type {any} */ (row).operatorRunId || ''));
      confirmedNormalChats.delete(id);
    } else if (!operatorRunChats.has(id)) {
      confirmedNormalChats.add(id);
    }
  }
  return value;
}

/**
 * @param {unknown} chatId
 * @returns {OperatorRunIdentity}
 */
export function getOperatorRunIdentity(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return 'normal';
  if (operatorRunChats.has(id)) return 'operator';
  if (confirmedNormalChats.has(id)) return 'normal';
  return 'unknown';
}

/** @param {unknown} chatId @returns {boolean} true for a confirmed operator run */
export function isOperatorRunChatIdRegistered(chatId) {
  return getOperatorRunIdentity(chatId) === 'operator';
}

/**
 * True when the operator isolation guards must apply: a confirmed operator run
 * or a chat whose identity could not be confirmed (fail-closed).
 *
 * @param {unknown} chatId
 * @returns {boolean}
 */
export function isOperatorIsolatedChatId(chatId) {
  return getOperatorRunIdentity(chatId) !== 'normal';
}

/** @param {unknown} chatId @returns {string} run id of a registered operator run chat, else '' */
export function getRegisteredOperatorRunId(chatId) {
  return operatorRunChats.get(String(chatId || '').trim()) || '';
}

/** Test hook. */
export function resetOperatorRunChatRegistry() {
  operatorRunChats.clear();
  confirmedNormalChats.clear();
  indexGeneration += 1;
}
