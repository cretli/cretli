import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-legacy-store.js';
import { addTodo, loadTodosData } from '../lib/persist/todos-legacy-adapter.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';

const workspace = ISOLATED_DATA_DIR;
const parent = addChat(randomUUID(), 'Phases coordinator', null, workspace, 'test', { sdkMode: 'agent' });
const client = createInProcessMcpClient({ chatId: parent.id, workspaceFolder: workspace, mode: 'agent' });
addTodo(ISOLATED_DATA_DIR, workspace, { title: 'MCP watcher_phases patch' });
const todoId = loadTodosData(ISOLATED_DATA_DIR, workspace).items[0].id;
const read = () => loadTodosData(ISOLATED_DATA_DIR, workspace).items.find((row) => row.id === todoId);

const before = read();
assert.equal(before.watcherPhases, undefined);
const updated = await client.updateTodo({ workspaceFolder: workspace, todoId, watcherPhases: { implement: false } });
assert.deepEqual(read().watcherPhases, { implement: false });
assert.deepEqual(updated.watcherPhases, { implement: false });
assert.notEqual(read().updatedAt, before.updatedAt);

await assert.rejects(
  client.updateTodo({ workspaceFolder: workspace, todoId, watcherPhases: { bogus: true } }),
  /unknown phase/,
);
assert.deepEqual(read().watcherPhases, { implement: false });

// An empty object clears the override.
await client.updateTodo({ workspaceFolder: workspace, todoId, watcherPhases: {} });
assert.equal(read().watcherPhases, undefined);
removeIsolatedDataDir();
console.log('mcp-update-todo-watcher-phases: all passed');
