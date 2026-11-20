/**
 * Blocked-todo view (pure, DOM-free): renders the server's
 * `GET /api/workspace-watcher/blocked` groups and maps a clicked action to the
 * todo patch it stands for. The decision itself lives in `lib/todo-blocked-view.js`.
 */

import { t } from '../../i18n/index.js';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} action `ready` | `defer` | `open_report` | `refresh_worktree`
 * @returns {Record<string, any> | null} PATCH payload, or null when the action only opens the todo
 */
export function blockedActionPatch(action) {
  if (action === 'ready') return { status: 'ready' };
  if (action === 'defer') return { status: 'deferred' };
  return null;
}

/** Actions that call a server operation instead of patching the todo. */
export function blockedActionRequest(action, todoId) {
  if (action === 'refresh_worktree') {
    return { path: '/api/workspace-watcher/refresh-worktree', options: { method: 'POST', body: { todoId } } };
  }
  return null;
}

/** User-facing categories in display order. */
export const BLOCKED_CATEGORIES = Object.freeze(['human', 'stale_worktree', 'review_fail', 'date', 'infra']);

/**
 * Maps a backend entry (cause + optional reasonCode/detail) to one of the five
 * user-facing categories.
 *
 * @param {{ cause?: string, reasonCode?: string, detail?: string }} entry
 * @returns {'human'|'stale_worktree'|'review_fail'|'date'|'infra'}
 */
export function blockedCategory(entry) {
  const code = String(entry?.reasonCode || '');
  if (code === 'waits_for_date') return 'date';
  if (code === 'env_infra') return 'infra';
  if (code === 'review_fail' || code === 'review_failed') return 'review_fail';
  if (code === 'needs_human' || code === 'needs_rescope') return 'human';
  switch (entry?.cause) {
    case 'stale_worktree': return 'stale_worktree';
    case 'backoff': return 'date';
    case 'dead_container': return 'infra';
    case 'parked':
      return /review.*fail|fail.*review/i.test(String(entry?.detail || '')) ? 'review_fail' : 'human';
    default: return 'human'; // plan_unapproved, blocked_sibling, orphan
  }
}

/**
 * Regroups the server's per-cause groups into the five categories.
 *
 * @param {{ groups?: Array<{ cause: string, entries: Array<Record<string, any>> }> } | null | undefined} view
 * @returns {Array<{ category: string, entries: Array<Record<string, any>> }>}
 */
export function groupBlockedByCategory(view) {
  const map = new Map(BLOCKED_CATEGORIES.map((category) => [category, []]));
  for (const group of Array.isArray(view?.groups) ? view.groups : []) {
    for (const entry of group.entries || []) {
      map.get(blockedCategory({ ...entry, cause: entry.cause || group.cause })).push(entry);
    }
  }
  return BLOCKED_CATEGORIES.map((category) => ({ category, entries: map.get(category) })).filter((g) => g.entries.length);
}

/**
 * Renders the blocked groups as stacked cards (title, wrapped detail, actions)
 * so long titles and reasons wrap on a phone instead of forcing a wide table.
 * The title opens the todo: an unknown action falls through to `cretli-open-todo`.
 *
 * @param {{ total?: number, groups?: Array<{ cause: string, entries: Array<Record<string, any>> }> } | null | undefined} view
 * @returns {string}
 */
export function renderTodoBlockedHtml(view) {
  const groups = groupBlockedByCategory(view);
  if (!groups.length) return `<p class="todo-blocked-empty">${esc(t('todo.blockedEmpty'))}</p>`;
  return groups.map((group) => {
    const items = group.entries.map((entry) => {
      const id = esc(entry.todoId);
      const title = esc(entry.title || String(entry.todoId).slice(0, 8));
      const detail = entry.detail
        ? `<p class="todo-blocked-detail" title="${esc(entry.detail)}">${esc(entry.detail)}</p>`
        : '';
      const actions = [entry.action, entry.action === 'defer' ? '' : 'defer'].filter(Boolean);
      const buttons = actions.map((action, index) => `<button type="button" class="todo-blocked-action"`
        + `${index === 0 ? ' data-primary' : ''} data-blocked-action="${esc(action)}" data-blocked-id="${id}">`
        + `${esc(t(`todo.blockedAction_${action}`))}</button>`).join('');
      return '<li class="todo-blocked-item">'
        + `<button type="button" class="todo-blocked-title" data-blocked-action="open" data-blocked-id="${id}">${title}</button>`
        + detail
        + `<div class="todo-blocked-actions">${buttons}</div>`
        + '</li>';
    }).join('');
    return `<section class="todo-blocked-group" data-category="${esc(group.category)}">`
      + '<header class="todo-blocked-group-head">'
      + `<h3 class="todo-blocked-group-title">${esc(t(`todo.blockedCategory_${group.category}`))}`
      + ` <span class="todo-blocked-count">${group.entries.length}</span></h3>`
      + `<p class="todo-blocked-hint">${esc(t(`todo.blockedHint_${group.category}`))}</p>`
      + `</header><ul class="todo-blocked-list">${items}</ul></section>`;
  }).join('');
}
