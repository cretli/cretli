/**
 * View route storage v1 (navigation plan stage 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_ROUTE_LOCAL_KEY,
  VIEW_ROUTE_SESSION_KEY,
  isExplicitNavigationLocation,
  legacyPanelRouteFromStorage,
  parseViewRouteRecord,
  resolveBootRouteIntent,
  sanitizeRouteForPersistence,
  serializeViewRouteRecord,
} from '../app_front/app/appShell/viewRouteStorage.js';
import { parseSpaRoute } from '../lib/spa-routes.js';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('storage priority on / prefers session, then local v1, then legacy keys', () => {
  const session = memoryStorage({
    [VIEW_ROUTE_SESSION_KEY]: serializeViewRouteRecord('/tasks'),
  });
  const local = memoryStorage({
    [VIEW_ROUTE_LOCAL_KEY]: serializeViewRouteRecord('/agents'),
    'cretli-last-panel': 'chat',
  });
  const boot = resolveBootRouteIntent({
    location: { pathname: '/', search: '' },
    sessionStorage: session,
    localStorage: local,
    defaultPanel: 'chat',
  });
  assert.equal(boot.source, 'session');
  assert.equal(boot.intent.panel, 'tasks');

  const bootLocal = resolveBootRouteIntent({
    location: { pathname: '/', search: '' },
    sessionStorage: memoryStorage(),
    localStorage: local,
    defaultPanel: 'chat',
  });
  assert.equal(bootLocal.source, 'local');
  assert.equal(bootLocal.intent.panel, 'chat');

  const bootLegacy = resolveBootRouteIntent({
    location: { pathname: '/', search: '' },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage({ 'cretli-last-panel': 'files' }),
    defaultPanel: 'chat',
  });
  assert.equal(bootLegacy.source, 'legacy');
  assert.equal(bootLegacy.intent.panel, 'files');
});

test('explicit /git/worktrees boot intent keeps the worktrees subview', () => {
  const boot = resolveBootRouteIntent({
    location: { pathname: '/git/worktrees', search: '?ws=cretli:ws:abc&folder=f1' },
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    defaultPanel: 'chat',
  });
  assert.equal(boot.source, 'url');
  assert.equal(boot.intent.panel, 'git');
  assert.equal(boot.intent.subview, 'worktrees');
  assert.equal(boot.intent.context.workspaceKey, 'cretli:ws:abc');
  assert.equal(boot.intent.context.folderKey, 'f1');
});

test('an explicit URL wins over stored routes', () => {
  const local = memoryStorage({
    [VIEW_ROUTE_LOCAL_KEY]: serializeViewRouteRecord('/tasks'),
  });
  const boot = resolveBootRouteIntent({
    location: { pathname: '/terminal', search: '' },
    sessionStorage: memoryStorage({
      [VIEW_ROUTE_SESSION_KEY]: serializeViewRouteRecord('/agents'),
    }),
    localStorage: local,
    defaultPanel: 'chat',
  });
  assert.equal(boot.explicit, true);
  assert.equal(boot.source, 'url');
  assert.equal(boot.intent.panel, 'terminal');
});

test('persisted routes drop volatile sessions and keep git on main', () => {
  const route = parseSpaRoute('/git/worktrees?session=abc&run=task-1&source=pwa-push');
  assert.ok(route);
  const canonical = sanitizeRouteForPersistence(route);
  assert.equal(canonical, '/git');
  assert.doesNotMatch(canonical, /session=|run=|source=/);
});

test('legacy widget panel migrates to settings/widgets', () => {
  const storage = memoryStorage({ 'cretli-last-panel': 'widget' });
  assert.equal(legacyPanelRouteFromStorage(storage), '/settings/widgets');
});

test('broken storage records are ignored without blocking boot', () => {
  assert.equal(parseViewRouteRecord('{not-json'), null);
  assert.equal(parseViewRouteRecord(JSON.stringify({ version: 2, route: '/chat', updatedAt: Date.now() })), null);
  const boot = resolveBootRouteIntent({
    location: { pathname: '/', search: '' },
    sessionStorage: memoryStorage({ [VIEW_ROUTE_SESSION_KEY]: '!!!' }),
    localStorage: memoryStorage(),
    defaultPanel: 'chat',
  });
  assert.equal(boot.source, 'default');
  assert.equal(boot.intent.panel, 'chat');
});

test('isExplicitNavigationLocation treats bare / as implicit', () => {
  assert.equal(isExplicitNavigationLocation({ pathname: '/', search: '' }), false);
  assert.equal(isExplicitNavigationLocation({ pathname: '/todo', search: '' }), true);
  assert.equal(isExplicitNavigationLocation({ pathname: '/', search: '?panel=tasks' }), true);
});
