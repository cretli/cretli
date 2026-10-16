import { applyReviewLessonsFeedback, addReviewLesson, deleteReviewLesson, listReviewLessons, ReviewLessonsError, sanitizeLessonPatch, updateReviewLesson } from './persist/review-lessons-persist.js';
import { REVIEW_FINDING_CATEGORIES } from './review-findings-taxonomy.js';
import { assertNotCommittedRuleDuplicate } from './review-lessons-checks.js';
import { getReviewFindingsLedger } from './persist/review-findings-ledger-persist.js';

export { ReviewLessonsError };
export function listLessons(workspaceFolder, options = {}) { return listReviewLessons(workspaceFolder, options); }
function validateLesson(workspaceFolder, input) {
  const category = String(input?.category || '').toLowerCase();
  if (!REVIEW_FINDING_CATEGORIES.includes(category)) throw new ReviewLessonsError(`category must be one of: ${REVIEW_FINDING_CATEGORIES.join(', ')}`);
  if (input.kind === 'suppress') {
    if (category === 'security') throw new ReviewLessonsError('suppress lessons cannot use the security category');
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    if (!evidence.length) throw new ReviewLessonsError('suppress lessons require rejected false_positive evidence');
    for (const ref of evidence) {
      const ledger = getReviewFindingsLedger(workspaceFolder, ref.leafId);
      const row = ledger?.entries?.find((entry) => entry.key === ref.ledgerKey);
      if (!row || row.outcome !== 'rejected' || row.rejection?.reason !== 'false_positive' || row.priority === 'P1') {
        throw new ReviewLessonsError('suppress evidence must be a rejected false_positive finding and cannot be P1');
      }
    }
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
  validateLesson(workspaceFolder, { ...existing, ...safePatch });
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
