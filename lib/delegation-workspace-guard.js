/**
 * Workspace write lock and optional process-wide cap. Reviews stay parallel;
 * mutating implement/fix jobs do not share a folder with another parent.
 */

import { delegationController } from './delegation-control.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-key.js';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvAlias } from './env-alias.js';
import { normalizeDelegationAssignment } from './delegation-request.js';
import { isCancelUnconfirmedDelegationSlot, isDelegationSlotOccupied } from './delegation-status.js';
import { loadDelegations } from './persist/delegations-persist.js';
import { isRowInDelegationTree } from './delegation-tree-lock.js';

const WORKSPACE_BUSY_ERROR = 'Another parent already has a mutating job in this workspace.';
const TREE_WORKSPACE_BUSY_ERROR = 'Another job of this delegation tree already has a mutating job in this workspace.';
const GLOBAL_LIMIT_ERROR = 'The process-wide delegation limit is full.';

/**
 * @param {object | null | undefined} blocker
 * @param {{ sameTree?: boolean }} [options]
 * @returns {string}
 */
export function formatWorkspaceBusyError(blocker, options = {}) {
  const base = options.sameTree === true ? TREE_WORKSPACE_BUSY_ERROR : WORKSPACE_BUSY_ERROR;
  const delegationId = String(blocker?.id || '').trim();
  const parentChatId = String(blocker?.parentChatId || '').trim();
  if (!delegationId && !parentChatId) return base;
  const parts = [base];
  if (delegationId) parts.push(`Blocker delegation id: ${delegationId}.`);
  if (parentChatId) parts.push(`Blocker parent chat: ${parentChatId}.`);
  return parts.join(' ');
}

export { normalizeDelegationWorkspaceKey };

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isMutatingDelegationRow(row) {
  return normalizeDelegationAssignment(row?.assignment, row?.executionMode) !== 'review';
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
function occupiesWorkspaceFolderForWriteLock(row) {
  if (isCancelUnconfirmedDelegationSlot(row)) return true;
  return isMutatingDelegationRow(row);
}

/**
 * 0 = unlimited (default, compatible). Set CRETLI_DELEGATION_GLOBAL_LIMIT to a
 * positive integer to cap occupied slots across all parents.
 *
 * @returns {number}
 */
export function readDelegationGlobalLimit(env = process.env) {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_GLOBAL_LIMIT',
    defaultValue: '0',
    env,
  });
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * @param {{
 *   active?: object[],
 *   workspaceFolder?: unknown,
 *   executionFolder?: unknown,
 *   parentChatId?: unknown,
 *   rootDelegationId?: unknown,
 *   incomingAssignment?: unknown,
 *   resumeDelegationId?: unknown,
 * }} input
 * @returns {{ ok: true } | { ok: false, code: string, error: string, blocker?: object }}
 */
export function resolveDelegationWorkspaceWriteConflict(input = {}) {
  const incomingReview = normalizeDelegationAssignment(input.incomingAssignment, 'agent') === 'review';
  if (incomingReview) return { ok: true };
  // The write lock serializes on the runner cwd, not the logical project: two
  // parents in different execution folders do not block each other.
  const executionKey = delegationExecutionKey(input.executionFolder, input.workspaceFolder);
  if (!executionKey) return { ok: true };
  const parentChatId = String(input.parentChatId || '').trim();
  const resumeId = String(input.resumeDelegationId || '').trim();
  const others = (Array.isArray(input.active) ? input.active : []).filter((row) => {
    if (String(row?.status || '') === 'queued') return false;
    if (!isDelegationSlotOccupied(row)) return false;
    if (resumeId && String(row?.id || '').trim() === resumeId) return false;
    if (!occupiesWorkspaceFolderForWriteLock(row)) return false;
    if (delegationExecutionKey(row?.executionFolder, row?.workspaceFolder) !== executionKey) return false;
    // Same-tree rows of another parent and foreign parents both conflict;
    // same-parent rows are serialized by the parent width gate instead.
    return delegationController(row) !== parentChatId;
  });
  if (others.length === 0) return { ok: true };
  // Prefer an in-tree blocker so the message names the tree, not a stranger.
  const blocker = others.find((row) => isRowInDelegationTree(row, input.rootDelegationId)) || others[0];
  const sameTree = isRowInDelegationTree(blocker, input.rootDelegationId);
  return {
    ok: false,
    code: 'workspace_busy',
    error: formatWorkspaceBusyError(blocker, { sameTree }),
    blocker,
  };
}

/**
 * @param {unknown} executionFolder
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
function delegationExecutionKey(executionFolder, workspaceFolder) {
  const execution = normalizeDelegationWorkspaceKey(executionFolder);
  if (execution) return execution;
  return normalizeDelegationWorkspaceKey(workspaceFolder);
}

/**
 * @param {{
 *   active?: object[],
 *   resumeDelegationId?: unknown,
 *   limit?: number,
 * }} input
 * @returns {{ ok: true } | { ok: false, code: string, error: string, blocker?: object }}
 */
export function resolveDelegationGlobalLimit(input = {}) {
  const limit = Number.isFinite(input.limit) ? Number(input.limit) : readDelegationGlobalLimit();
  if (limit <= 0) return { ok: true };
  const resumeId = String(input.resumeDelegationId || '').trim();
  const occupied = (Array.isArray(input.active) ? input.active : []).filter((row) => {
    if (String(row?.status || '') === 'queued') return false;
    if (!isDelegationSlotOccupied(row)) return false;
    if (resumeId && String(row?.id || '').trim() === resumeId) return false;
    return true;
  });
  if (occupied.length < limit) return { ok: true };
  return {
    ok: false,
    code: 'global_limit',
    error: GLOBAL_LIMIT_ERROR,
    blocker: occupied[0],
  };
}

/**
 * @returns {object[]}
 */
export function listOccupiedDelegations() {
  return loadDelegations().filter((row) => {
    if (String(row?.status || '') === 'queued') return false;
    return isDelegationSlotOccupied(row);
  });
}
