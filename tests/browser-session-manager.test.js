/**
 * BrowserSessionManager contract tests using a fake Playwright driver.
 * Covers limits, isolation, policy wiring, redaction, rate limiting and cleanup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BrowserError,
  BrowserSessionManager,
  BROWSER_ELEMENTS_DEFAULT_LIMIT,
  BROWSER_ELEMENTS_MAX_LIMIT,
  BROWSER_ELEMENTS_SELECTOR,
  describePageElement,
  describePageElementsBatch,
  mapPreviewPoint,
} from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import { LOCAL_LOGIN_HEADER, getLocalLoginToken } from '../lib/local-login.js';

/** Scope used by every session in this file (one workspace per test). */
const SCOPE = { workspaceFile: '/ws/a' };
const OWNER = 'owner-a';

/**
 * The exact interactive selector list `browser_elements` scans with. Pinned so
 * a dropped or reordered entry is caught instead of only "still mentions
 * button": every control family an agent is told it can drive must stay here.
 */
const EXPECTED_ELEMENTS_SELECTORS = Object.freeze([
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
]);

/**
 * The local-login header value found in any captured `route.fetch` option set.
 * An empty string is the cross-origin strip working, so only a non-empty value
 * is a leak; '' is returned when no hop carries the token.
 * @param {{ fetchOptions: Array<Record<string, any>> }} calls
 * @returns {string}
 */
function leakedLocalLoginToken(calls) {
  const token = getLocalLoginToken();
  for (const options of calls.fetchOptions) {
    const headers = options?.headers;
    if (!headers || typeof headers !== 'object') continue;
    for (const [name, value] of Object.entries(headers)) {
      if (String(name).toLowerCase() !== LOCAL_LOGIN_HEADER) continue;
      const text = String(value ?? '');
      if (text) return text === token ? '<real-token>' : text;
    }
  }
  return '';
}

/**
 * Entry fixture → DOM-shaped node for the page-side scan. Entries may carry
 * `attrs`, `tag`, `text`, `bounds`, `hidden`, `rectThrows`; without `attrs` the
 * descriptor-shaped `role`/`name` are mapped onto the attributes a real element
 * would have, so the same fixtures drive both the action locators and the scan.
 * @param {Record<string, any>} entry
 */
function pageElementNode(entry) {
  const attrs = entry.attrs || {
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.name ? { 'aria-label': entry.name } : {}),
  };
  const text = entry.text ?? entry.name ?? '';
  return {
    nodeType: 1,
    tagName: String(entry.tag || 'button').toUpperCase(),
    hidden: entry.hidden === true || entry.visible === false,
    isConnected: entry.disconnected !== true,
    parentElement: entry.parentElement || null,
    children: entry.children || [],
    innerText: text,
    textContent: text,
    disabled: entry.disabled === true,
    checked: entry.checked,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getBoundingClientRect: () => {
      if (entry.rectThrows) throw new Error(entry.rectThrows);
      if (entry.bounds === null) return null;
      return entry.bounds || { x: 1, y: 2, width: 30, height: 20 };
    },
  };
}

/**
 * Minimal Playwright locator stand-in. `_elements` entries are descriptor-shaped
 * for the `browser_input` action tests and become DOM-shaped nodes for the
 * single-pass scan, so the real page-side `describePageElementsBatch` does the
 * visibility, bounds and limit work exactly as it does in Chromium (here in the
 * Node realm, which is also what lets a test drive `getComputedStyle`/`CSS`).
 * Page-level `_locatorFail`, `_elementsReport` and `_locatorNoEvaluateAll` let a
 * test reach the error and clamp branches of `getVisibleElements`.
 */
function makeLocator(entries, page) {
  const handle = (entry) => ({
    _entry: entry,
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
    // `failWith` lets a test make one action throw so the 502 mapping is covered.
    async selectOption(option, options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.selectOption = option;
      entry.selectOptionOptions = options;
    },
    async check(options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.checked = true;
      entry.checkOptions = options;
    },
    async uncheck(options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.checked = false;
      entry.uncheckOptions = options;
    },
    async hover(options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.hovered = true;
      entry.hoverOptions = options;
    },
    async dragTo(target, options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.dragged = true;
      entry.dragTarget = target?._entry || null;
      entry.dragOptions = options;
    },
    async setInputFiles(files, options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.uploadedFiles = files;
      entry.uploadOptions = options;
    },
    async waitFor(options) {
      if (entry.failWith) throw new Error(entry.failWith);
      entry.waitedFor = options;
    },
  });
  const locator = {
    async count() {
      const failure = page?._locatorFail?.count;
      if (failure) throw new Error(failure);
      return entries.length;
    },
    async evaluateAll(fn, arg) {
      const failure = page?._locatorFail?.evaluateAll;
      if (failure) throw new Error(failure);
      if (page?._elementsReport) return page._elementsReport;
      const nodes = entries.map((entry) => pageElementNode(entry));
      if (page) page._evaluateAllCalls.push({ fn, arg });
      return fn(nodes, arg || {});
    },
    nth(index) {
      const entry = entries[index] || {};
      entry.nthRequested = index;
      return handle(entry);
    },
    first() {
      const entry = entries[0] || {};
      entry.firstRequested = true;
      return handle(entry);
    },
  };
  // `_locatorNoEvaluateAll` stands in for a driver whose scan shape the manager
  // does not support, which must fail closed instead of falling back.
  if (page?._locatorNoEvaluateAll) delete locator.evaluateAll;
  return locator;
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
      this._evaluateAllCalls = [];
      this.screenshotOptions = null;
      this.locatorQueries = [];
      this.gotoCalls = [];
      this.waitForCalls = [];
      this.keyboardTypeCalls = [];
      this.keyboardPressCalls = [];
      this.mouse = { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {}, wheel: async () => {} };
      this.keyboard = {
        type: async (text, options) => { this.keyboardTypeCalls.push({ text, options }); },
        down: async () => {},
        up: async () => {},
        press: async (key) => { this.keyboardPressCalls.push(key); },
      };
      this.touchscreen = { tap: async () => {} };
      this._touch = false;
    }
    locator(selector) {
      this.locatorQueries.push(selector);
      return makeLocator(this._elements, this);
    }
    getByRole(role, options = {}) {
      this.locatorQueries.push(`role=${role}`);
      return makeLocator(this._elements.filter((entry) => entry.role === role
        && (!options.name || entry.name === options.name)), this);
    }
    getByText(value) {
      this.locatorQueries.push(`text=${value}`);
      return makeLocator(this._elements.filter((entry) => (entry.text || entry.name) === value), this);
    }
    getByLabel(value) {
      this.locatorQueries.push(`label=${value}`);
      return makeLocator(this._elements.filter((entry) => entry.label === value), this);
    }
    getByPlaceholder(value) {
      this.locatorQueries.push(`placeholder=${value}`);
      return makeLocator(this._elements.filter((entry) => entry.placeholder === value), this);
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, ...args) {
      for (const handler of this._handlers.get(event) || []) handler(...args);
    }
    async goto(url, options) {
      this.gotoCalls.push({ url, options: options || {} });
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
    async waitForSelector(selector, options) { this.waitForCalls.push({ type: 'selector', selector, options }); }
    async waitForLoadState(state, options) { this.waitForCalls.push({ type: 'loadState', state, options }); }
    async waitForURL(pattern, options) { this.waitForCalls.push({ type: 'url', pattern, options }); }
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
  // The local-login token is a passwordless credential and a Browser context
  // reaches every allowlisted origin, so it must never be injected context-wide
  // — it is attached per request only when the hop targets Cretli's own origin.
  assert.equal(state.contextOptions[0].extraHTTPHeaders, undefined);
  assert.ok(
    !JSON.stringify(state.contextOptions[0]).includes('x-cretli-local-login'),
    JSON.stringify(state.contextOptions[0]),
  );
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

test('sweepIdle spares a session with a live /ws-browser subscriber until it releases', async () => {
  const { manager, setClock } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  // The count lives on the manager so ws-handler.js never needs importing here;
  // the /ws-browser handler is the caller that now holds a live subscriber.
  const release = manager.addWsSubscriber(session.browserSessionId, 'sub-1');
  assert.equal(manager.hasLiveWsSubscriber(session.browserSessionId), true);

  setClock(1_000_000 + BROWSER_LIMITS.IDLE_TIMEOUT_MS + 1);
  // A live watcher must block the idle sweep even past the timeout.
  assert.deepEqual(manager.sweepIdle(), [], 'a live subscriber must keep the session alive');
  assert.equal(manager.sessions.has(session.browserSessionId), true);

  // After the socket closes (release), the session is idle again and sweepable.
  release();
  assert.equal(manager.hasLiveWsSubscriber(session.browserSessionId), false);
  assert.deepEqual(manager.sweepIdle(), [session.browserSessionId], 'released session is swept again');
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

test('scroll input moves the mouse to the preview point and wheels with the delta', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab: tabObj } = manager.requireTab(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
  const moves = [];
  const wheels = [];
  tabObj.page.mouse.move = async (x, y) => { moves.push({ x, y }); };
  tabObj.page.mouse.wheel = async (dx, dy) => { wheels.push({ dx, dy }); };
  await manager.dispatchInput(session.browserSessionId, tab.browserTabId, OWNER, {
    kind: 'scroll',
    point: { x: 195, y: 422 },
    preview: { width: 390, height: 844 },
    deltaX: 12,
    deltaY: -34,
  }, SCOPE);
  // The touch point must be mapped into the page viewport before wheeling, so a
  // mobile drag scrolls where the finger is, not at (0,0).
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0], { x: 195, y: 422 });
  assert.equal(wheels.length, 1);
  assert.deepEqual(wheels[0], { dx: 12, dy: -34 });
});

test('pointer tap uses touchscreen.tap on a touch-capable viewport', async () => {
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, OWNER, SCOPE);
  const { tab: tabObj } = manager.requireTab(session.browserSessionId, tab.browserTabId, OWNER, SCOPE);
  const taps = [];
  tabObj.page.touchscreen.tap = async (x, y) => { taps.push({ x, y }); };
  await manager.dispatchInput(session.browserSessionId, tab.browserTabId, OWNER, {
    kind: 'pointer',
    action: 'tap',
    point: { x: 100, y: 200 },
    preview: { width: 390, height: 844 },
  }, SCOPE);
  assert.equal(taps.length, 1);
  assert.deepEqual(taps[0], { x: 100, y: 200 });
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
  // Nothing in this manager has a self origin, so no hop on either chain may
  // carry the passwordless local-login credential toward a foreign origin.
  assert.equal(leakedLocalLoginToken(cross.calls), '', JSON.stringify(cross.calls.fetchOptions));
  assert.equal(leakedLocalLoginToken(same.calls), '', JSON.stringify(same.calls.fetchOptions));
});

test('a foreign allowlisted origin never receives the local-login token', async () => {
  // The workspace allowlists a third-party origin and the manager has no self
  // origins configured, so every hop here targets a foreign origin.
  const { manager } = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({
    url: 'https://example.com/asset.js',
    headers: { accept: '*/*', cookie: 'sid=page-cookie' },
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://example.com/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(route, request);
  assert.equal(calls.aborted, false);
  assert.equal(calls.fulfilled, true);
  assert.deepEqual(calls.fetchUrls, ['https://example.com/asset.js', 'https://example.com/final.js']);
  // The first hop is replayed untouched — no header set is added at all.
  assert.equal(calls.fetchOptions[0].headers, undefined);
  assert.equal(leakedLocalLoginToken(calls), '', JSON.stringify(calls.fetchOptions));
  const token = getLocalLoginToken();
  assert.ok(!JSON.stringify(calls.fetchOptions).includes(token), 'the raw token must never reach route.fetch');
});

test('a hop targeting a self origin carries the local-login token', async () => {
  // `allowSelfOrigin` is the explicit debug opt-in that lets the Browser
  // preview the Cretli UI; that is exactly the case the token must follow.
  const { manager } = createManager({
    selfOrigins: ['https://app.cretli.test'],
    resolvePolicy: () => ({
      allowedOrigins: ['https://app.cretli.test'],
      blockedPorts: [],
      unblockedPorts: [],
      allowSelfOrigin: true,
    }),
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const { route, request, calls } = routeHarness({
    url: 'https://app.cretli.test/',
    headers: { accept: 'text/html' },
    fetch: async () => ({ status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(route, request);
  assert.equal(calls.aborted, false);
  assert.equal(calls.fulfilled, true);
  const firstHeaders = calls.fetchOptions[0].headers;
  assert.equal(firstHeaders[LOCAL_LOGIN_HEADER], getLocalLoginToken());
  assert.equal(firstHeaders.accept, 'text/html', 'the original headers are preserved next to the token');

  // `baseHeaders` is null when the intercepted request exposes no `headers()`
  // (the FakePage.goto harness), so the explicit merge must not throw there and
  // must still deliver the credential to Cretli's own origin.
  const bare = routeHarness({
    url: 'https://app.cretli.test/api/login',
    fetch: async () => ({ status: () => 200, headers: () => ({}), ok: () => true }),
  });
  delete bare.request.headers;
  await routeHandler(bare.route, bare.request);
  assert.equal(bare.calls.aborted, false);
  assert.equal(bare.calls.fulfilled, true);
  assert.deepEqual(Object.keys(bare.calls.fetchOptions[0].headers), [LOCAL_LOGIN_HEADER]);
  assert.equal(bare.calls.fetchOptions[0].headers[LOCAL_LOGIN_HEADER], getLocalLoginToken());
});

test('a self-origin redirect chain keeps the token, a hop leaving to a foreign origin strips it', async () => {
  const { manager } = createManager({
    selfOrigins: ['https://app.cretli.test'],
    resolvePolicy: () => ({
      allowedOrigins: ['https://app.cretli.test', 'https://cdn.test'],
      blockedPorts: [],
      unblockedPorts: [],
      allowSelfOrigin: true,
    }),
  });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  const routeHandler = manager.sessions.get(session.browserSessionId).context.routes[0];
  const token = getLocalLoginToken();

  // Same-origin hop inside Cretli's own origin: the token must survive so a
  // redirect chain within the preview keeps authenticating.
  const withinSelf = routeHarness({
    url: 'https://app.cretli.test/start.js',
    headers: { accept: '*/*' },
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://app.cretli.test/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(withinSelf.route, withinSelf.request);
  assert.equal(withinSelf.calls.fulfilled, true);
  assert.equal(withinSelf.calls.fetchOptions[0].headers[LOCAL_LOGIN_HEADER], token);
  assert.equal(withinSelf.calls.fetchOptions[1].headers[LOCAL_LOGIN_HEADER], token);

  // A redirect into Cretli's own origin must authenticate even though the hop
  // is cross-origin, so the token is re-injected after the credential strip.
  const intoSelf = routeHarness({
    url: 'https://cdn.test/start.js',
    headers: { accept: '*/*', cookie: 'sid=page-cookie' },
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://app.cretli.test/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(intoSelf.route, intoSelf.request);
  assert.equal(intoSelf.calls.fulfilled, true);
  assert.equal(intoSelf.calls.fetchOptions[0].headers, undefined, 'a foreign first hop gets no header set');
  assert.equal(intoSelf.calls.fetchOptions[1].headers[LOCAL_LOGIN_HEADER], token);
  assert.equal(intoSelf.calls.fetchOptions[1].headers.cookie, '', 'the page cookie is still stripped');

  // Leaving a self origin toward a foreign origin forces the token to '' —
  // the credential must not follow the redirect out of Cretli.
  const outOfSelf = routeHarness({
    url: 'https://app.cretli.test/start.js',
    headers: { accept: '*/*', 'x-cretli-local-login': 'stale-value-set-by-the-page', cookie: 'sid=page-cookie' },
    fetch: async (_options, callIndex) => (callIndex === 1
      ? { status: () => 302, headers: () => ({ location: 'https://cdn.test/final.js' }), ok: () => false }
      : { status: () => 200, headers: () => ({}), ok: () => true }),
  });
  await routeHandler(outOfSelf.route, outOfSelf.request);
  assert.equal(outOfSelf.calls.fulfilled, true);
  assert.equal(outOfSelf.calls.fetchOptions[0].headers[LOCAL_LOGIN_HEADER], token);
  const foreignHeaders = outOfSelf.calls.fetchOptions[1].headers;
  assert.equal(foreignHeaders[LOCAL_LOGIN_HEADER], '', 'the strip must outlast any re-injection');
  assert.equal(foreignHeaders.cookie, '');
  assert.equal(foreignHeaders.accept, '*/*');
  assert.ok(!JSON.stringify(foreignHeaders).includes(token), 'the real token must not ride along to a foreign origin');
  assert.equal(leakedLocalLoginToken(outOfSelf.calls), '<real-token>', 'only the self hop may carry it');
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
  assert.deepEqual(BROWSER_ELEMENTS_SELECTOR.split(', '), [...EXPECTED_ELEMENTS_SELECTORS]);
  assert.deepEqual(BROWSER_ELEMENTS_SELECTOR.split(', ').filter((part) => !part.startsWith('[role=')), [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable=""]', '[contenteditable="true"]',
  ], 'the tag selectors and the ARIA selectors are both still scanned');
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

/**
 * Harness for the `browser_input` kinds: one session, one tab and a dispatcher
 * that always steps the fake clock past INPUT_MIN_INTERVAL_MS, so a test can
 * send several events in a row without tripping the per-tab rate limit.
 */
async function createInputHarness(overrides = {}, scope = SCOPE) {
  const { manager, state, setClock } = createManager(overrides);
  const session = await manager.createSession({ ownerSessionId: OWNER, ...scope });
  const [tabInfo] = manager.listTabs(session.browserSessionId, OWNER, scope);
  const { tab } = manager.requireTab(session.browserSessionId, tabInfo.browserTabId, OWNER, scope);
  let clock = 1_000_000;
  const send = (event) => {
    clock += BROWSER_LIMITS.INPUT_MIN_INTERVAL_MS + 1;
    setClock(clock);
    return manager.dispatchInput(session.browserSessionId, tabInfo.browserTabId, OWNER, event, scope);
  };
  return { manager, state, session, tabInfo, tab, send, scope, setClock };
}

test('input kind select resolves the option by value, label and index', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'combobox', name: 'Pet' }];

  const byValue = await send({ kind: 'select', selector: '#pet', value: 'dog' });
  assert.equal(byValue.kind, 'select');
  assert.deepEqual(tab.page._elements[0].selectOption, 'dog');
  assert.equal(tab.page._elements[0].selectOptionOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

  tab.page._elements[0].selectOption = undefined;
  await send({ kind: 'select', selector: '#pet', optionLabel: 'Dog' });
  assert.deepEqual(tab.page._elements[0].selectOption, { label: 'Dog' });

  tab.page._elements[0].selectOption = undefined;
  await send({ kind: 'select', selector: '#pet', optionIndex: 2 });
  assert.deepEqual(tab.page._elements[0].selectOption, { index: 2 });

  // optionIndex wins over optionLabel, which wins over value.
  tab.page._elements[0].selectOption = undefined;
  await send({ kind: 'select', selector: '#pet', value: 'dog', optionLabel: 'Dog', optionIndex: 1 });
  assert.deepEqual(tab.page._elements[0].selectOption, { index: 1 });

  // A multi-select receives one option object per value.
  tab.page._elements[0].selectOption = undefined;
  await send({ kind: 'select', selector: '#pet', value: ['cat', 'dog'] });
  assert.deepEqual(tab.page._elements[0].selectOption, ['cat', 'dog']);
});

test('input kind select fails closed on a missing or malformed option', async () => {
  const { send } = await createInputHarness();
  await assert.rejects(
    () => send({ kind: 'select', selector: '#pet' }),
    (err) => err instanceof BrowserError && err.code === 'select-option-required' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'select', selector: '#pet', optionIndex: -1 }),
    (err) => err.code === 'select-option-invalid' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'select', selector: '#pet', optionIndex: 1.5 }),
    (err) => err.code === 'select-option-invalid' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'select', selector: '#pet', value: 7 }),
    (err) => err.code === 'select-option-invalid' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'select' }),
    (err) => err.code === 'locator-required' && err.status === 400,
  );
});

test('input kinds check, uncheck and hover drive their locator actions', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'checkbox', name: 'Terms' }];

  const checked = await send({ kind: 'check', role: 'checkbox', name: 'Terms' });
  assert.equal(checked.kind, 'check');
  assert.equal(tab.page._elements[0].checked, true);
  assert.equal(tab.page._elements[0].checkOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

  const unchecked = await send({ kind: 'uncheck', role: 'checkbox', name: 'Terms' });
  assert.equal(unchecked.kind, 'uncheck');
  assert.equal(tab.page._elements[0].checked, false);
  assert.equal(tab.page._elements[0].uncheckOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

  const hovered = await send({ kind: 'hover', selector: '#menu' });
  assert.equal(hovered.kind, 'hover');
  assert.equal(tab.page._elements[0].hovered, true);
  assert.equal(tab.page._elements[0].hoverOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

  for (const kind of ['check', 'uncheck', 'hover']) {
    await assert.rejects(
      () => send({ kind }),
      (err) => err instanceof BrowserError && err.code === 'locator-required' && err.status === 400,
    );
  }
});

test('input kind check reports a locator failure as 502, not a silent success', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'checkbox', name: 'Terms', failWith: 'element is not a checkbox' }];
  await assert.rejects(
    () => send({ kind: 'check', selector: '#terms' }),
    (err) => err instanceof BrowserError && err.code === 'locator-failed' && err.status === 502
      && /not a checkbox/.test(err.message),
  );
});

test('input kind drag drops the source onto a separate destination', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [
    { role: 'button', name: 'Source' },
    { role: 'listitem', name: 'Target' },
  ];

  const dragged = await send({ kind: 'drag', role: 'button', name: 'Source', toRole: 'listitem', toName: 'Target' });
  assert.equal(dragged.kind, 'drag');
  assert.equal(tab.page._elements[0].dragged, true);
  assert.equal(tab.page._elements[0].dragTarget, tab.page._elements[1]);
  assert.equal(tab.page._elements[0].dragOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

  // A selector destination resolves its own locator: it is queried separately
  // from the source, so the two can never collapse into one element.
  tab.page.locatorQueries.length = 0;
  tab.page._elements[0].dragged = false;
  tab.page._elements[0].dragTarget = null;
  await send({ kind: 'drag', selector: '#src', toSelector: '#dst', toNth: 1 });
  assert.deepEqual(tab.page.locatorQueries, ['#src', '#dst']);
  assert.equal(tab.page._elements[0].dragged, true);
  assert.equal(tab.page._elements[0].dragTarget, tab.page._elements[1]);

  // A missing destination is a clear 400 and must never fall back to the source.
  tab.page._elements[0].dragged = false;
  tab.page._elements[1].dragged = false;
  await assert.rejects(
    () => send({ kind: 'drag', selector: '#src' }),
    (err) => err instanceof BrowserError && err.code === 'drag-target-required' && err.status === 400,
  );
  assert.equal(tab.page._elements[0].dragged, false);
  assert.equal(tab.page._elements[1].dragged, false);
  await assert.rejects(
    () => send({ kind: 'drag', toSelector: '#dst' }),
    (err) => err.code === 'locator-required' && err.status === 400,
  );
});

test('input kind wait accepts only the bounded whitelisted conditions', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'status', name: 'Saved' }];

  const bySelector = await send({ kind: 'wait', selector: '#ready', state: 'attached', timeout: 1000 });
  assert.equal(bySelector.kind, 'wait');
  assert.deepEqual(tab.page.waitForCalls.at(-1), {
    type: 'selector',
    selector: '#ready',
    options: { state: 'attached', timeout: 1000 },
  });

  await send({ kind: 'wait', loadState: 'networkidle' });
  assert.deepEqual(tab.page.waitForCalls.at(-1), {
    type: 'loadState',
    state: 'networkidle',
    options: { timeout: BROWSER_LIMITS.LOCATOR_TIMEOUT_MS },
  });

  await send({ kind: 'wait', url: 'https://example.com/done' });
  assert.deepEqual(tab.page.waitForCalls.at(-1), {
    type: 'url',
    pattern: 'https://example.com/done',
    options: { timeout: BROWSER_LIMITS.LOCATOR_TIMEOUT_MS },
  });

  // `text` goes through a locator (no script evaluation), like every other kind.
  await send({ kind: 'wait', text: 'Saved' });
  assert.deepEqual(tab.page._elements[0].waitedFor, {
    state: 'visible',
    timeout: BROWSER_LIMITS.LOCATOR_TIMEOUT_MS,
  });

  await assert.rejects(
    () => send({ kind: 'wait' }),
    (err) => err instanceof BrowserError && err.code === 'wait-target-required' && err.status === 400,
  );
  // An arbitrary expression is rejected: the module promises no script eval.
  await assert.rejects(
    () => send({ kind: 'wait', expression: 'document.readyState === "complete"' }),
    (err) => err.code === 'wait-target-required' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'wait', predicate: () => true }),
    (err) => err.code === 'wait-target-required' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'wait', selector: '#ready', state: 'glowing' }),
    (err) => err.code === 'wait-state-invalid' && err.status === 400,
  );
  await assert.rejects(
    () => send({ kind: 'wait', loadState: 'idle' }),
    (err) => err.code === 'wait-loadstate-invalid' && err.status === 400,
  );
});

test('input kind wait clamps its timeout so a wedged page cannot block the tab', async () => {
  const { tab, send } = await createInputHarness();
  const clamped = await send({ kind: 'wait', selector: '#ready', timeout: 10 * 60 * 1000 });
  assert.equal(clamped.timeout, BROWSER_LIMITS.MAX_WAIT_TIMEOUT_MS);
  assert.equal(tab.page.waitForCalls.at(-1).options.timeout, BROWSER_LIMITS.MAX_WAIT_TIMEOUT_MS);

  // 0 would disable Playwright's timeout entirely, so the floor is 1ms.
  const floored = await send({ kind: 'wait', selector: '#ready', timeout: 0 });
  assert.equal(floored.timeout, 1);
  const negative = await send({ kind: 'wait', selector: '#ready', timeout: -5000 });
  assert.equal(negative.timeout, 1);

  const timedOut = await createInputHarness();
  timedOut.tab.page.waitForSelector = async () => { throw new Error('Timeout 5000ms exceeded'); };
  await assert.rejects(
    () => timedOut.send({ kind: 'wait', selector: '#never' }),
    (err) => err.code === 'locator-failed' && err.status === 502,
  );
});

test('key type forwards a bounded per-character delay', async () => {
  const { tab, send } = await createInputHarness();
  await send({ kind: 'key', action: 'type', text: 'hello', delay: 80 });
  assert.deepEqual(tab.page.keyboardTypeCalls.at(-1), { text: 'hello', options: { delay: 80 } });

  await send({ kind: 'key', action: 'type', text: 'hello', delay: 999999 });
  assert.deepEqual(tab.page.keyboardTypeCalls.at(-1).options, { delay: BROWSER_LIMITS.MAX_INPUT_DELAY_MS });

  // Unset or invalid delay keeps the previous hardcoded behaviour of 0.
  await send({ kind: 'key', action: 'type', text: 'hello' });
  assert.deepEqual(tab.page.keyboardTypeCalls.at(-1).options, { delay: 0 });
  await send({ kind: 'key', action: 'type', text: 'hello', delay: 'fast' });
  assert.deepEqual(tab.page.keyboardTypeCalls.at(-1).options, { delay: 0 });
});

test('locator index picks one match and rejects an invalid value', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [
    { role: 'button', name: 'Row' },
    { role: 'button', name: 'Row' },
    { role: 'button', name: 'Row' },
  ];

  const byNth = await send({ kind: 'click', role: 'button', name: 'Row', nth: 2 });
  assert.equal(byNth.kind, 'click');
  assert.equal(tab.page._elements[2].clicked, true);
  assert.equal(tab.page._elements[0].clicked, undefined);

  // `browser_elements` returns an `index` field, so `index` is accepted as an alias.
  tab.page._elements.forEach((entry) => { delete entry.clicked; });
  const byIndex = await send({ kind: 'click', role: 'button', name: 'Row', index: 1 });
  assert.equal(byIndex.kind, 'click');
  assert.equal(tab.page._elements[1].clicked, true);
  assert.equal(tab.page._elements[0].clicked, undefined);

  // Without nth/index the first match still wins (unchanged default).
  const byDefault = await send({ kind: 'click', role: 'button', name: 'Row' });
  assert.equal(byDefault.kind, 'click');
  assert.equal(tab.page._elements[0].firstRequested, true);
});

test('locator index rejects negative, fractional and non-numeric values with 400', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'button', name: 'Row' }];
  for (const bad of [-1, 1.5, 'first', {}]) {
    await assert.rejects(
      () => send({ kind: 'click', role: 'button', name: 'Row', nth: bad }),
      (err) => err instanceof BrowserError && err.code === 'locator-index-invalid' && err.status === 400,
    );
    assert.equal(tab.page._elements[0].clicked, undefined);
  }
});

test('navigate waitUntil uses a closed allowlist and keeps domcontentloaded by default', async () => {
  const { tab, manager, session, tabInfo } = await createInputHarness();
  const scope = { workspaceFile: '/ws/a' };
  const defaultState = await manager.navigate(
    session.browserSessionId,
    tabInfo.browserTabId,
    'https://example.com/a',
    OWNER,
    scope,
  );
  assert.equal(defaultState.url, 'https://example.com/a');
  assert.equal(tab.page.gotoCalls.at(-1).options.waitUntil, 'domcontentloaded');
  assert.equal(tab.page.gotoCalls.at(-1).options.timeout, 30000);

  for (const waitUntil of ['load', 'networkidle', 'commit', 'domcontentloaded']) {
    await manager.navigate(
      session.browserSessionId,
      tabInfo.browserTabId,
      'https://example.com/a',
      OWNER,
      scope,
      { waitUntil },
    );
    assert.equal(tab.page.gotoCalls.at(-1).options.waitUntil, waitUntil);
  }

  await assert.rejects(
    () => manager.navigate(session.browserSessionId, tabInfo.browserTabId, 'https://example.com/a', OWNER, scope, {
      waitUntil: 'load(); alert(1)',
    }),
    (err) => err instanceof BrowserError && err.code === 'invalid-wait-until' && err.status === 400,
  );
  assert.equal(tab.page.gotoCalls.length, 5);
});

test('navigate normalizes a bare host so the policy and page.goto get one URL', async () => {
  const { tab, manager, session, tabInfo } = await createInputHarness();
  const scope = { workspaceFile: '/ws/a' };

  // Typed into the panel without a scheme: the allowlist judges
  // `https://example.com`, so Chromium must receive that same absolute URL —
  // a bare `example.com` is not a valid `goto` target.
  const state = await manager.navigate(
    session.browserSessionId,
    tabInfo.browserTabId,
    'example.com',
    OWNER,
    scope,
  );
  assert.equal(tab.page.gotoCalls.at(-1).url, 'https://example.com/');
  assert.equal(state.url, 'https://example.com/');

  // Default-deny still holds for a bare host that is not allowlisted, and it
  // fails at the policy (403), never as a scheme-less navigation.
  await assert.rejects(
    () => manager.navigate(session.browserSessionId, tabInfo.browserTabId, 'evil.test', OWNER, scope),
    (err) => err instanceof BrowserError && err.code === 'navigation-blocked' && err.status === 403,
  );
  assert.equal(tab.page.gotoCalls.length, 1);

  // A blocked scheme keeps failing closed instead of gaining an https prefix.
  await assert.rejects(
    () => manager.navigate(session.browserSessionId, tabInfo.browserTabId, 'file:///etc/passwd', OWNER, scope),
    (err) => err instanceof BrowserError && err.code === 'navigation-blocked' && err.status === 403,
  );
  assert.equal(tab.page.gotoCalls.length, 1);
});

test('input kind upload reads files only from inside the workspace root', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cretli-browser-upload-'));
  const scope = { cwd };
  try {
    const notes = path.join(cwd, 'notes.txt');
    writeFileSync(notes, 'hello');
    const { tab, send } = await createInputHarness({}, scope);
    tab.page._elements = [{ role: 'textbox', name: 'Attachment' }];

    const uploaded = await send({ kind: 'upload', selector: '#file', files: 'notes.txt' });
    assert.equal(uploaded.kind, 'upload');
    assert.equal(uploaded.count, 1);
    // The resolved host path is never echoed back to the caller.
    assert.equal(uploaded.files, undefined);
    assert.deepEqual(tab.page._elements[0].uploadedFiles, [realpathSync(notes)]);
    assert.equal(tab.page._elements[0].uploadOptions.timeout, BROWSER_LIMITS.LOCATOR_TIMEOUT_MS);

    await send({ kind: 'upload', selector: '#file', files: ['notes.txt', notes] });
    assert.deepEqual(tab.page._elements[0].uploadedFiles, [realpathSync(notes), realpathSync(notes)]);

    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: '../outside.txt' }),
      (err) => err instanceof BrowserError && err.code === 'upload-path-forbidden' && err.status === 400,
    );
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: path.join(cwd, '..', 'outside.txt') }),
      (err) => err.code === 'upload-path-forbidden' && err.status === 400,
    );
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: '/etc/passwd' }),
      (err) => err.code === 'upload-path-forbidden' && err.status === 400,
    );
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: 'notes.txt\0.txt' }),
      (err) => err.code === 'upload-path-forbidden' && err.status === 400,
    );
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file' }),
      (err) => err.code === 'upload-files-required' && err.status === 400,
    );
    await assert.rejects(
      () => send({
        kind: 'upload',
        selector: '#file',
        files: Array.from({ length: BROWSER_LIMITS.MAX_UPLOAD_FILES + 1 }, () => 'notes.txt'),
      }),
      (err) => err.code === 'upload-file-limit' && err.status === 400,
    );
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: 'missing.txt' }),
      (err) => err.code === 'upload-path-not-found' && err.status === 400,
    );
    // Every rejection above happened before setInputFiles.
    assert.equal(tab.page._elements[0].uploadedFiles.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('input kind upload rejects a symlink that escapes the workspace root', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cretli-browser-link-'));
  const scope = { cwd };
  try {
    const link = path.join(cwd, 'link.txt');
    writeFileSync(link, 'placeholder');
    // Symlinks need privileges on some platforms, so the escape is modelled by
    // the injected realpath: the path looks inside the root and resolves outside.
    const { tab, send } = await createInputHarness({
      realpath: (target) => (String(target) === link ? '/somewhere/else/secret.txt' : realpathSync(String(target))),
    }, scope);
    tab.page._elements = [{ role: 'textbox', name: 'Attachment' }];

    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: 'link.txt' }),
      (err) => err instanceof BrowserError && err.code === 'upload-path-forbidden' && err.status === 400,
    );
    assert.equal(tab.page._elements[0].uploadedFiles, undefined);

    // A path that already equals the root is not a file inside it either.
    await assert.rejects(
      () => send({ kind: 'upload', selector: '#file', files: '.' }),
      (err) => err.code === 'upload-path-forbidden' && err.status === 400,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('input kind upload fails closed when the scope carries no workspace root', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'textbox', name: 'Attachment' }];
  await assert.rejects(
    () => send({ kind: 'upload', selector: '#file', files: 'notes.txt' }),
    (err) => err instanceof BrowserError && err.code === 'upload-path-forbidden' && err.status === 400,
  );
  assert.equal(tab.page._elements[0].uploadedFiles, undefined);
});

/**
 * Node shaped for the `describePageElement` branch tests: only what the
 * page-side descriptor reads (tag, attributes, text, parent chain).
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {{ text?: string, parent?: any, children?: any[] }} [extras]
 */
function descriptorNode(tag, attrs = {}, extras = {}) {
  return {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: attrs.id || '',
    hidden: false,
    isConnected: true,
    innerText: extras.text || '',
    textContent: extras.text || '',
    parentElement: extras.parent || null,
    children: extras.children || [],
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 10 }),
  };
}

test('describePageElement maps an input type onto the role an agent can drive', () => {
  const cases = [
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['submit', 'button'],
    ['button', 'button'],
    ['reset', 'button'],
    ['text', 'textbox'],
    ['email', 'textbox'],
    [null, 'textbox'],
  ];
  for (const [type, expectedRole] of cases) {
    const node = descriptorNode('input', type ? { type } : {}, { text: 'x' });
    assert.equal(describePageElement(node, 50).role, expectedRole, `input[type=${type ?? '<none>'}]`);
    assert.equal(describePageElement(node, 50).type, type || undefined, 'the raw type is reported too');
  }
  // A non-input with a type attribute never takes the input branch.
  assert.equal(describePageElement(descriptorNode('span', { type: 'checkbox' }), 50).role, '');
});

test('describePageElement falls back to the tag role and an explicit role wins', () => {
  const tagRoles = [['a', 'link'], ['select', 'combobox'], ['textarea', 'textbox'], ['summary', 'button'], ['button', 'button']];
  for (const [tag, expectedRole] of tagRoles) {
    assert.equal(describePageElement(descriptorNode(tag), 50).role, expectedRole, `<${tag}>`);
  }
  assert.equal(describePageElement(descriptorNode('div'), 50).role, '', 'an unknown tag has no role');

  // `role` beats both the tag table and the input-type table.
  assert.equal(describePageElement(descriptorNode('a', { role: 'tab' }), 50).role, 'tab');
  assert.equal(describePageElement(descriptorNode('input', { role: 'switch', type: 'checkbox' }), 50).role, 'switch');
});

test('describePageElement resolves the name in aria-label, placeholder, name, title, text order', () => {
  const text = 'Body text';
  const all = describePageElement(
    descriptorNode('input', { 'aria-label': 'A', placeholder: 'P', name: 'N', title: 'T' }, { text }),
    50,
  );
  assert.equal(all.name, 'A', 'aria-label wins over everything');
  assert.equal(describePageElement(descriptorNode('input', { placeholder: 'P', name: 'N', title: 'T' }, { text }), 50).name, 'P');
  assert.equal(describePageElement(descriptorNode('input', { name: 'N', title: 'T' }, { text }), 50).name, 'N');
  assert.equal(describePageElement(descriptorNode('input', { title: 'T' }, { text }), 50).name, 'T');
  const last = describePageElement(descriptorNode('button', {}, { text }), 50);
  assert.equal(last.name, text, 'the trimmed text is the final fallback');
  assert.equal(describePageElement(descriptorNode('button', {}, { text: '   ' }), 50).name, '', 'whitespace-only text is empty');
  // Collapsed whitespace is what an agent should pass back as `name`.
  assert.equal(
    describePageElement(descriptorNode('button', {}, { text: 'Save\n  the\tfile' }), 50).name,
    'Save the file',
  );
});

test('describePageElement emits :nth-of-type only when the parent repeats the tag', () => {
  const parent = descriptorNode('div', {}, { children: [] });
  const first = descriptorNode('span', {}, { parent });
  const second = descriptorNode('span', {}, { parent });
  const other = descriptorNode('em', {}, { parent });
  parent.children = [first, second, other];

  assert.equal(describePageElement(first, 50).selector, 'div span:nth-of-type(1)');
  assert.equal(describePageElement(second, 50).selector, 'div span:nth-of-type(2)');
  assert.equal(describePageElement(other, 50).selector, 'div em', 'a unique tag gets no :nth-of-type');

  // An id is specific enough on its own, so no positional suffix is added.
  const withId = descriptorNode('span', { id: 'uniq' }, { parent });
  parent.children = [first, withId];
  assert.equal(describePageElement(withId, 50).selector, 'div #uniq');
});

test('describePageElement escapes special characters when CSS.escape is unavailable', () => {
  // Node has no `CSS` global, so the page-side fallback backslash-escapes the
  // characters a CSS identifier cannot carry.
  assert.equal(typeof globalThis.CSS, 'undefined', 'the fallback is the branch under test');
  assert.equal(describePageElement(descriptorNode('button', { id: 'weird.id' }), 50).selector, '#weird\\.id');
  assert.equal(
    describePageElement(descriptorNode('button', { class: 'a.b c:d' }), 50).selector,
    'button.a\\.b.c\\:d',
  );
  // Safe characters survive untouched, so a normal id/class stays readable.
  assert.equal(describePageElement(descriptorNode('button', { id: 'ok-1_2' }), 50).selector, '#ok-1_2');
  // Only the first two classes become the selector.
  assert.equal(
    describePageElement(descriptorNode('button', { class: 'one two three' }), 50).selector,
    'button.one.two',
  );
});

test('describePageElement clamps maxText to the 120-character default', () => {
  const long = `${'x'.repeat(200)} tail`;
  const node = () => descriptorNode('button', { 'aria-label': long }, { text: long });
  for (const maxText of [undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    const descriptor = describePageElement(node(), maxText);
    assert.equal(descriptor.text.length, 120, `maxText=${String(maxText)} falls back to 120`);
    assert.equal(descriptor.name.length, 120);
  }
  const tight = describePageElement(node(), 8);
  assert.equal(tight.text, 'x'.repeat(8));
  assert.equal(tight.name, 'x'.repeat(8));
});

test('describePageElementsBatch drops invisible nodes and never lets one bad node kill the scan', () => {
  const good = descriptorNode('button', { 'aria-label': 'Good' });
  const noRect = descriptorNode('button', { 'aria-label': 'NoRect' });
  noRect.getBoundingClientRect = () => {
    throw new Error('layout unavailable');
  };
  const zero = descriptorNode('button', { 'aria-label': 'Zero' });
  zero.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
  const detached = descriptorNode('button', { 'aria-label': 'Detached' });
  detached.isConnected = false;
  const hidden = descriptorNode('button', { 'aria-label': 'HiddenAttr' });
  hidden.hidden = true;

  const report = describePageElementsBatch([good, noRect, zero, detached, hidden], { cap: 10, limit: 10 });
  assert.deepEqual(report.rows.map((row) => row.descriptor.name), ['Good'], 'a throwing layout box is skipped, not fatal');
  assert.equal(report.total, 5);
  assert.equal(report.scanned, 5);

  // `getComputedStyle` throwing must fall back to the layout box, not drop the node.
  const previousComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => {
    throw new Error('no style for an orphaned node');
  };
  try {
    const survived = describePageElementsBatch([good], { cap: 10, limit: 10 });
    assert.deepEqual(survived.rows.map((row) => row.descriptor.name), ['Good']);
  } finally {
    if (previousComputedStyle) globalThis.getComputedStyle = previousComputedStyle;
    else delete globalThis.getComputedStyle;
  }

  // Style-driven invisibility is the check a real page needs most.
  for (const [style, label] of [
    [{ display: 'none' }, 'display:none'],
    [{ visibility: 'hidden' }, 'visibility:hidden'],
    [{ opacity: '0' }, 'opacity:0'],
  ]) {
    globalThis.getComputedStyle = () => style;
    try {
      assert.deepEqual(describePageElementsBatch([good], { cap: 10, limit: 10 }).rows, [], label);
    } finally {
      delete globalThis.getComputedStyle;
    }
  }

  // `requireSize: false` keeps a node that has no layout box at all (the
  // single-element entry point), while the scan drops it.
  const boxless = descriptorNode('button', { 'aria-label': 'Boxless' });
  boxless.getBoundingClientRect = () => null;
  assert.equal(describePageElementsBatch([boxless], { cap: 1, limit: 1, requireSize: false }).rows.length, 1);
  assert.equal(describePageElementsBatch([boxless], { cap: 10, limit: 10 }).rows.length, 0);

  // `cap` bounds how far the scan reads, `limit` how many rows it keeps.
  const many = Array.from({ length: 6 }, (_unused, i) => descriptorNode('button', { 'aria-label': `B${i}` }));
  assert.equal(describePageElementsBatch(many, { cap: 3, limit: 10 }).scanned, 3);
  assert.equal(describePageElementsBatch(many, { cap: 10, limit: 2 }).rows.length, 2);
});

test('getVisibleElements fails closed when the driver cannot run the single-pass scan', async () => {
  const { manager, tabInfo, tab, session } = await createInputHarness();
  tab.page._elements = [{ role: 'button', name: 'Save' }];
  const call = () => manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);

  tab.page.locator = null;
  await assert.rejects(call, (err) => err instanceof BrowserError
    && err.code === 'elements-unavailable' && err.status === 501);
  delete tab.page.locator;

  // A locator without `evaluateAll` is not the one supported scan shape, so the
  // manager must refuse rather than fall back to a per-element round trip.
  tab.page._locatorNoEvaluateAll = true;
  await assert.rejects(
    call,
    (err) => err.code === 'elements-unavailable' && err.status === 501,
  );
  assert.equal(tab.page.locatorQueries[0], BROWSER_ELEMENTS_SELECTOR, 'the scan was still the intended query');
});

test('getVisibleElements maps a failing scan to elements-failed 502', async () => {
  const { manager, tabInfo, tab, session } = await createInputHarness();
  tab.page._elements = [{ role: 'button', name: 'Save' }];
  tab.page._locatorFail = { count: 'count boom' };
  await assert.rejects(
    () => manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE),
    (err) => err instanceof BrowserError
      && err.code === 'elements-failed'
      && err.status === 502
      && /count boom/.test(err.message),
  );

  tab.page._locatorFail = { evaluateAll: 'evaluate boom' };
  await assert.rejects(
    () => manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE),
    (err) => err.code === 'elements-failed' && err.status === 502 && /evaluate boom/.test(err.message),
  );
});

test('getVisibleElements drops rows without a descriptor or a bounds box and reports truncation', async () => {
  const { manager, tabInfo, tab, session } = await createInputHarness();
  // The manager reads `total` from count(), so the page-side report has to
  // describe the same number of nodes the locator would have matched.
  tab.page._elements = Array.from({ length: 9 }, (_unused, i) => ({ role: 'button', name: `B${i}` }));
  const descriptor = { tag: 'button', role: 'button', name: 'Ok', text: 'Ok', selector: 'button', disabled: false };
  tab.page._elementsReport = {
    total: 9,
    scanned: 3,
    rows: [
      { descriptor: null, bounds: { x: 1, y: 1, width: 5, height: 5 } },
      { descriptor, bounds: null },
      { descriptor, bounds: { x: 1.6, y: 2.4, width: 5.5, height: 5.5 } },
    ],
  };

  const result = await manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  assert.equal(result.count, 1, 'only a complete row is listed');
  assert.equal(result.elements[0].index, 0, 'the listing is numbered from zero for browser_input `index`');
  assert.deepEqual(result.elements[0].bounds, { x: 2, y: 2, width: 6, height: 6 }, 'bounds are rounded');
  assert.equal(result.total, 9);
  assert.equal(result.scanned, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.channel, 'elements');
  assert.equal(result.browserSessionId, session.browserSessionId);
  assert.equal(result.browserTabId, tabInfo.browserTabId);

  // A page-side row list that is not an array must degrade to an empty listing.
  tab.page._elementsReport = { total: 9, scanned: 2, rows: null };
  const empty = await manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, SCOPE);
  assert.equal(empty.count, 0);
  assert.equal(empty.elements.length, 0);
  assert.equal(empty.truncated, true);
});

test('getVisibleElements clamps scope.limit and scope.maxText into the documented range', async () => {
  const { manager, tabInfo, tab, session } = await createInputHarness();
  // The bounds the `browser_elements` schema advertises are the clamp bounds.
  assert.equal(BROWSER_ELEMENTS_DEFAULT_LIMIT, 80);
  assert.equal(BROWSER_ELEMENTS_MAX_LIMIT, 200);
  tab.page._elements = [{ role: 'button', name: 'Save' }, { role: 'link', name: 'Docs' }];
  const scan = (scope) => manager.getVisibleElements(session.browserSessionId, tabInfo.browserTabId, OWNER, {
    ...SCOPE,
    ...scope,
  }).then(() => tab.page._evaluateAllCalls.at(-1).arg);

  assert.equal((await scan({ limit: 7, maxText: 60 })).limit, 7);
  assert.equal((await scan({ limit: 7, maxText: 60 })).maxText, 60);
  assert.equal((await scan({})).limit, BROWSER_ELEMENTS_DEFAULT_LIMIT, 'no limit uses the default');
  assert.equal((await scan({ limit: Number.NaN })).limit, BROWSER_ELEMENTS_DEFAULT_LIMIT);
  assert.equal((await scan({ limit: 'nonsense' })).limit, BROWSER_ELEMENTS_DEFAULT_LIMIT);
  assert.equal((await scan({ limit: 5000 })).limit, BROWSER_ELEMENTS_MAX_LIMIT, 'an oversized limit is capped');
  assert.equal((await scan({ limit: 0 })).limit, 1, 'a zero limit clamps to the minimum, not the default');
  assert.equal((await scan({ limit: -20 })).limit, 1);
  assert.equal((await scan({})).maxText, 120, 'no maxText uses the page-side default');
  assert.equal((await scan({ maxText: Number.NaN })).maxText, 120);
  assert.equal((await scan({ maxText: 5 })).maxText, 20, 'maxText has its own lower bound');
  assert.equal((await scan({ maxText: 9999 })).maxText, 500);
  // The scan never reads further than 4x the limit (and never past the page).
  assert.equal((await scan({ limit: 1 })).cap, Math.min(2, 4, 1000));
});

test('browser_input locates by text, label and placeholder', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [
    { text: 'Save', role: 'button', name: 'Save' },
    { label: 'Email', role: 'textbox', name: 'Email' },
    { placeholder: 'Search the docs', role: 'textbox', name: 'Search' },
  ];

  await send({ kind: 'click', text: 'Save' });
  assert.equal(tab.page.locatorQueries.at(-1), 'text=Save');
  assert.equal(tab.page._elements[0].clicked, true);

  await send({ kind: 'fill', label: 'Email', value: 'a@b.example' });
  assert.equal(tab.page.locatorQueries.at(-1), 'label=Email');
  assert.equal(tab.page._elements[1].filled, 'a@b.example');

  await send({ kind: 'click', placeholder: 'Search the docs' });
  assert.equal(tab.page.locatorQueries.at(-1), 'placeholder=Search the docs');
  assert.equal(tab.page._elements[2].clicked, true);

  await send({ kind: 'fill', text: 'Save', value: 'later' });
  assert.equal(tab.page.locatorQueries.at(-1), 'text=Save');
  assert.equal(tab.page._elements[0].filled, 'later');

  // `text` alone must not be swallowed by the `name` field of a role lookup:
  // the same value resolves through the text query only.
  assert.deepEqual(
    tab.page.locatorQueries.filter((query) => query.startsWith('role=')),
    [],
    'no role query was issued for a text/label/placeholder target',
  );
});

test('browser_input nth and index pick one match for every locator field', async () => {
  const { tab, send } = await createInputHarness();
  const dup = () => ([{ text: 'Dup', role: 'button', name: 'Dup' }, { text: 'Dup', role: 'button', name: 'Dup' }]);
  tab.page._elements = dup();
  await send({ kind: 'click', text: 'Dup', index: 1 });
  assert.equal(tab.page._elements[1].clicked, true, 'index selects the second match');
  assert.equal(tab.page._elements[0].clicked, undefined, 'the first match is left alone');
  assert.equal(tab.page._elements[1].nthRequested, 1);

  tab.page._elements = dup();
  await send({ kind: 'fill', text: 'Dup', nth: 0, value: 'first' });
  assert.equal(tab.page._elements[0].filled, 'first');
  assert.equal(tab.page._elements[1].filled, undefined);

  tab.page._elements = [{ label: 'Email' }, { label: 'Email' }];
  await send({ kind: 'click', label: 'Email', nth: 1 });
  assert.equal(tab.page._elements[1].clicked, true);

  tab.page._elements = [{ placeholder: 'Query' }, { placeholder: 'Query' }];
  await send({ kind: 'click', placeholder: 'Query', index: 1 });
  assert.equal(tab.page._elements[1].clicked, true);

  tab.page._elements = [{ role: 'button', name: 'X' }, { role: 'button', name: 'X' }];
  await send({ kind: 'click', role: 'button', name: 'X', index: 1 });
  assert.equal(tab.page._elements[1].clicked, true, 'role+name honours index too');

  // Without nth/index the first match wins.
  tab.page._elements = dup();
  await send({ kind: 'click', text: 'Dup' });
  assert.equal(tab.page._elements[0].firstRequested, true);
  assert.equal(tab.page._elements[0].clicked, true);
});

test('fetchDebuggerSourceMap resolves relative sourceMappingURL against script URL', async () => {
  const fetchedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return {
      ok: true,
      body: (async function* () {
        yield Buffer.from(JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'A' }));
      })(),
    };
  };
  try {
    const manager = new BrowserSessionManager({
      limits: BROWSER_LIMITS,
      driverStatus: { status: 'available' },
      resolvePolicy: () => ({ allowedOrigins: ['https://cdn.test'], blockedPorts: [], unblockedPorts: [] }),
      lookup: async () => [{ address: '93.184.216.34' }],
      driver: { launch: async () => ({ newContext: async () => ({ route: async () => {}, close: async () => {} }), isConnected: () => true, close: async () => {} }) },
    });
    manager.evaluateRequestPolicy = async () => ({ allowed: true });
    const session = { id: 'sess-sm', policy: {} };
    const tab = { url: 'https://app.test/page', id: 'tab-sm' };
    const map = await manager.fetchDebuggerSourceMap(
      session,
      tab,
      'index.js.map',
      'https://cdn.test/pkg/a/index.js',
    );
    assert.ok(map && typeof map === 'object');
    assert.equal(fetchedUrls.length, 1);
    assert.equal(fetchedUrls[0], 'https://cdn.test/pkg/a/index.js.map');
    const absolute = await manager.fetchDebuggerSourceMap(
      session,
      tab,
      'https://cdn.test/other.map',
      'https://cdn.test/pkg/a/index.js',
    );
    assert.ok(absolute);
    assert.equal(fetchedUrls[1], 'https://cdn.test/other.map');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser_input locator fields win in selector, role, text, label, placeholder order', async () => {
  const { tab, send } = await createInputHarness();
  tab.page._elements = [{ role: 'button', name: 'Save', text: 'Save', label: 'Save', placeholder: 'Save' }];
  const cases = [
    [{ selector: '#save', role: 'button', text: 'Save', label: 'Save', placeholder: 'Save' }, '#save'],
    [{ role: 'button', name: 'Save', text: 'Save', label: 'Save', placeholder: 'Save' }, 'role=button'],
    [{ text: 'Save', label: 'Save', placeholder: 'Save' }, 'text=Save'],
    [{ label: 'Save', placeholder: 'Save' }, 'label=Save'],
    [{ placeholder: 'Save' }, 'placeholder=Save'],
  ];
  for (const [fields, expected] of cases) {
    const before = tab.page.locatorQueries.length;
    await send({ kind: 'click', ...fields });
    assert.equal(tab.page.locatorQueries.length, before + 1, `${expected}: exactly one query is resolved`);
    assert.equal(tab.page.locatorQueries.at(-1), expected);
  }

  // Whitespace-only fields are absent fields, so the chain keeps falling through.
  const before = tab.page.locatorQueries.length;
  await send({ kind: 'click', selector: '   ', role: '', text: 'Save' });
  assert.equal(tab.page.locatorQueries.at(-1), 'text=Save');
  assert.equal(tab.page.locatorQueries.length, before + 1);
});

