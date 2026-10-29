import { integrateGitResult } from './integration/git-integrator.js';
import { runAutomaticIntegration, authorizeAutomaticIntegration } from './integration/auto-integrator.js';
/**
 * Worktree integration for a Workspace Watcher cycle (contract §8.3, §8.4,
 * §8.10, §9.1, S11–S14).
 *
 * On review PASS in worktree mode this module:
 *   1. builds the manual-integration diff (tracked + untracked) and writes the
 *      patch outside the worktree;
 *   2. stores a result record under the worktree registry, keyed by cycle id;
 *   3. marks the todo `integration.state = ready` while keeping `status = doing`.
 *
 * Review evidence semantics (`docs/todo-review-contract.md` §8.1-§8.3):
 *   - The result's `review` block is an artifact of ONE cycle. The caller passes
 *     a derived `reviewEvidence` (the cycle's independent PASS + satisfied
 *     verify, pinned to the reviewer/implementer attempt ids); this module never
 *     copies the live `todo.review` into the result.
 *   - `integration.reviewOutcome` written on the todo pointer by
 *     `markTodoIntegrationPointer` is historical artifact metadata copied from
 *     `result.review.outcome`; it is NOT the server-owned `todo.review` state and
 *     never overwrites it.
 *
 * Human flow (contract §8.4): `prepare` writes the result and moves the todo to
 * `integration.state = ready` while `status` stays `doing`; `confirm` sets
 * `status = done` and `integration.state = integrated`; `reject` returns the
 * todo to `ready` with the worktree preserved. `confirm`/`merge` are not a review
 * acceptance — they neither create a review `passed` nor a `manual` state.
 *
 * A human then confirms (todo `done`, siblings unblocked) or rejects (todo back
 * to `ready`, worktree preserved). Nothing here commits, merges or removes a
 * worktree; cleanup goes through `removeWorktree` and its discard guard.
 */

import { createHash } from 'node:crypto';
import { cleanupIntegratedTreeWorktree } from './worktree-tree-leaf.js';
import { logDelegationEvent } from './delegation-log.js';
import fs from 'node:fs';
import path from 'node:path';
import { writePatchScopeAsync, writePatchConflicts } from './worktree/patch-scope.ts';
import { getWorktreeRecord, mutateWorktreeRegistry, readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { addTodo, listTodos, updateTodo } from './persist/todos-store.js';
import { writeTextAtomic } from './persist/atomic-write.js';
import { applyWorktreeExecutionPatchAsync, collectWorktreeExecutionDiffAsync } from './worktree/git-worktree.ts';
import { createWorktreeResult, worktreeResultPatchPath } from './worktree/worktree-result.ts';
import { readDelegationMaterialRevision } from './delegation-material-revision.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow } from './persist/workspace-watchers-persist.js';
import { evaluateReviewGate, resolveReviewGateMode } from './workspace-watcher-review-gate.js';
import { isLiveWorktreeRecord } from './todo-worktree-manual.js';
import { getIntegrationLock, releaseSingleIntegrationLock } from './integration-lock.js';
import { resolveTodoChats } from './todo-source-chat.js';
import { NO_PUSH_DESTRUCTIVE_BLOCK } from './prompts/index.js';
import { deriveSimpleTodoIntegrationProof, fingerprintTodoMaterial, verifyTodoIntegrationProof } from './todo-integration-proof.js';
import { createPostIntegrator } from './integration/post-integrate.js';
import { blockNewStarts, unblockNewStarts, getActiveCycleCount } from './workspace-watcher-runtime.js';
import { spawn } from 'node:child_process';
import { publishNotification } from './notifications/notification-store.ts';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';
import {
  GIT_BRANCH_MERGE_MODE,
  buildGitBranchMergePrompt,
  preflightGitBranchMerge,
  verifyGitBranchMerge,
} from './worktree-merge.js';

export const INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS = NO_PUSH_DESTRUCTIVE_BLOCK;
export const INTEGRATION_GUARD_CHANGE_IN_HEAD = 'Do not confirm when the change is not in HEAD.';

export { isTodoAwaitingIntegration };

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} dataDir
 * @param {string} todoId
 * @returns {Record<string, any> | null}
 */
export function getWorktreeIntegrationRecord(todoId, dataDir) {
  return getWorktreeRecord(todoId, dataDir ? { dataDir } : {});
}

/**
 * Detect a leaf that works inside a worktree shared by its tree (`t-<root>`)
 * instead of owning one. Such a leaf never gets its own integration result: its
 * work waits in the tree worktree until the root is integrated, so the cycle
 * close must treat a review PASS as done rather than `cycle_incomplete`.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, todoId: string, items?: Record<string, any>[] }} input
 * @returns {Promise<{ rootId: string, record: Record<string, any> } | null>}
 */
export async function resolveTreeWorktreeLeaf(input) {
  const todoId = readString(input.todoId);
  if (!todoId) return null;
  const isActive = (record) => Boolean(
    record
    && isLiveWorktreeRecord(record)
    && record.creationState === 'ready'
    && record.executionState === 'active',
  );
  try {
    // A leaf with a live worktree of its own is integrated per leaf.
    if (isActive(getWorktreeIntegrationRecord(todoId, input.dataDir))) return null;
    const items = Array.isArray(input.items)
      ? input.items
      : (await listTodos(input.dataDir, input.workspaceFolder))?.items || [];
    const byId = new Map(items.map((row) => [readString(row?.id), row]));
    const visited = new Set([todoId]);
    let current = byId.get(readString(byId.get(todoId)?.parentId)) || null;
    while (current && !visited.has(readString(current.id))) {
      const id = readString(current.id);
      visited.add(id);
      const record = getWorktreeIntegrationRecord(id, input.dataDir);
      if (isActive(record)) return { rootId: id, record };
      current = byId.get(readString(current.parentId)) || null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Close a tree-worktree leaf after a verified cycle: the leaf becomes `done`
 * (its work stays in the tree worktree for root-level integration) and the
 * claim is released. Idempotent for an already-done leaf.
 *
 * @param {{ workspaceFolder: string, dataDir?: string, todoId: string, rootId: string, cycleId?: string, now?: string }} input
 * @returns {Promise<boolean>}
 */
export async function markTreeWorktreeLeafDone(input) {
  const todoId = readString(input.todoId);
  try {
    const current = ((await listTodos(input.dataDir, input.workspaceFolder))?.items || [])
      .find((row) => readString(row?.id) === todoId);
    if (!current) return false;
    if (readString(current.status) === 'done') return true;
    await updateTodo(input.dataDir, input.workspaceFolder, todoId, {
      status: 'done',
      strictStatus: true,
      claimedByChatId: null,
      claimedAt: null,
      expectedUpdatedAt: current.updatedAt,
      appendChangelog: {
        kind: 'note',
        text: `Waiting for tree integration: work stays in the shared tree worktree of ${readString(input.rootId).slice(0, 8)} until the root is integrated.`,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the immutable result payload for one cycle. Read-only for the worktree;
 * the only side effect is writing the patch artifact.
 *
 * @param {{
 *   todoId: string,
 *   cycleId: string,
 *   workspaceFolder?: string,
 *   dataDir: string,
 *   record: Record<string, any>,
 *   outcome?: string,
 *   reportedOutcome?: string,
 *   reviewOutcome?: string,
 *   reviewVerified?: boolean,
 *   reviewEvidence?: Record<string, any>,
 *   testOutcome?: string,
 *   testEvidence?: string,
 *   now?: string,
 *   deps?: Record<string, any>,
 * }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function prepareWorktreeIntegrationResult(input) {
  return buildWorktreeIntegrationResult(input, await collectWorktreeIntegrationDiff(input));
}

/**
 * Collect the worktree diff without blocking the event loop. Split from
 * {@link buildWorktreeIntegrationResult} so callers that must stay inside a
 * synchronous lock can collect first and build under the lock.
 *
 * @param {{ record: Record<string, any>, deps?: Record<string, any> }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function collectWorktreeIntegrationDiff(input) {
  const record = input.record;
  const collect = typeof input?.deps?.collectWorktreeExecutionDiff === 'function'
    ? input.deps.collectWorktreeExecutionDiff
    : collectWorktreeExecutionDiffAsync;
  return collect({ worktreePath: record.worktreePath, baseCommit: record.baseCommit });
}

/**
 * Persist the patch and build the integration result from a collected diff.
 *
 * @param {Record<string, any>} input same shape as {@link prepareWorktreeIntegrationResult}
 * @param {Record<string, any>} diff result of {@link collectWorktreeIntegrationDiff}
 * @returns {Record<string, any>}
 */
export function buildWorktreeIntegrationResult(input, diff) {
  const record = input.record;
  const patchPath = worktreeResultPatchPath(input.dataDir, input.todoId, input.cycleId);
  const patch = String(diff.patch ?? '');
  writeTextAtomic(patchPath, patch);
  const materialRevision = readString(record.materialRevision)
    || readDelegationMaterialRevision(record.worktreePath);
  // The review evidence is an artifact of THIS cycle (`docs/todo-review-contract.md`
  // §8.1-§8.2): the caller passes the derived `reviewEvidence`, and the result
  // records the concrete reviewer/implementer attempt ids. There is no default
  // PASS — a missing/unsatisfied review stays `unknown` and `verified:false`.
  const evidence = input.reviewEvidence && typeof input.reviewEvidence === 'object'
    ? input.reviewEvidence
    : null;
  const reviewOutcome = readString(input.reviewOutcome)
    || readString(evidence?.outcome)
    || readString(input.outcome)
    || 'unknown';
  return createWorktreeResult({
    cycleId: input.cycleId,
    todoId: input.todoId,
    baseCommit: record.baseCommit,
    headCommit: readString(record.headCommit) || record.baseCommit,
    branch: record.branch,
    worktreePath: record.worktreePath,
    materialRevision,
    patchPath,
    patchSha256: createHash('sha256').update(patch, 'utf8').digest('hex'),
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    changedFiles: diff.changedFiles,
    diffStat: diff.diffStat,
    review: {
      outcome: reviewOutcome,
      reportedOutcome: readString(input.reportedOutcome)
        || readString(evidence?.reportedOutcome)
        || readString(input.outcome),
      // When a derived evidence Record<string, any> is present it owns `verified`; the flat
      // boolean remains the manual-integration input.
      verified: evidence ? evidence.verified === true : input.reviewVerified === true,
      delegationId: readString(evidence?.delegationId),
      attemptId: readString(evidence?.attemptId),
      implementerAttemptId: readString(evidence?.implementerAttemptId),
      reviewerCount: Number.isInteger(evidence?.reviewerCount) ? evidence.reviewerCount : 0,
      independence: readString(evidence?.independence),
      stateReason: readString(evidence?.stateReason),
    },
    test: {
      outcome: readString(input.testOutcome) || 'unknown',
      evidence: readString(input.testEvidence),
    },
    outcome: readString(input.outcome) || 'unknown',
    recordedAt: input.now,
  });
}

/**
 * Store a result and mark the todo integration-ready in one locked registry
 * transaction. Idempotent by `(cycleId, resultHash)`: a repeated report writes
 * nothing and returns the stored record.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   cycleId: string,
 *   result: Record<string, any>,
 *   dataDir?: string,
 *   registryOptions?: Record<string, any>,
 *   now?: string,
 * }} input
 * @returns {Promise<{ ok: boolean, changed: boolean, record?: Record<string, any>, result?: Record<string, any>, reason?: string }>}
 */
export async function markTodoIntegrationReady(input) {
  const now = readString(input.now) || new Date().toISOString();
  const registryOptions = input.registryOptions || (input.dataDir ? { dataDir: input.dataDir } : {});
  // Defensive review gate (contract §2.1b): the cycle close already refuses,
  // this keeps a direct caller from producing a result without a code review.
  if (input.workspaceFolder) {
    try {
      const watcher = getWorkspaceWatcher(input.workspaceFolder, input.dataDir ? { dataDir: input.dataDir } : {});
      if (resolveReviewGateMode(watcher?.policy) === 'enforce') {
        const doc = await listTodos(input.dataDir, input.workspaceFolder);
        const todo = (Array.isArray(doc?.items) ? doc.items : [])
          .find((row) => String(row?.id || '') === String(input.todoId)) || null;
        if (todo && !evaluateReviewGate({ todo, policy: watcher.policy }).satisfied) {
          return { ok: false, changed: false, reason: 'review_missing' };
        }
      }
    } catch {
      // A read failure must not turn an off/warn workspace into a refusal.
    }
  }
  let outcome = null;
  mutateWorktreeRegistry((doc) => {
    const record = doc.items[input.todoId];
    if (!record) {
      outcome = { ok: false, reason: 'record_missing' };
      return { changed: false };
    }
    const existing = record.results?.[input.cycleId] || null;
    const changed = !existing || existing.resultHash !== input.result.resultHash;
    if (changed) {
      record.results = { ...(record.results || {}), [input.cycleId]: input.result };
    }
    record.executionState = 'execution_closed';
    record.integrationState = 'ready';
    record.integration = {
      readyAt: record.integration?.readyAt || now,
      integratedAt: record.integration?.integratedAt || null,
      rejectedAt: record.integration?.rejectedAt || null,
      reason: '',
    };
    record.updatedAt = now;
    outcome = {
      ok: true,
      changed,
      record,
      result: record.results[input.cycleId],
    };
    return { result: outcome, changed: true };
  }, registryOptions);
  if (!outcome?.ok) return outcome || { ok: false, reason: 'record_missing' };
  await markTodoIntegrationPointer({
    todoId: input.todoId,
    workspaceFolder: input.workspaceFolder,
    dataDir: input.dataDir,
    integration: {
      state: 'ready',
      cycleId: input.cycleId,
      resultPath: input.result.patchPath,
      baseCommit: input.result.baseCommit,
      branch: input.result.branch,
      worktreePath: input.result.worktreePath,
      materialRevision: input.result.materialRevision,
      // Historical artifact metadata: copied from the result's own review block,
      // never from the server-owned `todo.review` (`docs/todo-review-contract.md`
      // §8.3). `reviewOutcome: 'manual'` on a manual integration is not a human
      // review acceptance.
      reviewOutcome: input.result.review?.outcome || '',
      testOutcome: input.result.test?.outcome || '',
      changedFiles: (input.result.changedFiles || []).map((entry) => entry.path),
      recordedAt: input.result.recordedAt,
      updatedAt: now,
    },
  });
  return outcome;
}

/**
 * Write the operator-facing integration pointer on the todo. The status is
 * forced back to `doing` so an integration-ready leaf can never re-enter the
 * ready queue even if a later writer tried to flip it.
 *
 * @param {{ todoId: string, workspaceFolder: string, dataDir?: string, integration: Record<string, any> }} input
 * @returns {Promise<Record<string, any> | null>}
 */
export async function markTodoIntegrationPointer(input) {
  const doc = await updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
    status: 'doing',
    strictStatus: true,
    integration: input.integration,
  });
  return doc.items.find((row) => String(row.id) === input.todoId) || null;
}

/**
 * Resolve the integration target of a request that may name any node of a tree.
 * The worktree record and the operator-facing `integration` pointer both live on
 * the todo that owns the record, and the keying differs by start path: a
 * Watcher cycle keys the claimed LEAF, a manual Todo start keys the tree ROOT.
 * Walking from the requested node up to the root finds either one without
 * guessing, so a subtask row or a `done` container address the same target.
 *
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {string} todoId
 * @param {{ items?: Record<string, any>[], registry?: Record<string, Record<string, any>> } | null} [preloaded] Already loaded todos / registry (list payloads resolve many nodes).
 * @returns {Promise<{ targetId: string, target: Record<string, any>, items: Record<string, any>[] } | null>}
 */
export async function readIntegrationTarget(dataDir, workspaceFolder, todoId, preloaded = null) {
  const id = readString(todoId);
  if (!id) return null;
  let items;
  if (Array.isArray(preloaded?.items)) {
    items = preloaded.items;
  } else {
    try {
      items = (await listTodos(dataDir, workspaceFolder)).items;
    } catch {
      return null;
    }
  }
  return resolveIntegrationTargetFromItems(dataDir, id, items, preloaded?.registry);
}

/**
 * Pure part of {@link readIntegrationTarget}: the target of `todoId` inside an already loaded todo
 * list. Synchronous so list payloads and batch eligibility resolve many nodes without awaiting.
 *
 * @param {string | undefined} dataDir
 * @param {string} todoId
 * @param {Record<string, any>[]} items
 * @param {Record<string, Record<string, any>> | null} [preloadedRegistry]
 * @returns {{ targetId: string, target: Record<string, any>, items: Record<string, any>[] } | null}
 */
export function resolveIntegrationTargetFromItems(dataDir, todoId, items, preloadedRegistry = null) {
  const id = readString(todoId);
  if (!id) return null;
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map((row) => [String(row?.id || ''), row]));
  const requested = byId.get(id);
  if (!requested) return null;
  let registry = {};
  if (preloadedRegistry && typeof preloadedRegistry === 'object') {
    registry = preloadedRegistry;
  } else {
    try {
      registry = readWorktreeRegistry({ dataDir })?.items || {};
    } catch {
      registry = {};
    }
  }
  const seen = new Set();
  let current = requested;
  while (current && !seen.has(String(current.id))) {
    const currentId = String(current.id);
    seen.add(currentId);
    if (isLiveWorktreeRecord(registry[currentId])) return { targetId: currentId, target: current, items: list };
    const parentId = readString(current.parentId);
    current = parentId ? byId.get(parentId) : null;
  }
  // No live record anywhere up the chain: answer for the requested node so the
  // caller reports the honest `no_worktree` refusal.
  return { targetId: id, target: requested, items: list };
}

/**
 * Conflicted paths reported by a failed guilty apply. Empty means "unknown".
 *
 * @param {unknown} error
 * @returns {string[]}
 */
function readErrorConflicts(error) {
  const list = error && typeof error === 'object' && 'details' in error ? error.details?.conflicts : null;
  return Array.isArray(list) ? list.map(readString).filter(Boolean) : [];
}

/**
 * Prepare (build the diff and mark) a manually started ROOT worktree for human
 * integration. Unlike the Watcher path there is no review/report step, so the
 * recorded evidence is honest: `outcome:'manual'`, `review.verified:false`,
 * `test.outcome:'unknown'`. The synthetic cycle id is stable per root chat, so
 * a repeated prepare is idempotent; the diff accumulates every leaf sibling of
 * the tree.
 *
 * Any node of the tree may be named: the action resolves the ROOT itself, so a
 * subtask row or a `done` root (a tree closed without integration) works too.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   now?: string,
 *   deps?: Record<string, any>,
 * }} input
 * @returns {Promise<{ ok: boolean, changed?: boolean, reason?: string, targetId?: string, result?: Record<string, any>, item?: Record<string, any> | null }>}
 */
export async function prepareManualTodoIntegration(input = {}) {
  const dataDir = input.dataDir;
  const workspaceFolder = readString(input.workspaceFolder);
  const resolved = await readIntegrationTarget(dataDir, workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const { targetId, target: targetTodo } = resolved;
  const record = getWorktreeIntegrationRecord(targetId, dataDir);
  if (!isLiveWorktreeRecord(record)) return { ok: false, reason: 'no_worktree' };
  if (record.executionState === 'preparing') return { ok: false, reason: 'busy' };
  const chatId = readString(targetTodo.chatId) || readString(targetTodo.orchestratorChatId);
  const cycleId = `manual-${chatId || targetId}`;
  const result = await prepareWorktreeIntegrationResult({
    todoId: targetId,
    cycleId,
    workspaceFolder,
    dataDir,
    record,
    outcome: 'manual',
    reportedOutcome: '',
    reviewOutcome: 'manual',
    reviewVerified: false,
    testOutcome: 'unknown',
    testEvidence: '',
    now: input.now,
    deps: input.deps,
  });
  const marked = await markTodoIntegrationReady({
    todoId: targetId,
    workspaceFolder,
    cycleId,
    result,
    dataDir,
    now: input.now,
  });
  if (!marked.ok) return { ok: false, reason: marked.reason || 'record_missing' };
  return {
    ok: true,
    changed: marked.changed === true,
    targetId,
    result,
    item: await readTodo(dataDir, workspaceFolder, targetId),
  };
}

/** Targets with an apply in flight; the async apply yields, so a second request must not start. */
const applyInFlight = new Set();

/** Apply the prepared patch to the logical workspace after a human request. */
export async function applyWorkspaceTodoIntegration(input = {}) {
  const key = `${readString(input.workspaceFolder)}\0${readString(input.todoId)}`;
  if (applyInFlight.has(key)) return { ok: false, reason: 'busy' };
  applyInFlight.add(key);
  try {
    return await applyWorkspaceTodoIntegrationUnlocked(input);
  } finally {
    applyInFlight.delete(key);
  }
}

async function applyWorkspaceTodoIntegrationUnlocked(input = {}) {
  const workspaceFolder = readString(input.workspaceFolder);
  const dataDir = input.dataDir;
  const resolved = await readIntegrationTarget(dataDir, workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const targetId = resolved.targetId;
  const todo = resolved.target;
  if (!isTodoAwaitingIntegration(todo)) return { ok: false, reason: 'not_ready' };
  if (readString(todo.integration?.appliedAt)) return { ok: false, reason: 'already_applied' };
  if (readString(todo.integration?.reason) === SMART_MERGE_RUNNING) return { ok: false, reason: 'busy' };
  const cycleId = readString(todo.integration?.cycleId);
  const record = getWorktreeIntegrationRecord(targetId, dataDir);
  const result = record?.results?.[cycleId] || null;
  if (!isLiveWorktreeRecord(record) || !result) return { ok: false, reason: 'no_worktree' };
  const expectedPatchPath = worktreeResultPatchPath(dataDir, targetId, cycleId);
  if (path.resolve(result.patchPath) !== path.resolve(expectedPatchPath) || !fs.existsSync(expectedPatchPath)) {
    await recordTodoIntegrationIssue({ dataDir, workspaceFolder, todoId: targetId, todo, reason: 'patch_invalid' });
    return { ok: false, reason: 'patch_missing' };
  }
  const patch = fs.readFileSync(expectedPatchPath);
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  if (patchSha256 !== result.patchSha256 || result.baseCommit !== record.baseCommit) {
    await recordTodoIntegrationIssue({ dataDir, workspaceFolder, todoId: targetId, todo, reason: 'patch_invalid' });
    return { ok: false, reason: 'patch_invalid' };
  }
  const apply = typeof input?.deps?.applyWorktreeExecutionPatch === 'function'
    ? input.deps.applyWorktreeExecutionPatch
    : applyWorktreeExecutionPatchAsync;
  try {
    const applied = await apply({ workspaceFolder, baseCommit: record.baseCommit, patchPath: expectedPatchPath });
    const updatedAt = new Date().toISOString();
    const updated = await updateTodo(dataDir, workspaceFolder, targetId, {
      status: 'doing',
      strictStatus: true,
      integration: { ...todo.integration, appliedAt: updatedAt, reason: '', updatedAt },
    });
    return {
      ok: true,
      applied: applied.applied === true,
      targetId,
      item: updated.items.find((row) => row.id === targetId) || null,
    };
  } catch (error) {
    const reason = error?.code === 'WORKTREE_INTEGRATION_CONFLICT' ? 'integration_conflict' : 'apply_failed';
    await recordTodoIntegrationIssue({
      dataDir,
      workspaceFolder,
      todoId: targetId,
      todo,
      reason: reason === 'integration_conflict'
        ? `${reason}: ${readErrorConflicts(error).join(', ')}`
        : reason,
    });
    return {
      ok: false,
      reason,
      conflicts: readErrorConflicts(error),
    };
  }
}

async function recordTodoIntegrationIssue(input) {
  try {
    await updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
      status: input.todo.status,
      strictStatus: true,
      integration: { ...input.todo.integration, reason: readString(input.reason), updatedAt: new Date().toISOString() },
      expectedUpdatedAt: input.todo.updatedAt,
    });
  } catch {
    // Keep the original apply error even if the task changed concurrently.
  }
}

/**
 * Explicit human "integrate with workspace": prepare the worktree diff when it
 * is not ready yet, then apply it to the logical working tree through the
 * guarded three-way merge. Deterministic and idempotent; it commits nothing and
 * a conflict leaves every file in the workspace untouched.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   now?: string,
 *   deps?: Record<string, any>,
 * }} input
 * @returns {Promise<{ ok: boolean, reason?: string, applied?: boolean, alreadyApplied?: boolean, prepared?: boolean, targetId?: string, conflicts?: string[], item?: Record<string, any> | null }>}
 */
export async function mergeWorkspaceTodoIntegration(input = {}) {
  const dataDir = input.dataDir;
  const workspaceFolder = readString(input.workspaceFolder);
  const resolved = await readIntegrationTarget(dataDir, workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const targetId = resolved.targetId;
  let prepared = false;
  if (!isTodoAwaitingIntegration(resolved.target)) {
    const preparedResult = await prepareManualTodoIntegration({
      todoId: targetId,
      workspaceFolder,
      dataDir,
      now: input.now,
      deps: input.deps,
    });
    if (!preparedResult.ok) return { ...preparedResult, targetId };
    prepared = preparedResult.changed === true;
  }
  const applied = await applyWorkspaceTodoIntegration({
    todoId: targetId,
    workspaceFolder,
    dataDir,
    deps: input.deps,
  });
  if (!applied.ok && applied.reason === 'already_applied') {
    return { ok: true, applied: false, alreadyApplied: true, prepared, targetId, item: resolved.target };
  }
  return { ...applied, prepared, targetId };
}

/** `integration.reason` marker while a smart-merge agent is working. */
export const SMART_MERGE_RUNNING = 'smart_merge_running';

/**
 * @param {{ baseUrl?: string, insecureTls?: boolean, todoId: string, workspaceFolder: string, context?: { batchId: string, entryId: string, attempt: number, epoch: number, token: string } }} input
 * `context` is only set for a bulk-integrate entry: the report then also carries
 * the batch fencing fields. The single-todo prompt stays unchanged.
 * @returns {string}
 */
export function buildSmartMergeCallback(input) {
  const url = `${readString(input.baseUrl).replace(/\/$/, '')}/api/smart-merge-report-from-agent`;
  const context = input.context && typeof input.context === 'object' ? input.context : null;
  const payload = JSON.stringify({
    todoId: input.todoId,
    workspaceFolder: input.workspaceFolder,
    outcome: 'merged',
    summary: '<one line>',
    ...(context ? {
      batchId: context.batchId,
      entryId: context.entryId,
      attempt: context.attempt,
      epoch: context.epoch,
      token: context.token,
    } : {}),
  });
  const mcpArgs = JSON.stringify({
    todo_id: input.todoId,
    outcome: 'merged',
    summary: '<one line>',
    ...(context ? { batch: { batchId: context.batchId, entryId: context.entryId, attempt: context.attempt, epoch: context.epoch, token: context.token } } : {}),
  });
  return `Preferred: call the Cretli MCP tool smart_merge_report with ${mcpArgs} ("failed" instead of "merged" when the merge failed). Fallback when MCP is unavailable: curl -sS -X POST ${url}${input.insecureTls ? ' -k' : ''} -H "Content-Type: application/json" -d '${payload}'`;
}

/**
 * Record the outcome a smart-merge agent reported. `merged` marks the result as
 * applied (the human still confirms); `failed` clears the running marker so the
 * merge can be retried either way.
 *
 * @param {{ todoId: string, workspaceFolder: string, dataDir?: string, outcome: string, summary?: string }} input
 * @returns {Promise<{ ok: boolean, reason?: string, item?: Record<string, any> | null }>}
 */
export async function reportSmartMergeOutcome(input = {}) {
  const dataDir = input.dataDir;
  const workspaceFolder = readString(input.workspaceFolder);
  const resolved = await readIntegrationTarget(dataDir, workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  if (!isTodoAwaitingIntegration(resolved.target)) return { ok: false, reason: 'not_ready' };
  const outcome = readString(input.outcome).toLowerCase();
  if (outcome !== 'merged' && outcome !== 'failed') return { ok: false, reason: 'invalid_outcome' };
  const now = new Date().toISOString();
  const summary = readString(input.summary).slice(0, 200);
  const integration = { ...resolved.target.integration, updatedAt: now };
  if (outcome === 'merged' && integration.mergeMode === GIT_BRANCH_MERGE_MODE) {
    return confirmGitBranchMerge({ ...input, dataDir, workspaceFolder, resolved, integration, now });
  }
  if (outcome === 'merged') {
    integration.appliedAt = now;
    integration.reason = '';
  } else {
    integration.reason = summary ? `smart_merge_failed: ${summary}` : 'smart_merge_failed';
  }
  const doc = await updateTodo(dataDir, workspaceFolder, resolved.targetId, { status: 'doing', strictStatus: true, integration });
  // A failed report ends the flow, so the `single` lock can go back at once. A
  // `merged` report is not the end: the lock survives until the confirm, which
  // releases it, so no other flow (e.g. a batch) can start in the window between
  // the report and the attestation. The lazy idle release still frees a lock
  // whose chat dies before confirming.
  if (outcome !== 'merged') {
    releaseSingleIntegrationLock({ dataDir, workspaceFolder, todoIds: [resolved.targetId, input.todoId] });
  }
  return { ok: true, item: doc.items.find((row) => String(row.id) === resolved.targetId) || null };
}

/**
 * A git-level merge agent reported `merged`: never trust the report alone.
 * Git must prove the branch tip is reachable from the target branch; only then
 * the integration proof is recorded and the todo is confirmed. A refused proof
 * keeps the todo awaiting integration with the reason on the pointer.
 *
 * @param {{ dataDir?: string, workspaceFolder: string, resolved: { targetId: string, target: Record<string, any>, items: Record<string, any>[] }, integration: Record<string, any>, now: string }} input
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: string, confirmed?: boolean, item?: Record<string, any> | null }>}
 */
async function confirmGitBranchMerge(input) {
  const { dataDir, workspaceFolder, resolved, now } = input;
  const targetId = resolved.targetId;
  const integration = { ...input.integration };
  const record = getWorktreeIntegrationRecord(targetId, dataDir);
  const verified = verifyGitBranchMerge({
    workspaceFolder,
    record: record || {},
    targetBranch: readString(integration.targetBranch),
  });
  if (!verified.ok) {
    integration.reason = `git_merge_unverified: ${verified.reason}`;
    await updateTodo(dataDir, workspaceFolder, targetId, { status: 'doing', strictStatus: true, integration });
    return { ok: false, reason: 'merge_unverified', detail: verified.reason };
  }
  integration.appliedAt = now;
  integration.reason = '';
  const doc = await updateTodo(dataDir, workspaceFolder, targetId, { status: 'doing', strictStatus: true, integration });
  const current = doc.items.find((row) => String(row.id) === targetId);
  const hasChildren = resolved.items.some((row) => String(row.parentId || '') === targetId);
  const confirmed = await confirmWorkspaceTodoIntegration({
    todoId: targetId,
    workspaceFolder,
    dataDir,
    expectedUpdatedAt: readString(current?.updatedAt),
    proof: {
      targetBranch: verified.targetBranch,
      targetCommit: verified.targetCommit,
      sourceCommit: verified.sourceCommit,
      materialRevision: readString(integration.materialRevision) || verified.sourceCommit,
      changeRef: `git merge ${readString(record?.branch)} into ${verified.targetBranch}@${verified.targetCommit.slice(0, 12)}`,
      changeAttested: true,
      scope: hasChildren ? 'tree' : 'task',
    },
  });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason || 'confirm_failed' };
  return { ok: true, confirmed: true, item: confirmed.item };
}

/**
 * Prepare the worktree diff (when needed) and describe it for an agent that
 * merges the result into the logical workspace by hand ("smart merge"). The
 * server applies nothing. The agent commits only the listed task paths and
 * records the integration proof, because starting this action is the user's
 * attestation. It never pushes.
 *
 * `mode: 'git-branch'` switches to the git-level merge: the preflight must pass
 * and the agent merges the worktree branch into the checked-out target branch.
 *
 * @param {{ todoId: string, workspaceFolder: string, dataDir?: string, conflicts?: string[], mode?: string, instructions?: string, baseUrl?: string, insecureTls?: boolean, callbackContext?: Record<string, any>, deps?: Record<string, any> }} input
 * @returns {Promise<{ ok: boolean, reason?: string, targetId?: string, prompt?: string, title?: string, blockers?: Record<string, any>[] }>}
 */
export async function buildSmartMergeRequest(input = {}) {
  const dataDir = input.dataDir;
  const workspaceFolder = readString(input.workspaceFolder);
  const resolved = await readIntegrationTarget(dataDir, workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const targetId = resolved.targetId;
  const gitBranchMode = input.mode === GIT_BRANCH_MERGE_MODE;
  /** @type {ReturnType<typeof preflightGitBranchMerge> | null} */
  let preflight = null;
  if (gitBranchMode) {
    // Refuse before anything is prepared or marked: a blocked merge must leave
    // the todo exactly as it was.
    const liveRecord = getWorktreeIntegrationRecord(targetId, dataDir);
    if (!isLiveWorktreeRecord(liveRecord)) return { ok: false, reason: 'no_worktree', targetId };
    preflight = preflightGitBranchMerge({ workspaceFolder, record: liveRecord, dataDir });
    if (!preflight.ok) {
      return { ok: false, reason: preflight.blockers[0].code, targetId, blockers: preflight.blockers };
    }
  }
  if (!isTodoAwaitingIntegration(resolved.target)) {
    const prepared = await prepareManualTodoIntegration({ todoId: targetId, workspaceFolder, dataDir, deps: input.deps });
    if (!prepared.ok) return { ...prepared, targetId };
  }
  const todo = await readTodo(dataDir, workspaceFolder, targetId) || resolved.target;
  const record = getWorktreeIntegrationRecord(targetId, dataDir);
  const cycleId = readString(todo.integration?.cycleId);
  const result = record?.results?.[cycleId] || null;
  if (!isLiveWorktreeRecord(record) || !result) return { ok: false, reason: 'no_worktree' };
  const conflicts = (Array.isArray(input.conflicts) ? input.conflicts : []).map((value) => String(value ?? '')).filter(Boolean);
  const scopePath = gitBranchMode ? null : await writePatchScopeAsync(result, conflicts);
  const conflictsPath = scopePath || (!gitBranchMode && conflicts.length > 50 ? writePatchConflicts(result, conflicts) : null);
  const scope = scopePath
    ? `Authorization scope file: ${scopePath} (JSON files[].path and files[].oldPath; patchSha256 identifies the prepared patch).`
    : 'Patch missing, unreadable or hash mismatch: derive the scope in the worktree with git diff --name-status -z -M <base> plus git ls-files --others --exclude-standard (best effort). If the worktree is gone, stop and report failure.';
  const conflictLines = conflicts.length
    ? ['', `A plain three-way apply conflicted on: ${JSON.stringify(conflicts.slice(0, 50))}`]
    : [];
  if (conflicts.length > 50) {
    conflictLines.push(conflictsPath
      ? `All conflicts are in ${conflictsPath} under conflicts${scopePath ? '' : '; scopeUnavailable=true: this file does not authorize paths; use the fallback above'}.`
      : 'Remaining conflicts must be inspected in the worktree (scope artifact unavailable).');
  }
  const prompt = gitBranchMode ? buildGitBranchMergePrompt({
    workspaceFolder,
    record,
    preflight,
    changedFiles: (result.changedFiles || []).map((entry) => entry.path),
    instructions: input.instructions,
    callback: buildSmartMergeCallback({ baseUrl: input.baseUrl, insecureTls: input.insecureTls, todoId: targetId, workspaceFolder, context: input.callbackContext }),
  }) : [
    'Smart merge: integrate the result of a git worktree into the main workspace.',
    'Run the skill @cretli-integrate in mode smart-merge (read its listed SKILL.md if the text is not included).',
    '',
    `Workspace (merge target, your working directory): ${workspaceFolder}`,
    `Worktree path: ${result.worktreePath || record.worktreePath || ''}`,
    `Worktree branch: ${result.branch || record.branch || ''}`,
    `Base commit the worktree started from: ${result.baseCommit || record.baseCommit || ''}`,
    `Prepared patch (worktree changes vs. base): ${result.patchPath || ''}`,
    '',
    scope,
    ...conflictLines,
    '',
    `Commit only paths from the scope that you changed; do not stage any other path. ${INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS} ${INTEGRATION_GUARD_CHANGE_IN_HEAD}`,
    'Finish in this order (report while the task is still awaiting integration; confirm only on "merged", with the change in HEAD, via todo_integration action confirm, proof.simple true):',
    '1. Commit the listed task paths, unless already in HEAD.',
    '2. Report the outcome ("merged" or "failed", one short line) with this callback:',
    buildSmartMergeCallback({ baseUrl: input.baseUrl, insecureTls: input.insecureTls, todoId: targetId, workspaceFolder, context: input.callbackContext }),
    '3. On "merged" only: todo_show for expected_updated_at, then todo_integration action confirm. Do not push.',
  ].join('\n');
  // The agent merges by hand: mark the run so the deterministic "apply" is not
  // offered meanwhile. The agent reports back through the callback below.
  const startedAt = new Date().toISOString();
  await updateTodo(dataDir, workspaceFolder, targetId, {
    status: 'doing',
    strictStatus: true,
    integration: {
      ...todo.integration,
      reason: SMART_MERGE_RUNNING,
      updatedAt: startedAt,
      ...(gitBranchMode
        ? { mergeMode: GIT_BRANCH_MERGE_MODE, targetBranch: preflight.targetBranch }
        : { mergeMode: '', targetBranch: '' }),
    },
  });
  return { ok: true, targetId, prompt, title: `[Merge] ${readString(todo.title) || 'worktree'}`.slice(0, 120) };
}

/**
 * Describe an agent run that verifies a finished todo without a live worktree
 * ("verify integration"): the agent checks the task change is in the checked-out
 * branch, then records the proof (or the no-code decision) so the todo ends up
 * integrated. The server changes nothing here. The agent never pushes.
 *
 * @param {{ todoId: string, workspaceFolder: string, dataDir?: string }} input
 * @returns {Promise<{ ok: boolean, reason?: string, targetId?: string, prompt?: string, title?: string }>}
 */
export async function buildVerifyIntegrationRequest(input = {}) {
  const dataDir = input.dataDir;
  const workspaceFolder = readString(input.workspaceFolder);
  const todo = await readTodo(dataDir, workspaceFolder, readString(input.todoId));
  if (!todo) return { ok: false, reason: 'not_found' };
  if (readString(todo.status) !== 'done') return { ok: false, reason: 'not_done' };
  const targetId = readString(todo.id);
  const record = getWorktreeIntegrationRecord(targetId, dataDir);
  if (isLiveWorktreeRecord(record)) return { ok: false, reason: 'worktree_live', targetId };
  const hints = buildVerifyIntegrationHints(todo, record);
  const prompt = [
    'Verify and close integration of a finished todo in the main workspace.',
    'Run the skill @cretli-integrate in mode verify (read its listed SKILL.md if the text is not included).',
    '',
    `Workspace (your working directory): ${workspaceFolder}`,
    `Todo: ${targetId} — ${readString(todo.title)}`,
    '',
    `${INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS} Unrelated uncommitted files are not yours: leave them untouched. ${INTEGRATION_GUARD_CHANGE_IN_HEAD}`,
    ...(hints ? ['', hints] : []),
  ].join('\n');
  return { ok: true, targetId, prompt, title: `[Integrate] ${readString(todo.title) || 'todo'}`.slice(0, 120) };
}

const VERIFY_HINTS_HEADER = 'Hints from the server, unverified; check HEAD and behaviour yourself.';
const VERIFY_HINTS_MAX_BYTES = 600;
const VERIFY_CHAT_ROLE_PRIORITY = ['executor', 'orchestrator', 'planner', 'creator', 'linked'];

// Hint block assembly: the header is always kept; candidate lines are appended in
// order (chats by role priority, then checkpoint, then patch path) and a line that
// would push the block over VERIFY_HINTS_MAX_BYTES is skipped whole, so an id or a
// path is never cut. Size is counted in UTF-8 bytes. The guard sentences shared with
// the smart-merge prompt stay as literal constants on purpose: a shared core would
// couple two prompts that are tested separately.

function buildVerifyIntegrationHints(todo, record) {
  const lines = [VERIFY_HINTS_HEADER];
  const linkedOrder = Array.isArray(todo.linkedChatIds) ? todo.linkedChatIds.map((id) => readString(id)) : [];
  const chats = resolveTodoChats(todo, [])
    .map((chat) => ({ ...chat, roles: chat.roles.slice().sort((a, b) => VERIFY_CHAT_ROLE_PRIORITY.indexOf(a) - VERIFY_CHAT_ROLE_PRIORITY.indexOf(b)) }))
    .sort((a, b) => {
      const roleA = Math.min(...a.roles.map((role) => VERIFY_CHAT_ROLE_PRIORITY.indexOf(role)).filter((index) => index >= 0));
      const roleB = Math.min(...b.roles.map((role) => VERIFY_CHAT_ROLE_PRIORITY.indexOf(role)).filter((index) => index >= 0));
      // Ties: the newest linkedChatIds entry first; the sort is stable, so equal ranks keep the recency order.
      return roleA - roleB || linkedOrder.lastIndexOf(b.id) - linkedOrder.lastIndexOf(a.id);
    }).slice(0, 5);
  const candidates = chats.map((chat) => `- Chat ${chat.id}: ${chat.roles.join(', ')} (may no longer exist)`);
  const checkpoint = readString(todo.leafMaterial?.lastCheckpoint?.commit);
  if (checkpoint) candidates.push(`- Checkpoint commit ${checkpoint} is on the worktree branch, NOT proof of presence in HEAD; use only to diff against the working tree.`);
  const patchPath = readString(todo.integration?.resultPath) || readString(record?.results?.[readString(todo.integration?.cycleId)]?.patchPath);
  if (patchPath) candidates.push(`- Result patch (may be gone; verify runs without a live worktree): ${patchPath}`);
  let block = VERIFY_HINTS_HEADER;
  for (const candidate of candidates) {
    const next = `${block}\n${candidate}`;
    if (Buffer.byteLength(next, 'utf8') > VERIFY_HINTS_MAX_BYTES) continue;
    block = next;
  }
  return block === VERIFY_HINTS_HEADER && candidates.length === 0 ? '' : block;
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {string} todoId
 * @returns {Promise<Record<string, any> | null>}
 */
async function readTodo(dataDir, workspaceFolder, todoId) {
  try {
    const doc = await listTodos(dataDir, workspaceFolder);
    return doc.items.find((row) => String(row.id) === todoId) || null;
  } catch {
    return null;
  }
}

/**
 * Touch the registry integration state after a human decision. Best-effort: a
 * missing registry record (for example a hand-made todo) must not fail the
 * todo transition.
 *
 * @param {{ todoId: string, dataDir?: string, registryOptions?: Record<string, any>, integrationState: string, reason?: string, now: string }} input
 * @returns {Record<string, any> | null}
 */
function updateRegistryIntegrationState(input) {
  const registryOptions = input.registryOptions || (input.dataDir ? { dataDir: input.dataDir } : {});
  let record = null;
  try {
    mutateWorktreeRegistry((doc) => {
      const row = doc.items[input.todoId];
      if (!row) return { changed: false };
      row.integrationState = input.integrationState;
      row.integration = {
        readyAt: row.integration?.readyAt || null,
        integratedAt: input.integrationState === 'integrated' ? input.now : (row.integration?.integratedAt || null),
        rejectedAt: input.integrationState === 'rejected' ? input.now : (row.integration?.rejectedAt || null),
        reason: readString(input.reason) || (input.integrationState === 'integrated' ? '' : (row.integration?.reason || '')),
      };
      row.updatedAt = input.now;
      record = row;
      return { result: row, changed: true };
    }, registryOptions);
  } catch {
    return null;
  }
  return record;
}

/**
 * Human confirmation: the result is integrated, so the todo becomes `done` and
 * the next sequential sibling may start. CAS on the live todo revision.
 *
 * Like reject / invalidate, a competing writer is refused by the workspace
 * integration lock. The only exemption is `humanAttested: true`, which the REST
 * route sets for the operator's own confirm in the UI; the MCP path never sets
 * it, so a non-owning agent is refused while a batch or another single flow owns
 * the lock.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   expectedUpdatedAt?: string,
 *   callerChatId?: string,
 *   humanAttested?: boolean,
 *   now?: number,
 * }} input
 * @returns {Promise<{ ok: boolean, reason?: string, item?: Record<string, any> | null, currentUpdatedAt?: string, targetTodoId?: string }>}
 */
export async function confirmWorkspaceTodoIntegration(input) {
  const refused = await refuseWhenIntegrationLockedForWriter(input);
  if (refused) return refused;
  const now = readString(input.now ? new Date(input.now).toISOString() : '') || new Date().toISOString();
  const dataDir = input.dataDir;
  const resolved = await readIntegrationTarget(dataDir, input.workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const todoId = resolved.targetId;
  const current = resolved.target;
  let proofInput = input.proof || {};
  if (proofInput.simple === true) {
    // One-click confirmation: the server resolves branch and HEAD itself, so the
    // operator never has to type a SHA. The click is the attestation.
    const hasChildren = resolved.items.some((row) => String(row.parentId || '') === todoId);
    const derived = deriveSimpleTodoIntegrationProof({
      workspaceFolder: input.workspaceFolder,
      todoId,
      materialRevision: readString(current.integration?.materialRevision),
      scope: proofInput.scope || (hasChildren ? 'tree' : 'task'),
    });
    if (!derived.ok) return { ok: false, reason: derived.reason };
    proofInput = derived.proof;
  }
  const storedMaterialRevision = readString(current.integration?.materialRevision);
  const suppliedMaterialRevision = readString(proofInput.materialRevision);
  if (storedMaterialRevision && suppliedMaterialRevision !== storedMaterialRevision) {
    return { ok: false, reason: 'material_revision_mismatch' };
  }
  const proofResult = verifyTodoIntegrationProof({
    workspaceFolder: input.workspaceFolder,
    ...proofInput,
    todoId,
    todoItems: resolved.items,
    cycleId: input.proof?.cycleId || current.integration?.cycleId || current.execution?.cycleId,
    source: input.proof?.source || (current.executionMode === 'worktree' ? 'human_worktree' : 'human_project'),
    now,
  });
  if (!proofResult.ok) return { ok: false, reason: proofResult.reason };
  const expectedUpdatedAt = readString(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return { ok: false, reason: 'expected_revision_required' };
  const nextStatus = isTodoAwaitingIntegration(current) ? 'done' : current.status;
  try {
    const doc = await updateTodo(dataDir, input.workspaceFolder, todoId, {
      status: nextStatus,
      strictStatus: true,
      integration: {
        ...current.integration,
        state: 'integrated',
        evidence: { ...proofResult.evidence, todoMaterialFingerprint: fingerprintTodoMaterial(current) },
        reason: '',
        updatedAt: now,
      },
      expectedUpdatedAt,
      ...(nextStatus === 'done' ? { claimedByChatId: null, claimedAt: null } : {}),
    });
    const item = doc.items.find((row) => String(row.id) === todoId) || null;
    updateRegistryIntegrationState({
      todoId,
      dataDir,
      integrationState: 'integrated',
      now,
    });
    releaseSingleIntegrationLock({ dataDir, workspaceFolder: input.workspaceFolder, todoIds: [todoId, input.todoId] });
    // Per-leaf-worktree trees drop their tree worktree once integrated; the
    // delete runs in the background and never blocks the confirmation.
    void cleanupIntegratedTreeWorktree({ todoId, registryOptions: dataDir ? { dataDir } : {} })
      .then((cleaned) => cleaned.freed?.then((info) => logDelegationEvent('workspace-watcher-tree-worktree-removed', {}, { todoId, freedBytes: info.freedBytes })))
      .catch(() => {});
    return { ok: true, item };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return code === 'CONFLICT'
      ? { ok: false, reason: 'conflict', currentUpdatedAt: String(/** @type {any} */ (error).currentUpdatedAt || ''), targetTodoId: resolved.targetId }
      : { ok: false, reason: 'error' };
  }
}

/**
 * Library-level integration lock guard shared by REST routes and MCP. A lock
 * refuses every writer except its own: the todo owning a `single` lock (or its
 * resolved target), and the chat bound to a `batch` lock (the batch agent).
 *
 * `humanAttested: true` is the operator's own attestation from the REST confirm
 * / no-code route (the UI). It skips the guard so a human confirm keeps working
 * while a flow owns the lock. Only that route sets it; the MCP path never does,
 * so an agent that is not the lock owner is refused like any other writer.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, todoId?: string, callerChatId?: string, humanAttested?: boolean }} input
 * @returns {Promise<{ ok: false, reason: 'integration_locked', lock: Record<string, any> } | null>} a refusal, or null when allowed
 */
export async function refuseWhenIntegrationLockedForWriter(input = {}) {
  // The human operator is not a competing writer agent. The UI confirm / no-code
  // is the attestation the lock exists to serialise, so it always passes.
  if (input.humanAttested === true) return null;
  if (!input.dataDir || !input.workspaceFolder) return null;
  let lock = null;
  try {
    lock = getIntegrationLock({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder });
  } catch {
    return null;
  }
  if (!lock) return null;
  const todoId = readString(input.todoId);
  if (lock.owner === 'single') {
    const owned = readString(lock.todoId);
    const resolved = await readIntegrationTarget(input.dataDir, input.workspaceFolder, todoId);
    if (owned && (owned === todoId || owned === resolved?.targetId)) return null;
  } else {
    const chatId = readString(input.callerChatId);
    if (chatId && chatId === readString(lock.chatId)) return null;
  }
  return { ok: false, reason: 'integration_locked', lock };
}

/** Invalidate a previously recorded proof after a target branch revert. */
export async function invalidateTodoIntegrationProof(input = {}) {
  const refused = await refuseWhenIntegrationLockedForWriter(input);
  if (refused) return refused;
  const resolved = await readIntegrationTarget(input.dataDir, input.workspaceFolder, readString(input.todoId));
  if (!resolved) return { ok: false, reason: 'not_found' };
  const current = resolved.target;
  if (!current.integration?.evidence) return { ok: false, reason: 'no_evidence' };
  const expectedUpdatedAt = readString(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return { ok: false, reason: 'expected_revision_required' };
  const reason = readString(input.reason).slice(0, 300);
  if (!reason) return { ok: false, reason: 'reason_required' };
  const now = readString(input.now) || new Date().toISOString();
  try {
    const doc = await updateTodo(input.dataDir, input.workspaceFolder, resolved.targetId, {
      integration: { ...current.integration, evidence: null, reason: `proof_invalidated: ${reason}`, updatedAt: now },
      expectedUpdatedAt,
    });
    releaseSingleIntegrationLock({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder, todoIds: [resolved.targetId, input.todoId] });
    return { ok: true, item: doc.items.find((row) => String(row.id) === resolved.targetId) || null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return code === 'CONFLICT'
      ? { ok: false, reason: 'conflict', currentUpdatedAt: String(/** @type {any} */ (error).currentUpdatedAt || ''), targetTodoId: resolved.targetId }
      : { ok: false, reason: 'error' };
  }
}

/**
 * Undo a request builder whose chat could not be started: clear the
 * `smart_merge_running` marker the builder set and give a `single` lock back.
 *
 * @param {{ dataDir?: string, workspaceFolder: string, targetId: string, todoId?: string }} input
 */
export async function rollbackIntegrationRequest(input) {
  await clearSmartMergeRunningMarker(input.dataDir, input.workspaceFolder, readString(input.targetId));
  releaseSingleIntegrationLock({
    dataDir: input.dataDir,
    workspaceFolder: input.workspaceFolder,
    todoIds: [readString(input.targetId), readString(input.todoId)],
  });
}

/**
 * Clear the `smart_merge_running` marker a builder set on the target. The marker
 * is advisory; a concurrent edit keeps its own value.
 *
 * @param {string | undefined} dataDir
 * @param {string} workspaceFolder
 * @param {string} targetId
 */
export async function clearSmartMergeRunningMarker(dataDir, workspaceFolder, targetId) {
  try {
    const todo = (await listTodos(dataDir, workspaceFolder)).items.find((row) => readString(row.id) === targetId);
    const patch = buildClearSmartMergeMarkerPatch(todo);
    if (patch) await updateTodo(dataDir, workspaceFolder, targetId, patch);
  } catch {
    // Advisory marker only.
  }
}

/**
 * Todo patch that clears the `smart_merge_running` marker, or null when the todo does not carry it.
 * Shared with the batch store, which still writes through the synchronous API.
 *
 * @param {Record<string, any> | null | undefined} todo
 * @returns {Record<string, any> | null}
 */
export function buildClearSmartMergeMarkerPatch(todo) {
  if (!todo || readString(todo.integration?.reason) !== SMART_MERGE_RUNNING) return null;
  return {
    status: todo.status,
    strictStatus: true,
    integration: { ...todo.integration, reason: '', updatedAt: new Date().toISOString() },
  };
}

/** True when the stored worktree result patch has no content, so nothing is left to integrate. */
function isEmptyIntegrationResult(todo) {
  const patchPath = readString(todo?.integration?.resultPath);
  if (!patchPath) return false;
  try {
    return fs.statSync(patchPath).size === 0;
  } catch {
    return false;
  }
}

/**
 * Record a human review that a TODO produced no code changes. Guarded by the
 * workspace integration lock exactly like confirm; the REST human attestation
 * (`humanAttested: true`) is the only exemption.
 *
 * @param {{ todoId?: string, workspaceFolder?: string, dataDir?: string, expectedUpdatedAt?: string, reason?: string, callerChatId?: string, humanAttested?: boolean, now?: string }} input
 * @returns {Promise<{ ok: boolean, reason?: string, item?: Record<string, any> | null, currentUpdatedAt?: string, targetTodoId?: string }>}
 */
export async function markTodoIntegrationNoCode(input = {}) {
  const refused = await refuseWhenIntegrationLockedForWriter(input);
  if (refused) return refused;
  const resolved = await readIntegrationTarget(input.dataDir, input.workspaceFolder, readString(input.todoId));
  if (!resolved) return { ok: false, reason: 'not_found' };
  const current = resolved.target;
  if (current.status !== 'done') return { ok: false, reason: 'not_done' };
  const awaiting = isTodoAwaitingIntegration(current);
  if (awaiting && !isEmptyIntegrationResult(current)) return { ok: false, reason: 'integration_ready' };
  if (current.integration?.evidence) return { ok: false, reason: 'already_integrated' };
  const expectedUpdatedAt = readString(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return { ok: false, reason: 'expected_revision_required' };
  const reason = readString(input.reason).slice(0, 200);
  if (!reason) return { ok: false, reason: 'reason_required' };
  const now = readString(input.now) || new Date().toISOString();
  try {
    const doc = await updateTodo(input.dataDir, input.workspaceFolder, resolved.targetId, {
      integration: {
        ...current.integration,
        state: awaiting ? 'integrated' : current.integration?.state || 'integrated',
        changeScope: 'none',
        noCodeReason: reason,
        noCodeConfirmedAt: now,
        noCodeMaterialFingerprint: fingerprintTodoMaterial(current),
        evidence: null,
        reason: '',
        updatedAt: now,
      },
      expectedUpdatedAt,
    });
    releaseSingleIntegrationLock({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder, todoIds: [resolved.targetId, input.todoId] });
    return { ok: true, item: doc.items.find((row) => String(row.id) === resolved.targetId) || null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return code === 'CONFLICT'
      ? { ok: false, reason: 'conflict', currentUpdatedAt: String(/** @type {any} */ (error).currentUpdatedAt || ''), targetTodoId: resolved.targetId }
      : { ok: false, reason: 'error' };
  }
}

/**
 * Human rejection: the worktree and its diff are preserved, the todo returns to
 * `ready` with a readable reason so a retry can reuse the frozen worktree.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   expectedUpdatedAt?: string,
 *   reason?: string,
 *   now?: number,
 * }} input
 * @returns {Promise<{ ok: boolean, reason?: string, item?: Record<string, any> | null, currentUpdatedAt?: string, targetTodoId?: string }>}
 */
export async function rejectWorkspaceTodoIntegration(input) {
  const refused = await refuseWhenIntegrationLockedForWriter(input);
  if (refused) return refused;
  const now = readString(input.now ? new Date(input.now).toISOString() : '') || new Date().toISOString();
  const dataDir = input.dataDir;
  const resolved = await readIntegrationTarget(dataDir, input.workspaceFolder, input.todoId);
  if (!resolved) return { ok: false, reason: 'not_found' };
  const todoId = resolved.targetId;
  const current = resolved.target;
  if (!isTodoAwaitingIntegration(current)) return { ok: false, reason: 'not_ready' };
  if (readString(current.integration?.appliedAt)) return { ok: false, reason: 'already_applied' };
  const reason = readString(input.reason) || 'Integration rejected; the worktree result is preserved for a retry.';
  const expectedUpdatedAt = readString(input.expectedUpdatedAt) || readString(current.updatedAt);
  try {
    const doc = await updateTodo(dataDir, input.workspaceFolder, todoId, {
      status: 'ready',
      strictStatus: true,
      integration: { ...current.integration, state: 'rejected', reason, updatedAt: now },
      expectedUpdatedAt,
      claimedByChatId: null,
      claimedAt: null,
    });
    const item = doc.items.find((row) => String(row.id) === todoId) || null;
    updateRegistryIntegrationState({
      todoId,
      dataDir,
      integrationState: 'rejected',
      reason,
      now,
    });
    releaseSingleIntegrationLock({ dataDir, workspaceFolder: input.workspaceFolder, todoIds: [todoId, input.todoId] });
    return { ok: true, item };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return code === 'CONFLICT'
      ? { ok: false, reason: 'conflict', currentUpdatedAt: String(/** @type {any} */ (error).currentUpdatedAt || ''), targetTodoId: resolved.targetId }
      : { ok: false, reason: 'error' };
  }
}

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const postIntegrators = new Map();

function execPostIntegrationCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: PROJECT_ROOT, stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => resolve({ ok: code === 0 }));
  });
}

/** One integrator per data dir so a batch of commits coalesces into one restart. */
function getPostIntegrator(dataDir, policyRef) {
  const key = dataDir || '';
  let entry = postIntegrators.get(key);
  if (!entry) {
    entry = { policy: policyRef, integrator: createPostIntegrator({
      getPolicy: () => entry.policy,
      exec: execPostIntegrationCommand,
      runtime: {
        block: () => blockNewStarts({ dataDir }),
        unblock: () => unblockNewStarts({ dataDir }),
        activeCycles: () => getActiveCycleCount({ dataDir }),
      },
    }) };
    postIntegrators.set(key, entry);
  }
  entry.policy = policyRef;
  return entry.integrator;
}

/**
 * After a committed auto-integration: record the changed files and flush in the
 * background (the restart waits for active cycles and must not stall the tick).
 * No-op unless policy `autoRestart` is on; failures never affect the outcome.
 */
function schedulePostIntegration(input, result) {
  try {
    if (input.policy?.autoRestart !== true) return;
    const integrator = input.deps?.postIntegrator || getPostIntegrator(input.dataDir, input.policy);
    const paths = (result?.changedFiles || []).map((entry) => (typeof entry === 'string' ? entry : entry?.path)).filter(Boolean);
    if (!integrator.record(paths)) return;
    Promise.resolve(integrator.flush()).catch((error) => {
      console.warn('[cretli] post-integration failed:', error?.message || error);
    });
  } catch (error) {
    console.warn('[cretli] post-integration scheduling failed:', error?.message || error);
  }
}

/** Resolve the immutable registry result, never a denormalized todo field. */
const automaticWorkspaces = new Set();

export const FRONTEND_SMOKE_STOP_REASON = 'frontend_smoke_failed';

function frontendSmokeEvidenceBody({ todo, result, reason, error }) {
  const artifacts = readString(error?.artifacts);
  const files = [];
  const visit = (folder, prefix = '') => {
    if (!folder || !fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) visit(path.join(folder, entry.name), relative);
      else if (/\.(?:png|zip|json|log|md)$/i.test(entry.name)) files.push(relative);
    }
  };
  visit(artifacts);
  const evidence = files.slice(0, 50).map((file) => `- ${file}`).join('\n') || '- no artifact files found';
  return [
    `Automatic frontend smoke failed for todo ${readString(todo?.id)}.`,
    '',
    `Reason: ${reason}`,
    `Base commit: ${readString(result?.baseCommit) || 'unknown'}`,
    `Material revision: ${readString(result?.materialRevision) || 'unknown'}`,
    `Artifact directory: ${artifacts || 'unavailable'}`,
    '',
    'Evidence files (screenshots, console diagnostics, logs and trace):',
    evidence,
  ].join('\n');
}

/** Durably stop the workspace and record operator-visible smoke evidence. */
export async function suspendWorkspaceAfterFrontendSmokeFailure(input, deps = {}) {
  const mutate = deps.mutateWatcher || mutateWorkspaceWatcherRow;
  const notify = deps.notify || publishNotification;
  const createTodo = deps.createTodo || addTodo;
  const broadcast = deps.broadcast || broadcastWorkspaceWatcherChanged;
  const saved = mutate(input.workspaceFolder, () => ({ stopReason: FRONTEND_SMOKE_STOP_REASON }), { dataDir: input.dataDir });
  if (!saved?.ok) return { ok: false, reason: `smoke_pause_failed:${readString(saved?.reason) || 'unknown'}` };
  broadcast({ workspaceFolder: input.workspaceFolder });
  const evidenceBody = frontendSmokeEvidenceBody(input);
  const fingerprint = `frontend-smoke:${readString(input.todo?.id)}:${readString(input.result?.cycleId) || readString(input.result?.patchSha256)}`;
  const notified = await notify({
    category: 'system', severity: 'error', title: 'Frontend smoke test failed',
    body: `Automatic integration was stopped. ${input.reason}`,
    actionUrl: '/?panel=todo&tab=watcher', fingerprint,
  }, { storePath: path.join(input.dataDir, 'notification-center.json') });
  if (!notified || (!notified.created && !notified.id)) throw Object.assign(new Error('smoke_notification_failed'), { code: 'smoke_notification_failed' });
  const created = await createTodo(input.dataDir, input.workspaceFolder, {
    title: 'Investigate frontend smoke test failure', body: evidenceBody, status: 'ready',
    idempotencyKey: fingerprint, sourceTodoId: readString(input.todo?.id) || null,
  });
  if (!created?.item?.id) throw Object.assign(new Error('smoke_evidence_todo_failed'), { code: 'smoke_evidence_todo_failed' });
  return { ok: true, todoId: created.item.id, notificationId: notified.id };
}

/** @param {Record<string, any>} input @returns {Promise<Record<string, any>>} */
export async function automaticallyIntegrateWorkspaceTodo(input) {
  const key = path.resolve(input.workspaceFolder);
  if (automaticWorkspaces.has(key)) return { ok: false, reason: 'busy' };
  automaticWorkspaces.add(key);
  try { return await automaticallyIntegrateWorkspaceTodoUnlocked(input); }
  finally { automaticWorkspaces.delete(key); }
}

async function confirmAutomaticCommit(input, result, integrated) {
  const current = await readTodo(input.dataDir, input.workspaceFolder, input.todoId);
  return confirmWorkspaceTodoIntegration({ ...input, expectedUpdatedAt: current.updatedAt, proof: {
    targetBranch: integrated.branch, targetCommit: integrated.commit, sourceCommit: integrated.commit,
    materialRevision: result.materialRevision || integrated.commit,
    changeRef: `auto_integrator patch ${result.patchSha256}`, changeAttested: true,
    source: 'auto_integrator', cycleId: result.cycleId,
  } });
}

async function automaticallyIntegrateWorkspaceTodoUnlocked(input) {
  const todo = await readTodo(input.dataDir, input.workspaceFolder, input.todoId);
  const record = getWorktreeIntegrationRecord(input.todoId, input.dataDir);
  const result = record?.results?.[todo?.integration?.cycleId];
  if ((await listTodos(input.dataDir, input.workspaceFolder)).items.some((item) => item.parentId === input.todoId)) {
    return { ok: false, reason: 'integration_not_leaf' };
  }
  if (input.policy?.autoIntegrate !== true) return { ok: false, reason: 'auto_integrate_disabled' };
  const row = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
  if (row?.paused) return { ok: false, reason: 'paused' };
  if (readString(row?.stopReason)) return { ok: false, reason: 'stopped' };
  const authorization = authorizeAutomaticIntegration({ policy: input.policy, todo, result });
  if (!authorization.ok) return authorization;
  const audit = row?.automaticIntegrations || [];
  const pending = [...audit].reverse().find((entry) => entry.todoId === input.todoId
    && entry.cycleId === result?.cycleId && entry.patchSha256 === result?.patchSha256
    && ['publication_pending', 'confirmation_pending'].includes(entry.reason) && entry.commit);
  if (pending && todo?.integration?.state === 'ready') {
    const recovered = await confirmAutomaticCommit(input, result, pending);
    if (recovered.ok) {
      mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => ({
        automaticIntegrations: current.automaticIntegrations.map((entry) => entry.commit === pending.commit
          ? { ...entry, ok: true, reason: '' } : entry),
      }), { dataDir: input.dataDir });
      schedulePostIntegration(input, result);
      return { ...recovered, applied: { commit: pending.commit } };
    }
  }
  if (todo?.integration?.reason === 'confirmation_pending') return { ok: false, reason: 'confirmation_pending' };
  if (audit.filter((entry) => Date.parse(entry.at) > Date.now() - 3600000).length >= (input.policy.autoIntegrateMaxPerHour || 10)) return { ok: false, reason: 'integration_rate_limit' };
  let streak = 0;
  for (const entry of [...audit].reverse()) { if (entry.ok) break; streak += 1; }
  if (streak >= (input.policy.autoIntegrateMaxFailures || 3)) return { ok: false, reason: 'integration_failure_limit' };
  let published = false;
  let committed = '';
  const outcome = await runAutomaticIntegration({ policy: input.policy, todo, result, deps: {
    apply: async () => {
      const refused = await refuseWhenIntegrationLockedForWriter(input);
      if (refused) return refused;
      if (!isLiveWorktreeRecord(record) || result.baseCommit !== record.baseCommit) return { ok: false, reason: 'patch_invalid' };
      const expected = worktreeResultPatchPath(input.dataDir, input.todoId, result.cycleId);
      if (path.resolve(result.patchPath) !== path.resolve(expected)
        || createHash('sha256').update(fs.readFileSync(expected)).digest('hex') !== result.patchSha256) return { ok: false, reason: 'patch_invalid' };
      const integrated = await integrateGitResult({ ...input, result, gates: input.deps?.gates, beforePublish: async ({ commit, branch }) => {
        const latest = await readTodo(input.dataDir, input.workspaceFolder, input.todoId);
        const watcher = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
        if (latest.updatedAt !== todo.updatedAt || latest.integration?.cycleId !== result.cycleId
          || fingerprintTodoMaterial(latest) !== fingerprintTodoMaterial(todo)
          || (watcher && (watcher.paused || watcher.policy.autoIntegrate !== true))) {
          throw Object.assign(new Error('Integration authorization changed'), { code: 'authorization_changed' });
        }
        committed = commit;
        if (row) {
          const saved = mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => ({
            automaticIntegrations: [...current.automaticIntegrations, {
              todoId: input.todoId, at: new Date().toISOString(), ok: false,
              reason: 'publication_pending', commit, branch, cycleId: result.cycleId, patchSha256: result.patchSha256,
            }].slice(-100),
          }), { dataDir: input.dataDir });
          if (!saved.ok) throw Object.assign(new Error('Audit not durable'), { code: 'audit_not_durable' });
        }
      } });
      published = true;
      committed = integrated.commit;
      const confirmed = await confirmAutomaticCommit(input, result, integrated);
      // A published commit must never be rejected back into the fix queue.
      if (!confirmed.ok) throw Object.assign(new Error(confirmed.reason), { code: 'confirmation_pending' });
      return { ...confirmed, commit: integrated.commit };
    },
    suspendAfterSmokeFailure: (failure) => suspendWorkspaceAfterFrontendSmokeFailure({ ...input, ...failure }, input.deps?.smokeFailure),
    reject: async ({ reason }) => {
      if (published || reason === 'confirmation_pending') {
        await recordTodoIntegrationIssue({ ...input, todo: await readTodo(input.dataDir, input.workspaceFolder, input.todoId), reason: 'confirmation_pending' });
        return { ok: false, reason: 'confirmation_pending' };
      }
      if (['confirmation_pending', 'authorization_changed', 'busy', 'integration_locked'].includes(reason)) return { ok: false, reason };
      const current = await readTodo(input.dataDir, input.workspaceFolder, input.todoId);
      await updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
        body: `${current.body || ''}\n\nAutomatic integration returned for correction: ${reason}. Patch: ${result.patchPath}`,
        expectedUpdatedAt: current.updatedAt,
      });
      return rejectWorkspaceTodoIntegration({ ...input, reason });
    },
  } });
  if (row && !['review_not_passed', 'integration_not_ready'].includes(outcome.reason)) {
    mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => {
      return { automaticIntegrations: [...(current.automaticIntegrations || []).filter((entry) => !committed || entry.commit !== committed), {
        todoId: input.todoId, at: new Date().toISOString(), ok: outcome.ok,
        reason: outcome.reason || '', commit: outcome.applied?.commit || committed,
        branch: current.automaticIntegrations.find((entry) => entry.commit === committed)?.branch || '',
        cycleId: result.cycleId, patchSha256: result.patchSha256,
      }].slice(-100) };
    }, { dataDir: input.dataDir });
  }
  if (outcome.ok && (outcome.applied?.commit || committed)) schedulePostIntegration(input, result);
  return outcome;
}
