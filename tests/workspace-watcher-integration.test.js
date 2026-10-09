/**
 * Worktree result persistence and manual integration (contract §8.3, §8.4,
 * §8.10, §8.13, §9.1).
 *
 * Every Git repository lives under os.tmpdir(). Covered here: the diff includes
 * new/untracked files, a worktree PASS records a result and keeps the todo
 * `doing`, selection/recovery gates exclude it, confirm unblocks a sequential
 * sibling, and reject/cleanup preserve the worktree.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById, loadTodosData } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import {
  getWorktreeRecord,
  readWorktreeRegistry,
} from '../lib/persist/worktree-registry-persist.js';
import { listReadyTodoLeaves, isTodoNodeBlocked } from '../lib/todo-tree.js';
import { pickNextWorkspaceReadyTodo } from '../lib/workspace-watcher.js';
import { classifyWorkspaceDoingTodo } from '../lib/workspace-watcher-recovery.js';
import { recoverWorkspaceWatcherTodo } from '../lib/workspace-watcher-todo-recover.js';
import { startWorkspaceWatcherCycle, reportWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { releaseWorkspaceWatcherCycleTodoClaim } from '../lib/workspace-watcher-cycle-close.js';
import { prepareWorkspaceWatcherExecution } from '../lib/workspace-watcher-worktree.js';
import { collectWorktreeExecutionDiff } from '../lib/worktree/git-worktree.js';
import { removeWorktree } from '../lib/worktree-manager.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';
import {
  confirmWorkspaceTodoIntegration,
  isTodoAwaitingIntegration,
  prepareWorktreeIntegrationResult,
  rejectWorkspaceTodoIntegration,
} from '../lib/workspace-watcher-integration.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from '../lib/worktree/worktree-errors.js';
import { createTempRepo, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const T0 = Date.parse('2026-06-01T10:00:00.000Z');

/**
 * @param {string} name
 * @returns {{ dataDir: string, baseDir: string, repo: string, cleanup: () => void }}
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-int-data-${name}-`);
  const baseDir = tempDir(`cretli-int-base-${name}-`);
  const repo = createTempRepo().dir;
  return {
    dataDir,
    baseDir,
    repo,
    cleanup: () => {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

/**
 * @param {string} dataDir
 * @param {string} repo
 * @param {object} [extra]
 * @returns {object}
 */
function addReadyTodo(dataDir, repo, title, extra = {}) {
  return addTodo(dataDir, repo, { title, status: 'ready', ...extra }).item;
}

/**
 * @param {string} repo
 * @param {string} dataDir
 * @param {boolean} [withLayout]
 * @returns {object}
 */
function setAutopilotWorktree(repo, dataDir, baseDir, options = {}) {
  return upsertWorkspaceWatcher(repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 25,
      maxParallel: options.maxParallel || 1,
      executionMode: 'worktree',
      worktree: worktreeConfig(baseDir),
    },
  }, { dataDir });
}

/**
 * @returns {object}
 */
function cycleDeps() {
  return {
    addChat: (_session, title, _wf, _folder, _model, extras) => ({ id: extras.id, title }),
    startChatRun: async () => ({ runId: 'run-1', accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether a worktree-preparation test can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    notify: () => false,
  };
}

/**
 * Start one worktree cycle for the todo and return its chat id.
 *
 * @param {{ dataDir: string, repo: string }} suite
 * @param {object} todo
 * @returns {Promise<string>}
 */
async function startCycle(suite, todo) {
  const deps = cycleDeps();
  const tick = {
    watcher: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: {
      readyLeaves: [{
        id: todo.id,
        updatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt,
        title: todo.title,
      }],
    },
  };
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    now: T0,
    tick,
    token: `lease-${todo.id.slice(0, 8)}`,
    deps,
  });
  assert.equal(started.started, true, JSON.stringify(started));
  return String(started.cycle.chatId);
}

/**
 * @param {{ dataDir: string, repo: string }} suite
 * @param {string} chatId
 * @param {object} todo
 * @param {object} [extra]
 * @returns {object}
 */
function reportPass(suite, chatId, todo, extra = {}) {
  return reportWorkspaceWatcherCycle({
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    now: T0 + 60_000,
    sourceChatId: chatId,
    outcome: 'success',
    todoIds: [todo.id],
    ...extra,
  });
}

test('listReadyTodoLeaves and the pick exclude an integration-ready leaf', () => {
  const items = [
    { id: 'parent', title: 'p', status: 'doing', runMode: 'sequential', siblingIndex: 0 },
    { id: 's1', title: 's1', status: 'doing', parentId: 'parent', siblingIndex: 0, integration: { state: 'ready' } },
    { id: 's2', title: 's2', status: 'ready', parentId: 'parent', siblingIndex: 1 },
  ];
  const ready = listReadyTodoLeaves(items);
  assert.equal(ready.length, 0, 'integration-ready s1 is excluded and s2 waits for it');
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  assert.equal(pickNextWorkspaceReadyTodo({ readyLeaves: ready }), null);
  // Defensive: even a forced `ready` status does not make it pickable.
  const forced = items.map((row) => (row.id === 's1' ? { ...row, status: 'ready' } : row));
  assert.equal(listReadyTodoLeaves(forced).length, 0);
});

test('collectWorktreeExecutionDiff includes tracked changes and new files', async (t) => {
  const suite = makeSuite('diff');
  t.after(suite.cleanup);
  const todoId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) },
    dataDir: suite.dataDir,
  });
  fs.writeFileSync(path.join(prepared.record.worktreePath, 'README.md'), '# changed\n');
  fs.writeFileSync(path.join(prepared.record.worktreePath, 'new-file.txt'), 'brand new\n');
  const diff = collectWorktreeExecutionDiff({
    worktreePath: prepared.record.worktreePath,
    baseCommit: prepared.record.baseCommit,
  });
  const paths = diff.changedFiles.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ['README.md', 'new-file.txt']);
  assert.match(diff.patch, /new file mode/);
  assert.match(diff.patch, /new-file\.txt/);
});

test('a worktree PASS records the result, keeps the todo doing and is replay-safe', async (t) => {
  const suite = makeSuite('pass');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'integrate me', { executionMode: 'worktree' });
  setAutopilotWorktree(suite.repo, suite.dataDir, suite.baseDir);
  const chatId = await startCycle(suite, todo);
  const record = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'feature.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(record.worktreePath, 'README.md'), '# integrated\n');

  const first = reportPass(suite, chatId, todo, { cycleId: String(getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).activeCycles[0].cycleId), reportId: 'r-1' });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.closed, true);

  const after = getTodoById(suite.dataDir, suite.repo, todo.id);
  assert.equal(after.status, 'doing', 'a PASS in a worktree never returns the leaf to ready');
  assert.equal(isTodoAwaitingIntegration(after), true);
  assert.equal(after.claimedByChatId, undefined, 'the claim is released');
  assert.equal(String(after.integration?.cycleId || '').length > 0, true);
  assert.equal(getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).activeCycles.length, 0, 'the cycle is closed');

  const stored = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  assert.equal(stored.integrationState, 'ready');
  assert.equal(stored.executionState, 'execution_closed');
  const cycleId = Object.keys(stored.results)[0];
  assert.ok(cycleId, 'the result is stored by cycle id');
  assert.equal(stored.results[cycleId].changedFiles.some((entry) => entry.path === 'feature.js'), true);
  assert.equal(fs.existsSync(stored.results[cycleId].patchPath), true);
  const revision = readWorktreeRegistry({ dataDir: suite.dataDir }).revision;

  // A repeated report is a replay and must not double-count or lose the result.
  const replay = reportPass(suite, chatId, todo, { cycleId, reportId: 'r-1' });
  assert.equal(replay.replayed, true);
  const reloaded = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  assert.equal(Object.keys(reloaded.results).length, 1);
  assert.equal(readWorktreeRegistry({ dataDir: suite.dataDir }).revision, revision);
  assert.equal(fs.existsSync(reloaded.results[cycleId].patchPath), true);

  // A lost claim (already released, or owned by another chat) must not move the
  // integration-ready leaf back to ready or drop the result.
  const lostChatRelease = releaseWorkspaceWatcherCycleTodoClaim({
    workspaceFolder: suite.repo,
    todoId: todo.id,
    chatId: 'some-other-chat',
    cycleId,
    dataDir: suite.dataDir,
    now: T0 + 90_000,
  });
  assert.equal(lostChatRelease, undefined);
  const afterLost = getTodoById(suite.dataDir, suite.repo, todo.id);
  assert.equal(afterLost.status, 'doing');
  assert.equal(isTodoAwaitingIntegration(afterLost), true);
  assert.equal(Object.keys(getWorktreeRecord(todo.id, { dataDir: suite.dataDir }).results).length, 1);
});

test('a worktree PASS does not unblock the next sequential sibling; confirm does', async (t) => {
  const suite = makeSuite('sequential');
  t.after(suite.cleanup);
  const parent = addTodo(suite.dataDir, suite.repo, { title: 'parent', status: 'ready', runMode: 'sequential' }).item;
  const s1 = addReadyTodo(suite.dataDir, suite.repo, 'first', { parentId: parent.id, siblingIndex: 0, executionMode: 'worktree' });
  const s2 = addReadyTodo(suite.dataDir, suite.repo, 'second', { parentId: parent.id, siblingIndex: 1, executionMode: 'worktree' });
  setAutopilotWorktree(suite.repo, suite.dataDir, suite.baseDir);
  assert.deepEqual(listReadyTodoLeaves(loadTodosData(suite.dataDir, suite.repo).items).map((row) => row.id), [s1.id]);

  const chatId = await startCycle(suite, s1);
  const record = getWorktreeRecord(s1.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 's1.js'), 's1\n');
  const cycleId = String(getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).activeCycles[0].cycleId);
  reportPass(suite, chatId, s1, { cycleId, reportId: 'seq-1' });

  let items = loadTodosData(suite.dataDir, suite.repo).items;
  assert.equal(listReadyTodoLeaves(items).length, 0, 's2 stays blocked while s1 awaits integration');

  const confirmed = confirmWorkspaceTodoIntegration({
    todoId: s1.id,
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    expectedUpdatedAt: getTodoById(suite.dataDir, suite.repo, s1.id).updatedAt,
    now: T0 + 120_000,
  });
  assert.equal(confirmed.ok, true, confirmed.reason);
  assert.equal(getTodoById(suite.dataDir, suite.repo, s1.id).status, 'done');
  items = loadTodosData(suite.dataDir, suite.repo).items;
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), [s2.id]);
});

test('integration-ready recovery is user_action and never auto-releases', async (t) => {
  const suite = makeSuite('recovery');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'await', { executionMode: 'worktree' });
  setAutopilotWorktree(suite.repo, suite.dataDir, suite.baseDir);
  const chatId = await startCycle(suite, todo);
  const record = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'x.js'), 'x\n');
  const cycleId = String(getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).activeCycles[0].cycleId);
  reportPass(suite, chatId, todo, { cycleId, reportId: 'rec-1' });

  const item = getTodoById(suite.dataDir, suite.repo, todo.id);
  const state = classifyWorkspaceDoingTodo({
    item,
    items: [item],
    index: new Map([[item.id, item]]),
    childParentIds: new Set(),
    delegations: [],
    cycles: [],
    probe: () => ({ known: true, busy: false, reason: 'idle' }),
    isCycleChatAlive: () => false,
    getChat: () => null,
    now: T0 + 120_000,
  });
  assert.equal(state.state, 'user_action');
  assert.equal(state.reason, 'integration_ready');

  const recovered = recoverWorkspaceWatcherTodo({
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    todoId: todo.id,
    expectedUpdatedAt: item.updatedAt,
    now: T0 + 130_000,
  });
  assert.equal(recovered.outcome, 'user-action');
  assert.equal(getTodoById(suite.dataDir, suite.repo, todo.id).status, 'doing');
});

test('reject returns the todo to ready and preserves worktree, patch and cleanup guard', async (t) => {
  const suite = makeSuite('reject');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'reject me', { executionMode: 'worktree' });
  setAutopilotWorktree(suite.repo, suite.dataDir, suite.baseDir);
  const chatId = await startCycle(suite, todo);
  const record = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'work.js'), 'work\n');
  const cycleId = String(getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }).activeCycles[0].cycleId);
  reportPass(suite, chatId, todo, { cycleId, reportId: 'rej-1' });
  const patchPath = getWorktreeRecord(todo.id, { dataDir: suite.dataDir }).results[cycleId].patchPath;

  const rejected = rejectWorkspaceTodoIntegration({
    todoId: todo.id,
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    expectedUpdatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt,
    reason: 'needs changes',
    now: T0 + 120_000,
  });
  assert.equal(rejected.ok, true, rejected.reason);
  const after = getTodoById(suite.dataDir, suite.repo, todo.id);
  assert.equal(after.status, 'ready');
  assert.equal(after.integration?.state, 'rejected');
  assert.equal(getWorktreeRecord(todo.id, { dataDir: suite.dataDir }).integrationState, 'rejected');
  assert.equal(fs.existsSync(record.worktreePath), true, 'the worktree is preserved');
  assert.equal(fs.existsSync(patchPath), true, 'the patch is preserved');

  // Cleanup refuses unaccepted work without an explicit discard confirmation.
  assert.throws(
    () => removeWorktree({
      todoId: todo.id,
      registryOptions: { dataDir: suite.dataDir },
      hasActiveAgent: () => false,
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.UNACCEPTED,
  );
  const removed = removeWorktree({
    todoId: todo.id,
    registryOptions: { dataDir: suite.dataDir },
    hasActiveAgent: () => false,
    confirmation: { discard: true, worktreePath: record.worktreePath, branch: record.branch },
  });
  assert.equal(removed.removed, true);
});

test('the cycle prompt tells a worktree orchestrator not to mark the todo done', () => {
  const base = {
    workspaceFolder: '/tmp/ws',
    watcher: { policy: { requirePlanApproval: false } },
    decision: { planOnly: false },
    todo: { id: 'todo-1', title: 't' },
    cycleId: 'c1',
    chatId: 'ch1',
  };
  const worktree = buildWorkspaceWatcherCyclePromptPlan({ ...base, executionMode: 'worktree' });
  assert.match(worktree.prompt, /do NOT mark this todo done/i);
  assert.match(worktree.prompt, /manual human integration/);
  const project = buildWorkspaceWatcherCyclePromptPlan({ ...base, executionMode: 'project' });
  assert.doesNotMatch(project.prompt, /do NOT mark this todo done/i);
  assert.match(project.prompt, /mark this todo done with `todo_update`/);
});

test('prepareWorktreeIntegrationResult is idempotent-tagged and stores the material revision', async (t) => {
  const suite = makeSuite('prepare');
  t.after(suite.cleanup);
  const todoId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) },
    dataDir: suite.dataDir,
  });
  fs.writeFileSync(path.join(prepared.record.worktreePath, 'a.js'), 'a\n');
  const record = getWorktreeRecord(todoId, { dataDir: suite.dataDir });
  const result = prepareWorktreeIntegrationResult({
    todoId,
    cycleId: 'cycle-prep',
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    record,
    outcome: 'success',
    reviewVerified: true,
  });
  assert.equal(result.cycleId, 'cycle-prep');
  assert.equal(result.baseCommit, record.baseCommit);
  assert.match(result.materialRevision, /^[0-9a-f]{12}\+/);
  assert.equal(result.changedFiles.some((entry) => entry.path === 'a.js'), true);
  assert.equal(result.patchBytes > 0, true);
  const again = prepareWorktreeIntegrationResult({
    todoId,
    cycleId: 'cycle-prep',
    workspaceFolder: suite.repo,
    dataDir: suite.dataDir,
    record,
    outcome: 'success',
    reviewVerified: true,
  });
  assert.equal(again.resultHash, result.resultHash, 'the same work hashes identically');
});
