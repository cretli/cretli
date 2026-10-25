/**
 * Refuse a code review start that the server would never count as independent:
 * the chosen reviewer runs the same base model on the same harness as the
 * leaf's implementer or as the controller (orchestrator) chat that starts it.
 * Failing up-front is cheaper than a review whose PASS ends up
 * `review_state=unknown` (`independence=same_model_same_harness`).
 */

import { isImplementationWorkDelegationRow } from './delegation-work-role.js';
import { listDelegationsForController } from './persist/delegations-persist.js';
import { classifyTodoReviewIndependence } from './todo-review-state.js';

export const DELEGATION_REVIEW_NOT_INDEPENDENT = 'review_not_independent';

/**
 * @param {Record<string, any>} row
 * @returns {number}
 */
function rowTime(row) {
  const at = Date.parse(String(row.finishedAt || row.createdAt || row.startedAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {{
 *   controllerChatId?: unknown,
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   executor?: { transport?: unknown, model?: unknown },
 *   controller?: { harness?: unknown, model?: unknown } | null,
 *   allowSameModel?: unknown,
 * }} input `controller` is the orchestrator chat's own harness and model;
 * `allowSameModel` is an explicit service-level opt-out (never set by the
 * model-facing tools) for flows that must reuse one executor across roles
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function inspectReviewIndependence(input = {}) {
  if (String(input.assignment || '').toLowerCase() !== 'review') return { ok: true };
  if (String(input.reviewSubject || '').toLowerCase() !== 'code') return { ok: true };
  if (input.allowSameModel === true) return { ok: true };
  const reviewer = {
    harness: String(input.executor?.transport || '').trim().toLowerCase(),
    model: String(input.executor?.model || '').trim(),
  };
  /** @type {Array<{ who: string, entry: { harness?: unknown, model?: unknown } }>} */
  const references = [];
  if (input.controller) references.push({ who: 'orchestrator', entry: input.controller });
  const controllerChatId = String(input.controllerChatId || '').trim();
  const leafId = String(input.leafId || '').trim();
  if (controllerChatId) {
    const implementers = listDelegationsForController(controllerChatId)
      .filter((/** @type {Record<string, any>} */ row) => isImplementationWorkDelegationRow(row)
        && (!leafId || String(row.leafId || '').trim() === leafId))
      .sort((/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b) => rowTime(b) - rowTime(a));
    const latest = implementers[0];
    if (latest) {
      references.push({
        who: 'implementer',
        entry: { harness: latest.executor?.transport, model: latest.executor?.model },
      });
    }
  }
  for (const { who, entry } of references) {
    // Only an identified same-model/same-harness pair is refused; an unknown
    // model (auto/empty) cannot be proven dependent and stays allowed.
    if (classifyTodoReviewIndependence(reviewer, entry) !== 'same_model_same_harness') continue;
    return {
      ok: false,
      status: 409,
      code: DELEGATION_REVIEW_NOT_INDEPENDENT,
      error: `A code review must run on a different base model than the ${who} `
        + `(${reviewer.harness}/${reviewer.model || 'auto'} is the same model on the same harness, so its verdict would not count). `
        + 'Pick another reviewer with model_pick role=review and exclude_model for the orchestrator and the implementer.',
    };
  }
  return { ok: true };
}
