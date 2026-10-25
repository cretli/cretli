/**
 * Policy gate for automatic integration of reviewed watcher leaves.
 *
 * This module intentionally contains no Git mutation. It turns a stored
 * result into a small, auditable decision that the integration worker can
 * execute; callers must still use the existing guarded integration flow.
 */

export const AUTO_INTEGRATE_DISABLED = 'auto_integrate_disabled';
export const AUTO_INTEGRATE_REVIEW_REQUIRED = 'review_not_passed';
export const AUTO_INTEGRATE_NOT_READY = 'integration_not_ready';

function text(value) {
  return String(value ?? '').trim();
}

/**
 * Decide whether a prepared result may enter the automatic integrator.
 * @param {{ policy?: Record<string, any>, todo?: Record<string, any>, result?: Record<string, any> }} input
 * @returns {{ ok: true, todoId: string, cycleId: string } | { ok: false, reason: string }}
 */
export function authorizeAutomaticIntegration(input = {}) {
  if (input.policy?.autoIntegrate !== true) return { ok: false, reason: AUTO_INTEGRATE_DISABLED };
  const result = input.result || {};
  const review = result.review || {};
  if (text(review.outcome).toLowerCase() !== 'pass' || review.verified !== true) {
    return { ok: false, reason: AUTO_INTEGRATE_REVIEW_REQUIRED };
  }
  const todo = input.todo || {};
  if (text(todo.integration?.state) !== 'ready' || !text(result.patchPath)) {
    return { ok: false, reason: AUTO_INTEGRATE_NOT_READY };
  }
  return { ok: true, todoId: text(todo.id), cycleId: text(result.cycleId) };
}

/**
 * Select only eligible ready leaves. The returned objects are decisions, not
 * commands, so an OFF policy cannot accidentally cause a side effect.
 * @param {{policy?: Record<string, any>, candidates?: Record<string, any>[]}} input
 */
export function selectAutomaticIntegrations({ policy, candidates = [] } = {}) {
  return candidates.map((candidate) => ({
    candidate,
    decision: authorizeAutomaticIntegration({ policy, todo: candidate.todo, result: candidate.result }),
  }));
}

/**
 * Execute one authorized integration through injected guarded operations.
 * Keeping the operations injectable makes the watcher easy to test and keeps
 * the policy-off path side-effect free.
 * @param {{policy?: Record<string, any>, todo?: Record<string, any>, result?: Record<string, any>, deps?: Record<string, any>}} input
 * @returns {Promise<{ok: boolean, reason?: string, todoId?: string, applied?: any, rejected?: boolean, rejectError?: string, suspendError?: string}>}
 */
export async function runAutomaticIntegration({ policy, todo, result, deps = {} } = {}) {
  const decision = authorizeAutomaticIntegration({ policy, todo, result });
  if (!decision.ok) return decision;
  const apply = typeof deps.apply === 'function' ? deps.apply : null;
  const reject = typeof deps.reject === 'function' ? deps.reject : null;
  if (!apply) return { ok: false, reason: AUTO_INTEGRATE_NOT_READY };
  let reason;
  let failure;
  try {
    const applied = await apply({ todo, result });
    if (applied?.ok === true) return { ok: true, todoId: decision.todoId, applied };
    reason = String(applied?.reason || 'integration_failed');
  } catch (error) {
    failure = error;
    reason = String(error?.code || error?.message || 'integration_failed');
    if (error?.artifacts) reason += `; artifacts: ${error.artifacts}`;
  }
  if (failure?.code === 'frontend_browser_failed') {
    const suspend = typeof deps.suspendAfterSmokeFailure === 'function'
      ? deps.suspendAfterSmokeFailure : null;
    if (!suspend) {
      return { ok: false, reason, rejected: false, suspendError: 'smoke_failure_handler_missing' };
    }
    try {
      const suspended = await suspend({ todo, result, reason, error: failure });
      if (suspended?.ok === false) {
        return { ok: false, reason, rejected: false,
          suspendError: String(suspended.reason || 'smoke_failure_pause_failed') };
      }
    } catch (error) {
      return { ok: false, reason, rejected: false,
        suspendError: String(error?.code || error?.message || 'smoke_failure_pause_failed') };
    }
  }
  try {
    const rejected = reject ? await reject({ todo, result, reason }) : null;
    return { ok: false, reason, rejected: Boolean(reject) && rejected?.ok !== false,
      ...(rejected?.ok === false ? { rejectError: rejected.reason } : {}) };
  } catch (error) {
    return { ok: false, reason, rejected: false, rejectError: String(error?.code || error?.message) };
  }
}
