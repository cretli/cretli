import assert from 'node:assert/strict';

function createMemoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

const logs = [];
const baseFetch = async () => ({ status: 200 });

globalThis.localStorage = createMemoryStorage();
globalThis.localStorage.setItem('cretli-ui-freeze-diag', '1');
globalThis.window = {
  location: { search: '' },
  fetch: baseFetch,
};
globalThis.fetch = baseFetch;
globalThis.document = {
  hidden: false,
  visibilityState: 'visible',
  addEventListener() {},
};

const uiFreezeTrace = await import('../app_front/lib/uiFreezeTrace.js');

uiFreezeTrace.initUiFreezeTrace({
  logger: {
    log(tag, message, payload) {
      logs.push({ tag, message, payload });
    },
  },
});

await globalThis.window.fetch('/api/client-debug-log', {
  method: 'POST',
  headers: {
    'x-cr-debug-log': '1',
  },
});

const clientDebugProbeLogs = logs.filter(
  (entry) =>
    entry.tag === 'ui-freeze-http' &&
    String(entry.payload?.url || '').includes('/api/client-debug-log')
);
assert.equal(clientDebugProbeLogs.length, 0);

await globalThis.window.fetch('/api/chats', { method: 'GET' });

const chatsProbeLogs = logs.filter(
  (entry) =>
    entry.tag === 'ui-freeze-http' &&
    String(entry.payload?.url || '').includes('/api/chats')
);
assert.equal(chatsProbeLogs.length >= 2, true);

globalThis.window = originalWindow;
globalThis.localStorage = originalLocalStorage;
globalThis.fetch = originalFetch;
globalThis.document = originalDocument;

console.log('ui-freeze-fetch-probe.test.js: ok');
