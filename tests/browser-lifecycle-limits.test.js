/**
 * P2c Browser lifecycle tests: global/per-workspace caps, bounded metrics,
 * respawn backoff, the crash hook, the persistent PID store and the boot orphan
 * sweep. Uses a fake driver — no real Chromium is launched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { BrowserError, BrowserSessionManager } from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import {
  BrowserMetrics,
  createPidStore,
  createRespawnController,
  resolveLifecycleLimits,
} from '../lib/browser/lifecycle.js';
import { registerBrowserRoutes } from '../lib/browser/routes.js';

/** Limits that disable both new caps for tests that do not exercise them. */
const UNCAPPED = Object.freeze({ maxSessionsGlobal: 100, maxSessionsPerWorkspace: 100 });

/**
 * @param {unknown} value
 * @param {string[]} [out]
 * @returns {string[]} every object key found anywhere in `value`
 */
function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** Minimal in-memory Playwright stand-in with a crash-capable browser. */
function createFakeDriver() {
  const state = { browsers: [], contexts: [], pages: [], launchOptions: [], launchError: null, nextPid: 7000 };

  class FakePage {
    constructor(context) {
      this._context = context;
      this._handlers = new Map();
      this._closed = false;
      this._url = 'about:blank';
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    async goto(url) { this._url = url; }
    async goBack() {}
    async goForward() {}
    async reload() {}
    async title() { return 'fake'; }
    url() { return this._url; }
    context() { return this._context; }
    viewportSize() { return { width: 390, height: 844 }; }
    async setViewportSize() {}
    async screenshot() { return Buffer.from('fake-jpeg'); }
    async close() {
      this._closed = true;
      this.emit('close');
    }
  }

  class FakeContext {
    constructor(browser) {
      this.browser = browser;
      this.pages = [];
      this.routes = [];
      this._handlers = new Map();
      this.closed = false;
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    async route(_pattern, handler) { this.routes.push(handler); }
    async newPage() {
      const page = new FakePage(this);
      this.pages.push(page);
      state.pages.push(page);
      for (const handler of this._handlers.get('page') || []) handler(page);
      return page;
    }
    async close() {
      for (const page of this.pages) {
        if (!page._closed) await page.close();
      }
      this.closed = true;
    }
  }

  class FakeBrowser {
    constructor() {
      this.closed = false;
      this.pid = state.nextPid;
      state.nextPid += 1;
      this._handlers = new Map();
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    process() { return { pid: this.pid }; }
    async newContext(options) {
      this.contextOptions = options || {};
      const context = new FakeContext(this);
      state.contexts.push(context);
      return context;
    }
    isConnected() { return !this.closed; }
    async close() { this.closed = true; }
  }

  return {
    state,
    driver: {
      name: 'fake',
      executablePath: '/usr/bin/chromium',
      async launch(options) {
        state.launchOptions.push(options || {});
        if (state.launchError) throw state.launchError;
        const browser = new FakeBrowser();
        state.browsers.push(browser);
        return browser;
      },
    },
  };
}

/**
 * @param {object} [overrides]
 */
function createManager(overrides = {}) {
  const { driver, state } = createFakeDriver();
  let clock = 1_000_000;
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available', executablePath: '/usr/bin/chromium' },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [],
    now: () => clock,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    killTree: () => true,
    lifecycleLimits: UNCAPPED,
    ...overrides,
  });
  return { manager, driver, state, setClock: (value) => { clock = value; }, getClock: () => clock };
}

test('resolveLifecycleLimits prefers env overrides and ignores invalid values', () => {
  const limits = resolveLifecycleLimits({
    CRETLI_BROWSER_MAX_SESSIONS_GLOBAL: '5',
    CRETLI_BROWSER_MAX_SESSIONS_PER_WORKSPACE: '0',
    CRETLI_BROWSER_RESPAWN_MAX_ATTEMPTS: 'oops',
    CRETLI_BROWSER_RESPAWN_BASE_DELAY_MS: '250',
    CRETLI_BROWSER_RESPAWN_MAX_DELAY_MS: '-5',
    CRETLI_BROWSER_RESPAWN_WINDOW_MS: '1000',
    CRETLI_BROWSER_METRICS_MAX_WORKSPACES: '7',
  }, BROWSER_LIMITS);

  assert.equal(limits.maxSessionsGlobal, 5);
  assert.equal(limits.maxSessionsPerWorkspace, BROWSER_LIMITS.MAX_SESSIONS_PER_WORKSPACE);
  assert.equal(limits.respawnMaxAttempts, BROWSER_LIMITS.RESPAWN_MAX_ATTEMPTS);
  assert.equal(limits.respawnBaseDelayMs, 250);
  assert.equal(limits.respawnMaxDelayMs, BROWSER_LIMITS.RESPAWN_MAX_DELAY_MS);
  assert.equal(limits.respawnWindowMs, 1000);
  assert.equal(limits.metricsMaxWorkspaces, 7);
});

test('global session limit rejects the session above the cap', async () => {
  const { manager } = createManager({
    lifecycleLimits: { maxSessionsGlobal: 2, maxSessionsPerWorkspace: 100 },
  });
  await manager.createSession({ ownerSessionId: 'o1', workspaceFile: '/ws/1' });
  await manager.createSession({ ownerSessionId: 'o2', workspaceFile: '/ws/2' });

  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'o3', workspaceFile: '/ws/3' }),
    (err) => err instanceof BrowserError && err.code === 'global-session-limit' && err.status === 409,
  );
  assert.equal(manager.sessions.size, 2);
  await manager.closeAll('test');
});

test('per-workspace limit counts owners and rejects the second session in one workspace', async () => {
  const { manager } = createManager({
    lifecycleLimits: { maxSessionsGlobal: 100, maxSessionsPerWorkspace: 1 },
  });
  await manager.createSession({ ownerSessionId: 'o1', workspaceFile: '/ws/a' });
  await manager.createSession({ ownerSessionId: 'o2', workspaceFile: '/ws/b' });

  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'o3', workspaceFile: '/ws/a' }),
    (err) => err instanceof BrowserError && err.code === 'workspace-session-limit' && err.status === 409,
  );
  assert.equal(manager.sessions.size, 2);
  await manager.closeAll('test');
});

test('per-owner limit still rejects the fourth session for one owner', async () => {
  const { manager } = createManager();
  await manager.createSession({ ownerSessionId: 'owner', workspaceFile: '/ws/1' });
  await manager.createSession({ ownerSessionId: 'owner', workspaceFile: '/ws/2' });
  await manager.createSession({ ownerSessionId: 'owner', workspaceFile: '/ws/3' });

  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'owner', workspaceFile: '/ws/4' }),
    (err) => err instanceof BrowserError && err.code === 'session-limit',
  );
  await manager.closeAll('test');
});

test('BrowserMetrics counts lifecycle, tabs, errors and respawns per workspace', () => {
  const metrics = new BrowserMetrics({ maxWorkspaces: 2, now: () => 1234 });
  metrics.recordSessionStart('/ws/a', 10);
  metrics.recordTabOpen('/ws/a', 11);
  metrics.recordSessionError('/ws/a', 'launch-failed', 12);
  metrics.recordRespawn('/ws/a', { ok: true, at: 13 });
  metrics.recordRespawn('/ws/a', { ok: false, at: 14 });
  metrics.recordSessionClose('/ws/a', { lifetimeMs: 50, at: 15 });
  metrics.recordOrphanSweep({ killed: 2, checked: 3 });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.global.sessionsStarted, 1);
  assert.equal(snapshot.global.sessionsClosed, 1);
  assert.equal(snapshot.global.sessionErrors, 1);
  assert.equal(snapshot.global.tabsOpened, 1);
  assert.equal(snapshot.global.respawns, 2);
  assert.equal(snapshot.global.respawnFailures, 1);
  assert.equal(snapshot.global.orphanSweeps, 1);
  assert.equal(snapshot.global.orphansKilled, 2);
  assert.equal(snapshot.global.lifetimeMsTotal, 50);
  assert.equal(snapshot.global.lifetimeMsMax, 50);
  assert.equal(snapshot.global.lastSessionAt, 15);

  const workspace = snapshot.workspaces.find((entry) => entry.workspaceKey === '/ws/a');
  assert.equal(workspace.sessionsStarted, 1);
  assert.equal(workspace.sessionsClosed, 1);
  assert.equal(workspace.sessionErrors, 1);
  assert.equal(workspace.tabsOpened, 1);
  assert.equal(workspace.respawns, 2);
  assert.equal(workspace.respawnFailures, 1);
  assert.equal(workspace.lifetimeMsTotal, 50);
  assert.equal(workspace.lifetimeMsMax, 50);
});

test('metrics snapshot keeps at most maxWorkspaces buckets with LRU eviction', () => {
  const metrics = new BrowserMetrics({ maxWorkspaces: 2, now: () => 0 });
  metrics.recordSessionStart('/ws/1', 1);
  metrics.recordSessionStart('/ws/2', 2);
  metrics.recordSessionStart('/ws/3', 3); // evicts /ws/1
  metrics.recordSessionStart('/ws/2', 4); // refreshes /ws/2
  metrics.recordSessionStart('/ws/4', 5); // evicts /ws/3

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.workspaces.length, 2);
  assert.deepEqual(snapshot.workspaces.map((entry) => entry.workspaceKey).sort(), ['/ws/2', '/ws/4']);
  assert.equal(snapshot.global.sessionsStarted, 5);
});

test('manager records metrics on session start, tab open and close', async () => {
  const metrics = new BrowserMetrics({ maxWorkspaces: 5, now: () => 1000 });
  const { manager } = createManager({ metrics });
  const session = await manager.createSession({ ownerSessionId: 'o-metrics', workspaceFile: '/ws/metrics' });

  let snapshot = manager.metricsSnapshot();
  assert.equal(snapshot.global.sessionsStarted, 1);
  assert.equal(snapshot.global.tabsOpened, 1);
  assert.equal(snapshot.live.globalSessions, 1);
  assert.deepEqual(snapshot.live.workspaces, [{ workspaceKey: '/ws/metrics', active: 1 }]);

  await manager.closeSession(session.browserSessionId, 'o-metrics', { reason: 'test' });
  snapshot = manager.metricsSnapshot();
  assert.equal(snapshot.global.sessionsClosed, 1);
  assert.equal(snapshot.live.globalSessions, 0);
});

test('manager records a session error when the driver launch fails', async () => {
  const { manager, state } = createManager();
  state.launchError = new Error('no chromium');

  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'o-err', workspaceFile: '/ws/err' }),
    (err) => err instanceof BrowserError && err.code === 'browser-unavailable',
  );
  const snapshot = manager.metricsSnapshot();
  assert.equal(snapshot.global.sessionErrors, 1);
  const workspace = snapshot.workspaces.find((entry) => entry.workspaceKey === '/ws/err');
  assert.equal(workspace.sessionErrors, 1);
});

test('manager registers the Chromium pid on create and removes it on close', async () => {
  const writes = [];
  const pidStore = {
    read: () => [],
    write: (entries) => { writes.push(entries.map((entry) => entry.pid)); return true; },
    clear: () => true,
  };
  const { manager } = createManager({ pidStore });
  const session = await manager.createSession({ ownerSessionId: 'o-pid', workspaceFile: '/ws/pid' });

  assert.equal(writes.length >= 1, true);
  assert.equal(writes.at(-1).length, 1);
  assert.equal(Number.isInteger(writes.at(-1)[0]), true);

  await manager.closeSession(session.browserSessionId, 'o-pid', { reason: 'test' });
  assert.equal(writes.at(-1).length, 0);
});

test('respawn controller backs off exponentially and resolves true on success', async () => {
  const delays = [];
  let launches = 0;
  const controller = createRespawnController({
    launch: async () => {
      launches += 1;
      if (launches <= 2) throw new Error('crash');
      return 'ok';
    },
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 10000,
    windowMs: 60000,
    now: () => 1000,
    setTimeoutFn: (fn, delay) => { delays.push(delay); fn(); },
  });

  assert.equal(await controller.schedule('crash-1'), false);
  assert.equal(await controller.schedule('crash-2'), false);
  assert.equal(await controller.schedule('crash-3'), true);

  const status = controller.status();
  assert.equal(status.attempts, 3);
  assert.equal(status.exhausted, false);
  assert.equal(status.lastReason, 'crash-3');
  assert.notEqual(status.lastOkAt, null);
  assert.deepEqual(delays, [100, 200, 400]);
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] > delays[i - 1]);
});

test('respawn controller exhausts at maxAttempts and reset clears the window', async () => {
  let launches = 0;
  const controller = createRespawnController({
    launch: async () => { launches += 1; return 'ok'; },
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 10,
    windowMs: 60000,
    now: () => 5000,
    setTimeoutFn: (fn) => fn(),
  });

  assert.equal(await controller.schedule('a'), true);
  assert.equal(await controller.schedule('b'), true);
  assert.equal(await controller.schedule('c'), false);
  const exhausted = controller.status();
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attempts, 2);
  assert.equal(launches, 2);

  controller.reset();
  const afterReset = controller.status();
  assert.equal(afterReset.attempts, 0);
  assert.equal(afterReset.exhausted, false);
  assert.equal(await controller.schedule('d'), true);
});

test("driver 'disconnected' schedules a respawn unless the session is closing", async () => {
  const respawnCalls = [];
  const respawn = {
    schedule: (reason) => { respawnCalls.push(reason); return Promise.resolve(true); },
    status: () => ({ attempts: respawnCalls.length, exhausted: false }),
  };
  const { manager, state } = createManager({ respawn });
  const session = await manager.createSession({ ownerSessionId: 'o-crash', workspaceFile: '/ws/crash' });
  const browser = state.browsers[0];

  browser.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(respawnCalls, ['chromium-disconnected']);

  const internal = manager.sessions.get(session.browserSessionId);
  internal.closing = true;
  browser.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(respawnCalls.length, 1);

  const snapshot = manager.metricsSnapshot();
  assert.equal(snapshot.global.respawns, 1);
  assert.equal(snapshot.global.respawnFailures, 0);

  internal.closing = false;
  await manager.closeSession(session.browserSessionId, 'o-crash', { reason: 'test' });
});

test('startup sweep kills only live Chromium pids and clears the store', async () => {
  const pids = [
    { pid: 111, executablePath: '/usr/bin/chromium', recordedAt: 1 },
    { pid: 222, executablePath: '/usr/bin/chromium', recordedAt: 2 },
    { pid: 333, executablePath: '/usr/bin/chromium', recordedAt: 3 },
  ];
  let cleared = false;
  const killed = [];
  const pidStore = {
    read: () => pids.map((entry) => ({ ...entry })),
    write: () => true,
    clear: () => { cleared = true; return true; },
  };
  const metrics = new BrowserMetrics({ maxWorkspaces: 5, now: () => 0 });
  const { manager } = createManager({
    pidStore,
    metrics,
    isProcessAlive: (pid) => pid === 111 || pid === 222,
    looksLikeChromium: (pid) => pid === 111,
    killTree: (pid) => { killed.push(pid); return true; },
  });

  const result = await manager.startupSweep();
  assert.equal(result.checked, 3);
  assert.equal(result.killed, 1);
  assert.deepEqual(killed, [111]);
  assert.equal(cleared, true);

  const snapshot = manager.metrics.snapshot();
  assert.equal(snapshot.global.orphanSweeps, 1);
  assert.equal(snapshot.global.orphansKilled, 1);
});

test('startup sweep never throws when the pid store read fails', async () => {
  const pidStore = {
    read: () => { throw new Error('corrupt store'); },
    write: () => true,
    clear: () => { throw new Error('cannot clear'); },
  };
  const { manager } = createManager({ pidStore });
  const result = await manager.startupSweep();
  assert.deepEqual(result, { checked: 0, killed: 0 });
});

test('metrics snapshot exposes per-workspace counts without secret-looking fields', async () => {
  const metrics = new BrowserMetrics({ maxWorkspaces: 3, now: () => 0 });
  metrics.recordSessionStart('/ws/a', 1);
  metrics.recordTabOpen('/ws/a', 2);
  metrics.recordSessionError('/ws/a', 'launch-failed', 3);
  metrics.recordRespawn('/ws/a', { ok: false, at: 4 });

  const snapshot = metrics.snapshot();
  const workspace = snapshot.workspaces.find((entry) => entry.workspaceKey === '/ws/a');
  assert.equal(workspace.sessionsStarted, 1);
  assert.equal(workspace.tabsOpened, 1);
  assert.equal(workspace.sessionErrors, 1);
  assert.equal(workspace.respawns, 1);
  assert.equal(workspace.respawnFailures, 1);

  const { manager } = createManager({ metrics });
  for (const candidate of [snapshot, manager.metricsSnapshot()]) {
    const keys = collectKeys(candidate);
    for (const banned of ['cookie', 'authorization', 'token', 'url']) {
      assert.equal(
        keys.some((key) => key.toLowerCase().includes(banned)),
        false,
        `unexpected ${banned} field in metrics snapshot`,
      );
    }
  }
});

test('healthcheck reports driver, process, session counts and respawn state', async () => {
  const respawn = {
    schedule: () => Promise.resolve(false),
    status: () => ({ attempts: 1, exhausted: true, nextDelayMs: 10 }),
  };
  const { manager } = createManager({
    respawn,
    isProcessAlive: () => true,
    lifecycleLimits: { maxSessionsGlobal: 4, maxSessionsPerWorkspace: 2 },
  });
  const session = await manager.createSession({ ownerSessionId: 'o-h', workspaceFile: '/ws/h' });

  const health = manager.healthcheck();
  assert.equal(health.status, 'degraded');
  assert.equal(health.driver.available, true);
  assert.equal(health.process.alive, true);
  assert.equal(Number.isInteger(health.process.pid), true);
  assert.equal(health.sessions.global, 1);
  assert.equal(health.sessions.maxGlobal, 4);
  assert.deepEqual(health.sessions.workspaces, [{ workspaceKey: '/ws/h', active: 1, max: 2 }]);
  assert.equal(health.respawn.exhausted, true);

  await manager.closeSession(session.browserSessionId, 'o-h', { reason: 'test' });
});

test('setDriver swaps the runtime descriptor and healthcheck reports unavailable without one', () => {
  const { manager } = createManager();

  assert.equal(manager.setDriver(null), false);
  const unavailable = manager.healthcheck();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.driver.available, false);
  assert.equal(unavailable.process.pid, null);
  assert.equal(unavailable.process.alive, false);

  const nextDriver = { name: 'next', async launch() {} };
  assert.equal(manager.setDriver({ available: true, driver: nextDriver, status: 'available', version: '1.2.3' }), true);
  const health = manager.healthcheck();
  assert.equal(health.driver.available, true);
  assert.equal(health.driver.version, '1.2.3');
  assert.equal(health.status, 'ok');
});

test('createPidStore persists valid entries, clears them and works in memory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cretli-pid-store-'));
  try {
    const store = createPidStore(dir);
    assert.equal(store.write([
      { pid: 42, executablePath: '/usr/bin/chromium', recordedAt: 123 },
      { pid: -1, executablePath: '/nope', recordedAt: 1 },
      { nope: true },
    ]), true);
    const entries = store.read();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { pid: 42, executablePath: '/usr/bin/chromium', recordedAt: 123 });
    assert.equal(store.clear(), true);
    assert.deepEqual(store.read(), []);

    const memory = createPidStore('');
    assert.equal(memory.write([{ pid: 7, executablePath: '', recordedAt: 0 }]), true);
    assert.deepEqual(memory.read(), [{ pid: 7, executablePath: '', recordedAt: 0 }]);
    assert.equal(memory.clear(), true);
    assert.deepEqual(memory.read(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/browser/health requires auth and returns health plus metrics', async () => {
  const { manager } = createManager();
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: manager,
    dataDir: '',
    getCurrentCwd: () => '/ws/health',
    getCurrentWorkspaceFile: () => '/ws/health',
    getOwnerSessionId: (req) => String(req.headers['x-test-owner'] || ''),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const noAuth = await fetch(`${base}/api/browser/health`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${base}/api/browser/health`, { headers: { 'x-test-owner': 'o-health' } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.health.status, 'ok');
    assert.equal(body.metrics.live.globalSessions, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('server.js wires the respawn controller into the session manager (P2c blocker)', () => {
  // Static guard for the review fa494e14 blocker: production never passed a
  // `respawn` controller, so handleDriverCrash returned false immediately and
  // respawn/backoff never ran. This asserts the wiring stays in server.js.
  const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  assert.match(
    serverSource,
    /import\s*\{[^}]*\bcreateRespawnController\b[^}]*\}\s*from\s*['"]\.\/lib\/browser\/lifecycle\.js['"]/,
    'server.js must import createRespawnController from ./lib/browser/lifecycle.js',
  );
  assert.match(
    serverSource,
    /respawn\s*:\s*browserRespawnController\b/,
    'server.js must pass the respawn controller to BrowserSessionManager',
  );
  // Chosen exactly-once variant: the controller's own `launch` performs the real
  // relaunch, so the manager must not receive a separate `relaunch` callback
  // (handleDriverCrash would otherwise relaunch twice per crash).
  assert.doesNotMatch(
    serverSource,
    /^[ \t]*relaunch[ \t]*:/m,
    'server.js must not pass a standalone relaunch callback to BrowserSessionManager',
  );
  assert.match(
    serverSource,
    /launch\s*:\s*async\s*\(\)\s*=>\s*\{/,
    'the respawn controller must own the real relaunch in its launch callback',
  );
});
