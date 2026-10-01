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

/** Persisted todo item status values (root filter). */
export const TODO_ITEM_STATUSES = ['idea', 'ready', 'doing', 'done'];

/**
 * @param {unknown} status
 * @returns {'idea' | 'ready' | 'doing' | 'done'}
 */
export function normalizeTodoItemStatus(status) {
  const raw = String(status || 'idea').trim();
  return /** @type {'idea' | 'ready' | 'doing' | 'done'} */ (
    TODO_ITEM_STATUSES.includes(raw) ? raw : 'idea'
  );
}

/**
 * @param {unknown} values
 * @returns {Set<string> | null} `null` = no filter (show all roots).
 */
export function parseTodoRootStatusFilter(values) {
  if (!Array.isArray(values)) return null;
  /** @type {Set<string>} */
  const selected = new Set();
  values.forEach((value) => {
    const key = String(value || '').trim();
    if (TODO_ITEM_STATUSES.includes(key)) selected.add(key);
  });
  if (selected.size === 0 || selected.size >= TODO_ITEM_STATUSES.length) return null;
  return selected;
}

/**
 * @param {Set<string> | null | undefined} filter
 * @returns {string[]}
 */
export function serializeTodoRootStatusFilter(filter) {
  if (!filter || filter.size === 0 || filter.size >= TODO_ITEM_STATUSES.length) return [];
  return TODO_ITEM_STATUSES.filter((status) => filter.has(status));
}

/**
 * Keeps only subtrees whose root matches `statusFilter`. Orphans (missing parent)
 * are treated as roots, same as flattenTodoTree.
 *
 * @param {object[] | null | undefined} items
 * @param {Set<string> | null | undefined} statusFilter
 * @returns {object[]}
 */
export function filterTodoItemsByRootStatus(items, statusFilter) {
  const list = Array.isArray(items) ? items : [];
  if (!statusFilter || statusFilter.size === 0) return list;
  const byId = buildTodoIndex(list);
  const known = new Set(byId.keys());
  /** @type {string[]} */
  const rootIds = [];
  list.forEach((item) => {
    if (!item?.id) return;
    const parentId = readTodoParentId(item);
    const isRoot = !parentId || !known.has(parentId);
    if (isRoot) rootIds.push(String(item.id));
  });
  /** @type {Set<string>} */
  const visibleIds = new Set();
  rootIds.forEach((rootId) => {
    const root = byId.get(rootId);
    if (!root) return;
    if (!statusFilter.has(normalizeTodoItemStatus(root.status))) return;
    collectTodoSubtreeIds(list, rootId).forEach((id) => visibleIds.add(id));
  });
  return list.filter((item) => item?.id && visibleIds.has(String(item.id)));
}

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
 * Harness a Todo's agent chat should start with. The explicit assignee wins,
 * then the stored source harness (or the harness captured in sourceChat), then
 * the caller's fallback. Both the row menu and the card dialog use this, so the
 * same todo resolves to the same harness from every entry point.
 *
 * @param {unknown} item
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveTodoStartHarness(item, fallback = 'sdk') {
  const row = item && typeof item === 'object' ? /** @type {Record<string, any>} */ (item) : {};
  const assignee = row.assignee && typeof row.assignee === 'object' ? row.assignee : null;
  const candidates = [assignee?.harness, row.sourceHarness, row.sourceChat?.agentTransport];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return String(fallback || '').trim() || 'sdk';
}

/**
 * First 8 characters of the todo uuid — the same short id MCP `formatTodoLine`
 * prints, so a user can paste it back into `todo_show`.
 *
 * @param {unknown} id
 * @returns {string}
 */
export function formatTodoShortId(id) {
  return String(id || '').trim().slice(0, 8);
}

/**
 * @param {unknown} item
 * @returns {number}
 */
export function countActiveTodoChats(item) {
  const chats = Array.isArray(item?.chats) ? item.chats : [];
  return chats.filter((chat) => !chat?.deleted).length;
}

/**
 * Most recent activity timestamp known for a todo (chat activity first, then
 * the item revision).
 *
 * @param {unknown} item
 * @returns {string}
 */
export function resolveTodoLastActivityAt(item) {
  const chats = Array.isArray(item?.chats) ? item.chats : [];
  const latest = chats
    .filter((chat) => !chat?.deleted)
    .map((chat) => String(chat?.lastAt || '').trim())
    .filter(Boolean)
    .sort()
    .pop();
  return latest || String(/** @type {any} */ (item)?.updatedAt || '').trim();
}

/**
 * Coarse relative age for a todo row/dialog. Returns null for a missing or
 * unparsable timestamp so callers can omit the whole fragment.
 *
 * @param {unknown} iso
 * @param {number} [nowMs]
 * @returns {{ unit: 'now' | 'minutes' | 'hours' | 'days', count: number } | null}
 */
export function formatTodoRelativeTime(iso, nowMs = Date.now()) {
  const raw = String(iso || '').trim();
  if (!raw) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  const diffMs = Number(nowMs) - at;
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return { unit: 'now', count: 0 };
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.floor(hours / 24) };
}

/**
 * i18n key for "{count} chats" with Polish plural categories.
 *
 * @param {number} count
 * @param {string} [lang]
 * @returns {'todo.chatCountOne' | 'todo.chatCountFew' | 'todo.chatCountMany'}
 */
export function resolveTodoChatCountKey(count, lang = 'en') {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (String(lang || '').trim().toLowerCase().startsWith('pl')) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (n === 1) return 'todo.chatCountOne';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'todo.chatCountFew';
    return 'todo.chatCountMany';
  }
  return n === 1 ? 'todo.chatCountOne' : 'todo.chatCountMany';
}

/**
 * Everything the row meta line and the dialog ID/meta bar need, so the same
 * formatting is unit-testable without a DOM.
 *
 * @param {unknown} item
 * @param {number} [nowMs]
 * @returns {{
 *   shortId: string,
 *   chats: number,
 *   age: ReturnType<typeof formatTodoRelativeTime>,
 * }}
 */
export function readTodoRowMeta(item, nowMs = Date.now()) {
  return {
    shortId: formatTodoShortId(/** @type {any} */ (item)?.id),
    chats: countActiveTodoChats(item),
    age: formatTodoRelativeTime(resolveTodoLastActivityAt(item), nowMs),
  };
}

/**
 * Clipboard markdown for a todo: title, notes and the persisted plan.
 *
 * @param {unknown} item
 * @returns {string}
 */
export function buildTodoMarkdown(item) {
  const title = String(/** @type {any} */ (item)?.title || '').trim();
  const body = /** @type {any} */ (item)?.body != null ? String(/** @type {any} */ (item).body).trim() : '';
  const plan = /** @type {any} */ (item)?.plan;
  const planMarkdown =
    plan && typeof plan === 'object' && typeof plan.markdown === 'string' ? plan.markdown.trim() : '';
  const parts = [`# ${title || '(untitled)'}`];
  if (body) parts.push('', body);
  if (planMarkdown) parts.push('', '## Plan', '', planMarkdown);
  return parts.join('\n');
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
