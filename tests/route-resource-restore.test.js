/**
 * Route resource adapters (navigation plan stage 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRouteResourceRestorer,
  resolveBrowserRouteRestore,
  resolveRunRouteRestore,
  resolveTerminalSessionRestore,
  validateFilesRoutePath,
} from '../app_front/app/appShell/routeResourceRestore.js';
import { parseSpaRoute } from '../lib/spa-routes.js';

test('files path adapter rejects traversal and absolute paths', () => {
  assert.equal(validateFilesRoutePath('src/app.js').ok, true);
  assert.equal(validateFilesRoutePath('../secret').ok, false);
  assert.equal(validateFilesRoutePath('/etc/passwd').ok, false);
});

test('dead terminal session clears the URL and does not join', async () => {
  const replaced = [];
  let joined = 0;
  const restore = createRouteResourceRestorer({
    replaceCanonical: (url) => replaced.push(url),
    showResourceNotice: () => {},
    listTerminalSessionIds: async () => ['live-session'],
    restoreTerminalSession: () => { joined += 1; },
    isCurrentGeneration: () => true,
  });
  const route = parseSpaRoute('/terminal?session=dead-session');
  assert.ok(route);
  await restore(route, 1);
  assert.equal(joined, 0);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0], '/terminal');
});

test('resolveTerminalSessionRestore keeps unknown lists offline-safe', () => {
  assert.deepEqual(resolveTerminalSessionRestore({
    sessionId: 'sess-1',
    knownSessionIds: null,
  }), { action: 'join', sessionId: 'sess-1' });
  assert.deepEqual(resolveTerminalSessionRestore({
    sessionId: 'sess-1',
    knownSessionIds: [],
  }), { action: 'clear', sessionId: 'sess-1', reason: 'session-not-live' });
});

test('stale navigation generation skips restore side effects', async () => {
  const replaced = [];
  let joined = 0;
  const restore = createRouteResourceRestorer({
    replaceCanonical: (url) => replaced.push(url),
    showResourceNotice: () => {},
    listTerminalSessionIds: async () => ['live-session'],
    restoreTerminalSession: () => { joined += 1; },
    isCurrentGeneration: () => false,
  });
  const route = parseSpaRoute('/terminal?session=dead-session');
  assert.ok(route);
  await restore(route, 1);
  assert.equal(joined, 0);
  assert.equal(replaced.length, 0);
});

test('resolveBrowserRouteRestore clears unknown session and tab without select', () => {
  assert.deepEqual(resolveBrowserRouteRestore({
    browserSession: 'gone-session',
    browserTab: '',
    knownSessions: [{ browserSessionId: 'live-session' }],
  }), { action: 'clear-session', browserSession: 'gone-session', browserTab: '' });
  assert.deepEqual(resolveBrowserRouteRestore({
    browserSession: 'live-session',
    browserTab: 'missing-tab',
    knownSessions: [{ browserSessionId: 'live-session' }],
    knownTabs: [{ tabId: 'tab-1' }],
  }), { action: 'clear-tab', browserSession: 'live-session', browserTab: 'missing-tab' });
});


test('unknown browser session strips URL and does not restore browser', async () => {
  const replaced = [];
  let restored = 0;
  const restore = createRouteResourceRestorer({
    replaceCanonical: (url) => replaced.push(url),
    showResourceNotice: () => {},
    listBrowserSessions: async () => [{ browserSessionId: 'live-session' }],
    restoreBrowser: () => { restored += 1; },
    isCurrentGeneration: () => true,
  });
  const route = parseSpaRoute('/browser?browserSession=dead-session&browserTab=t1');
  assert.ok(route);
  await restore(route, 1);
  assert.equal(restored, 0);
  assert.equal(replaced.length, 1);
  expectCanonicalWithoutBrowserKeys(replaced[0]);
});


function expectCanonicalWithoutBrowserKeys(canonical) {
  const parsed = parseSpaRoute(canonical);
  assert.ok(parsed);
  assert.equal(parsed.query.browserSession, undefined);
  assert.equal(parsed.query.browserTab, undefined);
}

test('invalid files path replaces the URL without opening a file', async () => {
  const replaced = [];
  let opened = 0;
  const restore = createRouteResourceRestorer({
    replaceCanonical: (url) => replaced.push(url),
    showResourceNotice: () => {},
    restoreFilesPath: () => { opened += 1; },
    isCurrentGeneration: () => true,
  });
  const route = parseSpaRoute('/files?path=src/ok.js');
  assert.ok(route);
  route.query.path = '../outside';
  await restore(route, 1);
  assert.equal(opened, 0);
  assert.equal(replaced[0], '/files');
});
