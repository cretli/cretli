/**
 * Manual operator release for `unknown` doing todos.
 *
 * Covers the review findings on the unknown-release path:
 *  - non-`doing` todos are refused before classify (NOT_DOING);
 *  - an idempotent replay answers success even with the stale pre-release
 *    revision, and the replay key survives the execution normalizer;
 *  - negative gates: recoverable -> USE_RECOVER, integration/worktree
 *    `user_action` never bypassed, NOT_LEAF, already-active, CAS conflict.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { upsertWorkspaceWatcher, getWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { mutateWorktreeRegistry } from '../lib/persist/worktree-registry-persist.js';
import { createWorktreeRecord } from '../lib/worktree/worktree-record.js';
import { claimWorkspaceTodo } from '../lib/workspace-watcher.js';
import {
  canManualReleaseDoingTodo,
  releaseDoingWorkspaceWatcherTodo,
} from '../lib/workspace-watcher-todo-recover.js';
import { canManualReleaseUnknownWorkspaceTodo } from '../app_front/features/todo/todoRecoveryView.js';

const T0 = Date.parse('2026-10-12T12:00:00.000Z');

function makeWorkspace(name) {
  const cwd = path.join(ISOLATED_DATA_DIR, name);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

try {
  const dataDir = ISOLATED_DATA_DIR;
  const cwd = makeWorkspace('unknown-release');
  const unknownProbe = () => ({ known: false, busy: false, reason: 'state_missing' });
  const busyProbe = () => ({ known: true, busy: true, reason: 'busy' });
  const goneProbe = () => ({ known: false, busy: false, reason: 'chat_missing' });

  /**
   * A `doing` leaf carrying a watcher-style execution attempt, claimed by
   * `chatId`. The claim is written directly (a watcher claim requires the todo
   * to be `ready`), so the stored attempt is exactly what the claim path writes.
   */
  function makeClaimedDoing(title, chatId, extra = {}) {
    const todo = addTodo(dataDir, cwd, { title, status: 'ready', ...extra }).item;
    const claim = claimWorkspaceTodo({
      dataDir,
      workspaceFolder: cwd,
      todoId: todo.id,
      claimedByChatId: chatId,
      expectedUpdatedAt: todo.updatedAt,
      now: T0,
    });
    assert.equal(claim.claimed, true, `claim ${title}: ${claim.reason}`);
    return getTodoById(dataDir, cwd, todo.id);
  }

  // --- Pure gates -----------------------------------------------------------
  const todo = makeClaimedDoing('Stuck unknown', 'exec-chat', { orchestratorChatId: 'exec-chat' });
  upsertWorkspaceWatcher(cwd, {
    mode: 'observe',
    unknownTodoEscalations: {
      [todo.id]: { signature: 'unknown|state_missing|chat_run_probe', count: 3, escalatedSignature: 'x' },
    },
  }, { dataDir });
  const row = getTodoById(dataDir, cwd, todo.id);
  assert.equal(canManualReleaseDoingTodo({ state: 'unknown', reason: 'state_missing' }), true);
  assert.equal(canManualReleaseDoingTodo({ state: 'user_action', reason: 'integration_ready' }), false);
  assert.equal(canManualReleaseDoingTodo({ state: 'user_action', reason: 'worktree_open' }), false);
  assert.equal(canManualReleaseUnknownWorkspaceTodo({ state: 'unknown' }), true);
  assert.equal(canManualReleaseUnknownWorkspaceTodo({ state: 'recoverable' }), false);

  // --- Missing confirmation is a validation error ---------------------------
  const noConfirm = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: row.updatedAt,
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.error?.code, 'VALIDATION');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'doing');

  // --- Happy path: operator release of an unknown doing leaf ----------------
  const released = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: row.updatedAt,
    confirmUnknownRelease: true,
    operatorMessage: 'Operator confirmed stale executor after restart.',
    idempotencyKey: 'release-test-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(released.ok, true);
  assert.equal(released.outcome, 'released');
  assert.equal(released.replayed, false);
  const updated = getTodoById(dataDir, cwd, todo.id);
  assert.equal(updated.status, 'ready');
  assert.equal(updated.claimedByChatId, undefined);
  assert.ok(
    (updated.changelog || []).some((entry) => String(entry.text || '').includes('Operator released stuck todo')),
    'changelog records operator intent',
  );
  // The replay identity persists through the execution normalizer.
  assert.equal(updated.execution?.phase, 'released');
  assert.match(String(updated.execution?.releaseReason || ''), /^manual_unknown_release:/);
  assert.equal(updated.execution?.lastManualUnknownReleaseKey, 'release-test-1');
  assert.equal(updated.execution?.lastRecoverSource, 'manual');
  const watcher = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(watcher.unknownTodoEscalations?.[todo.id], undefined, 'escalation entry cleared');

  // --- True idempotent replay: same key, STALE revision ---------------------
  // The release already bumped updatedAt, so the pre-release revision is stale;
  // the key match must answer success instead of a CAS conflict.
  const replay = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: row.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-test-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.outcome, 'released');
  assert.equal(replay.replayed, true);
  const afterReplay = getTodoById(dataDir, cwd, todo.id);
  assert.equal(afterReplay.status, 'ready');
  assert.equal(
    (afterReplay.changelog || []).filter((entry) => String(entry.text || '').includes('Operator released stuck todo')).length,
    1,
    'a replay never appends a second release note',
  );
  // The replay key is per-todo: reusing it on a DIFFERENT doing todo is not a
  // replay and must not release that todo.
  const otherTodo = makeClaimedDoing('Other unknown', 'exec-chat-other');
  const otherKey = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: otherTodo.id,
    expectedUpdatedAt: otherTodo.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-test-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(otherKey.ok, true);
  assert.equal(otherKey.outcome, 'released');
  assert.equal(otherKey.replayed, false, 'a key recorded on another todo does not replay');
  assert.equal(getTodoById(dataDir, cwd, otherTodo.id).status, 'ready');

  // --- F1: a non-doing todo is refused before classify ----------------------
  const readyTodo = addTodo(dataDir, cwd, { title: 'Not doing', status: 'ready' }).item;
  const readyRow = getTodoById(dataDir, cwd, readyTodo.id);
  const notDoing = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: readyTodo.id,
    expectedUpdatedAt: readyRow.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-ready-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(notDoing.ok, false);
  assert.equal(notDoing.outcome, 'not-doing');
  assert.equal(notDoing.error?.code, 'NOT_DOING');
  const readyAfter = getTodoById(dataDir, cwd, readyTodo.id);
  assert.equal(readyAfter.status, 'ready');
  assert.equal(readyAfter.updatedAt, readyRow.updatedAt, 'a refused release writes nothing');
  const doneTodo = addTodo(dataDir, cwd, { title: 'Already done', status: 'ready' }).item;
  updateTodo(dataDir, cwd, doneTodo.id, { status: 'done' });
  const doneRow = getTodoById(dataDir, cwd, doneTodo.id);
  const doneRelease = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: doneTodo.id,
    expectedUpdatedAt: doneRow.updatedAt,
    confirmUnknownRelease: true,
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(doneRelease.ok, false);
  assert.equal(doneRelease.outcome, 'not-doing');
  assert.equal(doneRelease.error?.code, 'NOT_DOING');
  assert.equal(getTodoById(dataDir, cwd, doneTodo.id).status, 'done');

  // --- recoverable -> USE_RECOVER (never the manual unknown path) -----------
  const recoverableTodo = addTodo(dataDir, cwd, {
    title: 'Recoverable',
    status: 'ready',
    orchestratorChatId: 'gone-chat',
  }).item;
  updateTodo(dataDir, cwd, recoverableTodo.id, { status: 'doing', strictStatus: true });
  const recoverableRow = getTodoById(dataDir, cwd, recoverableTodo.id);
  const useRecover = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: recoverableTodo.id,
    expectedUpdatedAt: recoverableRow.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-recoverable-1',
    probeChatRunLiveness: goneProbe,
  });
  assert.equal(useRecover.ok, false);
  assert.equal(useRecover.outcome, 'recoverable');
  assert.equal(useRecover.error?.code, 'USE_RECOVER');
  assert.equal(getTodoById(dataDir, cwd, recoverableTodo.id).status, 'doing');

  // --- user_action via classify: integration_ready is never bypassed --------
  const integrationTodo = addTodo(dataDir, cwd, {
    title: 'Integration ready',
    status: 'ready',
    orchestratorChatId: 'exec-chat',
  }).item;
  updateTodo(dataDir, cwd, integrationTodo.id, {
    status: 'doing',
    strictStatus: true,
    integration: { state: 'ready' },
  });
  const integrationRow = getTodoById(dataDir, cwd, integrationTodo.id);
  const integrationRelease = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: integrationTodo.id,
    expectedUpdatedAt: integrationRow.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-integration-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(integrationRelease.ok, false);
  assert.equal(integrationRelease.outcome, 'user-action');
  assert.equal(integrationRelease.state?.reason, 'integration_ready');
  assert.equal(getTodoById(dataDir, cwd, integrationTodo.id).status, 'doing');

  // --- user_action via classify: a live worktree record is never bypassed ---
  const worktreeTodo = addTodo(dataDir, cwd, {
    title: 'Worktree open',
    status: 'ready',
    orchestratorChatId: 'exec-chat',
  }).item;
  updateTodo(dataDir, cwd, worktreeTodo.id, { status: 'doing', strictStatus: true });
  const worktreeRecord = createWorktreeRecord({
    todoId: worktreeTodo.id,
    workspaceFolder: cwd,
    worktreePath: path.join(ISOLATED_DATA_DIR, 'wt-path'),
    branch: 'feature/worktree-open',
    baseCommit: 'a'.repeat(40),
  });
  mutateWorktreeRegistry((draft) => {
    draft.items[worktreeRecord.todoId] = worktreeRecord;
  }, { dataDir });
  const worktreeRow = getTodoById(dataDir, cwd, worktreeTodo.id);
  const worktreeRelease = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: worktreeTodo.id,
    expectedUpdatedAt: worktreeRow.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-worktree-1',
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(worktreeRelease.ok, false);
  assert.equal(worktreeRelease.outcome, 'user-action');
  assert.equal(worktreeRelease.state?.reason, 'worktree_open');
  assert.equal(getTodoById(dataDir, cwd, worktreeTodo.id).status, 'doing');

  // --- A leaf with children is refused (NOT_LEAF) ---------------------------
  const parentTodo = addTodo(dataDir, cwd, { title: 'Parent', status: 'ready' }).item;
  addTodo(dataDir, cwd, { title: 'Child', parentId: parentTodo.id, status: 'ready' });
  updateTodo(dataDir, cwd, parentTodo.id, { status: 'doing', strictStatus: true });
  const parentRow = getTodoById(dataDir, cwd, parentTodo.id);
  const notLeaf = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: parentTodo.id,
    expectedUpdatedAt: parentRow.updatedAt,
    confirmUnknownRelease: true,
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(notLeaf.ok, false);
  assert.equal(notLeaf.outcome, 'blocked');
  assert.equal(notLeaf.error?.code, 'NOT_LEAF');

  // --- An already-active slot is refused ------------------------------------
  const activeTodo = makeClaimedDoing('Active slot', 'busy-chat');
  const alreadyActive = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: activeTodo.id,
    expectedUpdatedAt: activeTodo.updatedAt,
    confirmUnknownRelease: true,
    idempotencyKey: 'release-active-1',
    probeChatRunLiveness: busyProbe,
  });
  assert.equal(alreadyActive.ok, false);
  assert.equal(alreadyActive.outcome, 'already-active');
  assert.equal(getTodoById(dataDir, cwd, activeTodo.id).status, 'doing');

  // --- CAS conflict on a stale revision (no replay key match) ---------------
  const staleTodo = makeClaimedDoing('Stale revision', 'exec-chat-2');
  const staleRelease = releaseDoingWorkspaceWatcherTodo({
    dataDir,
    workspaceFolder: cwd,
    todoId: staleTodo.id,
    expectedUpdatedAt: '1970-01-01T00:00:00.000Z',
    confirmUnknownRelease: true,
    probeChatRunLiveness: unknownProbe,
  });
  assert.equal(staleRelease.ok, false);
  assert.equal(staleRelease.outcome, 'conflict');
  assert.equal(getTodoById(dataDir, cwd, staleTodo.id).status, 'doing');

  console.log('workspace-watcher-unknown-release: passed');
} finally {
  removeIsolatedDataDir();
}
