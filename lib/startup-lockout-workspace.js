/**
 * Logical workspace identity for harness startup-failure lockouts.
 * Usage-limit lockouts stay account-wide; startup lockouts are scoped per
 * logical workspace (worktree execution folders map back to the todo workspace).
 */

import path from 'node:path';
import { workspaceKeyFromCwd } from './persist/todos-persist.js';
import { listWorktreeRecords } from './persist/worktree-registry-persist.js';
import { isStartupFailureLockoutRow } from './delegation-startup-lockout-policy.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWorkspaceFolder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve the logical workspace folder for lockout scoping.
 *
 * @param {{ workspaceFolder?: unknown, executionFolder?: unknown, dataDir?: unknown }} [input]
 * @returns {string}
 */
export function resolveLogicalWorkspaceFolder(input = {}) {
  const executionFolder = normalizeWorkspaceFolder(input.executionFolder);
  const workspaceFolder = normalizeWorkspaceFolder(input.workspaceFolder);
  const dataDir = String(input.dataDir ?? '').trim();
  if (executionFolder && dataDir) {
    for (const record of listWorktreeRecords({ dataDir })) {
      const worktreePath = normalizeWorkspaceFolder(record?.worktreePath);
      if (worktreePath && worktreePath === executionFolder) {
        return normalizeWorkspaceFolder(record.workspaceFolder) || workspaceFolder || executionFolder;
      }
    }
  }
  return workspaceFolder || executionFolder || '';
}

/**
 * @param {{ workspaceFolder?: unknown, executionFolder?: unknown, dataDir?: unknown, workspaceKey?: unknown }} [input]
 * @returns {string|null}
 */
export function resolveStartupLockoutWorkspaceKey(input = {}) {
  const explicit = String(input.workspaceKey ?? '').trim();
  if (explicit) return explicit;
  const folder = resolveLogicalWorkspaceFolder(input);
  if (!folder) return null;
  return workspaceKeyFromCwd(folder);
}

/**
 * @param {object | null | undefined} row
 * @param {string | null | undefined} workspaceKey
 * @returns {boolean}
 */
export function startupLockoutAppliesToWorkspace(row, workspaceKey) {
  if (!isStartupFailureLockoutRow(row)) return true;
  const rowKey = String(row?.workspaceKey || '').trim();
  if (!rowKey) return true;
  const wanted = String(workspaceKey || '').trim();
  if (!wanted) return false;
  return rowKey === wanted;
}

/**
 * @param {object[]} lockouts
 * @param {string | null | undefined} workspaceKey
 * @returns {object[]}
 */
export function filterHarnessUsageLimitsForWorkspace(lockouts, workspaceKey) {
  return (Array.isArray(lockouts) ? lockouts : []).filter((row) => (
    startupLockoutAppliesToWorkspace(row, workspaceKey)
  ));
}
