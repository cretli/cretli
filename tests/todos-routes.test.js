/**
 * Route tests for POST /api/todos/:id/start-agent.
 *
 * Uses the isolated data dir helper (see its header) and a temp cwd so no
 * live project data is touched. Registering the routes on a tiny fake express
 * app keeps the test free of HTTP and auth.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, linkTodoChat, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Promise<void>[]} */
const pending = [];

function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => console.log('OK:', name), (err) => fail(name, err)));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    fail(name, err);
  }
}

function fail(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-routes-'));
const dataDir = path.join(cwd, 'data');
const workspaceFile = path.join(cwd, 'proj.code-workspace');

/**
 * @returns {{ invoke: (method: string, urlPath: string, req?: object) => Promise<{status: number, body: object}> }}
 */
function makeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) {
      handlers.set(`GET ${p}`, fn);
    },
    post(p, fn) {
      handlers.set(`POST ${p}`, fn);
    },
    patch(p, fn) {
      handlers.set(`PATCH ${p}`, fn);
    },
    delete(p, fn) {
      handlers.set(`DELETE ${p}`, fn);
    },
  };
  registerTodosRoutes(app, {
    dataDir,
    getCurrentCwd: () => cwd,
    getCurrentWorkspaceFile: () => workspaceFile,
    agentModel: 'auto',
    getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999',
    useHttps: false,
  });
  const invoke = (method, urlPath, req = {}) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    if (!fn) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, body });
        },
      };
      fn({ params: {}, query: {}, body: {}, ...req }, res);
    });
  };
  return { invoke };
}

/** @param {(invoke: Function) => Promise<void>} fn */
function withApp(fn) {
  return () => fn(makeApp().invoke);
}

runCase(
  'parent start-agent starts an orchestrator in agent mode and delegates the entire subtree',
  withApp(async (invoke) => {
    const parent = addTodo(dataDir, cwd, { title: 'Execute the tree', status: 'ready' }).item;
    const first = addTodo(dataDir, cwd, { title: 'First step', parentId: parent.id, status: 'ready' }).item;
    addTodo(dataDir, cwd, { title: 'Second step', parentId: parent.id, status: 'ready' });
    const started = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: parent.id },
      body: { agentTransport: 'claude', workspaceFolder: cwd, workspaceFile },
    });
    assert.equal(started.body.ok, true);
    assert.equal(started.body.chat.sdkMode, 'agent');
    assert.equal(started.body.todo.orchestratorChatId, started.body.chat.id);
    assert.match(started.body.initialPrompt, /entire subtree/);
    assert.match(started.body.initialPrompt, /assignment=implement/);
    assert.match(started.body.initialPrompt, /assignment=review/);
    assert.match(started.body.initialPrompt, /Continue automatically/);
    assert.doesNotMatch(started.body.initialPrompt, /Start by preparing a plan/);
    assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === first.id).status, 'ready');
  })
);

runCase(
  'start-agent without forceNew creates once and then reuses the chat',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Reuse me', status: 'ready' });
    const id = created.item.id;
    const first = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(first.body.ok, true);
    assert.equal(first.body.reused, false);
    const chatId = first.body.chat.id;
    assert.equal(first.body.todo.chatId, chatId);
    assert.equal(first.body.todo.status, 'doing');

    const second = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.reused, true);
    assert.equal(second.body.chat.id, chatId);
  })
);

runCase(
  'start-agent forceNew creates a fresh chat and keeps the old one linked',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Fork me', status: 'ready' });
    const id = created.item.id;
    const first = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    const firstChatId = first.body.chat.id;

    const second = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.reused, false);
    assert.equal(second.body.forceNew, true);
    const secondChatId = second.body.chat.id;
    assert.notEqual(secondChatId, firstChatId);

    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
    assert.equal(item.chatId, secondChatId);
    assert.ok(item.linkedChatIds.includes(firstChatId));
    assert.ok(item.linkedChatIds.includes(secondChatId));

    const listed = await invoke('GET', '/api/todos', { query: { workspaceFolder: cwd } });
    const listedItem = listed.body.items.find((row) => row.id === id);
    const chatIds = listedItem.chats.map((chat) => chat.id);
    assert.ok(chatIds.includes(firstChatId), 'old chat stays in chats[]');
    assert.ok(chatIds.includes(secondChatId), 'new chat is in chats[]');

    // The fresh prompt points at the todo ref and the previous chat.
    assert.match(second.body.initialPrompt, /cretli-ref todo=/);
    assert.match(second.body.initialPrompt, new RegExp(firstChatId));
    assert.match(second.body.initialPrompt, /chat_show/);
  })
);

runCase(
  'start-agent forceNew on a done todo does not reopen it',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Finished', status: 'doing' });
    const id = created.item.id;
    const first = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(first.body.ok, true);
    updateTodo(dataDir, cwd, id, { status: 'done' });

    const second = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.todo.status, 'done');
  })
);

runCase(
  'start-agent agentTransport/assignee/sourceHarness precedence',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, {
      title: 'Harness',
      status: 'ready',
      assignee: { harness: 'deepseek', role: 'implement' },
      sourceHarness: 'qwen',
    });
    const id = created.item.id;
    const fromBody = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(fromBody.body.chat.agentTransport, 'claude');

    const created2 = addTodo(dataDir, cwd, {
      title: 'Harness 2',
      status: 'ready',
      assignee: { harness: 'deepseek', role: 'implement' },
      sourceHarness: 'qwen',
    });
    const fromAssignee = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created2.item.id },
      body: { workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(fromAssignee.body.chat.agentTransport, 'deepseek');
  })
);

runCase(
  'start-agent forceNew prompt omits chats from another workspace',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Foreign chat', status: 'ready' });
    const id = created.item.id;
    const foreignFolder = path.join(cwd, 'other-ws');
    const foreignChat = addChat(
      randomUUID(),
      'Foreign workspace chat',
      path.join(cwd, 'other.code-workspace'),
      foreignFolder,
      undefined,
      { agentTransport: 'claude', todoId: id }
    );
    linkTodoChat(dataDir, cwd, id, foreignChat.id);

    const result = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(result.body.ok, true);
    assert.equal(
      result.body.initialPrompt.includes(foreignChat.id),
      false,
      'foreign chat id must not leak into the prompt'
    );
    assert.equal(
      result.body.initialPrompt.includes('Foreign workspace chat'),
      false,
      'foreign chat title must not leak into the prompt'
    );
  })
);

runCase(
  'start-agent forceNew drops a chatId that points to a deleted chat',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Ghost chat', status: 'ready' });
    const id = created.item.id;
    const ghostId = randomUUID();
    updateTodo(dataDir, cwd, id, { chatId: ghostId });

    const result = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(result.body.ok, true);
    assert.equal(
      result.body.initialPrompt.includes(ghostId),
      false,
      'missing chat must not appear in the prompt'
    );
    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
    assert.equal(item.chatId, result.body.chat.id);
    assert.equal(
      (item.linkedChatIds || []).includes(ghostId),
      false,
      'missing chat must not be linked'
    );
    assert.equal((item.linkedChatIds || []).includes(result.body.chat.id), true);
  })
);

runCase(
  'start-agent forceNew moves an idea/ready todo to doing',
  withApp(async (invoke) => {
    for (const status of ['idea', 'ready']) {
      const created = addTodo(dataDir, cwd, { title: `Force ${status}`, status });
      const id = created.item.id;
      const result = await invoke('POST', '/api/todos/:id/start-agent', {
        params: { id },
        body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
      });
      assert.equal(result.body.ok, true);
      assert.equal(result.body.forceNew, true);
      assert.equal(result.body.todo.status, 'doing', `${status} must move to doing`);
    }
  })
);

runCase('tree API: reject premature completion and later starts, roll up parents and reopen ancestors', withApp(async (invoke) => {
  const root = addTodo(dataDir, cwd, { title: 'Sequential tree', status: 'ready' }).item;
  const first = addTodo(dataDir, cwd, { title: 'First branch', status: 'ready', parentId: root.id }).item;
  const leaf = addTodo(dataDir, cwd, { title: 'First leaf', status: 'ready', parentId: first.id }).item;
  const last = addTodo(dataDir, cwd, { title: 'Last branch', status: 'ready', parentId: root.id }).item;
  const patch = (id, status) => invoke('PATCH', '/api/todos/:id', { params: { id }, body: { status } });
  assert.equal((await patch(root.id, 'done')).status, 400);
  assert.equal((await patch(last.id, 'doing')).status, 400);
  const blocked = await invoke('POST', '/api/todos/:id/start-agent', { params: { id: last.id } });
  assert.equal(blocked.status, 409);
  assert.equal(getItem(last.id).chatId, undefined, 'denial must not create a chat');
  assert.equal((await patch(leaf.id, 'done')).status, 200);
  assert.equal(getItem(first.id).status, 'done');
  assert.equal(getItem(root.id).status, 'doing');
  const started = await invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: last.id }, body: { agentTransport: 'claude' },
  });
  assert.equal(started.status, 200);
  assert.equal((await patch(last.id, 'done')).status, 200);
  assert.equal(getItem(root.id).status, 'done');
  assert.equal((await patch(leaf.id, 'ready')).status, 200);
  assert.equal(getItem(first.id).status, 'ready');
  assert.equal(getItem(root.id).status, 'doing');
  function getItem(id) { return loadTodosData(dataDir, cwd).items.find((row) => row.id === id); }
}));

Promise.all(pending).then(() => {
  rmSync(cwd, { recursive: true, force: true });
  removeIsolatedDataDir();
  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('todos-routes: all passed');
});
