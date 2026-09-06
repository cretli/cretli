/**
 * Structured errors for builtin Cretli MCP tools.
 */

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
   */
  constructor(code, message) {
    super(message);
    this.name = 'CretliMcpToolError';
    this.code = code;
  }
}

/**
 * @param {unknown} err
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
  if (code === 'CONFLICT' || code === 'MCP_REVISION_CONFLICT' || code === 'plan_revision_conflict'
    || code === 'idempotency_conflict' || code === 'active_delegation_exists'
    || code === 'source_changed' || code === 'source_unavailable' || err?.status === 409) {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, err.message || 'Conflict');
  }
  if (code === 'model_unavailable') {
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
