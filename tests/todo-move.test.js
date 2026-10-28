/**
 * MCP `todo_move`: move a todo subtree to another workspace folder.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { addTodo, getTodoById, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools } from '../lib/mcp/mcp-policy.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import { writeFileSync } from 'node:fs';

const dataDir = resolveDataPath();
setBuiltinMcpRuntimeDeps({ dataDir });

/**
 * @param {string} prefix
 */
function createWorkspace(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} workspaceFolder
 */
function createHandlers(workspaceFolder) {
  const chat = addChat(`sess-${path.basename(workspaceFolder)}`, 'Move chat', null, workspaceFolder, 'model', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const client = createInProcessMcpClient({ harness: 'opencode', chatId: chat.id, workspaceFolder });
  const session = { chatId: chat.id, workspaceFolder, harness: 'opencode', mode: 'agent', builtinClient: client };
  return { chat, handlers: createCretliMcpToolHandlers(client, session) };
}

/**
 * @param {string} workspaceFolder
 */
function seedTree(workspaceFolder) {
  const root = addTodo(dataDir, workspaceFolder, { title: 'root', status: 'idea' }).item;
  const child = addTodo(dataDir, workspaceFolder, { title: 'child', parentId: root.id, status: 'idea', siblingIndex: 0 }).item;
  const other = addTodo(dataDir, workspaceFolder, { title: 'stays', status: 'idea' }).item;
  return { root, child, other };
}

test('todo_move is a mutating tool', () => {
  assert.ok(getBuiltinMcpMutatingTools().includes('todo_move'));
});

test('moves a fresh subtree to the target workspace and unlinks source chats', async () => {
  const source = createWorkspace('todo-move-src-');
  const target = createWorkspace('todo-move-dst-');
  const { chat, handlers } = createHandlers(source);
  const { root, child, other } = seedTree(source);
  updateChat(chat.id, { todoId: child.id });
  const actual = await handlers.todo_move({ todo_id: root.id, expected_updated_at: root.updatedAt, target_workspace_folder: target });
  assert.equal(actual.isError, false, actual.content?.[0]?.text);
  assert.deepEqual(new Set(actual.structuredContent.moved_ids), new Set([root.id, child.id]));
  assert.deepEqual(loadTodosData(dataDir, source).items.map((item) => item.id), [other.id]);
  const movedRoot = getTodoById(dataDir, target, root.id);
  assert.equal(movedRoot?.parentId || '', '');
  assert.match(movedRoot?.changelog?.at(-1)?.text || '', /moved from workspace/);
  assert.equal(getTodoById(dataDir, target, child.id)?.parentId, root.id);
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId ?? null, null);
});

test('refuses a tree with run history or a stale revision', async () => {
  const source = createWorkspace('todo-move-hist-src-');
  const target = createWorkspace('todo-move-hist-dst-');
  const { chat, handlers } = createHandlers(source);
  const { root, child } = seedTree(source);
  const stale = await handlers.todo_move({ todo_id: root.id, expected_updated_at: 'stale', target_workspace_folder: target });
  assert.equal(stale.isError, true);
  createDelegationRecord({
    parentChatId: chat.id,
    workspaceFolder: source,
    leafId: child.id,
    planRevision: 1,
    planMarkdown: 'plan',
    status: 'completed',
    executor: { transport: 'opencode', model: 'opencode/test' },
  });
  const actual = await handlers.todo_move({ todo_id: root.id, expected_updated_at: root.updatedAt, target_workspace_folder: target });
  assert.equal(actual.isError, true);
  assert.match(actual.content?.[0]?.text || '', /delegation/);
  assert.ok(getTodoById(dataDir, source, root.id));
  assert.equal(getTodoById(dataDir, target, root.id), null);
});

test('refuses a doing leaf and a relative target', async () => {
  const source = createWorkspace('todo-move-doing-src-');
  const target = createWorkspace('todo-move-doing-dst-');
  const { handlers } = createHandlers(source);
  const { root, child } = seedTree(source);
  const relative = await handlers.todo_move({ todo_id: root.id, expected_updated_at: root.updatedAt, target_workspace_folder: 'relative/dir' });
  assert.equal(relative.isError, true);
  updateTodo(dataDir, source, child.id, { status: 'doing' });
  const fresh = getTodoById(dataDir, source, root.id);
  const actual = await handlers.todo_move({ todo_id: root.id, expected_updated_at: fresh.updatedAt, target_workspace_folder: target });
  assert.equal(actual.isError, true);
  assert.match(actual.content?.[0]?.text || '', /status doing/);
});

test('a .code-workspace target resolves to its default folder, not its first folder', async () => {
  const source = createWorkspace('todo-move-ws-src-');
  const firstFolder = createWorkspace('todo-move-ws-first-');
  const defaultFolder = createWorkspace('todo-move-ws-default-');
  const workspaceFile = path.join(firstFolder, 'demo.code-workspace');
  writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: '.' }, { path: defaultFolder }] }));
  const settings = loadSettings();
  settings.workspaces = [...(settings.workspaces || []), { id: workspaceFile, kind: 'file', workspaceFile }];
  settings.workspaceSidebarConfig = {
    ...(settings.workspaceSidebarConfig || {}),
    [workspaceFile]: { folder: defaultFolder, folders: { [firstFolder]: { enabled: true }, [defaultFolder]: { enabled: true } } },
  };
  saveSettings(settings);
  const { handlers } = createHandlers(source);
  const { root } = seedTree(source);
  const actual = await handlers.todo_move({ todo_id: root.id, expected_updated_at: root.updatedAt, target_workspace_folder: workspaceFile });
  assert.equal(actual.isError, false, actual.content?.[0]?.text);
  assert.equal(actual.structuredContent.target_workspace_folder, defaultFolder);
  assert.ok(getTodoById(dataDir, defaultFolder, root.id));
  assert.equal(getTodoById(dataDir, firstFolder, root.id), null);
});

test('injected failure mid-move: source write failing leaves a duplicate, never a loss; target failing changes nothing', async () => {
  const { moveTodoTree } = await import('../lib/todo-move.js');
  const { saveTodosData } = await import('../lib/persist/todos-persist.js');
  const source = createWorkspace('todo-move-fail-src-');
  const target = createWorkspace('todo-move-fail-dst-');
  const { root, child } = seedTree(source);
  const input = { dataDir, sourceFolder: source, targetFolder: target, todoId: root.id, expectedUpdatedAt: root.updatedAt };

  // Failure while writing the TARGET (first write): nothing changes anywhere.
  assert.throws(() => moveTodoTree({ ...input, saveDoc: () => { throw new Error('boom-target'); } }), /boom-target/);
  assert.equal(getTodoById(dataDir, target, root.id), null);
  assert.ok(getTodoById(dataDir, source, root.id));

  // Failure while writing the SOURCE (second write): documented legacy behavior,
  // the subtree exists in both workspaces (duplicate, no loss).
  let calls = 0;
  const saveDoc = (dir, cwd, doc) => {
    calls += 1;
    if (calls === 2) throw new Error('boom-source');
    return saveTodosData(dir, cwd, doc);
  };
  assert.throws(() => moveTodoTree({ ...input, saveDoc }), /boom-source/);
  assert.ok(getTodoById(dataDir, target, root.id));
  assert.ok(getTodoById(dataDir, target, child.id));
  assert.ok(getTodoById(dataDir, source, root.id));
  assert.ok(getTodoById(dataDir, source, child.id));
});
