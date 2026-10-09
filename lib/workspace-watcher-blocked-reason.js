/**
 * Workspace Watcher blocked-reason markers and predicates.
 *
 * Single source of truth for the `blockedReason` text the watcher writes when it
 * parks a todo. Shared by the server (tick park, clear-stop reset, cycle close,
 * abandoned-work recovery) and the UI (todo card + per-todo retry), so the
 * "one-time human resume" gates can never drift apart from the writers.
 *
 * Two markers exist:
 *  - the loop-guard park written by `markWorkspaceWatcherTodoBlocked` (repeated
 *    failed cycles or identical review findings), and
 *  - the failure-ceiling reason written when an abandoned `doing` leaf is
 *    released back to `ready`.
 */

/** Reason written by the loop guard when it parks a stuck todo. */
export const WORKSPACE_WATCHER_PARKED_REASON =
  'Workspace Watcher parked this todo after repeated failed cycles or identical review findings.';

/** Prefix of the reason written when a todo reached the failure ceiling. */
export const WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX = 'Workspace Watcher failure ceiling reached';

/**
 * Build the failure-ceiling `blockedReason` from the observed counters.
 *
 * @param {number} failureCount
 * @param {number} ceiling
 * @returns {string}
 */
export function workspaceWatcherFailureCeilingReason(failureCount, ceiling) {
  return `${WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX} (${failureCount}/${ceiling}). Retry manually after resolving the blocker.`;
}

/**
 * Whether a `blockedReason` was written by the Workspace Watcher (loop-guard
 * park or failure ceiling). Only such blockers may be cleared by a one-time
 * human action: the loop-stop reset (clear-stop) or the per-todo retry.
 *
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isWorkspaceWatcherBlockedReason(reason) {
  const text = String(reason ?? '').trim();
  if (!text) return false;
  return text.startsWith(WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX)
    || text.includes(WORKSPACE_WATCHER_PARKED_REASON);
}

/**
 * Whether a blocked todo can be resumed by a human right now. The status guard
 * keeps a `doing`/`done` todo out of the retry path even if it still carries a
 * stale watcher blocker.
 *
 * @param {{ blockedReason?: unknown, status?: unknown } | null | undefined} todo
 * @returns {boolean}
 */
export function isWorkspaceWatcherRetryableBlockedTodo(todo) {
  if (!isWorkspaceWatcherBlockedReason(todo?.blockedReason)) return false;
  const status = String(todo?.status ?? '').trim();
  return status !== 'doing' && status !== 'done';
}
