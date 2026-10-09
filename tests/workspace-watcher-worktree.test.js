/**
 * Worktree execution mode for the Workspace Watcher.
 *
 * Every Git repository lives under os.tmpdir(); the real Cretli checkout is
 * never modified. Covered here: mode resolution, prepare/rollback semantics,
 * frozen worktrees and the watcher cycle start/rollback wiring.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { getWorktreeRecord } from '../lib/persist/worktree-registry-persist.js';
import { startWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { resolveWorktreeMode } from '../lib/worktree/worktree-mode.js';
import { WORKTREE_ERROR_CODES, WorktreeError } from '../lib/worktree/worktree-errors.js';
import {
  prepareWorkspaceWatcherExecution,
  resolveWorkspaceWatcherExecutionMode,
} from '../lib/workspace-watcher-worktree.js';
import { createTempRepo, git, tempDir, worktreeConfig } from './helpers/temp-git-repo.js';

const T0 = Date.parse('2026-05-01T10:00:00.000Z');

/**
 * @param {string} name
 * @returns {{ dataDir: string, baseDir: string, repo: string, cleanup: () => void }}
 */
function makeSuite(name) {
  const dataDir = tempDir(`cretli-wtw-data-${name}-`);
  const baseDir = tempDir(`cretli-wtw-base-${name}-`);
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
 * @param {string} cwd
 * @param {string} title
 * @param {object} [extra]
 * @returns {object}
 */
function addReadyTodo(dataDir, cwd, title, extra = {}) {
  return addTodo(dataDir, cwd, { title, status: 'ready', ...extra }).item;
}

test('mode resolution: leaf override wins, inherit falls back to the policy default', () => {
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'worktree', policyDefault: 'project' }), { mode: 'worktree', source: 'leaf' });
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'project', policyDefault: 'worktree' }), { mode: 'project', source: 'leaf' });
  assert.deepEqual(resolveWorktreeMode({ leafMode: 'inherit', policyDefault: 'worktree' }), { mode: 'worktree', source: 'policy' });
  assert.deepEqual(resolveWorktreeMode({}), { mode: 'project', source: 'policy' });
  assert.throws(
    () => resolveWorktreeMode({ leafMode: 'elsewhere', policyDefault: 'project' }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.MODE_INVALID,
    'an unknown leaf mode is fail-closed',
  );
  assert.throws(
    () => resolveWorktreeMode({ policyDefault: 'elsewhere' }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.MODE_INVALID,
  );
});

test('resolveWorkspaceWatcherExecutionMode reads the todo override and policy default', () => {
  assert.equal(resolveWorkspaceWatcherExecutionMode({ todo: { executionMode: 'worktree' }, policy: {} }).mode, 'worktree');
  assert.equal(resolveWorkspaceWatcherExecutionMode({ todo: {}, policy: { executionMode: 'worktree' } }).mode, 'worktree');
  assert.equal(resolveWorkspaceWatcherExecutionMode({ todo: {}, policy: {} }).mode, 'project');
});

test('project mode keeps the logical workspace and creates nothing', async (t) => {
  const suite = makeSuite('project');
  t.after(suite.cleanup);
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    workspaceFolder: suite.repo,
    todo: {},
    policy: {},
    dataDir: suite.dataDir,
  });
  assert.equal(prepared.mode, 'project');
  assert.equal(prepared.executionFolder, suite.repo);
  assert.equal(prepared.record, null);
  assert.equal(getWorktreeRecord('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { dataDir: suite.dataDir }), null);
});

test('plan-only cycles do not create a worktree directory', async (t) => {
  const suite = makeSuite('planonly');
  t.after(suite.cleanup);
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) },
    dataDir: suite.dataDir,
    planOnly: true,
  });
  assert.equal(prepared.mode, 'project');
  assert.equal(prepared.executionFolder, suite.repo);
  assert.equal(getWorktreeRecord('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { dataDir: suite.dataDir }), null);
  assert.deepEqual(fs.readdirSync(path.join(suite.baseDir, 'worktrees')), [], 'no directory is created for a plan-only cycle');
});

test('worktree prepare creates the worktree, runs the prepare action and marks it active', async (t) => {
  const suite = makeSuite('prepare');
  t.after(suite.cleanup);
  const todoId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: {
      executionMode: 'worktree',
      worktree: {
        ...worktreeConfig(suite.baseDir),
        prepareCommand: [process.execPath, '-e', "require('fs').writeFileSync('prepared.txt','ok')"],
      },
    },
    dataDir: suite.dataDir,
    cycleId: 'cycle-1',
    chatId: 'chat-1',
  });
  assert.equal(prepared.mode, 'worktree');
  assert.equal(prepared.executionFolder, prepared.record.worktreePath);
  assert.equal(fs.readFileSync(path.join(prepared.record.worktreePath, 'prepared.txt'), 'utf8'), 'ok');
  const record = getWorktreeRecord(todoId, { dataDir: suite.dataDir });
  assert.equal(record.executionState, 'active');
  assert.deepEqual(record.chats, ['chat-1']);
  assert.deepEqual(record.cycles, ['cycle-1']);
});

test('a failed prepare rolls the record back to none, preserves the worktree and refuses to fall back', async (t) => {
  const suite = makeSuite('prep-fail');
  t.after(suite.cleanup);
  const todoId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId,
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy: {
        executionMode: 'worktree',
        worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: [process.execPath, '-e', 'process.exit(7)'] },
      },
      dataDir: suite.dataDir,
      cycleId: 'cycle-fail',
      chatId: 'chat-fail',
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.PREPARE_FAILED,
  );
  const record = getWorktreeRecord(todoId, { dataDir: suite.dataDir });
  assert.ok(record, 'the reserved worktree record stays inspectable');
  assert.equal(record.executionState, 'none');
  assert.equal(fs.existsSync(record.worktreePath), true, 'the worktree is preserved, never force-removed');
  assert.equal(fs.existsSync(path.join(record.worktreePath, 'prepared.txt')), false);
});

test('worktree mode blocks a dirty logical tree and writes no record', async (t) => {
  const suite = makeSuite('dirty');
  t.after(suite.cleanup);
  fs.writeFileSync(path.join(suite.repo, 'dirty.txt'), 'uncommitted\n');
  const todoId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId,
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy: { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) },
      dataDir: suite.dataDir,
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.DIRTY,
  );
  assert.equal(getWorktreeRecord(todoId, { dataDir: suite.dataDir }), null);
});

test('an existing worktree is frozen against a changing override or policy', async (t) => {
  const suite = makeSuite('frozen');
  t.after(suite.cleanup);
  const todoId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const first = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'worktree' },
    policy: { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) },
    dataDir: suite.dataDir,
  });
  // The leaf override now says project, but the frozen record still wins.
  const second = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: suite.repo,
    todo: { executionMode: 'project' },
    policy: { executionMode: 'project' },
    dataDir: suite.dataDir,
  });
  assert.equal(second.mode, 'worktree');
  assert.equal(second.frozen, true);
  assert.equal(second.executionFolder, first.executionFolder);
});

test('two independent todos prepare two distinct worktrees', async (t) => {
  const suite = makeSuite('parallel');
  t.after(suite.cleanup);
  const policy = { executionMode: 'worktree', worktree: worktreeConfig(suite.baseDir) };
  const [a, b] = await Promise.all([
    prepareWorkspaceWatcherExecution({
      todoId: '11111111-1111-1111-1111-111111111111',
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy,
      dataDir: suite.dataDir,
    }),
    prepareWorkspaceWatcherExecution({
      todoId: '22222222-2222-2222-2222-222222222222',
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy,
      dataDir: suite.dataDir,
    }),
  ]);
  assert.notEqual(a.executionFolder, b.executionFolder);
  assert.equal(fs.existsSync(a.executionFolder), true);
  assert.equal(fs.existsSync(b.executionFolder), true);
});

test('a shell-string prepare command is refused fail-closed', async (t) => {
  const suite = makeSuite('string-prepare');
  t.after(suite.cleanup);
  const todoId = '88888888-8888-8888-8888-888888888888';
  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId,
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy: {
        executionMode: 'worktree',
        worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: 'npm ci' },
      },
      dataDir: suite.dataDir,
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
  const record = getWorktreeRecord(todoId, { dataDir: suite.dataDir });
  assert.equal(record.executionState, 'none', 'the worktree record is rolled back, nothing runs');
});

test('worktree mode without a layout fails closed instead of using the project folder', async (t) => {
  const suite = makeSuite('no-layout');
  t.after(suite.cleanup);
  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId: '99999999-9999-9999-9999-999999999999',
      workspaceFolder: suite.repo,
      todo: { executionMode: 'worktree' },
      policy: { executionMode: 'worktree' },
      dataDir: suite.dataDir,
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
});

test('allowSuggestedLayout derives the workspace suggestion, persists it and prepares the worktree', async (t) => {
  const suite = makeSuite('autoderive');
  t.after(suite.cleanup);
  // The repo sits inside its own parent so the suggested root is cleaned up and
  // never lands in the shared os.tmpdir().
  const parent = tempDir('cretli-wtw-autoderive-');
  const repo = path.join(parent, 'my-app');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}\n');
  git(repo, ['add', 'package-lock.json']);
  git(repo, ['commit', '-qm', 'init']);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const todoId = 'abababab-abab-abab-abab-abababababab';
  const prepared = await prepareWorkspaceWatcherExecution({
    todoId,
    workspaceFolder: repo,
    todo: { executionMode: 'worktree' },
    policy: {
      executionMode: 'project',
      worktree: { root: '', namespace: '', branchPrefix: '', directoryPrefix: '', prepareCommand: [] },
    },
    dataDir: suite.dataDir,
    allowSuggestedLayout: true,
  });

  const expectedRoot = path.join(parent, '.cretli-worktrees');
  assert.equal(prepared.mode, 'worktree');
  assert.equal(
    prepared.executionFolder,
    path.join(expectedRoot, 'my-app', `t-${todoId}`),
  );
  // Persisted so the settings panel and every later start agree on the layout.
  const row = getWorkspaceWatcher(repo, { dataDir: suite.dataDir });
  assert.equal(row.policy.worktree.root, expectedRoot);
  assert.equal(row.policy.worktree.namespace, 'my-app');
  assert.equal(row.policy.worktree.branchPrefix, 'my-app/todo/');
  assert.equal(row.policy.worktree.directoryPrefix, 't-');
  // The layout is derived; running an install stays the operator's decision.
  assert.deepEqual(row.policy.worktree.prepareCommand, []);
});

test('allowSuggestedLayout still fails closed when the workspace is not a Git repository', async (t) => {
  const suite = makeSuite('autoderive-nogit');
  t.after(suite.cleanup);
  const plain = tempDir('cretli-wtw-nogit-');
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));

  await assert.rejects(
    () => prepareWorkspaceWatcherExecution({
      todoId: 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd',
      workspaceFolder: plain,
      todo: { executionMode: 'worktree' },
      policy: {
        executionMode: 'worktree',
        worktree: { root: '', namespace: '', branchPrefix: '', directoryPrefix: '', prepareCommand: [] },
      },
      dataDir: suite.dataDir,
      allowSuggestedLayout: true,
    }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_ERROR_CODES.CONFIG_INVALID,
  );
  const row = getWorkspaceWatcher(plain, { dataDir: suite.dataDir });
  assert.equal(row?.policy?.worktree?.root ?? '', '', 'a non-Git workspace keeps an empty layout');
});

test('startWorkspaceWatcherCycle: maxParallel=2 starts two worktree cycles with distinct execution folders', async (t) => {
  const suite = makeSuite('cycle-two');
  t.after(suite.cleanup);
  const first = addReadyTodo(suite.dataDir, suite.repo, 'worktree one', { executionMode: 'worktree' });
  const second = addReadyTodo(suite.dataDir, suite.repo, 'worktree two', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 5,
      maxParallel: 2,
      executionMode: 'worktree',
      worktree: worktreeConfig(suite.baseDir),
    },
  }, { dataDir: suite.dataDir });
  const executionFolders = [];
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      executionFolders.push(String(extras.executionFolder || ''));
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: 'run-1', accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether a worktree-preparation test can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const tick = (todo) => ({
    watcher: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt, title: todo.title }] },
  });
  const leaseToken = 'worktree-lease';
  const firstStart = await startWorkspaceWatcherCycle({ workspaceFolder: suite.repo, dataDir: suite.dataDir, now: T0, tick: tick(first), token: leaseToken, deps });
  assert.equal(firstStart.started, true, JSON.stringify(firstStart));
  const secondStart = await startWorkspaceWatcherCycle({ workspaceFolder: suite.repo, dataDir: suite.dataDir, now: T0 + 1000, tick: tick(second), token: leaseToken, deps });
  assert.equal(secondStart.started, true, JSON.stringify(secondStart));
  assert.equal(executionFolders.length, 2);
  assert.notEqual(executionFolders[0], executionFolders[1]);
  assert.notEqual(executionFolders[0], suite.repo);
  assert.equal(getWorktreeRecord(first.id, { dataDir: suite.dataDir }).executionState, 'active');
  assert.equal(getWorktreeRecord(second.id, { dataDir: suite.dataDir }).executionState, 'active');
});

test('startWorkspaceWatcherCycle: a prepare failure releases the claim, keeps the worktree and never starts in project mode', async (t) => {
  const suite = makeSuite('cycle-fail');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'doomed worktree', { executionMode: 'worktree' });
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 5,
      executionMode: 'worktree',
      worktree: { ...worktreeConfig(suite.baseDir), prepareCommand: [process.execPath, '-e', 'process.exit(9)'] },
    },
  }, { dataDir: suite.dataDir });
  let chatCreated = false;
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      chatCreated = true;
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: 'run-should-not-happen', accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether a worktree-preparation test can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: suite.repo, dataDir: suite.dataDir, now: T0, tick, token: 'fail-lease', deps });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'worktree_prepare_failed');
  assert.equal(chatCreated, false, 'no orchestrator chat is created in project mode');
  const row = getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir });
  assert.equal(row.activeCycles.length, 0);
  const reloaded = getTodoById(suite.dataDir, suite.repo, todo.id);
  assert.equal(reloaded.status, 'ready');
  assert.equal(reloaded.claimedByChatId, undefined);
  const record = getWorktreeRecord(todo.id, { dataDir: suite.dataDir });
  assert.ok(record, 'the worktree is preserved for inspection');
  assert.equal(record.executionState, 'none');
  assert.equal(fs.existsSync(record.worktreePath), true);
  assert.ok(row.decisions.some((decision) => decision.kind === 'worktree_prepare_failed'));
});

test('startWorkspaceWatcherCycle: a dirty tree refuses worktree mode before any chat', async (t) => {
  const suite = makeSuite('cycle-dirty');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'dirty start', { executionMode: 'worktree' });
  fs.writeFileSync(path.join(suite.repo, 'uncommitted.txt'), 'x\n');
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 5,
      executionMode: 'worktree',
      worktree: worktreeConfig(suite.baseDir),
    },
  }, { dataDir: suite.dataDir });
  let chatCreated = false;
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      chatCreated = true;
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: 'run-should-not-happen', accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether a worktree-preparation test can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: suite.repo, dataDir: suite.dataDir, now: T0, tick, token: 'dirty-lease', deps });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'worktree_prepare_failed');
  assert.equal(started.error.code, WORKTREE_ERROR_CODES.DIRTY);
  assert.equal(chatCreated, false);
  assert.equal(getTodoById(suite.dataDir, suite.repo, todo.id).status, 'ready');
  assert.equal(getWorktreeRecord(todo.id, { dataDir: suite.dataDir }), null);
  const row = getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir });
  assert.equal(Number(row.failures?.[todo.id] || 0), 0, 'a dirty-tree preflight block does not count toward the failure ceiling');
});

test('a per-leaf project override beats a worktree policy default', async (t) => {
  const suite = makeSuite('leaf-project');
  t.after(suite.cleanup);
  const todo = addReadyTodo(suite.dataDir, suite.repo, 'project leaf', { executionMode: 'project' });
  upsertWorkspaceWatcher(suite.repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 5,
      executionMode: 'worktree',
      worktree: worktreeConfig(suite.baseDir),
    },
  }, { dataDir: suite.dataDir });
  const executionFolders = [];
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => {
      executionFolders.push(String(extras.executionFolder || ''));
      return { id: extras.id, title };
    },
    startChatRun: async () => ({ runId: 'run-project', accepted: true }),
    // Deterministic orchestrator seam: the ambient harness catalog / usage
    // ledger must not decide whether a worktree-preparation test can start.
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
  };
  const tick = {
    watcher: getWorkspaceWatcher(suite.repo, { dataDir: suite.dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(suite.dataDir, suite.repo, todo.id).updatedAt, title: todo.title }] },
  };
  const started = await startWorkspaceWatcherCycle({ workspaceFolder: suite.repo, dataDir: suite.dataDir, now: T0, tick, token: 'leaf-project', deps });
  assert.equal(started.started, true, JSON.stringify(started));
  assert.equal(executionFolders.length, 1);
  assert.equal(executionFolders[0], '', 'project mode leaves the default workspace cwd in place');
  assert.equal(getWorktreeRecord(todo.id, { dataDir: suite.dataDir }), null);
});
