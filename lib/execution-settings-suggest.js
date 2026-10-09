/**
 * Server-computed default worktree layout for one workspace.
 *
 * The Settings form must not start from empty placeholders: the operator would
 * have to invent a location outside the repository, a single-segment namespace
 * and a branch scheme before worktree mode can run at all. This module derives
 * a safe suggestion from the workspace itself (Git root, folder name, lockfile)
 * so the fields are prefilled and only need a confirmation.
 *
 * Read-only: it never creates a directory, never writes settings and never
 * throws for a non-Git workspace (it returns `available: false` instead).
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveRepositoryRoot } from './worktree/git-worktree.js';

/** Lockfile → prepare argv, checked in order. The first match wins. */
const PREPARE_RECIPES = Object.freeze([
  Object.freeze({ file: 'pnpm-lock.yaml', command: Object.freeze(['pnpm', 'install', '--frozen-lockfile']) }),
  Object.freeze({ file: 'yarn.lock', command: Object.freeze(['yarn', 'install', '--frozen-lockfile']) }),
  Object.freeze({ file: 'package-lock.json', command: Object.freeze(['npm', 'ci']) }),
  Object.freeze({ file: 'composer.lock', command: Object.freeze(['composer', 'install']) }),
  Object.freeze({ file: 'go.sum', command: Object.freeze(['go', 'mod', 'download']) }),
  Object.freeze({ file: 'requirements.txt', command: Object.freeze(['python', '-m', 'pip', 'install', '-r', 'requirements.txt']) }),
]);

/** Shared parent of the repository: `<parent>/.cretli-worktrees/<namespace>/...`. */
const WORKTREE_DIR_NAME = '.cretli-worktrees';
const BRANCH_SUFFIX = '/todo/';
const DIRECTORY_PREFIX = 't-';

/**
 * A namespace is one path segment, so separators and traversal are stripped.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeNamespace(value) {
  const clean = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return clean && clean !== '.' && clean !== '..' ? clean : 'workspace';
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function detectPrepareCommand(repoRoot) {
  for (const recipe of PREPARE_RECIPES) {
    if (fs.existsSync(path.join(repoRoot, recipe.file))) return [...recipe.command];
  }
  // No lockfile: a plain `npm install` is still the least surprising default for
  // a Node project, and an empty argv means "nothing to prepare" for the rest.
  if (fs.existsSync(path.join(repoRoot, 'package.json'))) return ['npm', 'install'];
  return [];
}

/**
 * Branch prefix for a namespace. Kept beside the suggestion so a backfilled
 * layout and the suggested one never drift.
 *
 * @param {unknown} namespace
 * @returns {string}
 */
export function worktreeBranchPrefix(namespace) {
  return `${sanitizeNamespace(namespace)}${BRANCH_SUFFIX}`;
}

/** Layout keys the server refuses to invent (`normalizeWorktreeConfig`). */
const WORKTREE_LAYOUT_KEYS = Object.freeze(['root', 'namespace', 'branchPrefix', 'directoryPrefix']);

/**
 * Whether a worktree layout carries every required naming input. A start in
 * worktree mode is refused until this is true, so both the settings form and a
 * start-time backfill use the same completeness test.
 *
 * @param {unknown} layout
 * @returns {boolean}
 */
export function isWorktreeLayoutComplete(layout) {
  const raw = layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {};
  return WORKTREE_LAYOUT_KEYS.every((key) => String(raw[key] ?? '').trim() !== '');
}

/**
 * Fill the missing worktree layout fields from the workspace-derived suggestion.
 * A stored value always wins, so this is safe to run against a partially filled
 * layout. `prepareCommand` is deliberately never invented here: running a
 * package install is the operator's explicit decision.
 *
 * @param {object | null | undefined} policy
 * @param {unknown} workspaceFolder
 * @returns {{ policy: object, changed: boolean }}
 */
export function backfillWorktreeLayout(policy, workspaceFolder) {
  const current = policy && typeof policy === 'object' ? policy : {};
  const worktree = current.worktree && typeof current.worktree === 'object' && !Array.isArray(current.worktree)
    ? { ...current.worktree }
    : {};
  if (isWorktreeLayoutComplete(worktree)) return { policy: current, changed: false };
  const suggestion = suggestExecutionSettings(workspaceFolder);
  if (!suggestion.available) return { policy: current, changed: false };
  for (const key of ['root', 'namespace', 'directoryPrefix']) {
    if (String(worktree[key] ?? '').trim() === '') worktree[key] = suggestion.worktree[key];
  }
  // A prefix follows the effective namespace, so a caller that supplied only a
  // namespace still gets a matching branch prefix.
  if (String(worktree.branchPrefix ?? '').trim() === '') {
    worktree.branchPrefix = worktreeBranchPrefix(worktree.namespace);
  }
  return { policy: { ...current, worktree }, changed: true };
}

/**
 * @typedef {object} ExecutionSettingsSuggestion
 * @property {boolean} available
 * @property {string} repoRoot
 * @property {'project'} executionMode
 * @property {{ root: string, namespace: string, branchPrefix: string, directoryPrefix: string, prepareCommand: string[] }} worktree
 */

/**
 * @param {unknown} workspaceFolder
 * @returns {ExecutionSettingsSuggestion}
 */
export function suggestExecutionSettings(workspaceFolder) {
  const folder = String(workspaceFolder ?? '').trim();
  let repoRoot = '';
  try {
    repoRoot = resolveRepositoryRoot(folder);
  } catch {
    repoRoot = '';
  }
  if (!repoRoot) {
    return {
      available: false,
      repoRoot: '',
      executionMode: 'project',
      worktree: {
        root: '',
        namespace: '',
        branchPrefix: '',
        directoryPrefix: DIRECTORY_PREFIX,
        prepareCommand: [],
      },
    };
  }
  const namespace = sanitizeNamespace(path.basename(repoRoot));
  return {
    available: true,
    repoRoot,
    executionMode: 'project',
    worktree: {
      // `dirname(repoRoot)` is always outside the repository, so the suggestion
      // satisfies the settled "worktrees live outside the project" rule (S8).
      root: path.join(path.dirname(repoRoot), WORKTREE_DIR_NAME),
      namespace,
      branchPrefix: worktreeBranchPrefix(namespace),
      directoryPrefix: DIRECTORY_PREFIX,
      prepareCommand: detectPrepareCommand(repoRoot),
    },
  };
}
