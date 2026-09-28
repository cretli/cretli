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
