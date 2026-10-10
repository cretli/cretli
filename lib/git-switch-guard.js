/**
 * Server-side guard for workspace branch switches.
 *
 * A branch switch rewrites the main working tree, so it must not happen while
 * any work is live in that tree. The authority sits here (the client-side
 * dirty/running confirmation is only UX), and the registry covers the whole
 * workspace: every chat run in the repository, every delegation scoped to it
 * and every live watcher cycle.
 *
 * A chat executing in a linked worktree is NOT part of the main tree, so it
 * does not block a switch of the repository root (git keeps worktrees on their
 * own branches).
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { loadChats } from './persist/chats-persist.js';
import { probeChatRunLiveness } from './chat-run-service.js';
import {
  listActiveDelegations,
} from './persist/delegations-persist.js';
import { isDelegationSlotOccupied, isActiveDelegationStatus } from './delegation-status.js';
import {
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchers,
} from './persist/workspace-watchers-persist.js';

/**
 * @typedef {Object} WorkspaceGitActivity
 * @property {boolean} busy true when any chat run, delegation slot or watcher
 *   cycle is live in the repository's main working tree
 * @property {number} runningChats live chat runs in the tree
 * @property {number} runningDelegations delegations with an occupied slot in
 *   the workspace
 * @property {number} watcherCycles active watcher cycles in the workspace
 */

/**
 * Realpath when the path exists, resolved form otherwise, so a symlinked
 * workspace folder still matches git's own `show-toplevel` output.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFolder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return path.resolve(realpathSync(raw));
  } catch {
    return path.resolve(raw);
  }
}

/**
 * True when `target` is `base` itself or lives below it. Paths are compared
 * with platform separators after normalization.
 *
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function isFolderInsideBase(base, target) {
  const baseNorm = normalizeFolder(base);
  const targetNorm = normalizeFolder(target);
  if (!baseNorm || !targetNorm) return false;
  return targetNorm === baseNorm || targetNorm.startsWith(baseNorm + path.sep);
}

/**
 * Live work summary for one repository's main working tree. All sources are
 * injectable so tests can run without durable state.
 *
 * @param {string} repoRoot absolute path of `git rev-parse --show-toplevel`
 * @param {{
 *   dataDir?: string,
 *   deps?: {
 *     loadChats?: () => object[],
 *     probeChatRunLiveness?: (input: { chat: object }) => { busy?: boolean },
 *     listActiveDelegations?: (options?: object) => object[],
 *     isDelegationSlotOccupied?: (row: object) => boolean,
 *     isActiveDelegationStatus?: (status: unknown) => boolean,
 *     loadWorkspaceWatchers?: (options?: object) => object[],
 *     getWorkspaceWatcherActiveCycles?: (row: object) => object[],
 *   },
 * }} [options]
 * @returns {WorkspaceGitActivity}
 */
export function collectWorkspaceGitActivity(repoRoot, options = {}) {
  const empty = { busy: false, runningChats: 0, runningDelegations: 0, watcherCycles: 0 };
  const root = normalizeFolder(repoRoot);
  if (!root) return empty;
  const deps = options.deps || {};
  const loadChatsFn = deps.loadChats || loadChats;
  const probeFn = deps.probeChatRunLiveness || probeChatRunLiveness;
  const listDelegationsFn = deps.listActiveDelegations || listActiveDelegations;
  const slotOccupiedFn = deps.isDelegationSlotOccupied || isDelegationSlotOccupied;
  const activeStatusFn = deps.isActiveDelegationStatus || isActiveDelegationStatus;
  const loadWatchersFn = deps.loadWorkspaceWatchers || loadWorkspaceWatchers;
  const activeCyclesFn = deps.getWorkspaceWatcherActiveCycles || getWorkspaceWatcherActiveCycles;
  const persistOptions = options.dataDir ? { dataDir: options.dataDir } : {};

  let runningChats = 0;
  try {
    for (const chat of loadChatsFn() || []) {
      const folder = chat?.executionFolder || chat?.workspaceFolder || '';
      if (!isFolderInsideBase(root, folder)) continue;
      let probe = null;
      try {
        probe = probeFn({ chat });
      } catch {
        probe = null;
      }
      if (probe?.busy) runningChats += 1;
    }
  } catch {
    // A failing registry read must not fail the route; it just weakens the guard.
  }

  let runningDelegations = 0;
  try {
    for (const row of listDelegationsFn(persistOptions) || []) {
      if (!isFolderInsideBase(root, row?.workspaceFolder || '')) continue;
      const slotFree = !slotOccupiedFn(row) && !activeStatusFn(row?.status);
      if (!slotFree) runningDelegations += 1;
    }
  } catch {
    // Same fail-open contract as the chat registry above.
  }

  let watcherCycles = 0;
  try {
    for (const row of loadWatchersFn(persistOptions) || []) {
      if (!isFolderInsideBase(root, row?.workspaceFolder || '')) continue;
      let cycles = [];
      try {
        cycles = activeCyclesFn(row) || [];
      } catch {
        cycles = [];
      }
      watcherCycles += cycles.length;
    }
  } catch {
    // Same fail-open contract as the registries above.
  }

  return {
    busy: runningChats + runningDelegations + watcherCycles > 0,
    runningChats,
    runningDelegations,
    watcherCycles,
  };
}
