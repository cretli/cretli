/**
 * Execution-mode resolution (contract §4).
 *
 * S3 settles the values (`inherit | worktree | project`, resolved to
 * `worktree | project`, product default `project`). O1 — whether `inherit`
 * walks the ancestor tree — is OPEN, so this resolver intentionally does **no
 * ancestor walk**: a leaf's own explicit value wins, otherwise the policy
 * default applies. Callers that want inheritance must not get it here.
 */

import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.ts';

export type WorktreeMode = 'inherit' | 'worktree' | 'project';
export type ResolvedWorktreeMode = 'worktree' | 'project';

export const WORKTREE_MODES = Object.freeze(['inherit', 'worktree', 'project']);
export const RESOLVED_WORKTREE_MODES = Object.freeze(['worktree', 'project']);
export const WORKTREE_DIRTY_POLICIES = Object.freeze(['block', 'head', 'snapshot']);

/** Normalize a dirty-tree start policy; invalid values fail closed. */
export function normalizeWorktreeDirtyPolicy(value: unknown): string | null {
  const policy = String(value ?? 'block').trim().toLowerCase() || 'block';
  return WORKTREE_DIRTY_POLICIES.includes(policy) ? policy : null;
}

function normalizeResolvedMode(value: unknown): ResolvedWorktreeMode | null {
  const mode = String(value ?? '').trim();
  return mode === 'worktree' || mode === 'project' ? mode : null;
}

/**
 * Leaf request normalization shared by TODO persistence, REST and MCP. An
 * absent or empty value is `inherit`; unknown stored values also degrade to
 * `inherit` (load stays tolerant), while explicit create/update reject them.
 */
export function normalizeWorktreeMode(value: unknown): WorktreeMode | null {
  const mode = String(value ?? '').trim().toLowerCase();
  return WORKTREE_MODES.includes(mode) ? (mode as WorktreeMode) : null;
}

/**
 * Resolve `inherit`/`worktree`/`project` to a frozen `worktree`/`project`.
 */
export function resolveWorktreeMode(
  options: { leafMode?: unknown; policyDefault?: unknown } = {},
): { mode: ResolvedWorktreeMode; source: 'leaf' | 'policy' } {
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
 */
export function assertWorktreeMode(mode: unknown): 'worktree' {
  if (String(mode ?? '').trim() !== 'worktree') {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.MODE_NOT_WORKTREE,
      `Worktree operations require resolved mode "worktree" (got ${JSON.stringify(mode)}).`,
    );
  }
  return 'worktree';
}
