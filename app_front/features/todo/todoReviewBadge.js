/**
 * Pure, browser-safe model for the Todo review badge
 * (`docs/todo-review-contract.md` §3, §4, §9, §12).
 *
 * It consumes the read-side review object (`buildTodoReviewReadModel` /
 * `attachTodoReviewReadModels`) and never imports server-only code, so it runs
 * both in the bundler (Lit component) and under `node:test` (the unit test).
 *
 * The snapshot shape (per subject) is:
 *   { state, stateReason, subject, subjectSource, reviewers[], reviewerCount,
 *     independence: { independent, class, reference }, implementer, material,
 *     acceptance, updatedAt }
 *
 * State vocabulary: none | pending | passed | failed | manual | stale | unknown.
 */

import { buildTodoIndex, readTodoParentId } from '../../../lib/todo-tree.js';

/** @type {Record<string, string>} */
const ICON_BY_STATE = {
  passed: 'mdi-check-circle',
  failed: 'mdi-close-circle',
  pending: 'mdi-progress-clock',
  stale: 'mdi-update',
  manual: 'mdi-account-check',
  unknown: 'mdi-help-circle-outline',
  none: 'mdi-circle-outline',
};

/** @type {Record<string, 'success'|'error'|'info'|'warn'|'muted'>} */
const TONE_BY_STATE = {
  passed: 'success',
  failed: 'error',
  pending: 'info',
  stale: 'warn',
  manual: 'success',
  unknown: 'warn',
  none: 'muted',
};

/** States that never render a reviewer/harness in the label. */
const REVIEW_STATES = ['none', 'pending', 'stale', 'manual', 'unknown', 'passed', 'failed'];

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isReviewState(value) {
  return REVIEW_STATES.includes(String(value ?? '').trim());
}

/**
 * @param {unknown} review
 * @param {'code'|'plan'|'other'} [subject]
 * @returns {object | null}
 */
function readSubjectSnapshot(review, subject = 'code') {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const snapshot = review[subject];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return snapshot;
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
function asInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Resolve one review badge descriptor for a subject.
 *
 * @param {object | null | undefined} review read-side review object
 * @param {'code'|'plan'} [subject]
 * @returns {{
 *   subject: 'code'|'plan',
 *   state: string,
 *   tone: 'success'|'error'|'info'|'warn'|'muted',
 *   iconName: string,
 *   labelKey: string,
 *   labelParams: Record<string, string>,
 *   reviewerCount: number,
 *   hasReviewer: boolean,
 *   independenceClass: string,
 *   independenceIndependent: boolean,
 *   noImplementer: boolean,
 *   hasDetails: boolean,
 * }}
 */
export function resolveReviewBadge(review, subject = 'code') {
  const subj = subject === 'plan' ? 'plan' : 'code';
  const snapshot = readSubjectSnapshot(review, subj);
  const rawState = snapshot?.state && isReviewState(snapshot.state)
    ? String(snapshot.state).trim()
    : 'none';
  const tone = TONE_BY_STATE[rawState] || 'muted';
  const iconName = ICON_BY_STATE[rawState] || ICON_BY_STATE.none;
  const reviewers = Array.isArray(snapshot?.reviewers) ? snapshot.reviewers : [];
  const primary = reviewers[0] && typeof reviewers[0] === 'object' ? reviewers[0] : null;
  const reviewerCount = asInt(snapshot?.reviewerCount) || reviewers.length;
  const independenceClass = asText(snapshot?.independence?.class) || 'unknown';
  const independenceIndependent = snapshot?.independence?.independent === true;
  const params = {};
  const harness = primary ? asText(primary.harness) : '';
  const model = primary ? asText(primary.model) : '';
  if (model) params.model = model;
  if (harness) params.harness = harness;
  // Single display token so a label never shows a raw `{model}` placeholder.
  params.reviewer = [harness, model].filter(Boolean).join('/') || '—';
  params.count = String(Math.max(reviewerCount, 1));

  const fanout = reviewerCount > 1 && (rawState === 'passed' || rawState === 'failed');
  let labelKey;
  if (rawState === 'passed') labelKey = `todo.reviewBadge.${subj}.${fanout ? 'passedFanout' : 'passedSingle'}`;
  else if (rawState === 'failed') labelKey = `todo.reviewBadge.${subj}.${fanout ? 'failedFanout' : 'failedSingle'}`;
  else labelKey = `todo.reviewBadge.${subj}.${rawState}`;

  const hasDetails = !!reviewers.length
    || !!snapshot?.implementer
    || !!snapshot?.acceptance
    || rawState !== 'none';

  return {
    subject: subj,
    state: rawState,
    tone,
    iconName,
    labelKey,
    labelParams: params,
    reviewerCount,
    hasReviewer: !!primary,
    independenceClass,
    independenceIndependent,
    // A code PASS with no implementer to compare against is not gate-quality
    // evidence (contract §3.5): render an explicit marker, never a bare PASS.
    noImplementer: subj === 'code'
      && (rawState === 'passed' || rawState === 'failed')
      && !snapshot?.implementer,
    hasDetails,
  };
}

/**
 * Independence marker text next to the badge (contract §9.2): only the two
 * same-base-model classes get a marker, because `different_base_model` is the
 * default independent case and needs no annotation.
 *
 * @param {string} independenceClass
 * @returns {string | null} i18n key, or null when no marker is needed
 */
export function resolveIndependenceMarkerKey(independenceClass) {
  const cls = String(independenceClass || '').trim();
  if (cls === 'same_model_other_harness') return 'todo.reviewIndependence.sameModelOtherHarness';
  if (cls === 'same_model_same_harness') return 'todo.reviewIndependence.sameModelSameHarness';
  return null;
}

/**
 * Per-subject summary suitable for a compact list row. Containers have no own
 * per-subject state, so they return `null` and the panel renders the aggregate
 * instead (contract §12.2).
 *
 * @param {object | null | undefined} review
 * @returns {{ code: object|null, plan: object|null }}
 */
export function resolveRowReviewBadges(review) {
  const code = readSubjectSnapshot(review, 'code') ? resolveReviewBadge(review, 'code') : null;
  const plan = readSubjectSnapshot(review, 'plan') ? resolveReviewBadge(review, 'plan') : null;
  return { code, plan };
}

/**
 * Human-readable verdict token for a reviewer row (details panel).
 *
 * @param {unknown} verdict
 * @returns {string} i18n key
 */
export function resolveVerdictKey(verdict) {
  const v = String(verdict || '').trim().toUpperCase();
  if (v === 'PASS') return 'todo.reviewVerdict.pass';
  if (v === 'FAIL') return 'todo.reviewVerdict.fail';
  if (v === 'BLOCKED') return 'todo.reviewVerdict.blocked';
  if (v === 'CONFLICT') return 'todo.reviewVerdict.conflict';
  if (v === 'UNSPECIFIED') return 'todo.reviewVerdict.unspecified';
  return 'todo.reviewVerdict.none';
}

/**
 * Human-readable verify status token for a reviewer row (details panel).
 *
 * @param {unknown} status
 * @returns {string} i18n key
 */
export function resolveVerifyStatusKey(status) {
  const s = String(status || '').trim();
  if (s === 'passed') return 'todo.reviewVerify.passed';
  if (s === 'failed') return 'todo.reviewVerify.failed';
  if (s === 'required-missing') return 'todo.reviewVerify.missing';
  if (s === 'not-required') return 'todo.reviewVerify.notRequired';
  if (s === 'pending') return 'todo.reviewVerify.pending';
  return 'todo.reviewVerify.unknown';
}

/**
 * Resolve the delegation-report link state for one reviewer (contract §11.3).
 * The read surface may either attach a precomputed `reportLinkState` on the
 * reviewer row, or the UI resolves it from a fetched delegation. When neither is
 * available the link is rendered as "unavailable" rather than guessed.
 *
 * @param {object} reviewer
 * @param {Record<string, string>} [resolved] states resolved on click, by delegation id
 * @returns {string} one of available|report_missing|report_trimmed|chat_deleted|delegation_missing|unavailable
 */
export function resolveReviewerReportLinkState(reviewer, resolved = {}) {
  const row = reviewer && typeof reviewer === 'object' ? reviewer : {};
  const known = ['available', 'report_missing', 'report_trimmed', 'chat_deleted', 'delegation_missing'];
  const id = asText(row.delegationId);
  const fromClick = id && resolved && typeof resolved === 'object' ? asText(resolved[id]) : '';
  if (known.includes(fromClick)) return fromClick;
  const state = asText(row.reportLinkState);
  if (known.includes(state)) return state;
  // Not resolved yet (the list read never computes it, §11.3): never guess
  // "available" — the click resolves it.
  return 'unavailable';
}

/**
 * Whether a leaf row shows a review badge at all (contract §7.6, §12.2).
 *
 * A `done` leaf always shows one — "no review" included, so a human-closed task
 * is visibly different from a reviewed one. A non-`done` leaf stays quiet until
 * some review evidence exists, which keeps ready/idea rows free of noise.
 *
 * @param {object | null | undefined} item
 * @returns {boolean}
 */
export function shouldShowLeafReviewBadge(item) {
  if (String(item?.status || '') === 'done') return true;
  const review = item?.review;
  return ['code', 'plan'].some((subject) => {
    const state = readSubjectSnapshot(review, subject)?.state;
    return isReviewState(state) && state !== 'none';
  });
}

/**
 * Derived rollup badge for a container (contract §12). It never reports a
 * single `passed` for the container: it counts direct children with review
 * evidence out of all direct children.
 *
 * @param {object | null | undefined} review
 * @returns {{
 *   reviewed: number, total: number, tone: 'success'|'error'|'warn'|'muted',
 *   iconName: string, counts: Record<string, number>, plan: Record<string, number>,
 *   truncated: boolean,
 * } | null} null when the item has no aggregate (a leaf)
 */
export function resolveAggregateReviewBadge(review) {
  const aggregate = review && typeof review === 'object' ? review.aggregate : null;
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) return null;
  /** @param {unknown} raw */
  const toCounts = (raw) => {
    const out = {};
    for (const state of REVIEW_STATES) {
      out[state] = raw && typeof raw === 'object' ? asInt(raw[state]) : 0;
    }
    return out;
  };
  const counts = toCounts(aggregate.code);
  const plan = toCounts(aggregate.plan);
  const total = REVIEW_STATES.reduce((sum, state) => sum + counts[state], 0);
  if (!total) return null;
  const reviewed = total - counts.none;
  let tone = 'muted';
  if (counts.failed > 0) tone = 'error';
  else if (counts.stale > 0 || counts.unknown > 0) tone = 'warn';
  else if (reviewed === total) tone = 'success';
  const iconName = tone === 'error'
    ? ICON_BY_STATE.failed
    : tone === 'warn' ? ICON_BY_STATE.stale : tone === 'success' ? ICON_BY_STATE.passed : ICON_BY_STATE.none;
  return { reviewed, total, tone, iconName, counts, plan, truncated: aggregate.truncated === true };
}

/** List filters the Todo panel offers (value `''` = no review filter). */
export const REVIEW_LIST_FILTERS = Object.freeze(['none', 'stale']);

/**
 * @param {unknown} value
 * @returns {'' | 'none' | 'stale'}
 */
export function parseReviewListFilter(value) {
  const key = String(value || '').trim();
  return REVIEW_LIST_FILTERS.includes(key) ? /** @type {'none'|'stale'} */ (key) : '';
}

/**
 * Keep the leaves whose review state matches the filter plus their ancestors,
 * so the tree stays navigable. Containers never match on their own.
 *
 * - `none`  : code review state is `none` (the "no review" badge).
 * - `stale` : the code or plan review is `stale`.
 *
 * @param {object[] | null | undefined} items
 * @param {unknown} filter
 * @returns {object[]}
 */
export function filterTodoItemsByReviewState(items, filter) {
  const list = Array.isArray(items) ? items : [];
  const key = parseReviewListFilter(filter);
  if (!key) return list;
  const byId = buildTodoIndex(list);
  const parentIds = new Set();
  for (const item of list) {
    const parentId = readTodoParentId(item);
    if (parentId && byId.has(parentId)) parentIds.add(parentId);
  }
  /** @param {object} item */
  const matches = (item) => {
    const code = asText(readSubjectSnapshot(item?.review, 'code')?.state) || 'none';
    const plan = asText(readSubjectSnapshot(item?.review, 'plan')?.state) || 'none';
    return key === 'none' ? code === 'none' : code === 'stale' || plan === 'stale';
  };
  const keep = new Set();
  for (const item of list) {
    const id = asText(item?.id);
    if (!id || parentIds.has(id) || !matches(item)) continue;
    let cursor = item;
    const guard = new Set();
    while (cursor && !guard.has(asText(cursor.id))) {
      guard.add(asText(cursor.id));
      keep.add(asText(cursor.id));
      const parentId = readTodoParentId(cursor);
      cursor = parentId ? byId.get(parentId) : null;
    }
  }
  return list.filter((item) => keep.has(asText(item?.id)));
}

/**
 * Map a delegation-ack rejection code to an i18n key so the card can explain a
 * stale acceptance instead of showing a bare HTTP error (contract §7.3).
 *
 * @param {unknown} result api response of the accept call
 * @returns {string} i18n key
 */
export function resolveAcceptErrorKey(result) {
  const code = String(result?.code || '').trim();
  if (code === 'ack_attempt_mismatch') return 'chat.delegationAcceptStaleAttempt';
  if (code === 'ack_material_mismatch') return 'chat.delegationAcceptStaleMaterial';
  if (code === 'ack_todo_revision_mismatch' || code === 'ack_todo_unavailable') return 'chat.delegationAcceptStaleTodo';
  if (code === 'accept_expectation_required') return 'chat.delegationAcceptContextMissing';
  return 'chat.delegationAcceptFailed';
}
