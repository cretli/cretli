/**
 * Scoped request adapters (navigation plan stage 2, review round 5).
 *
 * A resource conflict clears the header `dataset` on purpose (the header must
 * never lie about a scope it cannot honor), so every panel that derived its
 * scope from that dataset used to fall back to an UNscoped request — which the
 * server answers from its shared settings cwd, i.e. a different workspace.
 * These tests pin the resolved ViewContext runtime scope as the source for the
 * list/query adapters, assert the shared query helper is used by production
 * requests (not only by its own unit test), and prove no worktree write can
 * leave the tab without an explicit folder.
 *
 * The fetch layer is exercised behaviourally (stubbed `globalThis.fetch`): the
 * honest assertion is "this exact URL left the tab" / "no request left the tab".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VIEW_CONTEXT_STATUS, createViewContextStore } from '../app_front/app/appShell/viewContext.js';
// Namespace import: the new bridge export does not exist yet, and a named
// import of a missing symbol would take the whole suite down with a link-time
// SyntaxError instead of failing only the cases that pin it.
import * as viewContextBridge from '../app_front/app/appShell/viewContextBridge.js';
import { getTodoWorkspaceFolder } from '../app_front/features/todo/todoWorkspaceScope.js';
import * as api from '../app_front/api.js';

const { setSharedViewContextStore, withViewContextQuery, hasExplicitViewContextWorkspace } = viewContextBridge;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const WS_A = '0e6a6f32-2b8c-4921-9041-e5b230e7b793';
const FOLDER_A = '3b8d2f1a-5a44-4a12-b1c8-2f4f0a1d9c33';
const CHAT_ID = '4fbef7c3-96cd-4451-b014-64d6c4e1ca03';
const WORKSPACE_FILE = '/ws/alpha/app.code-workspace';
const WORKSPACE_FOLDER = '/ws/alpha/app';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Store resolved from an explicit deep link, optionally driven into a conflict.
 *
 * @param {{ conflictWith?: object|null }} [options]
 */
async function explicitStore(options = {}) {
  const store = createViewContextStore({
    readLocation: () => ({
      pathname: '/chat',
      search: `?ws=${WS_A}&folder=${FOLDER_A}&chat=${CHAT_ID}`,
    }),
    resolveWorkspace: async () => ({
      workspaceFile: WORKSPACE_FILE,
      workspaceFolder: WORKSPACE_FOLDER,
      workspaceKey: WS_A,
      folderKey: FOLDER_A,
    }),
    readyTimeoutMs: 30,
  });
  await store.applyRouteContext();
  if (options.conflictWith) store.reportResourceConflict('chat', options.conflictWith);
  setSharedViewContextStore(store);
  return store;
}

/**
 * Stub the network and hand back a tab whose header datasets were cleared by
 * the conflict notice (that is the exact state the panels used to read as
 * "no scope", which the server then answered from its global cwd).
 *
 * @returns {{ requests: Array<{url: string, init: object|undefined}>, urls: () => string[], restore: () => void }}
 */
function stubTab() {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  /** @type {Array<{url: string, init: object|undefined}>} */
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return { status: 200, json: async () => ({ ok: true, cwd: WORKSPACE_FOLDER, items: [], chats: [] }) };
  };
  const trigger = { dataset: { workspaceFile: '', workspaceFolder: '' } };
  globalThis.document = { getElementById: () => trigger };
  return {
    requests,
    urls: () => requests.map((entry) => entry.url),
    body: (index = 0) => JSON.parse(String(requests[index]?.init?.body || '{}')),
    restore: () => {
      globalThis.fetch = previousFetch;
      if (typeof previousDocument === 'undefined') delete globalThis.document;
      else globalThis.document = previousDocument;
      setSharedViewContextStore(null);
    },
  };
}

/**
 * @param {string} url
 * @returns {URLSearchParams}
 */
function queryOf(url) {
  const index = url.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : url.slice(index + 1));
}

test.afterEach(() => {
  setSharedViewContextStore(null);
});

test('a conflicting resource keeps TODO reads and writes on the resolved folder, not the global cwd', async () => {
  const store = await explicitStore({ conflictWith: { workspaceFile: '/ws/beta/beta.code-workspace' } });
  assert.equal(store.getState().status, VIEW_CONTEXT_STATUS.CONFLICT);
  const tab = stubTab();
  try {
    assert.equal(getTodoWorkspaceFolder(), WORKSPACE_FOLDER,
      'the TODO adapter follows the resolved runtime scope after the header was cleared');

    await api.getTodos();
    assert.equal(tab.requests.length, 1, 'the TODO list issued exactly one request');
    const params = queryOf(tab.requests[0].url);
    assert.ok(tab.requests[0].url.startsWith('/api/todos'), 'the TODO list endpoint is unchanged');
    assert.equal(params.get('workspaceFolder'), WORKSPACE_FOLDER,
      'GET /api/todos must stay scoped to the link folder, never the server cwd');
    assert.equal(params.get('ws'), WS_A, 'the durable workspace key travels with the request');
    assert.equal(params.get('folder'), FOLDER_A, 'the durable folder key travels with the request');

    await api.postTodo({ title: 'Scoped while conflicting' });
    assert.equal(tab.requests.length, 2);
    assert.equal(tab.body(1).workspaceFolder, WORKSPACE_FOLDER,
      'a TODO write while a conflict is shown stays on the resolved folder');
  } finally {
    tab.restore();
  }
});

test('the chat panel derives scope from view-context runtime when the header dataset is cleared', () => {
  const source = readSource('app_front/chat.js');
  const start = source.indexOf('function getWorkspaceContextForChat');
  assert.ok(start > 0, 'getWorkspaceContextForChat must exist');
  const body = source.slice(start, start + 600);
  assert.match(body, /getViewContextRuntimeScope\(\)/,
    'sidebar chat filtering must follow the resolved runtime, not an empty header');
});

test('the chat list fetch carries the resolved view-context scope', async () => {
  await explicitStore({ conflictWith: { workspaceFile: '/ws/beta/beta.code-workspace' } });
  const tab = stubTab();
  try {
    await api.getChats({ includeArchived: true });
    assert.equal(tab.requests.length, 1);
    const params = queryOf(tab.requests[0].url);
    assert.ok(tab.requests[0].url.startsWith('/api/chats'));
    assert.equal(params.get('includeArchived'), '1', 'existing chat query params are preserved');
    assert.equal(params.get('ws'), WS_A, 'the shared query helper is wired into the production chat list');
    assert.equal(params.get('folder'), FOLDER_A);
    assert.equal(params.get('workspaceFolder'), WORKSPACE_FOLDER);
    assert.equal(params.get('workspaceFile'), WORKSPACE_FILE);
  } finally {
    tab.restore();
  }
});

test('withViewContextQuery stays inert for a tab without an explicit context', async () => {
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/chat', search: `?chat=${CHAT_ID}` }),
    resolveWorkspace: async () => ({ workspaceFile: WORKSPACE_FILE, workspaceFolder: WORKSPACE_FOLDER }),
    readyTimeoutMs: 30,
  });
  setSharedViewContextStore(store);
  await store.applyRouteContext();
  assert.equal(hasExplicitViewContextWorkspace(), false);
  assert.equal(withViewContextQuery('/api/todos'), '/api/todos',
    'a default tab keeps sending exactly the URLs it sent before');
  assert.equal(
    withViewContextQuery('/api/todos?workspaceFolder=%2Fother'),
    '/api/todos?workspaceFolder=%2Fother',
    'an explicit param already on the URL is never duplicated or overridden',
  );
  const tab = stubTab();
  try {
    await api.getTodos();
    assert.deepEqual(tab.urls(), ['/api/todos'], 'a default TODO read is byte-for-byte the old request');
  } finally {
    tab.restore();
  }
});

test('worktree writes and reads refuse an empty folder locally and issue no request', async () => {
  setSharedViewContextStore(null);
  const tab = stubTab();
  try {
    const calls = [
      ['rejectWorktree', () => api.rejectWorktree('todo-1', '')],
      ['cleanupWorktree', () => api.cleanupWorktree('todo-1', '   ')],
      ['startWorktreeMerge', () => api.startWorktreeMerge('todo-1', '', { instructions: 'x' })],
      ['getWorktreeDiff', () => api.getWorktreeDiff('todo-1', '')],
      ['getWorktreeMergePreview', () => api.getWorktreeMergePreview('todo-1', '')],
      ['listWorktrees', () => api.listWorktrees('')],
      ['getWorktrees', () => api.getWorktrees('')],
      ['smartMergeTodo', () => api.smartMergeTodo('todo-1', '')],
    ];
    for (const [name, call] of calls) {
      const result = await call();
      assert.equal(result?.ok, false, `${name} must refuse an empty workspace folder`);
      if (name !== 'smartMergeTodo') {
        assert.equal(result?.code, 'workspace-folder-required', `${name} refusal code`);
      }
    }
    assert.deepEqual(tab.urls(), [], 'no worktree request may fall back to the server global cwd');
  } finally {
    tab.restore();
  }
});

test('a pending explicit link still refuses worktree writes (no fetch)', async () => {
  const gate = deferred();
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/chat', search: `?ws=${WS_A}&folder=${FOLDER_A}&chat=${CHAT_ID}` }),
    resolveWorkspace: () => gate.promise,
    readyTimeoutMs: 30,
  });
  setSharedViewContextStore(store);
  // Deliberately not awaited: the resolver never settles while the tab is
  // pending, and the PENDING snapshot is emitted before the first await.
  const pendingApply = store.applyRouteContext();
  const tab = stubTab();
  try {
    assert.equal(store.getState().status, VIEW_CONTEXT_STATUS.PENDING);
    const result = await api.rejectWorktree('todo-1', '');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'workspace-folder-required');
    assert.deepEqual(tab.urls(), [], 'a pending tab may not write into the global cwd');
  } finally {
    gate.resolve({ workspaceFile: WORKSPACE_FILE, workspaceFolder: WORKSPACE_FOLDER });
    await pendingApply;
    tab.restore();
  }
});

test('a worktree write with an explicit folder still reaches the scoped endpoint', async () => {
  setSharedViewContextStore(null);
  const tab = stubTab();
  try {
    await api.rejectWorktree('todo-1', WORKSPACE_FOLDER);
    assert.equal(tab.requests.length, 1, 'the authorized write is untouched by the new guard');
    assert.deepEqual(queryOf(tab.requests[0].url).get('workspaceFolder'), null,
      'the list query keeps its own shape; the write carries the folder in the body');
    assert.equal(tab.body(0).workspaceFolder, WORKSPACE_FOLDER);
    await api.startWorktreeMerge('todo-2', WORKSPACE_FOLDER, { instructions: 'go' });
    assert.equal(tab.requests.length, 2);
    assert.equal(tab.body(1).workspaceFolder, WORKSPACE_FOLDER);
  } finally {
    tab.restore();
  }
});

test('the worktree panel blocks every write dispatch through one guard', () => {
  const source = readSource('app_front/features/git/worktreeList.js');
  assert.match(source, /function guardWorktreeAction\(/,
    'the panel owns one scope guard for reads and writes');
  assert.match(source, /if \(isWorktreeListBlocked\(\)\)/,
    'a pending or missing link blocks the action');
  const dispatches = source.slice(source.indexOf('async function openDiff'));
  const guarded = dispatches.match(/if \(!guardWorktreeAction\(/g) || [];
  assert.ok(guarded.length >= 4,
    `merge, reject, cleanup and the diff/preview reads must all be guarded (found ${guarded.length})`);
});

test('the terminal declares its per-tab scope so the server cannot fall back to the global cwd', () => {
  const terminal = readSource('app_front/terminal.js');
  assert.match(terminal, /if \(hasExplicitViewContextWorkspace\(\)\) params\.set\('scoped', '1'\);/,
    'an explicit per-tab context must be declared on the WS connect');
  assert.match(terminal, /isViewContextScopedAccessAllowed\(\)/,
    'the client-side block stays: a pending link never connects');

  const router = readSource('lib/ws/ws-router.js');
  const branch = router.slice(router.indexOf("const isAgent = urlPath === '/ws-agent'"));
  const ptyIndex = branch.indexOf('handlePtyConnection(');
  assert.ok(ptyIndex > 0);
  const scopedIndex = branch.indexOf("params.get('scoped')");
  assert.ok(scopedIndex > 0 && scopedIndex < ptyIndex,
    'the scoped marker must be parsed before the PTY handler runs');

  const handler = readSource('lib/ws/pty-ws-handler.js');
  const guardIndex = handler.indexOf('resolvePtyScopedCwd(');
  const spawnIndex = handler.indexOf('pty.spawn(');
  assert.ok(guardIndex > 0, 'the handler must resolve the terminal cwd through the scoped helper');
  assert.ok(spawnIndex > guardIndex, 'the guard must run before any PTY is spawned');
});
