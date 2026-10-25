import { isTodoAwaitingIntegration } from '../../../../lib/todo-integration-state.js';
import { matchesTodoIntegrationFilter } from '../todoTreeView.js';
import { t } from '../../../i18n/index.js';

export function filterTodoItemsByIntegrationState(items, filter) {
  if (!filter.size) return items;
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const included = new Set();
  for (const item of items) {
    if (!Array.from(filter).some((value) => matchesTodoIntegrationFilter(item, value))) continue;
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

export function countTodoItemsByIntegrationState(items, filter) {
  if (filter === 'all') return items.length;
  if (filter instanceof Set) {
    return items.filter((item) => Array.from(filter).some((value) => matchesTodoIntegrationFilter(item, value))).length;
  }
  return items.filter((item) => matchesTodoIntegrationFilter(item, filter)).length;
}

/**
 * The tree owns a live worktree (the server summary is keyed by the tree ROOT,
 * so every node of the tree reports it) and its result is not integrated yet.
 *
 * @param {any} item
 * @returns {boolean}
 */
export function canIntegrateWorktree(item) {
  const summary = item?.worktree;
  if (summary?.live !== true) return false;
  return String(summary.integrationState || '') !== 'integrated';
}

/**
 * A finished todo with no live worktree has nothing to merge; the remaining
 * integration step is recording proof against the workspace branch.
 *
 * @param {any} item
 * @returns {boolean}
 */
export function canConfirmIntegrationFromMenu(item) {
  if (String(item?.status || '') !== 'done') return false;
  if (isTodoAwaitingIntegration(item)) return false;
  return String(item?.integrationSummary?.state || 'unconfirmed') !== 'integrated';
}

/**
 * @param {string} action
 * @param {{ error?: string } | null | undefined} result
 * @returns {string}
 */
export function integrationFailureMessage(action, result) {
  const error = String(result?.error || '');
  if (action === 'prepare') return t('todo.integrationPrepareFailed');
  if (error.startsWith('target_') || error === 'task_change_link_required' || error === 'full_commit_required') {
    return t('todo.integrationProofInvalid');
  }
  if (error === 'conflict' || error === 'integration_conflict') return t('todo.integrationConflict');
  return t('todo.integrationFailed');
}

export function sameAssignee(item, assignee) {
  const current = item?.assignee && typeof item.assignee === 'object' ? item.assignee : null;
  if (!assignee && !current?.harness) return true;
  if (!assignee || !current) return false;
  return current.harness === assignee.harness
    && current.role === assignee.role
    && String(current.model || '') === String(assignee.model || '');
}
