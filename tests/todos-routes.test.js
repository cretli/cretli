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
import { addTodo, linkTodoChat, loadTodosData, updateTodo, writeTodoReview } from '../lib/persist/todos-persist.js';
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
    assert.equal(first.body.chat.sdkMode, 'plan');

    const second = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.reused, false);
    assert.equal(second.body.forceNew, true);
    assert.equal(second.body.chat.sdkMode, 'agent');
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
  'start-agent mode=refine opens a side chat with the refine-loop prompt and leaves the todo untouched',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Refine me', status: 'ready' });
    const id = created.item.id;
    const first = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    const executorChatId = first.body.chat.id;

    const refined = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', mode: 'refine', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(refined.body.ok, true);
    assert.equal(refined.body.reused, false);
    assert.equal(refined.body.chat.sdkMode, 'agent');
    assert.match(refined.body.chat.title, /^\[Todo plan\] Refine me/);
    const refineChatId = refined.body.chat.id;
    assert.notEqual(refineChatId, executorChatId);
    assert.match(refined.body.initialPrompt, /@cretli-todo-refine-loop/);
    assert.match(refined.body.initialPrompt, /cretli-ref todo=/);
    assert.doesNotMatch(refined.body.initialPrompt, /set-todo-from-agent/);

    // The refine chat is listed on the todo but is not its executor chat.
    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
    assert.equal(item.chatId, executorChatId);
    assert.equal(item.status, 'doing');
    assert.ok(item.linkedChatIds.includes(refineChatId));
  })
);

runCase(
  'start-agent mode=refine does not move an untouched todo to doing',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Draft only', status: 'idea' });
    const id = created.item.id;
    const refined = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', mode: 'refine', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(refined.body.ok, true);
    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
    assert.equal(item.status, 'idea');
    assert.ok(!item.chatId);
    assert.ok(item.linkedChatIds.includes(refined.body.chat.id));
  })
);

runCase(
  'start-agent forceNew defaults to agent over a planning assignee and respects an explicit mode',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, {
      title: 'Continue planning task',
      status: 'ready',
      assignee: { harness: 'claude', role: 'plan' },
    });
    const body = { forceNew: true, workspaceFile, workspaceFolder: cwd };
    const started = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created.item.id },
      body,
    });
    assert.equal(started.body.ok, true);
    assert.equal(started.body.chat.sdkMode, 'agent');
    const explicit = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created.item.id },
      body: { ...body, sdkMode: 'plan' },
    });
    assert.equal(explicit.body.ok, true);
    assert.equal(explicit.body.chat.sdkMode, 'plan');
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

runCase('REST PATCH rejects a client-supplied review field', withApp(async (invoke) => {
  const created = addTodo(dataDir, cwd, { title: 'REST review', status: 'ready' });
  const id = created.item.id;
  for (const payload of [
    { review: { code: { state: 'passed' } } },
    { review_subject: 'code' },
    { reviewSubject: 'plan' },
  ]) {
    const res = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: payload });
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal(res.body.ok, false);
    assert.match(String(res.body.error), /review/i);
  }
  const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
  assert.equal(item.review, undefined, 'review must never be written through REST');
  // A normal patch still works.
  const patched = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { title: 'REST renamed' } });
  assert.equal(patched.status, 200);
  assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === id).title, 'REST renamed');
}));

runCase('REST POST rejects a client-supplied review field', withApp(async (invoke) => {
  const res = await invoke('POST', '/api/todos', {
    body: { title: 'Nope review', review: { code: { state: 'passed' } } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(String(res.body.error), /review/i);
  assert.equal(
    loadTodosData(dataDir, cwd).items.some((row) => row.title === 'Nope review'),
    false,
    'a rejected create must not persist anything',
  );
}));

runCase('REST list exposes the review read model and the container aggregate', withApp(async (invoke) => {
  const parent = addTodo(dataDir, cwd, { title: 'Review REST parent', status: 'doing' }).item;
  const leaf = addTodo(dataDir, cwd, { title: 'Review REST leaf', status: 'doing', parentId: parent.id }).item;
  const empty = addTodo(dataDir, cwd, { title: 'Review REST empty', status: 'doing', parentId: parent.id }).item;
  writeTodoReview(dataDir, cwd, leaf.id, {
    code: {
      state: 'passed',
      stateReason: 'fresh_review',
      subject: 'code',
      subjectSource: 'explicit',
      reviewerCount: 1,
      reviewers: [
        { delegationId: 'rd1', attemptId: 'ra1', harness: 'opencode', model: 'mimo', status: 'completed', verdict: 'PASS', usable: true, independence: 'different_base_model' },
      ],
      independence: { independent: true, class: 'different_base_model', reference: 'implementer' },
      implementer: { delegationId: 'impl', attemptId: 'ia', role: 'implement', harness: 'codex', model: 'gpt' },
      material: { current: true, kind: 'trusted', reason: 'fresh_review' },
    },
    plan: { state: 'none', stateReason: 'no_review', subject: 'plan', subjectSource: 'default' },
  });

  const listed = await invoke('GET', '/api/todos', { query: { workspaceFolder: cwd } });
  assert.equal(listed.status, 200);
  const listedLeaf = listed.body.items.find((row) => row.id === leaf.id);
  assert.equal(listedLeaf.review_state, 'passed');
  assert.equal(listedLeaf.review_plan_state, 'none');
  assert.deepEqual(listedLeaf.review_reviewer, { harness: 'opencode', model: 'mimo', count: 1 });
  assert.equal(listedLeaf.review_independence, 'different_base_model');
  assert.equal(listedLeaf.review.code.state, 'passed');
  assert.equal(listedLeaf.review.code.reviewers.length, 1);

  const listedEmpty = listed.body.items.find((row) => row.id === empty.id);
  assert.equal(listedEmpty.review_state, 'none');
  assert.equal(listedEmpty.review.code.state, 'none');

  const listedParent = listed.body.items.find((row) => row.id === parent.id);
  assert.equal(listedParent.review_state, '', 'container row has empty own state');
  assert.equal(listedParent.review.aggregate.source, 'children');
  assert.equal(listedParent.review.aggregate.code.passed, 1);
  assert.equal(listedParent.review.aggregate.code.none, 1);
  assert.equal(listedParent.review.aggregate.plan.none, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(listedParent.review.aggregate, 'reviewers'), false);
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
