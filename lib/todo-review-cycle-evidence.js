/**
 * Per-cycle review evidence for worktree integration
 * (`docs/todo-review-contract.md` §8.1-§8.3).
 *
 * The worktree integration result is a per-cycle artifact, not a copy of the
 * live `todo.review`. This module derives the honest review evidence of ONE
 * Watcher cycle: it scopes the leaf's delegations to the cycle's orchestrator
 * chat and the cycle's leaf, then reuses the same snapshot engine as the
 * server-owned review field. A cycle with no review job — or with no fresh
 * independent PASS and satisfied verify — yields `outcome: 'unknown'` and
 * `verified: false`, never a hardcoded PASS.
 *
 * The returned `attemptId`/`delegationId`/`implementerAttemptId` pin the
 * evidence to the concrete attempt, and `cycleId`/`materialRevision` on the
 * result pin it to the cycle and the material revision at close.
 */

import { delegationController } from './delegation-control.js';
import { buildTodoReviewSnapshot } from './todo-review-sync.js';
import {
  delegationWorkflowLeafIdsMatch,
  readDelegationWorkflowLeafIdFromRow,
} from './delegation-workflow-leaf.js';
import { normalizeTodoRefId } from './todo-ref.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * Derive the review artifact of one cycle.
 *
 * @param {{
 *   cycleId?: string,
 *   parentChatId?: string,
 *   leafId?: string,
 *   rows?: object[],
 *   now?: number,
 * }} [input]
 * @returns {{
 *   outcome: 'PASS'|'FAIL'|'BLOCKED'|'pending'|'stale'|'unknown'|'none',
 *   reportedOutcome: string,
 *   verified: boolean,
 *   cycleId: string,
 *   delegationId: string,
 *   attemptId: string,
 *   implementerAttemptId: string,
 *   reviewerCount: number,
 *   independence: string,
 *   materialCurrent: boolean,
 *   stateReason: string,
 * }}
 */
export function buildCycleReviewEvidence(input = {}) {
  const cycleId = readString(input.cycleId);
  const parentChatId = readString(input.parentChatId);
  const leafId = normalizeTodoRefId(input.leafId) || readString(input.leafId);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  // Scope to this cycle's orchestrator and leaf. A row whose stored leaf is a
  // prefix is attributed to the full id for the snapshot engine, which matches
  // on the normalized row leaf.
  const scoped = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (readString(delegationController(row)) !== parentChatId) continue;
    if (!leafId) continue;
    const rowLeaf = readDelegationWorkflowLeafIdFromRow(row);
    if (!rowLeaf || !delegationWorkflowLeafIdsMatch(rowLeaf, leafId)) continue;
    scoped.push({ ...row, leafId });
  }
  const snapshot = buildTodoReviewSnapshot({ leafId, rows: scoped, now: input.now });
  const code = snapshot.code || {};
  const independence = code.independence && typeof code.independence === 'object' ? code.independence : {};
  const material = code.material && typeof code.material === 'object' ? code.material : {};
  const reviewers = Array.isArray(code.reviewers) ? code.reviewers : [];
  const independentPass = code.state === 'passed'
    && independence.independent === true
    && material.current === true;
  const passReviewer = reviewers.find((row) => row.usable === true && row.verdict === 'PASS') || null;
  const implementer = code.implementer && typeof code.implementer === 'object' ? code.implementer : null;
  // Honest artifact vocabulary (`docs/todo-review-contract.md` §8.2): only a
  // fresh independent PASS is a `PASS`; a decisive failure is `FAIL`; everything
  // else (none/pending/stale/unknown, or a PASS that is not independent/current)
  // is `unknown` and `verified:false`.
  const state = readString(code.state) || 'unknown';
  const outcome = independentPass ? 'PASS' : (state === 'failed' ? 'FAIL' : 'unknown');
  return {
    outcome,
    // The raw computed state stays available for diagnostics; `verified` is the
    // gate that integration actually honors.
    reportedOutcome: state,
    verified: independentPass,
    cycleId,
    delegationId: readString(passReviewer?.delegationId),
    attemptId: readString(passReviewer?.attemptId),
    implementerAttemptId: readString(implementer?.attemptId),
    reviewerCount: Number.isInteger(code.reviewerCount) ? code.reviewerCount : reviewers.length,
    independence: readString(independence.class) || 'unknown',
    materialCurrent: material.current === true,
    stateReason: readString(code.stateReason),
  };
}
