/**
 * The "round implementer" of a leaf: the implement/fix attempt that opened the
 * current review round. It reproduces the choice of the todo review sync
 * (lib/todo-review-sync.js `buildSubjectSnapshot`: the last non-review attempt
 * by material chronology, with NO status filter), so the cross-role session
 * gate and the server-written independence class always name the same
 * implementer. An equivalence test pins the two together.
 */

import { listDelegationAttempts } from './delegation-attempt.js';
import { delegationCycleRole } from './delegation-cycle-classify.js';
import { normalizeTodoRefId } from './todo-ref.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * Queue time first (invalidation happens at queue time), then start time.
 *
 * @param {Record<string, any>} attempt
 * @returns {number}
 */
function materialTime(attempt) {
  const queued = Date.parse(asText(attempt?.queuedAt));
  if (Number.isFinite(queued)) return queued;
  const started = Date.parse(asText(attempt?.startedAt));
  return Number.isFinite(started) ? started : -Infinity;
}

/**
 * Same ordering as the sync: time, then attempt id, then delegation id.
 *
 * @param {{ attempt: Record<string, any>, attemptId: string, delegationId: string }} left
 * @param {{ attempt: Record<string, any>, attemptId: string, delegationId: string }} right
 * @returns {number}
 */
function compareMaterial(left, right) {
  const leftTime = materialTime(left.attempt);
  const rightTime = materialTime(right.attempt);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  if (left.attemptId !== right.attemptId) return left.attemptId < right.attemptId ? -1 : 1;
  if (left.delegationId !== right.delegationId) return left.delegationId < right.delegationId ? -1 : 1;
  return 0;
}

/**
 * Implement/fix attempt that opened the current round of `leafId`, or null.
 *
 * @param {{ delegations?: Record<string, any>[], leafId?: unknown }} [input]
 * @returns {{ delegationId: string, attemptId: string, childChatId: string } | null}
 */
export function findRoundImplementer(input = {}) {
  const leafId = normalizeTodoRefId(input.leafId) || asText(input.leafId);
  if (!leafId) return null;
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const materials = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rowLeafId = normalizeTodoRefId(row.leafId) || asText(row.leafId);
    if (rowLeafId !== leafId) continue;
    const role = delegationCycleRole(row);
    if (asText(row.assignment).toLowerCase() === 'review' || role === 'review') continue;
    if (role !== 'implement' && role !== 'fix') continue;
    for (const attempt of listDelegationAttempts(row)) {
      const safeAttempt = attempt && typeof attempt === 'object' ? attempt : {};
      materials.push({
        delegationId: asText(row.id),
        attemptId: asText(safeAttempt.attemptId),
        childChatId: asText(row.childChatId),
        attempt: safeAttempt,
      });
    }
  }
  const last = materials.sort(compareMaterial).at(-1);
  return last ? { delegationId: last.delegationId, attemptId: last.attemptId, childChatId: last.childChatId } : null;
}
