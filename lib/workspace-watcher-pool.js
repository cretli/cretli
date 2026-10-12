/**
 * Execution-pool helpers shared by the watcher decision and the cycle start.
 *
 * `maxParallelWorktree` and `maxParallelProject` bound the two execution
 * folders — worktree leaves and the logical project folder — separately from
 * the global `maxParallel` cap. Both the candidate pick (an agent outside the
 * watcher may already hold a pool slot) and a cycle start (this row's own live
 * cycles hold it) need the same three answers: which pool a todo belongs to,
 * what that pool's ceiling is, and how many of the row's cycles already sit in
 * it. The answers live here so no call site restates — and later drifts from —
 * the rule.
 *
 * Every function is pure over rows the caller already loaded; the module reads
 * no store on purpose. Its only dependency is `workspace-watcher-worktree.js`
 * (the execution-mode resolver), which imports none of the watcher modules, so
 * `workspace-watcher.js`, `workspace-watcher-cycle.js` and
 * `workspace-watcher-control.js` can all import this one without a cycle.
 */

import { resolveWorkspaceWatcherExecutionMode } from './workspace-watcher-worktree.js';

/**
 * @param {unknown} value
 * @returns {'worktree' | 'project' | ''} an unusable pool is empty, never a guess
 */
export function normalizeWorkspaceWatcherPool(value) {
  const pool = String(value ?? '').trim();
  return pool === 'worktree' || pool === 'project' ? pool : '';
}

/**
 * The pool a todo row executes in. A stored `executionMode` the resolver
 * refuses is treated as `project` — the conservative folder, the same choice as
 * the snapshot's busy-token split — so an unusable value can never turn a
 * decision into an error or widen the worktree pool.
 *
 * @param {object | null | undefined} todo
 * @param {object | null | undefined} policy
 * @returns {'worktree' | 'project'}
 */
export function workspaceWatcherTodoPool(todo, policy) {
  try {
    return resolveWorkspaceWatcherExecutionMode({ todo, policy }).mode;
  } catch {
    return 'project';
  }
}

/**
 * Whether a leaf the watcher would run in the project folder sits under an
 * ancestor that explicitly requires a worktree. The watcher keys by the leaf
 * (contract §4.3: no ancestor walk while O1 is open), but `delegation_start`
 * refuses every child of such a leaf from a project-folder orchestrator, so a
 * cycle for it can only report `blocked`. Those leaves need a manual start
 * (`todo_start`, contract §4.3a) and are not eligible for an autopilot pick.
 *
 * @param {object | null | undefined} todo
 * @param {unknown} items every todo row of the workspace (for the parent chain)
 * @param {object | null | undefined} policy
 * @returns {boolean}
 */
export function isWorkspaceWatcherLeafBehindWorktreeAncestor(todo, items, policy) {
  if (!todo || workspaceWatcherTodoPool(todo, policy) !== 'project') return false;
  const byId = workspaceWatcherPoolTodoIndex([items]);
  const visited = new Set([String(todo.id ?? '')]);
  let current = byId.get(String(todo.parentId ?? '').trim()) || null;
  while (current && !visited.has(String(current.id ?? ''))) {
    visited.add(String(current.id ?? ''));
    if (String(current.executionMode ?? '').trim() === 'worktree') return true;
    current = byId.get(String(current.parentId ?? '').trim()) || null;
  }
  return false;
}

/**
 * Index the todo rows a pool lookup can use. A live cycle claims a `doing` row
 * that is not in `readyLeaves`, while the todo about to be started is in both
 * lists, so callers pass the snapshot's item list first and the ready leaves as
 * the fallback; the first row seen for an id wins.
 *
 * @param {(object[] | undefined | null)[]} sources
 * @returns {Map<string, object>} todo id -> row
 */
export function workspaceWatcherPoolTodoIndex(sources = []) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const rows of Array.isArray(sources) ? sources : []) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String(row?.id ?? '').trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, row);
    }
  }
  return byId;
}

/**
 * Pool of a todo by id. A row that cannot be found (a deleted todo, a cycle
 * slot written before the row existed, an id list that is not an array) lands in
 * the project pool: the conservative guess, because an untraceable slot must
 * never be counted as permission to open another worktree checkout.
 *
 * @param {unknown} todoId
 * @param {{ todos?: Map<string, object>, policy?: object | null }} [input]
 * @returns {'worktree' | 'project'}
 */
export function workspaceWatcherTodoIdPool(todoId, input = {}) {
  const id = String(todoId ?? '').trim();
  const todo = id && input.todos instanceof Map ? input.todos.get(id) : null;
  if (!todo) return 'project';
  return workspaceWatcherTodoPool(todo, input.policy);
}

/**
 * Configured cap for one pool. `0`, an absent field or an unparseable value all
 * mean "no separate limit": the pool is bounded only by the global `maxParallel`
 * cap, which is what keeps a legacy policy row decision-identical.
 *
 * @param {'worktree' | 'project'} pool
 * @param {object | null | undefined} policy
 * @returns {number}
 */
export function workspaceWatcherPoolLimit(pool, policy) {
  const limit = Math.floor(Number(pool === 'worktree'
    ? policy?.maxParallelWorktree
    : policy?.maxParallelProject));
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

/**
 * Wait reason of a pool filled by agents outside the watcher. A pool filled by
 * this row's own cycles stays on `cycle_active` and carries the pool as a
 * marker instead — see `decisionForOccupiedWatcherSlots`.
 *
 * @param {'worktree' | 'project'} pool
 * @returns {string}
 */
export function workspaceWatcherPoolWaitReason(pool) {
  return pool === 'worktree' ? 'worktree_parallel' : 'project_parallel';
}

/**
 * Split a row's live cycles by the execution mode of the todo each one claimed
 * at start (`executionMode`). Legacy cycles fall back to `todoIds[0]`.
 * Planning uses the claimed task's pool even if it needs no checkout.
 * The rest of `todoIds` is a subtree the cycle
 * drives, not the folder it runs in.
 *
 * @param {{
 *   cycles?: object[],
 *   todos?: Map<string, object>,
 *   policy?: object | null,
 * }} [input]
 * @returns {{ worktree: object[], project: object[] }}
 */
export function partitionWorkspaceWatcherCyclesByPool(input = {}) {
  /** @type {object[]} */
  const worktree = [];
  /** @type {object[]} */
  const project = [];
  for (const cycle of Array.isArray(input.cycles) ? input.cycles : []) {
    const todoIds = Array.isArray(cycle?.todoIds) ? cycle.todoIds : [];
    const pool = normalizeWorkspaceWatcherPool(cycle?.executionMode)
      || workspaceWatcherTodoIdPool(todoIds[0], input);
    (pool === 'worktree' ? worktree : project).push(cycle);
  }
  return { worktree, project };
}

/**
 * The pool gate for one start: which pool the todo being started belongs to and
 * whether that pool's own cycle ceiling is already reached by this row's live
 * cycles. The global `maxParallel` cap is checked by every caller *before* this
 * gate, so the sum of both pools can never exceed it.
 *
 * @param {{
 *   todoId?: unknown,
 *   cycles?: object[],
 *   todos?: Map<string, object>,
 *   policy?: object | null,
 *   snapshot?: object,
 * }} input
 * @returns {{ pool: 'worktree' | 'project', limit: number, occupied: number, full: boolean }}
 */
export function workspaceWatcherStartPoolGate(input = {}) {
  const pool = workspaceWatcherTodoIdPool(input.todoId, input);
  const limit = workspaceWatcherPoolLimit(pool, input.policy);
  if (limit <= 0) return { pool, limit: 0, occupied: 0, full: false };
  const partition = partitionWorkspaceWatcherCyclesByPool(input);
  const external = Math.max(0, Number(pool === 'worktree'
    ? input.snapshot?.worktreeAgentCount : input.snapshot?.projectAgentCount) || 0);
  const occupied = (pool === 'worktree' ? partition.worktree : partition.project).length + external;
  return { pool, limit, occupied, full: occupied >= limit };
}
