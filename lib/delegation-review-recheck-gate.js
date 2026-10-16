/**
 * Refuse a review start that would re-run the same reviewer on unchanged
 * material: no implement/fix was queued since that reviewer's last usable
 * review attempt on the same leaf and subject.
 */

import { isTerminalDelegationStatus } from './delegation-status.js';
import { isImplementOrFixDelegationRow } from './delegation-implement-verify-gate.js';
import { listDelegationsForController } from './persist/delegations-persist.js';
import { decodeModelValue } from './model-catalog.js';
import { isReviewerTimedOutAttempt } from './todo-review-sync.js';

export const DELEGATION_REVIEW_RECHECK_NO_CHANGE = 'review_recheck_no_material_change';

const USABLE_VERDICTS = new Set(['PASS', 'FAIL', 'BLOCKED']);

/**
 * @param {object} row
 * @returns {number}
 */
function rowTime(row) {
  const at = Date.parse(String(row.queuedAt || row.createdAt || row.startedAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * Normalized transport + BASE model id (the `::effort=...` option suffix is
 * stripped by `decodeModelValue`, the same helper the anti-bias check uses), so
 * an effort variant of the same model is still the same reviewer.
 *
 * @param {object} row
 * @returns {string}
 */
function executorKey(row) {
  const transport = String(row?.executor?.transport || row?.transport || '').trim().toLowerCase();
  const raw = String(row?.executor?.model || row?.model || '').trim();
  const model = raw ? String(decodeModelValue(raw).modelId || '').trim().toLowerCase() : '';
  return `${transport}:${model}`;
}

/**
 * Material rule, one per subject:
 * - `code`: when both the live leaf material revision (`materialRevision`) and
 *   the one stored on the reviewer's last usable review are known, a different
 *   revision means changed (this also sees direct edits made without an
 *   implement/fix row). Otherwise (legacy row / no captured leaf base) unchanged
 *   means no implement/fix was queued on the leaf since that review.
 * - `plan`: unchanged means the reviewed todo's plan CONTENT key
 *   (`computeTodoPlanContentKey`, markdown only, so a save/approval without a
 *   text change does not re-admit a rerun) equals the key stored on the
 *   reviewer's last usable plan review. Legacy rows that only carry the
 *   timestamp-based `todoPlanRevisionKey` fall back to comparing that key. The
 *   parent chat plan revision is not used. When the incoming key is empty (todo
 *   missing or without a plan) or the last review row has no stored key,
 *   "unchanged" cannot be proven and the start is allowed.
 * - `other`: intentionally uncovered (no material notion), never blocked.
 * - A reviewer attempt that hit the wait limit (`run_deadline_exceeded`) is not
 *   a usable prior review (same notion as `todo-review-sync`), so rerunning
 *   the same reviewer after a timeout needs no `allow_recheck`.
 *
 * @param {{
 *   parentChatId?: unknown,
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   executor?: { transport?: unknown, model?: unknown },
 *   todoPlanRevisionKey?: unknown,
 *   todoPlanContentKey?: unknown,
 *   materialRevision?: unknown,
 *   planReviewerPhase?: unknown,
 *   exchangeOfDelegationId?: unknown,
 *   allowRecheck?: unknown,
 * }} input
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function inspectReviewRecheckWithoutChange(input = {}) {
  if (input.allowRecheck === true) return { ok: true };
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return { ok: true };
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (!parentChatId || !leafId) return { ok: true };
  const subject = String(input.reviewSubject || '').trim().toLowerCase();
  // `other` subjects have no material notion and stay uncovered.
  if (subject !== 'code' && subject !== 'plan') return { ok: true };
  // An exchange-phase start tied to an independent row is not a recheck.
  const phase = String(input.planReviewerPhase || '').trim().toLowerCase();
  if (phase === 'exchange' || String(input.exchangeOfDelegationId || '').trim()) return { ok: true };
  const planKey = String(input.todoPlanContentKey || '').trim();
  const legacyPlanKey = String(input.todoPlanRevisionKey || '').trim();
  if (subject === 'plan' && !planKey && !legacyPlanKey) return { ok: true };
  const wanted = executorKey({ executor: input.executor });
  const rows = listDelegationsForController(parentChatId)
    .filter((row) => String(row.leafId || '').trim() === leafId);
  const lastReview = rows
    .filter((row) => String(row.assignment || '').toLowerCase() === 'review'
      && !isImplementOrFixDelegationRow(row)
      && String(row.reviewSubject || '').trim().toLowerCase() === subject
      && executorKey(row) === wanted
      && isTerminalDelegationStatus(row.status)
      && !isReviewerTimedOutAttempt(row)
      && String(row.status) !== 'cancelled'
      && USABLE_VERDICTS.has(String(row.reportVerdict || row.verdict || '').toUpperCase()))
    .sort((a, b) => rowTime(b) - rowTime(a))[0];
  if (!lastReview) return { ok: true };
  if (subject === 'plan') {
    const reviewedContentKey = String(lastReview.todoPlanContentKey || '').trim();
    if (reviewedContentKey && planKey) {
      if (reviewedContentKey !== planKey) return { ok: true };
    } else {
      const reviewedKey = String(lastReview.todoPlanRevisionKey || '').trim();
      if (!reviewedKey || reviewedKey !== legacyPlanKey) return { ok: true };
    }
    return refusal('This reviewer already reviewed this plan revision. Revise the plan, use a different reviewer, or pass allow_recheck=true to override.');
  }
  const liveRevision = String(input.materialRevision || '').trim();
  const reviewedRevision = String(lastReview.reviewedMaterialRevision || '').trim();
  if (liveRevision && reviewedRevision && liveRevision !== reviewedRevision) return { ok: true };
  const reviewAt = rowTime(lastReview);
  const changed = rows.some((row) => isImplementOrFixDelegationRow(row) && rowTime(row) > reviewAt);
  if (changed) return { ok: true };
  return refusal('This reviewer already reviewed this leaf and no implement/fix was queued since. Run an implement/fix first, use a different reviewer, or pass allow_recheck=true to override.');
}

/**
 * @param {string} error
 * @returns {{ ok: false, status: number, code: string, error: string }}
 */
function refusal(error) {
  return { ok: false, status: 409, code: DELEGATION_REVIEW_RECHECK_NO_CHANGE, error };
}
