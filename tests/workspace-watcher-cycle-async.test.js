import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { addTodo, getTodoById } from '../lib/persist/todos-persist.js';
import { createLegacyJsonTodosBackend, setTodosBackend } from '../lib/persist/todos-store.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { startWorkspaceWatcherCycle, stampCycleOrchestratorOnTodoTree } from '../lib/workspace-watcher-cycle.js';
import { acceptScoutFindings, recordScoutFindings } from '../lib/workspace-watcher-scout.js';

after(removeIsolatedDataDir);
let sequence = 0;
function fixture(policy = {}) {
  const workspaceFolder = `/example/async-cycle-${++sequence}`;
  const todo = addTodo(ISOLATED_DATA_DIR, workspaceFolder, { title: 'Ready leaf', status: 'ready' }).item;
  const watcher = upsertWorkspaceWatcher(workspaceFolder, {
    mode: 'autopilot', policy: { requirePlanApproval: false, cooldownMs: 0, ...policy },
  }, { dataDir: ISOLATED_DATA_DIR });
  return { workspaceFolder, todo, watcher };
}

// A second SQLite connection cannot acquire this mutex if the caller holds it.
function assertWatcherUnlocked() {
  const db = new DatabaseSync(path.join(ISOLATED_DATA_DIR, 'workspace-watchers.lock.sqlite'));
  try { db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK'); } finally { db.close(); }
}

test('start commits the reservation and ready claim before any orchestrator work', async () => {
  const f = fixture();
  const legacy = createLegacyJsonTodosBackend();
  let commands = 0;
  const previous = setTodosBackend({ ...legacy, async commitWatcherTodoCommand(...args) {
    assertWatcherUnlocked();
    await setImmediate();
    const result = legacy.commitWatcherTodoCommand(...args);
    if (result.ok) {
      commands += 1;
      const todo = getTodoById(ISOLATED_DATA_DIR, f.workspaceFolder, f.todo.id);
      const row = getWorkspaceWatcher(f.workspaceFolder, { dataDir: ISOLATED_DATA_DIR });
      assert.equal(todo.status, 'doing');
      assert.equal(todo.execution.cycleId, row.activeCycles[0].cycleId);
      assert.equal(todo.claimedByChatId, row.activeCycles[0].chatId);
      assert.equal(row.cycles.count, 1);
      assert.equal(Date.parse(todo.claimLeaseUntil) - Date.parse(todo.claimedAt), 30_000);
    }
    return result;
  } });
  try {
    const result = await startWorkspaceWatcherCycle({
      workspaceFolder: f.workspaceFolder, dataDir: ISOLATED_DATA_DIR,
      tick: { watcher: f.watcher, decision: { kind: 'start_cycle', nextTodoId: f.todo.id }, snapshot: { readyLeaves: [f.todo] } },
      deps: { resolveWorkspaceWatcherOrchestrator: async () => ({ ok: false, reason: 'test_stop' }) },
    });
    assert.equal(result.started, false);
    assert.equal(commands, 1);
  } finally { setTodosBackend(previous); }
});

test('a failed claim command leaves reservation, budget, lease and todo untouched', async () => {
  const f = fixture();
  const previous = setTodosBackend({ ...createLegacyJsonTodosBackend(), async commitWatcherTodoCommand() {
    assertWatcherUnlocked();
    await setImmediate();
    return { ok: false, reason: 'todo_conflict' };
  } });
  try {
    const result = await startWorkspaceWatcherCycle({
      workspaceFolder: f.workspaceFolder, dataDir: ISOLATED_DATA_DIR,
      tick: { watcher: f.watcher, decision: { kind: 'start_cycle', nextTodoId: f.todo.id }, snapshot: { readyLeaves: [f.todo] } },
    });
    assert.equal(result.reason, 'stale_todo');
    assert.deepEqual(getWorkspaceWatcher(f.workspaceFolder, { dataDir: ISOLATED_DATA_DIR }), f.watcher);
    assert.deepEqual(getTodoById(ISOLATED_DATA_DIR, f.workspaceFolder, f.todo.id), f.todo);
  } finally { setTodosBackend(previous); }
});

test('tree stamping and scout materialization await the facade outside the watcher mutex', async () => {
  const f = fixture({ scoutAutoCreate: true });
  const legacy = createLegacyJsonTodosBackend();
  let writes = 0;
  const backend = { ...legacy };
  for (const method of ['listTodos', 'addTodo', 'updateTodo']) {
    backend[method] = async (...args) => {
      assertWatcherUnlocked();
      await setImmediate();
      if (method !== 'listTodos') writes += 1;
      return legacy[method](...args);
    };
  }
  const previous = setTodosBackend(backend);
  try {
    await stampCycleOrchestratorOnTodoTree({ ...f, todoId: f.todo.id, chatId: 'test-orchestrator', dataDir: ISOLATED_DATA_DIR });
    assert.equal(getTodoById(ISOLATED_DATA_DIR, f.workspaceFolder, f.todo.id).orchestratorChatId, 'test-orchestrator');
    const recorded = await recordScoutFindings(f.workspaceFolder, [{ title: 'A separate finding', category: 'bug' }], { dataDir: ISOLATED_DATA_DIR });
    assert.equal(recorded.added, 1);
    const row = getWorkspaceWatcher(f.workspaceFolder, { dataDir: ISOLATED_DATA_DIR });
    assert.equal(row.pendingScoutFindings.length, 0);
    assert.ok(row.scoutFindingDecisions[0].todoId);
    assert.equal(writes, 3);
    const replay = await acceptScoutFindings(f.workspaceFolder, [row.scoutFindingDecisions[0].id], { dataDir: ISOLATED_DATA_DIR });
    assert.equal(replay.changed, 0);
    assert.equal(writes, 3);
  } finally { setTodosBackend(previous); }
});

test('Scout acceptance wins a concurrent reject before awaiting todo creation', async () => {
  const f = fixture({ scoutAutoCreate: false });
  await recordScoutFindings(f.workspaceFolder, [{ title: 'Concurrent acceptance', category: 'bug' }], { dataDir: ISOLATED_DATA_DIR });
  const row = getWorkspaceWatcher(f.workspaceFolder, { dataDir: ISOLATED_DATA_DIR });
  const id = row.pendingScoutFindings[0].id;
  upsertWorkspaceWatcher(f.workspaceFolder, { policy: { ...row.policy, scoutAutoCreate: true } }, { dataDir: ISOLATED_DATA_DIR });
  const legacy = createLegacyJsonTodosBackend();
  let signal;
  let resume;
  const entered = new Promise((resolve) => { signal = resolve; });
  const barrier = new Promise((resolve) => { resume = resolve; });
  const accepting = acceptScoutFindings(f.workspaceFolder, [id], {
    dataDir: ISOLATED_DATA_DIR,
    deps: { addTodo: async (...args) => { signal(); await barrier; return legacy.addTodo(...args); } },
  });
  await entered;
  const { rejectScoutFindings } = await import('../lib/workspace-watcher-scout.js');
  const rejected = await rejectScoutFindings(f.workspaceFolder, [id], { dataDir: ISOLATED_DATA_DIR });
  assert.equal(rejected.changed, 0);
  resume();
  const accepted = await accepting;
  assert.equal(accepted.changed, 1);
  assert.equal(accepted.findings[0].status, 'accepted');
  assert.ok(accepted.findings[0].todoId);
});

test('retry repairs an interrupted Scout draft without duplicating the idea', async () => {
  const f = fixture({ scoutAutoCreate: true });
  const legacy = createLegacyJsonTodosBackend();
  await recordScoutFindings(f.workspaceFolder, [{ title: 'Interrupted draft', category: 'bug' }], {
    dataDir: ISOLATED_DATA_DIR,
    deps: { updateTodo: async () => { throw new Error('test write failure'); } },
  });
  const row = getWorkspaceWatcher(f.workspaceFolder, { dataDir: ISOLATED_DATA_DIR });
  const finding = row.scoutFindingDecisions[0];
  assert.equal(finding.status, 'accepted');
  assert.equal(finding.todoId, undefined);
  const before = legacy.listTodos(ISOLATED_DATA_DIR, f.workspaceFolder).items;
  const result = await acceptScoutFindings(f.workspaceFolder, [finding.id], { dataDir: ISOLATED_DATA_DIR });
  const after = legacy.listTodos(ISOLATED_DATA_DIR, f.workspaceFolder).items;
  assert.equal(after.length, before.length);
  const linked = result.findings.find((item) => item.id === finding.id);
  assert.ok(linked.todoId);
  assert.ok(after.find((item) => item.id === linked.todoId).plan.markdown);
});
