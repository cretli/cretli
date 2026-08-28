import assert from 'node:assert/strict';
import test from 'node:test';

const originalWindow = globalThis.window;

function setLocationSearch(search) {
  globalThis.window = { location: { search } };
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
