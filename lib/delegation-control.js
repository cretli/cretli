/**
 * Delegation control model.
 *
 * `parentChatId` is the historical identity of the chat that started a
 * delegation. The chat that currently *controls* it (waits, acks, rates,
 * cancels, owns the workflow and the queue) is a separate notion: an optional
 * `controllerChatId` on the record, falling back to `parentChatId` for every
 * record that has none. Control decisions must go through
 * `delegationController(row)`; `parentChatId` stays for identity/history.
 *
 * Guarded by tests/delegation-controller-guard.test.js.
 */

function normalizeChatId(value) {
  return String(value ?? '').trim();
}

/**
 * Chat id that currently controls the delegation.
 *
 * @param {{ controllerChatId?: unknown, parentChatId?: unknown } | null | undefined} row
 * @returns {string} '' when the row has neither field
 */
export function delegationController(row) {
  if (!row || typeof row !== 'object') return '';
  return normalizeChatId(row.controllerChatId) || normalizeChatId(row.parentChatId);
}

/**
 * @param {object | null | undefined} row
 * @param {string} chatId
 * @returns {boolean}
 */
export function canChatControlDelegation(row, chatId) {
  const caller = normalizeChatId(chatId);
  if (!caller) return false;
  return delegationController(row) === caller;
}

/**
 * Chat ids a "scope" gate may resolve a chat from: the controller first, then
 * the historical parent (it may already be deleted).
 *
 * @param {object | null | undefined} row
 * @returns {string[]}
 */
export function delegationScopeChatIds(row) {
  const ids = [delegationController(row), normalizeChatId(row?.parentChatId)].filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Resolve the chat a scope gate checks (workspace / widget access) for a
 * delegation: the controller when it still exists, else the historical parent.
 * Never reports "not found" just because the original parent was deleted.
 *
 * @param {object | null | undefined} row
 * @param {(chatId: string) => object | null | undefined} findChat
 * @returns {object | null}
 */
export function resolveDelegationScopeChat(row, findChat) {
  for (const chatId of delegationScopeChatIds(row)) {
    const chat = findChat(chatId);
    if (chat) return chat;
  }
  return null;
}
