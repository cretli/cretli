/**
 * Archive virtual list — ARIA listbox indices and keyboard logical navigation (stage 7.3).
 * Pure helpers; DOM scrolling lives on cr-sidebar-archive-group.
 */

/**
 * Flat archive tree options use 1-based posinset and setsize on each `role="option"`.
 *
 * @param {number} logicalIndex zero-based index in the flattened archive tree
 * @param {number} totalOptions option count (same as archiveTree.length)
 * @returns {{ ariaPosInSet: number, ariaSetSize: number } | null}
 */
export function computeArchiveOptionAria(logicalIndex, totalOptions) {
  const total = Math.max(0, Math.round(Number(totalOptions) || 0));
  const index = Math.round(Number(logicalIndex));
  if (total <= 0 || index < 0 || index >= total) return null;
  return { ariaPosInSet: index + 1, ariaSetSize: total };
}

/**
 * @param {string} key
 * @param {number} index
 * @param {number} count
 * @returns {number|null}
 */
export function resolveNextArchiveLogicalIndex(key, index, count) {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * @param {Array<{ chat?: { id?: string } }>} archiveTree
 * @param {string} chatId
 * @returns {number}
 */
export function findArchiveLogicalIndexByChatId(archiveTree, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return -1;
  const list = Array.isArray(archiveTree) ? archiveTree : [];
  return list.findIndex((item) => String(item?.chat?.id || '').trim() === id);
}

/**
 * Prefer stored logical index when it still points at `chatId`; otherwise resolve by id.
 *
 * @param {{ chatId?: string, logicalIndex?: number } | null | undefined} stored
 * @param {Array<{ chat?: { id?: string } }>} archiveTree
 * @returns {number}
 */
export function resolveArchiveStoredLogicalIndex(stored, archiveTree) {
  const chatId = String(stored?.chatId || '').trim();
  if (!chatId) return -1;
  const rows = Array.isArray(archiveTree) ? archiveTree : [];
  if (!rows.length) return -1;
  let logicalIndex = Number.isFinite(Number(stored?.logicalIndex))
    ? Math.round(Number(stored.logicalIndex))
    : -1;
  if (logicalIndex >= 0 && logicalIndex < rows.length) {
    const atIndex = String(rows[logicalIndex]?.chat?.id || '').trim();
    if (atIndex === chatId) return logicalIndex;
  }
  return findArchiveLogicalIndexByChatId(rows, chatId);
}
