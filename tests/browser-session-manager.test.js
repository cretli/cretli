/**
 * BrowserSessionManager contract tests using a fake Playwright driver.
 * Covers limits, isolation, policy wiring, redaction, rate limiting and cleanup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserError,
  BrowserSessionManager,
  BROWSER_ELEMENTS_SELECTOR,
  describePageElement,
  mapPreviewPoint,
} from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';

/** Scope used by every session in this file (one workspace per test). */
const SCOPE = { workspaceFile: '/ws/a' };
const OWNER = 'owner-a';

/**
 * Minimal Playwright locator stand-in. `_elements` entries carry the descriptor
 * the page-side function would return; the manager only orchestrates them.
 */
function makeLocator(entries) {
  const handle = (entry) => ({
    async isVisible() { return entry.visible !== false; },
    async boundingBox() { return entry.bounds === null ? null : (entry.bounds || { x: 1, y: 2, width: 30, height: 20 }); },
    async evaluate() {
      return entry.descriptor || {
        tag: entry.tag || 'button',
        role: entry.role,
        name: entry.name,
        text: entry.text || entry.name || '',
        selector: entry.selector || '#el',
      };
    },
    async click(options) { entry.clicked = true; entry.clickOptions = options; },
    async fill(value, options) { entry.filled = value; entry.fillOptions = options; },
  });
  return {
    async count() { return entries.length; },
    nth(index) { return handle(entries[index]); },
    first() { return handle(entries[0] || {}); },
  };
}

/** Minimal in-memory Playwright stand-in. */
function createFakeDriver() {
  const state = { browsers: [], contexts: [], pages: [], launchOptions: [], contextOptions: [] };

  class FakePage {
    constructor(context) {
      this._context = context;
      this._url = 'about:blank';
      this._title = 'fake';
      this._closed = false;
      this._handlers = new Map();
      this._viewport = { width: 390, height: 844 };
      this._elements = [];
      this.screenshotOptions = null;
      this.locatorQueries = [];
      this.mouse = { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {}, wheel: async () => {} };
      this.keyboard = { type: async () => {}, down: async () => {}, up: async () => {}, press: async () => {} };
      this.touchscreen = { tap: async () => {} };
      this._touch = false;
    }
    locator(selector) {
      this.locatorQueries.push(selector);
      return makeLocator(this._elements);
    }
    getByRole(role, options = {}) {
      this.locatorQueries.push(`role=${role}`);
      return makeLocator(this._elements.filter((entry) => entry.role === role
        && (!options.name || entry.name === options.name)));
    }
    getByText(value) {
      this.locatorQueries.push(`text=${value}`);
      return makeLocator(this._elements.filter((entry) => (entry.text || entry.name) === value));
    }
    getByLabel(value) {
      this.locatorQueries.push(`label=${value}`);
      return makeLocator(this._elements.filter((entry) => entry.label === value));
    }
    getByPlaceholder(value) {
      this.locatorQueries.push(`placeholder=${value}`);
      return makeLocator(this._elements.filter((entry) => entry.placeholder === value));
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    async goto(url) {
      for (const handler of this._context.routes) {
        let aborted = false;
        const route = {
          continue: async () => {},
          abort: async () => { aborted = true; },
          fetch: async () => ({ status: () => 200, headers: () => ({}), ok: () => true }),
          fulfill: async () => {},
        };
        await handler(route, {
          url: () => url,
          method: () => 'GET',
          resourceType: () => 'document',
          isNavigationRequest: () => true,
          postDataBuffer: () => undefined,
          frame: () => ({ page: () => this }),
        });
        if (aborted) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      }
      this._url = url;
      this.emit('framenavigated', { url: () => url });
    }
    async goBack() {}
    async goForward() {}
    async reload() {}
    async title() { return this._title; }
    url() { return this._url; }
    context() { return this._context; }
    viewportSize() { return this._viewport; }
    async setViewportSize(v) { this._viewport = v; }
    async screenshot(options) { this.screenshotOptions = options; return Buffer.from('fake-jpeg-bytes'); }
    async close() { this._closed = true; this.emit('close'); }
  }

  class FakeContext {
    constructor(browser) {
      this.browser = browser;
      this.pages = [];
      this.routes = [];
      this.closed = false;
      this._handlers = new Map();
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    async route(_pattern, handler) { this.routes.push(handler); }
    async newCDPSession(_page) {
      return {
        send: async (method) => {
          if (method === 'Page.getNavigationHistory') {
            return this.navigationHistory || { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
          }
          return {};
        },
        detach: async () => { this.cdpDetached = true; },
      };
    }
    async newPage() {
      const page = new FakePage(this);
      this.pages.push(page);
      state.pages.push(page);
      this.emit('page', page);
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
    constructor() { this.closed = false; }
    async newContext(options) {
      state.contextOptions.push(options || {});
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
      async launch(options) {
        state.launchOptions.push(options || {});
        const browser = new FakeBrowser();
        state.browsers.push(browser);
        return browser;
      },
    },
  };
}

function createManager(overrides = {}) {
  const { driver, state } = createFakeDriver();
  let clock = 1_000_000;
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    now: () => clock,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    ...overrides,
  });
  return { manager, state, setClock: (value) => { clock = value; }, getClock: () => clock };
}

test('creates a session with one initial tab and enforces per-owner session limit', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.equal(session.tabs.length, 1);
  for (let i = 1; i < BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER; i += 1) {
    await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  }
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: OWNER, ...SCOPE }),
    (err) => err instanceof BrowserError && err.code === 'session-limit',
  );
});

test('createSession rejects an empty workspace scope', async () => {
  const { manager } = createManager();
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: OWNER }),
    (err) => err instanceof BrowserError && err.code === 'no-workspace' && err.status === 400,
  );
});

test('blocks Service Workers and pins DNS via launch args', async () => {
  const { manager, state } = createManager();
  await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.equal(state.contextOptions[0].serviceWorkers, 'block');
  const localLogin = state.contextOptions[0].extraHTTPHeaders?.['x-cretli-local-login'];
  assert.equal(typeof localLogin, 'string');
  assert.equal(localLogin.length, 48);
  const args = state.launchOptions[0].args || [];
  assert.ok(
    args.some((arg) => arg.startsWith('--host-resolver-rules=') && arg.includes('MAP example.com 93.184.216.34')),
    JSON.stringify(args),
  );
});

test('foreign owner and foreign workspace are rejected with 403', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.throws(
    () => manager.requireSession(session.browserSessionId, 'owner-b', SCOPE),
    (err) => err instanceof BrowserError && err.status === 403 && err.code === 'forbidden-owner',
  );
  assert.throws(
    () => manager.requireSession(session.browserSessionId, OWNER, { workspaceFile: '/ws/other' }),
    (err) => err instanceof BrowserError && err.status === 403 && err.code === 'forbidden-workspace',
  );
  // Missing scope is not "all workspaces".
  assert.throws(
    () => manager.requireSession(session.browserSessionId, OWNER),
    (err) => err instanceof BrowserError && err.status === 403 && err.code === 'forbidden-workspace',
  );
  // Sessions from another workspace never show up in a list.
  assert.deepEqual(manager.listSessions(OWNER, { workspaceFile: '/ws/other' }), []);
  assert.deepEqual(manager.listSessions(OWNER, {}), []);
  assert.equal(manager.listSessions(OWNER, SCOPE).length, 1);
});

test('enforces the 4-tab limit with a controlled error', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  for (let i = 1; i < BROWSER_LIMITS.MAX_TABS_PER_SESSION; i += 1) {
    await manager.createTab(session.browserSessionId, OWNER, {}, { scope: SCOPE });
  }
  assert.equal(manager.listTabs(session.browserSessionId, OWNER, SCOPE).length, 4);
  await assert.rejects(
    () => manager.createTab(session.browserSessionId, OWNER, {}, { scope: SCOPE }),
    (err) => err instanceof BrowserError && err.code === 'tab-limit',
  );
});

test('navigate honours the URL policy and route handler blocks subresources', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);

  const state = await manager.navigate(session.browserSessionId, tab.browserTabId, 'https://example.com/', OWNER, SCOPE);
  assert.equal(state.url, 'https://example.com/');

  await assert.rejects(
    () => manager.navigate(session.browserSessionId, tab.browserTabId, 'https://evil.test/', OWNER, SCOPE),
    (err) => err instanceof BrowserError && err.code === 'navigation-blocked' && err.status === 403,
  );

  const context = manager.sessions.get(session.browserSessionId).context;
  const routeHandler = context.routes[0];
  let aborted = false;
  await routeHandler(
    { continue: async () => {}, abort: async () => { aborted = true; } },
    {
      url: () => 'http://169.254.169.254/latest/meta-data/',
      method: () => 'GET',
      resourceType: () => 'document',
      isNavigationRequest: () => false,
      frame: () => null,
    },
  );
  assert.equal(aborted, true);
  const network = manager.pullNetwork(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE);
  assert.ok(network.entries.some((entry) => entry.blocked === true));
});

test('DNS answers are pinned: a hostname changing address is blocked mid-session', async () => {
  let address = '93.184.216.34';
  const lookup = async () => [{ address }];
  const { manager } = createManager({ lookup });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  // The session pinned example.com to .34 at launch; DNS now answers .99.
  address = '93.184.216.99';

  const context = manager.sessions.get(session.browserSessionId).context;
  const routeHandler = context.routes[0];
  let aborted = false;
  await routeHandler(
    { continue: async () => {}, abort: async () => { aborted = true; } },
    { url: () => 'https://example.com/other', method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => false, frame: () => null },
  );
  assert.equal(aborted, true);
  const network = manager.pullNetwork(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE);
  assert.ok(network.entries.some((entry) => entry.blockedReason === 'dns-rebinding'));
});

test('screenshot enforces the 2 fps cap and size limit', async () => {
  const { manager, setClock } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const first = await manager.screenshot(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
  assert.equal(first.mimeType, 'image/jpeg');
  await assert.rejects(
    () => manager.screenshot(session.browserSessionId, tab.browserTabId, OWNER, SCOPE),
    (err) => err instanceof BrowserError && err.code === 'rate-limited' && err.status === 429,
  );
  setClock(1_000_000 + BROWSER_LIMITS.SCREENSHOT_MIN_INTERVAL_MS + 1);
  await manager.screenshot(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
});

test('console and network buffers are redacted and bounded', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  tab.console.pushConsole({ text: 'token=abc123secret' });
  tab.network.recordRequest({ method: 'GET', url: 'https://example.com/?api_key=sk-1' });
  const consolePull = manager.pullConsole(session.browserSessionId, tabInfo.browserTabId, OWNER, {}, SCOPE);
  assert.match(consolePull.entries[0].text, /token=\[redacted\]/);
  const networkPull = manager.pullNetwork(session.browserSessionId, tabInfo.browserTabId, OWNER, {}, SCOPE);
  assert.match(networkPull.entries[0].url, /api_key=(?:%5Bredacted%5D|\[redacted\])/);
});

test('state and tab summaries redact embedded URL credentials', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  tab.url = 'https://user:supersecret@example.com/private';
  const state = await manager.getState(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  assert.doesNotMatch(state.url, /supersecret/);
  assert.match(state.url, /redacted/i);
  const summary = manager.getSessionSummary(session.browserSessionId, OWNER, SCOPE);
  assert.doesNotMatch(summary.tabs[0].url, /supersecret/);
});

test('closeSession clears buffers and tears down context/browser', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const browser = manager.sessions.get(session.browserSessionId).browser;
  const context = manager.sessions.get(session.browserSessionId).context;
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: SCOPE });
  assert.equal(manager.sessions.has(session.browserSessionId), false);
  assert.equal(context.closed, true);
  assert.equal(browser.closed, true);
});

test('closeSession refuses a foreign workspace even for the same owner', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  await assert.rejects(
    () => manager.closeSession(session.browserSessionId, OWNER, {
      reason: 'test',
      scope: { workspaceFile: '/ws/other' },
    }),
    (err) => err instanceof BrowserError && err.code === 'forbidden-workspace',
  );
  assert.equal(manager.sessions.has(session.browserSessionId), true);
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: SCOPE });
});

test('idle sweep closes sessions past the timeout', async () => {
  const { manager, setClock } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  setClock(1_000_000 + BROWSER_LIMITS.IDLE_TIMEOUT_MS + 1);
  const closed = manager.sweepIdle();
  assert.deepEqual(closed, [session.browserSessionId]);
  assert.equal(manager.sessions.size, 0);
});

test('chat bindings are exclusive, scoped and unbind on close', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  manager.bindChat(session.browserSessionId, OWNER, { chatId: 'chat-1' }, SCOPE);
  assert.deepEqual(manager.resolveChatBinding('chat-1'), { browserSessionId: session.browserSessionId, chatId: 'chat-1' });
  assert.throws(
    () => manager.bindChat(session.browserSessionId, OWNER, { chatId: 'chat-2' }, { workspaceFile: '/ws/other' }),
    (err) => err instanceof BrowserError && err.code === 'forbidden-workspace',
  );
  await manager.closeSession(session.browserSessionId, OWNER, { scope: SCOPE });
  assert.equal(manager.resolveChatBinding('chat-1'), null);
});

test('popups beyond the tab limit are closed instead of opening a 5th tab', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  for (let i = 1; i < BROWSER_LIMITS.MAX_TABS_PER_SESSION; i += 1) {
    await manager.createTab(session.browserSessionId, OWNER, {}, { scope: SCOPE });
  }
  const context = manager.sessions.get(session.browserSessionId).context;
  const popup = await context.newPage();
  assert.equal(popup._closed, true);
  assert.equal(manager.listTabs(session.browserSessionId, OWNER, SCOPE).length, BROWSER_LIMITS.MAX_TABS_PER_SESSION);
});

test('mapPreviewPoint scales preview coordinates to the viewport', () => {
  assert.deepEqual(
    mapPreviewPoint({ x: 50, y: 100 }, { width: 100, height: 200 }, { width: 400, height: 800 }),
    { x: 200, y: 400 },
  );
  assert.deepEqual(mapPreviewPoint({ x: 5, y: 6 }, null, null), { x: 5, y: 6 });
});

test('createSession reports browser-unavailable when no driver is present', async () => {
  const manager = new BrowserSessionManager({
    driver: null,
    driverStatus: { status: 'browser-unavailable', reason: 'no chromium' },
  });
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: OWNER, ...SCOPE }),
    (err) => err instanceof BrowserError && err.code === 'browser-unavailable' && err.status === 503,
  );
});

test('cleanup is hard-bounded and kills the Chromium tree when close hangs', async () => {
  const killed = [];
  const { driver, state } = createFakeDriver();
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    limits: { ...BROWSER_LIMITS, GRACE_CLOSE_MS: 5, CLOSE_HARD_TIMEOUT_MS: 10 },
    killTree: (pid) => { killed.push(pid); return true; },
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const record = manager.sessions.get(session.browserSessionId);
  // Make close hang and pretend the tree still has a pid.
  record.context.close = () => new Promise(() => {});
  record.browser.close = () => new Promise(() => {});
  record.browser.process = () => ({ pid: 4242 });
  const started = Date.now();
  await manager.closeSession(session.browserSessionId, OWNER, { scope: SCOPE });
  const elapsed = Date.now() - started;
  assert.equal(manager.sessions.has(session.browserSessionId), false);
  assert.deepEqual(killed, [4242]);
  assert.ok(elapsed < 2000, `cleanup took ${elapsed}ms`);
  void state;
});

test('closeAll resolves even when every session close hangs', async () => {
  const { driver } = createFakeDriver();
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    limits: { ...BROWSER_LIMITS, GRACE_CLOSE_MS: 5, CLOSE_HARD_TIMEOUT_MS: 10 },
    killTree: () => true,
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const record = manager.sessions.get(session.browserSessionId);
  record.context.close = () => new Promise(() => {});
  record.browser.close = () => new Promise(() => {});
  const started = Date.now();
  const count = await manager.closeAll('sigterm-test');
  assert.equal(count, 1);
  assert.ok(Date.now() - started < 2000);
});

/**
 * Builds a minimal route/request pair for directly exercising handleRoute.
 * @param {{ url: string, fetch: Function, isNavigation?: boolean, method?: string }} input
 */
function routeHarness(input) {
  const calls = { aborted: false, fulfilled: false, fetchUrls: [], fetchOptions: [] };
  const route = {
    continue: async () => {},
    abort: async () => { calls.aborted = true; },
    fulfill: async () => { calls.fulfilled = true; },
    fetch: async (options = {}) => {
      calls.fetchOptions.push(options);
      calls.fetchUrls.push(options.url || input.url);
      return input.fetch(options, calls.fetchUrls.length);
    },
  };
  const request = {
    url: () => input.url,
    method: () => input.method || 'GET',
    resourceType: () => 'script',
    isNavigationRequest: () => input.isNavigation === true,
    postDataBuffer: () => undefined,
    headers: () => input.headers || {},
    frame: () => null,
  };
  return { route, request, calls };
}

test('subresource redirect to a metadata address is blocked before it is fetched', async () => {
  // Metadata is allowlisted on purpose: the redirect hop must still be blocked
  // by the always-blocked address rule, not merely by the origin allowlist.
  const { manager } = createManager({
    resolvePolicy: () => ({
      allowedOrigins: ['https://example.com', 'http://169.254.169.254'],
      blockedPorts: [],
      unblockedPorts: [],
    }),
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({
    url: 'https://example.com/asset.js',
    fetch: async () => ({
      status: () => 302,
      headers: () => ({ location: 'http://169.254.169.254/latest/meta-data/' }),
      ok: () => false,
    }),
  });
  await routeHandler(route, request);
  assert.equal(calls.aborted, true);
  assert.equal(calls.fulfilled, false);
  // Only the allowlisted first hop was fetched; the metadata hop never was.
  assert.deepEqual(calls.fetchUrls, ['https://example.com/asset.js']);
  const network = manager.pullNetwork(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE);
  assert.ok(network.entries.some((entry) => entry.blocked === true && entry.blockedReason === 'blocked-address'));
});

test('subresource redirect to an allowlisted target is followed and fulfilled', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({
    url: 'https://example.com/asset.js',
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: '/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(route, request);
  assert.equal(calls.aborted, false);
  assert.equal(calls.fulfilled, true);
  assert.deepEqual(calls.fetchUrls, ['https://example.com/asset.js', 'https://example.com/final.js']);
});

test('a redirect chain past MAX_REDIRECTS fails closed', async () => {
  const { manager } = createManager({ limits: { ...BROWSER_LIMITS, MAX_REDIRECTS: 2 } });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({
    url: 'https://example.com/loop',
    fetch: async () => ({
      status: () => 302,
      headers: () => ({ location: 'https://example.com/loop' }),
      ok: () => false,
    }),
  });
  await routeHandler(route, request);
  assert.equal(calls.aborted, true);
  assert.equal(calls.fulfilled, false);
  // 1 original + MAX_REDIRECTS followed hops, then stop.
  assert.equal(calls.fetchUrls.length, 3);
});

test('blocks a self-origin even when the workspace allowlists it', async () => {
  const { manager } = createManager({ selfOrigins: ['https://example.com'] });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({ url: 'https://example.com/browser', fetch: async () => ({ status: () => 200, headers: () => ({}), ok: () => true }) });
  await routeHandler(route, request);
  assert.equal(calls.aborted, true);
  const network = manager.pullNetwork(session.browserSessionId, tab.browserTabId, OWNER, {}, SCOPE);
  assert.ok(network.entries.some((entry) => entry.blockedReason === 'self-origin'));
  await assert.rejects(
    () => manager.navigate(session.browserSessionId, tab.browserTabId, 'https://example.com/', OWNER, SCOPE),
    (err) => err instanceof BrowserError && err.code === 'navigation-blocked',
  );
});

test('screenshot rejects a concurrent frame with screenshot-busy', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  let release;
  tab.page.screenshot = () => new Promise((resolve) => { release = resolve; });
  const first = manager.screenshot(session.browserSessionId, tabInfo.browserTabId, OWNER, { ...SCOPE, force: true });
  await assert.rejects(
    () => manager.screenshot(session.browserSessionId, tabInfo.browserTabId, OWNER, { ...SCOPE, force: true }),
    (err) => err instanceof BrowserError && err.code === 'screenshot-busy' && err.status === 429,
  );
  release(Buffer.from('frame'));
  assert.equal((await first).mimeType, 'image/jpeg');
});

test('REST input shares the per-tab rate limit with the WS channel', async () => {
  const { manager, setClock } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const event = { kind: 'key', action: 'press', key: 'Enter' };
  await manager.dispatchInput(session.browserSessionId, tab.browserTabId, OWNER, event, SCOPE);
  await assert.rejects(
    () => manager.dispatchInput(session.browserSessionId, tab.browserTabId, OWNER, event, SCOPE),
    (err) => err instanceof BrowserError && err.code === 'input-rate-limited' && err.status === 429,
  );
  setClock(1_000_000 + BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS + 1);
  const result = await manager.dispatchInput(session.browserSessionId, tab.browserTabId, OWNER, event, SCOPE);
  assert.equal(result.ok, true);
});

test('getState derives canGoBack/canGoForward from real CDP navigation history', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const context = manager.sessions.get(session.browserSessionId).context;
  context.navigationHistory = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const state = await manager.getState(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
  assert.equal(state.canGoBack, true);
  assert.equal(state.canGoForward, true);

  context.navigationHistory = { currentIndex: 0, entries: [{ id: 1 }] };
  const first = await manager.getState(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
  assert.equal(first.canGoBack, false);
  assert.equal(first.canGoForward, false);
});

test('cross-origin redirect strips credentials; same-origin redirect keeps them', async () => {
  const { manager } = createManager({
    resolvePolicy: () => ({
      allowedOrigins: ['https://example.com', 'https://cdn.test'],
      blockedPorts: [],
      unblockedPorts: [],
    }),
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const headers = { cookie: 'sid=supersecret', authorization: 'Bearer tok123', accept: '*/*' };

  const cross = routeHarness({
    url: 'https://example.com/asset.js',
    headers,
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://cdn.test/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(cross.route, cross.request);
  assert.equal(cross.calls.fulfilled, true);
  assert.deepEqual(cross.calls.fetchUrls, ['https://example.com/asset.js', 'https://cdn.test/final.js']);
  // The first hop reuses the original request untouched.
  assert.equal(cross.calls.fetchOptions[0].headers, undefined);
  const xHeaders = cross.calls.fetchOptions[1].headers;
  assert.equal(xHeaders.cookie, '', 'cookie must be cleared on a cross-origin hop');
  assert.equal(xHeaders.authorization, '', 'authorization must be cleared on a cross-origin hop');
  assert.equal(xHeaders['proxy-authorization'], '');
  assert.equal(xHeaders.accept, '*/*', 'non-sensitive headers are preserved');

  const same = routeHarness({
    url: 'https://example.com/asset.js',
    headers,
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://example.com/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(same.route, same.request);
  assert.equal(same.calls.fulfilled, true);
  assert.equal(same.calls.fetchOptions[1].headers, undefined, 'same-origin hop keeps the original headers');
});

test('closeSession bounds a hanging CDP detach by the hard cleanup timeout', async () => {
  const { driver } = createFakeDriver();
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    limits: { ...BROWSER_LIMITS, GRACE_CLOSE_MS: 5, CLOSE_HARD_TIMEOUT_MS: 20 },
    killTree: () => true,
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  // A wedged CDP connection must never block teardown.
  tab.cdpSession = { detach: () => new Promise(() => {}) };
  const started = Date.now();
  await manager.closeSession(session.browserSessionId, OWNER, { scope: SCOPE });
  const elapsed = Date.now() - started;
  assert.equal(manager.sessions.has(session.browserSessionId), false);
  assert.ok(elapsed < 1000, `hanging detach bounded to ${elapsed}ms`);
});

test('concurrent createSession calls cannot exceed the per-owner limit', async () => {
  const { manager } = createManager();
  const attempts = BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER + 1;
  const results = await Promise.all(
    Array.from({ length: attempts }, () => (
      manager.createSession({ ownerSessionId: OWNER, ...SCOPE }).then(() => 'ok', (err) => err?.code)
    )),
  );
  const okCount = results.filter((result) => result === 'ok').length;
  const limitedCount = results.filter((result) => result === 'session-limit').length;
  assert.equal(okCount, BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER);
  assert.equal(limitedCount, 1);
  assert.equal(manager.sessions.size, BROWSER_LIMITS.MAX_SESSIONS_PER_OWNER);
});

test('screenshot is captured in CSS pixels so image pixels match click coordinates', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({
    ownerSessionId: OWNER,
    ...SCOPE,
    viewport: { width: 390, height: 844, dpr: 2, hasTouch: true },
  });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  const frame = await manager.screenshot(session.browserSessionId, tabInfo.browserTabId, OWNER, { ...SCOPE, force: true });
  assert.equal(tab.page.screenshotOptions.scale, 'css');
  assert.equal(frame.width, 390);
  assert.equal(frame.height, 844);
  assert.equal(frame.dpr, 2);
});

test('resize preserves deviceScaleFactor and touch instead of resetting them', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({
    ownerSessionId: OWNER,
    ...SCOPE,
    viewport: { width: 390, height: 844, dpr: 1, hasTouch: false },
  });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  await manager.dispatchInput(
    session.browserSessionId,
    tabInfo.browserTabId,
    OWNER,
    { kind: 'resize', viewport: { width: 800, height: 600 } },
    SCOPE,
  );
  const state = await manager.getState(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  assert.equal(state.viewport.width, 800);
  assert.equal(state.viewport.height, 600);
  assert.equal(state.dpr, 1);
  assert.equal(state.hasTouch, false);
});

test('browser_input click and fill drive Playwright locators and fail closed without a target', async () => {
  const { manager, setClock } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  tab.page._elements = [{ role: 'button', name: 'Save', bounds: { x: 1, y: 2, width: 30, height: 20 } }];

  const clicked = await manager.dispatchInput(
    session.browserSessionId,
    tabInfo.browserTabId,
    OWNER,
    { kind: 'click', selector: '#save' },
    SCOPE,
  );
  assert.equal(clicked.kind, 'click');
  assert.equal(tab.page._elements[0].clicked, true);
  assert.equal(tab.page.locatorQueries[0], '#save');

  setClock(1_000_000 + BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS + 1);
  const filled = await manager.dispatchInput(
    session.browserSessionId,
    tabInfo.browserTabId,
    OWNER,
    { kind: 'fill', role: 'button', name: 'Save', value: 'hello' },
    SCOPE,
  );
  assert.equal(filled.kind, 'fill');
  assert.equal(tab.page._elements[0].filled, 'hello');
  assert.equal(tab.page.locatorQueries.at(-1), 'role=button');

  setClock(1_000_000 + 2 * (BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS + 1));
  await assert.rejects(
    () => manager.dispatchInput(session.browserSessionId, tabInfo.browserTabId, OWNER, { kind: 'click' }, SCOPE),
    (err) => err instanceof BrowserError && err.code === 'locator-required' && err.status === 400,
  );
});

test('getVisibleElements filters invisible/zero-size nodes and bounds the listing', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  tab.page._elements = [
    { role: 'button', name: 'Save', bounds: { x: 10, y: 20, width: 100, height: 40 } },
    { role: 'link', name: 'Hidden', visible: false },
    { role: 'textbox', name: 'Email', bounds: { x: 10, y: 80, width: 200, height: 30 } },
    { role: 'button', name: 'Zero', bounds: { x: 0, y: 0, width: 0, height: 0 } },
  ];
  const result = await manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, { ...SCOPE, limit: 10 });
  assert.equal(result.count, 2);
  assert.deepEqual(result.elements.map((el) => el.name), ['Save', 'Email']);
  assert.deepEqual(result.elements[0].bounds, { x: 10, y: 20, width: 100, height: 40 });
  assert.ok(BROWSER_ELEMENTS_SELECTOR.includes('button'));
  // The scan uses the shared interactive selector, which Playwright resolves
  // across open shadow roots (Lit components).
  assert.equal(tab.page.locatorQueries[0], BROWSER_ELEMENTS_SELECTOR);
  assert.equal(result.truncated, false);

  const capped = await manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, { ...SCOPE, limit: 1 });
  assert.equal(capped.count, 1);
  assert.equal(capped.truncated, true);
});

test('describePageElement reads role/name and builds a shadow-piercing selector', () => {
  const documentRoot = {};
  const outerParent = {
    nodeType: 1,
    tagName: 'DIV',
    id: 'app',
    parentElement: null,
    children: [],
    getAttribute: () => null,
    getRootNode: () => documentRoot,
  };
  const shadowRoot = { host: null };
  const host = {
    nodeType: 1,
    tagName: 'MY-BUTTON',
    id: '',
    parentElement: outerParent,
    children: [],
    getAttribute: (name) => (name === 'class' ? 'btn primary' : null),
    getRootNode: () => documentRoot,
  };
  shadowRoot.host = host;
  const button = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: 'save',
    parentElement: null,
    children: [],
    innerText: 'Save',
    textContent: 'Save',
    disabled: false,
    checked: undefined,
    getAttribute: (name) => (name === 'aria-label' ? 'Save' : null),
    getRootNode: () => shadowRoot,
  };

  const descriptor = describePageElement(button, 50);
  assert.equal(descriptor.tag, 'button');
  assert.equal(descriptor.role, 'button');
  assert.equal(descriptor.name, 'Save');
  assert.equal(descriptor.text, 'Save');
  assert.match(descriptor.selector, /#save/);
  assert.match(descriptor.selector, /my-button\.btn\.primary >> #save/);
});

