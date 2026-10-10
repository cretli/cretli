/**
 * Compact workspace-folder branch chip in the sidebar workspace bar.
 *
 * Unlike the execution badge (`header-git-badge`, which follows the active
 * chat's worktree), this chip always shows the branch of the active workspace
 * folder. Clicking it is owned by the quick-menu module; this file only
 * renders data. A late answer for a previous workspace is dropped through a
 * request sequence, so fast workspace switches never paint stale data.
 */

import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { deriveWorkspaceBranchBadge } from '../../features/git/workspaceBranchView.js';

/** Minimum gap between two focus-triggered refreshes (ms). */
const FOCUS_REFRESH_THROTTLE_MS = 15000;

let requestSeq = 0;
/** Last workspace folder we attempted, so duplicate triggers do not refetch. */
let lastAttemptKey = '';
/** @type {object | null} last git info for the workspace scope (menu reuse). */
let lastInfo = null;
let deps = {
  getActiveWorkspaceFolder: () => '',
};

/** The bar shows while either the branch chip or the worktree row is visible. */
export function syncWorkspaceBarVisibility() {
  const bar = document.getElementById('sidebar-workspace-bar');
  if (!bar) return;
  const chip = document.getElementById('header-workspace-branch');
  const row = document.getElementById('sidebar-worktree-row');
  bar.hidden = (!chip || chip.hidden) && (!row || row.hidden);
}

function hideChip() {
  const el = document.getElementById('header-workspace-branch');
  if (!el) return;
  el.hidden = true;
  syncWorkspaceBarVisibility();
  el.textContent = '';
  el.removeAttribute('title');
  delete el.dataset.detached;
  lastInfo = null;
}

/**
 * @param {{
 *   getActiveWorkspaceFolder?: () => string,
 * }} [options]
 * @returns {{ refresh: (options?: { force?: boolean }) => Promise<void> }}
 */
export function initWorkspaceBranchBadge(options = {}) {
  if (typeof options.getActiveWorkspaceFolder === 'function') {
    deps.getActiveWorkspaceFolder = options.getActiveWorkspaceFolder;
  }
  window.addEventListener('cretli-active-workspace-changed', () => {
    lastAttemptKey = '';
    void refreshWorkspaceBranchBadge({ force: true });
  });
  // The header folder may be filled in after this module initialised, so poll
  // a few times at startup instead of relying on a single change event.
  for (const delayMs of [0, 1500, 5000]) {
    window.setTimeout(() => {
      if (!lastInfo) void refreshWorkspaceBranchBadge({ force: true });
    }, delayMs);
  }
  window.addEventListener('cretli-git-changed', () => {
    void refreshWorkspaceBranchBadge({ force: true });
  });
  window.addEventListener('cr-lang-changed', () => {
    void refreshWorkspaceBranchBadge({ force: true });
  });
  let lastFocusRefreshAt = 0;
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - lastFocusRefreshAt < FOCUS_REFRESH_THROTTLE_MS) return;
    lastFocusRefreshAt = now;
    void refreshWorkspaceBranchBadge({ force: true });
  });
  return { refresh: refreshWorkspaceBranchBadge };
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function refreshWorkspaceBranchBadge(options = {}) {
  const el = document.getElementById('header-workspace-branch');
  if (!el) return;
  const folder = String(deps.getActiveWorkspaceFolder() || '').trim();
  if (!folder) {
    lastAttemptKey = '';
    hideChip();
    return;
  }
  if (!options.force && folder === lastAttemptKey) return;
  lastAttemptKey = folder;
  const seq = ++requestSeq;
  let info = null;
  try {
    info = await api.getGitInfo({ workspaceFolder: folder });
  } catch {
    if (seq === requestSeq) hideChip();
    return;
  }
  if (seq !== requestSeq) return;
  const badge = deriveWorkspaceBranchBadge(info, t);
  if (!badge.visible) {
    hideChip();
    return;
  }
  lastInfo = info;
  el.hidden = false;
  syncWorkspaceBarVisibility();
  el.textContent = badge.label;
  el.title = badge.title;
  el.setAttribute('aria-label', badge.title);
  if (badge.detached) el.dataset.detached = '1';
  else delete el.dataset.detached;
}

/**
 * Last known Git info for the workspace scope, so the quick menu can render
 * the dirty-tree confirmation without an extra request.
 *
 * @returns {object | null}
 */
export function getWorkspaceBranchBadgeInfo() {
  return lastInfo;
}
