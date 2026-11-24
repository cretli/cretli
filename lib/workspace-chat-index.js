/**
 * Read model: persisted chat rows grouped by their raw `workspaceFolder` string.
 *
 * The Watcher snapshot used to canonicalize (path.resolve + realpath) the folder of every chat on every
 * call — O(chats) filesystem calls per snapshot, which dominated the event loop under background cycles.
 * Chats share a handful of distinct folders, so the group-by is built once per chats snapshot and a call
 * only canonicalizes the distinct folders (O(workspaces)).
 *
 * Invalidation: the index is keyed by the identity of the read-only rows array that
 * `peekChatsAsync()` hands out. Every chats write replaces that array, so a changed chat (new folder,
 * pinned flag, new/removed chat) can never be served from a stale index. The canonical match key itself
 * is still computed per call, so the realpath cache TTL (symlink re-pointing) keeps its meaning.
 */

/** @type {Map<readonly Record<string, any>[], Map<string, Record<string, any>[]>>} */
const indexByRows = new Map();

/** Counters for tests and profiling. */
export const workspaceChatIndexStats = { builds: 0, hits: 0 };

/**
 * @param {readonly Record<string, any>[]} rows read-only shared rows (never mutated here)
 * @returns {Map<string, Record<string, any>[]>}
 */
function groupByRawFolder(rows) {
  const cached = indexByRows.get(rows);
  if (cached) {
    workspaceChatIndexStats.hits += 1;
    return cached;
  }
  workspaceChatIndexStats.builds += 1;
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const chat of rows) {
    if (!chat || chat.watcherPinned === true) continue;
    if (!String(chat.id ?? '').trim()) continue;
    const folder = String(chat.workspaceFolder ?? '');
    const list = groups.get(folder);
    if (list) list.push(chat);
    else groups.set(folder, [chat]);
  }
  indexByRows.set(rows, groups);
  // Only the latest snapshot matters; older arrays are garbage once the cache replaces them.
  if (indexByRows.size > 4) indexByRows.delete(indexByRows.keys().next().value);
  return groups;
}

/**
 * Chats (not watcher-pinned, with an id) whose canonical workspace key equals `matchKey`.
 *
 * @param {readonly Record<string, any>[]} rows
 * @param {(folder: unknown) => string} matchKeyOf canonicalizer, called once per distinct raw folder
 * @param {string} matchKey
 * @returns {Record<string, any>[]}
 */
export function listChatsByWorkspaceMatchKey(rows, matchKeyOf, matchKey) {
  const out = [];
  for (const [folder, chats] of groupByRawFolder(rows)) {
    if (matchKeyOf(folder) === matchKey) out.push(...chats);
  }
  return out;
}
