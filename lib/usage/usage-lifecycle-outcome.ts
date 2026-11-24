/**
 * Lifecycle outcome of one delegation attempt (or one watcher cycle), a read-side
 * label that sits next to - never inside - the run `outcome` of usage events
 * (`USAGE_OUTCOMES` ok/error/limit/aborted are unchanged).
 *
 * Exactly one label per attempt, evaluated in this precedence:
 * recovered > completed > cancelled > restart > requeued > abandoned.
 * - recovered: completed although the attempt was interrupted/retried on the way
 *   (interrupt code or a startup retry recorded on the attempt);
 * - completed: ended `completed` without interruption;
 * - cancelled: ended `cancelled` (also when a restart caused it);
 * - restart: ended by a server restart (`interruptCode` carries `restart`);
 * - requeued: not completed, but a later attempt of the same delegation exists
 *   (`hasSuccessor`) - the work was retried;
 * - abandoned: everything else that is terminal (failed/interrupted, no successor).
 */

import { listDelegationAttempts } from '../delegation-attempt.js';

export const USAGE_LIFECYCLE_OUTCOMES = Object.freeze(['recovered', 'completed', 'cancelled', 'restart', 'requeued', 'abandoned']);

const TERMINAL = new Set(['cancelled', 'completed', 'failed', 'interrupted']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * @param {{ status?: unknown, interruptCode?: unknown, cancelCause?: unknown, startupRetry?: { used?: unknown } | null }} attempt
 * @param {{ hasSuccessor?: boolean }} [ctx]
 * @returns {string} one of USAGE_LIFECYCLE_OUTCOMES, or '' for a non-terminal attempt
 */
export function classifyAttemptLifecycleOutcome(attempt, ctx: { hasSuccessor?: boolean } = {}) {
  const status = text(attempt?.status);
  if (!TERMINAL.has(status)) return '';
  const interrupt = text(attempt?.interruptCode);
  const restart = interrupt.includes('restart') || text(attempt?.cancelCause).includes('restart');
  if (status === 'completed' && (interrupt || Number(attempt?.startupRetry?.used) > 0)) return 'recovered';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (restart) return 'restart';
  if (ctx.hasSuccessor === true) return 'requeued';
  return 'abandoned';
}

/**
 * Cycle-level label from the watcher cycle metric (`closeOutcome` / `closeSource`).
 *
 * @param {{ closeOutcome?: unknown, closeSource?: unknown } | null | undefined} cycle
 * @returns {string} label or '' while the cycle is still open
 */
export function classifyCycleLifecycleOutcome(cycle) {
  const outcome = text(cycle?.closeOutcome);
  const source = text(cycle?.closeSource);
  if (outcome === 'interrupted_restart') return 'restart';
  if (source === 'abort') return 'abandoned';
  if (outcome === 'success') return 'completed';
  if (outcome === 'blocked' || outcome === 'failure') return 'abandoned';
  return '';
}

/**
 * One row per terminal attempt of the given delegations.
 *
 * @param {Record<string, any>[]} delegations
 * @returns {{ delegationId: string, attemptId: string, harness: string, finishedAt: string, outcome: string, hasSuccessor: boolean }[]}
 */
export function listAttemptLifecycleOutcomes(delegations) {
  const out = [];
  for (const row of Array.isArray(delegations) ? delegations : []) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    const attempts = listDelegationAttempts(row);
    attempts.forEach((attempt, i) => {
      // A later attempt (retry/resume of the same delegation) is a successor.
      const hasSuccessor = i < attempts.length - 1;
      const outcome = classifyAttemptLifecycleOutcome(attempt, { hasSuccessor });
      if (!outcome) return;
      out.push({
        delegationId: id,
        attemptId: String(attempt.attemptId ?? '').trim(),
        harness: String(attempt.transport || row?.executor?.transport || '').trim().toLowerCase(),
        finishedAt: String(attempt.finishedAt ?? '').trim(),
        outcome,
        hasSuccessor,
      });
    });
  }
  return out;
}

/**
 * @param {{ outcome: string }[]} rows
 * @returns {Record<string, number>} count per outcome (all labels present); sums to rows.length
 */
export function countLifecycleOutcomes(rows) {
  const counts = Object.fromEntries(USAGE_LIFECYCLE_OUTCOMES.map((k) => [k, 0]));
  for (const r of rows) if (r.outcome in counts) counts[r.outcome] += 1;
  return counts;
}
