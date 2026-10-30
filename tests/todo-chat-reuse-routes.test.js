import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-legacy-adapter.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { noteHarnessCacheState, resetCacheStateForTests } from '../lib/usage/cache-state.ts';
import { removeChat } from '../lib/persist/chats-persist.js';
import { isReuseChatReserved, clearReuseChatReservationsForTests } from '../lib/todo-chat-reuse.js';

function makeApp(dataDir, cwd, probe) {
  const handlers = new Map();
  const app = {
    get(route, handler) { handlers.set(`GET ${route}`, handler); },
    post(route, handler) { handlers.set(`POST ${route}`, handler); },
    patch(route, handler) { handlers.set(`PATCH ${route}`, handler); },
    delete(route, handler) { handlers.set(`DELETE ${route}`, handler); },
  };
  registerTodosRoutes(app, {
    dataDir,
    getCurrentCwd: () => cwd,
    getCurrentWorkspaceFile: () => path.join(cwd, 'project.code-workspace'),
    agentModel: 'auto',
    getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999',
    useHttps: false,
    loadWatcherPolicy: () => null,
    probeChatRunLiveness: (...args) => { probe?.(...args); return { known: true, busy: false, reason: 'idle' }; },
  });
  return async (method, route, req = {}) => new Promise((resolve, reject) => {
    const handler = handlers.get(`${method} ${route}`);
    if (!handler) return reject(new Error(`missing route ${method} ${route}`));
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    Promise.resolve(handler({ params: {}, query: {}, body: {}, ...req }, res)).catch(reject);
  });
}

test('reuse candidates are read-only and a warm continuation links, starts and prompts the selected chat', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-reuse-route-'));
  const dataDir = path.join(cwd, 'data');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  resetCacheStateForTests();
  clearReuseChatReservationsForTests();

  const root = addTodo(dataDir, cwd, { title: 'Tree', status: 'idea' }).item;
  const previous = addTodo(dataDir, cwd, { title: 'Previous', parentId: root.id, status: 'idea' }).item;
  const target = addTodo(dataDir, cwd, { title: 'Target', parentId: root.id, status: 'idea' }).item;
  const chat = addChat('session', 'Previous stage', path.join(cwd, 'project.code-workspace'), cwd, 'sonnet', {
    agentTransport: 'claude',
  });
  await updateTodo(dataDir, cwd, previous.id, { status: 'done', chatId: chat.id, linkedChatId: chat.id });
  const ready = (await updateTodo(dataDir, cwd, target.id, { status: 'ready' })).items.find((row) => row.id === target.id);
  noteHarnessCacheState({
    chatId: chat.id,
    harness: 'claude',
    now: Date.now(),
    tokens: { textInput: 2_000, cachedInput: 10_000, cacheWrite: 500 },
  });
  const invoke = makeApp(dataDir, cwd);

  const before = await getTodoById(dataDir, cwd, target.id);
  const candidates = await invoke('GET', '/api/todos/:id/reuse-candidates', {
    params: { id: target.id }, query: { workspaceFolder: cwd },
  });
  assert.equal(candidates.status, 200);
  assert.equal(candidates.body.candidates[0].chatId, chat.id);
  assert.equal(candidates.body.candidates[0].eligible, true);
  assert.equal((await getTodoById(dataDir, cwd, target.id)).updatedAt, before.updatedAt);

  const changed = (await updateTodo(dataDir, cwd, target.id, { title: 'Target changed' })).items.find((row) => row.id === target.id);
  const stale = await invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: target.id },
    body: { workspaceFolder: cwd, reuseChatId: chat.id, expectedUpdatedAt: ready.updatedAt },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONFLICT');

  const started = await invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: target.id },
    body: { workspaceFolder: cwd, reuseChatId: chat.id, expectedUpdatedAt: changed.updatedAt },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.reused, true);
  assert.equal(started.body.reuseKind, 'continuation');
  assert.match(started.body.continuationPrompt, new RegExp(`cretli-ref todo=${target.id}`));
  assert.match(started.body.continuationPrompt, /direct executor/);
  const saved = await getTodoById(dataDir, cwd, target.id);
  assert.equal(saved.status, 'doing');
  assert.equal(saved.chatId, chat.id);
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId, target.id);
});

test('reuse start validates incompatible flags and stale revisions without leaking a reservation', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-reuse-conflict-'));
  const dataDir = path.join(cwd, 'data');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  resetCacheStateForTests();
  clearReuseChatReservationsForTests();
  const todo = addTodo(dataDir, cwd, { title: 'Target', status: 'ready' }).item;
  const invoke = makeApp(dataDir, cwd);
  const invalid = await invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: todo.id },
    body: { workspaceFolder: cwd, reuseChatId: 'chat', expectedUpdatedAt: todo.updatedAt, forceNew: true },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'TODO_REUSE_INVALID');
});

test('reuse start rejects ineligible chats, foreign todo chats and parallel claims, releasing reservations', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-reuse-reject-'));
  const dataDir = path.join(cwd, 'data');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  resetCacheStateForTests();
  clearReuseChatReservationsForTests();
  const root = addTodo(dataDir, cwd, { title: 'Tree', status: 'idea' }).item;
  const previous = addTodo(dataDir, cwd, { title: 'Previous', parentId: root.id, status: 'idea' }).item;
  const target = addTodo(dataDir, cwd, { title: 'Target', parentId: root.id, status: 'idea' }).item;
  const chat = addChat('session', 'Previous stage', path.join(cwd, 'project.code-workspace'), cwd, 'sonnet', {
    agentTransport: 'claude',
  });
  await updateTodo(dataDir, cwd, previous.id, { status: 'done', chatId: chat.id, linkedChatId: chat.id });
  const ready = (await updateTodo(dataDir, cwd, target.id, { status: 'ready' })).items.find((row) => row.id === target.id);
  const invoke = makeApp(dataDir, cwd);
  const start = (expectedUpdatedAt) => invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: target.id },
    body: { workspaceFolder: cwd, reuseChatId: chat.id, expectedUpdatedAt },
  });

  // No cache telemetry yet: the chat is not eligible and nothing is written.
  const cold = await start(ready.updatedAt);
  assert.equal(cold.status, 409);
  assert.equal(cold.body.code, 'TODO_REUSE_NOT_ELIGIBLE');
  assert.equal(cold.body.reason, 'cache_unknown');
  assert.equal((await getTodoById(dataDir, cwd, target.id)).chatId || '', '');

  noteHarnessCacheState({
    chatId: chat.id,
    harness: 'claude',
    now: Date.now(),
    tokens: { textInput: 2_000, cachedInput: 10_000, cacheWrite: 500 },
  });
  // A failed attempt must not leave the chat reserved: two parallel starts, one wins.
  const [a, b] = await Promise.all([start(ready.updatedAt), start(ready.updatedAt)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal((await getTodoById(dataDir, cwd, target.id)).chatId, chat.id);
  // The loser must not roll chat.todoId back over the winner's link.
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId, target.id);
  assert.equal(isReuseChatReserved(chat.id, 'other-todo'), false);

});

test('a chat deleted during the start fails with 409 and leaves the todo unlinked', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-reuse-deleted-'));
  const dataDir = path.join(cwd, 'data');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  resetCacheStateForTests();
  clearReuseChatReservationsForTests();
  const root = addTodo(dataDir, cwd, { title: 'Tree', status: 'idea' }).item;
  const previous = addTodo(dataDir, cwd, { title: 'Previous', parentId: root.id, status: 'idea' }).item;
  const target = addTodo(dataDir, cwd, { title: 'Target', parentId: root.id, status: 'idea' }).item;
  const chat = addChat('session', 'Previous stage', path.join(cwd, 'project.code-workspace'), cwd, 'sonnet', {
    agentTransport: 'claude',
  });
  await updateTodo(dataDir, cwd, previous.id, { status: 'done', chatId: chat.id, linkedChatId: chat.id });
  const ready = (await updateTodo(dataDir, cwd, target.id, { status: 'ready' })).items.find((row) => row.id === target.id);
  noteHarnessCacheState({
    chatId: chat.id, harness: 'claude', now: Date.now(),
    tokens: { textInput: 2_000, cachedInput: 10_000, cacheWrite: 500 },
  });
  let armed = false;
  // The liveness probe runs during candidate evaluation: delete the chat mid-start.
  const invoke = makeApp(dataDir, cwd, () => { if (armed) { armed = false; removeChat(chat.id); } });
  armed = true;
  const res = await invoke('POST', '/api/todos/:id/start-agent', {
    params: { id: target.id },
    body: { workspaceFolder: cwd, reuseChatId: chat.id, expectedUpdatedAt: ready.updatedAt },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TODO_REUSE_NOT_ELIGIBLE');
  const saved = await getTodoById(dataDir, cwd, target.id);
  assert.equal(saved.chatId || '', '');
  assert.equal(saved.status, 'ready');
  // The reservation was released: a later attempt is not blocked by 'reserved'.
  assert.equal(isReuseChatReserved(chat.id, target.id), false);
});

test('after a successful reuse the chat is claimed by the target: another sibling is rejected and chat.todoId stays stable', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-reuse-postlink-'));
  const dataDir = path.join(cwd, 'data');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  resetCacheStateForTests();
  clearReuseChatReservationsForTests();
  const root = addTodo(dataDir, cwd, { title: 'Tree', status: 'idea' }).item;
  await updateTodo(dataDir, cwd, root.id, { runMode: 'parallel' });
  const previous = addTodo(dataDir, cwd, { title: 'Previous', parentId: root.id, status: 'idea' }).item;
  const target = addTodo(dataDir, cwd, { title: 'Target', parentId: root.id, status: 'idea' }).item;
  const sibling = addTodo(dataDir, cwd, { title: 'Sibling', parentId: root.id, status: 'idea' }).item;
  const chat = addChat('session', 'Previous stage', path.join(cwd, 'project.code-workspace'), cwd, 'sonnet', {
    agentTransport: 'claude',
  });
  await updateTodo(dataDir, cwd, previous.id, { status: 'done', chatId: chat.id, linkedChatId: chat.id });
  const fresh = async (id) => (await getTodoById(dataDir, cwd, id)).updatedAt;
  await updateTodo(dataDir, cwd, target.id, { status: 'ready' });
  await updateTodo(dataDir, cwd, sibling.id, { status: 'ready' });
  noteHarnessCacheState({
    chatId: chat.id, harness: 'claude', now: Date.now(),
    tokens: { textInput: 2_000, cachedInput: 10_000, cacheWrite: 500 },
  });
  const invoke = makeApp(dataDir, cwd);
  const start = async (id) => invoke('POST', '/api/todos/:id/start-agent', {
    params: { id },
    body: { workspaceFolder: cwd, reuseChatId: chat.id, expectedUpdatedAt: await fresh(id) },
  });

  const first = await start(target.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId, target.id);
  // The reservation is gone, but the chat is now the target's unfinished chat.
  assert.equal(isReuseChatReserved(chat.id, sibling.id), false);

  const other = await start(sibling.id);
  assert.equal(other.status, 409, JSON.stringify(other.body));
  // The start is refused (tree gate or reuse check); the candidate list names the claim as the reason.
  const listed = await invoke('GET', '/api/todos/:id/reuse-candidates', {
    params: { id: sibling.id }, query: { workspaceFolder: cwd },
  });
  const entry = listed.body.candidates.find((row) => row.chatId === chat.id);
  assert.equal(entry?.eligible, false);
  assert.equal(entry?.reason, 'claimed_by_other_todo');
  assert.equal((await getTodoById(dataDir, cwd, sibling.id)).chatId || '', '');
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId, target.id);

  // Repeating the start for the owning target is an idempotent resume, not a takeover.
  const again = await start(target.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(loadChats().find((row) => row.id === chat.id)?.todoId, target.id);
});
