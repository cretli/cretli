/**
 * Pure helpers for sidebar drag: captured subtrees and drop parent ids.
 * DOM classes like is-child are not a parent pointer.
 */

export const MAX_SIDEBAR_NEST_INDENT = 8;

/**
 * @param {unknown} datasetNestLevel
 * @param {boolean} [isChild]
 * @returns {number}
 */
export function readNestLevel(datasetNestLevel, isChild = false) {
  const fromData = Number(datasetNestLevel);
  if (Number.isFinite(fromData) && fromData >= 0) return fromData;
  return isChild ? 1 : 0;
}

/**
 * Descendants of `startIndex` are the following rows with a strictly greater level.
 *
 * @param {{ id?: string, level?: number }[]} items
 * @param {number} startIndex
 * @returns {number[]}
 */
export function collectNestedBlockIndexes(items, startIndex) {
  if (!Array.isArray(items) || startIndex < 0 || startIndex >= items.length) return [];
  const startLevel = readNestLevel(items[startIndex]?.level);
  const indexes = [startIndex];
  for (let i = startIndex + 1; i < items.length; i += 1) {
    if (readNestLevel(items[i]?.level) <= startLevel) break;
    indexes.push(i);
  }
  return indexes;
}

/**
 * @param {{ nestParentId?: string, parentChatId?: string } | null | undefined} drop
 * @returns {string}
 */
export function readDropParentChatId(drop) {
  const nested = String(drop?.nestParentId || '').trim();
  if (nested) return nested;
  return String(drop?.parentChatId || '').trim();
}

/**
 * A row that may take part in chat drag & drop. Hidden rows (folded into a
 * collapsed subchat group, or hidden behind a collapsed parent) must never be
 * measured, reordered, or used as a drop target.
 *
 * @param {{ id?: unknown, archived?: unknown, hidden?: unknown, subchatHidden?: unknown, isGroup?: unknown } | null | undefined} row
 * @returns {boolean}
 */
export function isChatRowDraggable(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isGroup === true) return false;
  if (row.archived === true || row.archived === '1') return false;
  if (row.hidden === true) return false;
  if (row.subchatHidden === true) return false;
  return true;
}

/**
 * @param {{ id?: unknown }[]} rows
 * @returns {{ id: string }[]}
 */
export function selectDraggableChatRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => isChatRowDraggable(row) && String(row?.id || '').trim() !== '');
}

/**
 * @param {{
 *   parentChatId?: string,
 *   parentLevel?: number,
 *   relativeLevels?: number[],
 * }} input
 * @returns {{ parentId: string, rootLevel: number, levels: number[], indentLevels: number[] }}
 */
/**
 * @param {Element | null | undefined} node
 * @returns {HTMLElement | null}
 */
export function resolveSidebarChatRowLiFromListNode(node) {
  if (!(node instanceof HTMLElement)) return null;
  if (node.classList.contains('sidebar-chat-item')) return node;
  if (node.tagName === 'CR-SIDEBAR-CHAT-ROW') {
    const li = node.querySelector('li.sidebar-chat-item');
    return li instanceof HTMLElement ? li : null;
  }
  return null;
}

/**
 * Collect nested chat rows for drag when list children are Lit hosts (`display:contents`).
 *
 * @param {HTMLElement} li
 * @returns {HTMLElement[]}
 */
export function collectSidebarChatBlock(li) {
  const nodes = [li];
  const level = readNestLevel(li?.dataset?.nestLevel, li.classList.contains('is-child'));
  let listSibling = li.closest('cr-sidebar-chat-row')?.nextElementSibling ?? li.nextElementSibling;
  while (listSibling instanceof HTMLElement) {
    const nextLi = resolveSidebarChatRowLiFromListNode(listSibling);
    if (!nextLi) break;
    if (nextLi.dataset.archived === '1' || nextLi.hidden || nextLi.classList.contains('is-subchat-hidden')) break;
    if (readNestLevel(nextLi.dataset.nestLevel, nextLi.classList.contains('is-child')) <= level) break;
    nodes.push(nextLi);
    listSibling = listSibling.nextElementSibling;
  }
  return nodes;
}

/**
 * List `<ul>` child for drag reorder: Lit host when present, else the row `<li>`.
 *
 * @param {HTMLElement} li
 * @returns {HTMLElement}
 */
export function sidebarChatRowListHostOf(li) {
  if (!(li instanceof HTMLElement)) return li;
  const host = li.closest('cr-sidebar-chat-row');
  return host instanceof HTMLElement ? host : li;
}

/**
 * Live-reorder captured block rows by moving list hosts (not inner `<li>` nodes).
 *
 * @param {HTMLElement} list
 * @param {HTMLElement[]} blockLis
 * @param {HTMLElement | null} beforeLi row to insert before (from `drop.beforeId`), or null for end
 * @returns {boolean} true when the list DOM was updated
 */
export function insertSidebarChatBlockAt(list, blockLis, beforeLi) {
  if (!(list instanceof HTMLElement) || !Array.isArray(blockLis) || blockLis.length === 0) return false;
  const beforeEl = beforeLi instanceof HTMLElement ? beforeLi : null;
  const beforeHost = beforeEl ? sidebarChatRowListHostOf(beforeEl) : null;
  const lastHost = sidebarChatRowListHostOf(blockLis[blockLis.length - 1]);
  const alreadyPlaced = beforeHost
    ? lastHost.nextElementSibling === beforeHost
    : list.lastElementChild === lastHost;
  if (alreadyPlaced) return false;
  const frag = document.createDocumentFragment();
  const seen = new Set();
  for (const node of blockLis) {
    const host = sidebarChatRowListHostOf(node);
    if (seen.has(host)) continue;
    seen.add(host);
    frag.appendChild(host);
  }
  list.insertBefore(frag, beforeHost);
  return true;
}

export function resolveBlockNest(input = {}) {
  const parentId = String(input.parentChatId || '').trim();
  const parentLevel = Number(input.parentLevel);
  const rootLevel = parentId
    ? (Number.isFinite(parentLevel) && parentLevel >= 0 ? parentLevel + 1 : 1)
    : 0;
  const relative = Array.isArray(input.relativeLevels) && input.relativeLevels.length
    ? input.relativeLevels
    : [0];
  const levels = relative.map((rel) => rootLevel + Math.max(0, Number(rel) || 0));
  return {
    parentId,
    rootLevel,
    levels,
    indentLevels: levels.map((level) => Math.min(MAX_SIDEBAR_NEST_INDENT, level)),
  };
}
