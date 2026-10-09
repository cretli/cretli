/**
 * Worktree layout resolution.
 *
 * Contract §6.1–6.2 leaves the exact base path, per-workspace namespace and the
 * branch/directory naming schema as OPEN (O3). This module deliberately ships
 * **no defaults**: every naming input is required from the caller, and a
 * missing input is a readable refusal instead of an invented path. That keeps
 * O3 unsettled while still giving the manager one deterministic layout function.
 */

import path from 'node:path';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree-errors.js';

const REQUIRED_LAYOUT_KEYS = Object.freeze(['root', 'namespace', 'branchPrefix', 'directoryPrefix']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * A todo id is used as a path segment, so it must not carry separators or
 * traversal. UUIDs and slugs pass; anything path-like is refused.
 *
 * @param {unknown} todoId
 * @returns {string}
 */
export function normalizeWorktreeTodoId(todoId) {
  const id = readString(todoId);
  if (!id) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, 'A worktree todo id is required.');
  }
  if (/[\\/]/.test(id) || id === '.' || id === '..' || id.includes('..') || /\s/.test(id)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Unsafe worktree todo id: ${JSON.stringify(id)}.`,
    );
  }
  return id;
}

/**
 * Validate a caller-supplied layout policy. All four keys are REQUIRED because
 * the contract marks the path/namespace/naming schema OPEN (O3).
 *
 * @param {unknown} raw
 * @returns {{ root: string, namespace: string, branchPrefix: string, directoryPrefix: string }}
 */
export function normalizeWorktreeConfig(raw) {
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, string>} */
  const values = {};
  const missing = [];
  for (const key of REQUIRED_LAYOUT_KEYS) {
    const value = readString(source[key]);
    values[key] = value;
    if (!value) missing.push(key);
  }
  if (missing.length > 0) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Worktree layout is not configured (missing ${missing.join(', ')}); OPEN O3 in docs/todo-worktree-contract.md must be settled before worktree mode can run.`,
    );
  }
  const root = path.resolve(values.root);
  if (!path.isAbsolute(values.root)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Worktree root must be an absolute path (got ${JSON.stringify(values.root)}).`,
    );
  }
  if (/[\\/]/.test(values.namespace) || values.namespace === '.' || values.namespace === '..') {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Worktree namespace must be a single path segment (got ${JSON.stringify(values.namespace)}).`,
    );
  }
  return {
    root,
    namespace: values.namespace,
    branchPrefix: values.branchPrefix,
    directoryPrefix: values.directoryPrefix,
  };
}

/**
 * Deterministic branch + directory for one todo. Idempotent by construction:
 * the same todo id and config always resolve to the same path.
 *
 * @param {unknown} rawConfig
 * @param {unknown} todoId
 * @returns {{ root: string, namespace: string, branchPrefix: string, directoryPrefix: string, branch: string, worktreePath: string }}
 */
export function resolveWorktreeLayout(rawConfig, todoId) {
  const config = normalizeWorktreeConfig(rawConfig);
  const id = normalizeWorktreeTodoId(todoId);
  const worktreePath = path.join(config.root, config.namespace, `${config.directoryPrefix}${id}`);
  return {
    ...config,
    branch: `${config.branchPrefix}${id}`,
    worktreePath,
  };
}

/**
 * True when `child` is inside `parent` (or equals it). Used to keep a worktree
 * out of the repository, per settled §6.1 (S8).
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isPathInside(parent, child) {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}
