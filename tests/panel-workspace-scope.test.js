import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { registerTasksAgentsRoutes } from '../lib/routes/tasks-agents-routes.js';
import { buildBrowserWsUrl } from '../app_front/features/browser/browserWsClient.js';
import {
  getViewContextRuntimeScope,
  setSharedViewContextStore,
  whenViewContextRuntimeReady,
} from '../app_front/app/appShell/viewContextBridge.js';
import { createViewContextStore, VIEW_CONTEXT_STATUS } from '../app_front/app/appShell/viewContext.js';
import { watcherApi } from '../app_front/features/settings/watcher/api.js';

function load(file, globals, typescript = false) {
  let source = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (typescript) source = stripTypeScriptTypes(source);
  const context = vm.createContext({ URLSearchParams, process, ...globals });
  vm.runInContext(source.replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, ''), context);
  return context;
}
const scope = { workspaceFile: 'cretli:ws:acme', workspaceFolder: '/ws/acme' };

test('task API lists runs and definitions for the tab and blocks pending scopes', async () => {
  const urls = [];
  let allowed = true;
  const api = load('../app_front/core/api/tasks.js', {
    getViewContextRuntimeScope: () => scope,
    isViewContextScopedAccessAllowed: () => allowed,
    dedupeGetJson: async (url) => { urls.push(url); return { ok: true }; },
    apiFetchJson: async (url) => { urls.push(url); return { ok: true }; },
  });
  await api.getTaskRuns();
  await api.getTasks({ ...scope, fresh: true });
  for (const url of urls) {
    const params = new URL(url, 'http://localhost').searchParams;
    assert.equal(params.get('workspaceFolder'), scope.workspaceFolder);
    assert.equal(params.get('workspaceFile'), scope.workspaceFile);
  }
  allowed = false;
  assert.equal((await api.getTaskRuns()).ok, false);
  assert.equal((await api.getTasks(scope)).ok, false);
  assert.equal(urls.length, 2);
});

test('task run listing selects a local folder and workspace instead of the global default', () => {
  const routes = new Map();
  registerTasksAgentsRoutes({ get: (p, fn) => routes.set(p, fn), delete() {} }, {
    buildTaskRunScopeSnapshot: () => { throw new Error('global selection used'); },
    taskRuns: new Map([
      ['acme', { taskLabel: 'build', workspaceFile: scope.workspaceFile, cwd: scope.workspaceFolder }],
      ['other', { taskLabel: 'build', workspaceFile: 'cretli:ws:other', cwd: '/ws/other' }],
      ['same-folder', { taskLabel: 'build', workspaceFile: 'cretli:ws:other', cwd: scope.workspaceFolder }],
    ]),
  });
  let result;
  routes.get('/api/task-runs')({ query: scope }, { json: (data) => { result = data; } });
  assert.deepEqual(result.runs.map((run) => run.runId), ['acme']);
});

test('task socket reconnect and launch use the requested scope', () => {
  const launched = [];
  const h = load('../lib/ws/task-ws-handler.ts', {
    BUILD_TASK_LABEL: 'front', TASK_RUN_BUFFER_MAX: 100,
    canAcceptNewRun: () => true, assertExecutorLaunchAllowed() {}, trackChildProcess() {},
    pty: { spawn: (command, args, options) => { launched.push({ command, options }); return { onData() {}, onExit() {} }; } },
  }, true);
  const messages = [];
  const ws = { readyState: 1, send: (data) => messages.push(JSON.parse(data)), on() {}, close: () => { ws.closed = true; } };
  const runs = new Map([['running', { workspaceFile: scope.workspaceFile, cwd: scope.workspaceFolder, clients: new Set(), buffer: 'acme output' }]]);
  const ctx = {
    taskRuns: runs,
    buildTaskRunScopeSnapshot: () => { throw new Error('global scope used'); },
    isTaskRunInScope: (run, selected) => run.workspaceFile === selected.workspaceFile && run.cwd === selected.cwd,
    loadCurrentTasks: () => { throw new Error('global task definitions used'); },
    loadTasksForWorkspace: (selected) => {
      assert.equal(selected.workspaceFile, scope.workspaceFile);
      assert.equal(selected.workspaceFolder, scope.workspaceFolder);
      return { tasks: [{ label: 'build', type: 'shell', command: 'acme-build', cwd: scope.workspaceFolder }] };
    },
    buildInteractivePtyEnv: () => ({}), randomSessionId: () => 'new-run',
  };
  h.handleTaskConnection(ws, 'build', 'running', scope.workspaceFile, ctx, scope.workspaceFolder);
  assert.equal(messages[0].data, 'acme output');
  assert.equal(ws.closed, undefined);
  h.handleTaskConnection(ws, 'build', null, scope.workspaceFile, ctx, scope.workspaceFolder);
  assert.equal(launched[0].command, process.env.SHELL || 'bash');
  assert.equal(launched[0].options.cwd, scope.workspaceFolder);
  assert.equal(runs.get('new-run').workspaceFile, scope.workspaceFile);
  assert.equal(runs.get('new-run').cwd, scope.workspaceFolder);
  h.handleTaskConnection(ws, 'build', 'running', 'cretli:ws:other', ctx, '/ws/other');
  assert.equal(ws.closed, true);
});

test('Browser socket sends the tab workspace with session and tab ids', () => {
  setSharedViewContextStore({ getState: () => ({ runtime: scope }) });
  try {
    const url = new URL(buildBrowserWsUrl({ host: 'localhost', sessionId: 'session', tabId: 'tab' }));
    assert.equal(url.searchParams.get('workspaceFile'), scope.workspaceFile);
    assert.equal(url.searchParams.get('workspaceFolder'), scope.workspaceFolder);
    assert.equal(url.searchParams.get('session'), 'session');
  } finally {
    setSharedViewContextStore(null);
  }
});


test('Browser policy waits for runtime scope and sends it on reads and mutations', async () => {
  const requests = [];
  let ready;
  const pending = new Promise((resolve) => { ready = resolve; });
  let runtime = { workspaceFile: '', workspaceFolder: '' };
  const api = load('../app_front/core/api/settings.js', {
    getViewContextRuntimeScope: () => runtime,
    whenViewContextRuntimeReady: () => pending,
    dedupeGetJson: async (url) => { requests.push({ url }); return { ok: true }; },
    apiFetchJson: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
  });
  const read = api.getBrowserPolicy();
  assert.equal(requests.length, 0, 'boot must not send an unscoped request');
  runtime = scope;
  ready();
  await read;
  await api.patchBrowserPolicy({ allowSelfOrigin: true });
  await api.deleteBrowserFolderOverride('/ws/acme/override');
  for (const request of [requests[0], requests[2]]) {
    const params = new URL(request.url, 'http://localhost').searchParams;
    assert.equal(params.get('workspaceFile'), scope.workspaceFile);
    assert.equal(params.get('workspaceFolder'), scope.workspaceFolder);
  }
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.workspaceFile, scope.workspaceFile);
  assert.equal(body.workspaceFolder, scope.workspaceFolder);
  assert.equal(body.policy.allowSelfOrigin, true);
});

test('Watcher production wrapper waits for scope and serializes scope for reads and writes', async () => {
  const requests = [];
  let ready;
  const pending = new Promise((resolve) => { ready = resolve; });
  let folder = '';
  const { scopeWatcherRequestToWorkspace } = await import('../app_front/features/watcher/watcherWorkspaceScope.js');
  const api = load('../app_front/features/settings/watcher/api.js', {
    whenViewContextRuntimeReady: () => pending,
    getWatcherWorkspaceFolder: () => folder,
    scopeWatcherRequestToWorkspace,
    isWorkspaceWatcherRead: () => false,
    getCurrentLang: () => 'en',
    cretliApiFetch: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, json: async () => ({ ok: true }) };
    },
  });
  const read = api.watcherApi('/api/workspace-watcher/stats');
  assert.equal(requests.length, 0);
  // Runtime control is global and remains available before workspace boot.
  await api.watcherApi('/api/workspace-watcher/runtime-control');
  assert.equal(requests[0].url, '/api/workspace-watcher/runtime-control');
  folder = scope.workspaceFolder;
  ready();
  await read;
  await api.watcherApi('/api/workspace-watcher/pause', { method: 'POST' });
  await api.watcherApi('/api/workspace-watcher', { method: 'PATCH', body: { mode: 'off' } });
  assert.equal(new URL(requests[1].url, 'http://localhost').searchParams.get('workspaceFolder'), folder);
  for (const request of requests.slice(2)) {
    assert.equal(JSON.parse(request.options.body).workspaceFolder, folder);
    assert.equal(request.options.headers['Content-Type'], 'application/json');
  }
  assert.equal(JSON.parse(requests[3].options.body).mode, 'off');
});


test('resolved route-only boot with empty runtime parks Watcher and Browser policy until settings supply scope', async () => {
  const store = createViewContextStore({
    readLocation: () => ({ pathname: '/chat', search: '' }),
    getDefaultContext: async () => ({ workspaceFile: ' ', workspaceFolder: ' ' }),
  });
  await store.applyRouteContext();
  assert.equal(store.getState().status, VIEW_CONTEXT_STATUS.RESOLVED);
  assert.deepEqual(store.getState().runtime, { workspaceFile: '', workspaceFolder: '' });
  setSharedViewContextStore(store);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const browserApi = load('../app_front/core/api/settings.js', {
    getViewContextRuntimeScope,
    whenViewContextRuntimeReady,
    dedupeGetJson: async (url) => { requests.push({ url }); return { ok: true }; },
    apiFetchJson: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
  });
  try {
    const calls = [
      watcherApi('/api/workspace-watcher/stats'),
      watcherApi('/api/workspace-watcher/pause', { method: 'POST' }),
      browserApi.getBrowserPolicy(),
      browserApi.patchBrowserPolicy({ allowSelfOrigin: true }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, 'resolved status alone must not send requests');
    store.markDefaultReady({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0, 'empty default settings must not release requests');
    store.markDefaultReady(scope);
    await Promise.all(calls);
    assert.equal(requests.length, 4);
    for (const request of requests) {
      const params = new URL(request.url, 'http://localhost').searchParams;
      const body = JSON.parse(request.options?.body || '{}');
      assert.equal(params.get('workspaceFolder') || body.workspaceFolder, scope.workspaceFolder);
    }
  } finally {
    globalThis.fetch = originalFetch;
    setSharedViewContextStore(null);
  }
});
