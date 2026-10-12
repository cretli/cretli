/**
 * SPA navigation (plan stage 3): atomic history, popstate, generation guard,
 * notification alias parsing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CR_NAVIGATION_STATE_KEY,
  createSpaNavigation,
  mergeHistoryState,
  mergeRouteIntent,
  parseNotificationActionRoute,
  resolveHistoryWrite,
} from '../app_front/app/appShell/spaNavigation.js';
import { parseSpaRoute } from '../lib/spa-routes.js';

test('resolveHistoryWrite uses push for explicit navigation and none for popstate', () => {
  assert.equal(resolveHistoryWrite({
    canonicalNext: '/chat',
    canonicalCurrent: '/todo',
    explicit: true,
  }), 'push');
  assert.equal(resolveHistoryWrite({
    canonicalNext: '/chat',
    canonicalCurrent: '/todo',
    popstate: true,
    explicit: true,
  }), 'none');
  assert.equal(resolveHistoryWrite({
    canonicalNext: '/chat',
    canonicalCurrent: '/chat',
    explicit: true,
  }), 'none');
});

test('settings panel + tab merge into one canonical location', () => {
  const route = mergeRouteIntent(parseSpaRoute({ pathname: '/chat', search: '' }), {
    panel: 'settings',
    settingsTab: 'workspace',
  });
  assert.equal(route.canonical, '/settings/workspace');
});

test('git worktrees merge into one pathname without an intermediate panel hop', () => {
  const route = mergeRouteIntent(parseSpaRoute({ pathname: '/chat', search: '' }), {
    panel: 'git',
    subview: 'worktrees',
  });
  assert.equal(route.canonical, '/git/worktrees');
});

test('notification legacy panel/tab aliases parse to a canonical settings route', () => {
  const route = parseNotificationActionRoute('/?panel=settings&tab=workspace');
  assert.ok(route);
  assert.equal(route.panel, 'settings');
  assert.equal(route.settingsTab, 'workspace');
  assert.equal(route.canonical, '/settings/workspace');
});

test('notification legacy chat alias keeps the chat resource on /chat', () => {
  const route = parseNotificationActionRoute('/?panel=chat&chat=abc-123');
  assert.ok(route);
  assert.equal(route.panel, 'chat');
  assert.equal(route.query.chat, 'abc-123');
});

test('navigate performs one push for settings+tab', async () => {
  const writes = [];
  const nav = createSpaNavigation({
    readLocation: () => ({ pathname: '/chat', search: '' }),
    writeHistory: (url, mode, state) => writes.push({ url, mode, state }),
    applyRouteContext: async () => ({}),
    ensurePanelReady: async () => {},
    showPanel: () => {},
    applySettingsTab: () => {},
    applyGitSubview: () => {},
    applyRouteGitScope: () => {},
    restoreRouteResources: async () => {},
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['chat', 'settings'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  await nav.navigate({ panel: 'settings', settingsTab: 'workspace' }, { explicit: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mode, 'push');
  assert.equal(writes[0].url, '/settings/workspace');
  assert.equal(writes[0].state[CR_NAVIGATION_STATE_KEY].panel, 'settings');
});

test('popstate apply does not write history', async () => {
  const writes = [];
  const nav = createSpaNavigation({
    readLocation: () => ({ pathname: '/settings/workspace', search: '' }),
    writeHistory: (url, mode) => writes.push({ url, mode }),
    applyRouteContext: async () => ({}),
    ensurePanelReady: async () => {},
    showPanel: () => {},
    applySettingsTab: () => {},
    applyGitSubview: () => {},
    applyRouteGitScope: () => {},
    restoreRouteResources: async () => {},
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['settings'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  await nav.applyFromLocation({ popstate: true, history: 'none' });
  assert.equal(writes.length, 0);
});

test('one navigate calls ensurePanelReady once', async () => {
  let readyCalls = 0;
  const nav = createSpaNavigation({
    readLocation: () => ({ pathname: '/chat', search: '' }),
    writeHistory: () => {},
    applyRouteContext: async () => ({}),
    ensurePanelReady: async () => { readyCalls += 1; },
    showPanel: () => {},
    applySettingsTab: () => {},
    applyGitSubview: () => {},
    applyRouteGitScope: () => {},
    restoreRouteResources: async () => {},
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['chat'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  await nav.navigate({ panel: 'chat' }, { explicit: true });
  assert.equal(readyCalls, 1);
});

test('initPopstate registers at most one popstate handler', () => {
  /** @type {Array<() => void>} */
  const handlers = [];
  const nav = createSpaNavigation({
    readLocation: () => ({ pathname: '/chat', search: '' }),
    writeHistory: () => {},
    applyRouteContext: async () => ({}),
    ensurePanelReady: async () => {},
    showPanel: () => {},
    registerPopstate: (handler) => handlers.push(handler),
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['chat'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  nav.initPopstate();
  nav.initPopstate();
  assert.equal(handlers.length, 1);
});

test('canonical rewrite during apply still paints the destination panel', async () => {
  let loc = { pathname: '/settings/connection', search: '' };
  const painted = [];
  /** @type {ReturnType<typeof createSpaNavigation>} */
  let nav;
  nav = createSpaNavigation({
    readLocation: () => loc,
    writeHistory: (url) => {
      const queryAt = url.indexOf('?');
      loc = {
        pathname: queryAt === -1 ? url : url.slice(0, queryAt),
        search: queryAt === -1 ? '' : url.slice(queryAt),
      };
    },
    applyRouteContext: async () => {
      nav.replaceCanonicalUrl('/chat?ws=k1');
    },
    ensurePanelReady: async () => {},
    showPanel: (panelId) => painted.push(panelId),
    applySettingsTab: () => {},
    applyGitSubview: () => {},
    applyRouteGitScope: () => {},
    restoreRouteResources: async () => {},
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['chat', 'settings'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  await nav.navigate({ panel: 'chat' }, { explicit: true });
  assert.deepEqual(painted, ['chat']);
  assert.equal(loc.pathname, '/chat');
  assert.equal(loc.search, '?ws=k1');
});

test('stale generation does not paint after a newer navigate', async () => {
  const slow = deferred();
  const painted = [];
  const nav = createSpaNavigation({
    readLocation: () => ({ pathname: '/chat', search: '' }),
    writeHistory: () => {},
    applyRouteContext: async () => ({}),
    ensurePanelReady: async (panelId) => {
      if (panelId === 'chat') await slow.promise;
    },
    showPanel: (panelId) => painted.push(panelId),
    applySettingsTab: () => {},
    applyGitSubview: () => {},
    applyRouteGitScope: () => {},
    restoreRouteResources: async () => {},
    isPanelAllowed: () => true,
    getModeConfig: () => ({ allowedPanels: ['chat', 'todo'] }),
    whenScopedAccessAllowed: async () => ({}),
  });
  const first = nav.navigate({ panel: 'chat' }, { explicit: true });
  await nav.navigate({ panel: 'todo' }, { explicit: true });
  slow.resolve(undefined);
  await first;
  assert.deepEqual(painted, ['todo'], 'slow chat navigation must not repaint after todo won');
});

test('mergeHistoryState preserves foreign history fields', () => {
  const merged = mergeHistoryState({ vendor: 1, other: 'x' }, { generation: 3, panel: 'git' });
  assert.equal(merged.vendor, 1);
  assert.equal(merged.other, 'x');
  assert.equal(merged[CR_NAVIGATION_STATE_KEY].generation, 3);
});

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve;
  /** @type {(reason?: unknown) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
