/**
 * Execution-mode resolution (contract §4).
 *
 * S3 settles the values (`inherit | worktree | project`, resolved to
 * `worktree | project`, product default `project`). O1 — whether `inherit`
 * walks the ancestor tree — is OPEN, so this resolver intentionally does **no
 * ancestor walk**: a leaf's own explicit value wins, otherwise the policy
 * default applies. Callers that want inheritance must not get it here.
 */

import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.js';

export const WORKTREE_MODES = Object.freeze(['inherit', 'worktree', 'project']);
export const RESOLVED_WORKTREE_MODES = Object.freeze(['worktree', 'project']);

/**
 * @param {unknown} value
 * @returns {'worktree' | 'project' | null}
 */
function normalizeResolvedMode(value) {
  const mode = String(value ?? '').trim();
  return mode === 'worktree' || mode === 'project' ? mode : null;
}

/**
 * Leaf request normalization shared by TODO persistence, REST and MCP. An
 * absent or empty value is `inherit`; unknown stored values also degrade to
 * `inherit` (load stays tolerant), while explicit create/update reject them.
 *
 * @param {unknown} value
 * @returns {'inherit' | 'worktree' | 'project' | null}
 */
export function normalizeWorktreeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return WORKTREE_MODES.includes(mode) ? mode : null;
}

/**
 * Resolve `inherit`/`worktree`/`project` to a frozen `worktree`/`project`.
 *
 * @param {{ leafMode?: unknown, policyDefault?: unknown }} [options]
 * @returns {{ mode: 'worktree' | 'project', source: 'leaf' | 'policy' }}
 */
export function resolveWorktreeMode(options = {}) {
  const rawLeaf = String(options.leafMode ?? '').trim();
  if (rawLeaf && rawLeaf !== 'inherit') {
    const leaf = normalizeResolvedMode(rawLeaf);
    if (!leaf) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.MODE_INVALID,
        `Invalid execution mode ${JSON.stringify(rawLeaf)}; expected inherit, worktree or project.`,
      );
    }
    return { mode: leaf, source: 'leaf' };
  }
  // S3: the compatibility product default is `project`.
  const rawPolicy = options.policyDefault == null ? 'project' : String(options.policyDefault).trim();
  const policy = normalizeResolvedMode(rawPolicy);
  if (!policy) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.MODE_INVALID,
      `Invalid watcher policy default ${JSON.stringify(rawPolicy)}; expected worktree or project.`,
    );
  }
  return { mode: policy, source: 'policy' };
}

/**
 * Guard for the worktree-only entry points: `project` mode keeps the existing
 * folder behaviour and must never be silently upgraded to a worktree.
 *
 * @param {unknown} mode
 * @returns {'worktree'}
 */
export function assertWorktreeMode(mode) {
  if (String(mode ?? '').trim() !== 'worktree') {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.MODE_NOT_WORKTREE,
      `Worktree operations require resolved mode "worktree" (got ${JSON.stringify(mode)}).`,
    );
  }
  return 'worktree';
}
