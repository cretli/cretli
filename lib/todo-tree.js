/**
 * Shared tree helpers for TODO items (parentId + siblingIndex groups).
 * Pure functions over the plain items array — no persistence involved.
 */

import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { isTodoBlockedByParallelSiblingScope } from './todo-parallel-scope.js';

/** Maximum node count on any root..leaf chain. */
export const TODO_MAX_DEPTH = 6;

/**
 * @param {Record<string, any>[] | null | undefined} items
 * @returns {Map<string, Record<string, any>>}
 */
export function buildTodoIndex(items) {
  const byId = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (item?.id && !byId.has(String(item.id))) byId.set(String(item.id), item);
  });
  return byId;
}

/**
 * @param {Record<string, any> | null | undefined} item
 * @returns {string}
 */
export function readTodoParentId(item) {
  if (!item || typeof item.parentId !== 'string') return '';
  return item.parentId.trim();
}

/**
 * @param {Record<string, any>[] | null | undefined} items
 * @returns {Map<string, { item: Record<string, any>, position: number }[]>}
 */
function groupByParentKey(items) {
  /** @type {Map<string, { item: Record<string, any>, position: number }[]>} */
  const groups = new Map();
  (Array.isArray(items) ? items : []).forEach((item, position) => {
    if (!item?.id) return;
    const key = readTodoParentId(item) || '';
    const list = groups.get(key) || [];
    list.push({ item, position });
    groups.set(key, list);
  });
  return groups;
}

/**
 * Walks ancestors of `parentId`. True when `todoId` appears in that chain
 * (modelled on wouldCreateChatParentCycle from chat-tree.js).
 *
 * @param {Record<string, any>[]} items
 * @param {string} todoId
 * @param {string} parentId
 * @param {Map<string, Record<string, any>>} [index] prebuilt `buildTodoIndex(items)`
 *   for callers that check many rows (avoids an O(n) rebuild per call)
 * @returns {boolean}
 */
export function wouldCreateTodoParentCycle(items, todoId, parentId, index) {
  const id = String(todoId || '').trim();
  const startParent = String(parentId || '').trim();
  if (!id || !startParent) return false;
  if (id === startParent) return true;
  const byId = index || buildTodoIndex(items);
  let current = byId.get(startParent);
  const visited = new Set();
  while (current?.id) {
    if (current.id === id) return true;
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const nextId = readTodoParentId(current);
    if (!nextId) break;
    current = byId.get(nextId);
  }
  return false;
}

/**
 * Depth of a node counting itself (root = 1). Unknown id = 0.
 * Cycle-safe: a broken chain counts only until the first revisit.
 *
 * @param {Record<string, any>[]} items
 * @param {string} id
 * @returns {number}
 */
export function todoNodeDepth(items, id) {
  const byId = buildTodoIndex(items);
  let current = byId.get(String(id || '').trim());
  if (!current) return 0;
  const visited = new Set([current.id]);
  let depth = 1;
  for (;;) {
    const parentId = readTodoParentId(current);
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * Height of the subtree rooted at `id` (single node = 1). Cycle-safe.
 *
 * @param {Record<string, any>[]} items
 * @param {string} id
 * @returns {number}
 */
export function todoSubtreeHeight(items, id) {
  const rootId = String(id || '').trim();
  if (!rootId || !buildTodoIndex(items).has(rootId)) return 0;
  const groups = groupByParentKey(items);
  let tallest = 0;
  const walk = (/** @type {any} */ nodeId, /** @type {any} */ level, /** @type {any} */ seen) => {
    tallest = Math.max(tallest, level);
    for (const { item } of groups.get(nodeId) || []) {
      const childId = String(item.id);
      if (seen.has(childId)) continue;
      seen.add(childId);
      walk(childId, level + 1, seen);
    }
  };
  walk(rootId, 1, new Set([rootId]));
  return tallest;
}

/**
 * All item ids in the subtree rooted at `rootId` (inclusive), BFS order.
 *
 * @param {Record<string, any>[]} items
 * @param {string} rootId
 * @returns {string[]}
 */
export function collectTodoSubtreeIds(items, rootId) {
  const root = String(rootId || '').trim();
  if (!root || !buildTodoIndex(items).has(root)) return [];
  const groups = groupByParentKey(items);
  const out = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    const id = queue.shift();
    out.push(id);
    for (const { item } of groups.get(/** @type {string} */ (id)) || []) {
      const childId = String(item.id);
      if (seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return /** @type {any} */ (out);
}

/**
 * Ancestor ids of `id`, nearest parent first. Cycle-safe and tolerant of a
 * parent that is missing from the list (returns what it could walk).
 *
 * @param {Record<string, any>[] | null | undefined} items
 * @param {string} id
 * @returns {string[]}
 */
export function collectTodoAncestorIds(items, id) {
  const index = buildTodoIndex(items);
  const start = String(id || '').trim();
  if (!start || !index.has(start)) return [];
  const out = [];
  const seen = new Set([start]);
  let parent = readTodoParentId(index.get(start));
  while (parent && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    const row = index.get(parent);
    if (!row) break;
    parent = readTodoParentId(row);
  }
  return /** @type {any} */ (out);
}

/**
 * Id of the top-most ancestor of `id` (the tree root), or `id` itself when it
 * has no parent. Returns '' for an unknown id.
 *
 * @param {Record<string, any>[] | null | undefined} items
 * @param {string} id
 * @returns {string}
 */
export function resolveTodoRootId(items, id) {
  const index = buildTodoIndex(items);
  const start = String(id || '').trim();
  if (!start || !index.has(start)) return '';
  let current = start;
  const seen = new Set([start]);
  let parent = readTodoParentId(index.get(current));
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    current = parent;
    const row = index.get(current);
    if (!row) break;
    parent = readTodoParentId(row);
  }
  return current;
}

/**
 * Renumber siblingIndex 0..n-1 inside every sibling group (roots and each
 * parent's children). Group members sort by current siblingIndex (missing
 * counts as last), ties keep array order. The global array order is left
 * untouched — consumers that need group order must sort by siblingIndex.
 * Mutates items in place and returns them.
 *
 * @param {Record<string, any>[]} items
 * @returns {Record<string, any>[]}
 */
export function renumberTodoSiblings(items) {
  for (const entries of groupByParentKey(items).values()) {
    entries.sort((a, b) => {
      const ai = Number.isInteger(a.item.siblingIndex) ? a.item.siblingIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.item.siblingIndex) ? b.item.siblingIndex : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.position - b.position;
    });
    entries.forEach((entry, index) => {
      entry.item.siblingIndex = index;
    });
  }
  return items;
}

/**
 * Container status follows its children, bottom-up at every depth (all done -> done;
 * only done+deferred with >=1 deferred -> deferred). A parent with an open `idea`
 * child (even `nonBlocking`) is never done: it stays ready/idea. Leaves are
 * never changed. Reopening a descendant also reopens completed ancestors.
 * `onChange` lets persistence advance only the affected parents' CAS tokens.
 */
export function synchronizeTodoParentStatuses(/** @type {any} */ items, onChange = /** @type {(item: any, before: string) => void} */ (() => {})) {
  const groups = groupByParentKey(items);
  const visited = new Set();
  const visiting = new Set();
  const visit = (/** @type {any} */ item) => {
    if (visited.has(item.id) || visiting.has(item.id)) return;
    visiting.add(item.id);
    const children = (groups.get(String(item.id)) || []).map((entry) => entry.item);
    children.forEach(visit);
    if (children.length) {
      const before = item.status;
      if (children.every((child) => child.status === 'done')) item.status = 'done';
      else if (children.every((child) => child.status === 'done' || child.status === 'deferred')) item.status = 'deferred';
      else if (children.some((child) => ['doing', 'done'].includes(child.status)) || before === 'doing') item.status = 'doing';
      else if (children.some((child) => child.status === 'ready') || ['ready', 'done'].includes(before)) item.status = 'ready';
      else item.status = 'idea';
      if (before !== item.status) onChange(item, before);
    }
    visiting.delete(item.id);
    visited.add(item.id);
  };
  (Array.isArray(items) ? items : []).forEach(visit);
  return items;
}

/**
 * True when this node or any ancestor already has a human-approved plan.
 * Approval on the top parent covers the whole subtree.
 *
 * @param {Record<string, any> | null | undefined} item
 * @param {Map<string, Record<string, any>>} index
 * @returns {boolean}
 */
function hasApprovedPlanOnNodeOrAncestor(item, index) {
  const seen = new Set();
  let current = item || null;
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    if (String(current.plan?.approvedAt || '').trim()) return true;
    current = index.get(readTodoParentId(current)) || null;
  }
  return false;
}

/**
 * The nearest strict ancestor whose plan a human approved, or null. Prompts and
 * `todo_show` use it so an agent sees the same plan gate as the tree: approval
 * on an ancestor (up to the root) opens the gate for a node without its own
 * approved plan.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any> | null | undefined} item
 * @returns {{ id: string, title: string, approvedAt: string } | null}
 */
export function findApprovedPlanAncestor(items, item) {
  const index = buildTodoIndex(items);
  const seen = new Set([String(item?.id || '')]);
  let current = index.get(readTodoParentId(item)) || null;
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    const approvedAt = String(current.plan?.approvedAt || '').trim();
    if (approvedAt) {
      return { id: String(current.id), title: String(current.title || ''), approvedAt };
    }
    current = index.get(readTodoParentId(current)) || null;
  }
  return null;
}

/**
 * Computed readiness (not stored). A node is blocked when its parent has a
 * plan that is not approved yet and no ancestor plan is approved, or when the
 * parent runs sequentially and an earlier sibling (lower siblingIndex) is not
 * done (deferred nodes, and `idea` nodes with `nonBlocking`, are skipped). A parent without any plan is a plain grouping node and does not block.
 * Approving the top parent unlocks every descendant plan gate.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} [index]
 * @returns {boolean}
 */
export function isTodoNodeBlocked(items, item, index = buildTodoIndex(items)) {
  if (String(item?.blockedReason || '').trim()) return true;
  if (!item) return false;
  const parentId = readTodoParentId(item);
  if (!parentId) return false;
  const parent = index.get(parentId);
  if (!parent) return false;
  const parentHasPlan = Boolean(String(parent.plan?.markdown || '').trim());
  if (parentHasPlan && !hasApprovedPlanOnNodeOrAncestor(parent, index)) return true;
  if (parent.runMode !== 'parallel') {
    const ownIndex = Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0;
    return (Array.isArray(items) ? items : []).some((row) => {
      if (!row?.id || row.id === item.id) return false;
      if (readTodoParentId(row) !== parentId) return false;
      const rowIndex = Number.isInteger(row.siblingIndex) ? row.siblingIndex : 0;
      if (rowIndex >= ownIndex) return false;
      // Legacy rows can claim done even though a deeper descendant is open.
      // Deferred work is skipped, so it does not hold back later siblings.
      // An `idea` node that opted in with nonBlocking is skipped the same way.
      return collectTodoSubtreeIds(items, row.id).some((id) => {
        const node = index.get(id);
        const status = node?.status;
        if (status === 'idea' && node?.nonBlocking === true) return false;
        return status !== 'done' && status !== 'deferred';
      });
    });
  }
  if (isTodoBlockedByParallelSiblingScope(items, item, index)) return true;
  return false;
}

/**
 * True when the node or any of its ancestors is blocked. A child of a node
 * that waits for an earlier sibling must wait too.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} [index]
 * @returns {boolean}
 */
export function isTodoBranchBlocked(items, item, index) {
  const memo = index ? null : readBlockedMemo(items, item);
  if (memo) return memo.branch(item);
  return walkBranchBlocked(items, item, index || buildTodoIndex(items));
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} index
 * @param {(item: Record<string, any>) => boolean} [nodeBlocked]
 * @returns {boolean}
 */
function walkBranchBlocked(items, item, index, nodeBlocked = (node) => isTodoNodeBlocked(items, node, index)) {
  const visited = new Set();
  let current = item;
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    if (nodeBlocked(current)) return true;
    current = index.get(readTodoParentId(current));
  }
  return false;
}

/**
 * Fields that `isTodoNodeBlocked` (and the parallel scope check) read from a row. A memo is only reused
 * while every row still shows these values, so an in-place edit of the array invalidates it.
 */
function blockedSignature(item) {
  const plan = item?.plan;
  return [
    item, item?.id, item?.parentId, item?.status, item?.siblingIndex, item?.runMode, item?.nonBlocking,
    item?.blockedReason, item?.body, plan?.markdown, plan?.approvedAt,
  ];
}

/** Parallel scope checks look at which files exist, so a memo never outlives this window. */
const BLOCKED_MEMO_TTL_MS = 2000;

/** @type {WeakMap<object, { at: number, sigs: any[][], index: Map<string, Record<string, any>>, nodes: Map<string, boolean>, branches: Map<string, boolean>, branch: (item: Record<string, any>) => boolean }>} */
const blockedMemos = new WeakMap();

/** Counters for tests: memo builds and reuses. */
export const todoBlockedMemoStats = { builds: 0, hits: 0 };

/**
 * Per-array memo of the id index and of node/branch blocked results. Valid for the same array while its rows
 * keep the same blocking-relevant fields; rebuilt otherwise. Returns null when `item` is not a row of `items`.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 */
function readBlockedMemo(items, item) {
  if (!Array.isArray(items) || !item?.id) return null;
  let memo = blockedMemos.get(items);
  if (memo && Date.now() - memo.at <= BLOCKED_MEMO_TTL_MS && memo.sigs.length === items.length
    && items.every((row, i) => {
      const sig = memo.sigs[i];
      const now = blockedSignature(row);
      for (let k = 0; k < now.length; k += 1) if (sig[k] !== now[k]) return false;
      return true;
    })) {
    todoBlockedMemoStats.hits += 1;
  } else {
    const index = buildTodoIndex(items);
    const nodes = new Map();
    const branches = new Map();
    const nodeBlocked = (/** @type {Record<string, any>} */ node) => {
      const id = String(node.id);
      let value = nodes.get(id);
      if (value === undefined) {
        value = isTodoNodeBlocked(items, node, index);
        nodes.set(id, value);
      }
      return value;
    };
    memo = {
      at: Date.now(),
      sigs: items.map(blockedSignature),
      index,
      nodes,
      branches,
      branch: (node) => {
        const id = String(node.id);
        let value = branches.get(id);
        if (value === undefined) {
          value = walkBranchBlocked(items, node, index, nodeBlocked);
          branches.set(id, value);
        }
        return value;
      },
    };
    blockedMemos.set(items, memo);
    todoBlockedMemoStats.builds += 1;
  }
  // Duplicate ids resolve to the first row in the index; stay on the plain path for any other object.
  return memo.index.get(String(item.id)) === item ? memo : null;
}

/**
 * Ready leaves: nodes without children that are not done, not doing, and
 * not blocked (including by an ancestor). Optional rootId limits the result
 * to one subtree; blocking is still evaluated against the full list.
 *
 * @param {Record<string, any>[]} items
 * @param {{ rootId?: string }} [options]
 * @returns {Record<string, any>[]}
 */
export function listReadyTodoLeaves(items, options = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  const probe = items.find((row) => row?.id);
  const memo = probe ? readBlockedMemo(items, probe) : null;
  const index = memo ? memo.index : buildTodoIndex(items);
  let scope = items;
  const rootId = String(options?.rootId || '').trim();
  if (rootId) {
    if (!index.has(rootId)) return [];
    const subtree = new Set(collectTodoSubtreeIds(items, rootId));
    scope = items.filter((row) => subtree.has(String(row.id)));
  }
  const parents = new Set();
  scope.forEach((row) => {
    const parentId = readTodoParentId(row);
    if (parentId && index.get(parentId)) parents.add(parentId);
  });
  return scope.filter((row) => {
    if (!row?.id) return false;
    if (parents.has(String(row.id))) return false;
    if (row.status !== 'ready') return false;
    // Integration-ready leaves keep `doing`, but the explicit gate also covers
    // a row whose status was forced back to `ready` (contract §8.4).
    if (isTodoAwaitingIntegration(row)) return false;
    return memo && index.get(String(row.id)) === row
      ? !memo.branch(row)
      : !walkBranchBlocked(items, row, index);
  });
}

/** Title of the workspace-wide parking root that holds deferred leaves moved out of their trees. */
export const TODO_LATER_ROOT_TITLE = 'Na później';

/**
 * Finds the workspace "later" root: a parentless todo with the reserved title.
 *
 * @param {Record<string, any>[]} items
 * @returns {Record<string, any> | null}
 */
export function findTodoLaterRoot(items) {
  const wanted = TODO_LATER_ROOT_TITLE.toLocaleLowerCase();
  return (Array.isArray(items) ? items : []).find((row) => row
    && !readTodoParentId(row)
    && String(row.title || '').trim().toLocaleLowerCase() === wanted) || null;
}

/**
 * Decides what "move to later" does for a deferred leaf (input state -> decision).
 *
 * `target` is a root id to park the leaf under, or empty for the shared
 * "Na później" root (reused when present, otherwise `createRoot` is true).
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item the (already deferred) leaf
 * @param {string} [target]
 * @returns {{ action: 'move', targetId: string, createRoot: boolean, fromParentId: string }
 *   | { action: 'skip', reason: string }}
 */
export function decideDeferredMove(items, item, target = '') {
  if (!item || item.status !== 'deferred') return { action: 'skip', reason: 'not_deferred' };
  const fromParentId = readTodoParentId(item);
  if (!fromParentId) return { action: 'skip', reason: 'is_root' };
  if ((items || []).some((row) => readTodoParentId(row) === String(item.id))) {
    return { action: 'skip', reason: 'not_leaf' };
  }
  const later = findTodoLaterRoot(items);
  if (later && String(later.id) === fromParentId) return { action: 'skip', reason: 'already_in_later' };
  const wanted = String(target || '').trim();
  if (!wanted) {
    return { action: 'move', targetId: later ? String(later.id) : '', createRoot: !later, fromParentId };
  }
  const dest = buildTodoIndex(items).get(wanted);
  if (!dest) return { action: 'skip', reason: 'target_missing' };
  if (readTodoParentId(dest)) return { action: 'skip', reason: 'target_not_root' };
  if (wanted === fromParentId) return { action: 'skip', reason: 'same_parent' };
  return { action: 'move', targetId: wanted, createRoot: false, fromParentId };
}

/**
 * Decides whether a parked leaf can return to its old tree. The old parent is
 * kept in `sourceTodoId` by the move; it must still exist.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @returns {{ action: 'restore', parentId: string } | { action: 'skip', reason: string }}
 */
export function decideRestoreToTree(items, item) {
  if (!item) return { action: 'skip', reason: 'missing' };
  const origin = String(item.sourceTodoId || '').trim();
  if (!origin) return { action: 'skip', reason: 'no_origin' };
  const parentId = readTodoParentId(item);
  if (!parentId) return { action: 'skip', reason: 'is_root' };
  if (parentId === origin) return { action: 'skip', reason: 'already_there' };
  if (!buildTodoIndex(items).has(origin)) return { action: 'skip', reason: 'origin_missing' };
  if (collectTodoSubtreeIds(items, String(item.id)).includes(origin)) return { action: 'skip', reason: 'origin_in_subtree' };
  return { action: 'restore', parentId: origin };
}
