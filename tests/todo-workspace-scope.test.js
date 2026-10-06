import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as api from '../app_front/api.js';
import {
  getTodoWorkspaceFolder,
  todoWorkspaceMatches,
} from '../app_front/features/todo/todoWorkspaceScope.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('TODO reads and every mutation target the client workspace', async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const trigger = { dataset: { workspaceFolder: '/client workspace' } };
  globalThis.document = { getElementById: () => trigger };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await api.getTodos();
    await api.postTodo({ title: 'New' });
    await api.patchTodo('todo-1', { status: 'done' });
    await api.deleteTodo('todo-1');
    await api.postTodoStartAgent('todo-1', { agentTransport: 'claude' });
    assert.equal(calls[0].url, '/api/todos?workspaceFolder=%2Fclient%20workspace');
    for (const index of [1, 2, 4]) {
      assert.equal(JSON.parse(calls[index].init.body).workspaceFolder, '/client workspace');
    }
    assert.equal(calls[3].url, '/api/todos/todo-1?workspaceFolder=%2Fclient%20workspace');
    assert.equal(JSON.parse(calls[2].init.body).status, 'done');
    await api.patchTodo('todo-2', { workspaceFolder: '/explicit', title: 'Explicit' });
    assert.equal(JSON.parse(calls[5].init.body).workspaceFolder, '/explicit');
    await api.getTodos('/explicit');
    assert.equal(calls[6].url, '/api/todos?workspaceFolder=%2Fexplicit');

    delete globalThis.document;
    await api.getTodos();
    assert.equal(calls[7].url, '/api/todos', 'boot without a known workspace keeps the server default');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('in-flight TODO reads are coalesced per workspace', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url) => {
    const pending = deferred();
    calls.push({ url, pending });
    return pending.promise;
  };
  try {
    const a = api.getTodos('/a');
    const anotherA = api.getTodos('/a');
    const b = api.getTodos('/b');
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].url, calls[1].url);
    for (const { pending } of calls) pending.resolve({ status: 200, json: async () => ({ ok: true }) });
    await Promise.all([a, anotherA, b]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// Exercise the panel itself without loading browser-only custom elements.
function makePanel() {
  let folder = '/a';
  const list = { textContent: 'Old rows', innerHTML: '' };
  const hint = { textContent: '/a', hidden: false };
  const status = { textContent: '', classList: { toggle() {} } };
  const pending = [];
  let editorHidden = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => id === 'todo-panel' ? { classList: { contains: () => true } } : null },
    getTodoWorkspaceFolder: () => folder,
    todoWorkspaceMatches: (candidate, active = folder) => todoWorkspaceMatches(candidate, active),
    api: {
      getTodos: (requestedFolder) => {
        const request = deferred();
        pending.push({ ...request, folder: requestedFolder });
        return request.promise;
      },
      getAgentSdkStatus: async () => ({ ready: true }),
    },
    localStorage: { getItem: () => null },
    parseTodoRootStatusFilter: () => null,
    filterTodoItemsByRootStatus: (items) => items,
    refreshWatcherPanel: async () => {},
    t: (key) => key,
    list, hint, status,
    editor: { hide: () => { editorHidden += 1; } },
  });
  const source = readFileSync(new URL('../app_front/todoPanel.js', import.meta.url), 'utf8')
    .replace(/^import\b[\s\S]*?;\s*/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(`${source}\nlistEl = list; hintEl = hint; statusEl = status; editorDialog = editor;`, context);
  return {
    pending, list, hint, status,
    refresh: () => vm.runInContext('refreshTodoList()', context),
    workspaceChanged: () => vm.runInContext('onTodoWorkspaceChange()', context),
    switchTo: (next) => { folder = next; },
    editorHidden: () => editorHidden,
    evaluate: (code) => vm.runInContext(code, context),
  };
}

test('workspace switch clears old rows and editor, and ignores a delayed response', async () => {
  const panel = makePanel();
  const a = panel.refresh();
  panel.switchTo('/b');
  const b = panel.refresh();
  assert.deepEqual(panel.pending.map((request) => request.folder), ['/a', '/b']);
  assert.equal(panel.list.textContent, '');
  assert.equal(panel.hint.textContent, '');
  assert.ok(panel.editorHidden() > 0);
  panel.pending[1].resolve({ ok: true, cwd: '/b', items: [] });
  await b;
  panel.pending[0].resolve({ ok: true, cwd: '/a', items: [{ id: 'foreign' }] });
  await a;
  assert.equal(panel.hint.textContent, '/b');
  assert.equal(panel.evaluate('latestItems.length'), 0);
});

test('a delayed failure cannot clear the new workspace or display an error', async () => {
  const panel = makePanel();
  const a = panel.refresh();
  panel.switchTo('/b');
  const b = panel.refresh();
  panel.pending[1].resolve({ ok: true, cwd: '/b', items: [] });
  await b;
  panel.pending[0].reject(new Error('Old request failed'));
  await a;
  assert.equal(panel.hint.textContent, '/b');
  assert.equal(panel.status.textContent, '');
});

test('a workspace change while Todo is open clears and reloads the list for the new folder', async () => {
  const panel = makePanel();
  panel.switchTo('/domq');
  const changed = panel.workspaceChanged();
  assert.equal(panel.list.textContent, '');
  assert.equal(panel.pending[0].folder, '/domq');
  panel.pending[0].resolve({ ok: true, cwd: '/domq', items: [] });
  await changed;
  assert.equal(panel.hint.textContent, '/domq');
});

test('cached lookups and mutation responses cannot restore another workspace', () => {
  const panel = makePanel();
  panel.evaluate("latestWorkspaceFolder = '/a'; latestItems = [{ id: 'old' }]");
  panel.switchTo('/b');
  assert.equal(panel.evaluate("findItem('old')"), null);
  panel.evaluate("renderList({ cwd: '/a', items: [{ id: 'foreign' }] })");
  assert.equal(panel.evaluate('latestItems[0].id'), 'old', 'foreign response was ignored');
});

test('workspace comparisons tolerate trailing separators', () => {
  assert.equal(todoWorkspaceMatches('/workspace/', '/workspace'), true);
  assert.equal(todoWorkspaceMatches('C:\\workspace\\', 'C:/workspace'), true);
  assert.equal(getTodoWorkspaceFolder(), '');
});
