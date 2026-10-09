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
  writeWorktreeRegistry,
  withWorktreeRegistryLock,
} from './persist/worktree-registry-persist.js';
import {
  branchExists as gitBranchExists,
  gitWorktreeAdd,
  gitWorktreeRemove,
  isGitRepository,
  isWorkingTreeClean,
  listBranchesWithPrefix,
  listGitWorktrees,
  resolveCommit,
  resolveHeadCommit,
  resolveRepositoryRoot,
  resolveWorktreeGitDir,
} from './worktree/git-worktree.js';
import {
  createWorktreeRecord,
  assertExecutionState,
  assertIntegrationState,
} from './worktree/worktree-record.js';
import { isPathInside, normalizeWorktreeTodoId, resolveWorktreeLayout } from './worktree/worktree-layout.js';
import { assertWorktreeMode } from './worktree/worktree-mode.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from './worktree/worktree-errors.js';

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
 * @param {object} record
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
 * @param {object} record
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

/**
 * Verify a registry record against Git and the ownership marker. Never mutates.
 *
 * @param {object} record
 * @param {{ gitWorktrees?: ReturnType<typeof listGitWorktrees> }} [options]
 * @returns {{ ok: boolean, status: string, message: string }}
 */
export function verifyWorktreeRecord(record, options = {}) {
  const worktreePath = String(record?.worktreePath ?? '').trim();
  if (!worktreePath) return { ok: false, status: 'missing', message: 'The record has no worktree path.' };
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, status: 'missing', message: `Worktree directory is missing: ${worktreePath}.` };
  }
  const repoRoot = repoRootOf(record);
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
  if (entry.head !== record.baseCommit) {
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
 * @param {object} record
 * @param {object} params
 * @returns {object}
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
 * @param {object} record
 * @param {{ repoRoot: string, doc: object, write: (doc: object) => object }} params
 * @returns {object}
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
 * Create or reuse the persistent worktree for one todo.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   mode: string,
 *   config: object,
 *   baseCommit?: string,
 *   registryOptions?: { dataDir?: string, registryPath?: string, lockTimeoutMs?: number }
 * }} params
 * @returns {{ record: object, created: boolean, reused: boolean, recovered: boolean }}
 */
export function ensureWorktree(params) {
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
    const existing = doc.items[todoId];
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
      if (!samePath(existing.worktreePath, layout.worktreePath) || existing.branch !== layout.branch) {
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
    if (!isWorkingTreeClean(repoRoot)) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.DIRTY,
        `Logical tree of ${repoRoot} has uncommitted changes; worktree mode blocks the start (S6). Commit by hand first; O6 is not implemented.`,
      );
    }
    let baseCommit = String(params?.baseCommit ?? '').trim();
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
      creationState: 'reserved',
      executionState: 'none',
      integrationState: 'not_applicable',
      createdAt: now,
      updatedAt: now,
    });
    doc.items[todoId] = record;
    // Persist the reservation before touching Git so a crash is recoverable.
    write(doc);
    gitWorktreeAdd({
      repoRoot,
      worktreePath: layout.worktreePath,
      branch: layout.branch,
      baseCommit,
      branchExists: false,
    });
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
 * @returns {object}
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
 * @returns {{ entries: object[], foreign: object[], orphanBranches: object[], counts: Record<string, number> }}
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
    /** @type {object[]} */
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
    /** @type {object[]} */
    const foreign = [];
    /** @type {object[]} */
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
 *   confirmation?: { discard: boolean, worktreePath: string, branch: string }
 * }} params
 * @returns {{ removed: boolean, alreadyCleaned?: boolean, alreadyMissing?: boolean, record: object }}
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
      record.cleanedAt = now;
      record.updatedAt = now;
      writeWorktreeRegistry(doc, registryOptions);
      return { removed: false, alreadyMissing: true, record };
    }
    let outcome = gitWorktreeRemove({ repoRoot: repoRootOf(record), worktreePath: record.worktreePath, force: false });
    if (!outcome.removed && discardConfirmed) {
      // Force only after an explicit human discard confirmation naming path+branch.
      outcome = gitWorktreeRemove({ repoRoot: repoRootOf(record), worktreePath: record.worktreePath, force: true });
    }
    if (!outcome.removed) {
      throw new WorktreeError(
        WORKTREE_ERROR_CODES.REMOVE_REFUSED,
        `git worktree remove refused for ${record.worktreePath}: ${outcome.message}. Nothing was forced; pass an explicit discard confirmation to discard unaccepted changes.`,
      );
    }
    record.cleanedAt = now;
    record.updatedAt = now;
    writeWorktreeRegistry(doc, registryOptions);
    return { removed: true, record };
  }, registryOptions);
}

export { isGitRepository };
