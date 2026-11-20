import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-waiting-plan-'));
process.env.CRETLI_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { describeWatcherTodoAttention, callExternalOperatorTool } = await import('../lib/mcp/mcp-external-operator-tools.js');
const { TODO_MCP_TOOLS } = await import('../lib/mcp/builtin/todo-tools.js');
const { addTodo, loadTodosData, saveTodosData } = await import('../lib/persist/todos-legacy-adapter.js');
const { upsertWorkspaceWatcher } = await import('../lib/persist/workspace-watchers-persist.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
setBuiltinMcpRuntimeDeps({ dataDir: dir });
const items = [
  { id: 'closed-00000001', title: 'Closed', status: 'ready', plan: { markdown: 'draft' } },
  { id: 'open-000000001', title: 'Open', status: 'ready', plan: { markdown: 'plan', approvedAt: '2026-11-01' } },
  { id: 'child-00000001', title: 'Child', status: 'ready', parentId: 'open-000000001' },
];
upsertWorkspaceWatcher('/tmp/my-app', { policy: { requirePlanApproval: true } }, { dataDir: dir });
const context = { client: { listTodos: async () => items }, session: { workspaceFolder: '/tmp/my-app' } };

test('todo_list and todo_show expose waiting_plan without rewriting ready; approved ancestor opens gate', async () => {
  const list = TODO_MCP_TOOLS.find((t) => t.name === 'todo_list');
  const show = TODO_MCP_TOOLS.find((t) => t.name === 'todo_show');
  const before = structuredClone(items);
  for (const compact of [false, true]) {
    const result = await list.handler({ status: 'ready', compact, ...(compact ? { fields: ['execution_state', 'status'] } : {}) }, context);
    assert.deepEqual(result.structuredContent.items.map((r) => r.execution_state), ['waiting_plan', 'ready', 'ready']);
    assert.match(result.content[0].text, /waiting_plan/);
  }
  for (const item of items) {
    const result = await show.handler({ todo_id: item.id }, context);
    assert.equal(result.structuredContent.item.execution_state, item === items[0] ? 'waiting_plan' : 'ready');
    assert.equal(result.structuredContent.item.plan_gate, item === items[0] ? 'closed' : 'open');
    assert.equal(result.structuredContent.item.status, 'ready');
  }
  assert.deepEqual(items, before);
});

test('waiting_plan follows the real gate: no policy, policy off, approved container body, approved ancestor', async () => {
  const { readTodoExecutionState } = await import('../lib/todo-tree.js');
  const tree = [
    { id: 'root', status: 'ready', title: 'Root', body: 'Container scope', plan: { markdown: 'p' } },
    { id: 'leaf', status: 'ready', title: 'Leaf', parentId: 'root' },
    { id: 'body', status: 'ready', title: 'Body container', body: 'Accepted container description' },
    { id: 'bodyleaf', status: 'ready', title: 'Body leaf', parentId: 'body' },
    { id: 'solo', status: 'ready', title: 'Solo, no plan anywhere' },
  ];
  const on = { requirePlanApproval: true };
  assert.equal(readTodoExecutionState(tree, tree[1], on), 'waiting_plan');
  assert.equal(readTodoExecutionState(tree, tree[1], { requirePlanApproval: false }), 'ready');
  assert.equal(readTodoExecutionState(tree, tree[1]), 'ready');
  assert.equal(readTodoExecutionState(tree, tree[3], on), 'ready');
  // The real gate (resolveWorkspaceWatcherPlanGateInputs) treats a plan-less leaf as gated, so does the read model.
  const { resolveWorkspaceWatcherPlanGateInputs } = await import('../lib/workspace-watcher-guardrails.js');
  for (const todo of [tree[1], tree[3], tree[4]]) {
    const gate = resolveWorkspaceWatcherPlanGateInputs({ watcher: { policy: on }, items: tree, todo });
    assert.equal(readTodoExecutionState(tree, todo, on) === 'waiting_plan', gate.gated && !gate.approvedAt, todo.id);
  }
  tree[0].plan.approvedAt = '2026-11-01';
  assert.equal(readTodoExecutionState(tree, tree[1], on), 'ready');
  assert.equal(readTodoExecutionState(tree, tree[0], on), 'ready');
});

test('operator diagnostic counts closed gates and stale doing, preserving active states', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const doing = { id: 'abandoned', status: 'doing', updatedAt: '2026-11-01T12:00:00Z' };
  const view = { snapshot: { doingStates: [{ todoId: 'abandoned', state: 'recoverable', reason: 'orphan_doing_idle' }] }, watcher: { policy: { requirePlanApproval: true } } };
  const result = describeWatcherTodoAttention(view, [...items, doing], now);
  assert.equal(result.ready_blocked_by_gate, 1);
  assert.equal(result.stale_doing, 1);
  assert.equal(result.doing_attention.length, 1);
  assert.equal(result.doing_attention[0].reason, 'stale_doing');
  assert.ok(result.doing_attention[0].suggested_action);
  assert.equal(doing.status, 'doing');
});

test('operator_watcher_status returns counters through its public tool', async () => {
  await addTodo(dir, dir, { title: 'Blocked by gate', status: 'ready' });
  await addTodo(dir, dir, { title: 'Approved', status: 'ready', plan: { markdown: 'plan', approvedAt: '2026-11-01' } });
  const stale = await addTodo(dir, dir, { title: 'Abandoned', status: 'doing' });
  const doc = await loadTodosData(dir, dir);
  doc.items.find((item) => item.title === 'Approved').plan = { markdown: 'plan', approvedAt: '2026-11-01' };
  const abandoned = doc.items.find((item) => item.id === stale.item.id);
  abandoned.createdAt = abandoned.updatedAt = '2026-01-01T00:00:00Z';
  await saveTodosData(dir, dir, doc);
  const result = await callExternalOperatorTool({ id: 'test', mode: 'operator', workspaceFolder: dir }, 'operator_watcher_status', {});
  assert.equal(result.isError, false, result.content[0].text);
  const out = JSON.parse(result.content[0].text);
  assert.equal(out.ready_blocked_by_gate, 1);
  assert.equal(out.stale_doing, 1);
  assert.equal(out.doing_attention.find((row) => row.todo_id === stale.item.id)?.reason, 'stale_doing');
  assert.equal((await loadTodosData(dir, dir)).items.find((row) => row.id === stale.item.id).status, 'doing');
});
