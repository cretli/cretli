/**
 * Scoped Git boot (navigation plan stage 2, review round 2).
 *
 * A deep link that pins an explicit `ws`/`folder` owns this tab's Git scope.
 * While that target is unresolved (pending after the bounded boot wait,
 * missing, or conflicting) nothing scoped may be opened, fetched or written —
 * in particular `GET /api/git/info` must never be issued without a
 * `workspaceFolder`, because the route would then answer with the shared
 * settings cwd, i.e. a DIFFERENT workspace's state. The Git badge is the exact
 * path the review found: `routeWorkspaceGit` fetched the empty scope.
 *
 * The fetch layer is exercised behaviourally (stubbed `globalThis.fetch`, so
 * the assertion is "no request left the tab", not a source scan), and the App
 * boot wiring is locked by a source contract because App.js cannot be imported.
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createViewContextStore } from '../app_front/app/appShell/viewContext.js';
import {
  isViewContextScopedAccessAllowed,
  setSharedViewContextStore,
} from '../app_front/app/appShell/viewContextBridge.js';
import { getGitInfo, invalidateStartupGetCache } from '../app_front/core/api/index.js';
import { refreshGitContextBadge } from '../app_front/features/git/gitContextBadge.js';
import { resetGitScopeForTests, setGitScope } from '../app_front/features/git/gitScope.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_A = '0e6a6f32-2b8c-4921-9041-e5b230e7b793';

/**
 * @returns {{ promise: Promise<object>, resolve: Function }}
 */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Installs a fetch stub that records every request URL, plus the minimal DOM
 * the Git badge needs. Restored by `restore()`.
 *
 * @returns {{ urls: string[], restore: () => void }}
 */
function stubNetwork() {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { status: 200, json: async () => ({ ok: true, isRepo: true, branch: 'main' }) };
  };
  const badgeEl = {
    hidden: true,
    textContent: '',
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
  globalThis.document = { getElementById: () => badgeEl };
  globalThis.window = typeof previousWindow !== 'undefined' && previousWindow
    ? previousWindow
    : { addEventListener() {}, dispatchEvent: () => true };
  return {
    urls,
    restore: () => {
      globalThis.fetch = previousFetch;
      if (typeof previousDocument === 'undefined') delete globalThis.document;
      else globalThis.document = previousDocument;
      if (typeof previousWindow === 'undefined') delete globalThis.window;
      else globalThis.window = previousWindow;
      setSharedViewContextStore(null);
    },
  };
}

/**
 * Store pinned to `/git?ws=…` whose resolver answer is handed to the test, so
 * the pending window is fully under control (no timers involved).
 *
 * @param {{ resolve: () => Promise<object> }} resolver
 */
function pendingGitStore(resolver) {
  return createViewContextStore({
    readLocation: () => ({ pathname: '/git', search: `?ws=${WS_A}` }),
    resolveWorkspace: () => resolver(),
    readyTimeoutMs: 30,
  });
}

test.afterEach(() => {
  setSharedViewContextStore(null);
  resetGitScopeForTests();
});

// The startup GET cache is module state: a URL read by an earlier test must not answer a later one.
beforeEach(() => invalidateStartupGetCache());

test('an unscoped Git read is refused while the link\'s explicit workspace is still pending', async () => {
  const net = stubNetwork();
  try {
    const gate = deferred();
    const store = pendingGitStore(() => gate.promise);
    setSharedViewContextStore(store);
    const applied = store.applyRouteContext();
    assert.equal(store.getState().status, 'pending', 'the target is mid-resolve');
    assert.equal(isViewContextScopedAccessAllowed(), false);

    const info = await getGitInfo(null);
    assert.deepEqual(net.urls, [], 'no /api/git/info may leave the tab (it would read the global cwd)');
    assert.equal(info.ok, false);
    assert.equal(info.code, 'view-context-pending');

    gate.resolve({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app', workspaceKey: WS_A });
    await applied;
    assert.equal(store.getState().status, 'resolved');
  } finally {
    net.restore();
  }
});

test('a missing or conflicting target keeps refusing unscoped Git reads', async () => {
  const net = stubNetwork();
  try {
    const missing = pendingGitStore(async () => ({ error: 'workspace-unknown' }));
    setSharedViewContextStore(missing);
    await missing.applyRouteContext();
    assert.equal(missing.getState().status, 'missing-target');
    const info = await getGitInfo({ workspaceFolder: '' });
    assert.deepEqual(net.urls, [], 'an empty scope must not be sent for a missing target either');
    assert.equal(info.code, 'view-context-pending');

    // The same link conflicts on a foreign chat: still no unscoped read.
    const conflict = pendingGitStore(async () => ({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app' }));
    setSharedViewContextStore(conflict);
    await conflict.applyRouteContext();
    const bad = conflict.reportResourceConflict('chat', { workspaceFile: '/ws/beta' });
    assert.equal(bad.ok, false, 'the conflict is reported');
    const conflictInfo = await getGitInfo(null);
    assert.equal(conflictInfo.code, 'view-context-pending');
    assert.equal(net.urls.length, 0, 'the conflict added no request');
  } finally {
    net.restore();
  }
});

test('a resolved link sends the scoped folder, and a request with a real selector is never blocked', async () => {
  const net = stubNetwork();
  try {
    const store = pendingGitStore(async () => ({
      workspaceFile: '/ws/alpha',
      workspaceFolder: '/ws/alpha/app',
      workspaceKey: WS_A,
    }));
    setSharedViewContextStore(store);
    await store.applyRouteContext();

    await getGitInfo({ workspaceFolder: '/ws/alpha/app' });
    assert.deepEqual(net.urls, ['/api/git/info?workspaceFolder=%2Fws%2Falpha%2Fapp'],
      'the resolved runtime folder is carried in the query');

    // A chat/task scope is authorized by the durable server record, not the
    // pending link: the gate must not swallow it even while unresolved.
    net.urls.length = 0;
    const pending = pendingGitStore(() => deferred().promise);
    setSharedViewContextStore(pending);
    await Promise.resolve();
    void pending.applyRouteContext();
    const chatScoped = await getGitInfo({ chatId: 'chat-1' });
    assert.deepEqual(net.urls, ['/api/git/info?chatId=chat-1']);
    assert.equal(chatScoped.ok, true, 'the stubbed server answered normally');
  } finally {
    net.restore();
  }
});

test('a link without explicit ws/folder keeps the legacy global-cwd Git read', async () => {
  const net = stubNetwork();
  try {
    const store = createViewContextStore({
      readLocation: () => ({ pathname: '/git', search: '' }),
      resolveWorkspace: async () => ({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha' }),
      readyTimeoutMs: 30,
    });
    setSharedViewContextStore(store);
    await store.applyRouteContext();
    await getGitInfo(null);
    assert.deepEqual(net.urls, ['/api/git/info'], 'the default context may still read the shared cwd');
  } finally {
    net.restore();
  }
});

test('the Git badge does not fetch a workspace it has not resolved yet', async () => {
  const net = stubNetwork();
  try {
    const gate = deferred();
    const store = pendingGitStore(() => gate.promise);
    setSharedViewContextStore(store);
    const applied = store.applyRouteContext();
    resetGitScopeForTests();

    await refreshGitContextBadge({ force: true });
    assert.deepEqual(net.urls, [], 'routeWorkspaceGit must not fetch while the target is pending');

    gate.resolve({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app', workspaceKey: WS_A });
    await applied;
    setGitScope({ chatId: '', todoId: '', workspaceFolder: '/ws/alpha/app' }, { lock: false });
    await refreshGitContextBadge({ force: true });
    assert.deepEqual(net.urls, ['/api/git/info?workspaceFolder=%2Fws%2Falpha%2Fapp'],
      'the late resolve resumes the badge with the scoped request');
  } finally {
    net.restore();
  }
});

test('the badge drops a STALE folder scope instead of painting it under a new pending link', async () => {
  const net = stubNetwork();
  try {
    resetGitScopeForTests();
    // The tab already showed one workspace; a new deep link now pins another and
    // is still resolving. That leftover folder is a real selector, so the API
    // guard alone cannot stop the chip from keeping the OLD branch on screen —
    // only the caller-level scoped-access gate can.
    setGitScope({ chatId: '', todoId: '', workspaceFolder: '/ws/previous' }, { lock: false });
    const gate = deferred();
    const store = pendingGitStore(() => gate.promise);
    setSharedViewContextStore(store);
    const applied = store.applyRouteContext();
    assert.equal(store.getState().status, 'pending');

    await refreshGitContextBadge({ force: true });
    assert.deepEqual(net.urls, [], 'no scoped read may run against the unresolved link');

    gate.resolve({ workspaceFile: '/ws/alpha', workspaceFolder: '/ws/alpha/app', workspaceKey: WS_A });
    await applied;
    setGitScope({ chatId: '', todoId: '', workspaceFolder: '/ws/alpha/app' }, { lock: false });
    await refreshGitContextBadge({ force: true });
    assert.deepEqual(net.urls, ['/api/git/info?workspaceFolder=%2Fws%2Falpha%2Fapp'],
      'the resolved link is what finally paints');
  } finally {
    net.restore();
  }
});

test('worktree list refresh refuses an empty folder while the link is unresolved', () => {
  const source = fs.readFileSync(path.join(root, 'app_front/features/git/worktreeList.js'), 'utf8');
  assert.match(source, /function isWorktreeListBlocked\(\)/);
  assert.match(source, /if \(isWorktreeListBlocked\(\)\)/);
  assert.match(source, /viewContextRuntimeParams\(getViewContextState\(\)/);
});

test('terminal WS connections carry explicit workspace scope', () => {
  const source = fs.readFileSync(path.join(root, 'app_front/features/terminal/services/terminalConnection.js'), 'utf8');
  assert.match(source, /getViewContextRuntimeScope\(\)/);
  assert.match(source, /workspaceFolder/);
  assert.match(source, /isViewContextScopedAccessAllowed\(\)/);
});

test('the App boot defers scoped passes until the explicit target resolved', () => {
  const gitScope = fs.readFileSync(path.join(root, 'app_front/app/appShell/gitRouteScope.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app_front/app/appShell/bootApp.js'), 'utf8');
  const gate = gitScope.slice(gitScope.indexOf('function applyRouteGitScope()'));
  const gateBody = gate.slice(0, gate.indexOf('window.addEventListener'));
  assert.match(gateBody, /isViewContextScopedAccessAllowed\(\)/,
    'the route scope must not be written while the target is unresolved');

  const boot = app.slice(app.indexOf('function bootApp()'));
  assert.match(boot, /const scopedBootPass = whenViewContextReady\(\)\.then\(\(\) => whenViewContextScopedAccessAllowed\(\)\)/,
    'the bounded boot wait is followed by the scoped-access gate, so a timeout never falls back');
  assert.match(boot, /scopedBootPass\.then\(\(\) => \{\s*void loadChatsFromServer\(\{ preferChatId: readRequestedChatId\(\) \}\)/,
    'the chat list load resumes exactly once on the late resolve');
  assert.match(boot, /scopedBootPass\.then\([\s\S]*spaNav\.bootApply\(/,
    'the first route apply runs only with a resolved context');
  assert.doesNotMatch(boot, /void whenViewContextReady\(\)\.then\(\(\) => \{\s*(void loadChatsFromServer|applyRouteGitScope)/,
    'no scoped boot pass may hang off the bounded wait alone');
});
