import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { subscribeChatListUpdates, __clearChatListUpdateClientsForTest } from '../lib/chat-list-updates.js';
import assert from 'node:assert/strict';
import { createLegacyJsonTodosBackend, setTodosBackend } from '../lib/persist/todos-store.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { persistTodoPlan, persistTodoImplementationSummary } from '../lib/todo-plan-sync.js';
import { updateLeafMaterialPartialPaths } from '../lib/todo-leaf-material.js';
import { syncTodoReviewTarget, clearTodoReviewSyncRetries, pendingTodoReviewSyncRetryCount } from '../lib/todo-review-sync-hooks.js';
import { buildTodoReviewSnapshot } from '../lib/todo-review-sync.js';
import { clearTodoReviewLiveChanges, pendingTodoReviewLiveChangeCount } from '../lib/todo-review-live.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

let sequence = 0;
function fixture(t, overrides = {}) {
  const cwd = `/example/l3c-${++sequence}`;
  const legacy = createLegacyJsonTodosBackend();
  const todo = addTodo(ISOLATED_DATA_DIR, cwd, { title: 'Leaf', status: 'doing' }).item;
  const previous = setTodosBackend({ ...legacy, ...overrides });
  t.after(() => { setTodosBackend(previous); clearTodoReviewSyncRetries(); clearTodoReviewLiveChanges(); });
  return { cwd, todo, legacy };
}

test('plan persistence waits for the backend commit and sends the read CAS revision', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const { cwd, todo, legacy } = fixture(t, {
    async updateTodo(dataDir, workspace, id, patch) {
      assert.equal(patch.expectedUpdatedAt, todo.updatedAt);
      entered.resolve();
      await gate.promise;
      return legacy.updateTodo(dataDir, workspace, id, patch);
    },
  });
  let settled = false;
  const pending = persistTodoPlan({ dataDir: ISOLATED_DATA_DIR, cwd, todoId: todo.id, chatId: '', planMarkdown: 'Plan' })
    .then((result) => { settled = true; return result; });
  await entered.promise;
  assert.equal(settled, false);
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).plan, undefined);
  gate.resolve();
  const saved = await pending;
  assert.equal(saved.items.find((row) => row.id === todo.id).plan.markdown, 'Plan');
});

test('a rejected plan commit rejects the caller and leaves the plan unchanged', async (t) => {
  const { cwd, todo } = fixture(t, {
    async updateTodo() { throw Object.assign(new Error('commit rejected'), { code: 'IO' }); },
  });
  await assert.rejects(persistTodoPlan({ dataDir: ISOLATED_DATA_DIR, cwd, todoId: todo.id, chatId: '', planMarkdown: 'Plan' }), { code: 'IO' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).plan, undefined);
});

test('summary RMW rejects a concurrent edit instead of marking the todo done', async (t) => {
  const { cwd, todo, legacy } = fixture(t, {
    async updateTodo(dataDir, workspace, id, patch) {
      updateTodo(dataDir, workspace, id, { title: 'Concurrent edit' });
      return legacy.updateTodo(dataDir, workspace, id, patch);
    },
  });
  await assert.rejects(persistTodoImplementationSummary({ dataDir: ISOLATED_DATA_DIR, cwd, todoId: todo.id, chatId: '', summaryText: 'Done', markDone: true }), { code: 'CONFLICT' });
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).status, 'doing');
});

test('review sync waits for its commit before emitting the change', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const { cwd, todo, legacy } = fixture(t, {
    async writeTodoReview(...args) {
      entered.resolve();
      await gate.promise;
      return legacy.writeTodoReview(...args);
    },
  });
  clearTodoReviewLiveChanges();
  const session = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {} });
  subscribeChatListUpdates(session, { kind: 'session' });
  t.after(() => __clearChatListUpdateClientsForTest());
  const pending = syncTodoReviewTarget({ dataDir: ISOLATED_DATA_DIR, workspaceFolder: cwd, todoId: todo.id });
  await entered.promise;
  assert.equal(pendingTodoReviewLiveChangeCount(), 0);
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).review, undefined);
  gate.resolve();
  assert.equal((await pending).changed, true);
  assert.equal(pendingTodoReviewLiveChangeCount(), 1);
});

test('review CAS rejects stale computation and queues a recomputation', async (t) => {
  const { cwd, todo } = fixture(t);
  const result = await syncTodoReviewTarget({ dataDir: ISOLATED_DATA_DIR, workspaceFolder: cwd, todoId: todo.id }, {
    deps: {
      async computeSnapshot() {
        updateTodo(ISOLATED_DATA_DIR, cwd, todo.id, { title: 'Concurrent edit' });
        return buildTodoReviewSnapshot({ leafId: todo.id, rows: [] });
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CONFLICT');
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).review, undefined);
  assert.equal(pendingTodoReviewSyncRetryCount(), 1);
});

test('partial material cleanup waits for the CAS mutation', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const { cwd, todo, legacy } = fixture(t, {
    async updateTodo(...args) {
      assert.ok(args[3].expectedUpdatedAt);
      entered.resolve();
      await gate.promise;
      return legacy.updateTodo(...args);
    },
  });
  updateTodo(ISOLATED_DATA_DIR, cwd, todo.id, {
    leafMaterial: { mode: 'project', baseCapturedAt: new Date().toISOString(), partialPaths: ['app.js'] },
  });
  let settled = false;
  const pending = updateLeafMaterialPartialPaths({
    dataDir: ISOLATED_DATA_DIR, workspaceFolder: cwd, leafId: todo.id, executionFolder: cwd,
    delegation: { assignment: 'implement', status: 'completed' },
  }).then(() => { settled = true; });
  await entered.promise;
  assert.equal(settled, false);
  assert.deepEqual(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).leafMaterial.partialPaths, ['app.js']);
  gate.resolve();
  await pending;
  assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).leafMaterial.partialPaths, undefined);
});

for (const channel of ['HTTP', 'MCP']) {
  test(`${channel} plan update waits for review persistence before returning success`, async (t) => {
    const gate = deferred();
    const entered = deferred();
    const { cwd, todo, legacy } = fixture(t, {
      async writeTodoReview(...args) {
        entered.resolve();
        await gate.promise;
        return legacy.writeTodoReview(...args);
      },
    });
    let settled = false;
    let pending;
    if (channel === 'MCP') {
      const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
      const client = createInProcessMcpClient({ workspaceFolder: cwd, mode: 'agent' });
      pending = client.updateTodo({ workspaceFolder: cwd, todoId: todo.id, plan: { markdown: 'Updated plan' } })
        .then((item) => { settled = true; return item; });
    } else {
      const { registerTodosRoutes } = await import('../lib/routes/todos-routes.js');
      const handlers = new Map();
      const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method, (route, handler) => handlers.set(`${method} ${route}`, handler)]));
      registerTodosRoutes(app, { dataDir: ISOLATED_DATA_DIR, getCurrentCwd: () => cwd });
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { settled = true; assert.equal(this.statusCode, 200, JSON.stringify(body)); return body; },
      };
      pending = handlers.get('patch /api/todos/:id')({ params: { id: todo.id }, query: {}, body: { plan: { markdown: 'Updated plan' } } }, res);
    }
    await entered.promise;
    assert.equal(settled, false);
    assert.equal(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).review, undefined);
    gate.resolve();
    await pending;
    assert.equal(settled, true);
    assert.ok(getTodoById(ISOLATED_DATA_DIR, cwd, todo.id).review);
  });
}
