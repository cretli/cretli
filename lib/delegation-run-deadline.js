/**
 * Per-run time limits: explicit deadlines and role-based defaults from startedAt.
 */

import { readEnvAlias } from './env-alias.js';
import {
  DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
  isActiveDelegationStatus,
} from './delegation-status.js';
import { getDelegationWorkflow } from './delegation-workflow.js';
import { getDelegationById, listActiveDelegations, updateDelegationRecord } from './persist/delegations-persist.js';

export const DELEGATION_CANCEL_CAUSE_RUN_DEADLINE = 'run_deadline_exceeded';

/** Default 20 minutes for review and fix runs. */
export const DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS = 20 * 60 * 1000;
/** Default 40 minutes for implement runs. */
export const DELEGATION_RUN_DEADLINE_IMPLEMENT_MS = 40 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number} 0 disables the default for review/fix.
 */
export function readDelegationRunDeadlineReviewFixMs(env = process.env) {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS',
    defaultValue: String(DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS),
    env,
  });
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DELEGATION_RUN_DEADLINE_REVIEW_FIX_MS;
  return parsed;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {number} 0 disables the default for implement.
 */
export function readDelegationRunDeadlineImplementMs(env = process.env) {
  const raw = readEnvAlias({
    current: 'CRETLI_DELEGATION_RUN_DEADLINE_IMPLEMENT_MS',
    defaultValue: String(DELEGATION_RUN_DEADLINE_IMPLEMENT_MS),
    env,
  });
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DELEGATION_RUN_DEADLINE_IMPLEMENT_MS;
  return parsed;
}

/**
 * @param {object | null | undefined} row
 * @param {Record<string, string | undefined>} [env]
 * @returns {'review' | 'fix' | 'implement'}
 */
export function delegationRunDeadlineRole(row, _env = process.env) {
  const pickRole = String(row?.pickRole || '').trim().toLowerCase();
  if (pickRole === 'fix') return 'fix';
  if (pickRole === 'review') return 'review';
  const assignment = String(row?.assignment || '').trim().toLowerCase();
  if (assignment === 'review') return 'review';
  return 'implement';
}

/**
 * @param {object | null | undefined} row
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function readDefaultRunDeadlineMsForRow(row, env = process.env) {
  const role = delegationRunDeadlineRole(row, env);
  if (role === 'review' || role === 'fix') return readDelegationRunDeadlineReviewFixMs(env);
  return readDelegationRunDeadlineImplementMs(env);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationRunDeadlineAt(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

/**
 * @param {object | null | undefined} row
 * @returns {number | null} epoch ms when the active run must stop, or null when unlimited.
 */
export function resolveEffectiveRunDeadlineEpoch(row) {
  if (!row?.id) return null;
  /** @type {number[]} */
  const explicit = [];
  const stored = normalizeDelegationRunDeadlineAt(row.runDeadlineAt);
  if (stored) {
    const parsed = Date.parse(stored);
    if (Number.isFinite(parsed)) explicit.push(parsed);
  }
  const leafId = String(row.leafId || '').trim();
  const parentChatId = String(row.parentChatId || '').trim();
  if (leafId && parentChatId) {
    const workflow = getDelegationWorkflow(parentChatId, leafId);
    const wfAt = normalizeDelegationRunDeadlineAt(workflow?.deadlineAt);
    if (wfAt) {
      const parsed = Date.parse(wfAt);
      if (Number.isFinite(parsed)) explicit.push(parsed);
    }
  }
  if (explicit.length > 0) return Math.min(...explicit);
  if (row.runDefaultLimitActive !== true) return null;
  const limitMs = readDefaultRunDeadlineMsForRow(row);
  if (limitMs <= 0) return null;
  const started = Date.parse(String(row.startedAt || '').trim());
  if (!Number.isFinite(started)) return null;
  return started + limitMs;
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function runDeadlineCancelFenceKey(row) {
  const epoch = resolveEffectiveRunDeadlineEpoch(row);
  if (!Number.isFinite(epoch)) return '';
  return String(epoch);
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isRunDeadlineExceeded(row, now = Date.now()) {
  const epoch = resolveEffectiveRunDeadlineEpoch(row);
  if (!Number.isFinite(epoch)) return false;
  return now >= epoch;
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isRunDeadlineCancelPending(row) {
  if (!row?.id || !isActiveDelegationStatus(row.status)) return false;
  if (String(row.status || '') === 'cancelling') return false;
  const fence = String(row.runDeadlineCancelKey || '').trim();
  const key = runDeadlineCancelFenceKey(row);
  if (!key) return false;
  return fence !== key;
}

/**
 * @param {number} [now]
 * @returns {object[]}
 */
export function listDelegationsPendingRunDeadlineCancel(now = Date.now()) {
  return listActiveDelegations().filter((row) => {
    if (String(row.status || '') === 'cancelling') return false;
    if (!isRunDeadlineExceeded(row, now)) return false;
    return isRunDeadlineCancelPending(row);
  });
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function shouldFinishCancellingAsRunDeadlineExceeded(row) {
  const cause = String(row?.cancelCause || '').trim().toLowerCase();
  return cause === DELEGATION_CANCEL_CAUSE_RUN_DEADLINE
    || cause === DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED;
}

/**
 * Mark the row and fence before adapter cancel is requested.
 *
 * @param {object} row
 * @param {number} [now]
 * @returns {object | null}
 */
export function markDelegationRunDeadlineCancelRequested(row, _now = Date.now()) {
  if (!row?.id) return null;
  const key = runDeadlineCancelFenceKey(row);
  if (!key) return getDelegationById(row.id) || row;
  const epoch = resolveEffectiveRunDeadlineEpoch(row);
  const message = Number.isFinite(epoch)
    ? `Run exceeded its time limit at ${new Date(epoch).toISOString()}.`
    : 'Run exceeded its time limit.';
  return updateDelegationRecord(row.id, {
    runDeadlineCancelKey: key,
    cancelCause: DELEGATION_CANCEL_CAUSE_RUN_DEADLINE,
    error: message,
  }) || row;
}
