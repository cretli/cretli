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
import {
  inferDelegationWorkflowFromHistory,
  isDelegationWorkflowHardStopReason,
  normalizeDelegationWorkflowLeafId,
} from './delegation-workflow-leaf.js';
import { summarizeDelegationWorkflowUsage } from './delegation-workflow-budget.js';
import {
  DELEGATION_OPEN_FINDINGS_MAX,
  mergeDelegationOpenFindings,
} from './delegation-review-gate.js';

export const DELEGATION_WORKFLOW_DEFAULT_MAX_ROUNDS = 4;
/** A `resume_rounds` without an explicit cap grants exactly one more cycle. */
export const DELEGATION_WORKFLOW_RESUME_ROUND_STEP = 1;

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
 *   lastModel?: unknown,
 *   findingsHash?: unknown,
 *   findingsText?: unknown,
 *   lastVerdict?: unknown,
 *   reportText?: unknown,
 *   fanoutVerdicts?: unknown[],
 *   stopReason?: unknown,
 *   clearStop?: boolean,
 *   deadlineAt?: unknown,
 *   materialRevision?: unknown,
 *   leafId?: unknown,
 *   budgetTokens?: unknown,
 *   budgetCostUsd?: unknown,
 *   budget_cost_usd?: unknown,
 *   deadlineCancelKey?: unknown,
 *   deadline_cancel_key?: unknown,
 * }} input
 * @returns {string}
 */
export function fingerprintDelegationWorkflowPatch(input = {}) {
  const findingsHash = String(input.findingsHash || '').trim()
    || hashDelegationWorkflowFindings(input.findingsText !== undefined ? input.findingsText : input.reportText);
  const payload = {
    leafId: normalizeDelegationWorkflowLeafId(input),
    role: input.role === undefined ? '' : String(input.role || '').trim(),
    round: input.round === undefined ? '' : Number(input.round),
    maxRounds: input.maxRounds === undefined ? '' : Number(input.maxRounds),
    lastImplementer: input.lastImplementer === undefined ? '' : String(input.lastImplementer || '').trim(),
    lastModel: input.lastModel === undefined ? '' : String(input.lastModel || '').trim(),
    findingsHash,
    lastVerdict: input.lastVerdict === undefined ? '' : String(input.lastVerdict || '').trim(),
    reportText: input.reportText == null ? '' : String(input.reportText),
    fanoutVerdicts: Array.isArray(input.fanoutVerdicts) ? input.fanoutVerdicts.map((row) => String(row)) : [],
    stopReason: fingerprintOptionalString(input.stopReason),
    clearStop: input.clearStop === true,
    deadlineAt: fingerprintOptionalString(input.deadlineAt),
    materialRevision: fingerprintOptionalString(input.materialRevision),
    budgetTokens: fingerprintOptionalString(input.budgetTokens ?? input.budget_tokens),
    budgetCostUsd: fingerprintOptionalString(input.budgetCostUsd ?? input.budget_cost_usd),
    deadlineCancelKey: fingerprintOptionalString(input.deadlineCancelKey ?? input.deadline_cancel_key),
  };
  // Only recorded when explicitly disabled, so default patches keep their
  // existing fingerprint (no replay conflict for in-flight workflows).
  if (input.countReview === false) payload.countReview = false;
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
 *   lastModel?: unknown,
 *   findingsHash?: unknown,
 *   findingsText?: unknown,
 *   lastVerdict?: unknown,
 *   reportText?: unknown,
 *   fanoutVerdicts?: unknown[],
 *   stopReason?: unknown,
 *   deadlineAt?: unknown,
 *   materialRevision?: unknown,
 *   clearStop?: boolean,
 *   countReview?: boolean,
 *   idempotencyKey?: unknown,
 *   eventId?: unknown,
 *   reviewId?: unknown,
 *   leafId?: unknown,
 *   leaf_id?: unknown,
 *   todoId?: unknown,
 *   todo_id?: unknown,
 *   resumeRounds?: unknown,
 *   resume_rounds?: unknown,
 * }} input
 * @returns {object}
 */
export function applyDelegationWorkflowPatch(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = normalizeDelegationWorkflowLeafId(input);
  const current = getDelegationWorkflow(parentChatId, leafId) || {
    parentChatId,
    leafId,
    workspaceFolder: '',
    role: '',
    round: 0,
    maxRounds: DELEGATION_WORKFLOW_DEFAULT_MAX_ROUNDS,
    lastImplementer: '',
    lastModel: '',
    lastReviewer: '',
    findingsHash: '',
    lastVerdict: 'unspecified',
    consecutiveSameFail: 0,
    stopReason: '',
    deadlineAt: '',
    budgetTokens: 0,
    budgetCostUsd: 0,
    deadlineCancelKey: '',
    materialRevision: '',
    findingsText: '',
    openFindingsText: '',
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
  // `report_text` is the field the parent sends after every child report, so
  // derive findings from it when the explicit summary is missing. Without this
  // fallback the regression gate and `same_findings` never fire in the real
  // flow (the caller is not required to pass `findings_text`).
  const reportFindingsText = input.reportText != null
    ? String(input.reportText).trim().slice(-DELEGATION_OPEN_FINDINGS_MAX)
    : '';
  const findingsHash = String(input.findingsHash || '').trim()
    || hashDelegationWorkflowFindings(input.findingsText !== undefined ? input.findingsText : reportFindingsText)
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
  const findingsTextInput = input.findingsText !== undefined
    ? String(input.findingsText || '').trim()
    : undefined;
  let findingsText = findingsTextInput !== undefined
    ? findingsTextInput
    : String(current.findingsText || '').trim();
  let openFindingsText = String(current.openFindingsText || '').trim();
  // A history-sync patch (`countReview: false`) mirrors an already-recorded
  // verdict onto a fresh round; it must not count as a second review event or
  // a first fix would trip `same_findings` before any new failure.
  const countReview = input.countReview !== false;
  if (verdictProvided && lastVerdict === 'FAIL') {
    if (countReview) {
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
      const effectiveFindingsText = findingsTextInput !== undefined && findingsTextInput
        ? findingsTextInput
        : reportFindingsText;
      if (effectiveFindingsText) {
        findingsText = effectiveFindingsText;
        openFindingsText = mergeDelegationOpenFindings(openFindingsText, effectiveFindingsText, findingsHash);
      }
    }
  } else if (verdictProvided && (lastVerdict === 'PASS' || lastVerdict === 'BLOCKED')) {
    consecutiveSameFail = 0;
    if (lastVerdict === 'PASS') {
      openFindingsText = '';
      findingsText = '';
    }
  }
  if (verdictProvided && lastVerdict === 'BLOCKED' && !stopReason) stopReason = 'blocked';
  const resumeRounds = input.resumeRounds === true || input.resume_rounds === true;
  const hasExplicitMaxRounds = input.maxRounds !== undefined;
  let maxRounds = hasExplicitMaxRounds
    ? Number(input.maxRounds)
    : current.maxRounds;
  let round = input.round !== undefined ? Number(input.round) : current.round;
  if (verdictProvided && lastVerdict === 'PASS') {
    round = 0;
  }
  if (resumeRounds && !hasExplicitMaxRounds) {
    // A resume without an explicit cap must actually lift the soft gate, so
    // grant one more cycle above the highest round already reached.
    maxRounds = Math.max(Number(current.maxRounds) || 0, Number(round) || 0)
      + DELEGATION_WORKFLOW_RESUME_ROUND_STEP;
  }
  if (resumeRounds && (stopReason === 'rounds_exhausted_soft' || stopReason === 'rounds_exhausted')) {
    stopReason = '';
  }
  if (Number(maxRounds) > 0 && Number(round) >= Number(maxRounds) && !stopReason) {
    stopReason = 'rounds_exhausted_soft';
  }
  if (Number(maxRounds) > 0 && Number(round) < Number(maxRounds)
    && (stopReason === 'rounds_exhausted_soft' || stopReason === 'rounds_exhausted')) {
    stopReason = '';
  }
  if (isDelegationWorkflowDeadlinePassed({
    deadlineAt: input.deadlineAt !== undefined ? input.deadlineAt : current.deadlineAt,
  }) && !stopReason) {
    stopReason = 'deadline';
  }
  const nextDeadlineAt = input.deadlineAt !== undefined
    ? String(input.deadlineAt || '').trim()
    : String(current.deadlineAt || '').trim();
  let deadlineCancelKey = input.deadlineCancelKey !== undefined || input.deadline_cancel_key !== undefined
    ? String(input.deadlineCancelKey ?? input.deadline_cancel_key ?? '').trim()
    : String(current.deadlineCancelKey || '').trim();
  if (nextDeadlineAt !== String(current.deadlineAt || '').trim() && input.deadlineCancelKey === undefined
    && input.deadline_cancel_key === undefined) {
    // A moved deadline invalidates the old cancel fence; the worker must be
    // able to request cancel for the new deadline once.
    deadlineCancelKey = '';
  }
  const readBudget = (value, fallback) => {
    if (value === undefined) return Number(fallback) || 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const budgetTokens = readBudget(
    input.budgetTokens ?? input.budget_tokens,
    current.budgetTokens,
  );
  const budgetCostUsd = readBudget(
    input.budgetCostUsd ?? input.budget_cost_usd,
    current.budgetCostUsd,
  );
  const next = upsertDelegationWorkflow({
    ...current,
    parentChatId,
    leafId,
    workspaceFolder: input.workspaceFolder !== undefined
      ? String(input.workspaceFolder || '').trim()
      : current.workspaceFolder,
    role: input.role !== undefined ? String(input.role || '').trim() : current.role,
    round,
    maxRounds,
    lastImplementer: input.lastImplementer !== undefined
      ? String(input.lastImplementer || '').trim()
      : current.lastImplementer,
    lastModel: input.lastModel !== undefined ? String(input.lastModel || '').trim() : current.lastModel,
    lastReviewer: input.lastReviewer !== undefined
      ? String(input.lastReviewer || '').trim()
      : current.lastReviewer,
    findingsHash,
    findingsText,
    openFindingsText,
    lastVerdict,
    consecutiveSameFail,
    stopReason,
    deadlineAt: nextDeadlineAt,
    budgetTokens,
    budgetCostUsd,
    deadlineCancelKey,
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
 * Merge durable workflow with implement→review history when the parent omitted updates.
 *
 * @param {{ parentChatId?: unknown, leafId?: unknown, todoId?: unknown, todo_id?: unknown, leaf_id?: unknown }} input
 * @returns {object | null}
 */
export function resolveDelegationWorkflowRow(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  if (!parentChatId) return null;
  const leafId = normalizeDelegationWorkflowLeafId(input);
  let row = getDelegationWorkflow(parentChatId, leafId);
  const inferred = inferDelegationWorkflowFromHistory({ parentChatId, leafId });
  const storedRound = Number(row?.round) || 0;
  const inferredRound = Number(inferred.round) || 0;
  // Sync up on a new implement/fix cycle, and sync down when the latest review
  // is a PASS: otherwise a stored round from before the PASS would survive
  // forever and the history path would never see the auto-reset. The verdict is
  // only written together with that change, so a parent's own aggregated
  // fan-out verdict is not overwritten while the round is unchanged.
  // A PASS only resets a stale stored round when the PASS is still the latest
  // history event. When a new implement/fix already followed it, inference has
  // moved the round above zero again, and treating that as a reset would make
  // resolve() toggle the round on every call (0 -> 1 -> 0 ...).
  const passReset = inferred.lastVerdict === 'PASS' && inferredRound === 0 && storedRound > 0;
  const upSync = inferredRound > storedRound;
  if (passReset || upSync) {
    /** @type {Record<string, unknown>} */
    const syncPatch = {
      parentChatId,
      leafId,
      round: inferredRound,
      idempotencyKey: `history-sync-${leafId || 'chat'}-r${inferredRound}-n${inferred.reviewEventCount}`,
      // Round/verdict mirror only: this is not a new review event, so it must
      // not increment consecutiveSameFail or rewrite the last-review snapshot.
      countReview: false,
    };
    // A PASS that is already recorded must not zero a freshly-inferred round
    // (the "new cycle after PASS" case), so only write it for a real reset.
    if (passReset || inferred.lastVerdict !== 'PASS') {
      syncPatch.lastVerdict = inferred.lastVerdict;
    }
    row = applyDelegationWorkflowPatch(syncPatch);
  }
  return row || getDelegationWorkflow(parentChatId, leafId);
}

/**
 * @param {{ parentChatId?: unknown, assignment?: unknown, now?: number, leafId?: unknown, todoId?: unknown, todo_id?: unknown, leaf_id?: unknown, resumeRounds?: unknown, resume_rounds?: unknown }} input
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function inspectDelegationWorkflowStart(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  if (!parentChatId) return { ok: true };
  const leafId = normalizeDelegationWorkflowLeafId(input);
  if (input.resumeRounds === true || input.resume_rounds === true) {
    applyDelegationWorkflowPatch({
      parentChatId,
      leafId,
      resumeRounds: true,
      clearStop: true,
      maxRounds: input.maxRounds !== undefined ? Number(input.maxRounds) : undefined,
    });
  }
  const row = resolveDelegationWorkflowRow({ parentChatId, leafId });
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
      error: `Workflow round ${round} reached max_rounds ${maxRounds}. Bump max_rounds or pass resume_rounds to continue.`,
    };
  }
  if (isDelegationWorkflowHardStopReason(row.stopReason)) {
    return {
      ok: false,
      status: 409,
      code: 'workflow_stopped',
      error: `Workflow is stopped (${row.stopReason}). Clear stop_reason to continue.`,
    };
  }
  const budgetBlock = inspectDelegationWorkflowBudget(row, { now: input.now });
  if (budgetBlock) return budgetBlock;
  return { ok: true };
}

/**
 * Cost/token budget gate for one leaf. Only blocks when the ledger actually
 * measured spend at or above the configured cap, so a missing measurement never
 * fabricates a block. Raise or clear `budget_tokens`/`budget_cost_usd` to resume.
 *
 * @param {object} row
 * @param {{ now?: unknown }} [options]
 * @returns {{ ok: false, status: number, code: string, error: string } | null}
 */
function inspectDelegationWorkflowBudget(row, options = {}) {
  const budgetTokens = Number(row?.budgetTokens) || 0;
  const budgetCostUsd = Number(row?.budgetCostUsd) || 0;
  if (budgetTokens <= 0 && budgetCostUsd <= 0) return null;
  const leafId = String(row?.leafId || '').trim();
  if (!leafId) return null;
  const usage = summarizeDelegationWorkflowUsage({
    parentChatId: row.parentChatId,
    leafId,
    now: options.now,
  });
  if (!usage.measured) return null;
  const tokensExceeded = budgetTokens > 0 && usage.tokens >= budgetTokens;
  const costExceeded = budgetCostUsd > 0 && usage.usd >= budgetCostUsd;
  if (!tokensExceeded && !costExceeded) return null;
  return {
    ok: false,
    status: 409,
    code: 'workflow_budget_exhausted',
    error: `Workflow budget exhausted for leaf ${leafId} (tokens ${usage.tokens}/${budgetTokens || '-'}, usd ${usage.usd}/${budgetCostUsd || '-'}). Raise budget_tokens/budget_cost_usd to continue.`,
  };
}

/**
 * @param {number} [now]
 * @returns {object[]}
 */
export function listDelegationWorkflowsPastDeadline(now = Date.now()) {
  return loadDelegationWorkflows().filter((row) => isDelegationWorkflowDeadlinePassed(row, now));
}

/**
 * Past-deadline rows whose cancel was not requested yet. The worker marks
 * `deadlineCancelKey` with the deadline it fenced, so a still-expired leaf is
 * not cancelled again on every tick.
 *
 * @param {number} [now]
 * @returns {object[]}
 */
export function listDelegationWorkflowsPendingDeadlineCancel(now = Date.now()) {
  return listDelegationWorkflowsPastDeadline(now).filter((row) => {
    const deadlineAt = String(row?.deadlineAt || '').trim();
    const fence = String(row?.deadlineCancelKey || '').trim();
    return !deadlineAt || fence !== deadlineAt;
  });
}

export { getDelegationWorkflow };
