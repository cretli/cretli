/**
 * Read helpers for the server-owned `todo.review` snapshot
 * (`docs/todo-review-contract.md` §5.4, §10.6, §12).
 *
 * The durable snapshot is computed and written by `lib/todo-review-sync.js` /
 * `lib/persist/todos-persist.js`. This module only projects that stored value
 * for the read surfaces (`todo_list`, `todo_show`, `GET /api/todos`); it never
 * recomputes states and never writes.
 *
 * The one thing a read surface does derive is the container rollup: a persisted
 * per-subject snapshot belongs to the leaf itself, so the parent/root aggregate
 * is counted from the direct children the caller already has in hand
 * (`aggregateTodoReviewStates`). That keeps the rollup off the delegation store
 * and out of the hot write path.
 */

import {
  TODO_REVIEW_SCHEMA_VERSION,
  TODO_REVIEW_STATES,
  TODO_REVIEW_SUBJECTS,
  aggregateTodoReviewStates,
  isTodoReviewState,
  todoReviewStateForSubject,
  todoReviewSubjectSnapshot,
} from './todo-review-state.js';

/** States usable as a `review` list filter. */
export const TODO_REVIEW_FILTER_STATES = TODO_REVIEW_STATES;

/** Subjects a `review` list filter can target. */
export const TODO_REVIEW_FILTER_SUBJECTS = Object.freeze(['code', 'plan', 'other']);

/**
 * Behaviour of the "open the delegation report" link carried by a review
 * reviewer row, defined once so the read surfaces and the UI agree
 * (`docs/todo-review-contract.md` §5.1, §11).
 *
 * - `available`          — the report body is present and the owning chat exists.
 * - `report_missing`     — the job has no report body (never ran / still running).
 * - `report_trimmed`     — retention archived the job and cut its `report`
 *                          (`applyDelegationRetention`, `lib/delegation-retention.js`).
 *                          The link still opens the (partial) retained report and
 *                          the UI must label it as trimmed.
 * - `chat_deleted`       — the delegation's chat no longer exists, so there is no
 *                          card/report page to open. The reviewer identity and
 *                          verdict stay visible; only the link is disabled.
 * - `delegation_missing` — the referenced delegation record is gone entirely.
 *
 * A retained/trimmed report is never silently dropped from the review block:
 * the reviewer row stays, and the link state carries the reason.
 */
export const TODO_REVIEW_REPORT_LINK_STATES = Object.freeze([
  'available',
  'report_missing',
  'report_trimmed',
  'chat_deleted',
  'delegation_missing',
]);

/**
 * Retention truncates an archived report to this many characters
 * (`applyDelegationRetention`). Kept local so this read module does not import
 * the runner-side retention module.
 */
const RETENTION_REPORT_MAX = 2000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Resolve the delegation-report link state for one reviewer.
 *
 * `chatExists` and `delegationExists` are supplied by the caller because the
 * persisted `todo.review` snapshot intentionally stores no chat id and no report
 * body (contract §5.4). When a caller has no evidence either way it should leave
 * them undefined; the helper then conservatively treats the chat as present so a
 * live report is not hidden by a missing probe.
 *
 * @param {{
 *   delegation?: object | null,
 *   chatExists?: boolean,
 *   delegationExists?: boolean,
 * }} [input]
 * @returns {'available'|'report_missing'|'report_trimmed'|'chat_deleted'|'delegation_missing'}
 */
export function resolveTodoReviewReportLinkState(input = {}) {
  if (input.delegationExists === false) return 'delegation_missing';
  const delegation = input.delegation && typeof input.delegation === 'object' ? input.delegation : null;
  if (!delegation) return 'delegation_missing';
  if (input.chatExists === false) return 'chat_deleted';
  const report = asText(delegation.report);
  if (!report) return 'report_missing';
  const archivedAt = asText(delegation.archivedAt);
  return archivedAt && report.length >= RETENTION_REPORT_MAX ? 'report_trimmed' : 'available';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTodoReviewFilterState(value) {
  return isTodoReviewState(value);
}

/**
 * Parse an optional `review` list filter. Accepts a bare state (`passed`) which
 * targets the code subject, or an explicit `subject:state` (`plan:none`).
 *
 * @param {unknown} value
 * @returns {{ ok: true, subject: 'code'|'plan'|'other', state: string } | { ok: false, message: string }}
 */
export function parseTodoReviewFilter(value) {
  const raw = asText(value).toLowerCase();
  if (!raw) return { ok: true, subject: 'code', state: '' };
  const separator = raw.indexOf(':');
  let subject = 'code';
  let state = raw;
  if (separator >= 0) {
    subject = raw.slice(0, separator).trim();
    state = raw.slice(separator + 1).trim();
  }
  if (!TODO_REVIEW_FILTER_SUBJECTS.includes(subject)) {
    return {
      ok: false,
      message: `Invalid review subject "${subject}" (expected ${TODO_REVIEW_FILTER_SUBJECTS.join(', ')})`,
    };
  }
  if (!isTodoReviewFilterState(state)) {
    return {
      ok: false,
      message: `Invalid review state "${state}" (expected ${TODO_REVIEW_FILTER_STATES.join(', ')})`,
    };
  }
  return { ok: true, subject, state };
}

/**
 * True when a leaf matches a parsed review filter. A container has no own
 * per-subject state, so it never matches a review filter
 * (`docs/todo-review-contract.md` §12.2).
 *
 * @param {object} item
 * @param {boolean} isContainer
 * @param {{ subject?: string, state?: string }} filter
 * @returns {boolean}
 */
export function todoReviewMatchesFilter(item, isContainer, filter = {}) {
  const state = asText(filter.state).toLowerCase();
  if (!state) return true;
  if (isContainer) return false;
  return todoReviewStateForSubject(item, asText(filter.subject) || 'code') === state;
}

/**
 * Compact per-subject review summary for a list row
 * (`docs/todo-review-contract.md` §10.6). New keys are additive; existing keys
 * are untouched.
 *
 * A leaf with no stored snapshot reports `none` (nothing to review), never
 * `unknown`. A container reports empty review fields because its badge is the
 * derived aggregate, not its own state.
 *
 * @param {object} item
 * @param {{ isContainer?: boolean }} [options]
 * @returns {{
 *   review_state: string,
 *   review_plan_state: string,
 *   review_reviewer: { harness: string, model: string, count: number } | null,
 *   review_independence: string,
 * }}
 */
export function summarizeTodoReviewForList(item, options = {}) {
  if (options.isContainer === true) {
    return {
      review_state: '',
      review_plan_state: '',
      review_reviewer: null,
      review_independence: '',
    };
  }
  const codeSnapshot = todoReviewSubjectSnapshot(item, 'code');
  const reviewers = Array.isArray(codeSnapshot?.reviewers) ? codeSnapshot.reviewers : [];
  const first = reviewers[0] && typeof reviewers[0] === 'object' ? reviewers[0] : null;
  const count = Number.isInteger(codeSnapshot?.reviewerCount)
    ? codeSnapshot.reviewerCount
    : reviewers.length;
  return {
    review_state: todoReviewStateForSubject(item, 'code'),
    review_plan_state: todoReviewStateForSubject(item, 'plan'),
    review_reviewer: first
      ? {
        harness: asText(first.harness),
        model: asText(first.model),
        count,
      }
      : null,
    review_independence: asText(codeSnapshot?.independence?.class) || 'unknown',
  };
}

/**
 * @param {string} subject
 * @returns {object}
 */
function emptySubjectSnapshot(subject) {
  return {
    state: 'none',
    stateReason: 'no_review',
    subject,
    subjectSource: subject === 'other' ? 'unknown' : 'default',
  };
}

/**
 * Full per-subject block for a detail read (`todo_show`, REST item). Always
 * exposes `code` and `plan`; `other` only when the snapshot carried it. When
 * `children` is non-empty the derived `aggregate` rollup is attached. `aggregate`
 * never certifies the container and never carries `reviewers[]`.
 *
 * @param {object} item
 * @param {{ children?: object[] }} [options]
 * @returns {object}
 */
export function buildTodoReviewReadModel(item, options = {}) {
  const stored = item && typeof item === 'object' && item.review && typeof item.review === 'object'
    && !Array.isArray(item.review)
    ? item.review
    : null;
  /** @type {Record<string, unknown>} */
  const out = {
    schemaVersion: Number.isInteger(stored?.schemaVersion)
      ? stored.schemaVersion
      : TODO_REVIEW_SCHEMA_VERSION,
    generation: Number.isInteger(stored?.generation) && stored.generation >= 0 ? stored.generation : 0,
  };
  for (const subject of TODO_REVIEW_SUBJECTS) {
    const snapshot = stored?.[subject];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      if (subject === 'other') continue;
      out[subject] = emptySubjectSnapshot(subject);
      continue;
    }
    out[subject] = { ...snapshot };
  }
  for (const key of ['computedAt', 'updatedAt', 'decisionKey']) {
    const value = asText(stored?.[key]);
    if (value) out[key] = value;
  }
  const children = Array.isArray(options.children) ? options.children : [];
  if (children.length > 0) {
    out.aggregate = aggregateTodoReviewStates(children);
  }
  return out;
}

/**
 * Attach the compact review summary and the full read block to every item of a
 * list, deriving container-ness from the direct parent links so no extra store
 * read is needed.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
export function attachTodoReviewReadModels(items) {
  const list = Array.isArray(items) ? items : [];
  /** @type {Set<string>} */
  const containerIds = new Set();
  /** @type {Map<string, object[]>} */
  const childrenByParent = new Map();
  for (const item of list) {
    const parentId = asText(item?.parentId);
    if (!parentId) continue;
    containerIds.add(parentId);
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(item);
    else childrenByParent.set(parentId, [item]);
  }
  return list.map((item) => {
    const id = asText(item?.id);
    const isContainer = containerIds.has(id);
    const summary = summarizeTodoReviewForList(item, { isContainer });
    const children = childrenByParent.get(id) || [];
    return {
      ...item,
      ...summary,
      review: buildTodoReviewReadModel(item, { children }),
    };
  });
}
