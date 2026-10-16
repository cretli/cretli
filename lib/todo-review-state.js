/**
 * TODO `review` field vocabulary and stable comparison
 * (`docs/todo-review-contract.md` §3, §4, §5.4-§5.5, §9, §12).
 *
 * The persisted `todo.review` snapshot is server-owned: it carries one
 * independent snapshot per subject (`code`, `plan`, `other`) plus a monotonic
 * `generation` used as a compare-and-set guard and a `decisionKey` that lets a
 * writer decide whether anything decision-relevant actually changed.
 *
 * This module stays pure: it does not import the todo tree, the persistence
 * layer or any runner. Both the persistence normalizer and the review
 * aggregation can import it without pulling either of them in.
 *
 * Independence is derived from `decodeModelValue` (`lib/model-catalog.js`) so a
 * parameterized value (`model::effort=high`) compares by its base model. The
 * contract names `isExcludedDelegationModel` for the same identity check; using
 * the exported decoder directly keeps this vocabulary module free of the heavy
 * `model-role-profiles` dependency graph and is behaviourally equivalent for
 * non-empty, non-`auto` values.
 */

import { createHash } from 'node:crypto';
import { decodeModelValue } from './model-catalog.js';

/** Persisted review snapshot schema version. */
export const TODO_REVIEW_SCHEMA_VERSION = 1;

/** The seven review states (`docs/todo-review-contract.md` §4.1). */
export const TODO_REVIEW_STATES = Object.freeze([
  'none',
  'pending',
  'passed',
  'failed',
  'manual',
  'stale',
  'unknown',
]);

/** Review subjects. `other` is audit-only and never rendered as a badge. */
export const TODO_REVIEW_SUBJECTS = Object.freeze(['code', 'plan', 'other']);

/** How the subject got onto the snapshot. */
export const TODO_REVIEW_SUBJECT_SOURCES = Object.freeze(['explicit', 'default', 'unknown']);

/** Independence classes (`docs/todo-review-contract.md` §9.2). */
export const TODO_REVIEW_INDEPENDENCE_CLASSES = Object.freeze([
  'different_base_model',
  'same_model_other_harness',
  'same_model_same_harness',
  'unknown',
]);

/** Storage safety cap for the durable reviewer list (§5.6). */
export const TODO_REVIEW_MAX_REVIEWERS = 64;

/** @type {Set<string>} */
const TODO_REVIEW_STATE_SET = new Set(TODO_REVIEW_STATES);
/** @type {Set<string>} */
const TODO_REVIEW_SUBJECT_SET = new Set(TODO_REVIEW_SUBJECTS);
/** @type {Set<string>} */
const TODO_REVIEW_SUBJECT_SOURCE_SET = new Set(TODO_REVIEW_SUBJECT_SOURCES);
/** @type {Set<string>} */
const TODO_REVIEW_INDEPENDENCE_SET = new Set(TODO_REVIEW_INDEPENDENCE_CLASSES);
/** @type {Set<string>} */
const INDEPENDENT_CLASSES = new Set(['different_base_model', 'same_model_other_harness']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTodoReviewState(value) {
  return TODO_REVIEW_STATE_SET.has(String(value ?? '').trim());
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTodoReviewSubject(value) {
  return TODO_REVIEW_SUBJECT_SET.has(String(value ?? '').trim());
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTodoReviewSubjectSource(value) {
  return TODO_REVIEW_SUBJECT_SOURCE_SET.has(String(value ?? '').trim());
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTodoReviewIndependenceClass(value) {
  return TODO_REVIEW_INDEPENDENCE_SET.has(String(value ?? '').trim());
}

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
function asNonNegativeInt(value) {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

/**
 * @param {string} cls
 * @returns {boolean}
 */
function isIndependentClass(cls) {
  return INDEPENDENT_CLASSES.has(cls);
}

/**
 * Read one subject snapshot from a todo item.
 *
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {object | null}
 */
export function todoReviewSubjectSnapshot(todo, subject = 'code') {
  const review = todo && typeof todo === 'object' ? todo.review : null;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const snapshot = review[subject];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return snapshot;
}

/**
 * Effective state of one subject. A missing subject is `none` (nothing to
 * review), a malformed state is `unknown` — never a silent `passed`.
 *
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {'none'|'pending'|'passed'|'failed'|'manual'|'stale'|'unknown'}
 */
export function todoReviewStateForSubject(todo, subject = 'code') {
  const snapshot = todoReviewSubjectSnapshot(todo, subject);
  if (!snapshot) return 'none';
  return isTodoReviewState(snapshot.state) ? snapshot.state : 'unknown';
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewPassed(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'passed';
}

/** @param {object | null | undefined} todo */
export function isTodoCodeReviewPassed(todo) {
  return isTodoReviewPassed(todo, 'code');
}

/** @param {object | null | undefined} todo */
export function isTodoPlanReviewPassed(todo) {
  return isTodoReviewPassed(todo, 'plan');
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewFailed(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'failed';
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewPending(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'pending';
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewStale(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'stale';
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewManual(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'manual';
}

/**
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewUnknown(todo, subject = 'code') {
  return todoReviewStateForSubject(todo, subject) === 'unknown';
}

/**
 * True when the round's aggregate independence is one of the independent
 * classes (`docs/todo-review-contract.md` §9.3).
 *
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewIndependent(todo, subject = 'code') {
  const snapshot = todoReviewSubjectSnapshot(todo, subject);
  const cls = asText(snapshot?.independence?.class);
  return isIndependentClass(cls) && snapshot?.independence?.independent === true;
}

/**
 * Full gate predicate for a future review gate: a fresh independent PASS with a
 * known implementer and current material. It is deliberately not used to block
 * `done` in this leaf.
 *
 * @param {object | null | undefined} todo
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isTodoReviewGateQualified(todo, subject = 'code') {
  const snapshot = todoReviewSubjectSnapshot(todo, subject);
  if (!snapshot) return false;
  return snapshot.state === 'passed'
    && isTodoReviewIndependent(todo, subject)
    && snapshot.material?.current === true
    && snapshot.implementer != null;
}

/**
 * Resolve the base model id of a stored model value, stripping parameters and
 * provider aliases. Empty and `auto` values have no comparable base.
 *
 * @param {unknown} modelValue
 * @returns {string}
 */
function resolveReviewBaseModelId(modelValue) {
  const decoded = decodeModelValue(modelValue);
  const id = asText(decoded?.modelId).toLowerCase();
  if (!id || id === 'auto') return '';
  return id;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function resolveHarness(value) {
  return asText(value).toLowerCase();
}

/**
 * @param {object|string|null|undefined} entry
 * @returns {string}
 */
function readEntryModel(entry) {
  if (entry && typeof entry === 'object') return asText(entry.model);
  return asText(entry);
}

/**
 * @param {object|string|null|undefined} entry
 * @returns {string}
 */
function readEntryHarness(entry) {
  if (entry && typeof entry === 'object') {
    return resolveHarness(entry.harness ?? entry.transport);
  }
  return '';
}

/**
 * Classify one reviewer against the round implementer (`docs/todo-review-contract.md` §9.2):
 *
 * - `different_base_model`     — different base model (independent);
 * - `same_model_other_harness` — same base model, different harness (independent);
 * - `same_model_same_harness`  — same base model and harness (not independent);
 * - `unknown`                  — `auto`/empty model, or no implementer.
 *
 * @param {{ model?: unknown, harness?: unknown, transport?: unknown, independence?: unknown } | string | null | undefined} reviewer
 * @param {{ model?: unknown, harness?: unknown, transport?: unknown } | string | null | undefined} implementer
 * @returns {'different_base_model'|'same_model_other_harness'|'same_model_same_harness'|'unknown'}
 */
export function classifyTodoReviewIndependence(reviewer, implementer) {
  if (reviewer && typeof reviewer === 'object' && isTodoReviewIndependenceClass(reviewer.independence)) {
    return String(reviewer.independence).trim();
  }
  const reviewerModel = resolveReviewBaseModelId(readEntryModel(reviewer));
  const implementerModel = resolveReviewBaseModelId(readEntryModel(implementer));
  if (!reviewerModel || !implementerModel) return 'unknown';
  if (reviewerModel !== implementerModel) return 'different_base_model';
  const reviewerHarness = readEntryHarness(reviewer);
  const implementerHarness = readEntryHarness(implementer);
  if (!reviewerHarness || !implementerHarness) return 'unknown';
  return reviewerHarness === implementerHarness ? 'same_model_same_harness' : 'same_model_other_harness';
}

/**
 * Aggregate the independence of a review round (`docs/todo-review-contract.md` §9.3).
 * Every reviewer is classified against the round implementer; the round is
 * independent only when all reviewers are independent and at least one exists.
 *
 * @param {Array<object|string>} reviewers
 * @param {{ model?: unknown, harness?: unknown, transport?: unknown } | string | null | undefined} implementer
 * @returns {{ independent: boolean, class: string, reference: 'implementer'|'none' }}
 */
export function summarizeTodoReviewIndependence(reviewers, implementer) {
  const list = Array.isArray(reviewers) ? reviewers : [];
  if (list.length === 0 || implementer == null) {
    return { independent: false, class: 'unknown', reference: 'none' };
  }
  const classes = list.map((reviewer) => classifyTodoReviewIndependence(reviewer, implementer));
  let cls = 'unknown';
  if (classes.includes('same_model_same_harness')) cls = 'same_model_same_harness';
  else if (classes.includes('same_model_other_harness')) cls = 'same_model_other_harness';
  else if (classes.every((entry) => entry === 'different_base_model')) cls = 'different_base_model';
  return { independent: isIndependentClass(cls), class: cls, reference: 'implementer' };
}

/**
 * @returns {Record<string, number>}
 */
function emptyReviewStateCounts() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const state of TODO_REVIEW_STATES) counts[state] = 0;
  return counts;
}

/**
 * @param {Record<string, number>} counts
 * @param {string} state
 * @returns {void}
 */
function incrementReviewStateCount(counts, state) {
  const key = isTodoReviewState(state) ? state : 'unknown';
  counts[key] = (counts[key] || 0) + 1;
}

/**
 * Derived rollup over direct children (`docs/todo-review-contract.md` §12).
 * It never certifies the container: it only counts each child's own per-subject
 * state.
 *
 * @param {Array<object>} items direct children
 * @returns {{ source: 'children', code: Record<string, number>, plan: Record<string, number>, truncated: boolean, computedAt: string }}
 */
export function aggregateTodoReviewStates(items) {
  const code = emptyReviewStateCounts();
  const plan = emptyReviewStateCounts();
  const list = Array.isArray(items) ? items : [];
  let truncated = false;
  for (const item of list) {
    // `truncated` lives on each per-subject snapshot, not on the container
    // `review` object (`docs/todo-review-contract.md` §5.6, §12.1).
    const codeSnapshot = todoReviewSubjectSnapshot(item, 'code');
    const planSnapshot = todoReviewSubjectSnapshot(item, 'plan');
    if (codeSnapshot?.truncated === true || planSnapshot?.truncated === true) truncated = true;
    incrementReviewStateCount(code, todoReviewStateForSubject(item, 'code'));
    incrementReviewStateCount(plan, todoReviewStateForSubject(item, 'plan'));
  }
  return {
    source: 'children',
    code,
    plan,
    truncated,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Decision-relevant projection of the whole review snapshot. Timestamps,
 * `computedAt`/`updatedAt`, `generation`, free text and the diagnostic material
 * revision are excluded (`docs/todo-review-contract.md` §5.5).
 *
 * @param {unknown} review
 * @returns {object | null}
 */
export function todoReviewDecisionPayload(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const source = /** @type {Record<string, unknown>} */ (review);
  /** @type {Record<string, unknown>} */
  const payload = {
    schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : TODO_REVIEW_SCHEMA_VERSION,
  };
  for (const subject of TODO_REVIEW_SUBJECTS) {
    const snapshot = source[subject];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
    payload[subject] = reviewSnapshotDecisionPayload(snapshot);
  }
  const aggregate = source.aggregate;
  if (aggregate && typeof aggregate === 'object' && !Array.isArray(aggregate)) {
    payload.aggregate = reviewAggregateDecisionPayload(aggregate);
  }
  return payload;
}

/**
 * @param {object} snapshot
 * @returns {object}
 */
function reviewSnapshotDecisionPayload(snapshot) {
  const source = /** @type {Record<string, unknown>} */ (snapshot);
  /** @type {Record<string, unknown>} */
  const payload = {
    state: isTodoReviewState(source.state) ? String(source.state).trim() : 'unknown',
    stateReason: asText(source.stateReason),
    subject: isTodoReviewSubject(source.subject) ? String(source.subject).trim() : 'unknown',
    subjectSource: isTodoReviewSubjectSource(source.subjectSource) ? String(source.subjectSource).trim() : 'unknown',
    round: source.round && typeof source.round === 'object'
      ? {
        index: asNonNegativeInt(/** @type {Record<string, unknown>} */ (source.round).index),
        id: asText(/** @type {Record<string, unknown>} */ (source.round).id),
      }
      : null,
    reviewers: reviewReviewersDecisionPayload(source.reviewers),
    reviewerCount: asNonNegativeInt(source.reviewerCount),
    truncated: source.truncated === true,
    implementer: source.implementer && typeof source.implementer === 'object'
      ? reviewImplementerDecisionPayload(/** @type {Record<string, unknown>} */ (source.implementer))
      : null,
    independence: source.independence && typeof source.independence === 'object'
      ? {
        independent: /** @type {Record<string, unknown>} */ (source.independence).independent === true,
        class: asText(/** @type {Record<string, unknown>} */ (source.independence).class),
        reference: asText(/** @type {Record<string, unknown>} */ (source.independence).reference),
      }
      : null,
    material: source.material && typeof source.material === 'object'
      ? {
        current: /** @type {Record<string, unknown>} */ (source.material).current === true,
        kind: asText(/** @type {Record<string, unknown>} */ (source.material).kind),
        reason: asText(/** @type {Record<string, unknown>} */ (source.material).reason),
      }
      : null,
    acceptance: source.acceptance && typeof source.acceptance === 'object'
      ? {
        actor: asText(/** @type {Record<string, unknown>} */ (source.acceptance).actor),
        delegationId: asText(/** @type {Record<string, unknown>} */ (source.acceptance).delegationId),
        attemptId: asText(/** @type {Record<string, unknown>} */ (source.acceptance).attemptId),
        expectedTodoRevision: asText(/** @type {Record<string, unknown>} */ (source.acceptance).expectedTodoRevision),
      }
      : null,
  };
  return payload;
}

/**
 * @param {unknown} reviewers
 * @returns {Array<object>}
 */
function reviewReviewersDecisionPayload(reviewers) {
  if (!Array.isArray(reviewers)) return [];
  /** @type {Array<object>} */
  const rows = reviewers
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const source = /** @type {Record<string, unknown>} */ (entry);
      return {
        delegationId: asText(source.delegationId),
        attemptId: asText(source.attemptId),
        leafId: asText(source.leafId),
        harness: asText(source.harness),
        model: asText(source.model),
        baseModel: asText(source.baseModel),
        status: asText(source.status),
        verdict: asText(source.verdict),
        usable: source.usable === true,
        verifyStatus: asText(source.verifyStatus),
        ...(Number(source.verifyPreexisting) > 0 ? { verifyPreexisting: Math.floor(Number(source.verifyPreexisting)) } : {}),
        independence: asText(source.independence),
      };
    });
  rows.sort((left, right) => {
    const keyLeft = `${left.delegationId}\u0000${left.attemptId}`;
    const keyRight = `${right.delegationId}\u0000${right.attemptId}`;
    return keyLeft < keyRight ? -1 : keyLeft > keyRight ? 1 : 0;
  });
  return rows;
}

/**
 * @param {Record<string, unknown>} implementer
 * @returns {object}
 */
function reviewImplementerDecisionPayload(implementer) {
  return {
    delegationId: asText(implementer.delegationId),
    attemptId: asText(implementer.attemptId),
    role: asText(implementer.role),
    harness: asText(implementer.harness),
    model: asText(implementer.model),
    baseModel: asText(implementer.baseModel),
  };
}

/**
 * @param {Record<string, unknown>} aggregate
 * @returns {object}
 */
function reviewAggregateDecisionPayload(aggregate) {
  /** @type {Record<string, unknown>} */
  const payload = { source: asText(aggregate.source) };
  for (const subject of ['code', 'plan']) {
    const counts = aggregate[subject];
    if (!counts || typeof counts !== 'object') continue;
    const sourceCounts = /** @type {Record<string, unknown>} */ (counts);
    /** @type {Record<string, number>} */
    const normalized = {};
    for (const state of TODO_REVIEW_STATES) normalized[state] = asNonNegativeInt(sourceCounts[state]);
    payload[subject] = normalized;
  }
  payload.truncated = aggregate.truncated === true;
  return payload;
}

/**
 * Stable, timestamp-free decision key of a review snapshot.
 *
 * @param {unknown} review
 * @returns {string}
 */
export function todoReviewDecisionKey(review) {
  const payload = todoReviewDecisionPayload(review);
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

/**
 * True when two review snapshots are decision-equal, ignoring timestamps,
 * `generation` and diagnostic-only fields. A writer uses this to decide whether
 * anything decision-relevant changed.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function compareTodoReviewSnapshots(left, right) {
  return JSON.stringify(todoReviewDecisionPayload(left)) === JSON.stringify(todoReviewDecisionPayload(right));
}

/**
 * True when two per-subject snapshots are decision-equal (timestamps ignored).
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function compareTodoReviewSubjects(left, right) {
  const leftSnapshot = left && typeof left === 'object' && !Array.isArray(left) ? left : null;
  const rightSnapshot = right && typeof right === 'object' && !Array.isArray(right) ? right : null;
  if (!leftSnapshot || !rightSnapshot) return leftSnapshot === rightSnapshot;
  return JSON.stringify(reviewSnapshotDecisionPayload(leftSnapshot))
    === JSON.stringify(reviewSnapshotDecisionPayload(rightSnapshot));
}
