/**
 * Structured errors for builtin Cretli MCP tools.
 */

/**
 * Delegations and reviewer sessions are run by a Cretli chat (the orchestrator). A caller without one,
 * such as an external MCP client, starts an orchestrator instead of acting as one.
 */
export const NO_CALLING_CHAT_HINT = 'These tools run inside a Cretli orchestrator chat. An external MCP client is not one: start an orchestrator instead — operator_plan_review_start (plan review with reviewers), todo_start (implementation orchestrator), or set the leaf ready for the Workspace Watcher — then follow it with operator_chat_status / operator_chat_wait.';

export const MCP_BUILTIN_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  WORKSPACE_REQUIRED: 'WORKSPACE_REQUIRED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  PLAN_MODE_DENIED: 'PLAN_MODE_DENIED',
  HARNESS_UNAVAILABLE: 'HARNESS_UNAVAILABLE',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
});

export class CretliMcpToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CretliMcpToolError';
    this.code = code;
    this.delegationId = String(details.delegationId || '').trim();
    this.attemptId = String(details.attemptId || '').trim();
    this.reason = String(details.reason || '').trim();
  }
}

function conflictDetails(err) {
  return {
    delegationId: String(err?.delegationId || err?.id || '').trim(),
    attemptId: String(err?.attemptId || '').trim(),
    reason: String(err?.reason || '').trim(),
  };
}

/**
 * @param {any} err
 * @returns {CretliMcpToolError}
 */
export function toCretliMcpToolError(err) {
  if (err instanceof CretliMcpToolError) return err;
  const code = String(err?.code || '');
  if (code === 'NO_WORKSPACE' || code === 'no_workspace') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.WORKSPACE_REQUIRED, err.message || 'Workspace folder is required');
  }
  if (code === 'OUT_OF_SCOPE') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE, err.message || 'Out of workspace scope');
  }
  if (code === 'NOT_FOUND' || code === 'chat_not_found' || code === 'not_found' || err?.status === 404) {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, err.message || 'Not found');
  }
  if (code.startsWith('takeover_') || code === 'mailbox_recipient_moved' || code === 'CONFLICT' || code === 'MCP_REVISION_CONFLICT' || code === 'plan_revision_conflict'
    || code === 'idempotency_conflict' || code === 'active_delegation_exists'
    || code === 'still_active' || code === 'parent_busy' || code === 'review_fanout_full'
    || code === 'queue_full'
    || code === 'run_stopping' || code === 'job_in_progress'
    || code === 'stale_running' || code === 'attempt_mismatch' || code === 'run_mismatch'
    || code === 'source_changed' || code === 'source_unavailable'
    || code === 'nested_delegation_denied' || code === 'depth_exceeded' || code === 'review_uncertified'
    || code === 'workspace_busy' || code === 'global_limit' || code === 'tree_slot_limit' || code === 'tree_budget_exceeded'
    || code === 'workflow_stopped' || code === 'workflow_deadline'
    || code === 'workflow_rounds_exhausted' || code === 'workflow_parent_required'
    || code === 'already_terminal' || code === 'parent_cancelling'
    || err?.status === 409) {
    return new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.CONFLICT,
      err.message || 'Conflict',
      conflictDetails(err),
    );
  }
  if (code === 'model_unavailable' || code === 'effort_unavailable') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.MODEL_UNAVAILABLE, err.message || 'Model is unavailable');
  }
  if (code === 'executor_unavailable') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.HARNESS_UNAVAILABLE, err.message || 'Harness is unavailable');
  }
  if (code === 'VALIDATION' || code === 'LIMIT' || code === 'parent_required' || code === 'plan_missing') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, err.message || 'Invalid arguments');
  }
  if (err?.status === 400) {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, err.message || 'Invalid arguments');
  }
  return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, err?.message || String(err));
}
