import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager, BrowserError } from '../lib/browser/session-manager.js';
import {
  BROWSER_SYSTEM_OWNER_ID,
  EXTERNAL_CDP_MAX_SESSIONS_DEFAULT,
  EXTERNAL_CDP_MAX_SESSIONS_LIMIT,
} from '../lib/browser/constants.js';
import { normalizeExternalMaxSessions, resolveBrowserCdpConfig } from '../lib/browser/cdp-config.js';
import { createCdpDriver } from '../lib/browser/runtime-detect.js';

function externalFixture(options = {}) {
  const events = { pageRoutes: 0, initScripts: 0, pageCloses: 0, contextCloses: 0, browserCloses: 0, cdpMethods: [] };
  const page = {
    _closed: false,
    on() {},
    context: () => context,
    isClosed: () => page._closed,
    url: () => 'about:blank',
    async title() { return ''; },
    async addInitScript() { events.initScripts += 1; },
    async route(_pattern, handler) { events.pageRoutes += 1; page.routeHandler = handler; },
    async routeWebSocket(_pattern, handler) { page.webSocketRouteHandler = handler; },
    async close() { page._closed = true; events.pageCloses += 1; },
    viewportSize: () => ({ width: 1280, height: 720 }),
    opener: async () => null,
  };
  const context = {
    pages: () => [],
    _handlers: new Map(),
    on(event, handler) { this._handlers.set(event, [...(this._handlers.get(event) || []), handler]); },
    off(event, handler) { this._handlers.set(event, (this._handlers.get(event) || []).filter((h) => h !== handler)); },
    emit(event, value) { for (const handler of this._handlers.get(event) || []) handler(value); },
    async newCDPSession() {
      return { send: async (method) => { events.cdpMethods.push(method); }, detach: async () => {} };
    },
    async newPage() { return page; },
    async close() { events.contextCloses += 1; },
  };
  const browser = {
    contexts: () => [context],
    _handlers: new Map(),
    on(event, handler) { this._handlers.set(event, handler); },
    emit(event) { this._handlers.get(event)?.(); },
    async close() { events.browserCloses += 1; },
  };
  const driver = {
    onConnectionChange(fn) { driver.listener = fn; },
    async connect() { driver.listener?.(true); return browser; },
    getProcessId() { return null; },
  };
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available', mode: 'external-cdp', connected: 'unknown' },
    externalMaxSessions: options.externalMaxSessions ?? 1,
    resolvePolicy: options.resolvePolicy || (() => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [], allowExternalBrowser: true })),
    proxyProbe: options.proxyProbe,
    selfOrigins: options.selfOrigins || [],
    now: () => 1000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    lookup: options.lookup || (async () => [{ address: '93.184.216.34' }]),
  });
  return { manager, driver, events, page, context, browser };
}

test('external CDP disconnect closes the session without headless crash recovery', async () => {
  const { manager, browser, events } = externalFixture();
  let respawns = 0;
  let relaunches = 0;
  manager.respawn = { schedule: async () => { respawns += 1; return true; } };
  manager.relaunch = async () => { relaunches += 1; };
  await manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' });
  browser.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRuntimeStatus().connected, false);
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.externalSessionReserved, false);
  assert.equal(respawns, 0);
  assert.equal(relaunches, 0);
  assert.equal(events.pageCloses, 1);
  assert.equal(events.contextCloses, 0);
  assert.equal(events.browserCloses, 0);
});

test('external CDP reports connection, reserves one session, and closes only its page', async () => {
  const { manager, driver, events, page } = externalFixture();
  assert.equal(manager.getRuntimeStatus().connected, 'unknown');
  const session = await manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' });
  assert.equal(manager.getRuntimeStatus().connected, true);
  assert.equal(events.pageRoutes, 1);
  assert.equal(events.initScripts, 1);
  assert.ok(events.cdpMethods.includes('Network.setBypassServiceWorker'));
  assert.equal(typeof page.webSocketRouteHandler, 'function');
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'b', workspaceFile: '/ws/b' }),
    (error) => error instanceof BrowserError && error.code === 'external-session-busy' && error.holder === 'other-workspace',
  );
  driver.listener?.(false);
  assert.equal(manager.getRuntimeStatus().connected, false);
  driver.listener?.(true);
  assert.equal(manager.getRuntimeStatus().connected, true);
  const unrelated = { close: async () => { throw new Error('unrelated tab touched'); }, opener: async () => null };
  const popup = { close: async () => { events.pageCloses += 1; }, opener: async () => page };
  const live = manager.sessions.values().next().value;
  assert.equal(live.pageTabs.has(page), true);
  live.context.emit('page', unrelated);
  live.context.emit('page', popup);
  await new Promise((resolve) => setImmediate(resolve));
  let websocketClosed = false;
  await page.webSocketRouteHandler({
    url: () => 'ws://unallowlisted.example/socket',
    close: async () => { websocketClosed = true; },
    connectToServer: async () => { throw new Error('must not connect'); },
  });
  assert.equal(websocketClosed, true, 'owned-page websocket is policy checked');
  await manager.closeSession(session.browserSessionId, 'a', { scope: { workspaceFile: '/ws/a' } });
  assert.equal(events.pageCloses, 2, 'created page and related popup are closed');
  assert.equal(events.contextCloses, 0);
  assert.equal(events.browserCloses, 0);
});

test('external CDP reservation is atomic for concurrent owners', async () => {
  const { manager } = externalFixture();
  const results = await Promise.allSettled([
    manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' }),
    manager.createSession({ ownerSessionId: 'b', workspaceFile: '/ws/b' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'external-session-busy').length, 1);
});

test('external CDP holder is described relative to the caller and can be released by anyone', async () => {
  const { manager } = externalFixture();
  assert.equal(manager.describeExternalHolder('a', { workspaceFile: '/ws/a' }), null);
  await manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' });
  assert.equal(manager.describeExternalHolder('a', { workspaceFile: '/ws/a' }).holder, 'self');
  assert.equal(manager.describeExternalHolder('a', { workspaceFile: '/ws/a' }).mine, true);
  assert.equal(manager.describeExternalHolder('b', { workspaceFile: '/ws/a' }).holder, 'other-login');
  assert.equal(manager.describeExternalHolder('a', { workspaceFile: '/ws/b' }).holder, 'other-workspace');
  // The caller cannot see the holder in its own list, which is the bug this covers.
  assert.deepEqual(manager.listSessions('b', { workspaceFile: '/ws/b' }), []);
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'b', workspaceFile: '/ws/b' }),
    (error) => error.code === 'external-session-busy',
  );
  assert.deepEqual(await manager.releaseExternalSession(), { released: true });
  assert.equal(manager.describeExternalHolder('b', { workspaceFile: '/ws/b' }), null);
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.externalSessionReserved, false, 'the slot is free for the next owner');
});

test('external CDP holder reports an agent system session', async () => {
  const { manager } = externalFixture();
  await manager.createSession({ ownerSessionId: BROWSER_SYSTEM_OWNER_ID, workspaceFile: '/ws/a' });
  assert.equal(manager.describeExternalHolder('a', { workspaceFile: '/ws/a' }).holder, 'agent');
});

test('external CDP shares the profile up to the configured session cap', async () => {
  const { manager, context } = externalFixture({ externalMaxSessions: 2 });
  const a = await manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' });
  assert.equal(manager.describeExternalHolder('b', { workspaceFile: '/ws/b' }), null, 'a slot is still free');
  await manager.createSession({ ownerSessionId: BROWSER_SYSTEM_OWNER_ID, workspaceFile: '/ws/b' });
  const full = manager.describeExternalHolder('c', { workspaceFile: '/ws/c' });
  assert.equal(full.used, 2);
  assert.equal(full.max, 2);
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'c', workspaceFile: '/ws/c' }),
    (error) => error.code === 'external-session-busy',
  );
  const pageListeners = context._handlers.get('page').length;
  await manager.closeSession(a.browserSessionId, 'a');
  assert.equal(context._handlers.get('page').length, pageListeners - 1, 'a closed session leaves no listener on the shared context');
  assert.equal(manager.describeExternalHolder('c', { workspaceFile: '/ws/c' }), null);
  manager.externalMaxSessions = 1;
  assert.equal(manager.describeExternalHolder('c', { workspaceFile: '/ws/c' }).holder, 'agent', 'lowering the cap keeps live sessions');
});

test('external session cap is clamped and defaults when unset', () => {
  assert.equal(normalizeExternalMaxSessions(undefined), EXTERNAL_CDP_MAX_SESSIONS_DEFAULT);
  assert.equal(normalizeExternalMaxSessions(''), EXTERNAL_CDP_MAX_SESSIONS_DEFAULT);
  assert.equal(normalizeExternalMaxSessions('abc'), EXTERNAL_CDP_MAX_SESSIONS_DEFAULT);
  assert.equal(normalizeExternalMaxSessions(0), 1);
  assert.equal(normalizeExternalMaxSessions(2.7), 2);
  assert.equal(normalizeExternalMaxSessions(99), EXTERNAL_CDP_MAX_SESSIONS_LIMIT);
  assert.equal(resolveBrowserCdpConfig({}, { browserCdpMaxSessions: 5 }).maxSessions, 5);
  assert.equal(resolveBrowserCdpConfig({ CRETLI_BROWSER_CDP_URL: 'http://127.0.0.1:9222' }, {}).maxSessions, EXTERNAL_CDP_MAX_SESSIONS_DEFAULT);
});

test('external page route enforces iframe redirects and local-login scoping', async () => {
  const { manager, page } = externalFixture({
    selfOrigins: ['https://127.0.0.1'],
    resolvePolicy: () => ({
      allowedOrigins: ['https://example.com', 'https://127.0.0.1'],
      allowSelfOrigin: true,
      allowExternalBrowser: true,
      blockedPorts: [],
      unblockedPorts: [],
    }),
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  await manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' });
  const live = manager.sessions.values().next().value;
  assert.equal((await manager.evaluateRequestPolicy(live, 'https://127.0.0.1/login')).allowed, true);
  const fulfilled = [];
  const fetched = [];
  const aborted = [];
  const route = {
    async fetch(options) {
      fetched.push(options);
      if (fetched.length === 1) return { status: () => 302, headers: () => ({ location: '/iframe-final' }) };
      return { status: () => 200, headers: () => ({}) };
    },
    async fulfill(value) { fulfilled.push(value); },
    async abort(reason) { aborted.push(reason); },
  };
  const request = {
    url: () => 'https://example.com/iframe', method: () => 'GET', resourceType: () => 'document',
    headers: () => ({ accept: 'text/html' }), postDataBuffer: () => undefined,
    frame: () => ({ page: () => page }), isNavigationRequest: () => false,
  };
  await page.routeHandler(route, request);
  assert.equal(fetched.length, 2, 'redirect chain is manually fetched');
  assert.equal(fulfilled.length, 1);
  assert.equal(fetched[0].headers, undefined, 'foreign iframe does not receive local login');

  fetched.length = 0;
  fulfilled.length = 0;
  const localRequest = { ...request, url: () => 'https://127.0.0.1/login' };
  await page.routeHandler(route, localRequest);
  assert.ok(fetched[0].headers['x-cretli-browser-agent-page'], 'self-origin request is marked as an agent page');
  assert.equal(fetched[0].headers['x-cretli-local-login'], undefined, 'external Chrome never receives the local-login credential');

  fetched.length = 0;
  await page.routeHandler(route, {
    ...request,
    url: () => 'https://unallowlisted.example/image.png',
    resourceType: () => 'image',
  });
  assert.equal(fetched.length, 0, 'blocked subresource is not fetched');
  assert.equal(aborted.length, 1, 'blocked subresource is aborted');
});

test('external CDP requires workspace consent before connecting and releases reservation', async () => {
  let allowed = false;
  const { manager, driver } = externalFixture({ resolvePolicy: () => ({ allowExternalBrowser: allowed }) });
  let connections = 0;
  driver.connect = async () => { connections += 1; throw new Error('connection attempted'); };
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' }),
    (error) => error.code === 'external-browser-consent-required' && error.status === 403,
  );
  assert.equal(connections, 0);
  assert.equal(manager.externalSessionReserved, false);
  allowed = true;
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' }),
    (error) => error.code === 'browser-unavailable',
  );
  assert.equal(connections, 1);
});

test('external CDP refuses proxy and required boundaries before proxy probing or connecting', async () => {
  for (const mode of ['proxy', 'required']) {
    let probes = 0;
    const { manager, driver } = externalFixture({ proxyProbe: async () => { probes += 1; return { ok: true }; } });
    manager.driverStatus.networkBoundary = { mode, configured: true, proxyServer: 'http://proxy.internal:3128' };
    driver.connect = async () => { throw new Error('must not connect'); };
    await assert.rejects(
      () => manager.createSession({ ownerSessionId: 'a', workspaceFile: '/ws/a' }),
      (error) => error.code === 'browser-unavailable' && /cannot enforce/.test(error.message),
    );
    assert.equal(probes, 0);
    assert.equal(manager.externalSessionReserved, false);
  }
});

test('the CDP driver reuses one live connection across sessions', async () => {
  let connects = 0;
  let live = true;
  const browser = { isConnected: () => live, on() {} };
  const chromium = { connectOverCDP: async () => { connects += 1; return browser; } };
  const driver = await createCdpDriver(chromium, {
    url: 'http://127.0.0.1:9222',
    fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x', Browser: 'Chrome' }) }),
  });
  await driver.connect();
  await driver.connect();
  assert.equal(connects, 1, 'a second session attaches to the same connection');
  live = false;
  await driver.connect();
  assert.equal(connects, 2, 'a dropped connection is re-established');
});
