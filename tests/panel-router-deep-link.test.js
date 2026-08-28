import assert from 'node:assert/strict';
import test from 'node:test';

const originalWindow = globalThis.window;

function setLocation(pathname, search) {
  globalThis.window = { location: { pathname, search } };
}

function setLocationSearch(search) {
  setLocation('/', search);
}

test.after(() => {
  globalThis.window = originalWindow;
});

test('readRequestedPanel / readRequestedChatId parse PWA and push deep links', async () => {
  setLocationSearch('?source=pwa&panel=chat&chat=abc-123');
  const { readRequestedPanel, readRequestedChatId } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  assert.equal(readRequestedPanel(), 'chat');
  assert.equal(readRequestedChatId(), 'abc-123');
});

test('deep-link readers return empty strings when parameters are absent', async () => {
  const { readRequestedPanel, readRequestedChatId } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  setLocationSearch('');
  assert.equal(readRequestedPanel(), '');
  assert.equal(readRequestedChatId(), '');
  setLocationSearch('?source=pwa');
  assert.equal(readRequestedPanel(), '');
});

test('an explicit panel in the URL wins over the panel stored in localStorage', async () => {
  setLocationSearch('?panel=terminal');
  const storage = new Map([['cretli-last-panel', 'chat']]);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter } = await import('../app_front/app/appShell/panelRouter.js');
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'terminal'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'terminal'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'terminal');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('a bare / path keeps the last panel from localStorage', async () => {
  setLocation('/', '');
  const storage = new Map([['cretli-last-panel', 'tasks']]);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'tasks'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'tasks'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'tasks');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('an explicit pathname wins over the panel stored in localStorage', async () => {
  setLocation('/settings/workspace', '');
  const storage = new Map([['cretli-last-panel', 'chat']]);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'settings'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'settings'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'settings');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('pathname /widget opens settings', async () => {
  setLocation('/widget', '');
  const storage = new Map([['cretli-last-panel', 'chat']]);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'settings'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'settings'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'settings');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('last-panel widget remaps to settings and stores the widgets tab', async () => {
  setLocation('/', '');
  const storage = new Map([['cretli-last-panel', 'widget']]);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter, readRequestedSettingsTab } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'settings'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'settings'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'settings');
  assert.equal(readRequestedSettingsTab(), 'widgets');
  assert.equal(storage.get('cretli-settings-tab'), 'widgets');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('query panel=widget remaps to settings', async () => {
  setLocation('/', '?panel=widget');
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.document = { querySelector: () => null };
  const { createPanelRouter, readRequestedSettingsTab } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  const router = createPanelRouter({
    appModes: { main: { allowedPanels: ['chat', 'settings'], defaultPanel: 'chat' } },
  });
  const actual = router.resolveInitialPanel({
    allowedPanels: ['chat', 'settings'],
    defaultPanel: 'chat',
  });
  assert.equal(actual, 'settings');
  assert.equal(readRequestedSettingsTab(), 'widgets');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('replaceLocationView writes a History API path and keeps extra query params', async () => {
  const calls = [];
  setLocation('/', '?source=pwa&panel=chat&tab=harness&chat=abc');
  globalThis.window.history = {
    replaceState(_state, _title, url) {
      calls.push(url);
    },
  };
  const { replaceLocationView } = await import(
    '../app_front/app/appShell/panelRouter.js'
  );
  replaceLocationView('settings', 'workspace');
  assert.equal(calls[0], '/settings/workspace?source=pwa&chat=abc');
});
