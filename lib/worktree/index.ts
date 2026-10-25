/**
 * Worktree feature barrel for server-side importers.
 *
 * The public entry point stays `lib/worktree-manager.js`; this barrel only
 * re-exports the vocabulary and layout helpers a later settings/route leaf needs.
 */

export {
  ensureWorktree,
  reconcileWorktreeRegistry,
  removeWorktree,
  updateWorktreeState,
  verifyWorktreeRecord,
  WORKTREE_OWNER_MARKER_FILE,
} from '../worktree-manager.js';
export { resolveWorktreeMode, assertWorktreeMode, WORKTREE_MODES, RESOLVED_WORKTREE_MODES } from './worktree-mode.ts';
export { normalizeWorktreeConfig, resolveWorktreeLayout, normalizeWorktreeTodoId, isPathInside } from './worktree-layout.ts';
export {
  EXECUTION_STATES,
  INTEGRATION_STATES,
  CREATION_STATES,
  normalizeWorktreeRecord,
  createWorktreeRecord,
} from './worktree-record.ts';
export {
  WORKTREE_RESULT_VERSION,
  normalizeWorktreeResult,
  createWorktreeResult,
  hashWorktreeResult,
  worktreeResultDir,
  worktreeResultPatchPath,
} from './worktree-result.ts';
export { WorktreeError, WORKTREE_ERROR_CODES, isWorktreeError } from './worktree-errors.ts';
