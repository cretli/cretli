import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-scope-accept-'));
process.env.CRETLI_DATA_DIR = dataDir;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-operator-scope-accept-ws-'));
const { addTodo, listTodos } = await import('../lib/persist/todos-store.js');
const { callExternalOperatorTool, EXTERNAL_OPERATOR_TOOLS } = await import('../lib/mcp/mcp-external-operator-tools.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { getWorkspaceWatcher, upsertWorkspaceWatcher } = await import('../lib/persist/workspace-watchers-persist.js');
const { storeWorkspaceWatcherScopeRequest } = await import('../lib/workspace-watcher-cycle-close.js');
const { collectTodoLeafScopePaths, parseScopeRequest } = await import('../lib/todo-parallel-scope.js');
const { readOperatorPlaybook } = await import('../lib/mcp/mcp-external-guide.js');
setBuiltinMcpRuntimeDeps({ dataDir });
after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const client = { id: 'operator-test', name: 'Test operator', mode: 'operator', workspaceFolder: workspace };
const BODY = 'Leaf.\n\n## Leaf scope\n- `lib/a.js`\n';

async function call(name, args) {
  const response = await callExternalOperatorTool(client, name, args);
  return { isError: response.isError, text: response.content[0].text };
}
async function leaf(status = 'idea') {
  return (await addTodo(dataDir, workspace, { title: 'Leaf', status, body: BODY })).item;
}
async function read(id) {
  return (await listTodos(dataDir, workspace)).items.find((row) => row.id === id);
}

test('operator_scope_accept is registered with its schema and documented in the playbook', () => {
  const tool = EXTERNAL_OPERATOR_TOOLS.find((row) => row.name === 'operator_scope_accept');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['todo_id']);
  assert.match(readOperatorPlaybook(workspace), /operator_scope_accept/);
});

test('accepting a proposal widens Leaf scope, clears backoff and re-opens the parked leaf', async () => {
  const todo = await leaf('idea');
  await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: workspace, todoId: todo.id, files: ['lib/b.js', 'lib/c.js'], reason: 'needs b and c' });
  upsertWorkspaceWatcher(workspace, {
    mode: 'observe',
    blockedBackoff: { [todo.id]: { count: 1, until: '2099-01-01T00:00:00.000Z' } },
    failures: { [todo.id]: 1 },
  }, { dataDir });

  const result = await call('operator_scope_accept', { todo_id: todo.id.slice(0, 8), files: ['lib/b.js'] });
  assert.equal(result.isError, false, result.text);
  const out = JSON.parse(result.text);
  assert.deepEqual(out.accepted, ['lib/b.js']);
  assert.deepEqual(out.remaining, ['lib/c.js']);
  assert.equal(out.status, 'ready');

  const saved = await read(todo.id);
  assert.deepEqual(collectTodoLeafScopePaths(saved), ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(parseScopeRequest(saved.body)?.files, ['lib/c.js']);
  assert.ok(saved.changelog.some((entry) => entry.text.includes('Scope request accepted by external MCP client "Test operator"')));
  const row = getWorkspaceWatcher(workspace, { dataDir });
  assert.equal(row.blockedBackoff[todo.id], undefined);
  assert.equal(row.failures[todo.id], undefined);

  const rest = JSON.parse((await call('operator_scope_accept', { todo_id: todo.id })).text);
  assert.deepEqual(rest.accepted, ['lib/c.js']);
  assert.equal(parseScopeRequest((await read(todo.id)).body), null);
});

test('refusals: no open proposal, foreign file, stale CAS, non-operator client', async () => {
  const todo = await leaf('ready');
  const none = await call('operator_scope_accept', { todo_id: todo.id });
  assert.equal(none.isError, true);
  assert.match(none.text, /^NOT_FOUND:/);

  await storeWorkspaceWatcherScopeRequest({ dataDir, workspaceFolder: workspace, todoId: todo.id, files: ['lib/b.js'], reason: 'r' });
  const before = await read(todo.id);
  const foreign = await call('operator_scope_accept', { todo_id: todo.id, files: ['lib/other.js'] });
  assert.match(foreign.text, /^VALIDATION_ERROR:/);
  const stale = await call('operator_scope_accept', { todo_id: todo.id, expected_updated_at: 'stale' });
  assert.match(stale.text, /^CONFLICT:/);
  assert.equal((await read(todo.id)).body, before.body);

  const agent = await callExternalOperatorTool({ ...client, mode: 'agent' }, 'operator_scope_accept', { todo_id: todo.id });
  assert.equal(agent.isError, true);
  assert.match(agent.content[0].text, /^FORBIDDEN/);
});
