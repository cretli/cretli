/**
 * Pure "Blocked" read model for the Todo panel and the watcher "Why?" view.
 *
 * Input state (todo rows + watcher recovery/backoff state) -> per-todo decision
 * `{ cause, action }`. No I/O, no clock: callers inject `now`. The route
 * `GET /api/workspace-watcher/blocked` feeds it; the UI only renders the result.
 */

import { buildTodoIndex, collectTodoSubtreeIds, readTodoParentId, isTodoNodeBlocked } from './todo-tree.js';
import { isFeedbackDerivedTodo } from './feedback-marker.js';

/** Causes in display order. */
export const TODO_BLOCKED_CAUSES = Object.freeze([
  'parked',
  'backoff',
  'plan_unapproved',
  'blocked_sibling',
  'orphan',
  'dead_container',
  'stale_worktree',
  'review_failed',
]);

/** One-click actions the UI can offer. */
export const TODO_BLOCKED_ACTIONS = Object.freeze(['ready', 'defer', 'open_report', 'refresh_worktree']);

const OPEN_STATUSES = new Set(['idea', 'ready', 'doing']);

/** `doing` recovery reasons that mean the worktree/execution container is gone or abandoned. */
const STALE_WORKTREE_REASONS = new Set(['worktree_open', 'restart_interrupted_worktree']);
const DEAD_CONTAINER_REASONS = new Set(['chat_missing', 'idle_archived_chat', 'idle_open_chat', 'missing_identity']);

function text(value) {
  return String(value ?? '').trim();
}

/**
 * Decide why a single todo will not start, or return null when nothing blocks it.
 *
 * @param {{
 *   item: Record<string, any>,
 *   items: Record<string, any>[],
 *   index?: Map<string, Record<string, any>>,
 *   doingState?: Record<string, any> | null,
 *   backoffUntil?: string,
 *   now?: number,
 * }} input
 * @returns {{ todoId: string, cause: string, action: string, detail: string, blockerId: string } | null}
 */
export function decideBlockedTodo(input) {
  const { item, items } = input;
  const todoId = text(item?.id);
  if (!todoId || !OPEN_STATUSES.has(text(item?.status))) return null;
  const index = input.index || buildTodoIndex(items);
  const now = Number.isFinite(input.now) ? Number(input.now) : 0;
  const make = (cause, action, detail = '', blockerId = '') => ({ todoId, cause, action, detail, blockerId });

  // A `doing` row: its recovery state explains why nothing progresses.
  if (text(item.status) === 'doing') {
    const state = input.doingState;
    const reason = text(state?.reason);
    if (state && reason === 'review_failed') return make('review_failed', 'open_report', text(item?.review?.code?.reason) || reason);
    if (state && STALE_WORKTREE_REASONS.has(reason)) return make('stale_worktree', 'refresh_worktree', reason);
    if (state && state.state === 'recoverable' && DEAD_CONTAINER_REASONS.has(reason)) {
      return make('dead_container', 'ready', reason);
    }
    return null;
  }

  const parentId = readTodoParentId(item);
  if (parentId && !index.get(parentId)) return make('orphan', 'ready', parentId, parentId);

  const backoff = Date.parse(text(input.backoffUntil));
  if (Number.isFinite(backoff) && backoff > now) return make('backoff', 'open_report', text(input.backoffUntil));

  if (text(item.blockedReason)) return make('parked', 'ready', text(item.blockedReason));

  if (!parentId || !isTodoNodeBlocked(items, item, index)) return null;
  const parent = index.get(parentId);
  const parentHasPlan = Boolean(text(parent?.plan?.markdown));
  if (parentHasPlan && !hasApprovedPlan(parent, index)) {
    return make('plan_unapproved', 'open_report', text(parent.title), text(parent.id));
  }
  const ownIndex = Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0;
  const blocker = items
    .filter((row) => row?.id && row.id !== item.id && readTodoParentId(row) === parentId
      && (Number.isInteger(row.siblingIndex) ? row.siblingIndex : 0) < ownIndex)
    .sort((a, b) => (a.siblingIndex || 0) - (b.siblingIndex || 0))
    .find((row) => collectTodoSubtreeIds(items, row.id).some((id) => {
      const node = index.get(id);
      if (text(node?.status) === 'idea' && node?.nonBlocking === true) return false;
      return !['done', 'deferred'].includes(text(node?.status));
    }));
  return make('blocked_sibling', 'defer', text(blocker?.title), text(blocker?.id));
}

function hasApprovedPlan(node, index) {
  if (isFeedbackDerivedTodo([...index.values()], node)) return !!text(node?.plan?.approvedAt);
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (text(current.plan?.approvedAt)) return true;
    current = index.get(readTodoParentId(current)) || null;
  }
  return false;
}

/**
 * Decide for every open todo and group the blocked ones by cause. Children of a
 * blocked node are not listed separately: only the node that holds the cause is.
 *
 * @param {{
 *   items: Record<string, any>[],
 *   doingStates?: Record<string, any>[],
 *   blockedBackoff?: Record<string, { until?: string }>,
 *   now?: number,
 * }} input
 * @returns {{ total: number, groups: Array<{ cause: string, entries: Array<Record<string, any>> }> }}
 */
export function buildTodoBlockedView(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  const index = buildTodoIndex(items);
  const states = new Map((Array.isArray(input.doingStates) ? input.doingStates : []).map((row) => [text(row?.todoId), row]));
  const children = new Set(items.map((row) => readTodoParentId(row)).filter(Boolean));
  const byCause = new Map(TODO_BLOCKED_CAUSES.map((cause) => [cause, []]));
  for (const item of items) {
    // Grouping nodes derive their status from children; they are never the blocker themselves.
    if (children.has(text(item?.id))) continue;
    const decision = decideBlockedTodo({
      item,
      items,
      index,
      doingState: states.get(text(item?.id)) || null,
      backoffUntil: input.blockedBackoff?.[text(item?.id)]?.until,
      now: input.now,
    });
    if (!decision) continue;
    byCause.get(decision.cause)?.push({ ...decision, title: text(item.title), revision: text(item.updatedAt) });
  }
  const groups = TODO_BLOCKED_CAUSES
    .map((cause) => ({ cause, entries: byCause.get(cause) || [] }))
    .filter((group) => group.entries.length > 0);
  return { total: groups.reduce((sum, group) => sum + group.entries.length, 0), groups };
}
