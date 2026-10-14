/**
 * Effective execution settings for one workspace.
 *
 * Precedence per field: saved record (`data/execution-settings.json`) > legacy
 * watcher policy (`policy.executionMode` / `policy.worktree`) > server proposal.
 * Both the Watcher cycle and the manual todo start read through
 * `applyExecutionSettingsToPolicy`, so they can never disagree.
 */

import { getExecutionSettings } from './persist/execution-settings-persist.js';
import { getWorkspaceWatcher } from './persist/workspace-watchers-persist.js';
import { suggestExecutionSettings } from './execution-settings-suggest.js';

const LAYOUT_KEYS = Object.freeze(['root', 'namespace', 'branchPrefix', 'directoryPrefix']);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * Overlay one worktree layer onto another: non-empty strings and any argv
 * array (including an explicit empty one) from `top` win.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} top
 * @returns {Record<string, unknown>}
 */
function mergeWorktree(base, top) {
  const out = { ...base };
  for (const key of LAYOUT_KEYS) {
    if (typeof top[key] === 'string' && top[key].trim()) out[key] = top[key].trim();
  }
  if (Array.isArray(top.prepareCommand)) out.prepareCommand = top.prepareCommand;
  if (['block', 'head', 'snapshot'].includes(String(top.dirtyPolicy))) out.dirtyPolicy = top.dirtyPolicy;
  return out;
}

/**
 * @param {unknown} policy watcher policy (legacy source)
 * @param {unknown} workspaceFolder
 * @param {string} [dataDir]
 * @returns {object} policy copy whose `executionMode` / `worktree` follow the saved settings
 */
export function applyExecutionSettingsToPolicy(policy, workspaceFolder, dataDir) {
  const base = asObject(policy);
  let saved = null;
  try {
    saved = getExecutionSettings(String(workspaceFolder ?? ''), dataDir ? { dataDir } : {});
  } catch {
    saved = null;
  }
  if (!saved) return { ...base };
  const next = { ...base };
  if (saved.executionMode) next.executionMode = saved.executionMode;
  if (saved.worktree) next.worktree = mergeWorktree(asObject(base.worktree), saved.worktree);
  return next;
}

/**
 * Saved + effective + proposal view for the settings API.
 *
 * @param {{ workspaceFolder: string, dataDir?: string }} input
 * @returns {{ saved: object | null, effective: object, proposal: object }}
 */
export function resolveExecutionSettingsView(input) {
  const options = input.dataDir ? { dataDir: input.dataDir } : {};
  const saved = getExecutionSettings(input.workspaceFolder, options);
  let legacy = {};
  try {
    legacy = asObject(getWorkspaceWatcher(input.workspaceFolder, options)?.policy);
  } catch {
    legacy = {};
  }
  const proposal = suggestExecutionSettings(input.workspaceFolder);
  let worktree = mergeWorktree({}, asObject(proposal.worktree));
  worktree = mergeWorktree(worktree, asObject(legacy.worktree));
  worktree = mergeWorktree(worktree, asObject(saved?.worktree));
  const savedMode = saved?.executionMode;
  const legacyMode = ['project', 'worktree'].includes(String(legacy.executionMode)) ? String(legacy.executionMode) : '';
  return {
    saved,
    effective: { executionMode: savedMode || legacyMode || proposal.executionMode, worktree },
    proposal,
  };
}
