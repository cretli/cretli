/**
 * Browser PWA panel wiring: SPA routing, index.html structure, service-worker
 * view list, lazy module registration, i18n keys and App/panelRouter wiring.
 *
 * The heavy logic lives in tests/browser-*.test.js; this file guards the
 * front-end vertical slice so the panel cannot silently lose routing or
 * translations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSpaPath, isSpaShellPath, parseSpaPath } from '../lib/spa-routes.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { loadPanelModule } from '../app_front/app/appShell/lazyPanelModules.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('/browser is a first-class SPA panel path', () => {
  assert.deepEqual(parseSpaPath('/browser'), { panel: 'browser', settingsTab: '' });
  assert.equal(isSpaShellPath('/browser'), true);
  assert.equal(buildSpaPath({ panel: 'browser' }), '/browser');
});

test('index.html registers the Browser tab and panel container', () => {
  const html = read('public/index.html');
  assert.match(html, /<button[^>]+data-panel="browser"[^>]+data-i18n="tabs\.browser"/);
  assert.match(html, /<div id="browser-panel" class="panel">/);
  // Key interactive surfaces the lazy module expects.
  for (const id of [
    'browser-unavailable',
    'browser-sessions',
    'browser-tabs',
    'browser-url-input',
    'browser-frame',
    'browser-key-input',
    'browser-console-list',
    'browser-network-list',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html must contain #${id}`);
  }
});

test('service worker knows the /browser view for offline fallback', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /'browser'/);
  // Frames and pulls are API/WS traffic and must stay out of the SW cache.
  assert.match(sw, /pathname\.startsWith\('\/api\/'\) \|\| url\.pathname\.startsWith\('\/ws'\)/);
});

test('lazyPanelModules maps browser to the panel module with its API', async () => {
  const source = read('app_front/app/appShell/lazyPanelModules.js');
  assert.match(source, /browser:\s*\(\)\s*=>\s*import\([^)]*features\/browser\/browserPanel\.js/);
  const mod = await loadPanelModule('browser');
  assert.equal(typeof mod.initBrowserPanel, 'function');
  assert.equal(typeof mod.refreshBrowserPanel, 'function');
});

test('App.js and panelRouter.js wire the browser panel into the router', () => {
  const app = read('app_front/App.js');
  assert.match(app, /MAIN_PANELS = \[[^\]]*'browser'[^\]]*\]/);
  assert.match(app, /panelKey === 'browser'/);
  assert.match(app, /refreshBrowserPanel: \(\) => callLoadedPanel\('browser', 'refreshBrowserPanel'\)/);
  const router = read('app_front/app/appShell/panelRouter.js');
  assert.match(router, /panelId === 'browser'/);
  assert.match(router, /refreshBrowserPanel = \(\) => \{\}/);
});

test('browser panel i18n keys exist in en and pl', () => {
  const requiredEn = [
    'tabs.browser',
    'browser.title',
    'browser.newSession',
    'browser.closeSession',
    'browser.newTab',
    'browser.refresh',
    'browser.unavailable',
    'browser.noSessions',
    'browser.noTabs',
    'browser.urlPlaceholder',
    'browser.go',
    'browser.back',
    'browser.forward',
    'browser.reload',
    'browser.typePlaceholder',
    'browser.type',
    'browser.pressEnter',
    'browser.consoleTitle',
    'browser.networkTitle',
    'browser.pull',
    'browser.frameAlt',
    'browser.frameEmpty',
  ];
  /**
   * @param {Record<string, unknown>} dict
   * @param {string} key
   */
  const lookup = (dict, key) => key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), dict);
  for (const key of requiredEn) {
    assert.equal(typeof lookup(en, key), 'string', `en.js missing ${key}`);
    assert.equal(typeof lookup(pl, key), 'string', `pl.js missing ${key}`);
  }
  assert.notEqual(en.browser.unavailable, pl.browser.unavailable, 'pl translation must differ from en');
});

test('REST screenshot force never bypasses the per-tab frame cap', async () => {
  const { registerBrowserRoutes } = await import('../lib/browser/routes.js');
  const { BrowserSessionManager } = await import('../lib/browser/session-manager.js');
  const { BROWSER_LIMITS } = await import('../lib/browser/constants.js');
  const express = (await import('express')).default;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');

  class FakePage {
    url() { return 'about:blank'; }
    async title() { return 'fake'; }
    viewportSize() { return { width: 390, height: 844 }; }
    async screenshot() { return Buffer.from('fake-jpeg'); }
    async close() {}
  }
  class FakeContext {
    async newPage() { return new FakePage(); }
    async route() {}
    async close() {}
  }
  class FakeBrowser {
    async newContext() { return new FakeContext(); }
    async close() {}
  }

  let clock = 1_000_000;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-force-'));
  const manager = new BrowserSessionManager({
    driver: { async launch() { return new FakeBrowser(); } },
    driverStatus: { status: 'available' },
    dataDir,
    now: () => clock,
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
  });
  const app = express();
  app.use(express.json());
  registerBrowserRoutes(app, {
    browserManager: manager,
    dataDir,
    getCurrentCwd: () => '/ws/f',
    getCurrentWorkspaceFile: () => '/ws/f',
    getOwnerSessionId: () => 'owner-f',
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await manager.createSession({ ownerSessionId: 'owner-f', workspaceFile: '/ws/f' });
    const sessionId = created.browserSessionId;
    const tabId = created.tabs[0].browserTabId;
    const url = `${base}/api/browser/sessions/${sessionId}/tabs/${tabId}/screenshot`;

    const first = await fetch(url, { headers: { 'x-test-owner': 'owner-f' } });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).ok, true);

    // An immediate unforced poll is capped at 2 fps...
    const capped = await fetch(url, { headers: { 'x-test-owner': 'owner-f' } });
    assert.equal(capped.status, 429);

    // ...and `force` is not a public bypass either.
    const forcedTooSoon = await fetch(`${url}?force=1`, { headers: { 'x-test-owner': 'owner-f' } });
    assert.equal(forcedTooSoon.status, 429);

    // ...after the interval elapses a manual refresh succeeds.
    clock += BROWSER_LIMITS.SCREENSHOT_FORCE_MIN_INTERVAL_MS + 1;
    const forced = await fetch(`${url}?force=1`, { headers: { 'x-test-owner': 'owner-f' } });
    assert.equal(forced.status, 200);
    assert.equal((await forced.json()).ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await manager.closeAll('test');
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('browser panel consumes nextSince and real history state', () => {
  const panel = read('app_front/features/browser/browserPanel.js');
  // Pagination must use the server's nextSince cursor, not a non-existent
  // payload.cursor.
  assert.match(panel, /payload\.nextSince/);
  assert.doesNotMatch(panel, /payload\?\.cursor/);
  assert.doesNotMatch(panel, /payload\.cursor/);
  // The back/forward buttons reflect the server's CDP-derived state.
  assert.match(panel, /canGoBack/);
  assert.match(panel, /canGoForward/);
  assert.match(panel, /applyHistoryState/);
});

test('browser panel supports mobile gestures, viewport toggle and clears stale frames', () => {
  const panel = read('app_front/features/browser/browserPanel.js');
  const html = read('public/index.html');
  const enKeys = Object.keys(en.browser);
  const plKeys = Object.keys(pl.browser);

  // Touch/mouse input is unified under Pointer Events (one path for drag-scroll
  // and tap), not the old click-only handler.
  assert.match(panel, /addEventListener\('pointerdown'/);
  assert.match(panel, /addEventListener\('pointermove'/);
  assert.match(panel, /addEventListener\('pointerup'/);
  assert.match(panel, /addEventListener\('wheel'/);
  // No leftover click-only frame handler.
  assert.doesNotMatch(panel, /'click', \(event\) => void sendPointerClick/);

  // A drag becomes a scroll input; tap becomes a real tap (touch) or click.
  assert.match(panel, /kind: 'scroll'/);
  assert.match(panel, /hasTouch/);
  assert.match(panel, /kind: 'pointer', action: 'tap'/);
  assert.match(panel, /kind: 'pointer', action: 'click'/);

  // The mobile/desktop viewport toggle posts a resize input and the button exists.
  assert.match(panel, /kind: 'resize', viewport: target/);
  assert.match(html, /id="browser-mobile-btn"/);

  // A stale frame is cleared before a new screenshot loads on navigation, tab
  // switch and history actions so the previous view never lingers.
  assert.match(panel, /function clearFrame\(\)/);
  assert.match(panel, /clearFrame\(\);\s*\n\s*await refreshTabState\(\);/);

  // Translations for the viewport toggle.
  for (const key of ['mobileTitle', 'desktopTitle']) {
    assert.ok(enKeys.includes(key), `en.browser missing ${key}`);
    assert.ok(plKeys.includes(key), `pl.browser missing ${key}`);
  }
});

test('scroll input coalesces deltas and ignores input-rate-limited; tap/key still error', async (t) => {
  const {
    __testEnqueueScrollInput,
    __testResetScrollInputState,
    __testSendKeyInput,
    __testSendTapOrClick,
    __testSetApiImpl,
  } = await import('../app_front/features/browser/browserPanel.js');

  const statusEl = {
    textContent: '',
    classList: {
      /** @type {Set<string>} */
      _classes: new Set(),
      add(name) { this._classes.add(name); },
      remove(name) { this._classes.delete(name); },
    },
  };
  globalThis.document = {
    /** @param {string} id */
    getElementById(id) {
      if (id === 'browser-status') return statusEl;
      return null;
    },
  };

  /** @type {Array<{ path: string, body: Record<string, unknown> }>} */
  const scrollPosts = [];

  /**
   * @param {string} code
   * @returns {never}
   */
  const rejectInput = (code) => {
    const err = new Error(code);
    err.code = code;
    throw err;
  };

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  try {
    __testResetScrollInputState('sess-scroll', 'tab-scroll');
    __testSetApiImpl(async (path, init) => {
      if (path.includes('/input') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body?.event?.kind === 'scroll') {
          scrollPosts.push({ path, body: body.event });
          return { ok: true };
        }
        rejectInput('input-rate-limited');
      }
      return { ok: true, frame: null };
    });

    const point = { x: 10, y: 20 };
    __testEnqueueScrollInput(0, 1, point);
    __testEnqueueScrollInput(0, 2, point);
    __testEnqueueScrollInput(0, 3, point);
    t.mock.timers.tick(0);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(scrollPosts.length, 1, 'sync burst must produce one scroll POST');
    assert.equal(scrollPosts[0].body.deltaY, 6, 'deltas must sum, not replace');
    assert.equal(scrollPosts[0].body.deltaX, 0);

    scrollPosts.length = 0;
    statusEl.textContent = '';
    statusEl.classList._classes.clear();
    __testResetScrollInputState('sess-scroll', 'tab-scroll');
    __testSetApiImpl(async (path, init) => {
      if (path.includes('/input') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body?.event?.kind === 'scroll') rejectInput('input-rate-limited');
      }
      return { ok: true, frame: null };
    });
    __testEnqueueScrollInput(0, 5, point);
    t.mock.timers.tick(0);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(statusEl.classList._classes.has('browser-status--error'), false);
    assert.equal(statusEl.textContent, '');

    statusEl.textContent = '';
    statusEl.classList._classes.clear();
    __testResetScrollInputState('sess-scroll', 'tab-scroll');
    __testSetApiImpl(async (path, init) => {
      if (path.includes('/input') && init.method === 'POST') {
        rejectInput('input-rate-limited');
      }
      return { ok: true, frame: null };
    });
    await __testSendTapOrClick({ x: 1, y: 2 }, null);
    assert.equal(statusEl.classList._classes.has('browser-status--error'), true);

    statusEl.textContent = '';
    statusEl.classList._classes.clear();
    __testResetScrollInputState('sess-scroll', 'tab-scroll');
    await __testSendKeyInput({ kind: 'press', key: 'Enter' });
    assert.equal(statusEl.classList._classes.has('browser-status--error'), true);
  } finally {
    t.mock.timers.reset();
    __testSetApiImpl(null);
    delete globalThis.document;
  }
});

test('scroll coalescing drops stale targets and cancels on view changes', async (t) => {
  const {
    SCROLL_INPUT_MIN_INTERVAL_MS,
    __testCloseSession,
    __testEnqueueScrollInput,
    __testNavigate,
    __testResetScrollInputState,
    __testSelectTab,
    __testSetApiImpl,
    __testSetPanelLists,
  } = await import('../app_front/features/browser/browserPanel.js');

  const statusEl = {
    textContent: '',
    classList: {
      /** @type {Set<string>} */
      _classes: new Set(),
      add(name) { this._classes.add(name); },
      remove(name) { this._classes.delete(name); },
    },
  };
  const stubEl = {
    innerHTML: '',
    hidden: false,
    value: '',
    disabled: false,
    querySelectorAll: () => [],
    removeAttribute: () => {},
  };
  globalThis.document = {
    activeElement: null,
    /** @param {string} id */
    getElementById(id) {
      if (id === 'browser-status') return statusEl;
      if (id === 'browser-panel') return { classList: { contains: () => false } };
      if (id === 'browser-frame') return { ...stubEl, hidden: true };
      if (id === 'browser-frame-empty') return stubEl;
      if (id === 'browser-sessions' || id === 'browser-tabs') return stubEl;
      if (id === 'browser-url-input') return stubEl;
      if (id === 'browser-back-btn' || id === 'browser-forward-btn') return stubEl;
      if (id === 'browser-console-list' || id === 'browser-network-list') {
        return { ...stubEl, _crEntries: [] };
      }
      return null;
    },
  };
  globalThis.window = {
    confirm: () => true,
  };

  /** @type {Array<{ path: string, body: Record<string, unknown> }>} */
  const scrollPosts = [];

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  try {
    __testResetScrollInputState('sess-coalesce', 'tab-a');
    __testSetPanelLists({
      sessions: [{ browserSessionId: 'sess-coalesce', tabs: [{ browserTabId: 'tab-a' }, { browserTabId: 'tab-b' }] }],
      tabs: [{ browserTabId: 'tab-a', title: 'A' }, { browserTabId: 'tab-b', title: 'B' }],
    });
    __testSetApiImpl(async (path, init) => {
      if (path.includes('/input') && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body?.event?.kind === 'scroll') {
          scrollPosts.push({ path, body: body.event });
          return { ok: true };
        }
      }
      return { ok: true, frame: null, state: null };
    });

    const point = { x: 5, y: 5 };
    __testEnqueueScrollInput(0, 50, point);
    await __testSelectTab('tab-b');
    t.mock.timers.tick(SCROLL_INPUT_MIN_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(scrollPosts.length, 0, 'selectTab must cancel pending scroll for the previous tab');

    scrollPosts.length = 0;
    __testResetScrollInputState('sess-coalesce', 'tab-a');
    __testEnqueueScrollInput(0, 50, point);
    await __testNavigate('https://example.com/page');
    t.mock.timers.tick(SCROLL_INPUT_MIN_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(scrollPosts.length, 0, 'navigate must cancel pending scroll timer');

    scrollPosts.length = 0;
    __testResetScrollInputState('sess-coalesce', 'tab-a');
    __testSetPanelLists({
      sessions: [{ browserSessionId: 'sess-coalesce', tabs: [{ browserTabId: 'tab-a' }] }],
      tabs: [{ browserTabId: 'tab-a', title: 'A' }],
    });
    __testEnqueueScrollInput(0, 50, point);
    await __testCloseSession();
    t.mock.timers.tick(SCROLL_INPUT_MIN_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(scrollPosts.length, 0, 'closeSession must cancel pending scroll timer');

    scrollPosts.length = 0;
    __testResetScrollInputState('sess-coalesce', 'tab-a');
    __testEnqueueScrollInput(0, 1, point);
    __testEnqueueScrollInput(0, 2, point);
    __testEnqueueScrollInput(0, 3, point);
    t.mock.timers.tick(0);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    assert.equal(scrollPosts.length, 1, 'first burst sends once');
    assert.equal(scrollPosts[0].body.deltaY, 6);

    __testEnqueueScrollInput(0, 4, point);
    __testEnqueueScrollInput(0, 5, point);
    t.mock.timers.tick(SCROLL_INPUT_MIN_INTERVAL_MS - 1);
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    assert.equal(scrollPosts.length, 1, 'second burst must wait out the min interval');
    t.mock.timers.tick(1);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    assert.equal(scrollPosts.length, 2, 'second burst delivers after the interval');
    assert.equal(scrollPosts[1].body.deltaY, 9, 'second burst sums deltas');
  } finally {
    t.mock.timers.reset();
    __testSetApiImpl(null);
    delete globalThis.document;
    delete globalThis.window;
  }
});

