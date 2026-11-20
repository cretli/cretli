/**
 * Process-local index of chats whose host-owned state makes them read-only Scout / feedback-triage chats.
 *
 * Why it exists: the read-only policy is asked from synchronous permission paths (tool guards, stream handlers) that
 * cannot await the chats store. The chats facade (`lib/persist/chats-runtime.js`) notes every row it hands out or
 * creates, so a chat that runs in this process was necessarily seen here first. `pickPurpose` and `readOnlyScout` are
 * host-owned and never rewritten by an update, so the entry never goes stale. Dependency-free on purpose: both the
 * facade and `workspace-scout-chat.js` import it without forming a module cycle.
 */

/** @type {Set<string>} */
const scoutChatIds = new Set();

/**
 * The trusted-state rule: `readOnlyScout` or a Scout / feedback-triage `pickPurpose`.
 *
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isScoutReadOnlyRow(chat) {
  if (!chat || typeof chat !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (chat);
  if (row.readOnlyScout === true) return true;
  return ['scout', 'feedback_triage'].includes(String(row.pickPurpose || '').trim());
}

/**
 * Registers a row (or each row of a list) when it is a read-only Scout chat. Returns its argument unchanged.
 *
 * @template T
 * @param {T} value a chat row, a list of rows or null
 * @returns {T}
 */
export function noteChatRowsForScoutIndex(value) {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const id = /** @type {any} */ (row)?.id;
    if (typeof id === 'string' && id && isScoutReadOnlyRow(row)) scoutChatIds.add(id);
  }
  return value;
}

/** @param {unknown} chatId @returns {boolean} */
export function isScoutChatIdRegistered(chatId) {
  return scoutChatIds.has(String(chatId || '').trim());
}

/** Test hook. */
export function resetScoutChatRegistry() {
  scoutChatIds.clear();
}
