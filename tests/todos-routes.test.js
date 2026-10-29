/**
 * Route tests for POST /api/todos/:id/start-agent.
 *
 * Uses the isolated data dir helper (see its header) and a temp cwd so no
 * live project data is touched. Registering the routes on a tiny fake express
 * app keeps the test free of HTTP and auth.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo, linkTodoChat, loadTodosData, updateTodo, writeTodoReview } from '../lib/persist/todos-legacy-adapter.js';
import { FEEDBACK_ROOT_MARKER } from '../lib/feedback-marker.js';
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
        headers: {},
        set(name, value) {
          this.headers[String(name).toLowerCase()] = value;
          return this;
        },
        type() {
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, body });
        },
        send(text) {
          resolve({ status: this.statusCode, body: JSON.parse(text), headers: this.headers });
        },
        end() {
          resolve({ status: this.statusCode, body: null, headers: this.headers });
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
  'detached feedback report retains provenance and REST start stays in plan mode',
  withApp(async (invoke) => {
    const root = addTodo(dataDir, cwd, { title: 'Feedback root', body: FEEDBACK_ROOT_MARKER, status: 'idea' }).item;
    const report = addTodo(dataDir, cwd, { title: 'Report to detach', parentId: root.id, status: 'idea' }).item;
    const spoof = await invoke('PATCH', '/api/todos/:id', { params: { id: report.id }, body: { feedbackOrigin: null } });
    assert.equal(spoof.status, 400);
    const createSpoof = await invoke('POST', '/api/todos', { body: { title: 'Forged provenance', feedback_origin: { kind: 'report' } } });
    assert.equal(createSpoof.status, 400);
    const detached = await invoke('PATCH', '/api/todos/:id', {
      params: { id: report.id }, body: { parent_id: '', status: 'ready' },
    });
    assert.equal(detached.status, 200);
    const saved = loadTodosData(dataDir, cwd).items.find((row) => row.id === report.id);
    assert.equal(saved.parentId, undefined);
    assert.deepEqual(saved.feedbackOrigin, { kind: 'report', rootId: root.id, reportId: report.id });
    const started = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: report.id }, body: { agentTransport: 'claude', workspaceFolder: cwd, workspaceFile },
    });
    assert.equal(started.body.ok, true);
    assert.match(started.body.initialPrompt, /plan/i);
    assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === report.id).status, 'ready');
  }),
);

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
    assert.match(started.body.initialPrompt, /Delegate implementation and review/);
    assert.match(started.body.initialPrompt, /read .*todo-execution-prompt\.js/);
    assert.match(started.body.initialPrompt, /Continue automatically/);
    assert.doesNotMatch(started.body.initialPrompt, /Start by preparing a plan/);
    assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === first.id).status, 'ready');
  })
);

runCase(
  'PATCH watcher_phases rejects unknown keys and non-booleans, accepts valid and clears',
  withApp(async (invoke) => {
    const todo = addTodo(dataDir, cwd, { title: 'Phases', status: 'ready' }).item;
    const call = (watcher_phases) => invoke('PATCH', '/api/todos/:id', {
      params: { id: todo.id },
      body: { watcher_phases },
    });
    const unknown = await call({ bogus: true });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /unknown phase/);
    const nonBool = await call({ review: 'no' });
    assert.equal(nonBool.status, 400);
    assert.match(nonBool.body.error, /boolean/);
    const notObject = await call([true]);
    assert.equal(notObject.status, 400);
    assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === todo.id).watcherPhases, undefined);
    const ok = await call({ review: false });
    assert.notEqual(ok.status, 400);
    assert.deepEqual(loadTodosData(dataDir, cwd).items.find((row) => row.id === todo.id).watcherPhases, { review: false });
    await call({});
    assert.equal(loadTodosData(dataDir, cwd).items.find((row) => row.id === todo.id).watcherPhases, undefined);
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
    // A plain executor start is Agent, never an implicit Plan chat.
    assert.equal(first.body.chat.sdkMode, 'agent');

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

    // The fresh prompt points at live todo history without copying chat IDs.
    assert.match(second.body.initialPrompt, /cretli-ref todo=/);
    assert.doesNotMatch(second.body.initialPrompt, new RegExp(firstChatId));
    assert.match(second.body.initialPrompt, /Earlier chats are listed by todo_show/);
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
    assert.match(refined.body.initialPrompt, /After every plan rewrite call reviewer_session/);
    // The session the server opened for this start is handed over by id.
    assert.ok(refined.body.planReviewerSession?.id);
    assert.ok(refined.body.initialPrompt.includes(`plan-reviewer session ${refined.body.planReviewerSession.id}`));
    assert.match(refined.body.initialPrompt, /Cooperation mode: independent/);
    assert.match(refined.body.initialPrompt, /do not change the todo status/);
    assert.doesNotMatch(refined.body.initialPrompt, /PREVIOUS CHATS|session id:|Run the whole loop|two independent plan reviews/);
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
  'manual ready on feedback report starts planning even with approved container',
  withApp(async (invoke) => {
    const root = addTodo(dataDir, cwd, { title: 'MCP reports', body: '<!-- cretli-feedback-root:v1 -->', status: 'idea' }).item;
    updateTodo(dataDir, cwd, root.id, { plan: { markdown: '# Container plan', approvedAt: '2026-01-01T00:00:00.000Z' } });
    const report = addTodo(dataDir, cwd, { title: 'Bug report', body: '<!-- cretli-feedback {"hash":"abc"} -->', parentId: root.id, status: 'idea' }).item;
    updateTodo(dataDir, cwd, report.id, { status: 'ready' });
    const started = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: report.id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(started.body.ok, true);
    assert.match(started.body.initialPrompt, /@cretli-todo-refine-loop/);
    const saved = loadTodosData(dataDir, cwd).items.find((row) => row.id === report.id);
    assert.equal(saved.status, 'ready');
    assert.ok(!saved.chatId);
  }),
);

runCase(
  'start-agent resolves refine models according to the selected harness',
  withApp(async (invoke) => {
    const start = async (agentTransport, model) => {
      const created = addTodo(dataDir, cwd, { title: `Model for ${agentTransport}`, status: 'idea' });
      return invoke('POST', '/api/todos/:id/start-agent', {
        params: { id: created.item.id },
        body: {
          agentTransport,
          mode: 'refine',
          workspaceFile,
          workspaceFolder: cwd,
          ...(model === undefined ? {} : { model }),
        },
      });
    };

    const omitted = await start('claude', undefined);
    assert.equal(omitted.body.ok, true);
    assert.equal(omitted.body.chat.model, undefined);

    const automatic = await start('claude', 'AuTo');
    assert.equal(automatic.body.ok, true);
    assert.equal(automatic.body.chat.model, undefined);

    const explicit = await start('claude', 'opus::effort=medium');
    assert.equal(explicit.body.ok, true);
    assert.equal(explicit.body.chat.model, 'opus::effort=medium');

    const previousApiKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'test-key';
    try {
      const sdk = await start('sdk', undefined);
      assert.equal(sdk.body.ok, true);
      assert.equal(sdk.body.chat.model, 'auto');
    } finally {
      if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousApiKey;
    }
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
  'start-agent never defaults to plan without an explicit plan choice',
  withApp(async (invoke) => {
    const plain = addTodo(dataDir, cwd, { title: 'Plain executor', status: 'ready' }).item;
    const started = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: plain.id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(started.body.ok, true);
    assert.equal(started.body.chat.sdkMode, 'agent');

    // A saved (even unapproved) plan must not flip the executor back to Plan.
    const withPlan = addTodo(dataDir, cwd, { title: 'Has draft plan', status: 'ready' }).item;
    updateTodo(dataDir, cwd, withPlan.id, { plan: { markdown: '# Draft' } });
    const planned = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: withPlan.id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(planned.body.ok, true);
    assert.equal(planned.body.chat.sdkMode, 'agent');

    // An explicit user choice still opens Plan.
    const requested = addTodo(dataDir, cwd, { title: 'Explicit plan', status: 'ready' }).item;
    const planChat = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: requested.id },
      body: { agentTransport: 'claude', sdkMode: 'plan', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(planChat.body.ok, true);
    assert.equal(planChat.body.chat.sdkMode, 'plan');

    // A plan-only assignee role keeps Plan when the caller did not choose a mode.
    const assigneePlan = addTodo(dataDir, cwd, {
      title: 'Plan role executor',
      status: 'ready',
      assignee: { harness: 'claude', role: 'plan' },
    }).item;
    const roleChat = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: assigneePlan.id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(roleChat.body.ok, true);
    assert.equal(roleChat.body.chat.sdkMode, 'plan');
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
      assignee: { harness: 'testfakeb', role: 'implement' },
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
      assignee: { harness: 'testfakeb', role: 'implement' },
      sourceHarness: 'qwen',
    });
    const fromAssignee = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created2.item.id },
      body: { workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(fromAssignee.body.chat.agentTransport, 'testfakeb');
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
        { delegationId: 'rd1', attemptId: 'ra1', harness: 'testfake', model: 'mimo', status: 'completed', verdict: 'PASS', usable: true, independence: 'different_base_model' },
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
  assert.deepEqual(listedLeaf.review_reviewer, { harness: 'testfake', model: 'mimo', count: 1 });
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

runCase(
  'start-agent mode=full: orchestrator chat, approval-stop prompt for an unapproved plan, no confirm/commit/push',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Do everything', status: 'ready', plan: { markdown: '# Plan\nstep' } });
    const id = created.item.id;
    const full = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id },
      body: { agentTransport: 'claude', mode: 'full', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(full.body.ok, true);
    assert.equal(full.body.forceNew, true);
    assert.equal(full.body.reused, false);
    const prompt = full.body.initialPrompt;
    assert.match(prompt, /ready for human approval/);
    assert.match(prompt, /TODO EXECUTION WORKFLOW/);
    assert.doesNotMatch(prompt, /approvedAt/);
    assert.doesNotMatch(prompt, /3\. Implementation/);
    assert.match(prompt, /never commit, push or merge/);
    assert.match(prompt, /never confirm integration/);
    assert.doesNotMatch(prompt, /\bgit (commit|push)\b/);
    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === id);
    assert.equal(item.orchestratorChatId, full.body.chat.id);
    assert.equal(item.chatId, full.body.chat.id);
  })
);

runCase(
  'start-agent mode=full on an approved plan runs the implement loop then integration, still no confirm',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Approved work', status: 'ready', plan: { markdown: '# Plan\nstep' } });
    updateTodo(dataDir, cwd, created.item.id, { plan: { markdown: '# Plan\nstep', approvedAt: new Date().toISOString() } });
    const full = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created.item.id },
      body: { agentTransport: 'claude', mode: 'full', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(full.body.ok, true);
    const prompt = full.body.initialPrompt;
    assert.match(prompt, /3\. Implementation/);
    // Default phases: integrate is off, so the prompt stops after the leaves.
    assert.match(prompt, /Integration is disabled for this run/);
    assert.match(prompt, /never call todo_integration with action confirm/i);
    assert.doesNotMatch(prompt, /ready for human approval/);
    assert.doesNotMatch(prompt, /\bgit (commit|push)\b/);
  })
);

runCase(
  'start-agent on a leaf under an approved root: plan gate open in executor and full prompts',
  withApp(async (invoke) => {
    const root = addTodo(dataDir, cwd, { title: 'Approved root', status: 'ready', plan: { markdown: '# Root plan' } });
    updateTodo(dataDir, cwd, root.item.id, { plan: { markdown: '# Root plan', approvedAt: new Date().toISOString() } });
    const leaf = addTodo(dataDir, cwd, { title: 'Leaf without own plan', status: 'ready', parentId: root.item.id });
    const direct = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: leaf.item.id },
      body: { agentTransport: 'claude', forceNew: true, workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(direct.body.ok, true);
    assert.match(direct.body.initialPrompt, new RegExp(`Plan gate: open - the plan of ancestor ${root.item.id}`));
    const full = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: leaf.item.id },
      body: { agentTransport: 'claude', mode: 'full', workspaceFile, workspaceFolder: cwd },
    });
    assert.equal(full.body.ok, true);
    assert.match(full.body.initialPrompt, /CURRENT PHASE: execution/);
    assert.doesNotMatch(full.body.initialPrompt, /cretli-todo-refine-loop|ready for human approval/);
  })
);

runCase(
  'start-agent other modes never get the full orchestrator prompt',
  withApp(async (invoke) => {
    const created = addTodo(dataDir, cwd, { title: 'Plain', status: 'ready' });
    const plain = await invoke('POST', '/api/todos/:id/start-agent', {
      params: { id: created.item.id },
      body: { agentTransport: 'claude', workspaceFile, workspaceFolder: cwd },
    });
    assert.doesNotMatch(plain.body.initialPrompt, /per-todo orchestrator/);
    const item = loadTodosData(dataDir, cwd).items.find((row) => row.id === created.item.id);
    assert.ok(!item.orchestratorChatId);
  })
);

runCase('GET /api/todos serves an ETag and 304s a fresh conditional request', withApp(async (invoke) => {
  const first = await invoke('GET', '/api/todos');
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag);
  const again = await invoke('GET', '/api/todos', { fresh: true });
  assert.equal(again.status, 304);
}));

runCase('REST deferred status: snake_case aliases, review gate passes, no jump to ready-only shortcuts', withApp(async (invoke) => {
  const made = await invoke('POST', '/api/todos', { body: { title: 'Park me', status: 'ready', strictStatus: true } });
  const id = made.body.item.id;
  const park = await invoke('PATCH', '/api/todos/:id', {
    params: { id },
    body: { status: 'deferred', deferred_until: '2030-01-02T00:00:00.000Z', deferred_reason: 'later' },
  });
  assert.equal(park.status, 200);
  let row = loadTodosData(dataDir, cwd).items.find((it) => it.id === id);
  assert.equal(row.status, 'deferred');
  assert.equal(row.deferredReason, 'later');
  assert.ok(row.deferredUntil);
  const jump = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { status: 'doing' } });
  assert.equal(jump.status, 409);
  const back = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { status: 'ready' } });
  assert.equal(back.status, 200);
  row = loadTodosData(dataDir, cwd).items.find((it) => it.id === id);
  assert.equal(row.status, 'ready');
  assert.equal(row.deferredReason, undefined);
  const created = await invoke('POST', '/api/todos', {
    body: { title: 'Born deferred', status: 'deferred', deferred_reason: 'why', strictStatus: true },
  });
  assert.equal(created.body.item.status, 'deferred');
  assert.equal(created.body.item.deferredReason, 'why');
}));

/** Synthetic checkpointed leaf: stored data keeps manifests, responses must not. */
function seedLeafMaterial(id, files = 400) {
  const manifest = {};
  for (let i = 0; i < files; i += 1) manifest[`src/file-${i}.js`] = `hash-${i}`.padEnd(40, 'a');
  updateTodo(dataDir, cwd, id, {
    leafMaterial: {
      mode: 'project',
      baseCapturedAt: new Date().toISOString(),
      baseManifest: manifest,
      lastCheckpoint: { at: new Date().toISOString(), manifest: { ...manifest } },
    },
  });
  return files;
}

runCase('PATCH path: status change, plain field change and plan write persist and return the item', withApp(async (invoke) => {
  const item = addTodo(dataDir, cwd, { title: 'Patch path', status: 'idea' }).item;
  const id = item.id;
  const statusRes = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { status: 'ready' } });
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.item.status, 'ready');
  assert.equal(loadTodosData(dataDir, cwd).items.find((r) => r.id === id).status, 'ready');
  const fieldRes = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { title: 'Patch path renamed', body: 'new body' } });
  assert.equal(fieldRes.status, 200);
  assert.equal(fieldRes.body.item.title, 'Patch path renamed');
  assert.equal(fieldRes.body.items.find((r) => r.id === id).body, 'new body');
  assert.equal(fieldRes.body.item.status, 'ready', 'a plain field change keeps the status');
  const planRes = await invoke('PATCH', '/api/todos/:id', { params: { id }, body: { plan: { markdown: '# Plan\n- step' } } });
  assert.equal(planRes.status, 200);
  assert.equal(planRes.body.item.plan.markdown, '# Plan\n- step');
  assert.equal(loadTodosData(dataDir, cwd).items.find((r) => r.id === id).plan.markdown, '# Plan\n- step');
  // The response mirrors what a fresh load returns (no stale document reuse).
  const fresh = loadTodosData(dataDir, cwd).items.find((r) => r.id === id);
  assert.equal(planRes.body.item.updatedAt, fresh.updatedAt);
}));

runCase('lean list (?slim=1) previews text, carries rev; GET /api/todos/:id returns the full item', withApp(async (invoke) => {
  const longBody = 'b'.repeat(4000);
  const longPlan = '# Plan\n' + 'p'.repeat(4000);
  const item = addTodo(dataDir, cwd, { title: 'Lean list', status: 'idea', body: longBody }).item;
  updateTodo(dataDir, cwd, item.id, { plan: { markdown: longPlan } });
  const full = await invoke('GET', '/api/todos');
  const lean = await invoke('GET', '/api/todos', { query: { slim: '1' } });
  const fullRow = full.body.items.find((r) => r.id === item.id);
  const leanRow = lean.body.items.find((r) => r.id === item.id);
  assert.equal(fullRow.body, longBody);
  assert.equal(fullRow.listSlim, undefined);
  assert.equal(leanRow.listSlim, true);
  assert.equal(leanRow.body.length, 80);
  assert.equal(leanRow.plan.markdown.length, 80);
  assert.equal(leanRow.title, 'Lean list');
  assert.ok(JSON.stringify(leanRow).length < JSON.stringify(fullRow).length / 4);
  assert.match(lean.body.rev, /^[\w-]+$/);
  // Other cases write to the shared store, so compare two back-to-back reads.
  const [first, second] = await Promise.all([
    invoke('GET', '/api/todos', { query: { slim: '1' } }),
    invoke('GET', '/api/todos', { query: { slim: '1' } }),
  ]);
  assert.equal(second.body.rev, first.body.rev, 'an unchanged list keeps its revision');
  const detail = await invoke('GET', '/api/todos/:id', { params: { id: item.id } });
  assert.equal(detail.body.ok, true);
  assert.equal(detail.body.item.body, longBody);
  assert.equal(detail.body.item.plan.markdown, longPlan);
  const missing = await invoke('GET', '/api/todos/:id', { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
}));

runCase('lean list row compacts review/chats/worktree/integrationSummary; detail keeps full fields', withApp(async (invoke) => {
  const item = addTodo(dataDir, cwd, { title: 'Lean compact', status: 'idea' }).item;
  const lean = await invoke('GET', '/api/todos', { query: { slim: '1' } });
  const row = lean.body.items.find((r) => r.id === item.id);
  assert.equal(row.listSlim, true);
  assert.equal(row.execution, undefined);
  assert.equal(row.leafMaterial, undefined);
  assert.equal(row.linkedChatIds, undefined);
  if (row.integrationSummary) {
    assert.deepEqual(Object.keys(row.integrationSummary).filter((k) => !['state', 'detail'].includes(k)), []);
  }
  if (row.worktree) assert.ok(row.worktree.live === true || Object.keys(row.worktree).join() === 'live');
  for (const chat of row.chats || []) assert.equal(chat.title, undefined);
  const detail = await invoke('GET', '/api/todos/:id', { params: { id: item.id } });
  assert.equal(detail.body.item.listSlim, undefined);
  const fullList = await invoke('GET', '/api/todos');
  const fullRow = fullList.body.items.find((r) => r.id === item.id);
  for (const key of ['integrationSummary', 'worktree', 'review', 'integration']) {
    assert.deepEqual(detail.body.item[key], fullRow[key], key + ' matches the full item');
  }
}));

runCase('PATCH path: expected_updated_at CAS conflict is rejected and writes nothing', withApp(async (invoke) => {
  const item = addTodo(dataDir, cwd, { title: 'CAS path', status: 'idea' }).item;
  const id = item.id;
  const ok = await invoke('PATCH', '/api/todos/:id', {
    params: { id },
    body: { status: 'ready', expected_updated_at: item.updatedAt },
  });
  assert.equal(ok.status, 200);
  const stale = await invoke('PATCH', '/api/todos/:id', {
    params: { id },
    body: { title: 'Should not apply', expected_updated_at: item.updatedAt },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.ok, false);
  assert.equal(loadTodosData(dataDir, cwd).items.find((r) => r.id === id).title, 'CAS path');
  // The fresh token succeeds.
  const retry = await invoke('PATCH', '/api/todos/:id', {
    params: { id },
    body: { title: 'Applied', expected_updated_at: ok.body.item.updatedAt },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.item.title, 'Applied');
}));

runCase('PATCH path: idempotent create replay returns the same todo', () => {
  const first = addTodo(dataDir, cwd, { title: 'Replay path', idempotencyKey: 'patch-path-replay' });
  const again = addTodo(dataDir, cwd, { title: 'Replay path', idempotencyKey: 'patch-path-replay' });
  assert.equal(again.item.id, first.item.id);
  assert.equal(loadTodosData(dataDir, cwd).items.filter((r) => r.title === 'Replay path').length, 1);
});

runCase('PATCH path: a child status change recomputes the parent status in the response', withApp(async (invoke) => {
  const parent = addTodo(dataDir, cwd, { title: 'Derive parent', status: 'idea' }).item;
  const kids = Array.from({ length: 22 }, (_, i) => addTodo(dataDir, cwd, { title: `Derive kid ${i}`, status: 'ready', parentId: parent.id }).item);
  const started = await invoke('PATCH', '/api/todos/:id', { params: { id: kids[0].id }, body: { status: 'doing' } });
  assert.equal(started.status, 200);
  assert.equal(started.body.items.find((r) => r.id === parent.id).status, 'doing');
  assert.equal(loadTodosData(dataDir, cwd).items.find((r) => r.id === parent.id).status, 'doing');
  const back = await invoke('PATCH', '/api/todos/:id', { params: { id: kids[0].id }, body: { status: 'ready' } });
  assert.equal(back.status, 200);
  assert.equal(back.body.items.find((r) => r.id === parent.id).status, loadTodosData(dataDir, cwd).items.find((r) => r.id === parent.id).status);
}));

runCase('PATCH and list responses do not carry leafMaterial manifests; stored data keeps them', withApp(async (invoke) => {
  const item = addTodo(dataDir, cwd, { title: 'Manifest leaf', status: 'ready' }).item;
  const files = seedLeafMaterial(item.id);
  const patched = await invoke('PATCH', '/api/todos/:id', { params: { id: item.id }, body: { title: 'Manifest leaf 2' } });
  const listed = await invoke('GET', '/api/todos', { query: { workspaceFolder: cwd } });
  for (const row of [patched.body.item, patched.body.items.find((r) => r.id === item.id), listed.body.items.find((r) => r.id === item.id)]) {
    assert.equal(row.leafMaterial.mode, 'project');
    assert.equal(row.leafMaterial.baseManifest, undefined);
    assert.equal(row.leafMaterial.lastCheckpoint.manifest, undefined);
    assert.equal(row.leafMaterial.baseManifestPaths, files);
    assert.equal(row.leafMaterial.lastCheckpoint.manifestPaths, files);
  }
  assert.ok(!JSON.stringify(patched.body).includes('src/file-1.js'));
  const stored = loadTodosData(dataDir, cwd).items.find((r) => r.id === item.id);
  assert.equal(Object.keys(stored.leafMaterial.baseManifest).length, files, 'stored manifest untouched');
  assert.equal(Object.keys(stored.leafMaterial.lastCheckpoint.manifest).length, files);
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
