/**
 * Pure view helpers for the Git panel worktree list (no DOM, no network), so
 * state labels, tones and action gating are unit-testable.
 */

/** Row `state` (server `lib/worktree-list.js`) -> i18n key + tone. */
const STATE_VIEW = Object.freeze({
  active: { key: 'worktrees.state.active', tone: 'info' },
  execution_closed: { key: 'worktrees.state.executionClosed', tone: 'muted' },
  integration_ready: { key: 'worktrees.state.integrationReady', tone: 'warn' },
  merging: { key: 'worktrees.state.merging', tone: 'info' },
  integrated: { key: 'worktrees.state.integrated', tone: 'success' },
  rejected: { key: 'worktrees.state.rejected', tone: 'error' },
  missing: { key: 'worktrees.state.missing', tone: 'error' },
  foreign: { key: 'worktrees.state.foreign', tone: 'error' },
  creating: { key: 'worktrees.state.creating', tone: 'muted' },
  cleaned: { key: 'worktrees.state.cleaned', tone: 'muted' },
});

/** Server preflight blocker code -> i18n key. */
const BLOCKER_KEYS = Object.freeze({
  workspace_busy: 'worktrees.blocker.workspaceBusy',
  dirty_workspace: 'worktrees.blocker.dirtyWorkspace',
  merge_in_progress: 'worktrees.blocker.mergeInProgress',
  detached_head: 'worktrees.blocker.detachedHead',
  same_branch: 'worktrees.blocker.sameBranch',
  branch_missing: 'worktrees.blocker.branchMissing',
  worktree_missing: 'worktrees.blocker.worktreeMissing',
  repo_unavailable: 'worktrees.blocker.repoUnavailable',
  no_worktree: 'worktrees.blocker.noWorktree',
});

/**
 * @param {string} state
 * @param {(key: string) => string} t
 * @returns {{ label: string, tone: string }}
 */
export function describeWorktreeState(state, t) {
  const view = STATE_VIEW[state];
  if (!view) return { label: String(state || '—'), tone: 'muted' };
  return { label: t(view.key), tone: view.tone };
}

/**
 * @param {{ code?: string, message?: string }} blocker
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function describeMergeBlocker(blocker, t) {
  const key = BLOCKER_KEYS[String(blocker?.code || '')];
  return key ? t(key) : String(blocker?.message || blocker?.code || '');
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shortCommit(value) {
  return String(value || '').trim().slice(0, 8);
}

/**
 * One-line change summary: committed commits plus files still uncommitted.
 *
 * @param {{ aheadCommits?: number, uncommittedFiles?: number }} row
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function summarizeWorktreeChanges(row, t) {
  const ahead = Number(row?.aheadCommits) || 0;
  const files = Number(row?.uncommittedFiles) || 0;
  if (!ahead && !files) return t('worktrees.noChanges');
  return t('worktrees.changes', { commits: ahead, files });
}

/**
 * Whether the merge confirmation may be submitted for a preview.
 *
 * @param {{ ok?: boolean, blockers?: object[] } | null | undefined} preflight
 * @returns {boolean}
 */
export function canStartMerge(preflight) {
  return Boolean(preflight) && preflight.ok === true && (preflight.blockers || []).length === 0;
}

/**
 * Cleanup of anything not integrated is a discard and must be confirmed.
 *
 * @param {{ state?: string }} row
 * @returns {boolean}
 */
export function cleanupNeedsDiscard(row) {
  return String(row?.state || '') !== 'integrated' && String(row?.state || '') !== 'cleaned';
}
