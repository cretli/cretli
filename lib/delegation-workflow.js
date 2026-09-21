/**
 * Parent-owned multi-harness workflow helpers. The parent still drives each
 * transition; this module stores round/verdict/deadline so a restart does not
 * reset the cap.
 */

import { createHash } from 'node:crypto';
import {
  getDelegationWorkflow,
  loadDelegationWorkflows,
  upsertDelegationWorkflow,
} from './persist/delegation-workflows-persist.js';
import { aggregateReviewFanoutVerdicts, parseDelegationVerdict } from './delegation-verdict.js';

export const DELEGATION_WORKFLOW_DEFAULT_MAX_ROUNDS = 4;

export class DelegationWorkflowConflictError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'DelegationWorkflowConflictError';
    this.code = 'idempotency_conflict';
    this.status = 409;
  }
}

/**
 * @param {unknown} now
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationWorkflowDeadlinePassed(row, now = Date.now()) {
  const deadline = Date.parse(String(row?.deadlineAt || ''));
  if (!Number.isFinite(deadline) || deadline <= 0) return false;
  const stamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return stamp >= deadline;
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function hashDelegationWorkflowFindings(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Omitted optional fields stay distinct from an explicit empty string (keep vs clear).
 *
 * @param {unknown} value
 * @returns {{ omitted: true } | string}
 */
function fingerprintOptionalString(value) {
  if (value === undefined) return { omitted: true };
  return String(value || '').trim();
}

/**
 * @param {{
 *   role?: unknown,
 *   round?: unknown,
 *   maxRounds?: unknown,
 *   lastImplementer?: unknown,
 *   findingsHash?: unknown,
 *   findingsText?: unknown,
 *   lastVerdict?: unknown,
 *   reportText?: unknown,
 *   fanoutVerdicts?: unknown[],
 *   stopReason?: unknown,
 *   clearStop?: boolean,
 *   deadlineAt?: unknown,
 *   materialRevision?: unknown,
 * }} input
 * @returns {string}
 */
export function fingerprintDelegationWorkflowPatch(input = {}) {
  const findingsHash = String(input.findingsHash || '').trim()
    || hashDelegationWorkflowFindings(input.findingsText);
  const payload = {
    role: input.role === undefined ? '' : String(input.role || '').trim(),
    round: input.round === undefined ? '' : Number(input.round),
    maxRounds: input.maxRounds === undefined ? '' : Number(input.maxRounds),
    lastImplementer: input.lastImplementer === undefined ? '' : String(input.lastImplementer || '').trim(),
    findingsHash,
    lastVerdict: input.lastVerdict === undefined ? '' : String(input.lastVerdict || '').trim(),
    reportText: input.reportText == null ? '' : String(input.reportText),
    fanoutVerdicts: Array.isArray(input.fanoutVerdicts) ? input.fanoutVerdicts.map((row) => String(row)) : [],
    stopReason: fingerprintOptionalString(input.stopReason),
    clearStop: input.clearStop === true,
    deadlineAt: fingerprintOptionalString(input.deadlineAt),
    materialRevision: fingerprintOptionalString(input.materialRevision),
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/**
 * @param {unknown} input
 * @returns {string}
 */
function readWorkflowIdempotencyKey(input) {
  if (!input || typeof input !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (input);
  return String(row.idempotencyKey || row.eventId || row.reviewId || '').trim();
}

/**
 * @param {object} current
 * @returns {Record<string, string>}
 */
function readAppliedWorkflowPatches(current) {
  const source = current?.appliedPatches;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return source;
}

/**
 * Replay any previously applied key. Unkeyed patches replay only when they
 * match the last fingerprint (worker deadline/stop updates).
 *
 * @param {object} current
 * @param {string} key
 * @param {string} fingerprint
 * @returns {'apply' | 'replay'}
 */
function inspectWorkflowPatchReplay(current, key, fingerprint) {
  if (key) {
    const stored = String(readAppliedWorkflowPatches(current)[key] || '').trim();
    if (!stored) return 'apply';
    if (stored === fingerprint) return 'replay';
    throw new DelegationWorkflowConflictError(
      'Idempotency key was used with different workflow parameters.',
    );
  }
  const lastFingerprint = String(current.lastPatchFingerprint || '').trim();
  if (lastFingerprint && fingerprint === lastFingerprint) return 'replay';
  return 'apply';
}

/**
 * @param {{
 *   parentChatId?: unknown,
 *   workspaceFolder?: unknown,
 *   role?: unknown,
 *   round?: unknown,
 *   maxRounds?: unknown,
 *   lastImplementer?: unknown,
 *   findingsHash?: unknown,
 *   findingsText?: unknown,
 *   lastVerdict?: unknown,
 *   reportText?: unknown,
 *   fanoutVerdicts?: unknown[],
 *   stopReason?: unknown,
 *   deadlineAt?: unknown,
 *   materialRevision?: unknown,
 *   clearStop?: boolean,
 *   idempotencyKey?: unknown,
 *   eventId?: unknown,
 *   reviewId?: unknown,
 * }} input
 * @returns {object}
 */
export function applyDelegationWorkflowPatch(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const current = getDelegationWorkflow(parentChatId) || {
    parentChatId,
    workspaceFolder: '',
    role: '',
    round: 0,
    maxRounds: DELEGATION_WORKFLOW_DEFAULT_MAX_ROUNDS,
    lastImplementer: '',
    lastReviewer: '',
    findingsHash: '',
    lastVerdict: 'unspecified',
    consecutiveSameFail: 0,
    stopReason: '',
    deadlineAt: '',
    materialRevision: '',
    lastReviewFindingsHash: '',
    lastReviewMaterialRevision: '',
    lastIdempotencyKey: '',
    lastPatchFingerprint: '',
    appliedPatches: {},
    reviewEventCount: 0,
  };
  const key = readWorkflowIdempotencyKey(input);
  const fingerprint = fingerprintDelegationWorkflowPatch(input);
  if (inspectWorkflowPatchReplay(current, key, fingerprint) === 'replay') {
    return { ...current, replayed: true };
  }
  const findingsHash = String(input.findingsHash || '').trim()
    || hashDelegationWorkflowFindings(input.findingsText)
    || String(current.findingsHash || '').trim();
  const verdictProvided = input.lastVerdict !== undefined
    || input.reportText != null
    || (Array.isArray(input.fanoutVerdicts) && input.fanoutVerdicts.length > 0);
  let lastVerdict = String(input.lastVerdict || '').trim();
  if (!lastVerdict && Array.isArray(input.fanoutVerdicts) && input.fanoutVerdicts.length > 0) {
    lastVerdict = aggregateReviewFanoutVerdicts(input.fanoutVerdicts);
  }
  if (!lastVerdict && input.reportText != null) {
    lastVerdict = parseDelegationVerdict(input.reportText);
  }
  if (!lastVerdict) lastVerdict = current.lastVerdict;
  const materialRevision = input.materialRevision !== undefined
    ? String(input.materialRevision || '').trim()
    : String(current.materialRevision || '').trim();
  let consecutiveSameFail = current.consecutiveSameFail;
  let stopReason = input.clearStop === true ? '' : current.stopReason;
  let lastReviewFindingsHash = String(current.lastReviewFindingsHash || '').trim();
  let lastReviewMaterialRevision = String(current.lastReviewMaterialRevision || '').trim();
  if (input.stopReason !== undefined && input.clearStop !== true) {
    stopReason = String(input.stopReason || '').trim();
  }
  if (verdictProvided && lastVerdict === 'FAIL') {
    const sameFindings = Boolean(findingsHash) && findingsHash === lastReviewFindingsHash;
    const sameMaterial = materialRevision === lastReviewMaterialRevision;
    if (sameFindings && sameMaterial) {
      consecutiveSameFail += 1;
    } else {
      consecutiveSameFail = 1;
    }
    if (consecutiveSameFail >= 2 && !stopReason) stopReason = 'same_findings';
    lastReviewFindingsHash = findingsHash;
    lastReviewMaterialRevision = materialRevision;
  } else if (verdictProvided && (lastVerdict === 'PASS' || lastVerdict === 'BLOCKED')) {
    consecutiveSameFail = 0;
  }
  if (verdictProvided && lastVerdict === 'BLOCKED' && !stopReason) stopReason = 'blocked';
  const maxRounds = input.maxRounds !== undefined
    ? Number(input.maxRounds)
    : current.maxRounds;
  const round = input.round !== undefined ? Number(input.round) : current.round;
  if (Number(maxRounds) > 0 && Number(round) >= Number(maxRounds) && !stopReason) {
    stopReason = 'rounds_exhausted';
  }
  if (isDelegationWorkflowDeadlinePassed({
    deadlineAt: input.deadlineAt !== undefined ? input.deadlineAt : current.deadlineAt,
  }) && !stopReason) {
    stopReason = 'deadline';
  }
  const next = upsertDelegationWorkflow({
    ...current,
    parentChatId,
    workspaceFolder: input.workspaceFolder !== undefined
      ? String(input.workspaceFolder || '').trim()
      : current.workspaceFolder,
    role: input.role !== undefined ? String(input.role || '').trim() : current.role,
    round,
    maxRounds,
    lastImplementer: input.lastImplementer !== undefined
      ? String(input.lastImplementer || '').trim()
      : current.lastImplementer,
    lastReviewer: input.lastReviewer !== undefined
      ? String(input.lastReviewer || '').trim()
      : current.lastReviewer,
    findingsHash,
    lastVerdict,
    consecutiveSameFail,
    stopReason,
    deadlineAt: input.deadlineAt !== undefined ? String(input.deadlineAt || '').trim() : current.deadlineAt,
    materialRevision,
    lastReviewFindingsHash,
    lastReviewMaterialRevision,
    lastIdempotencyKey: key,
    lastPatchFingerprint: fingerprint,
    appliedPatches: key
      ? { ...readAppliedWorkflowPatches(current), [key]: fingerprint }
      : readAppliedWorkflowPatches(current),
    reviewEventCount: Number(current.reviewEventCount || 0) + (verdictProvided ? 1 : 0),
  });
  return { ...next, replayed: false };
}

/**
 * @param {{ parentChatId?: unknown, assignment?: unknown, now?: number }} input
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function inspectDelegationWorkflowStart(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  if (!parentChatId) return { ok: true };
  const row = getDelegationWorkflow(parentChatId);
  if (!row) return { ok: true };
  if (isDelegationWorkflowDeadlinePassed(row, input.now)) {
    return {
      ok: false,
      status: 409,
      code: 'workflow_deadline',
      error: 'Workflow deadline has passed. Cancel was requested; wait until slot_occupied is false.',
    };
  }
  const maxRounds = Number(row.maxRounds) || 0;
  const round = Number(row.round) || 0;
  if (maxRounds > 0 && round >= maxRounds) {
    return {
      ok: false,
      status: 409,
      code: 'workflow_rounds_exhausted',
      error: `Workflow round ${round} reached max_rounds ${maxRounds}.`,
    };
  }
  if (String(row.stopReason || '').trim()) {
    return {
      ok: false,
      status: 409,
      code: 'workflow_stopped',
      error: `Workflow is stopped (${row.stopReason}). Clear stop_reason to continue.`,
    };
  }
  return { ok: true };
}

/**
 * @param {number} [now]
 * @returns {object[]}
 */
export function listDelegationWorkflowsPastDeadline(now = Date.now()) {
  return loadDelegationWorkflows().filter((row) => isDelegationWorkflowDeadlinePassed(row, now));
}

export { getDelegationWorkflow };
