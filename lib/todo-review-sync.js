/**
 * Server-side review snapshot computation for a leaf todo
 * (`docs/todo-review-contract.md` §2-§6, §9, §11).
 *
 * The core is pure: `buildTodoReviewSnapshot` takes the already-gathered
 * delegation rows of one logical workspace plus the full leaf id and returns one
 * snapshot per subject (`code`, `plan`, and `other` when it has evidence). It
 * never reads the store, so it is trivial to test and safe to call from a
 * recompute trigger.
 *
 * `computeTodoReviewSnapshotForTodo` is the thin runtime wrapper. It sources the
 * rows with `listDelegationsForWorkspace(row.workspaceFolder)` — never
 * `listDelegationsForParent` — so a leaf reviewed under a different orchestrator
 * chat is still found (§2.1).
 *
 * State is always recomputed from the current attempts; there is no incremental
 * downgrade. Chronology is the attempt start time (queue time before start),
 * never the job `createdAt`, so a retry that keeps `createdAt` never resurrects
 * a stale PASS (§2.3).
 */

import { listDelegationsForWorkspace } from './persist/delegations-persist.js';
import { normalizeTodoRefId } from './todo-ref.js';
import { decodeModelValue } from './model-catalog.js';
import { listDelegationAttempts } from './delegation-attempt.js';
import {
  DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED,
  DELEGATION_INTERRUPT_REVIEW_CANCEL_STUCK,
  isTerminalDelegationStatus,
} from './delegation-status.js';
import {
  delegationCycleRole,
  isStructuredInfraDelegationOutcome,
  isUserCancelledDelegation,
} from './delegation-cycle-classify.js';
import {
  isDelegationReportRepetitionDegraded,
  isUsableDelegationVerdict,
  resolveDelegationRecordVerdict,
} from './delegation-verdict.js';
import { normalizeDelegationReviewSubject } from './delegation-request.js';
import { MAX_ATTEMPT_HISTORY } from './delegation-retention.js';
import {
  TODO_REVIEW_MAX_REVIEWERS,
  TODO_REVIEW_SCHEMA_VERSION,
  classifyTodoReviewIndependence,
  summarizeTodoReviewIndependence,
} from './todo-review-state.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toTime(value) {
  const ms = Date.parse(asText(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function isoOrEmpty(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Chronology key of a review attempt: the start time, falling back to the queue
 * time for a review that is queued but not yet started (§2.3).
 *
 * @param {object} attempt
 * @returns {number}
 */
function reviewChronology(attempt) {
  const started = toTime(attempt?.startedAt);
  if (Number.isFinite(started)) return started;
  return toTime(attempt?.queuedAt);
}

/**
 * Chronology key of an implement/fix attempt: the queue time first, because
 * invalidation happens at queue time (`U5`), falling back to the start time.
 *
 * @param {object} attempt
 * @returns {number}
 */
function materialChronology(attempt) {
  const queued = toTime(attempt?.queuedAt);
  if (Number.isFinite(queued)) return queued;
  return toTime(attempt?.startedAt);
}

/**
 * Stable attempt ordering: time, then `attemptId`, then `delegationId`
 * (ascending, §2.3).
 *
 * @param {(descriptor: object) => number} timeOf
 * @returns {(left: object, right: object) => number}
 */
function compareByChronology(timeOf) {
  return (left, right) => {
    const leftTime = timeOf(left.attempt);
    const rightTime = timeOf(right.attempt);
    const leftValue = Number.isFinite(leftTime) ? leftTime : -Infinity;
    const rightValue = Number.isFinite(rightTime) ? rightTime : -Infinity;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
    const leftAttempt = asText(left.attemptId);
    const rightAttempt = asText(right.attemptId);
    if (leftAttempt !== rightAttempt) return leftAttempt < rightAttempt ? -1 : 1;
    const leftDelegation = asText(left.delegationId);
    const rightDelegation = asText(right.delegationId);
    if (leftDelegation !== rightDelegation) return leftDelegation < rightDelegation ? -1 : 1;
    return 0;
  };
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function baseModelIdOf(model) {
  const decoded = decodeModelValue(model);
  const id = asText(decoded?.modelId).toLowerCase();
  return !id || id === 'auto' ? '' : id;
}

/**
 * Flatten every job of the leaf into one descriptor per attempt.
 *
 * A job participates only when its persisted `leafId` normalizes to the target
 * full id; an empty leaf matches nothing (§2.4). Both implement/fix and review
 * jobs are included; plan-mode review jobs are reviews too, because their
 * subject is `plan` (§3).
 *
 * @param {object[]} rows
 * @param {string} leafId normalized target id
 * @returns {object[]}
 */
function collectAttemptDescriptors(rows, leafId) {
  /** @type {object[]} */
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const rowLeafId = normalizeTodoRefId(row.leafId) || asText(row.leafId);
    if (!rowLeafId || rowLeafId !== leafId) continue;
    const assignment = asText(row.assignment).toLowerCase();
    const role = delegationCycleRole(row);
    const isReview = assignment === 'review' || role === 'review';
    const isMaterial = role === 'implement' || role === 'fix';
    if (!isReview && !isMaterial) continue;
    const archivedCount = Array.isArray(row.attempts) ? row.attempts.length : 0;
    const historyTruncated = archivedCount >= MAX_ATTEMPT_HISTORY;
    for (const attempt of listDelegationAttempts(row)) {
      const safeAttempt = attempt && typeof attempt === 'object' ? attempt : {};
      const subject = isReview
        ? (normalizeDelegationReviewSubject(safeAttempt.reviewSubject) || 'other')
        : '';
      out.push({
        delegationId: asText(row.id),
        leafId: rowLeafId,
        role: isReview ? 'review' : (role === 'fix' ? 'fix' : 'implement'),
        isReview,
        subject,
        subjectSource: asText(safeAttempt.reviewSubjectSource) || 'unknown',
        historyTruncated,
        attemptId: asText(safeAttempt.attemptId),
        attempt: safeAttempt,
      });
    }
  }
  return out;
}

/**
 * Durable human acceptance bound to this attempt (`§7.2`, `§7.3`). A plain
 * `reviewed` ack, an agent accept, or an acceptance without a bound attempt is
 * not manual evidence.
 *
 * @param {object} descriptor
 * @returns {{ actor: string, at: string, delegationId: string, attemptId: string, expectedTodoRevision: string } | null}
 */
function extractAcceptance(descriptor) {
  const attempt = descriptor.attempt;
  const reason = asText(attempt.acknowledgedReason).toLowerCase();
  const actor = asText(attempt.acknowledgedActor).toLowerCase();
  const at = asText(attempt.acknowledgedAt);
  const acknowledgedAttemptId = asText(attempt.acknowledgedAttemptId);
  if (reason !== 'accepted' || actor !== 'human' || !at) return null;
  if (!acknowledgedAttemptId || acknowledgedAttemptId !== asText(descriptor.attemptId)) return null;
  return {
    actor,
    at,
    delegationId: descriptor.delegationId,
    attemptId: descriptor.attemptId,
    expectedTodoRevision: asText(attempt.acknowledgedExpectedTodoRevision),
  };
}

/**
 * @param {object} attempt
 * @returns {boolean}
 */
function verifyRequiredFor(attempt) {
  if (attempt?.verifyRequired === true) return true;
  if (attempt?.verifyRequired === false) return false;
  // Legacy archived snapshots predate the durable flag; `reviewCanRunTests`
  // false implies a parent verify is owed (§4.5).
  return attempt?.reviewCanRunTests === false;
}

/**
 * @param {object} attempt
 * @returns {'passed'|'failed'|'required-missing'|'not-required'|'pending'}
 */
function resolveVerifyStatus(attempt) {
  const status = asText(attempt?.verifyResult?.status).toLowerCase();
  if (status === 'passed' || status === 'failed') return status;
  if (!isTerminalDelegationStatus(attempt?.status)) return 'pending';
  return verifyRequiredFor(attempt) ? 'required-missing' : 'not-required';
}

/**
 * Infrastructure-only review attempt for round settlement (§4.5, §5.3).
 * Only explicit evidence counts: structured infra errors or the narrow
 * `Transport not started` start failure. A failed/interrupted row with an
 * empty report but no error evidence stays unclassified (unknown), and a
 * persisted verdict is never hidden behind an empty report body.
 *
 * @param {object} attempt
 * @returns {boolean}
 */
function isReviewRoundInfraAttempt(attempt) {
  if (isUserCancelledDelegation(attempt)) return false;
  const interrupt = asText(attempt?.interruptCode).toLowerCase();
  if (interrupt === DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED
    || interrupt === DELEGATION_INTERRUPT_REVIEW_CANCEL_STUCK) {
    return true;
  }
  if (isStructuredInfraDelegationOutcome(attempt)) return true;
  return /transport not started/i.test(asText(attempt?.error));
}

/**
 * @param {object} attempt
 * @returns {number | null}
 */
function readReviewAttemptToolCalls(attempt) {
  const metrics = attempt?.metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const raw = metrics.tool_calls_n;
  if (raw == null || raw === '') return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

/**
 * Fan-out participant that must not block a round when siblings PASS (§4.5):
 * infra, or a terminal attempt with zero tool calls and no usable verdict.
 *
 * @param {object} attempt
 * @param {ReturnType<typeof classifyReviewAttempt>} classification
 * @returns {boolean}
 */
function isReviewRoundNonDecidingParticipant(attempt, classification) {
  if (classification.infra) return true;
  if (!classification.terminal) return false;
  if (classification.cancelled) return false;
  if (classification.credible && isUsableDelegationVerdict(classification.verdict)) return false;
  return readReviewAttemptToolCalls(attempt) === 0;
}

/**
 * @param {object} attempt
 * @param {ReturnType<typeof classifyReviewAttempt>} classification
 * @returns {boolean}
 */
function isReviewRoundDecidingParticipant(attempt, classification) {
  return !isReviewRoundNonDecidingParticipant(attempt, classification);
}

/**
 * Structural credibility of one review attempt (§4.5, §5.3). The report body is
 * never consulted for infra: only the persisted verdict and the structured
 * error evidence count. A repetition-degraded report is downgraded; a merely
 * size-truncated report that kept its persisted verdict stays usable.
 *
 * @param {object} attempt
 * @returns {{ terminal: boolean, cancelled: boolean, infra: boolean, repetitionDegraded: boolean, verdict: string, verifyStatus: string, credible: boolean }}
 */
function classifyReviewAttempt(attempt) {
  const terminal = isTerminalDelegationStatus(attempt?.status);
  const cancelled = isUserCancelledDelegation(attempt);
  const infra = isReviewRoundInfraAttempt(attempt);
  const repetitionDegraded = isDelegationReportRepetitionDegraded(attempt?.report, {
    degraded: attempt?.reportDegraded === true,
    reason: '',
  });
  return {
    terminal,
    cancelled,
    infra,
    repetitionDegraded,
    verdict: resolveDelegationRecordVerdict(attempt),
    verifyStatus: resolveVerifyStatus(attempt),
    credible: terminal && !cancelled && !infra && !repetitionDegraded,
  };
}

/**
 * @param {string} verdict
 * @returns {boolean}
 */
function isPersistedBlockingVerdict(verdict) {
  const normalized = String(verdict || '').toUpperCase();
  return normalized === 'FAIL' || normalized === 'BLOCKED';
}

/**
 * Usable FAIL/BLOCKED from a credible reviewer or a persisted verdict on an
 * infra attempt (§4.5, C5).
 *
 * @param {{ credible: boolean, infra: boolean, terminal: boolean, cancelled: boolean, verdict: string }} row
 * @returns {boolean}
 */
function hasBlockingVerdict(row) {
  if (!isPersistedBlockingVerdict(row.verdict)) return false;
  if (row.credible) return true;
  return row.infra && row.terminal && !row.cancelled;
}

/**
 * Credible non-infra reviewers used for independence aggregation (§9.3).
 *
 * @param {object} descriptor
 * @returns {boolean}
 */
function isIndependenceDecidingDescriptor(descriptor) {
  const row = classifyReviewAttempt(descriptor.attempt);
  if (!isReviewRoundDecidingParticipant(descriptor.attempt, row)) return false;
  return row.credible;
}

/**
 * Evaluate the current round's subject reviews (`§4.5`). Ordering of the checks
 * matches the contract table exactly.
 *
 * @param {object[]} reviewers descriptors
 * @returns {{ state: 'pending'|'failed'|'unknown'|'passed', reason: string }}
 */
function evaluateRound(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    return { state: 'unknown', reason: 'no_review' };
  }
  const rows = reviewers.map((descriptor) => classifyReviewAttempt(descriptor.attempt));
  if (reviewers.some((descriptor, index) => (
    isReviewRoundDecidingParticipant(descriptor.attempt, rows[index])
    && !rows[index].terminal
  ))) {
    return { state: 'pending', reason: 'review_in_progress' };
  }
  if (rows.some((row) => hasBlockingVerdict(row) && String(row.verdict || '').toUpperCase() === 'BLOCKED')) {
    return { state: 'failed', reason: 'review_blocked' };
  }
  if (rows.some((row) => hasBlockingVerdict(row) && String(row.verdict || '').toUpperCase() === 'FAIL')) {
    return { state: 'failed', reason: 'review_failed' };
  }
  if (rows.some((row) => row.infra && row.terminal && row.verdict === 'conflict')) {
    return { state: 'unknown', reason: 'no_verdict' };
  }
  if (reviewers.some((descriptor, index) => {
    const row = rows[index];
    if (!isReviewRoundDecidingParticipant(descriptor.attempt, row)) return false;
    return row.credible && (row.verdict === 'conflict' || row.verdict === 'unspecified');
  })) {
    return { state: 'unknown', reason: 'no_verdict' };
  }
  if (reviewers.some((descriptor, index) => {
    const row = rows[index];
    if (!isReviewRoundDecidingParticipant(descriptor.attempt, row)) return false;
    return row.credible && row.verifyStatus === 'failed';
  })) {
    return { state: 'failed', reason: 'verify_failed' };
  }
  if (reviewers.some((descriptor, index) => {
    const row = rows[index];
    if (!isReviewRoundDecidingParticipant(descriptor.attempt, row)) return false;
    return row.credible && row.verifyStatus === 'required-missing';
  })) {
    return { state: 'unknown', reason: 'verify_missing' };
  }
  const participants = reviewers.map((descriptor, index) => ({
    attempt: descriptor.attempt,
    row: rows[index],
    nonDeciding: isReviewRoundNonDecidingParticipant(descriptor.attempt, rows[index]),
  }));
  const deciding = participants.filter((item) => !item.nonDeciding);
  if (deciding.length === 0) {
    return { state: 'unknown', reason: 'review_unknown' };
  }
  if (deciding.some((item) => item.row.cancelled)) {
    return { state: 'unknown', reason: 'review_unknown' };
  }
  const everyDecidingPass = deciding.every((item) => (
    item.row.credible
    && item.row.verdict === 'PASS'
    && (item.row.verifyStatus === 'passed' || item.row.verifyStatus === 'not-required')
  ));
  if (everyDecidingPass) return { state: 'passed', reason: 'fresh_review' };
  return { state: 'unknown', reason: 'review_unknown' };
}

/**
 * @param {object|null} materialDescriptor
 * @param {number} materialTime
 * @param {number} reviewTime
 * @param {boolean} hasReview
 * @returns {string}
 */
function resolveMaterialReason(materialDescriptor, materialTime, reviewTime, hasReview) {
  if (!hasReview) return 'no_review';
  if (!materialDescriptor || !Number.isFinite(materialTime) || materialTime <= reviewTime) return 'fresh_review';
  // Invalidation happens at queue time (U5). Only a job queued before the review
  // but started after it is the "started" variant.
  const queued = toTime(materialDescriptor.attempt?.queuedAt);
  if (!Number.isFinite(queued) || queued > reviewTime) return 'implement_queued_after_review';
  const started = toTime(materialDescriptor.attempt?.startedAt);
  return Number.isFinite(started) && started > reviewTime
    ? 'implement_started_after_review'
    : 'implement_queued_after_review';
}

/**
 * @param {object} descriptor
 * @param {object|null} implementer
 * @returns {object}
 */
function buildReviewerRow(descriptor, implementer) {
  const attempt = descriptor.attempt;
  const classification = classifyReviewAttempt(attempt);
  const model = asText(attempt.model);
  const harness = asText(attempt.transport);
  const verdict = classification.verdict;
  /** @type {Record<string, unknown>} */
  const row = {
    delegationId: descriptor.delegationId,
    attemptId: descriptor.attemptId,
    leafId: descriptor.leafId,
    harness,
    model,
    baseModel: baseModelIdOf(model),
    status: asText(attempt.status).toLowerCase(),
    verdict: isUsableDelegationVerdict(verdict)
      ? verdict
      : (verdict === 'conflict' || verdict === 'unspecified' ? verdict : ''),
    usable: classification.credible
      && isUsableDelegationVerdict(verdict)
      && (classification.verifyStatus === 'passed' || classification.verifyStatus === 'not-required'),
    queuedAt: asText(attempt.queuedAt),
    startedAt: asText(attempt.startedAt),
    finishedAt: asText(attempt.finishedAt),
    verifyStatus: classification.verifyStatus,
  };
  row.independence = classifyTodoReviewIndependence(row, implementer);
  return row;
}

/**
 * Number of implement/fix attempts that started after the latest credible PASS
 * review of the subject (all of them when there was never a PASS).
 *
 * @param {object[]} reviews subject review descriptors
 * @param {object[]} materials implement/fix descriptors
 * @returns {number}
 */
function countMaterialRoundsSinceLastPass(reviews, materials) {
  let lastPassTime = -Infinity;
  for (const descriptor of reviews) {
    const classification = classifyReviewAttempt(descriptor.attempt);
    if (!classification.credible || String(classification.verdict || '').toUpperCase() !== 'PASS') continue;
    const time = reviewChronology(descriptor.attempt);
    if (Number.isFinite(time) && time > lastPassTime) lastPassTime = time;
  }
  if (lastPassTime === -Infinity) return materials.length;
  return materials.filter((descriptor) => {
    const time = materialChronology(descriptor.attempt);
    return Number.isFinite(time) && time > lastPassTime;
  }).length;
}

/**
 * Build one subject snapshot from the leaf's attempts.
 *
 * @param {{
 *   subject: 'code'|'plan'|'other',
 *   descriptors: object[],
 *   acceptances: object[],
 *   now: number,
 *   materialRevision: string,
 * }} input
 * @returns {object}
 */
function buildSubjectSnapshot(input) {
  const { subject, descriptors, acceptances, now, materialRevision } = input;
  const reviews = descriptors
    .filter((descriptor) => descriptor.isReview && descriptor.subject === subject)
    .sort(compareByChronology(reviewChronology));
  const materials = descriptors
    .filter((descriptor) => !descriptor.isReview)
    .sort(compareByChronology(materialChronology));
  const subjectAcceptances = acceptances
    .filter((acceptance) => acceptance.subject === subject)
    .sort((left, right) => {
      const leftTime = toTime(left.at);
      const rightTime = toTime(right.at);
      const leftValue = Number.isFinite(leftTime) ? leftTime : -Infinity;
      const rightValue = Number.isFinite(rightTime) ? rightTime : -Infinity;
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
      const leftAttempt = asText(left.attemptId);
      const rightAttempt = asText(right.attemptId);
      if (leftAttempt !== rightAttempt) return leftAttempt < rightAttempt ? -1 : 1;
      return 0;
    });

  const lastReview = reviews[reviews.length - 1] || null;
  const lastMaterial = materials[materials.length - 1] || null;
  const lastAcceptance = subjectAcceptances[subjectAcceptances.length - 1] || null;
  const rawMaterialTime = lastMaterial ? materialChronology(lastMaterial.attempt) : NaN;
  const rawReviewTime = lastReview ? reviewChronology(lastReview.attempt) : NaN;
  const rawAcceptanceTime = lastAcceptance ? toTime(lastAcceptance.at) : NaN;
  const materialTime = Number.isFinite(rawMaterialTime) ? rawMaterialTime : -Infinity;
  const reviewTime = Number.isFinite(rawReviewTime) ? rawReviewTime : -Infinity;
  const acceptanceTime = Number.isFinite(rawAcceptanceTime) ? rawAcceptanceTime : -Infinity;
  const reviewFresh = !!lastReview && materialTime <= reviewTime;
  const acceptanceFresh = !!lastAcceptance && materialTime <= acceptanceTime;

  // The current round is opened by the latest implement/fix; every subject
  // review started at or after it belongs to that round (§4.3).
  const roundReviews = reviews.filter((descriptor) => {
    if (!lastMaterial) return true;
    const time = reviewChronology(descriptor.attempt);
    return !Number.isFinite(time) || time >= materialTime;
  });

  const implementer = lastMaterial
    ? {
      delegationId: lastMaterial.delegationId,
      attemptId: lastMaterial.attemptId,
      role: lastMaterial.role,
      harness: asText(lastMaterial.attempt.transport),
      model: asText(lastMaterial.attempt.model),
      baseModel: baseModelIdOf(lastMaterial.attempt.model),
      startedAt: asText(lastMaterial.attempt.startedAt),
    }
    : null;

  const reviewerRows = roundReviews.map((descriptor) => buildReviewerRow(descriptor, implementer));
  const reviewersTruncated = reviewerRows.length > TODO_REVIEW_MAX_REVIEWERS;
  const reviewers = reviewersTruncated
    ? reviewerRows.slice(0, TODO_REVIEW_MAX_REVIEWERS)
    : reviewerRows;
  const independenceReviewers = roundReviews
    .filter(isIndependenceDecidingDescriptor)
    .map((descriptor) => buildReviewerRow(descriptor, implementer));
  const independence = summarizeTodoReviewIndependence(independenceReviewers, implementer);

  const roundResult = evaluateRound(roundReviews);
  let state;
  let stateReason;
  if (!lastReview) {
    if (lastAcceptance) {
      state = acceptanceFresh ? 'manual' : 'stale';
      stateReason = acceptanceFresh
        ? 'manual_acceptance'
        : resolveMaterialReason(lastMaterial, materialTime, acceptanceTime, true);
    } else {
      state = 'none';
      stateReason = 'no_review';
    }
  } else if (lastMaterial && materialTime > reviewTime) {
    if (acceptanceFresh) {
      state = 'manual';
      stateReason = 'manual_acceptance';
    } else {
      state = 'stale';
      stateReason = resolveMaterialReason(lastMaterial, materialTime, reviewTime, true);
    }
  } else if (roundResult.state === 'passed') {
    state = 'passed';
    stateReason = 'fresh_review';
  } else if (acceptanceFresh && reviewTime <= acceptanceTime) {
    // No fresh independent PASS, but a durable human acceptance is newer than
    // the latest subject review, so it sets `manual` (§7.4).
    state = 'manual';
    stateReason = 'manual_acceptance';
  } else {
    state = roundResult.state;
    stateReason = roundResult.reason;
  }

  const historyTruncated = reviews.some((descriptor) => descriptor.historyTruncated)
    || subjectAcceptances.some((acceptance) => acceptance.historyTruncated);
  if (historyTruncated) {
    state = 'unknown';
    stateReason = 'history_truncated';
  }
  if (reviewersTruncated) {
    state = 'unknown';
    stateReason = 'reviewer_cap';
  }

  const subjectSource = lastReview
    ? lastReview.subjectSource
    : (subject === 'other' ? 'unknown' : 'default');

  return {
    state,
    stateReason,
    subject,
    subjectSource,
    round: lastMaterial
      ? {
        // Implement/fix rounds since the last usable PASS (§5.1), not the
        // lifetime total of the leaf.
        index: countMaterialRoundsSinceLastPass(reviews, materials),

        id: lastMaterial.attemptId,
        openedAt: isoOrEmpty(materialTime),
        invalidationAt: isoOrEmpty(materialTime),
      }
      : {
        index: 0,
        id: lastReview ? lastReview.attemptId : '',
        openedAt: '',
        invalidationAt: '',
      },
    reviewers,
    reviewerCount: reviewers.length,
    truncated: historyTruncated || reviewersTruncated,
    implementer,
    independence,
    material: {
      current: reviewFresh,
      kind: materialRevision ? 'trusted' : 'unavailable',
      reason: resolveMaterialReason(lastMaterial, materialTime, reviewTime, !!lastReview),
      revision: materialRevision,
    },
    acceptance: lastAcceptance
      ? {
        actor: lastAcceptance.actor,
        at: lastAcceptance.at,
        delegationId: lastAcceptance.delegationId,
        attemptId: lastAcceptance.attemptId,
        expectedTodoRevision: lastAcceptance.expectedTodoRevision || '',
      }
      : null,
    updatedAt: isoOrEmpty(now),
  };
}

/**
 * Pure snapshot builder. `rows` is the delegation slice for the leaf's logical
 * workspace; the function does not read the store.
 *
 * @param {{
 *   leafId?: string,
 *   rows?: object[],
 *   now?: number,
 *   materialRevision?: string,
 * }} [input]
 * @returns {{ schemaVersion: number, computedAt: string, code: object, plan: object, other?: object }}
 */
export function buildTodoReviewSnapshot(input = {}) {
  const leafId = normalizeTodoRefId(input.leafId) || asText(input.leafId);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const materialRevision = asText(input.materialRevision);
  const descriptors = leafId ? collectAttemptDescriptors(rows, leafId) : [];
  /** @type {object[]} */
  const acceptances = [];
  for (const descriptor of descriptors) {
    const acceptance = extractAcceptance(descriptor);
    if (!acceptance) continue;
    acceptances.push({
      ...acceptance,
      subject: descriptor.isReview ? descriptor.subject : 'other',
      historyTruncated: descriptor.historyTruncated,
    });
  }
  /** @type {{ schemaVersion: number, computedAt: string, code: object, plan: object, other?: object }} */
  const snapshot = {
    schemaVersion: TODO_REVIEW_SCHEMA_VERSION,
    computedAt: new Date(now).toISOString(),
    code: buildSubjectSnapshot({ subject: 'code', descriptors, acceptances, now, materialRevision }),
    plan: buildSubjectSnapshot({ subject: 'plan', descriptors, acceptances, now, materialRevision }),
  };
  const hasOther = descriptors.some((descriptor) => descriptor.isReview && descriptor.subject === 'other')
    || acceptances.some((acceptance) => acceptance.subject === 'other');
  if (hasOther) {
    snapshot.other = buildSubjectSnapshot({ subject: 'other', descriptors, acceptances, now, materialRevision });
  }
  return snapshot;
}

/**
 * Runtime wrapper: read the logical workspace's delegations (independent of any
 * `parentChatId`) and build the snapshot. Pass `rows` to stay pure in tests.
 *
 * @param {{
 *   todo?: object,
 *   leafId?: string,
 *   workspaceFolder?: string,
 *   dataDir?: string,
 *   rows?: object[],
 *   now?: number,
 *   materialRevision?: string,
 * }} [input]
 * @returns {{ schemaVersion: number, computedAt: string, code: object, plan: object, other?: object }}
 */
export function computeTodoReviewSnapshotForTodo(input = {}) {
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : {};
  const workspaceFolder = asText(input.workspaceFolder || todo.workspaceFolder);
  const leafId = asText(input.leafId || todo.id);
  const rows = Array.isArray(input.rows)
    ? input.rows
    : listDelegationsForWorkspace(workspaceFolder, input.dataDir ? { dataDir: input.dataDir } : {});
  return buildTodoReviewSnapshot({
    leafId,
    rows,
    now: input.now,
    materialRevision: input.materialRevision,
  });
}
