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
 * A human then confirms (todo `done`, siblings unblocked) or rejects (todo back
 * to `ready`, worktree preserved). Nothing here commits, merges or removes a
 * worktree; cleanup goes through `removeWorktree` and its discard guard.
 */

import { createHash } from 'node:crypto';
import { getWorktreeRecord, mutateWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { updateTodo, loadTodosData } from './persist/todos-persist.js';
import { writeTextAtomic } from './persist/atomic-write.js';
import { collectWorktreeExecutionDiff } from './worktree/git-worktree.js';
import { createWorktreeResult, worktreeResultPatchPath } from './worktree/worktree-result.js';
import { readDelegationMaterialRevision } from './delegation-material-revision.js';
import { isTodoAwaitingIntegration } from './todo-integration-state.js';
import { resolveTodoRootId } from './todo-tree.js';
import { isLiveWorktreeRecord } from './todo-worktree-manual.js';

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
 * @returns {object | null}
 */
export function getWorktreeIntegrationRecord(todoId, dataDir) {
  return getWorktreeRecord(todoId, dataDir ? { dataDir } : {});
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
 *   record: object,
 *   outcome?: string,
 *   reportedOutcome?: string,
 *   reviewOutcome?: string,
 *   reviewVerified?: boolean,
 *   testOutcome?: string,
 *   testEvidence?: string,
 *   now?: string,
 *   deps?: object,
 * }} input
 * @returns {object}
 */
export function prepareWorktreeIntegrationResult(input) {
  const record = input.record;
  const collect = typeof input?.deps?.collectWorktreeExecutionDiff === 'function'
    ? input.deps.collectWorktreeExecutionDiff
    : collectWorktreeExecutionDiff;
  const diff = collect({ worktreePath: record.worktreePath, baseCommit: record.baseCommit });
  const patchPath = worktreeResultPatchPath(input.dataDir, input.todoId, input.cycleId);
  const patch = String(diff.patch ?? '');
  writeTextAtomic(patchPath, patch);
  const materialRevision = readString(record.materialRevision)
    || readDelegationMaterialRevision(record.worktreePath);
  const reviewOutcome = readString(input.reviewOutcome) || readString(input.outcome) || 'unknown';
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
      reportedOutcome: readString(input.reportedOutcome) || readString(input.outcome),
      verified: input.reviewVerified === true,
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
 *   result: object,
 *   dataDir?: string,
 *   registryOptions?: object,
 *   now?: string,
 * }} input
 * @returns {{ ok: boolean, changed: boolean, record?: object, result?: object, reason?: string }}
 */
export function markTodoIntegrationReady(input) {
  const now = readString(input.now) || new Date().toISOString();
  const registryOptions = input.registryOptions || (input.dataDir ? { dataDir: input.dataDir } : {});
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
  markTodoIntegrationPointer({
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
 * @param {{ todoId: string, workspaceFolder: string, dataDir?: string, integration: object }} input
 * @returns {object | null}
 */
export function markTodoIntegrationPointer(input) {
  const doc = updateTodo(input.dataDir, input.workspaceFolder, input.todoId, {
    status: 'doing',
    strictStatus: true,
    integration: input.integration,
  });
  return doc.items.find((row) => String(row.id) === input.todoId) || null;
}

/**
 * Prepare (build the diff and mark) a manually started ROOT worktree for human
 * integration. Unlike the Watcher path there is no review/report step, so the
 * recorded evidence is honest: `outcome:'manual'`, `review.verified:false`,
 * `test.outcome:'unknown'`. The synthetic cycle id is stable per root chat, so
 * a repeated prepare is idempotent; the diff accumulates every leaf sibling of
 * the tree.
 *
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   now?: string,
 *   deps?: object,
 * }} input
 * @returns {{ ok: boolean, changed?: boolean, reason?: string, result?: object, item?: object | null }}
 */
export function prepareManualTodoIntegration(input = {}) {
  const dataDir = input.dataDir;
  const todoId = readString(input.todoId);
  const workspaceFolder = readString(input.workspaceFolder);
  const doc = loadTodosData(dataDir, workspaceFolder);
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const rootId = resolveTodoRootId(items, todoId);
  const rootTodo = items.find((row) => String(row?.id || '') === rootId) || null;
  if (!todoId || !rootTodo) return { ok: false, reason: 'not_found' };
  if (rootId !== todoId) {
    return { ok: false, reason: 'not_root' };
  }
  const record = getWorktreeIntegrationRecord(rootId, dataDir);
  if (!isLiveWorktreeRecord(record)) return { ok: false, reason: 'no_worktree' };
  if (record.executionState === 'preparing') return { ok: false, reason: 'busy' };
  const chatId = readString(rootTodo.chatId) || readString(rootTodo.orchestratorChatId);
  const cycleId = `manual-${chatId || rootId}`;
  const result = prepareWorktreeIntegrationResult({
    todoId: rootId,
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
  const marked = markTodoIntegrationReady({
    todoId: rootId,
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
    result,
    item: readTodo(dataDir, workspaceFolder, rootId),
  };
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {string} todoId
 * @returns {object | null}
 */
function readTodo(dataDir, workspaceFolder, todoId) {
  try {
    const doc = loadTodosData(dataDir, workspaceFolder);
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
 * @param {{ todoId: string, dataDir?: string, registryOptions?: object, integrationState: string, reason?: string, now: string }} input
 * @returns {object | null}
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
 * @param {{
 *   todoId: string,
 *   workspaceFolder: string,
 *   dataDir?: string,
 *   expectedUpdatedAt?: string,
 *   now?: number,
 * }} input
 * @returns {{ ok: boolean, reason?: string, item?: object | null }}
 */
export function confirmWorkspaceTodoIntegration(input) {
  const now = readString(input.now ? new Date(input.now).toISOString() : '') || new Date().toISOString();
  const dataDir = input.dataDir;
  const current = readTodo(dataDir, input.workspaceFolder, input.todoId);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!isTodoAwaitingIntegration(current)) return { ok: false, reason: 'not_ready' };
  const expectedUpdatedAt = readString(input.expectedUpdatedAt) || readString(current.updatedAt);
  try {
    const doc = updateTodo(dataDir, input.workspaceFolder, input.todoId, {
      status: 'done',
      strictStatus: true,
      integration: { ...current.integration, state: 'integrated', updatedAt: now },
      expectedUpdatedAt,
      claimedByChatId: null,
      claimedAt: null,
    });
    const item = doc.items.find((row) => String(row.id) === input.todoId) || null;
    updateRegistryIntegrationState({
      todoId: input.todoId,
      dataDir,
      integrationState: 'integrated',
      now,
    });
    return { ok: true, item };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return { ok: false, reason: code === 'CONFLICT' ? 'conflict' : 'error' };
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
 * @returns {{ ok: boolean, reason?: string, item?: object | null }}
 */
export function rejectWorkspaceTodoIntegration(input) {
  const now = readString(input.now ? new Date(input.now).toISOString() : '') || new Date().toISOString();
  const dataDir = input.dataDir;
  const current = readTodo(dataDir, input.workspaceFolder, input.todoId);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!isTodoAwaitingIntegration(current)) return { ok: false, reason: 'not_ready' };
  const reason = readString(input.reason) || 'Integration rejected; the worktree result is preserved for a retry.';
  const expectedUpdatedAt = readString(input.expectedUpdatedAt) || readString(current.updatedAt);
  try {
    const doc = updateTodo(dataDir, input.workspaceFolder, input.todoId, {
      status: 'ready',
      strictStatus: true,
      integration: { ...current.integration, state: 'rejected', reason, updatedAt: now },
      expectedUpdatedAt,
      claimedByChatId: null,
      claimedAt: null,
    });
    const item = doc.items.find((row) => String(row.id) === input.todoId) || null;
    updateRegistryIntegrationState({
      todoId: input.todoId,
      dataDir,
      integrationState: 'rejected',
      reason,
      now,
    });
    return { ok: true, item };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'ERROR';
    return { ok: false, reason: code === 'CONFLICT' ? 'conflict' : 'error' };
  }
}
