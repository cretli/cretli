/**
 * Shared tree helpers for TODO items (parentId + siblingIndex groups).
 * Pure functions over the plain items array — no persistence involved.
 */

import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { isTodoBlockedByParallelSiblingScope } from './todo-parallel-scope.js';
import { isFeedbackDerivedTodo, isFeedbackRoot } from './feedback-marker.js';
import { isTodoWaitingForPlan } from './todo-plan-gate.js';

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

/** Build parent-to-child groups alongside the id index for batch computations. */
export function buildTodoChildrenIndex(items) {
  todoChildrenIndexStats.builds += 1;
  const children = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item?.id) return;
    const parentId = readTodoParentId(item);
    if (!parentId) return;
    const rows = children.get(parentId) || [];
    rows.push(item);
    children.set(parentId, rows);
  });
  return children;
}

export const todoChildrenIndexStats = { builds: 0 };

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
 * Leaf ids strictly below `rootId` in tree order (depth-first, siblings by
 * `siblingIndex`, then list position) — the order a sequential tree runs in.
 * The root itself is never returned, so a leaf root yields `[]`. Cycle-safe.
 *
 * @param {Record<string, any>[] | null | undefined} items
 * @param {string} rootId
 * @returns {string[]}
 */
export function collectTodoSubtreeLeafIds(items, rootId) {
  const root = String(rootId || '').trim();
  if (!root || !buildTodoIndex(items).has(root)) return [];
  const groups = groupByParentKey(items);
  /** @type {string[]} */
  const out = [];
  const seen = new Set([root]);
  const walk = (/** @type {string} */ nodeId) => {
    const children = (groups.get(nodeId) || []).slice().sort((a, b) => {
      const ai = Number.isInteger(a.item.siblingIndex) ? a.item.siblingIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.item.siblingIndex) ? b.item.siblingIndex : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.position - b.position;
    });
    for (const { item } of children) {
      const childId = String(item.id);
      if (seen.has(childId)) continue;
      seen.add(childId);
      if ((groups.get(childId) || []).length) walk(childId);
      else out.push(childId);
    }
  };
  walk(root);
  return out;
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
  if (isFeedbackDerivedTodo(index, item)) {
    return !!String(item?.plan?.approvedAt || '').trim();
  }
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
 * Read-only execution state; the persisted status remains unchanged. A stored
 * `ready` leaf that the Watcher's plan gate would hold for a human is reported
 * as `waiting_plan`. The gate depends on the watcher policy, so without one
 * (`policy` missing) the stored status is returned and nothing is claimed.
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Record<string, any> | null | undefined} [policy] workspace watcher policy
 */
export function readTodoExecutionState(items, item, policy = undefined) {
  if (isTodoWaitingForPlan(items, item, policy)) return 'waiting_plan';
  return String(item?.status || 'idea');
}

/**
 * True when the node's inherited block is the plan gate itself: its parent has a
 * saved plan that no human approved on the parent or an ancestor, and no stored
 * `blockedReason` overrides it. Sequential-sibling and dependency blocks are false.
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} [index]
 */
export function isTodoBlockedByPlanGate(items, item, index = buildTodoIndex(items)) {
  // A branch inherits blocks from every ancestor (isTodoBranchBlocked), so walk the whole chain: the row
  // reads "waiting for plan" when some ancestor holds an unapproved draft and nothing else blocks the branch.
  let gated = false;
  const visited = new Set();
  let current = item;
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    if (String(current.blockedReason || '').trim()) return false;
    const parent = index.get(readTodoParentId(current));
    const planGate = Boolean(parent && String(parent.plan?.markdown || '').trim())
      && !hasApprovedPlanOnNodeOrAncestor(parent, index);
    if (planGate) gated = true;
    else if (isTodoNodeBlocked(items, current, index)) return false;
    current = parent;
  }
  return gated;
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
  if (isFeedbackDerivedTodo(items, item)) return null;
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
 * The MCP reports root is only a backlog: its reports never wait for each other.
 * Approving the top parent unlocks every descendant plan gate.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} [index]
 * @param {Map<string, Record<string, any>[]>} [childrenIndex]
 * @param {Map<string, boolean>} [openSubtreeMemo]
 * @param {Map<string, { min: { id: string, index: number } | null, second: { id: string, index: number } | null }>} [siblingOpenIndex]
 * @returns {boolean}
 */
export function isTodoNodeBlocked(items, item, index = undefined, childrenIndex = undefined, openSubtreeMemo = undefined, siblingOpenIndex = undefined) {
  if (String(item?.blockedReason || '').trim()) return true;
  if (!item) return false;
  const byId = index || buildTodoIndex(items);
  const parentId = readTodoParentId(item);
  if (!parentId) return false;
  const parent = byId.get(parentId);
  if (!parent) return false;
  const parentHasPlan = Boolean(String(parent.plan?.markdown || '').trim());
  if (parentHasPlan && !hasApprovedPlanOnNodeOrAncestor(parent, byId)) return true;
  if (isFeedbackRoot(parent)) return false;
  if (parent.runMode !== 'parallel') {
    const byParent = childrenIndex || buildTodoChildrenIndex(items);
    const siblings = byParent.get(parentId) || [];
    const ownIndex = Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0;
    const openIndexes = getSiblingOpenIndex(parentId, siblings, byParent, byId, openSubtreeMemo, siblingOpenIndex);
    const id = String(item.id);
    return Boolean((openIndexes.min && openIndexes.min.id !== id && openIndexes.min.index < ownIndex)
      || (openIndexes.min?.id === id && openIndexes.second && openIndexes.second.index < ownIndex));
  }
  if (isTodoBlockedByParallelSiblingScope(items, item, byId)) return true;
  return false;
}

function hasOpenTodoDescendant(row, childrenIndex, index, memo) {
  const rootId = String(row?.id || '');
  if (memo?.has(rootId)) return memo.get(rootId);
  const queue = [row];
  const seen = new Set();
  const result = new Map();
  const order = [];
  let truncated = false;
  while (queue.length) {
    const current = queue.pop();
    if (!current?.id) continue;
    const id = String(current.id);
    if (seen.has(id)) { truncated = true; continue; }
    seen.add(id);
    order.push(id);
    queue.push(...(childrenIndex.get(String(current.id)) || []));
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    const node = index.get(id);
    const status = node?.status;
    const ownOpen = !(status === 'idea' && node?.nonBlocking === true)
      && status !== 'done' && status !== 'deferred';
    const hasOpen = ownOpen || (childrenIndex.get(id) || []).some((child) => result.get(String(child.id)) === true);
    result.set(id, hasOpen);
  }
  if (memo && !truncated) for (const [id, value] of result) memo.set(id, value);
  return result.get(rootId) === true;
}

function buildSiblingOpenIndex(parentId, siblings, childrenIndex, index, openSubtreeMemo) {
  let min = null;
  let second = null;
  for (const row of siblings) {
    if (!row?.id || !hasOpenTodoDescendant(row, childrenIndex, index, openSubtreeMemo)) continue;
    const entry = { id: String(row.id), index: Number.isInteger(row.siblingIndex) ? row.siblingIndex : 0 };
    if (!min || entry.index < min.index) {
      if (min && min.id !== entry.id && (!second || min.index < second.index)) second = min;
      min = entry;
    } else if (entry.id !== min.id && (!second || entry.index < second.index)) {
      second = entry;
    }
  }
  return { min, second };
}

function getSiblingOpenIndex(parentId, siblings, childrenIndex, index, openSubtreeMemo, siblingOpenIndex) {
  if (siblingOpenIndex?.has(parentId)) return siblingOpenIndex.get(parentId);
  const result = buildSiblingOpenIndex(parentId, siblings, childrenIndex, index, openSubtreeMemo);
  siblingOpenIndex?.set(parentId, result);
  return result;
}

/**
 * True when the node or any of its ancestors is blocked. A child of a node
 * that waits for an earlier sibling must wait too.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} [index]
 * @param {Map<string, Record<string, any>[]>} [childrenIndex]
 * @returns {boolean}
 */
export function isTodoBranchBlocked(items, item, index = undefined, childrenIndex = undefined) {
  const memo = index ? null : readBlockedMemo(items, item);
  if (memo) return memo.branch(item);
  const byId = index || buildTodoIndex(items);
  return walkBranchBlocked(items, item, byId, undefined, childrenIndex);
}

/**
 * Batch form of `isTodoBranchBlocked`. Returns rows (of `candidates`, default all) whose branch is blocked.
 *
 * @param {Record<string, any>[]} items
 * @param {(item: Record<string, any>) => boolean} [accept] row filter applied before the blocked check
 * @returns {Record<string, any>[]}
 */
export function filterBlockedTodoBranches(items, accept = () => true) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const childrenIndex = buildTodoChildrenIndex(list);
  const index = buildTodoIndex(list);
  const openSubtreeMemo = new Map();
  const siblingOpenIndex = new Map();
  const blocked = computeBlockedBranches(list, index, childrenIndex, openSubtreeMemo, siblingOpenIndex);
  const resultByRow = new Map(list.map((row) => [row, blocked.get(String(row?.id || '')) === true]));
  for (const row of list) {
    if (!accept(row)) continue;
    const id = String(row?.id || '');
    const isIndexedRow = row?.id && index.get(id) === row;
    if (isIndexedRow ? resultByRow.get(row) : walkBranchBlocked(list, row, index, undefined, childrenIndex)) out.push(row);
  }
  return out;
}

function computeBlockedBranches(items, index, childrenIndex, openSubtreeMemo = new Map(), siblingOpenIndex = new Map()) {
  const nodeBlocked = new Map();
  for (const item of items) {
    if (!item?.id || index.get(String(item.id)) !== item) continue;
    const id = String(item.id);
    nodeBlocked.set(id, isTodoNodeBlocked(items, item, index, childrenIndex, openSubtreeMemo, siblingOpenIndex));
  }
  const branches = new Map();
  const visit = (item, visiting = new Set()) => {
    const id = String(item?.id || '');
    if (!id || index.get(id) !== item) return false;
    if (branches.has(id)) return branches.get(id);
    if (visiting.has(id)) return nodeBlocked.get(id) === true;
    visiting.add(id);
    const parentId = readTodoParentId(item);
    const parent = index.get(parentId);
    const value = nodeBlocked.get(id) === true || (parent ? visit(parent, visiting) : false);
    visiting.delete(id);
    branches.set(id, value);
    return value;
  };
  for (const item of items) if (item?.id && index.get(String(item.id)) === item) visit(item);
  return branches;
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @param {Map<string, Record<string, any>>} index
 * @param {(item: Record<string, any>) => boolean} [nodeBlocked]
 * @param {Map<string, Record<string, any>[]>} [childrenIndex]
 * @returns {boolean}
 */
function walkBranchBlocked(items, item, index, nodeBlocked = undefined, childrenIndex = undefined) {
  const checkNode = nodeBlocked || ((node) => isTodoNodeBlocked(items, node, index, childrenIndex));
  const visited = new Set();
  let current = item;
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    if (checkNode(current)) return true;
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

/** Compares a stored signature with a row without allocating a fresh signature array per row. */
function signatureMatches(sig, item) {
  const plan = item?.plan;
  return sig[0] === item && sig[1] === item?.id && sig[2] === item?.parentId && sig[3] === item?.status
    && sig[4] === item?.siblingIndex && sig[5] === item?.runMode && sig[6] === item?.nonBlocking
    && sig[7] === item?.blockedReason && sig[8] === item?.body && sig[9] === plan?.markdown
    && sig[10] === plan?.approvedAt;
}

/** Parallel scope checks look at which files exist, so a memo never outlives this window. */
const BLOCKED_MEMO_TTL_MS = 2000;

/** @type {WeakMap<object, { at: number, sigs: any[][], index: Map<string, Record<string, any>>, childrenIndex: Map<string, Record<string, any>[]>, nodes: Map<string, boolean>, branches: Map<string, boolean>, openSubtrees: Map<string, boolean>, siblingOpenIndex: Map<string, { min: { id: string, index: number } | null, second: { id: string, index: number } | null }>, branch: (item: Record<string, any>) => boolean }>} */
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
    && items.every((row, i) => signatureMatches(memo.sigs[i], row))) {
    todoBlockedMemoStats.hits += 1;
  } else {
    const index = buildTodoIndex(items);
    const childrenIndex = buildTodoChildrenIndex(items);
    const nodes = new Map();
    const branches = new Map();
    const openSubtrees = new Map();
    const siblingOpenIndex = new Map();
    const nodeBlocked = (/** @type {Record<string, any>} */ node) => {
      const id = String(node.id);
      let value = nodes.get(id);
      if (value === undefined) {
        value = isTodoNodeBlocked(items, node, index, childrenIndex, openSubtrees, siblingOpenIndex);
        nodes.set(id, value);
      }
      return value;
    };
    memo = {
      at: Date.now(),
      sigs: items.map(blockedSignature),
      index,
      childrenIndex,
      nodes,
      branches,
      openSubtrees,
      siblingOpenIndex,
      branch: (node) => {
        const id = String(node.id);
        let value = branches.get(id);
        if (value === undefined) {
          value = walkBranchBlocked(items, node, index, nodeBlocked, childrenIndex);
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
    if (isFeedbackRoot(row)) return false;
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
