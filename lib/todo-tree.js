/**
 * Shared tree helpers for TODO items (parentId + siblingIndex groups).
 * Pure functions over the plain items array — no persistence involved.
 */

/** Maximum node count on any root..leaf chain. */
export const TODO_MAX_DEPTH = 6;

/**
 * @param {object[] | null | undefined} items
 * @returns {Map<string, object>}
 */
export function buildTodoIndex(items) {
  const byId = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (item?.id && !byId.has(String(item.id))) byId.set(String(item.id), item);
  });
  return byId;
}

/**
 * @param {object | null | undefined} item
 * @returns {string}
 */
export function readTodoParentId(item) {
  if (!item || typeof item.parentId !== 'string') return '';
  return item.parentId.trim();
}

/**
 * @param {object[] | null | undefined} items
 * @returns {Map<string, { item: object, position: number }[]>}
 */
function groupByParentKey(items) {
  /** @type {Map<string, { item: object, position: number }[]>} */
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
 * @param {object[]} items
 * @param {string} todoId
 * @param {string} parentId
 * @returns {boolean}
 */
export function wouldCreateTodoParentCycle(items, todoId, parentId) {
  const id = String(todoId || '').trim();
  const startParent = String(parentId || '').trim();
  if (!id || !startParent) return false;
  if (id === startParent) return true;
  const byId = buildTodoIndex(items);
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
 * @param {object[]} items
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
 * @param {object[]} items
 * @param {string} id
 * @returns {number}
 */
export function todoSubtreeHeight(items, id) {
  const rootId = String(id || '').trim();
  if (!rootId || !buildTodoIndex(items).has(rootId)) return 0;
  const groups = groupByParentKey(items);
  let tallest = 0;
  const walk = (nodeId, level, seen) => {
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
 * @param {object[]} items
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
    for (const { item } of groups.get(id) || []) {
      const childId = String(item.id);
      if (seen.has(childId)) continue;
      seen.add(childId);
      queue.push(childId);
    }
  }
  return out;
}

/**
 * Renumber siblingIndex 0..n-1 inside every sibling group (roots and each
 * parent's children). Group members sort by current siblingIndex (missing
 * counts as last), ties keep array order. The global array order is left
 * untouched — consumers that need group order must sort by siblingIndex.
 * Mutates items in place and returns them.
 *
 * @param {object[]} items
 * @returns {object[]}
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
 * Container status follows its children, bottom-up at every depth. Leaves are
 * never changed. Reopening a descendant also reopens completed ancestors.
 * `onChange` lets persistence advance only the affected parents' CAS tokens.
 */
export function synchronizeTodoParentStatuses(items, onChange = () => {}) {
  const groups = groupByParentKey(items);
  const visited = new Set();
  const visiting = new Set();
  const visit = (item) => {
    if (visited.has(item.id) || visiting.has(item.id)) return;
    visiting.add(item.id);
    const children = (groups.get(String(item.id)) || []).map((entry) => entry.item);
    children.forEach(visit);
    if (children.length) {
      const before = item.status;
      if (children.every((child) => child.status === 'done')) item.status = 'done';
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
 * @param {object | null | undefined} item
 * @param {Map<string, object>} index
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
 * Computed readiness (not stored). A node is blocked when its parent has a
 * plan that is not approved yet and no ancestor plan is approved, or when the
 * parent runs sequentially and an earlier sibling (lower siblingIndex) is not
 * done. A parent without any plan is a plain grouping node and does not block.
 * Approving the top parent unlocks every descendant plan gate.
 *
 * @param {object[]} items
 * @param {object} item
 * @param {Map<string, object>} [index]
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
      return collectTodoSubtreeIds(items, row.id).some((id) => index.get(id)?.status !== 'done');
    });
  }
  return false;
}

/**
 * True when the node or any of its ancestors is blocked. A child of a node
 * that waits for an earlier sibling must wait too.
 *
 * @param {object[]} items
 * @param {object} item
 * @param {Map<string, object>} [index]
 * @returns {boolean}
 */
export function isTodoBranchBlocked(items, item, index = buildTodoIndex(items)) {
  const visited = new Set();
  let current = item;
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    if (isTodoNodeBlocked(items, current, index)) return true;
    current = index.get(readTodoParentId(current));
  }
  return false;
}

/**
 * Ready leaves: nodes without children that are not done, not doing, and
 * not blocked (including by an ancestor). Optional rootId limits the result
 * to one subtree; blocking is still evaluated against the full list.
 *
 * @param {object[]} items
 * @param {{ rootId?: string }} [options]
 * @returns {object[]}
 */
export function listReadyTodoLeaves(items, options = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  const index = buildTodoIndex(items);
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
    return !isTodoBranchBlocked(items, row, index);
  });
}
