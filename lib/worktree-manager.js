/**
 * Server-managed worktree lifecycle (contract §5–§9, §11).
 *
 * This module owns creation, the durable registry link, restart reconciliation
 * and explicit cleanup. It deliberately does **not** implement patch
 * integration, prepare or the review/done gate — those are later leaves.
 *
 * Fail-closed rules that keep OPEN decisions unsettled:
 * - O3: layout/naming is caller configuration; no default path is invented.
 * - O4: a missing, foreign or orphaned worktree is reported/refused, never
 *   adopted, reset, recreated or force-removed.
 * - O6: a dirty logical tree always blocks a new worktree; no "from HEAD" mode.
 * - O9: a retry reuses the frozen record/base; a cleaned record is not rebuilt.
 * - O1: the mode resolver never walks ancestors (see worktree-mode.js).
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persist/atomic-write.js';
import {
  readWorktreeRegistry,
  writeWorktreeRegistry as persistWorktreeRegistry,
  withWorktreeRegistryLock,
} from './persist/worktree-registry-persist.js';
import {
  branchExists as gitBranchExists,
  gitWorktreeAdd,
  gitWorktreeAddAsync,
  gitWorktreeRemove,
  isGitRepository,
  isWorkingTreeClean,
  isWorkingTreeCleanAsync,
  listDirtyWorktreePaths,
  listDirtyWorktreePathsAsync,
  createDirtyTreeSnapshot,
  createDirtyTreeSnapshotAsync,
  removeDirtyTreeSnapshotRef,
  removeDirtyTreeSnapshotRefAsync,
  listBranchesWithPrefix,
  listGitWorktrees,
  resolveCommit,
  resolveHeadCommit,
  resolveRepositoryRoot,
  resolveRepositoryRootAsync,
  resolveWorktreeGitDir,
  runGit,
  runGitAsync,
} from './worktree/git-worktree.ts';
import { invalidateWorktreeListCache } from './worktree-list-cache.js';
import {
  createWorktreeRecord,
  assertExecutionState,
  assertIntegrationState,
  isWorktreeRecordLive,
} from './worktree/worktree-record.ts';
import { isPathInside, normalizeWorktreeTodoId, resolveWorktreeLayout } from './worktree/worktree-layout.ts';
import { assertWorktreeMode, normalizeWorktreeDirtyPolicy } from './worktree/worktree-mode.ts';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.ts';

/**
 * Registry write that also drops the cached worktree list.
 *
 * @param {Parameters<typeof persistWorktreeRegistry>[0]} doc
 * @param {Parameters<typeof persistWorktreeRegistry>[1]} [options]
 * @returns {ReturnType<typeof persistWorktreeRegistry>}
 */
function writeWorktreeRegistry(doc, options) {
  try {
    return persistWorktreeRegistry(doc, options);
  } finally {
    invalidateWorktreeListCache();
  }
}

export const WORKTREE_OWNER_MARKER_FILE = 'cretli-worktree.json';
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  return Boolean(left) && left === right;
}

/**
 * @param {Record<string, any>} record
 * @returns {string}
 */
function repoRootOf(record) {
  return record.repoRoot || record.workspaceFolder;
}

/**
 * @param {string} worktreePath
 * @returns {string | null}
 */
export function worktreeOwnerMarkerPath(worktreePath) {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  return gitDir ? path.join(gitDir, WORKTREE_OWNER_MARKER_FILE) : null;
}

/**
 * The ownership marker lives in the worktree's Git admin directory, so it is
 * durable, never part of the working tree (no dirty status) and gone exactly
 * when the worktree is gone.
 *
 * @param {string} worktreePath
 * @param {Record<string, any>} record
 * @returns {string}
 */
export function writeWorktreeOwnerMarker(worktreePath, record) {
  const markerPath = worktreeOwnerMarkerPath(worktreePath);
  if (!markerPath) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.FOREIGN,
      `Cannot write the ownership marker: ${worktreePath} is not a Git worktree.`,
    );
  }
  writeJsonAtomic(markerPath, {
    v: 1,
    todoId: record.todoId,
    workspaceFolder: record.workspaceFolder,
    branch: record.branch,
    baseCommit: record.baseCommit,
  });
  return markerPath;
}

/**
 * @param {string} worktreePath
 * @returns {{ todoId?: string, branch?: string, baseCommit?: string } | null}
 */
export function readWorktreeOwnerMarker(worktreePath) {
  const markerPath = worktreeOwnerMarkerPath(worktreePath);
  if (!markerPath || !fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const LEAF_CHECKPOINT_SUBJECT_PREFIX = 'Cretli leaf checkpoint for ';
/** Subject prefix of the merge commits made by lib/worktree-tree-leaf.js. */
const TREE_MERGE_SUBJECT_PREFIX = 'Cretli tree merge: ';

/**
 * True when every commit between the frozen base and HEAD is a server-made leaf
 * checkpoint, so the move is Cretli's own and not an external change.
 *
 * @param {string} repoRoot
 * @param {string} baseCommit
 * @param {string} head
 * @returns {boolean}
 */
export function isOnlyLeafCheckpointsAhead(repoRoot, baseCommit, head) {
  if (!baseCommit || !head) return false;
  const range = runGit(['log', '--format=%s', `${baseCommit}..${head}`], repoRoot, { allowFailure: true });
  if (range.status !== 0) return false;
  const subjects = range.stdout.split('\n').filter(Boolean);
  if (subjects.length === 0) return false;
  const behind = runGit(['rev-list', '--count', `${head}..${baseCommit}`], repoRoot, { allowFailure: true });
  if (behind.status !== 0 || behind.stdout.trim() !== '0') return false;
  return subjects.every((subject) => subject.startsWith(LEAF_CHECKPOINT_SUBJECT_PREFIX) || subject.startsWith(TREE_MERGE_SUBJECT_PREFIX));
}

/**
 * Async twin of {@link isOnlyLeafCheckpointsAhead}: same answer, but the event
 * loop keeps running while Git works, so many rows can be checked concurrently.
 *
 * @param {string} repoRoot
 * @param {string} baseCommit
 * @param {string} head
 * @returns {Promise<boolean>}
 */
export async function isOnlyLeafCheckpointsAheadAsync(repoRoot, baseCommit, head) {
  if (!baseCommit || !head) return false;
  const [range, behind] = await Promise.all([
    runGitAsync(['log', '--format=%s', `${baseCommit}..${head}`], repoRoot, { allowFailure: true }),
    runGitAsync(['rev-list', '--count', `${head}..${baseCommit}`], repoRoot, { allowFailure: true }),
  ]);
  if (range.status !== 0) return false;
  const subjects = range.stdout.split('\n').filter(Boolean);
  if (subjects.length === 0) return false;
  if (behind.status !== 0 || behind.stdout.trim() !== '0') return false;
  return subjects.every((subject) => subject.startsWith(LEAF_CHECKPOINT_SUBJECT_PREFIX) || subject.startsWith(TREE_MERGE_SUBJECT_PREFIX));
}

/**
 * Verify a registry record against Git and the ownership marker. Never mutates.
 *
 * @param {Record<string, any>} record
 * @param {{ gitWorktrees?: ReturnType<typeof listGitWorktrees>, onlyLeafCheckpointsAhead?: boolean }} [options]
 *   `onlyLeafCheckpointsAhead` is a precomputed {@link isOnlyLeafCheckpointsAhead}
 *   answer for callers that ran it asynchronously.
 * @returns {{ ok: boolean, status: string, message: string }}
 */
export function verifyWorktreeRecord(record, options = {}) {
  const worktreePath = String(record?.worktreePath ?? '').trim();
  if (!worktreePath) return { ok: false, status: 'missing', message: 'The record has no worktree path.' };
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, status: 'missing', message: `Worktree directory is missing: ${worktreePath}.` };
  }
  const repoRoot = repoRootOf(record);
  if (record.baseKind === 'snapshot' && resolveCommit(record.snapshotRef, repoRoot) !== record.baseCommit) {
    return { ok: false, status: 'external_change', message: `Snapshot ref ${record.snapshotRef || '(missing)'} no longer points to the frozen base ${record.baseCommit}.` };
  }
  let worktrees = options.gitWorktrees;
  if (!worktrees) {
    try {
      worktrees = listGitWorktrees(repoRoot);
    } catch (error) {
      return {
        ok: false,
        status: 'repo_unavailable',
        message: `Could not read Git worktrees for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const entry = worktrees.find((candidate) => samePath(candidate.path, worktreePath));
  if (!entry) {
    return {
      ok: false,
      status: 'foreign',
      message: `Directory exists but is not a registered Git worktree of ${repoRoot}: ${worktreePath}.`,
    };
  }
  if (entry.branch !== record.branch) {
    return {
      ok: false,
      status: 'foreign',
      message: `Worktree branch mismatch: record has ${record.branch}, Git has ${entry.branch || '(detached)'}.`,
    };
  }
  if (entry.head !== record.baseCommit
    && !(typeof options.onlyLeafCheckpointsAhead === 'boolean'
      ? options.onlyLeafCheckpointsAhead
      : isOnlyLeafCheckpointsAhead(repoRoot, record.baseCommit, entry.head))) {
    return {
      ok: false,
      status: 'external_change',
      message: `Worktree HEAD ${entry.head || '(unknown)'} no longer matches the frozen base ${record.baseCommit}.`,
    };
  }
  const marker = readWorktreeOwnerMarker(worktreePath);
  if (!marker || marker.todoId !== record.todoId || marker.branch !== record.branch) {
    return {
      ok: false,
      status: 'owner_mismatch',
      message: `Ownership marker for todo ${record.todoId} is missing or does not match; refusing to adopt.`,
    };
  }
  return { ok: true, status: 'verified', message: '' };
}

/**
 * @param {string} status
 * @returns {string}
 */
function statusToErrorCode(status) {
  switch (status) {
    case 'missing':
      return WORKTREE_ERROR_CODES.MISSING;
    case 'owner_mismatch':
      return WORKTREE_ERROR_CODES.OWNER_MISMATCH;
    case 'external_change':
      return WORKTREE_ERROR_CODES.EXTERNAL_CHANGE;
    case 'foreign':
    case 'repo_unavailable':
    default:
      return WORKTREE_ERROR_CODES.FOREIGN;
  }
}

/**
 * @param {Record<string, any>} record
 * @param {Record<string, any>} params
 * @returns {Record<string, any>}
 */
function finalizeCreation(record, params) {
  writeWorktreeOwnerMarker(record.worktreePath, record);
  const now = new Date().toISOString();
  record.creationState = 'ready';
  record.executionState = 'none';
  record.integrationState = 'not_applicable';
  record.updatedAt = now;
  params.doc.items[record.todoId] = record;
  params.write(params.doc);
  return record;
}

/**
 * Resume an interrupted creation. Safe because nothing was executed yet: only
 * the reservation and possibly the empty worktree exist.
 *
 * @param {Record<string, any>} record
 * @param {{ repoRoot: string, doc: Record<string, any>, write: (doc: Record<string, any>) => Record<string, any> }} params
 * @returns {Record<string, any>}
 */
function resumeCreation(record, params) {
  const worktreePath = record.worktreePath;
  if (fs.existsSync(worktreePath)) {
    const worktrees = listGitWorktrees(params.repoRoot);
    const entry = worktrees.find((candidate) => samePath(candidate.path, worktreePath));
    if (!entry) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.FOREIGN,
        `Cannot resume creation: ${worktreePath} exists but is not a Git worktree; inspect it by hand.`,
      );
    }
    if (entry.branch !== record.branch) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.FOREIGN,
        `Cannot resume creation: ${worktreePath} is bound to branch ${entry.branch || '(detached)'}, not ${record.branch}.`,
      );
    }
    if (entry.head !== record.baseCommit) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.EXTERNAL_CHANGE,
        `Cannot resume creation: worktree HEAD ${entry.head} moved from the reserved base ${record.baseCommit}.`,
      );
    }
    return finalizeCreation(record, params);
  }
  const hasBranch = gitBranchExists(params.repoRoot, record.branch);
  if (hasBranch) {
    const branchHead = resolveCommit(record.branch, params.repoRoot);
    if (branchHead !== record.baseCommit) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BRANCH_COLLISION,
        `Cannot resume creation: branch ${record.branch} already exists at ${branchHead || 'an unknown commit'}, not the reserved base ${record.baseCommit}.`,
      );
    }
  }
  gitWorktreeAdd({
    repoRoot: params.repoRoot,
    worktreePath,
    branch: record.branch,
    baseCommit: record.baseCommit,
    branchExists: hasBranch,
  });
  return finalizeCreation(record, params);
}

/**
 * @param {Record<string, any>} record
 * @param {string} repoRoot
 * @returns {boolean}
 */
/**
 * True when a stored record still fits the current layout configuration.
 *
 * A record adopted from a descendant (`adoptDescendantWorktree`) is re-keyed to
 * the tree root but keeps the descendant's directory and branch. That is not a
 * layout change: the record still matches the layout of the todo its branch
 * names, so the root start reuses it instead of refusing it as re-pointed.
 *
 * @param {Record<string, any>} existing
 * @param {{ worktreePath: string, branch: string, branchPrefix?: string }} layout
 * @param {unknown} config
 * @returns {boolean}
 */
function matchesFrozenLayout(existing, layout, config) {
  if (samePath(existing.worktreePath, layout.worktreePath) && existing.branch === layout.branch) return true;
  const branch = String(existing.branch || '');
  const prefix = String(layout.branchPrefix || '');
  if (!prefix || !branch.startsWith(prefix)) return false;
  let owner;
  try {
    owner = resolveWorktreeLayout(config, branch.slice(prefix.length));
  } catch {
    return false;
  }
  return samePath(existing.worktreePath, owner.worktreePath) && existing.branch === owner.branch;
}

function isAbandonedReleasedRecord(record, repoRoot) {
  return Boolean(record.releasedAt) && !record.cleanedAt && record.creationState !== 'reserved'
    && !fs.existsSync(record.worktreePath) && !gitBranchExists(repoRoot, record.branch);
}

/**
 * Create or reuse the persistent worktree for one todo.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   mode: string,
 *   config: object,
 *   baseCommit?: string,
 *   dirtyPolicy?: 'block' | 'head' | 'snapshot',
 *   treeTodoId?: string,
 *   treeBranch?: string,
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number }
 * }} params
 * @returns {{ record: Record<string, any>, created: boolean, reused: boolean, recovered: boolean }}
 */
export function ensureWorktree(params) {
  return ensureWorktreeLocked(params, null);
}

/** Creations in flight, keyed by workspace + todo; a second caller joins the first. */
const ensureInFlight = new Map();

/**
 * Non-blocking {@link ensureWorktree}. The expensive Git work of a fresh
 * creation (dirty-tree status, snapshot, `worktree add`) runs off the event
 * loop: facts are read before the registry lock, the reservation is written
 * under the lock, the checkout runs with the lock released, and a second short
 * lock finalizes the record. A crash mid-checkout leaves the same recoverable
 * `reserved` record the synchronous path does.
 *
 * @param {Parameters<typeof ensureWorktree>[0]} params
 * @returns {Promise<ReturnType<typeof ensureWorktree>>}
 */
export function ensureWorktreeAsync(params) {
  const key = `${canonicalPath(params?.workspaceFolder)}\0${String(params?.todoId ?? '').trim()}`;
  const joined = ensureInFlight.get(key);
  if (joined) return joined;
  const run = ensureWorktreeAsyncUnshared(params).finally(() => {
    if (ensureInFlight.get(key) === run) ensureInFlight.delete(key);
  });
  ensureInFlight.set(key, run);
  return run;
}

/**
 * @param {Parameters<typeof ensureWorktree>[0]} params
 * @returns {Promise<ReturnType<typeof ensureWorktree>>}
 */
async function ensureWorktreeAsyncUnshared(params) {
  const workspace = canonicalPath(params?.workspaceFolder);
  const registryOptions = params?.registryOptions || {};
  const todoId = normalizeWorktreeTodoId(params?.todoId);
  const existing = workspace ? readWorktreeRegistry(registryOptions).items[todoId] : null;
  // Only a brand-new creation needs the heavy reads; every other branch of the
  // locked section is cheap and stays synchronous.
  if (!workspace || existing) return ensureWorktreeLocked(params, null);
  // Same validation order as the locked section: an invalid layout is reported before the repository.
  resolveWorktreeLayout(params?.config, todoId);
  const repoRoot = await resolveRepositoryRootAsync(workspace);
  const dirtyPolicy = normalizeWorktreeDirtyPolicy(params?.dirtyPolicy);
  const dirtyPaths = (await isWorkingTreeCleanAsync(repoRoot)) ? [] : await listDirtyWorktreePathsAsync(repoRoot);
  /** @type {{ dirtyPaths: string[], snapshot: Record<string, any> | null, deferred: { repoRoot: string, worktreePath: string, branch: string, baseCommit: string, branchExists: boolean } | null }} */
  const prefetch = { dirtyPaths, snapshot: null, deferred: null };
  if (dirtyPaths.length && dirtyPolicy === 'snapshot' && !String(params?.baseCommit ?? '').trim()) {
    prefetch.snapshot = await createDirtyTreeSnapshotAsync(repoRoot, todoId);
  }
  let result;
  try {
    result = ensureWorktreeLocked(params, prefetch);
  } catch (error) {
    // The locked section refused before using the snapshot: do not leak its ref.
    if (prefetch.snapshot && !prefetch.snapshot.used) await removeDirtyTreeSnapshotRefAsync(repoRoot, prefetch.snapshot.ref);
    throw error;
  }
  const pending = prefetch.deferred;
  if (!pending) return result;
  await gitWorktreeAddAsync(pending);
  return withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(registryOptions);
    const record = doc.items[todoId];
    if (!record) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, `Worktree reservation for ${todoId} disappeared during creation.`);
    }
    finalizeCreation(record, { doc, write: (next) => writeWorktreeRegistry(next, registryOptions) });
    return { record, created: true, reused: false, recovered: false };
  }, registryOptions);
}

/**
 * @param {Parameters<typeof ensureWorktree>[0]} params
 * @param {{ dirtyPaths: string[], snapshot: Record<string, any> | null, deferred: { repoRoot: string, worktreePath: string, branch: string, baseCommit: string, branchExists: boolean } | null } | null} prefetch
 *   facts read off the event loop; when set, the checkout is deferred to the caller
 */
function ensureWorktreeLocked(params, prefetch) {
  const todoId = normalizeWorktreeTodoId(params?.todoId);
  assertWorktreeMode(params?.mode);
  const workspace = canonicalPath(params?.workspaceFolder);
  if (!workspace) {
    throw new WorktreeError(WORKTREE_ERROR_CODES.NOT_GIT, 'A workspace folder is required for worktree mode.');
  }
  const layout = resolveWorktreeLayout(params?.config, todoId);
  const repoRoot = resolveRepositoryRoot(workspace);
  if (isPathInside(repoRoot, layout.worktreePath)) {
    throw new WorktreeError(
      WORKTREE_ERROR_CODES.CONFIG_INVALID,
      `Worktree path must live outside the repository (got ${layout.worktreePath} inside ${repoRoot}); see OPEN O3.`,
    );
  }
  const registryOptions = params.registryOptions || {};
  return withWorktreeRegistryLock(() => {
    /** @type {any} */
    let doc = readWorktreeRegistry(registryOptions);
    const write = (next) => {
      doc = writeWorktreeRegistry(next, registryOptions);
      return doc;
    };
    let existing = doc.items[todoId];
    // A released record whose directory and branch are both gone holds no work:
    // drop it so this start creates a fresh worktree instead of failing forever.
    if (existing && isAbandonedReleasedRecord(existing, repoRoot)) {
      delete doc.items[todoId];
      existing = null;
    }
    if (existing) {
      if (!samePath(existing.workspaceFolder, workspace)) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
          `Worktree record for ${todoId} belongs to ${existing.workspaceFolder}, not ${workspace}.`,
        );
      }
      if (existing.repoRoot && !samePath(existing.repoRoot, repoRoot)) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
          `Worktree record for ${todoId} was created in repository ${existing.repoRoot}, not ${repoRoot}.`,
        );
      }
      if (!matchesFrozenLayout(existing, layout, params?.config)) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.REGISTRY_CONFLICT,
          `Worktree record for ${todoId} is frozen to ${existing.worktreePath} (${existing.branch}); layout configuration changed, refusing to re-point it.`,
        );
      }
      if (existing.cleanedAt) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.MISSING,
          `Worktree for ${todoId} was explicitly cleaned up; start a new execution instead of retrying (OPEN O9).`,
        );
      }
      if (existing.creationState === 'reserved') {
        const record = resumeCreation(existing, { repoRoot, doc, write });
        return { record, created: true, reused: false, recovered: true };
      }
      const verification = verifyWorktreeRecord(existing, { gitWorktrees: listGitWorktrees(repoRoot) });
      if (verification.ok) {
        if (existing.releasedAt) {
          // An explicit worktree-mode start re-adopts a released worktree.
          existing.releasedAt = null;
          existing.updatedAt = new Date().toISOString();
          write(doc);
        }
        return { record: existing, created: false, reused: true, recovered: false };
      }
      throw new WorktreeError(statusToErrorCode(verification.status), verification.message, {
        details: { todoId, status: verification.status },
      });
    }

    // No record: a fresh creation. Never adopt anything already on disk (S9).
    if (fs.existsSync(layout.worktreePath)) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.PATH_EXISTS,
        `Path already exists and is not registered to todo ${todoId}: ${layout.worktreePath}; refusing to adopt it (S9/O4).`,
      );
    }
    if (gitBranchExists(repoRoot, layout.branch)) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BRANCH_COLLISION,
        `Branch ${layout.branch} already exists without a registered worktree; refusing to reuse or reset it (O4).`,
      );
    }
    const dirtyPaths = prefetch ? prefetch.dirtyPaths : (isWorkingTreeClean(repoRoot) ? [] : listDirtyWorktreePaths(repoRoot));
    const dirtyPolicy = normalizeWorktreeDirtyPolicy(params?.dirtyPolicy);
    if (!dirtyPolicy) throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, `Invalid dirtyPolicy ${JSON.stringify(params?.dirtyPolicy)}; expected block, head or snapshot.`);
    if (dirtyPaths.length && dirtyPolicy === 'block') throw new WorktreeError(WORKTREE_ERROR_CODES.DIRTY, `Logical tree of ${repoRoot} has uncommitted changes; commit by hand or choose an explicit dirty-tree start policy.`, { details: { dirtyPaths } });
    let baseCommit = String(params?.baseCommit ?? '').trim();
    let baseKind = dirtyPaths.length ? dirtyPolicy : 'clean';
    let snapshotOfHead = '';
    let snapshotRef = '';
    if (baseCommit) {
      if (!FULL_SHA_PATTERN.test(baseCommit)) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.CONFIG_INVALID,
          `Base commit must be a full SHA (got ${JSON.stringify(baseCommit)}).`,
        );
      }
      const resolved = resolveCommit(baseCommit, repoRoot);
      if (!resolved || resolved.toLowerCase() !== baseCommit.toLowerCase()) {
        throw new WorktreeError(
          WORKTREE_ERROR_CODES.CONFIG_INVALID,
          `Base commit ${baseCommit} does not exist in ${repoRoot}.`,
        );
      }
      baseCommit = resolved;
    } else if (dirtyPaths.length && dirtyPolicy === 'snapshot') {
      const snapshot = prefetch?.snapshot || createDirtyTreeSnapshot(repoRoot, todoId);
      if (prefetch?.snapshot) prefetch.snapshot.used = true;
      baseCommit = snapshot.commit;
      snapshotOfHead = snapshot.headCommit;
      snapshotRef = snapshot.ref;
    } else {
      baseCommit = resolveHeadCommit(repoRoot);
    }
    const now = new Date().toISOString();
    const record = createWorktreeRecord({
      todoId,
      workspaceFolder: workspace,
      repoRoot,
      worktreePath: layout.worktreePath,
      branch: layout.branch,
      baseCommit,
      baseKind,
      skippedPaths: baseKind === 'head' ? dirtyPaths : [],
      snapshotOfHead,
      snapshotRef,
      creationState: 'reserved',
      executionState: 'none',
      integrationState: 'not_applicable',
      treeTodoId: String(params?.treeTodoId ?? '').trim(),
      treeBranch: String(params?.treeBranch ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    });
    doc.items[todoId] = record;
    // Persist the reservation before touching Git so a crash is recoverable.
    write(doc);
    const addParams = {
      repoRoot,
      worktreePath: layout.worktreePath,
      branch: layout.branch,
      baseCommit,
      branchExists: false,
    };
    if (prefetch) {
      // The caller runs the checkout without holding the registry lock.
      prefetch.deferred = addParams;
      return { record, created: true, reused: false, recovered: false };
    }
    gitWorktreeAdd(addParams);
    finalizeCreation(record, { doc, write });
    return { record, created: true, reused: false, recovered: false };
  }, registryOptions);
}

/**
 * Record state without implementing any gate. Later leaves call this after
 * review PASS / integration / rejection; this module only validates the
 * settled vocabulary and appends unique cycle/chat links.
 *
 * @param {{
 *   todoId: string,
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number },
 *   executionState?: string,
 *   integrationState?: string,
 *   cycleId?: string,
 *   chatId?: string
 * }} params
 * @returns {Record<string, any>}
 */
export function updateWorktreeState(params) {
  const todoId = normalizeWorktreeTodoId(params?.todoId);
  const registryOptions = params.registryOptions || {};
  return withWorktreeRegistryLock(() => {
    /** @type {any} */
    let doc = readWorktreeRegistry(registryOptions);
    const record = doc.items[todoId];
    if (!record) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.RECORD_MISSING,
        `No worktree record for todo ${todoId}.`,
      );
    }
    if (params.executionState !== undefined) record.executionState = assertExecutionState(params.executionState);
    if (params.integrationState !== undefined) record.integrationState = assertIntegrationState(params.integrationState);
    const cycleId = String(params.cycleId ?? '').trim();
    if (cycleId && !record.cycles.includes(cycleId)) record.cycles.push(cycleId);
    const chatId = String(params.chatId ?? '').trim();
    if (chatId && !record.chats.includes(chatId)) record.chats.push(chatId);
    record.updatedAt = new Date().toISOString();
    writeWorktreeRegistry(doc, registryOptions);
    return record;
  }, registryOptions);
}

/**
 * Reconcile the registry with `git worktree list --porcelain`. Read-only:
 * classifications are returned, records are never rewritten and nothing is
 * removed (contract §6.5, §8.9).
 *
 * @param {{
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number },
 *   config?: object,
 *   workspaceFolder?: string
 * }} [options]
 * @returns {{ entries: Record<string, any>[], foreign: Record<string, any>[], orphanBranches: Record<string, any>[], counts: Record<string, number> }}
 */
export function reconcileWorktreeRegistry(options = {}) {
  const registryOptions = options.registryOptions || {};
  const workspaceFilter = canonicalPath(options.workspaceFolder);
  return withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(registryOptions);
    const records = Object.values(doc.items).filter((record) =>
      workspaceFilter ? samePath(record.workspaceFolder, workspaceFilter) : true,
    );
    /** @type {Map<string, ReturnType<typeof listGitWorktrees> | null>} */
    const worktreeCache = new Map();
    const worktreesFor = (repoRoot) => {
      const key = canonicalPath(repoRoot);
      if (worktreeCache.has(key)) return worktreeCache.get(key);
      let list = null;
      try {
        list = listGitWorktrees(repoRoot);
      } catch {
        list = null;
      }
      worktreeCache.set(key, list);
      return list;
    };
    const claimedPaths = new Set();
    /** @type {Record<string, any>[]} */
    const entries = [];
    for (const record of records) {
      if (record.cleanedAt) {
        entries.push({ todoId: record.todoId, status: 'cleaned', worktreePath: record.worktreePath, branch: record.branch });
        continue;
      }
      if (record.creationState === 'reserved') {
        claimedPaths.add(canonicalPath(record.worktreePath));
        entries.push({
          todoId: record.todoId,
          status: 'creating',
          worktreePath: record.worktreePath,
          branch: record.branch,
          message: 'Creation reservation without a finalized record; resume or inspect before retrying.',
        });
        continue;
      }
      const verification = verifyWorktreeRecord(record, { gitWorktrees: worktreesFor(repoRootOf(record)) || undefined });
      claimedPaths.add(canonicalPath(record.worktreePath));
      entries.push({
        todoId: record.todoId,
        status: verification.status,
        worktreePath: record.worktreePath,
        branch: record.branch,
        message: verification.message,
      });
    }
    /** @type {Record<string, any>[]} */
    const foreign = [];
    /** @type {Record<string, any>[]} */
    const orphanBranches = [];
    let config = null;
    try {
      config = options.config ? resolveWorktreeLayout(options.config, 'probe') : null;
    } catch {
      config = null;
    }
    const namespaceRoot = config ? path.join(config.root, config.namespace) : '';
    const branchPrefix = config ? config.branchPrefix : '';
    for (const repoRoot of new Set(records.map((record) => repoRootOf(record)))) {
      const list = worktreesFor(repoRoot);
      if (list && namespaceRoot) {
        for (const entry of list) {
          if (!isPathInside(namespaceRoot, entry.path)) continue;
          if (claimedPaths.has(canonicalPath(entry.path))) continue;
          foreign.push({ repoRoot, path: entry.path, branch: entry.branch, head: entry.head });
        }
      }
      if (branchPrefix) {
        try {
          for (const branch of listBranchesWithPrefix(repoRoot, branchPrefix)) {
            if (list && list.some((entry) => entry.branch === branch)) continue;
            orphanBranches.push({ repoRoot, branch });
          }
        } catch {
          // A repo that disappeared between passes is already reported per record.
        }
      }
    }
    /** @type {Record<string, number>} */
    const counts = {};
    for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
    return { entries, foreign, orphanBranches, counts };
  }, registryOptions);
}

/**
 * Explicit cleanup (contract §8.10, §11).
 *
 * Cleanup is allowed only when the worktree is integrated, or when a human
 * explicitly confirms discarding a rejected/unaccepted result by naming both
 * the worktree path and the branch. It always requires a liveness callback: an
 * unavailable liveness check is a refusal, not an assumption.
 *
 * @param {{
 *   todoId: string,
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number },
 *   hasActiveAgent: (record: object) => boolean,
 *   confirmation?: { discard: boolean, worktreePath: string, branch: string },
 *   forbidForce?: boolean
 * }} params
 * @returns {{ removed: boolean, alreadyCleaned?: boolean, alreadyMissing?: boolean, record: Record<string, any> }}
 */
export function removeWorktree(params) {
  const todoId = normalizeWorktreeTodoId(params?.todoId);
  const registryOptions = params.registryOptions || {};
  return withWorktreeRegistryLock(() => {
    /** @type {any} */
    let doc = readWorktreeRegistry(registryOptions);
    const record = doc.items[todoId];
    if (!record) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, `No worktree record for todo ${todoId}.`);
    }
    if (record.cleanedAt) {
      return { removed: false, alreadyCleaned: true, record };
    }
    if (record.executionState === 'preparing' || record.executionState === 'active') {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BUSY,
        `Worktree for ${todoId} is ${record.executionState}; stop or close the execution before cleanup.`,
      );
    }
    if (typeof params.hasActiveAgent !== 'function') {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BUSY_CHECK_UNAVAILABLE,
        'Cleanup requires a hasActiveAgent(record) callback; refusing to remove without a liveness check (S16).',
      );
    }
    if (params.hasActiveAgent(record) === true) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BUSY,
        `An active agent still holds the worktree for ${todoId}; cleanup refused (S16).`,
      );
    }
    const confirmation = params.confirmation;
    const discardConfirmed =
      confirmation?.discard === true &&
      confirmation.worktreePath === record.worktreePath &&
      confirmation.branch === record.branch;
    if (record.integrationState !== 'integrated' && !discardConfirmed) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.UNACCEPTED,
        `Worktree for ${todoId} is ${record.integrationState}; cleanup needs integration or an explicit discard confirmation naming ${record.worktreePath} and ${record.branch}.`,
      );
    }
    const now = new Date().toISOString();
    if (!fs.existsSync(record.worktreePath)) {
      if (record.snapshotRef) removeDirtyTreeSnapshotRef(repoRootOf(record), record.snapshotRef);
      record.cleanedAt = now;
      record.updatedAt = now;
      writeWorktreeRegistry(doc, registryOptions);
      return { removed: false, alreadyMissing: true, record };
    }
    let outcome = gitWorktreeRemove({ repoRoot: repoRootOf(record), worktreePath: record.worktreePath, force: false });
    if (!outcome.removed && discardConfirmed && params.forbidForce !== true) {
      // Force only after an explicit human discard confirmation naming path+branch.
      outcome = gitWorktreeRemove({ repoRoot: repoRootOf(record), worktreePath: record.worktreePath, force: true });
    }
    if (!outcome.removed) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.REMOVE_REFUSED,
        `git worktree remove refused for ${record.worktreePath}: ${outcome.message}. Nothing was forced; pass an explicit discard confirmation to discard unaccepted changes.`,
      );
    }
    if (record.snapshotRef) removeDirtyTreeSnapshotRef(repoRootOf(record), record.snapshotRef);
    record.cleanedAt = now;
    record.updatedAt = now;
    writeWorktreeRegistry(doc, registryOptions);
    return { removed: true, record };
  }, registryOptions);
}

/**
 * Release a worktree back to project mode (explicit operator/orchestrator
 * decision). The directory, branch and any uncommitted work are preserved on
 * disk; the record just stops being "live", so the tree starts a fresh
 * execution in the project folder. Refused while a live agent holds it.
 *
 * @param {{
 *   todoId: string,
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number },
 *   hasActiveAgent: (record: object) => boolean,
 * }} params
 * @returns {{ released: boolean, alreadyReleased?: boolean, record: Record<string, any> }}
 */
export function releaseWorktree(params) {
  const todoId = normalizeWorktreeTodoId(params?.todoId);
  const registryOptions = params.registryOptions || {};
  return withWorktreeRegistryLock(() => {
    /** @type {any} */
    const doc = readWorktreeRegistry(registryOptions);
    const record = doc.items[todoId];
    if (!record) {
      throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, `No worktree record for todo ${todoId}.`);
    }
    if (!isWorktreeRecordLive(record)) {
      return { released: false, alreadyReleased: true, record };
    }
    if (typeof params.hasActiveAgent !== 'function') {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BUSY_CHECK_UNAVAILABLE,
        'Release requires a hasActiveAgent(record) callback; refusing without a liveness check.',
      );
    }
    if (params.hasActiveAgent(record) === true) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.BUSY,
        `An active agent still holds the worktree for ${todoId}; release refused.`,
      );
    }
    const now = new Date().toISOString();
    record.releasedAt = now;
    record.executionState = 'execution_closed';
    record.updatedAt = now;
    writeWorktreeRegistry(doc, registryOptions);
    return { released: true, record };
  }, registryOptions);
}

/** Default number of commits a worktree may trail HEAD before it counts as stale. */
export const DEFAULT_WORKTREE_MAX_BEHIND = 50;

/**
 * Read the freshness facts of one live worktree record from Git. Never mutates.
 * `behind` counts commits on the repository HEAD that the frozen base lacks;
 * `unintegrated` is true for uncommitted changes or commits on the worktree
 * branch that HEAD does not contain (unless the record is already integrated).
 *
 * @param {Record<string, any>} record
 * @returns {Promise<{ behind: number, dirtyPaths: number, aheadCommits: number, unintegrated: boolean }>}
 */
export async function readWorktreeFreshnessFacts(record) {
  const repoRoot = repoRootOf(record);
  const count = async (range, cwd) => {
    const result = await runGitAsync(['rev-list', '--count', range], cwd, { allowFailure: true });
    const n = Number.parseInt(result.stdout.trim(), 10);
    return result.status === 0 && Number.isFinite(n) ? n : 0;
  };
  const behind = record.baseCommit ? await count(`${record.baseCommit}..HEAD`, repoRoot) : 0;
  const aheadCommits = record.branch ? await count(`HEAD..${record.branch}`, repoRoot) : 0;
  let dirtyPaths = 0;
  try {
    dirtyPaths = (await listDirtyWorktreePathsAsync(record.worktreePath)).length;
  } catch {
    // An unreadable worktree is treated as holding work by the caller's fail-safe below.
    dirtyPaths = 1;
  }
  const integrated = record.integrationState === 'integrated';
  return { behind, dirtyPaths, aheadCommits, unintegrated: !integrated && (dirtyPaths > 0 || aheadCommits > 0) };
}

/**
 * Save the unintegrated work of a worktree as a patch under
 * `<dataDir>/worktree-results/_carry/` so it survives a later cleanup.
 * Tracked changes and commits since the frozen base are included; untracked
 * files are marked intent-to-add first so they appear in the diff.
 *
 * @param {Record<string, any>} record
 * @param {{ dataDir?: string, registryPath?: string }} [registryOptions]
 * @returns {Promise<string | null>} patch path, or null when there was nothing to write
 */
export async function saveWorktreeCarryPatch(record, registryOptions = {}) {
  const todoId = normalizeWorktreeTodoId(record.todoId);
  const root = path.resolve(String(registryOptions.dataDir || path.dirname(path.resolve(String(registryOptions.registryPath || 'data/x')))), 'worktree-results', '_carry');
  await runGitAsync(['add', '-N', '.'], record.worktreePath, { allowFailure: true });
  const diff = await runGitAsync(['diff', record.baseCommit || 'HEAD'], record.worktreePath, { allowFailure: true });
  if (diff.status !== 0 || !diff.stdout.trim()) return null;
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${todoId}-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`);
  fs.writeFileSync(file, diff.stdout);
  return file;
}

/**
 * Preserve a stale tree branch before an operator-approved refresh. The ref is
 * immutable evidence: refreshing must never make unresolved checkpoints
 * unreachable.
 *
 * @param {Record<string, any>} record
 * @param {{ archiveRef?: string }} [options]
 * @returns {Promise<{ archiveRef: string, commit: string }>}
 */
export async function archiveWorktreeBranch(record, options = {}) {
  const branch = String(record?.branch || '').trim();
  const repoRoot = repoRootOf(record);
  if (!branch || !repoRoot) throw new WorktreeError(WORKTREE_ERROR_CODES.RECORD_MISSING, 'A tree branch is required for archival.');
  const head = (await runGitAsync(['rev-parse', branch], repoRoot, { allowFailure: true })).stdout.trim();
  if (!head) throw new WorktreeError(WORKTREE_ERROR_CODES.MISSING, `Tree branch ${branch} cannot be resolved.`);
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const safeId = normalizeWorktreeTodoId(record.todoId).replace(/[^a-zA-Z0-9_-]/g, '-');
  const archiveRef = String(options.archiveRef || `refs/cretli/archive/worktree/${safeId}/${suffix}`).trim();
  const written = await runGitAsync(['update-ref', archiveRef, head, ''], repoRoot, { allowFailure: true });
  if (written.status !== 0) throw new WorktreeError(WORKTREE_ERROR_CODES.CONFIG_INVALID, `Could not archive ${branch}: ${written.stderr || written.stdout}`);
  return { archiveRef, commit: head };
}

/**
 * Re-key the single live worktree record of a descendant onto the tree root.
 *
 * The Watcher used to key a worktree by the claimed leaf while a manual start
 * keys by the root; adopting the leaf record lets the whole tree share one
 * worktree. Only done when the root has no record yet, exactly one candidate is
 * live, it is fully prepared and no agent holds it. The directory and branch
 * are untouched; only the registry key, `todoId` and the ownership marker move.
 *
 * @param {{
 *   rootTodoId: string,
 *   candidateTodoIds: string[],
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number },
 *   hasActiveAgent: (record: object) => boolean,
 * }} params
 * @returns {{ adopted: boolean, fromTodoId?: string, record?: Record<string, any>, reason?: string }}
 */
export function adoptDescendantWorktree(params) {
  const rootTodoId = normalizeWorktreeTodoId(params?.rootTodoId);
  const registryOptions = params.registryOptions || {};
  const candidates = [...new Set((params.candidateTodoIds || []).map((id) => String(id ?? '').trim()))]
    .filter((id) => id && id !== rootTodoId);
  return withWorktreeRegistryLock(() => {
    /** @type {any} */
    const doc = readWorktreeRegistry(registryOptions);
    if (isWorktreeRecordLive(doc.items[rootTodoId])) return { adopted: false, reason: 'root_live' };
    const live = candidates.filter((id) => isWorktreeRecordLive(doc.items[id]));
    if (live.length !== 1) return { adopted: false, reason: live.length ? 'ambiguous' : 'none' };
    const fromTodoId = live[0];
    const record = doc.items[fromTodoId];
    if (record.creationState !== 'ready' || record.executionState !== 'active') {
      return { adopted: false, reason: 'not_active' };
    }
    if (typeof params.hasActiveAgent !== 'function' || params.hasActiveAgent(record) === true) {
      return { adopted: false, reason: 'busy' };
    }
    const verification = verifyWorktreeRecord(record);
    if (!verification.ok) return { adopted: false, reason: verification.status };
    const previousKey = record.todoId;
    record.todoId = rootTodoId;
    record.updatedAt = new Date().toISOString();
    // A stale root record that is not live (released/cleaned) is replaced.
    doc.items[rootTodoId] = record;
    delete doc.items[fromTodoId];
    writeWorktreeOwnerMarker(record.worktreePath, record);
    try {
      writeWorktreeRegistry(doc, registryOptions);
    } catch (error) {
      record.todoId = previousKey;
      writeWorktreeOwnerMarker(record.worktreePath, record);
      throw error;
    }
    return { adopted: true, fromTodoId, record };
  }, registryOptions);
}

/**
 * Retain integrated descendant worktrees as history before resuming a tree.
 * Only completed TODO ids may be supplied. Directories, branches and result
 * evidence stay intact; unfinished or busy records keep blocking the start.
 *
 * @param {{ completedTodoIds: string[], workspaceFolder: string, registryOptions?: Record<string, any>, hasActiveAgent: (record: Record<string, any>) => boolean }} params
 * @returns {string[]}
 */
export function releaseCompletedDescendantWorktrees(params) {
  const registryOptions = params.registryOptions || {};
  if (typeof params.hasActiveAgent !== 'function') return [];
  return withWorktreeRegistryLock(() => {
    const doc = readWorktreeRegistry(registryOptions);
    const released = [];
    for (const todoId of new Set(params.completedTodoIds)) {
      const record = doc.items[todoId];
      if (!isWorktreeRecordLive(record)
        || record.workspaceFolder !== params.workspaceFolder
        || record.creationState !== 'ready'
        || record.executionState !== 'execution_closed'
        || record.integrationState !== 'integrated'
        || params.hasActiveAgent(record) !== false) continue;
      const now = new Date().toISOString();
      record.releasedAt = now;
      record.updatedAt = now;
      released.push(todoId);
    }
    if (released.length) writeWorktreeRegistry(doc, registryOptions);
    return released;
  }, registryOptions);
}

export { isGitRepository };
