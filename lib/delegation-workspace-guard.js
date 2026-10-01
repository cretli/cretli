/**
 * Workspace write lock and optional process-wide cap. Reviews stay parallel;
 * mutating implement/fix jobs do not share a folder with another parent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readEnvAlias } from './env-alias.js';
import { normalizeDelegationAssignment } from './delegation-request.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { loadDelegations } from './persist/delegations-persist.js';

const WORKSPACE_BUSY_ERROR = 'Another parent already has a mutating job in this workspace.';
const GLOBAL_LIMIT_ERROR = 'The process-wide delegation limit is full.';

/**
 * @param {object | null | undefined} blocker
 * @returns {string}
 */
export function formatWorkspaceBusyError(blocker) {
  const delegationId = String(blocker?.id || '').trim();
  const parentChatId = String(blocker?.parentChatId || '').trim();
  if (!delegationId && !parentChatId) return WORKSPACE_BUSY_ERROR;
  const parts = [WORKSPACE_BUSY_ERROR];
  if (delegationId) parts.push(`Blocker delegation id: ${delegationId}.`);
  if (parentChatId) parts.push(`Blocker parent chat: ${parentChatId}.`);
  return parts.join(' ');
}

/**
 * @param {unknown} folder
 * @returns {string}
 */
export function normalizeDelegationWorkspaceKey(folder) {
  const raw = String(folder || '').trim();
  if (!raw) return '';
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    return raw;
  }
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isMutatingDelegationRow(row) {
  return normalizeDelegationAssignment(row?.assignment, row?.executionMode) !== 'review';
}

/**
 * 0 = unlimited (default, compatible). Set CRETLI_DELEGATION_GLOBAL_LIMIT to a
 * positive integer to cap occupied slots across all parents.
 *
 * @returns {number}
 */
export function readDelegationGlobalLimit() {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_GLOBAL_LIMIT',
    defaultValue: '0',
  });
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * @param {{
 *   active?: object[],
 *   workspaceFolder?: unknown,
 *   parentChatId?: unknown,
 *   incomingAssignment?: unknown,
 *   resumeDelegationId?: unknown,
 * }} input
 * @returns {{ ok: true } | { ok: false, code: string, error: string, blocker?: object }}
 */
export function resolveDelegationWorkspaceWriteConflict(input = {}) {
  const incomingReview = normalizeDelegationAssignment(input.incomingAssignment, 'agent') === 'review';
  if (incomingReview) return { ok: true };
  const workspaceKey = normalizeDelegationWorkspaceKey(input.workspaceFolder);
  if (!workspaceKey) return { ok: true };
  const parentChatId = String(input.parentChatId || '').trim();
  const resumeId = String(input.resumeDelegationId || '').trim();
  const others = (Array.isArray(input.active) ? input.active : []).filter((row) => {
    if (!isDelegationSlotOccupied(row)) return false;
    if (resumeId && String(row?.id || '').trim() === resumeId) return false;
    if (!isMutatingDelegationRow(row)) return false;
    if (normalizeDelegationWorkspaceKey(row?.workspaceFolder) !== workspaceKey) return false;
    return String(row?.parentChatId || '').trim() !== parentChatId;
  });
  if (others.length === 0) return { ok: true };
  const blocker = others[0];
  return {
    ok: false,
    code: 'workspace_busy',
    error: formatWorkspaceBusyError(blocker),
    blocker,
  };
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
  return loadDelegations().filter((row) => isDelegationSlotOccupied(row));
}
