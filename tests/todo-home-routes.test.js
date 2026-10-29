/**
 * Route-level behaviour of the todo home: secondary-folder requests hit the
 * workspace list, shared homes answer 409, MCP and agent callbacks agree.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSettings } from '../lib/persist/settings.js';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo, loadTodosData, normalizeExecutionFolder, resolveTodoExecutionFolder } from '../lib/persist/todos-legacy-adapter.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { resolveAgentCallbackTodoHome } from '../lib/routes/chat-agent-routes.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { findIntroducedSharedHomes } from '../lib/todo-home.js';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-home-'));
const dirs = Object.fromEntries(['a', 'b', 'c'].map((n) => {
  const dir = path.join(root, n);
  mkdirSync(dir);
  return [n, dir.replace(/\\/g, '/')];
}));
const WS1 = 'cretli:ws:11111111-1111-1111-1111-111111111111';
const WS2 = 'cretli:ws:22222222-2222-2222-2222-222222222222';
const registry = [{ id: WS1, kind: 'folders' }, { id: WS2, kind: 'folders' }];

function sidebar(ws2Folder) {
  return {
    [WS1]: { folder: dirs.a, folders: { [dirs.a]: {}, [dirs.b]: {} } },
    [WS2]: { folder: ws2Folder, folders: { [ws2Folder]: {} } },
  };
}

function makeApp() {
  const middlewares = [];
  const handlers = new Map();
  const app = {
    use(prefix, fn) { middlewares.push({ prefix, fn }); },
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerTodosRoutes(app, { dataDir, getCurrentCwd: () => root, getCurrentWorkspaceFile: () => '', agentModel: 'auto', getLocalCallbackBaseUrl: () => 'http://127.0.0.1:1', useHttps: false });
  return (method, urlPath, req = {}) => new Promise((resolve) => {
    const full = { params: {}, query: {}, body: {}, ...req };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    let i = 0;
    const matching = middlewares.filter((m) => '/api/todos'.startsWith(m.prefix) || m.prefix.startsWith('/api/todos'));
    const next = () => {
      const mw = matching[i++];
      if (mw) return mw.fn(full, res, next);
      return handlers.get(`${method} ${urlPath}`)(full, res);
    };
    next();
  });
}

test('a request from a secondary folder of the workspace reads the workspace list', async () => {
  saveSettings({ workspaces: registry, workspaceSidebarConfig: sidebar(dirs.c) });
  addTodo(dataDir, dirs.a, { title: 'Home todo' });
  const invoke = makeApp();
  const res = await invoke('GET', '/api/todos', { query: { workspaceFile: WS1, workspaceFolder: dirs.b } });
  assert.equal(res.status, 200);
  assert.equal(path.resolve(res.body.cwd), path.resolve(dirs.a));
  assert.equal(path.resolve(res.body.requestedFolder), path.resolve(dirs.b));
  assert.equal(res.body.workspaceId, WS1);
  assert.deepEqual(res.body.items.map((i) => i.title), ['Home todo']);
});

test('two workspaces sharing a home both answer 409 todo_home_shared', async () => {
  saveSettings({ workspaces: registry, workspaceSidebarConfig: sidebar(dirs.a) });
  const invoke = makeApp();
  for (const id of [WS1, WS2]) {
    const res = await invoke('GET', '/api/todos', { query: { workspaceFile: id } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'todo_home_shared');
  }
});

test('a pin that would create a shared home is reported, an existing one is not', () => {
  const ctx = { existsSet: new Set(Object.values(dirs)) };
  assert.deepEqual(findIntroducedSharedHomes(registry, sidebar(dirs.c), sidebar(dirs.a), ctx), [dirs.a]);
  assert.deepEqual(findIntroducedSharedHomes(registry, sidebar(dirs.a), sidebar(dirs.a), ctx), []);
});

test('MCP context and agent callbacks use the workspace home, not the chat folder', () => {
  saveSettings({ workspaces: registry, workspaceSidebarConfig: sidebar(dirs.c) });
  const chat = { id: 'chat-x', workspaceFile: WS1, workspaceFolder: dirs.b };
  const mcp = buildMcpRuntimeContext({ chat, room: {} });
  assert.equal(mcp.workspaceFolder, dirs.a);
  const stored = addChat('sess-home-1', 'Home chat', WS1, dirs.b);
  const chatId = stored?.id || loadChats().find((c) => c.cursorSessionId === 'sess-home-1')?.id;
  assert.equal(resolveAgentCallbackTodoHome({ chatId }, '/fallback'), dirs.a);
  assert.equal(resolveAgentCallbackTodoHome({}, '/fallback'), '/fallback');
});

test('execution folder: normalised, inherited, validated against workspace folders', async () => {
  assert.equal(normalizeExecutionFolder('relative/x'), '');
  assert.equal(normalizeExecutionFolder('/p/q/'), '/p/q');
  saveSettings({ workspaces: registry, workspaceSidebarConfig: sidebar(dirs.c) });
  const invoke = makeApp();
  const created = await invoke('POST', '/api/todos', {
    query: { workspaceFile: WS1 },
    body: { title: 'Root', workspaceFile: WS1, executionFolder: dirs.b },
  });
  assert.equal(created.status, 200);
  const root1 = loadTodosData(dataDir, dirs.a).items.find((i) => i.title === 'Root');
  assert.equal(root1.executionFolder, dirs.b);
  const child = addTodo(dataDir, dirs.a, { title: 'Child', parentId: root1.id }).item;
  assert.equal(resolveTodoExecutionFolder(loadTodosData(dataDir, dirs.a).items, child.id), dirs.b);
  const bad = await invoke('POST', '/api/todos', {
    query: { workspaceFile: WS1 },
    body: { title: 'Bad', workspaceFile: WS1, executionFolder: dirs.c },
  });
  assert.equal(bad.status, 400);
});
