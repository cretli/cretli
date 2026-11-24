/**
 * Identifies internal operator run chats from trusted host state (the chat
 * row's `pickPurpose`), never from a model argument. Identity is tri-state
 * (`operator` | `normal` | `unknown`); see `operator-run-chat-registry.js`.
 */

import { getChatByIdAsync } from '../persist/chats-persist.js';
import {
  getOperatorRunIdentity,
  isOperatorRunRow,
  noteChatRowsForOperatorIndex,
} from './operator-run-chat-registry.js';

export { isOperatorRunRow };

/**
 * @param {unknown} chatId
 * @param {unknown} row the chat row, or a falsy value when it could not be read
 * @returns {import('./operator-run-chat-registry.js').OperatorRunIdentity}
 */
function identityFromRow(chatId, row) {
  const id = String(chatId || '').trim();
  const found = /** @type {any} */ (row);
  if (!found || typeof found !== 'object' || String(found.id || '') !== id) return 'unknown';
  noteChatRowsForOperatorIndex(found);
  return isOperatorRunRow(found) ? 'operator' : 'normal';
}

/**
 * Synchronous identity for permission paths that cannot await. A cold index
 * with no injected store reads is `unknown`.
 *
 * @param {unknown} chatId
 * @param {{ loadChats?: () => unknown[] }} [options] test injection replacing the store
 * @returns {import('./operator-run-chat-registry.js').OperatorRunIdentity}
 */
export function resolveOperatorRunIdentity(chatId, options = {}) {
  const known = getOperatorRunIdentity(chatId);
  if (known !== 'unknown') return known;
  if (typeof options.loadChats !== 'function') return 'unknown';
  try {
    const chats = options.loadChats();
    return identityFromRow(chatId, (Array.isArray(chats) ? chats : []).find((row) => /** @type {any} */ (row)?.id === String(chatId).trim()));
  } catch {
    return 'unknown';
  }
}

/**
 * Authoritative asynchronous variant (reads the chat store).
 *
 * @param {unknown} chatId
 * @param {{ loadChats?: () => unknown[] | Promise<unknown[]> }} [options]
 * @returns {Promise<import('./operator-run-chat-registry.js').OperatorRunIdentity>}
 */
export async function resolveOperatorRunIdentityAsync(chatId, options = {}) {
  const known = getOperatorRunIdentity(chatId);
  if (known !== 'unknown') return known;
  try {
    if (typeof options.loadChats === 'function') {
      const chats = await options.loadChats();
      return identityFromRow(chatId, (Array.isArray(chats) ? chats : []).find((row) => /** @type {any} */ (row)?.id === String(chatId).trim()));
    }
    return identityFromRow(chatId, await getChatByIdAsync(String(chatId).trim()));
  } catch {
    return 'unknown';
  }
}

/** @returns {boolean} true only for a confirmed operator run */
export function isOperatorRunChatId(chatId, options = {}) {
  return resolveOperatorRunIdentity(chatId, options) === 'operator';
}

/** @returns {Promise<boolean>} true only for a confirmed operator run */
export async function isOperatorRunChatIdAsync(chatId, options = {}) {
  return (await resolveOperatorRunIdentityAsync(chatId, options)) === 'operator';
}

/**
 * True when operator isolation must apply: confirmed operator run or unknown.
 *
 * @param {unknown} chatId
 * @param {{ loadChats?: () => unknown[] }} [options]
 * @returns {boolean}
 */
export function isOperatorIsolatedChat(chatId, options = {}) {
  return resolveOperatorRunIdentity(chatId, options) !== 'normal';
}
