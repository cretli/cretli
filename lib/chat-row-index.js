/**
 * In-process index of chat rows by id, fed by every row the chats facade hands out (see `seen` in
 * `persist/chats-runtime.js`). It exists for the few synchronous liveness/run-state probes of `chat-run-service.js`
 * that the watcher, delegation and update-gate chains call without awaiting: they need only the transport and the
 * session identifiers of a row, which are stable, so a row seen earlier is enough. It never reads a chat store, so it
 * works on every backend (legacy JSON and SQLite alike). A chat the facade has not handed out yet is absent
 * (`getIndexedChatRow` returns null, which the probes report as a missing chat); callers that can await use the
 * `*Async` probes instead, and boot warms the index with one facade read before any probe consumer starts.
 */

/** @type {Map<string, Record<string, any>>} */
const rowsById = new Map();

/**
 * Records a row (or each row of a list). Returns its argument unchanged so it can wrap a facade result.
 *
 * @template T
 * @param {T} value a chat row, a list of rows or null
 * @returns {T}
 */
export function noteChatRowsForRunIndex(value) {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const id = /** @type {any} */ (row)?.id;
    if (typeof id === 'string' && id) rowsById.set(id, /** @type {Record<string, any>} */ (row));
  }
  return value;
}

/** @param {unknown} chatId */
export function forgetChatRowForRunIndex(chatId) {
  rowsById.delete(String(chatId || '').trim());
}

/** @param {unknown} chatId @returns {Record<string, any> | null} */
export function getIndexedChatRow(chatId) {
  return rowsById.get(String(chatId || '').trim()) || null;
}

/** @returns {Record<string, any>[]} */
export function listIndexedChatRows() {
  return [...rowsById.values()];
}

/** @param {unknown} sessionKey @returns {Record<string, any> | null} */
export function getIndexedChatRowBySession(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key) return null;
  for (const row of rowsById.values()) if (row.cursorSessionId === key) return row;
  return null;
}

/** Test hook: drops every indexed row. */
export function resetChatRowIndexForTest() {
  rowsById.clear();
}
