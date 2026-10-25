/**
 * Per-leaf worktrees inside one todo tree (variant B).
 *
 * A tree keeps ONE tree worktree (branch `cretli/todo/<root>`). In parallel
 * mode every leaf gets its own worktree branched from the HEAD of the TREE
 * branch, so implementers, verify and review never share a directory (the
 * write slot keys on the execution folder, so distinct folders do not block
 * each other). After a leaf PASSes its branch is merged (3-way) into the tree
 * worktree under a tree-level lock; a conflict is aborted cleanly and handed
 * back to the leaf for a fix round on the current tree branch. Integration into
 * the repository HEAD still happens once, for the tree worktree.
 *
 * Cleanup never holds the registry lock for the slow part: the directory is
 * renamed into a trash folder (instant), Git forgets it, and the delete runs in
 * a detached low-priority process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureWorktreeAsync, updateWorktreeState } from './worktree-manager.js';
import { withWorktreePrepareLock } from './workspace-watcher-worktree.js';
import { getWorktreeRecord, listWorktreeRecords, withWorktreeRegistryLock, readWorktreeRegistry, writeWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { directorySizeBytes } from './worktree-deps.js';
import { createWorktreeLeafCheckpointAsync, resolveCommitAsync, resolveHeadCommitAsync, runGitAsync } from './worktree/git-worktree.ts';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.ts';
import {
  DEFAULT_WORKTREE_MAX_BEHIND,
  archiveWorktreeBranch,
  readWorktreeFreshnessFacts,
  saveWorktreeCarryPatch,
} from './worktree-manager.js';

/** Retention of integrated/rejected results under `data/worktree-results`. */
export const WORKTREE_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** `lastError.code` set on a leaf record whose merge into the tree conflicted. */
export const TREE_MERGE_CONFLICT_CODE = 'TREE_MERGE_CONFLICT';

/** `lastError.code` set on a leaf record whose merge into the tree threw. */
export const TREE_MERGE_FAILED_CODE = 'TREE_MERGE_FAILED';

const MERGE_IDENTITY = ['-c', 'user.name=Cretli', '-c', 'user.email=cretli@localhost'];

/**
 * Parallel leaf worktrees are on for a tree that is `parallel` + `worktree`
 * mode, or globally through `policy.parallelLeafWorktrees`. Anything else keeps
 * today's shared-tree-worktree behaviour.
 *
 * @param {{ tree?: Record<string, any> | null, policy?: Record<string, any> | null }} [input]
 * @returns {boolean}
 */
export function isParallelLeafWorktreeEnabled(input = {}) {
  if (input.policy?.parallelLeafWorktrees === false) return false;
  if (input.policy?.parallelLeafWorktrees === true) return true;
  const tree = input.tree;
  return Boolean(tree) && tree.runMode === 'parallel' && tree.executionMode === 'worktree';
}

/** Lock key shared by tree merges, leaf creation and tree refresh. */
const treeLockKey = (treeTodoId) => `tree-merge:${treeTodoId}`;

/**
 * Refresh a stale tree only when it is clean and no live agent can use it.
 * Unintegrated work is retained as both an immutable ref and a carry patch.
 *
 * The liveness/freshness/archive/reset sequence runs under the same per-tree
 * lock as {@link mergeLeafIntoTree} and {@link ensureLeafWorktree}, and the
 * facts are re-read inside it, so work that arrives while the caller was
 * waiting is archived (or blocks the reset) instead of being discarded. The
 * reset targets the CURRENT repository HEAD, never the worktree's own HEAD.
 */
export async function refreshStaleTreeBeforeLeaf(input = {}) {
  const tree = input?.treeRecord;
  if (!tree || tree.cleanedAt) return { refreshed: false, reason: 'tree_busy', behind: 0 };
  return withWorktreePrepareLock(treeLockKey(tree.todoId), () => refreshStaleTreeLocked(input));
}

async function refreshStaleTreeLocked(input) {
  const registryOptions = input.registryOptions || {};
  // Re-read the record inside the lock: state may have changed while queued.
  const tree = (input.registryOptions && getWorktreeRecord(input.treeRecord.todoId, registryOptions)) || input.treeRecord;
  if (!tree || tree.cleanedAt || tree.executionState === 'active' || tree.executionState === 'preparing') {
    return { refreshed: false, reason: 'tree_busy', behind: 0 };
  }
  if (typeof input.hasActiveAgent !== 'function') return { refreshed: false, reason: 'agent_check_unavailable', behind: 0 };
  if (input.hasActiveAgent(tree) !== false) return { refreshed: false, reason: 'agent_active', behind: 0 };
  const records = input.listRecords ? input.listRecords() : (input.registryOptions ? listWorktreeRecords(registryOptions) : []);
  if (records.some((r) => r.treeTodoId === tree.todoId && !r.cleanedAt && (r.executionState === 'active' || r.executionState === 'preparing'))) {
    return { refreshed: false, reason: 'tree_busy', behind: 0 };
  }
  const readFacts = input.readFacts || readWorktreeFreshnessFacts;
  const facts = await readFacts(tree);
  const max = Number.isFinite(Number(input.maxBehind))
    ? Math.max(0, Math.floor(Number(input.maxBehind)))
    : DEFAULT_WORKTREE_MAX_BEHIND;
  if (!input.force && (max === 0 || facts.behind <= max)) return { refreshed: false, reason: 'fresh', behind: facts.behind };
  if (facts.behind === 0) return { refreshed: false, reason: 'fresh', behind: 0 };
  const archive = input.archive || archiveWorktreeBranch;
  const archived = await archive(tree, { archiveRef: input.archiveRef });
  if (facts.unintegrated || facts.dirtyPaths > 0 || facts.aheadCommits > 0) {
    const saveCarry = input.saveCarry || saveWorktreeCarryPatch;
    let patchPath = null;
    try { patchPath = await saveCarry(tree, registryOptions); } catch { /* the archive ref remains recoverable */ }
    return {
      refreshed: false,
      reason: 'unresolved_checkpoint',
      archiveRef: archived.archiveRef,
      patchPath,
      behind: facts.behind,
    };
  }
  const repoRoot = tree.repoRoot || tree.workspaceFolder;
  const target = await (input.resolveHead || resolveHeadCommitAsync)(repoRoot);
  if (!target) throw new WorktreeError(WORKTREE_ERROR_CODES.MISSING, `Repository HEAD of ${repoRoot} cannot be resolved.`);
  const reset = input.reset || ((record, commit) => runGitAsync(['reset', '--hard', commit], record.worktreePath));
  await reset(tree, target);
  if (!input.skipRecordUpdate) {
    withWorktreeRegistryLock(() => {
      const doc = readWorktreeRegistry(registryOptions);
      const live = doc.items[tree.todoId];
      if (!live) return;
      live.baseCommit = target;
      live.baseKind = 'head';
      live.snapshotRef = '';
      live.snapshotOfHead = '';
      live.skippedPaths = [];
      live.updatedAt = new Date().toISOString();
      writeWorktreeRegistry(doc, registryOptions);
    }, registryOptions);
  }
  return { refreshed: true, reason: 'refreshed', archiveRef: archived.archiveRef, behind: facts.behind, baseCommit: target };
}

/** Backward-compatible name for callers that only need the stale preflight. */
export const archiveStaleTreeBeforeLeaf = refreshStaleTreeBeforeLeaf;

/**
 * Create (or reuse) the worktree of one leaf, branched from the tree branch HEAD.
 * Creation time is measured and returned so the caller can log it / expose it
 * in health.
 *
 * @param {{
 *   leafTodoId: string,
 *   treeRecord: Record<string, any>,
 *   config: Record<string, any>,
 *   registryOptions?: Record<string, any>,
 *   ensure?: Function,
 * }} input
 * @returns {Promise<{ record: Record<string, any>, created: boolean, createMs: number }>}
 */
export async function ensureLeafWorktree(input) {
  const tree = input.treeRecord;
  if (!tree?.worktreePath || !tree.branch || !tree.todoId) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, 'A live tree worktree record is required to branch a leaf worktree.');
  }
  // Serialized with tree refresh/merge so the branch point cannot move mid-creation.
  return withWorktreePrepareLock(treeLockKey(tree.todoId), () => ensureLeafWorktreeLocked(input, tree));
}

async function ensureLeafWorktreeLocked(input, tree) {
  const treeHead = await resolveCommitAsync(tree.branch, tree.repoRoot || tree.workspaceFolder);
  if (!treeHead) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.MISSING, `Tree branch ${tree.branch} cannot be resolved.`);
  }
  const ensure = input.ensure || ensureWorktreeAsync;
  const startedAt = Date.now();
  const result = await ensure({
    todoId: input.leafTodoId,
    workspaceFolder: tree.workspaceFolder,
    mode: 'worktree',
    config: input.config,
    registryOptions: input.registryOptions || {},
    baseCommit: treeHead,
    // The base is explicit, so the state of the main checkout is irrelevant here.
    dirtyPolicy: 'head',
    treeTodoId: tree.todoId,
    treeBranch: tree.branch,
  });
  return { record: result.record, created: result.created === true, createMs: Date.now() - startedAt };
}

/**
 * @param {Record<string, any>} record
 * @param {string[]} args
 * @param {boolean} [allowFailure]
 */
function gitIn(record, cwd, args, allowFailure = false) {
  return runGitAsync(args, cwd, { allowFailure });
}

/**
 * Finish a merge left pending by {@link syncLeafWithTree} once the implementer
 * resolved the conflicts, so the checkpoint keeps the tree branch as a parent.
 *
 * @param {Record<string, any>} leaf
 */
async function completePendingMerge(leaf) {
  const pending = await gitIn(leaf, leaf.worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true);
  if (pending.status !== 0) return;
  await gitIn(leaf, leaf.worktreePath, ['add', '-A', '--', '.']);
  await gitIn(leaf, leaf.worktreePath, [...MERGE_IDENTITY, 'commit', '--no-edit']);
}

/**
 * Merge a PASSed leaf into the tree worktree. Serialized per tree. The leaf
 * working tree is checkpointed onto its branch first so the merge sees
 * uncommitted work. On a conflict the merge is aborted (the tree worktree stays
 * clean) and the conflicting paths are returned.
 *
 * @param {{ leafRecord: Record<string, any>, treeRecord: Record<string, any>, run?: Function }} input
 * @returns {Promise<{ status: 'merged' | 'conflict' | 'noop', commit?: string, conflicts?: string[], message: string }>}
 */
export function mergeLeafIntoTree(input) {
  const leaf = input.leafRecord;
  const tree = input.treeRecord;
  return withWorktreePrepareLock(treeLockKey(tree.todoId), async () => {
    const treePath = tree.worktreePath;
    await completePendingMerge(leaf);
    await createWorktreeLeafCheckpointAsync(leaf.worktreePath, leaf.todoId, leaf.branch);
    const dirty = (await gitIn(tree, treePath, ['status', '--porcelain'])).stdout.trim();
    if (dirty) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.DIRTY, `Tree worktree ${treePath} has uncommitted changes; refusing to merge leaf ${leaf.todoId} into it.`, { details: { dirty: dirty.split('\n').slice(0, 20) } });
    }
    const ahead = (await gitIn(tree, treePath, ['rev-list', '--count', `HEAD..${leaf.branch}`])).stdout.trim();
    if (ahead === '0') return { status: 'noop', message: `Leaf ${leaf.todoId} has nothing new for the tree branch.` };
    const merge = await gitIn(tree, treePath, [...MERGE_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `Cretli tree merge: leaf ${leaf.todoId} into tree ${tree.todoId}`, leaf.branch], true);
    if (merge.status === 0) {
      const commit = (await gitIn(tree, treePath, ['rev-parse', 'HEAD'])).stdout.trim();
      return { status: 'merged', commit, message: `Leaf ${leaf.todoId} merged into ${tree.branch}.` };
    }
    const conflicts = (await gitIn(tree, treePath, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    await gitIn(tree, treePath, ['merge', '--abort'], true);
    return {
      status: 'conflict',
      conflicts,
      message: `Leaf ${leaf.todoId} conflicts with the tree branch in ${conflicts.length ? conflicts.join(', ') : 'unknown paths'}; fix round on the current tree branch required.`,
    };
  });
}

/**
 * Bring the current tree branch into a leaf worktree (the fix round after a
 * merge conflict). The leaf is checkpointed first; conflict markers are left in
 * the leaf worktree for the implementer to resolve.
 *
 * @param {{ leafRecord: Record<string, any>, treeRecord: Record<string, any> }} input
 * @returns {Promise<{ clean: boolean, conflicts: string[] }>}
 */
export async function syncLeafWithTree(input) {
  const leaf = input.leafRecord;
  await completePendingMerge(leaf);
  await createWorktreeLeafCheckpointAsync(leaf.worktreePath, leaf.todoId, leaf.branch);
  const merge = await gitIn(leaf, leaf.worktreePath, [...MERGE_IDENTITY, 'merge', '--no-edit', '-m', `Cretli tree merge: tree ${input.treeRecord.todoId} into leaf ${leaf.todoId}`, input.treeRecord.branch], true);
  if (merge.status === 0) return { clean: true, conflicts: [] };
  const conflicts = (await gitIn(leaf, leaf.worktreePath, ['diff', '--name-only', '--diff-filter=U'], true)).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return { clean: false, conflicts };
}

/**
 * Remove a worktree directory without blocking: the registry lock is held only
 * for the rename into a trash folder and the record update; Git is told to
 * forget the checkout; the delete itself is a detached low-priority process.
 *
 * @param {{
 *   todoId: string,
 *   registryOptions?: Record<string, any>,
 *   deleteBranch?: boolean,
 *   spawnFn?: Function,
 * }} input
 * @returns {Promise<{ removed: boolean, trashPath: string, done: Promise<{ freedBytes: number }> }>}
 */
export async function removeWorktreeInBackground(input) {
  const registryOptions = input.registryOptions || {};
  const spawnFn = input.spawnFn || spawn;
  const moved = withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(registryOptions);
    const record = doc.items[input.todoId];
    if (!record) throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, `No worktree record for todo ${input.todoId}.`);
    if (record.cleanedAt) return { record, trashPath: '' };
    if (record.executionState === 'preparing' || record.executionState === 'active') {
      throw new WorktreeError(WORKTREE_ERROR_CODES.BUSY, `Worktree for ${input.todoId} is ${record.executionState}; close the execution before cleanup.`);
    }
    let trashPath = '';
    if (fs.existsSync(record.worktreePath)) {
      const trashRoot = path.join(path.dirname(record.worktreePath), '.trash');
      fs.mkdirSync(trashRoot, { recursive: true });
      trashPath = path.join(trashRoot, `${path.basename(record.worktreePath)}-${Date.now()}`);
      fs.renameSync(record.worktreePath, trashPath);
    }
    const now = new Date().toISOString();
    record.cleanedAt = now;
    record.updatedAt = now;
    writeWorktreeRegistry(doc, registryOptions);
    return { record, trashPath };
  }, registryOptions);
  const { record, trashPath } = moved;
  const repoRoot = record.repoRoot || record.workspaceFolder;
  // Outside the lock: let Git forget the moved checkout and drop the merged branch.
  await runGitAsync(['worktree', 'prune'], repoRoot, { allowFailure: true });
  if (input.deleteBranch === true) await runGitAsync(['branch', '-D', record.branch], repoRoot, { allowFailure: true });
  if (!trashPath) return { removed: false, trashPath: '', done: Promise.resolve({ freedBytes: 0 }) };
  const done = new Promise((resolve) => {
    const freedBytes = directorySizeBytes(trashPath);
    const finish = () => resolve({ freedBytes });
    try {
      // nice + ionice keep the delete from starving the server; fall back to plain rm.
      const child = spawnFn('nice', ['-n', '19', 'ionice', '-c', '3', 'rm', '-rf', trashPath], { stdio: 'ignore', detached: true });
      child.on?.('error', () => { fs.rm(trashPath, { recursive: true, force: true }, finish); });
      child.on?.('exit', finish);
    } catch {
      fs.rm(trashPath, { recursive: true, force: true }, finish);
    }
  });
  return { removed: true, trashPath, done };
}

/**
 * Delete retained result directories older than the retention window.
 *
 * @param {{ dataDir: string, now?: number, maxAgeMs?: number }} input
 * @returns {{ removed: string[], freedBytes: number }}
 */
export function pruneWorktreeResults(input) {
  const root = path.join(input.dataDir, 'worktree-results');
  const now = input.now ?? Date.now();
  const maxAge = input.maxAgeMs ?? WORKTREE_RESULT_RETENTION_MS;
  /** @type {string[]} */ const removed = [];
  let freedBytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { removed, freedBytes }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let mtime;
    try { mtime = fs.statSync(dir).mtimeMs; } catch { continue; }
    if (now - mtime < maxAge) continue;
    freedBytes += directorySizeBytes(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed, freedBytes };
}

/** @param {string} todoId @param {Record<string, any>} [registryOptions] */
export function getTreeOfLeaf(todoId, registryOptions = {}) {
  const record = getWorktreeRecord(todoId, registryOptions);
  return record?.treeTodoId ? getWorktreeRecord(record.treeTodoId, registryOptions) : null;
}

/**
 * After the tree was integrated into the repository HEAD, drop the tree
 * worktree in the background. Only trees that used per-leaf worktrees are
 * cleaned automatically (today's shared-worktree trees keep their explicit
 * cleanup), and never while a leaf worktree of the tree is still live. The
 * integration patch stays in `data/worktree-results` for the retention window.
 *
 * @param {{ todoId: string, registryOptions?: Record<string, any>, removeFn?: Function }} input
 * @returns {Promise<{ removed: boolean, reason?: string, freed?: Promise<{ freedBytes: number }> }>}
 */
export async function cleanupIntegratedTreeWorktree(input) {
  const registryOptions = input.registryOptions || {};
  const tree = getWorktreeRecord(input.todoId, registryOptions);
  if (!tree || tree.cleanedAt) return { removed: false, reason: 'no_tree_worktree' };
  const leaves = listWorktreeRecords(registryOptions).filter((record) => record.treeTodoId === input.todoId);
  if (leaves.length === 0) return { removed: false, reason: 'not_a_parallel_leaf_tree' };
  if (leaves.some((record) => !record.cleanedAt)) return { removed: false, reason: 'leaf_worktrees_live' };
  if (tree.integrationState !== 'integrated') return { removed: false, reason: 'not_integrated' };
  updateWorktreeState({ todoId: input.todoId, registryOptions, executionState: 'execution_closed' });
  const remove = input.removeFn || removeWorktreeInBackground;
  const out = await remove({ todoId: input.todoId, registryOptions, deleteBranch: true });
  return { removed: out.removed, freed: out.done };
}
