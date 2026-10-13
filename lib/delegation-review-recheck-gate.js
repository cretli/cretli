/**
 * Refuse a review start that would re-run the same reviewer on unchanged
 * material: no implement/fix was queued since that reviewer's last usable
 * review attempt on the same leaf and subject.
 */

import { isTerminalDelegationStatus } from './delegation-status.js';
import { isImplementOrFixDelegationRow } from './delegation-implement-verify-gate.js';
import { listDelegationsForParent } from './persist/delegations-persist.js';
import { decodeModelValue } from './model-catalog.js';

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
 * - `code`: unchanged means no implement/fix was queued on the leaf since the
 *   reviewer's last usable review.
 * - `plan`: unchanged means the reviewed todo's plan revision key
 *   (`computeTodoPlanRevisionKey`, resolved by the start path from the leaf id
 *   regardless of the delegation source kind) equals the key stored on the
 *   reviewer's last usable plan review. The parent chat plan revision is not
 *   used. When the incoming key is empty (todo missing or without a plan) or
 *   the last review row has no stored key (legacy row), "unchanged" cannot be
 *   proven and the start is allowed.
 *
 * @param {{
 *   parentChatId?: unknown,
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   executor?: { transport?: unknown, model?: unknown },
 *   todoPlanRevisionKey?: unknown,
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
  const planKey = String(input.todoPlanRevisionKey || '').trim();
  if (subject === 'plan' && !planKey) return { ok: true };
  const wanted = executorKey({ executor: input.executor });
  const rows = listDelegationsForParent(parentChatId)
    .filter((row) => String(row.leafId || '').trim() === leafId);
  const lastReview = rows
    .filter((row) => String(row.assignment || '').toLowerCase() === 'review'
      && !isImplementOrFixDelegationRow(row)
      && String(row.reviewSubject || '').trim().toLowerCase() === subject
      && executorKey(row) === wanted
      && isTerminalDelegationStatus(row.status)
      && String(row.status) !== 'cancelled'
      && USABLE_VERDICTS.has(String(row.reportVerdict || row.verdict || '').toUpperCase()))
    .sort((a, b) => rowTime(b) - rowTime(a))[0];
  if (!lastReview) return { ok: true };
  if (subject === 'plan') {
    const reviewedKey = String(lastReview.todoPlanRevisionKey || '').trim();
    if (!reviewedKey || reviewedKey !== planKey) return { ok: true };
    return refusal('This reviewer already reviewed this plan revision. Revise the plan, use a different reviewer, or pass allow_recheck=true to override.');
  }
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
