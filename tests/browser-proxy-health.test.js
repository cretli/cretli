/**
 * Browser proxy reachability tests.
 *
 * Two layers are covered: `proxy-health.js` URL parsing and bounded probe
 * semantics (with an injected transport, so no real network is touched), and
 * the `BrowserSessionManager` policy that maps a probe result onto the
 * `proxy` / `required` / `mvp-defense-in-depth` boundaries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProxyServer, probeBrowserProxy } from '../lib/browser/proxy-health.js';
import { BrowserError, BrowserSessionManager } from '../lib/browser/session-manager.js';

const SCOPE = { workspaceFile: '/ws/a' };
const OWNER = 'owner-a';

test('parseProxyServer applies http/https default ports and keeps explicit ones', () => {
  assert.deepEqual(
    parseProxyServer('http://127.0.0.1'),
    { protocol: 'http:', host: '127.0.0.1', port: 80 },
  );
  assert.deepEqual(
    parseProxyServer('https://proxy.example.com'),
    { protocol: 'https:', host: 'proxy.example.com', port: 443 },
  );
  assert.deepEqual(
    parseProxyServer('http://proxy.example.com:3128'),
    { protocol: 'http:', host: 'proxy.example.com', port: 3128 },
  );
});

test('parseProxyServer requires an explicit port for socks4/socks5', () => {
  assert.deepEqual(
    parseProxyServer('socks5://127.0.0.1:1080'),
    { protocol: 'socks5:', host: '127.0.0.1', port: 1080 },
  );
  assert.deepEqual(
    parseProxyServer('socks4://127.0.0.1:9050'),
    { protocol: 'socks4:', host: '127.0.0.1', port: 9050 },
  );
  assert.equal(parseProxyServer('socks5://127.0.0.1'), null);
  assert.equal(parseProxyServer('socks4://'), null);
});

test('parseProxyServer returns null for invalid input', () => {
  const invalid = ['', '   ', 'not-a-url', 'ftp://proxy:21', 'http://', 'http://proxy:0', 'http://proxy:99999', null, undefined];
  for (const value of invalid) {
    assert.equal(parseProxyServer(value), null, JSON.stringify(value));
  }
});

test('probeBrowserProxy reports proxy-ok and forwards the connect target', async () => {
  const calls = [];
  const result = await probeBrowserProxy('http://127.0.0.1:3128', {
    connect: async (target) => { calls.push(target); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'proxy-ok');
  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 3128, timeoutMs: 2000 }]);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test('probeBrowserProxy reports proxy-unreachable when connect rejects', async () => {
  const result = await probeBrowserProxy('http://127.0.0.1:3128', {
    connect: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proxy-unreachable');
  assert.match(result.reason, /ECONNREFUSED/);
});

test('probeBrowserProxy bounds a connect call that never settles', async () => {
  const result = await probeBrowserProxy('http://127.0.0.1:3128', {
    timeoutMs: 20,
    connect: () => new Promise(() => {}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proxy-unreachable');
  assert.match(result.reason, /Timed out/);
});

test('probeBrowserProxy reports proxy-invalid without calling connect', async () => {
  let called = 0;
  const result = await probeBrowserProxy('not-a-proxy', {
    connect: async () => { called += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proxy-invalid');
  assert.equal(called, 0);
});

test('probeBrowserProxy reports an empty host as unreachable', async () => {
  const result = await probeBrowserProxy('socks5://', { connect: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proxy-unreachable');
  assert.match(result.reason, /empty/i);
});

/** Minimal Playwright driver stand-in: enough to create one session + tab. */
function createFakeDriver() {
  const state = { launchCount: 0, pages: [] };
  class FakePage {
    constructor() {
      this._closed = false;
      this._handlers = new Map();
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    isClosed() { return this._closed; }
    url() { return 'about:blank'; }
    async close() { this._closed = true; this.emit('close'); }
  }
  class FakeContext {
    constructor() {
      this._handlers = new Map();
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    async route() {}
    async newPage() {
      const page = new FakePage();
      state.pages.push(page);
      this.emit('page', page);
      return page;
    }
  }
  class FakeBrowser {
    async newContext() { return new FakeContext(); }
    isConnected() { return true; }
    async close() {}
  }
  return {
    state,
    driver: {
      name: 'fake',
      async launch() {
        state.launchCount += 1;
        return new FakeBrowser();
      },
    },
  };
}

function createManager(overrides = {}) {
  const { driver, state } = createFakeDriver();
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    now: () => 1_000_000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [],
    ...overrides,
  });
  return { manager, state };
}

test('required boundary refuses a session when the proxy probe fails', async () => {
  let probeCalls = 0;
  const { manager, state } = createManager({
    driverStatus: {
      status: 'available',
      networkBoundary: { mode: 'required', proxyServer: 'http://proxy.internal:3128', configured: true },
    },
    proxyProbe: async () => {
      probeCalls += 1;
      return { ok: false, code: 'proxy-unreachable', reason: 'ECONNREFUSED' };
    },
  });
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: OWNER, ...SCOPE }),
    (err) => err instanceof BrowserError
      && err.code === 'browser-unavailable'
      && err.status === 503
      && /proxy\.internal:3128/.test(err.message)
      && /proxy-unreachable/.test(err.message),
  );
  assert.equal(probeCalls, 1);
  assert.equal(state.launchCount, 0);
  assert.equal(manager.sessions.size, 0);
});

test('proxy boundary still creates a session when the probe fails and exposes the health', async () => {
  const { manager, state } = createManager({
    driverStatus: {
      status: 'available',
      networkBoundary: { mode: 'proxy', proxyServer: 'http://proxy.internal:3128', configured: true },
    },
    proxyProbe: async () => ({ ok: false, code: 'proxy-unreachable', reason: 'ECONNREFUSED' }),
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.ok(session.browserSessionId);
  assert.equal(state.launchCount, 1);
  const status = manager.getRuntimeStatus();
  assert.equal(status.networkBoundary.mode, 'proxy');
  assert.equal(status.networkBoundary.proxyHealth.code, 'proxy-unreachable');
  assert.equal(status.networkBoundary.proxyHealth.proxyServer, 'http://proxy.internal:3128');
  assert.match(manager.proxyWarning, /warn only/);
});

test('mvp-defense-in-depth never probes the proxy', async () => {
  let probeCalls = 0;
  const { manager } = createManager({
    proxyProbe: async () => {
      probeCalls += 1;
      return { ok: true, code: 'proxy-ok', reason: 'ok', latencyMs: 1 };
    },
  });
  await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.equal(probeCalls, 0);
  assert.equal(manager.getRuntimeStatus().networkBoundary.proxyHealth, undefined);
});

test('a successful required probe is cached for the TTL', async () => {
  let probeCalls = 0;
  const { manager } = createManager({
    driverStatus: {
      status: 'available',
      networkBoundary: { mode: 'required', proxyServer: 'http://proxy.internal:3128', configured: true },
    },
    proxyProbe: async () => {
      probeCalls += 1;
      return { ok: true, code: 'proxy-ok', reason: 'ok', latencyMs: 1 };
    },
  });
  await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.equal(probeCalls, 1);
  assert.equal(manager.getRuntimeStatus().networkBoundary.proxyHealth.code, 'proxy-ok');
});
