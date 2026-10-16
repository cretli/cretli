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
 * `listDelegationsForController` — so a leaf reviewed under a different orchestrator
 * chat is still found (§2.1).
 *
 * State is always recomputed from the current attempts; there is no incremental
 * downgrade. Chronology is the attempt start time (queue time before start),
 * never the job `createdAt`, so a retry that keeps `createdAt` never resurrects
 * a stale PASS (§2.3).
 */

import { listDelegationsForWorkspace } from './persist/delegations-persist.js';
import { loadTodosData } from './persist/todos-persist.js';
import { resolveDataPath } from './runtime-paths.js';
import { normalizeTodoRefId } from './todo-ref.js';
import { decodeModelValue } from './model-catalog.js';
import { listDelegationAttempts } from './delegation-attempt.js';
import {
  DELEGATION_INTERRUPT_CANCEL_UNCONFIRMED,
  DELEGATION_INTERRUPT_REVIEW_CANCEL_STUCK,
  DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED,
  isTerminalDelegationStatus,
  readDelegationSlotHeldBy,
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
 * Baseline-only verify failures behind a gate `passed` (shown, never blocking).
 *
 * @param {object} attempt
 * @returns {number}
 */
function resolveVerifyPreexistingCount(attempt) {
  if (asText(attempt?.verifyResult?.status).toLowerCase() !== 'passed') return 0;
  const list = attempt?.verifyResult?.preexistingFailures;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Reviewer cancelled by the wait limit (REVIEW_REVIEWER_WAIT_MS): a terminal
 * attempt whose cancel cause or interrupt code is `run_deadline_exceeded`,
 * including one that escalated to `cancel_unconfirmed`. Such a reviewer is not
 * usable and is never ignorable (§5.4 `reviewer_timeout`).
 *
 * @param {object} attempt
 * @returns {boolean}
 */
function isReviewerTimedOutAttempt(attempt) {
  if (!isTerminalDelegationStatus(attempt?.status)) return false;
  if (isUserCancelledDelegation(attempt)) return false;
  return asText(attempt?.interruptCode).toLowerCase() === 'run_deadline_exceeded'
    || asText(attempt?.cancelCause).toLowerCase() === 'run_deadline_exceeded';
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
  if (isReviewerTimedOutAttempt(attempt)) return false;
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
  if (classification.timedOut) return false;
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
 * @returns {{ terminal: boolean, cancelled: boolean, infra: boolean, timedOut: boolean, repetitionDegraded: boolean, verdict: string, verifyStatus: string, verifyPreexisting: number, credible: boolean }}
 */
function classifyReviewAttempt(attempt) {
  const terminal = isTerminalDelegationStatus(attempt?.status);
  const cancelled = isUserCancelledDelegation(attempt);
  const infra = isReviewRoundInfraAttempt(attempt);
  const timedOut = isReviewerTimedOutAttempt(attempt);
  const repetitionDegraded = isDelegationReportRepetitionDegraded(attempt?.report, {
    degraded: attempt?.reportDegraded === true,
    reason: '',
  });
  return {
    terminal,
    cancelled,
    infra,
    timedOut,
    repetitionDegraded,
    verdict: resolveDelegationRecordVerdict(attempt),
    verifyStatus: resolveVerifyStatus(attempt),
    verifyPreexisting: resolveVerifyPreexistingCount(attempt),
    credible: terminal && !cancelled && !infra && !timedOut && !repetitionDegraded,
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
 * infra or timed-out attempt (§4.5, C5).
 *
 * @param {{ credible: boolean, infra: boolean, terminal: boolean, cancelled: boolean, verdict: string }} row
 * @returns {boolean}
 */
function hasBlockingVerdict(row) {
  if (!isPersistedBlockingVerdict(row.verdict)) return false;
  if (row.credible) return true;
  // A persisted FAIL/BLOCKED still blocks on an infra or timed-out attempt.
  return (row.infra || row.timedOut) && row.terminal && !row.cancelled;
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
  if (rows.some((row) => row.timedOut && row.terminal)) {
    return { state: 'unknown', reason: 'reviewer_timeout' };
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
  if (everyDecidingPass) {
    const hasPreexisting = deciding.some((item) => item.row.verifyPreexisting > 0);
    return { state: 'passed', reason: hasPreexisting ? 'verify_preexisting_failures' : 'fresh_review' };
  }
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
  if (classification.verifyPreexisting > 0) row.verifyPreexisting = classification.verifyPreexisting;
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
 *   planBoundaryAt?: string,
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
  // A plan review is also tied to the plan revision: the latest markdown change
  // opens a new round like an implement/fix does (§4.3, plan subject only).
  const rawPlanTime = subject === 'plan' ? toTime(input.planBoundaryAt) : NaN;
  const planTime = Number.isFinite(rawPlanTime) ? rawPlanTime : -Infinity;
  const boundaryTime = Math.max(materialTime, planTime);
  const planEditedAfterReview = planTime > reviewTime && !(materialTime > reviewTime);
  const reviewFresh = !!lastReview && boundaryTime <= reviewTime;
  const acceptanceFresh = !!lastAcceptance && boundaryTime <= acceptanceTime;

  // The current round is opened by the latest implement/fix (or plan revision);
  // every subject review started at or after it belongs to that round (§4.3).
  const roundReviews = reviews.filter((descriptor) => {
    if (boundaryTime === -Infinity) return true;
    const time = reviewChronology(descriptor.attempt);
    return !Number.isFinite(time) || time >= boundaryTime;
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
        : (planTime > acceptanceTime && !(materialTime > acceptanceTime)
          ? 'plan_edited_after_review'
          : resolveMaterialReason(lastMaterial, materialTime, acceptanceTime, true));
    } else {
      state = 'none';
      stateReason = 'no_review';
    }
  } else if (boundaryTime > reviewTime) {
    if (acceptanceFresh) {
      state = 'manual';
      stateReason = 'manual_acceptance';
    } else {
      state = 'stale';
      stateReason = planEditedAfterReview
        ? 'plan_edited_after_review'
        : resolveMaterialReason(lastMaterial, materialTime, reviewTime, true);
    }
  } else if (roundResult.state === 'passed') {
    state = 'passed';
    stateReason = roundResult.reason === 'verify_preexisting_failures' ? roundResult.reason : 'fresh_review';
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
    round: planTime > materialTime
      ? {
        index: 0,
        id: `plan:${isoOrEmpty(planTime)}`,
        openedAt: isoOrEmpty(planTime),
        invalidationAt: isoOrEmpty(planTime),
      }
      : lastMaterial
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
      reason: planEditedAfterReview && lastReview
        ? 'plan_edited_after_review'
        : resolveMaterialReason(lastMaterial, materialTime, reviewTime, !!lastReview),
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
 *   planBoundaryAt?: string,
 * }} [input]
 * @returns {{ schemaVersion: number, computedAt: string, code: object, plan: object, other?: object }}
 */
export function buildTodoReviewSnapshot(input = {}) {
  const leafId = normalizeTodoRefId(input.leafId) || asText(input.leafId);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const materialRevision = asText(input.materialRevision);
  const planBoundaryAt = asText(input.planBoundaryAt);
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
    plan: buildSubjectSnapshot({ subject: 'plan', descriptors, acceptances, now, materialRevision, planBoundaryAt }),
  };
  const hasOther = descriptors.some((descriptor) => descriptor.isReview && descriptor.subject === 'other')
    || acceptances.some((acceptance) => acceptance.subject === 'other');
  if (hasOther) {
    snapshot.other = buildSubjectSnapshot({ subject: 'other', descriptors, acceptances, now, materialRevision });
  }
  return snapshot;
}

/**
 * Time of the latest plan markdown change. Taken from the passed todo, or from
 * the todo store on the runtime path (sync hooks only know the todo id). Pure
 * callers that pass `rows` and no plan get no boundary, as before.
 *
 * @param {{ planBoundaryAt?: string, rows?: object[], dataDir?: string }} input
 * @param {object} todo
 * @param {{ workspaceFolder: string, leafId: string }} target
 * @returns {string}
 */
function resolvePlanBoundaryAt(input, todo, target) {
  const explicit = asText(input.planBoundaryAt);
  if (explicit) return explicit;
  const fromTodo = asText(todo?.plan?.markdownUpdatedAt || todo?.plan?.updatedAt);
  if (fromTodo) return fromTodo;
  if (Array.isArray(input.rows) || !target.workspaceFolder || !target.leafId) return '';
  try {
    const items = loadTodosData(input.dataDir || resolveDataPath(), target.workspaceFolder).items;
    const stored = items.find((item) => asText(item?.id) === target.leafId);
    return asText(stored?.plan?.markdownUpdatedAt || stored?.plan?.updatedAt);
  } catch {
    return '';
  }
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
 *   planBoundaryAt?: string,
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
    planBoundaryAt: resolvePlanBoundaryAt(input, todo, { workspaceFolder, leafId }),
  });
}

/**
 * Experimental, disabled-by-default flag for automatic leaf close after a code
 * review PASS. Enabling it requires a contract annex to §12.3/§13 of
 * `docs/todo-review-contract.md`; with the flag off nothing changes.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isTodoLeafAutoCloseEnabled(env = process.env) {
  const raw = asText(env?.CRETLI_TODO_LEAF_AUTO_CLOSE).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Pure close decision for one leaf. Reuses the server-computed `review.code`
 * state (`passed` already means every deciding reviewer PASSed, the verify is
 * satisfied and no implement/fix was queued since the review, §6.1). Plan and
 * `other` subjects are never consulted.
 *
 * `requireImplementer` is set when the Workspace Watcher review gate is active:
 * a PASS without a known implementer is not gate-qualifying (review contract
 * §3.5), so it must not auto-close the leaf either.
 *
 * @param {{ todo?: object, items?: object[], rows?: object[], now?: number, isLiveWorktree?: (todoId: string) => boolean, requireImplementer?: boolean }} [input]
 * @returns {{ eligible: boolean, reason: string }}
 */
export function evaluateTodoLeafAutoClose(input = {}) {
  const todo = input.todo && typeof input.todo === 'object' ? input.todo : null;
  if (!todo) return { eligible: false, reason: 'not_found' };
  if (asText(todo.status) !== 'doing') return { eligible: false, reason: 'not_doing' };
  const id = asText(todo.id);
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.some((row) => asText(row?.parentId) === id)) {
    return { eligible: false, reason: 'not_leaf' };
  }
  if (asText(todo?.integration?.state).toLowerCase() === 'ready') {
    return { eligible: false, reason: 'awaiting_integration' };
  }
  // Worktree-backed leaves get `integration.ready` only at Watcher cycle close,
  // after this PASS (worktree contract §8.12). Refuse on any signal that exists
  // now: a live registry record or a worktree execution mode on the leaf or an
  // ancestor (a manual start keys the record on the tree ROOT).
  const byId = new Map(items.map((row) => [asText(row?.id), row]));
  const seen = new Set();
  for (let node = todo; node && !seen.has(asText(node.id)); node = byId.get(asText(node.parentId))) {
    seen.add(asText(node.id));
    if (asText(node.executionMode).toLowerCase() === 'worktree') {
      return { eligible: false, reason: 'worktree_execution' };
    }
    if (asText(node?.integration?.state).toLowerCase() === 'ready') {
      return { eligible: false, reason: 'awaiting_integration' };
    }
    if (typeof input.isLiveWorktree !== 'function' || input.isLiveWorktree(asText(node.id))) {
      return { eligible: false, reason: 'worktree_execution' };
    }
  }
  const leafId = normalizeTodoRefId(id) || id;
  const rows = (Array.isArray(input.rows) ? input.rows : []).filter((row) => (
    row && typeof row === 'object' && (normalizeTodoRefId(row.leafId) || asText(row.leafId)) === leafId
  ));
  if (rows.some((row) => readDelegationSlotHeldBy(row) === DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED)) {
    return { eligible: false, reason: 'cancel_unconfirmed' };
  }
  const descriptors = collectAttemptDescriptors(rows, leafId);
  if (descriptors.some((d) => !d.isReview && !isTerminalDelegationStatus(d.attempt?.status))) {
    return { eligible: false, reason: 'material_active' };
  }
  const code = buildTodoReviewSnapshot({ leafId, rows, now: input.now }).code;
  if (code.state !== 'passed') return { eligible: false, reason: `review_${code.state}` };
  if (input.requireImplementer === true && code.implementer == null) {
    return { eligible: false, reason: 'no_implementer' };
  }
  if (!code.reviewers.some((reviewer) => reviewer.usable && reviewer.verdict === 'PASS')) {
    return { eligible: false, reason: 'no_usable_pass' };
  }
  return { eligible: true, reason: 'review_passed' };
}
