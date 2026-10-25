/**
 * Workspace Watcher scheduler — the decision layer behind "which leaf next".
 *
 * Replaces the artificial parallel limit with scheduling:
 *   - priority classes (continuation work before fresh work before background),
 *   - fair share between todo trees (fewest running leaves, then least recently
 *     served), so one big tree cannot starve the others,
 *   - queueing: a start that cannot happen now is postponed with a named reason,
 *     never rejected or aborted,
 *   - `maxParallel` as an emergency safety valve only: it caps starts while the
 *     S1 stability signals (event-loop lag, route latency, load, low disk)
 *     report danger, and never touches work that already runs.
 *
 * Everything here is pure except the registered stability source, which the
 * server wires to the S1 load snapshot.
 */

import { buildTodoIndex, readTodoParentId } from './todo-tree.js';
import {
  collectTodoSubtreeScopePaths,
  leafScopePathsCollide,
  listTodoSiblings,
} from './todo-parallel-scope.js';

/** Priority classes, lower runs first. */
export const WORKSPACE_WATCHER_PRIORITY_CLASSES = Object.freeze({
  continuation: 0,
  normal: 1,
  background: 2,
});

/** S1 alarms that mean the process is in danger; others are advisory. */
export const WORKSPACE_WATCHER_DANGER_ALARMS = Object.freeze([
  'eventLoopP99',
  'routeP95',
  'lowDisk',
  'loadAvg',
  'lowMemory',
]);

/** Close reasons caused by the platform, never by the leaf itself. */
const INFRA_CLOSE_REASONS = new Set(['mcp_not_ready', 'mcp_tools_missing', 'restart_interrupted', 'server_restart']);

/** @type {(() => Record<string, any> | null) | null} */
let stabilitySource = null;

/**
 * Register the S1 load snapshot getter. With no source registered the valve
 * cannot tell healthy from unhealthy, so `maxParallel` keeps acting as a plain
 * cap (the conservative legacy behaviour).
 *
 * @param {(() => Record<string, any> | null) | null} source
 */
export function setWorkspaceWatcherStabilitySource(source) {
  stabilitySource = typeof source === 'function' ? source : null;
}

/**
 * @param {Record<string, any> | null | undefined} [load] explicit snapshot; defaults to the registered source
 * @returns {{ known: boolean, danger: boolean, alarms: string[] }}
 */
export function readWorkspaceWatcherStability(load) {
  let snapshot = load;
  if (snapshot === undefined) {
    if (!stabilitySource) return { known: false, danger: false, alarms: [] };
    try {
      snapshot = stabilitySource();
    } catch {
      snapshot = null;
    }
  }
  if (!snapshot || typeof snapshot !== 'object') return { known: false, danger: false, alarms: [] };
  const alarms = (Array.isArray(snapshot.alarms) ? snapshot.alarms : [])
    .map((a) => String(a))
    .filter((a) => WORKSPACE_WATCHER_DANGER_ALARMS.includes(a));
  return { known: true, danger: alarms.length > 0, alarms };
}

/**
 * Safety valve: is `count` running agents at/above `maxParallel` a reason to
 * postpone a start? Only while S1 reports danger (or cannot report at all).
 *
 * @param {{ count: number, maxParallel: number, load?: Record<string, any> | null }} input
 * @returns {{ reached: boolean, reason: string, alarms: string[] }}
 */
export function evaluateWorkspaceWatcherSafetyValve(input) {
  const count = Math.max(0, Number(input?.count) || 0);
  const maxParallel = Math.max(1, Number(input?.maxParallel) || 1);
  if (count < maxParallel) return { reached: false, reason: '', alarms: [] };
  const stability = readWorkspaceWatcherStability(input?.load);
  if (!stability.known) return { reached: true, reason: 'max_parallel', alarms: [] };
  if (!stability.danger) return { reached: false, reason: '', alarms: [] };
  return {
    reached: true,
    reason: `stability_valve:${stability.alarms.join(',')}`,
    alarms: stability.alarms,
  };
}

/**
 * Infrastructure failures must not feed the failure ceiling or backoff.
 *
 * @param {string} closeReason
 * @param {{ load?: Record<string, any> | null }} [options]
 * @returns {boolean}
 */
export function isWorkspaceWatcherInfraFailure(closeReason, options = {}) {
  const reason = String(closeReason || '').trim();
  if (!reason) return false;
  if (INFRA_CLOSE_REASONS.has(reason)) return true;
  if (reason === 'missing_report' || reason === 'cycle_incomplete') {
    const stability = readWorkspaceWatcherStability(options.load);
    return stability.alarms.includes('eventLoopP99') || stability.alarms.includes('routeP95');
  }
  return false;
}

/**
 * @param {Record<string, any>} row
 * @returns {number}
 */
export function workspaceWatcherPriorityClass(row) {
  const declared = String(row?.priority ?? '').trim().toLowerCase();
  if (declared === 'low' || declared === 'background') return WORKSPACE_WATCHER_PRIORITY_CLASSES.background;
  if (declared === 'high' || declared === 'urgent') return WORKSPACE_WATCHER_PRIORITY_CLASSES.continuation;
  // Work that already has material (a leaf checkpoint) or a failed review is
  // finishing in-flight work: it goes before opening something new.
  if (row?.leafMaterial || row?.review?.code?.state === 'failed') {
    return WORKSPACE_WATCHER_PRIORITY_CLASSES.continuation;
  }
  return WORKSPACE_WATCHER_PRIORITY_CLASSES.normal;
}

/**
 * Orders eligible leaves: priority class, assignment, fair share between trees
 * (fewest running leaves, then least recently served), then the legacy order.
 * Pure: the caller passes `lastServedByTree` and persists it after a start.
 *
 * @param {Record<string, any>[]} eligible already filtered, in legacy order
 * @param {{
 *   items?: Record<string, any>[],
 *   lastServedByTree?: Record<string, number>,
 *   runningByTree?: Record<string, number>,
 *   preferred?: (row: Record<string, any>) => boolean,
 * }} [context]
 * @returns {Record<string, any>[]}
 */
export function rankWorkspaceWatcherCandidates(eligible, context = {}) {
  const items = Array.isArray(context.items) ? context.items : [];
  const served = context.lastServedByTree && typeof context.lastServedByTree === 'object' ? context.lastServedByTree : {};
  const running = context.runningByTree && typeof context.runningByTree === 'object' ? context.runningByTree : {};
  const preferred = typeof context.preferred === 'function' ? context.preferred : null;
  const index = buildTodoIndex(items);
  const treeOf = (row) => workspaceWatcherTreeKey(items, row, index);
  return eligible
    .map((row, order) => ({ row, order, tree: treeOf(row) }))
    .sort((a, b) => {
      const cls = workspaceWatcherPriorityClass(a.row) - workspaceWatcherPriorityClass(b.row);
      if (cls) return cls;
      if (preferred) {
        const pref = Number(preferred(b.row)) - Number(preferred(a.row));
        if (pref) return pref;
      }
      if (a.tree !== b.tree) {
        const load = (Number(running[a.tree]) || 0) - (Number(running[b.tree]) || 0);
        if (load) return load;
        const recency = (Number(served[a.tree]) || 0) - (Number(served[b.tree]) || 0);
        if (recency) return recency;
      }
      return a.order - b.order;
    })
    .map((entry) => entry.row);
}

/**
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} row
 * @param {Map<string, Record<string, any>>} [index]
 * @returns {string}
 */
export function workspaceWatcherTreeKey(items, row, index = buildTodoIndex(items)) {
  const id = String(row?.id ?? '');
  if (!id) return '';
  let current = id;
  const seen = new Set([id]);
  let parent = readTodoParentId(index.get(current));
  while (parent && index.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    current = parent;
    parent = readTodoParentId(index.get(current));
  }
  return current;
}

/**
 * Running leaves per tree, from `doing` rows.
 *
 * @param {Record<string, any>[]} items
 * @returns {Record<string, number>}
 */
export function countRunningLeavesByTree(items) {
  /** @type {Record<string, number>} */
  const out = {};
  const index = buildTodoIndex(items);
  const parents = new Set((Array.isArray(items) ? items : []).map((r) => readTodoParentId(r)).filter(Boolean));
  for (const row of Array.isArray(items) ? items : []) {
    // Only leaves run work; a `doing` parent is a status rollup of its children.
    if (row?.status !== 'doing' || parents.has(String(row.id))) continue;
    const key = workspaceWatcherTreeKey(items, row, index);
    if (key) out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Why a ready-status leaf in a parallel group is held back by its siblings.
 * `parallel_scope_unknown` names the sibling in `doing` whose scope (or this
 * leaf's own) is undeclared; `parallel_scope_collision` names a declared overlap.
 *
 * @param {Record<string, any>[]} items
 * @param {Record<string, any>} item
 * @returns {{ code: 'parallel_scope_unknown' | 'parallel_scope_collision', conflictLeafId: string } | null}
 */
export function explainParallelScopeBlock(items, item) {
  const parentId = readTodoParentId(item);
  if (!parentId) return null;
  const parent = buildTodoIndex(items).get(parentId);
  if (!parent || parent.runMode !== 'parallel') return null;
  const ownPaths = collectTodoSubtreeScopePaths(items, item);
  for (const row of listTodoSiblings(items, parentId)) {
    if (!row?.id || row.id === item.id || row.status !== 'doing') continue;
    const otherPaths = collectTodoSubtreeScopePaths(items, row);
    if (!leafScopePathsCollide(ownPaths, otherPaths)) continue;
    const unknown = ownPaths.length === 0 || otherPaths.length === 0;
    return {
      code: unknown ? 'parallel_scope_unknown' : 'parallel_scope_collision',
      conflictLeafId: String(row.id),
    };
  }
  return null;
}

/**
 * Per-candidate rejection list for "Why?": every ready leaf that was filtered
 * out with the filter that did it, plus parallel-group leaves held by sibling
 * scope (they never reach the ready list).
 *
 * @param {{
 *   items?: Record<string, any>[],
 *   readyLeaves?: Record<string, any>[],
 *   classify: (row: Record<string, any>) => string,
 * }} input
 * @returns {Array<{ id: string, filter: string, conflictLeafId?: string }>}
 */
export function explainWorkspaceWatcherRejections(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(input.readyLeaves) ? input.readyLeaves : []) {
    const filter = input.classify(row);
    if (!filter) continue;
    seen.add(String(row.id));
    out.push({ id: String(row.id), filter });
  }
  const parents = new Set(items.map((r) => readTodoParentId(r)).filter(Boolean));
  for (const row of items) {
    if (!row?.id || row.status !== 'ready' || parents.has(String(row.id)) || seen.has(String(row.id))) continue;
    const block = explainParallelScopeBlock(items, row);
    if (block) out.push({ id: String(row.id), filter: block.code, conflictLeafId: block.conflictLeafId });
  }
  return out;
}

/**
 * Headline reason for an idle decision: the filter that rejected the most
 * candidates wins, so one backed-off leaf cannot label a pool that something
 * else blocks.
 *
 * @param {Array<{ filter: string }>} rejections
 * @returns {string}
 */
export function pickDominantRejection(rejections) {
  if (!rejections.length) return '';
  const counts = new Map();
  for (const r of rejections) counts.set(r.filter, (counts.get(r.filter) || 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [filter, count] of counts) {
    if (count > bestCount) {
      best = filter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Advice for todo_create: a leaf in a parallel group needs a `## Leaf scope`.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
export function bodyDeclaresLeafScope(body) {
  return /^##\s+leaf\s+scope\s*$/im.test(String(body || ''));
}
