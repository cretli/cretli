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
