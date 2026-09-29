/**
 * Pure TODO tree view helpers: flatten, collapse, drop target, row markers.
 * No DOM. Drop index matches placeTodoInSiblingGroup (index among the other siblings).
 */
import {
  TODO_MAX_DEPTH,
  buildTodoIndex,
  collectTodoSubtreeIds,
  isTodoBranchBlocked,
  listReadyTodoLeaves,
  readTodoParentId,
  todoNodeDepth,
  todoSubtreeHeight,
  wouldCreateTodoParentCycle,
} from '../../../lib/todo-tree.js';

/** Top and bottom bands of a row are reorder; the middle nests. */
export const TODO_DROP_EDGE_RATIO = 0.28;

/**
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareSibling(a, b) {
  const ai = Number.isInteger(a.siblingIndex) ? a.siblingIndex : Number.MAX_SAFE_INTEGER;
  const bi = Number.isInteger(b.siblingIndex) ? b.siblingIndex : Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return 0;
}

/**
 * @param {object[] | null | undefined} items
 * @returns {Map<string, object[]>}
 */
function siblingGroups(items) {
  const list = Array.isArray(items) ? items : [];
  const known = new Set();
  list.forEach((item) => {
    if (item?.id) known.add(String(item.id));
  });
  /** @type {Map<string, { item: object, position: number }[]>} */
  const groups = new Map();
  list.forEach((item, position) => {
    if (!item?.id) return;
    const parentId = readTodoParentId(item);
    const key = parentId && known.has(parentId) ? parentId : '';
    const bucket = groups.get(key) || [];
    bucket.push({ item, position });
    groups.set(key, bucket);
  });
  /** @type {Map<string, object[]>} */
  const sorted = new Map();
  for (const [key, bucket] of groups) {
    bucket.sort((a, b) => {
      const byIndex = compareSibling(a.item, b.item);
      if (byIndex !== 0) return byIndex;
      return a.position - b.position;
    });
    sorted.set(key, bucket.map((entry) => entry.item));
  }
  return sorted;
}

/**
 * Depth-first rows. Collapsed ids hide descendants but stay in the list.
 * A missing parent is treated as a root so the row is still visible.
 *
 * @param {object[] | null | undefined} items
 * @param {Iterable<string> | null | undefined} collapsedIds
 * @returns {{ item: object, level: number, parentId: string, hasChildren: boolean, collapsed: boolean }[]}
 */
export function flattenTodoTree(items, collapsedIds) {
  const collapsed = new Set();
  if (collapsedIds) {
    for (const id of collapsedIds) {
      const key = String(id || '').trim();
      if (key) collapsed.add(key);
    }
  }
  const groups = siblingGroups(items);
  /** @type {{ item: object, level: number, parentId: string, hasChildren: boolean, collapsed: boolean }[]} */
  const rows = [];
  const walk = (parentKey, level) => {
    for (const item of groups.get(parentKey) || []) {
      const id = String(item.id);
      const children = groups.get(id) || [];
      const hasChildren = children.length > 0;
      const isCollapsed = hasChildren && collapsed.has(id);
      rows.push({
        item,
        level,
        parentId: parentKey,
        hasChildren,
        collapsed: isCollapsed,
      });
      if (isCollapsed) continue;
      walk(id, level + 1);
    }
  };
  walk('', 0);
  return rows;
}

/**
 * @param {number} ratio
 * @returns {'before' | 'after' | 'nest'}
 */
export function todoDropZoneFromRatio(ratio) {
  const value = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0.5;
  if (value < TODO_DROP_EDGE_RATIO) return 'before';
  if (value > 1 - TODO_DROP_EDGE_RATIO) return 'after';
  return 'nest';
}

/**
 * @param {object | null | undefined} item
 * @returns {string}
 */
export function formatTodoAssigneeBadge(item) {
  const assignee = item?.assignee;
  if (!assignee || typeof assignee !== 'object') return '';
  const harness = String(assignee.harness || '').trim();
  if (!harness) return '';
  const model = String(assignee.model || '').trim();
  const role = String(assignee.role || '').trim();
  return [harness, model, role].filter(Boolean).join(' · ');
}

/**
 * @param {object[] | null | undefined} items
 * @param {object | null | undefined} item
 * @returns {'blocked' | 'ready' | ''}
 */
export function readTodoRowMark(items, item) {
  if (!item?.id) return '';
  if (isTodoBranchBlocked(items, item)) return 'blocked';
  const ready = listReadyTodoLeaves(items).some((row) => row?.id === item.id);
  return ready ? 'ready' : '';
}

/**
 * @param {object[]} items
 * @param {string} parentId
 * @param {string} draggedId
 * @returns {object[]}
 */
function siblingsExcept(items, parentId, draggedId) {
  return (siblingGroups(items).get(parentId) || []).filter((row) => String(row.id) !== draggedId);
}

/**
 * @param {{
 *   items?: object[] | null,
 *   draggedId?: string,
 *   targetId?: string,
 *   zone?: string,
 * }} input
 * @returns {{ ok: true, parentId: string | null, siblingIndex: number } | { ok: false, reason: string }}
 */
export function resolveTodoDrop(input) {
  const items = Array.isArray(input?.items) ? input.items : [];
  const draggedId = String(input?.draggedId || '').trim();
  const targetId = String(input?.targetId || '').trim();
  const zone = input?.zone === 'before' || input?.zone === 'after' || input?.zone === 'nest'
    ? input.zone
    : '';
  if (!draggedId || !targetId || !zone) return { ok: false, reason: 'invalid' };
  if (draggedId === targetId) return { ok: false, reason: 'self' };
  const index = buildTodoIndex(items);
  const dragged = index.get(draggedId);
  const target = index.get(targetId);
  if (!dragged || !target) return { ok: false, reason: 'missing' };
  const subtree = new Set(collectTodoSubtreeIds(items, draggedId));
  const parentId = zone === 'nest' ? targetId : readTodoParentId(target);
  if (parentId && subtree.has(parentId)) return { ok: false, reason: 'cycle' };
  if (parentId && wouldCreateTodoParentCycle(items, draggedId, parentId)) {
    return { ok: false, reason: 'cycle' };
  }
  if (parentId && todoNodeDepth(items, parentId) + todoSubtreeHeight(items, draggedId) > TODO_MAX_DEPTH) {
    return { ok: false, reason: 'depth' };
  }
  const siblings = siblingsExcept(items, parentId, draggedId);
  let siblingIndex = siblings.length;
  if (zone !== 'nest') {
    const targetIndex = siblings.findIndex((row) => String(row.id) === targetId);
    if (targetIndex < 0) return { ok: false, reason: 'missing' };
    siblingIndex = zone === 'before' ? targetIndex : targetIndex + 1;
  }
  const currentParent = readTodoParentId(dragged);
  const currentIndex = Number.isInteger(dragged.siblingIndex) ? dragged.siblingIndex : 0;
  if (currentParent === parentId && currentIndex === siblingIndex) {
    return { ok: false, reason: 'noop' };
  }
  return { ok: true, parentId: parentId || null, siblingIndex };
}

/**
 * A new child would sit one level under `parentId`.
 *
 * @param {object[] | null | undefined} items
 * @param {string} parentId
 * @returns {boolean}
 */
export function canAddTodoChild(items, parentId) {
  const id = String(parentId || '').trim();
  if (!id || !buildTodoIndex(items).has(id)) return false;
  return todoNodeDepth(items, id) + 1 <= TODO_MAX_DEPTH;
}
