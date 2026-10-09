/**
 * Typed errors for the server-managed worktree flow.
 *
 * Every refusal that a caller must act on carries a stable `code` so the
 * watcher/routes layer can classify it without parsing the message. Errors are
 * deliberate fail-closed answers: an open decision or an unverifiable owner is
 * a refusal, never a guess.
 */

export class WorktreeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'WorktreeError';
    this.code = code;
    if (options.details && typeof options.details === 'object') {
      this.details = options.details;
    }
  }
}

/** All refusal codes, exported so callers can branch without stringly checks. */
export const WORKTREE_ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'WORKTREE_CONFIG_INVALID',
  MODE_INVALID: 'WORKTREE_MODE_INVALID',
  MODE_NOT_WORKTREE: 'WORKTREE_MODE_NOT_WORKTREE',
  NOT_GIT: 'WORKTREE_NOT_GIT',
  DIRTY: 'WORKTREE_DIRTY',
  PATH_EXISTS: 'WORKTREE_PATH_EXISTS',
  BRANCH_COLLISION: 'WORKTREE_BRANCH_COLLISION',
  MISSING: 'WORKTREE_MISSING',
  FOREIGN: 'WORKTREE_FOREIGN',
  OWNER_MISMATCH: 'WORKTREE_OWNER_MISMATCH',
  EXTERNAL_CHANGE: 'WORKTREE_EXTERNAL_CHANGE',
  REGISTRY_CONFLICT: 'WORKTREE_REGISTRY_CONFLICT',
  RECORD_MISSING: 'WORKTREE_RECORD_MISSING',
  BUSY: 'WORKTREE_BUSY',
  BUSY_CHECK_UNAVAILABLE: 'WORKTREE_BUSY_CHECK_UNAVAILABLE',
  UNACCEPTED: 'WORKTREE_UNACCEPTED',
  REMOVE_REFUSED: 'WORKTREE_REMOVE_REFUSED',
  PREPARE_FAILED: 'WORKTREE_PREPARE_FAILED',
  INTEGRATION_CONFLICT: 'WORKTREE_INTEGRATION_CONFLICT',
  GIT_FAILED: 'WORKTREE_GIT_FAILED',
});

/**
 * @param {unknown} error
 * @returns {error is WorktreeError}
 */
export function isWorktreeError(error) {
  return error instanceof WorktreeError;
}
