/**
 * Per-session Browser mode: a built-in launch driver and an external CDP driver
 * live in one BrowserSessionManager at the same time. No real Chromium: both
 * drivers are fakes that record every call, so the tests prove each session is
 * routed to its own driver and never to the other one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserSessionManager, BrowserError } from '../lib/browser/session-manager.js';
import { registerBrowserRoutes } from '../lib/browser/routes.js';
import { resolveBrowserCdpConfig } from '../lib/browser/cdp-config.js';

const ENDPOINT_HOST = 'chrome.internal.example';

function fakeBrowser(label, log, { external = false } = {}) {
  const page = {
    _closed: false,
    on() {},
    context: () => context,
    isClosed: () => page._closed,
    url: () => 'about:blank',
    async title() { return ''; },
    async addInitScript() {},
    async route() {},
    async routeWebSocket() {},
    async close() { page._closed = true; },
    viewportSize: () => ({ width: 1280, height: 720 }),
    opener: async () => null,
  };
  const context = {
    label,
    pages: () => [],
    on() {},
    off() {},
    async route() {},
    async routeWebSocket() {},
    async addInitScript() {},
    async newPage() { return page; },
    async newCDPSession() {
      log.push(`${label}:newCDPSession`);
      return { send: async () => {}, detach: async () => {}, on() {} };
    },
    async storageState() { return { cookies: [], origins: [] }; },
    async close() { log.push(`${label}:contextClose`); },
  };
  const handlers = new Map();
  const browser = {
    label,
    contexts: () => [context],
    async newContext(options) { log.push(`${label}:newContext`); context.options = options; return context; },
    isConnected: () => true,
    on(event, handler) { handlers.set(event, handler); },
    emit(event) { handlers.get(event)?.(); },
    async close() { log.push(`${label}:browserClose`); },
  };
  return { browser, context, page, external };
}

function createFixture(options = {}) {
  /** @type {string[]} */
  const log = [];
  const builtin = fakeBrowser('builtin', log);
  const external = fakeBrowser('external', log, { external: true });
  const builtinDriver = {
    name: 'fake-builtin',
    async launch(launchOptions) { log.push('builtin:launch'); builtinDriver.launchOptions = launchOptions; return builtin.browser; },
    getProcessId() { log.push('builtin:getProcessId'); return 4242; },
  };
  const externalDriver = {
    name: 'fake-external',
    onConnectionChange(fn) { externalDriver.listener = fn; },
    async connect() {
      log.push('external:connect');
      if (options.connectFails) {
        externalDriver.listener?.(false);
        throw new Error(`connect ECONNREFUSED ${ENDPOINT_HOST}:9222`);
      }
      externalDriver.listener?.(true);
      return external.browser;
    },
    getProcessId() { log.push('external:getProcessId'); return null; },
  };
  const manager = new BrowserSessionManager({
    drivers: {
      builtin: options.noBuiltin ? null : builtinDriver,
      external: options.noExternal ? null : externalDriver,
    },
    driverStatuses: {
      builtin: { status: 'available', mode: 'headless', executablePath: '/usr/bin/fake-chromium', networkBoundary: options.boundary },
      ...(options.noExternal ? {} : { external: { status: 'available', mode: 'external-cdp', connected: 'unknown', networkBoundary: options.boundary } }),
    },
    defaultMode: options.defaultMode,
    externalMaxSessions: options.externalMaxSessions ?? 1,
    externalNativeNetwork: options.nativeNetwork === true,
    resolvePolicy: options.resolvePolicy || (() => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [], allowExternalBrowser: options.consent !== false })),
    proxyProbe: options.proxyProbe || (async () => ({ ok: true, code: 'ok', reason: 'ok', latencyMs: 1 })),
    selfOrigins: [],
    now: () => 1000,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    lookup: async () => [{ address: '93.184.216.34' }],
    ...(options.manager || {}),
  });
  return { manager, log, builtin, external, builtinDriver, externalDriver };
}

const ws = (n = 'a') => ({ workspaceFile: `/ws/${n}` });
const make = (manager, owner, extra = {}) => manager.createSession({ ownerSessionId: owner, ...ws(owner), ...extra });

test('a builtin and an external session coexist; closing one leaves the other', async () => {
  const f = createFixture();
  const b = await make(f.manager, 'a', { browserMode: 'builtin' });
  const e = await make(f.manager, 'b', { browserMode: 'external' });
  assert.equal(b.mode, 'builtin');
  assert.equal(e.mode, 'external');
  assert.equal(f.manager.sessions.size, 2);
  await f.manager.closeSession(b.browserSessionId, 'a', { scope: ws('a') });
  assert.equal(f.manager.sessions.size, 1);
  assert.equal([...f.manager.sessions.values()][0].mode, 'external');
  assert.deepEqual(f.manager.listSessions('b', ws('b')).map((s) => s.mode), ['external']);
});

test('driver routing: each session only talks to its own driver', async () => {
  const f = createFixture();
  const b = await make(f.manager, 'a', { browserMode: 'builtin' });
  const e = await make(f.manager, 'b', { browserMode: 'external' });
  const bs = f.manager.sessions.get(b.browserSessionId);
  const es = f.manager.sessions.get(e.browserSessionId);
  assert.equal(bs.browser, f.builtin.browser);
  assert.equal(bs.context, f.builtin.context);
  assert.equal(es.browser, f.external.browser);
  assert.equal(es.context, f.external.context);
  // launch / connect
  assert.equal(f.log.filter((l) => l === 'builtin:launch').length, 1);
  assert.equal(f.log.filter((l) => l === 'external:connect').length, 1);
  // PID tracking: built-in only; the external driver is asked nothing it cannot answer for builtin.
  assert.ok(f.log.includes('builtin:getProcessId'));
  assert.equal(bs.processId, 4242);
  assert.equal(es.processId, null);
  assert.equal(f.manager.processIdFor(bs), 4242);
  assert.equal(f.manager.processIdFor(es), null);
  assert.equal([...f.manager.registeredPids.keys()].includes(4242), true);
  // newContext only on the built-in browser; external never gets a replaced context.
  assert.ok(f.log.includes('builtin:newContext'));
  assert.equal(f.log.includes('external:newContext'), false);
  // Screencast / debugger CDP sessions are opened on the session's own context.
  const bTab = bs.tabs.values().next().value;
  const eTab = es.tabs.values().next().value;
  f.log.length = 0;
  await f.manager.ensureCdpSession(bTab);
  await f.manager.ensureDebuggerCdpSession(bTab);
  assert.deepEqual(f.log.filter((l) => l.endsWith('newCDPSession')), ['builtin:newCDPSession', 'builtin:newCDPSession']);
  f.log.length = 0;
  await f.manager.ensureCdpSession(eTab);
  await f.manager.ensureDebuggerCdpSession(eTab);
  assert.deepEqual(f.log.filter((l) => l.endsWith('newCDPSession')), ['external:newCDPSession', 'external:newCDPSession']);
});

test('external slot limit counts external sessions only', async () => {
  const f = createFixture({ externalMaxSessions: 1 });
  await make(f.manager, 'a', { browserMode: 'builtin' });
  await make(f.manager, 'b', { browserMode: 'builtin' });
  await make(f.manager, 'c', { browserMode: 'external' });
  await assert.rejects(
    () => make(f.manager, 'd', { browserMode: 'external' }),
    (error) => error instanceof BrowserError && error.code === 'external-session-busy',
  );
  // Built-in is still allowed while the external slot is full.
  await make(f.manager, 'e', { browserMode: 'builtin' });
  // The holder lookup ignores built-in sessions.
  assert.equal(f.manager.describeExternalHolder('d', ws('d')).used, 1);
});

test('explicit external: consent, configuration and connect failures never fall back', async () => {
  const noConsent = createFixture({ consent: false });
  await assert.rejects(
    () => make(noConsent.manager, 'a', { browserMode: 'external' }),
    (e) => e.code === 'external-browser-consent-required',
  );
  assert.equal(noConsent.log.includes('builtin:launch'), false);

  const notConfigured = createFixture({ noExternal: true });
  await assert.rejects(
    () => make(notConfigured.manager, 'a', { browserMode: 'external' }),
    (e) => e.code === 'external-not-configured',
  );

  const failing = createFixture({ connectFails: true });
  await assert.rejects(
    () => make(failing.manager, 'a', { browserMode: 'external' }),
    (e) => e.code === 'browser-unavailable',
  );
  assert.equal(failing.log.includes('builtin:launch'), false);
  assert.equal(failing.manager.externalSessionReserved, false);
});

test('auto falls back to builtin with a warning that never leaks the endpoint', async () => {
  const f = createFixture({ connectFails: true, defaultMode: 'auto', nativeNetwork: true });
  const session = await make(f.manager, 'a');
  assert.equal(session.mode, 'builtin');
  assert.equal(session.warning.code, 'external-fallback');
  assert.doesNotMatch(JSON.stringify(session.warning), new RegExp(`${ENDPOINT_HOST}|9222`));
  assert.ok(f.log.includes('external:connect'));
  assert.ok(f.log.includes('builtin:launch'));
  const live = f.manager.sessions.get(session.browserSessionId);
  assert.equal(live.external, false);
  // Native networking is external-only: the fallback session never uses it.
  assert.equal(await f.manager.handleExternalNativeRoute(live, {}, {}, () => ({})), false);
});

test('auto fallback reasons: not configured, no consent, busy, proxy/required boundary', async () => {
  const notConfigured = createFixture({ noExternal: true, defaultMode: 'auto' });
  assert.equal((await make(notConfigured.manager, 'a')).warning.code, 'external-fallback');

  const noConsent = createFixture({ consent: false, defaultMode: 'auto' });
  const s = await make(noConsent.manager, 'a');
  assert.equal(s.mode, 'builtin');
  assert.match(s.warning.message, /allowed the external browser/);

  const busy = createFixture({ defaultMode: 'auto' });
  assert.equal((await make(busy.manager, 'a')).mode, 'external');
  const second = await make(busy.manager, 'b');
  assert.equal(second.mode, 'builtin');
  assert.match(second.warning.message, /busy/);

  for (const boundaryMode of ['proxy', 'required']) {
    let probes = 0;
    const f = createFixture({
      defaultMode: 'auto',
      boundary: { mode: boundaryMode, configured: true, proxyServer: 'http://proxy.internal:3128' },
      proxyProbe: async () => { probes += 1; return { ok: true, code: 'ok', reason: 'ok', latencyMs: 1 }; },
    });
    const session = await make(f.manager, 'a');
    assert.equal(session.mode, 'builtin');
    assert.match(session.warning.message, /network boundary/);
    assert.equal(f.log.includes('external:connect'), false);
    // The built-in fallback still goes through the proxy health check.
    assert.equal(probes, 1);
  }
});

test('non-fallback errors surface unchanged under auto', async () => {
  const f = createFixture({ defaultMode: 'auto' });
  await assert.rejects(
    () => f.manager.createSession({ ownerSessionId: 'a' }),
    (e) => e.code === 'no-workspace',
  );
});

test('default mode resolution and back-compat', () => {
  const none = resolveBrowserCdpConfig({}, {});
  assert.equal(none.defaultMode, 'builtin');
  assert.equal(none.explicitDefaultMode, '');
  const withUrl = resolveBrowserCdpConfig({}, { browserCdpUrl: 'http://127.0.0.1:9222' });
  assert.equal(withUrl.defaultMode, 'external');
  assert.equal(withUrl.explicitDefaultMode, '');
  const envUrl = resolveBrowserCdpConfig({ CRETLI_BROWSER_CDP_URL: 'http://127.0.0.1:9222' }, {});
  assert.equal(envUrl.defaultMode, 'external');
  const explicit = resolveBrowserCdpConfig({}, { browserCdpUrl: 'http://127.0.0.1:9222', browserDefaultMode: 'builtin' });
  assert.equal(explicit.defaultMode, 'builtin');
  const pinned = resolveBrowserCdpConfig({ CRETLI_BROWSER_DEFAULT_MODE: 'auto' }, { browserDefaultMode: 'builtin' });
  assert.equal(pinned.defaultMode, 'auto');
  assert.equal(pinned.defaultModeLocked, true);
  assert.equal(resolveBrowserCdpConfig({}, { browserDefaultMode: 'bogus' }).defaultMode, 'builtin');

  // The manager mirrors it: endpoint + no setting => external; none => builtin.
  assert.equal(createFixture().manager.defaultMode, 'external');
  assert.equal(createFixture({ noExternal: true }).manager.defaultMode, 'builtin');
  assert.equal(createFixture({ defaultMode: 'builtin' }).manager.defaultMode, 'builtin');
});

test('default applies to creation and an unset browserMode', async () => {
  const f = createFixture({ defaultMode: 'builtin' });
  assert.equal((await make(f.manager, 'a')).mode, 'builtin');
  f.manager.setDefaultMode('external');
  assert.equal((await make(f.manager, 'b')).mode, 'external');
  await assert.rejects(() => make(f.manager, 'c', { browserMode: 'bogus' }), (e) => e.code === 'invalid-browser-mode');
});

test('status and health report both modes; a disconnected external is not degraded while builtin is healthy', async () => {
  const f = createFixture({ defaultMode: 'external' });
  const e = await make(f.manager, 'a', { browserMode: 'external' });
  const b = await make(f.manager, 'b', { browserMode: 'builtin' });
  f.externalDriver.listener(false);
  const status = f.manager.getRuntimeStatus();
  assert.equal(status.defaultMode, 'external');
  assert.equal(status.modes.external.connected, false);
  assert.equal(status.modes.external.configured, true);
  assert.equal(status.modes.builtin.available, true);
  assert.equal(status.modes.builtin.connected, null);
  const health = f.manager.healthcheck();
  assert.notEqual(health.status, 'degraded');
  assert.equal(health.modes.external.connected, false);
  assert.equal(health.modes.builtin.available, true);
  assert.ok(e.browserSessionId && b.browserSessionId);

  const onlyExternal = createFixture({ noBuiltin: true });
  onlyExternal.externalDriver.listener(false);
  assert.equal(onlyExternal.manager.healthcheck().status, 'degraded');
});

test('CDP disconnect closes only external sessions and writes only the external status', async () => {
  const f = createFixture();
  let respawns = 0;
  f.manager.respawn = { schedule: async () => { respawns += 1; return true; } };
  const b = await make(f.manager, 'a', { browserMode: 'builtin' });
  await make(f.manager, 'b', { browserMode: 'external' });
  const builtinStatusBefore = f.manager.driverStatuses.builtin;
  f.external.browser.emit('disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...f.manager.sessions.values()].map((s) => s.mode), ['builtin']);
  assert.equal(f.manager.sessions.has(b.browserSessionId), true);
  assert.equal(f.manager.driverStatuses.external.connected, false);
  assert.equal(f.manager.driverStatuses.builtin, builtinStatusBefore);
  assert.equal(respawns, 0);
});

test('built-in respawn swaps only the built-in driver; the endpoint swap only the external one', () => {
  const f = createFixture();
  const externalBefore = f.manager.drivers.external;
  const next = { launch: async () => {} };
  assert.equal(f.manager.setDriver({ available: true, driver: next, status: 'available' }), true);
  assert.equal(f.manager.drivers.builtin, next);
  assert.equal(f.manager.drivers.external, externalBefore);
  // An external-shaped descriptor is never installed as the built-in driver.
  assert.equal(f.manager.setDriver({ available: true, driver: {}, mode: 'external-cdp' }), false);
  assert.equal(f.manager.drivers.builtin, next);
  const builtinBefore = f.manager.drivers.builtin;
  const ext2 = { connect: async () => ({}) };
  assert.equal(f.manager.setExternalDriver({ available: true, driver: ext2, mode: 'external-cdp' }), true);
  assert.equal(f.manager.drivers.external, ext2);
  assert.equal(f.manager.drivers.builtin, builtinBefore);
  f.manager.setExternalDriver(null);
  assert.equal(f.manager.externalConfigured, false);
  assert.equal(f.manager.drivers.builtin, builtinBefore);
});

test('storage state is persisted for builtin sessions only in a mixed setup', async () => {
  const f = createFixture();
  f.manager.sessionStorageConsented = () => true;
  f.manager.sessionStorageState = () => null;
  const b = await make(f.manager, 'a', { browserMode: 'builtin' });
  const e = await make(f.manager, 'b', { browserMode: 'external' });
  assert.equal(f.manager.sessions.get(b.browserSessionId).storageStateActive, true);
  assert.equal(f.manager.sessions.get(e.browserSessionId).storageStateActive, false);
  assert.equal(f.log.includes('external:newContext'), false);
});

test('describeExternalHolder / releaseExternalSession ignore built-in sessions', async () => {
  const f = createFixture();
  const b = await make(f.manager, 'a', { browserMode: 'builtin' });
  assert.equal(f.manager.describeExternalHolder('a', ws('a')), null);
  await make(f.manager, 'b', { browserMode: 'external' });
  assert.equal(f.manager.describeExternalHolder('a', ws('a')).used, 1);
  const released = await f.manager.releaseExternalSession();
  assert.equal(released.released, true);
  assert.equal(f.manager.sessions.has(b.browserSessionId), true, 'built-in session survives the external release');
  assert.equal(f.manager.sessions.size, 1);
});

test('only builtin available / only external available surface the right error', async () => {
  const noBuiltin = createFixture({ noBuiltin: true });
  await assert.rejects(() => make(noBuiltin.manager, 'a', { browserMode: 'builtin' }), (e) => e.code === 'browser-unavailable');
  assert.equal((await make(noBuiltin.manager, 'a', { browserMode: 'external' })).mode, 'external');
});

// ---- REST ----------------------------------------------------------------

async function startRoutes(manager) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-modes-'));
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: manager,
    dataDir,
    getCurrentCwd: () => '/ws/a',
    getCurrentWorkspaceFile: () => '/ws/a',
    getOwnerSessionId: () => 'owner',
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (body) => fetch(`${base}/api/browser/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    close: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('REST: browserMode reaches createSession, chat mode passes the guard, invalid value is 400', async () => {
  const seen = [];
  const manager = {
    createSession: async (input) => { seen.push(input); return { browserSessionId: 's1', mode: input.browserMode || 'builtin', tabs: [] }; },
    getRuntimeStatus: () => ({}),
  };
  const api = await startRoutes(manager);
  try {
    const ok = await api.post({ mode: 'agent', browserMode: 'builtin' });
    assert.equal(ok.status, 201);
    assert.equal(seen[0].browserMode, 'builtin');
    assert.equal('mode' in seen[0], false, 'chat mode is not forwarded as a session field');

    const plan = await api.post({ mode: 'plan', browserMode: 'builtin' });
    assert.equal(plan.status, 403, 'chat mode still drives the guard');

    const omitted = await api.post({ mode: 'agent' });
    assert.equal(omitted.status, 201);
    assert.equal('browserMode' in seen[1], false);

    for (const bad of ['auto', 'chromium', 5, {}]) {
      const res = await api.post({ mode: 'agent', browserMode: bad });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'invalid-browser-mode');
    }
    assert.equal(seen.length, 2);
  } finally {
    await api.close();
  }
});

test('REST: fallback warning is returned next to the session', async () => {
  const f = createFixture({ connectFails: true, defaultMode: 'auto' });
  const api = await startRoutes(f.manager);
  try {
    const res = await api.post({ mode: 'agent' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.session.mode, 'builtin');
    assert.equal(body.warning.code, 'external-fallback');
  } finally {
    await api.close();
  }
});
