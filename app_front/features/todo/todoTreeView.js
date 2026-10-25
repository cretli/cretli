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
export const TODO_ITEM_STATUSES = ['idea', 'ready', 'doing', 'done', 'deferred'];

/**
 * @param {unknown} status
 * @returns {'idea' | 'ready' | 'doing' | 'done' | 'deferred'}
 */
export function normalizeTodoItemStatus(status) {
  const raw = String(status || 'idea').trim();
  return /** @type {'idea' | 'ready' | 'doing' | 'done' | 'deferred'} */ (
    TODO_ITEM_STATUSES.includes(raw) ? raw : 'idea'
  );
}

/**
 * A row may join the bulk "integrate with agent" selection only when the server
 * marked it eligible. The read-only `batchEligibility` field is authoritative, so
 * the client never re-derives worktree / done state here.
 *
 * @param {unknown} item
 * @returns {boolean}
 */
export function isBatchSelectableItem(item) {
  const row = item && typeof item === 'object' ? /** @type {Record<string, any>} */ (item) : {};
  return String(row.batchEligibility?.mode || 'none').trim() !== 'none';
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

/** Integration states a todo can be in (`integrationSummary` on todo items). */
export const TODO_INTEGRATION_FILTERS = ['unconfirmed', 'awaiting', 'integrated', 'partial', 'rejected', 'conflict', 'no_code_changes'];
/** "Not integrated" preset: every state that still needs integration work. */
export const TODO_INTEGRATION_PENDING_FILTERS = ['unconfirmed', 'awaiting', 'partial', 'rejected', 'conflict'];

/**
 * Matches a todo against one integration filter. A no-code result is settled
 * even when its current proof state remains unconfirmed, so it must not leak
 * into the pending integration preset.
 *
 * @param {object | null | undefined} item
 * @param {string} filter
 * @returns {boolean}
 */
export function matchesTodoIntegrationFilter(item, filter) {
  const summary = item?.integrationSummary && typeof item.integrationSummary === 'object'
    ? item.integrationSummary
    : {};
  const state = String(summary.state || 'unconfirmed');
  const detail = String(summary.detail || '');
  if (detail === 'no_code_changes') return filter === detail;
  return state === filter || detail === filter;
}

/**
 * @param {string | null | undefined} raw Stored value; `null` when nothing usable is saved.
 * @returns {Set<string>} Empty set = all integration states. Nothing saved = the pending preset.
 */
export function parseTodoIntegrationFilter(raw) {
  const values = readStoredIntegrationValues(raw);
  if (!values) return new Set(TODO_INTEGRATION_PENDING_FILTERS);
  return new Set(values.filter((value) => TODO_INTEGRATION_FILTERS.includes(value)));
}

/**
 * @param {string | null | undefined} raw
 * @returns {string[] | null} `null` when the stored value cannot be read.
 */
function readStoredIntegrationValues(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  // Earlier builds stored one state name instead of a JSON array.
  if (!text.startsWith('[')) return [text];
  try {
    return JSON.parse(text).map(String);
  } catch {
    return null;
  }
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
 * Root order of the list. `manual` is the sibling (execution) order; the others
 * reorder root trees only, because children keep their sequential run order.
 */
export const TODO_SORT_MODES = ['manual', 'created', 'activity', 'active'];

/**
 * @param {unknown} value
 * @returns {'manual' | 'created' | 'activity' | 'active'}
 */
export function parseTodoSortMode(value) {
  const raw = String(value || '').trim();
  return /** @type {'manual' | 'created' | 'activity' | 'active'} */ (
    TODO_SORT_MODES.includes(raw) ? raw : 'manual'
  );
}

/** @param {unknown} iso */
function timestampMs(iso) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? at : 0;
}

/** Status rank for the `active` sort when no live agent decides it. */
const ACTIVE_STATUS_RANK = { doing: 2, ready: 3, idea: 4, done: 5, deferred: 6 };

/**
 * Root ids ordered by `mode`. A root tree counts as recently active / active when
 * any of its descendants is. `liveRank(root)` reports live agent state for a
 * root tree (0 = an agent is working, 1 = an agent waits for input, any other
 * value = nothing live), so this stays free of chat/DOM dependencies.
 *
 * @param {object[]} roots
 * @param {Map<string, object[]>} groups Output of siblingGroups.
 * @param {string} mode
 * @param {(root: object) => number} [liveRank]
 * @returns {object[]}
 */
function sortTodoRoots(roots, groups, mode, liveRank) {
  if (mode === 'manual') return roots;
  /** @param {object} root */
  const subtreeActivity = (root) => {
    let latest = 0;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = /** @type {any} */ (stack.pop());
      const id = String(node.id);
      if (seen.has(id)) continue;
      seen.add(id);
      latest = Math.max(latest, timestampMs(resolveTodoLastActivityAt(node)));
      stack.push(...(groups.get(id) || []));
    }
    return latest;
  };
  const keyed = roots.map((root, position) => {
    const row = /** @type {any} */ (root);
    const created = timestampMs(row.createdAt);
    const activity = mode === 'created' ? 0 : subtreeActivity(root);
    let rank = 0;
    if (mode === 'active') {
      const live = typeof liveRank === 'function' ? Number(liveRank(root)) : -1;
      rank = live === 0 || live === 1 ? live : ACTIVE_STATUS_RANK[normalizeTodoItemStatus(row.status)];
    }
    return { root, position, created, activity, rank };
  });
  keyed.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (mode === 'created') {
      if (a.created !== b.created) return b.created - a.created;
    } else if (a.activity !== b.activity) {
      return b.activity - a.activity;
    }
    return a.position - b.position;
  });
  return keyed.map((entry) => entry.root);
}

/**
 * Depth-first rows. Collapsed ids hide descendants but stay in the list.
 * A missing parent is treated as a root so the row is still visible.
 *
 * @param {object[] | null | undefined} items
 * @param {Iterable<string> | null | undefined} collapsedIds
 * @param {{ sort?: string, liveRank?: (root: object) => number }} [options]
 * @returns {{ item: object, level: number, parentId: string, hasChildren: boolean, collapsed: boolean }[]}
 */
export function flattenTodoTree(items, collapsedIds, options = {}) {
  const collapsed = new Set();
  if (collapsedIds) {
    for (const id of collapsedIds) {
      const key = String(id || '').trim();
      if (key) collapsed.add(key);
    }
  }
  const groups = siblingGroups(items);
  const sortMode = parseTodoSortMode(options?.sort);
  if (sortMode !== 'manual') {
    groups.set('', sortTodoRoots(groups.get('') || [], groups, sortMode, options?.liveRank));
  }
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
 * Splits depth-first rows into the main tree and the "Deferred" section. A
 * deferred root and its whole subtree belong to the section; a deferred item
 * nested under an active parent stays in the main tree.
 *
 * @template {{ level: number, item: object }} R
 * @param {R[] | null | undefined} rows Output of flattenTodoTree.
 * @returns {{ main: R[], deferred: R[], deferredRoots: number }}
 */
export function splitDeferredTodoRows(rows) {
  /** @type {R[]} */
  const main = [];
  /** @type {R[]} */
  const deferred = [];
  let deferredRoots = 0;
  let inSection = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.level === 0) {
      inSection = normalizeTodoItemStatus(/** @type {{ status?: string } | undefined} */ (row.item)?.status) === 'deferred';
      if (inSection) deferredRoots += 1;
    }
    (inSection ? deferred : main).push(row);
  }
  return { main, deferred, deferredRoots };
}

/**
 * A deferred todo whose `deferredUntil` date has passed.
 *
 * @param {unknown} item
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isTodoDeferredOverdue(item, nowMs = Date.now()) {
  const row = item && typeof item === 'object' ? /** @type {Record<string, any>} */ (item) : {};
  if (normalizeTodoItemStatus(row.status) !== 'deferred') return false;
  const until = Date.parse(String(row.deferredUntil || ''));
  return Number.isFinite(until) && until < nowMs;
}

/**
 * Open work excludes finished and deferred todos.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTodoOpenStatus(status) {
  const value = normalizeTodoItemStatus(status);
  return value !== 'done' && value !== 'deferred';
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
  // Lean list rows carry a count instead of chat records.
  const lean = /** @type {any} */ (item);
  if (lean?.listSlim === true && typeof lean.chatCount === 'number') return lean.chatCount;
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
  const lean = /** @type {any} */ (item);
  if (lean?.listSlim === true && !Array.isArray(lean.chats)) {
    return String(lean.chatLastAt || '').trim() || String(lean.updatedAt || '').trim();
  }
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
 * Free-text list search over title and id. Matches keep their ancestors so a
 * hit stays reachable in the tree.
 *
 * @param {object[]} items
 * @param {string} query
 * @returns {object[]}
 */
export function filterTodoItemsBySearch(items, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items;
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const included = new Set();
  for (const item of items) {
    const haystack = `${item.title || ''} ${item.id || ''}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    let current = item;
    const seen = new Set();
    while (current && !seen.has(String(current.id))) {
      const id = String(current.id);
      included.add(id);
      seen.add(id);
      current = byId.get(String(current.parentId || ''));
    }
  }
  return items.filter((item) => included.has(String(item.id)));
}

/**
 * Per-list cache for row marks. A list renders every row against the same
 * `items` array, and each lookup used to rescan the whole list (quadratic: ~1.6 s
 * for 570 tasks). The array identity is the key, and a snapshot of exactly the
 * fields the mark depends on guards against in-place edits (tests and optimistic
 * UI code mutate items), so a stale answer is never served.
 *
 * @type {WeakMap<object[], {
 *   list: object[],
 *   snapshot: unknown[][],
 *   index: Map<string, object>,
 *   readyIds: Set<string>,
 *   blocked: Map<string, boolean>,
 * }>}
 */
const rowContextCache = new WeakMap();

/**
 * Fields read by `isTodoBranchBlocked` / `listReadyTodoLeaves`, by reference so
 * comparing an unchanged (possibly very long) plan string is O(1).
 *
 * @param {object} item
 * @returns {unknown[]}
 */
function snapshotRowFields(item) {
  return [
    item,
    item?.id,
    item?.parentId,
    item?.status,
    item?.blockedReason,
    item?.siblingIndex,
    item?.runMode,
    item?.plan?.markdown,
    item?.plan?.approvedAt,
    item?.integration?.state,
  ];
}

/**
 * @param {unknown[][]} snapshot
 * @param {object[]} list
 * @returns {boolean}
 */
function isSnapshotCurrent(snapshot, list) {
  if (snapshot.length !== list.length) return false;
  for (let row = 0; row < list.length; row += 1) {
    const saved = snapshot[row];
    const item = list[row];
    if (saved[0] !== item) return false;
    if (saved[1] !== item?.id || saved[2] !== item?.parentId || saved[3] !== item?.status
      || saved[4] !== item?.blockedReason || saved[5] !== item?.siblingIndex
      || saved[6] !== item?.runMode || saved[7] !== item?.plan?.markdown
      || saved[8] !== item?.plan?.approvedAt || saved[9] !== item?.integration?.state) {
      return false;
    }
  }
  return true;
}

/**
 * @param {object[] | null | undefined} items
 */
function readTodoRowContext(items) {
  const list = Array.isArray(items) ? items : [];
  let context = rowContextCache.get(list);
  if (!context || !isSnapshotCurrent(context.snapshot, list)) {
    context = {
      list,
      snapshot: list.map(snapshotRowFields),
      index: buildTodoIndex(list),
      readyIds: new Set(listReadyTodoLeaves(list).map((row) => String(row.id))),
      blocked: new Map(),
    };
    rowContextCache.set(list, context);
  }
  return context;
}

/**
 * @param {ReturnType<typeof readTodoRowContext>} context
 * @param {object} item
 * @returns {boolean}
 */
function isRowBranchBlocked(context, item) {
  const id = String(item.id);
  let blocked = context.blocked.get(id);
  if (blocked === undefined) {
    blocked = isTodoBranchBlocked(context.list, item, context.index);
    context.blocked.set(id, blocked);
  }
  return blocked;
}

/**
 * @param {object[] | null | undefined} items
 * @param {object | null | undefined} item
 * @returns {'blocked' | 'ready' | ''}
 */
export function readTodoRowMark(items, item) {
  if (!item?.id) return '';
  const context = readTodoRowContext(items);
  if (isRowBranchBlocked(context, item)) return 'blocked';
  return context.readyIds.has(String(item.id)) ? 'ready' : '';
}

/**
 * Classify a blocked row as requiring an operator action or waiting on its tree.
 * A blocker stored directly on the todo is actionable; inherited tree gates are dependencies.
 *
 * @param {object[] | null | undefined} items
 * @param {object | null | undefined} item
 * @returns {'action' | 'dependency' | ''}
 */
export function readTodoRowBlockKind(items, item) {
  if (!item?.id) return '';
  if (String(item.blockedReason || '').trim()) return 'action';
  return isRowBranchBlocked(readTodoRowContext(items), item) ? 'dependency' : '';
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
