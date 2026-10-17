import { applyReviewLessonsFeedback, addReviewLesson, deleteReviewLesson, listReviewLessons, ReviewLessonsError, REVIEW_LESSON_STATUSES, sanitizeLessonPatch, updateReviewLesson } from './persist/review-lessons-persist.js';
import { REVIEW_FINDING_CATEGORIES } from './review-findings-taxonomy.js';
import { assertNotCommittedRuleDuplicate } from './review-lessons-checks.js';
import { getReviewFindingsLedger } from './persist/review-findings-ledger-persist.js';

export { ReviewLessonsError };
export function listLessons(workspaceFolder, options = {}) { return listReviewLessons(workspaceFolder, options); }

/** @param {unknown} value @returns {string} the lower-cased category */
function categoryValue(value) { return String(value ?? '').trim().toLowerCase(); }

/**
 * The category taxonomy is a review policy the store does not know about.
 *
 * @param {unknown} value
 * @returns {string} the accepted category
 */
function assertCategory(value) {
  const category = categoryValue(value);
  if (!REVIEW_FINDING_CATEGORIES.includes(category)) throw new ReviewLessonsError(`category must be one of: ${REVIEW_FINDING_CATEGORIES.join(', ')}`);
  return category;
}

/** @param {unknown} value must be absent or an array of non-empty model ids */
function assertAppliesToModels(value) {
  if (value == null) return;
  if (!Array.isArray(value)) throw new ReviewLessonsError('appliesToModels must be an array of model ids');
  if (value.some((model) => !String(model ?? '').trim())) throw new ReviewLessonsError('appliesToModels entries must be non-empty strings');
}

/** @param {unknown} value must be absent or an array of `{leafId, ledgerKey}` refs */
function assertEvidenceRefs(value) {
  if (value == null) return;
  if (!Array.isArray(value)) throw new ReviewLessonsError('evidence must be an array');
  for (const ref of value) {
    const isObject = ref && typeof ref === 'object' && !Array.isArray(ref);
    if (!isObject || !String(ref.leafId ?? '').trim() || !String(ref.ledgerKey ?? '').trim()) {
      throw new ReviewLessonsError('evidence entries require non-empty leafId and ledgerKey');
    }
  }
}

/** @param {unknown} value must be a string reason code */
function assertRetiredReasonType(value) {
  if (typeof value !== 'string') throw new ReviewLessonsError('retiredReason must be a string');
}

/** @param {unknown} value must be an accepted lesson status */
function assertStatus(value) {
  if (!REVIEW_LESSON_STATUSES.includes(value)) throw new ReviewLessonsError(`status must be one of: ${REVIEW_LESSON_STATUSES.join(', ')}`);
}

/**
 * Suppress rules must point at rejected `false_positive` findings (never P1) and
 * must not carry the security category. A retired suppress row is inert — the
 * feedback transaction never touches it — so its archived evidence is not
 * re-proven; that keeps a legacy row retirable.
 *
 * @param {string} workspaceFolder
 * @param {{ kind?: string, category?: unknown, status?: string, evidence?: unknown }} row
 */
function assertSuppressLesson(workspaceFolder, row) {
  if (row.kind !== 'suppress') return;
  if (categoryValue(row.category) === 'security') throw new ReviewLessonsError('suppress lessons cannot use the security category');
  if (row.status === 'retired') return;
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  if (!evidence.length) throw new ReviewLessonsError('suppress lessons require rejected false_positive evidence');
  assertEvidenceRefs(evidence);
  for (const ref of evidence) {
    const ledger = getReviewFindingsLedger(workspaceFolder, ref.leafId);
    const entry = ledger?.entries?.find((candidate) => candidate.key === ref.ledgerKey);
    if (!entry || entry.outcome !== 'rejected' || entry.rejection?.reason !== 'false_positive' || entry.priority === 'P1') {
      throw new ReviewLessonsError('suppress evidence must be a rejected false_positive finding and cannot be P1');
    }
  }
}

/**
 * Validate a brand-new lesson: the whole row is under the writer's control.
 *
 * @param {string} workspaceFolder
 * @param {object} input
 */
function validateLesson(workspaceFolder, input) {
  assertCategory(input?.category);
  assertAppliesToModels(input?.appliesToModels);
  assertEvidenceRefs(input?.evidence);
  if (input?.retiredReason != null) assertRetiredReasonType(input.retiredReason);
  assertSuppressLesson(workspaceFolder, input || {});
}

/**
 * Validate an update by what the patch touches plus the invariants of the
 * resulting row, never by re-validating unrelated stored fields: a legacy row
 * with an invalid (or absent) category and a malformed `appliesToModels` must
 * still be editable, in particular retirable.
 *
 * @param {string} workspaceFolder
 * @param {object} existing stored row
 * @param {object} safePatch sanitized patch
 * @param {unknown} rawPatch the caller patch, used for store-owned fields
 */
function validateLessonPatch(workspaceFolder, existing, safePatch, rawPatch) {
  if (safePatch.status !== undefined) assertStatus(safePatch.status);
  if (safePatch.category !== undefined) assertCategory(safePatch.category);
  if (safePatch.appliesToModels !== undefined) assertAppliesToModels(safePatch.appliesToModels);
  if (safePatch.retiredReason !== undefined && safePatch.retiredReason !== null) assertRetiredReasonType(safePatch.retiredReason);
  // Evidence is store-owned: a patch never persists it, but an explicitly
  // malformed payload is refused instead of being silently dropped.
  if (rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch) && 'evidence' in rawPatch) assertEvidenceRefs(rawPatch.evidence);
  const merged = { ...existing, ...safePatch };
  assertSuppressLesson(workspaceFolder, merged);
  // Retiring is a state change that must explain itself; an already retired row
  // keeps whatever reason it was stored with.
  if (existing.status !== 'retired' && merged.status === 'retired' && !String(merged.retiredReason ?? '').trim()) {
    throw new ReviewLessonsError('retiredReason is required to retire a lesson');
  }
}

export function addLesson(workspaceFolder, input, options = {}) {
  validateLesson(workspaceFolder, input);
  // `activate` is a transport-only flag: candidate by default, active only when explicitly requested.
  const { activate, ...fields } = input;
  if (activate === true) assertNotCommittedRuleDuplicate(workspaceFolder, fields.text, options);
  return addReviewLesson(workspaceFolder, { ...fields, status: activate === true ? 'active' : 'candidate' }, options);
}
export function updateLesson(workspaceFolder, id, patch, expectedRevision, options = {}) {
  const existing = listReviewLessons(workspaceFolder, options).find((row) => row.id === id);
  if (!existing) throw new ReviewLessonsError('Lesson not found', 'NOT_FOUND');
  const safePatch = sanitizeLessonPatch(patch);
  validateLessonPatch(workspaceFolder, existing, safePatch, patch);
  // Activation is refused when a committed rule already says the same thing.
  if (safePatch.status === 'active' && existing.status !== 'active') assertNotCommittedRuleDuplicate(workspaceFolder, safePatch.text ?? existing.text, options);
  return updateReviewLesson(workspaceFolder, id, safePatch, expectedRevision, options);
}
export function deleteLesson(workspaceFolder, id, options = {}) { return deleteReviewLesson(workspaceFolder, id, options); }

/**
 * Internal API for the feedback subscription: effectiveness counters and
 * automatic demotion/retirement, atomic under the store lock and idempotent per
 * `dedupeKey`. Not reachable from routes, clients or `lesson_update`.
 */
export function applyLessonFeedback(workspaceFolder, dedupeKey, plan, options = {}) { return applyReviewLessonsFeedback(workspaceFolder, dedupeKey, plan, options); }
