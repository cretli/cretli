import { normalizeChatWorkspaceScopeForListLoad } from './chatListLoadFreshness.js';

/**
 * After a scoped archive GET, keep archived rows from other workspaces in RAM while
 * applying the server window for the expanded workspace (additive reconcile).
 *
 * @param {object[]} existingChats
 * @param {object[]} reconciledRows
 * @param {string} archiveWorkspace
 * @returns {object[]}
 */
export function mergeRuntimeChatListAfterScopedArchiveLoad(existingChats, reconciledRows, archiveWorkspace) {
  const scopedKey = normalizeChatWorkspaceScopeForListLoad(archiveWorkspace);
  if (!scopedKey) return reconciledRows;
  const mergedById = new Map();
  for (const row of reconciledRows) {
    if (row?.id) mergedById.set(row.id, row);
  }
  for (const chat of existingChats) {
    if (!chat?.id || mergedById.has(chat.id)) continue;
    if (!chat.archivedAt) continue;
    const wsKey = normalizeChatWorkspaceScopeForListLoad(chat.workspaceFile);
    if (wsKey === scopedKey) continue;
    mergedById.set(chat.id, chat);
  }
  return Array.from(mergedById.values());
}

/**
 * A live-only GET says nothing about archived rows, so the ones already loaded for an open
 * archive section stay in RAM. Boot-cache rows are left to the unconfirmed-row teardown.
 *
 * @param {any[]} existingChats
 * @param {any[]} reconciledRows
 * @returns {any[]}
 */
export function retainArchivedRowsAfterLiveLoad(existingChats, reconciledRows) {
  const seenIds = new Set(reconciledRows.map((row) => row?.id));
  const retained = existingChats.filter((chat) => (
    chat?.id
    && chat.archivedAt
    && chat._fromBootCache !== true
    && !seenIds.has(chat.id)
  ));
  return retained.length > 0 ? [...reconciledRows, ...retained] : reconciledRows;
}
