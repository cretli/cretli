import assert from 'node:assert/strict';
import {
  installClientDebugInstrumentation,
  requestClientDebugRemoteFlush,
  flushClientDebugRemoteNow,
  appLogger,
  resetClientDebugInstrumentationForTests,
} from '../app_front/core/logging/logger.js';

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

resetClientDebugInstrumentationForTests();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalFetch = globalThis.fetch;

globalThis.localStorage = createMemoryStorage();
globalThis.window = {
  location: { search: '', origin: 'https://example.test' },
  addEventListener() {},
  setInterval() {
    return 0;
  },
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  getElementById() {
    return null;
  },
  body: null,
  documentElement: { style: { setProperty() {} } },
};
globalThis.fetch = () => Promise.resolve({ ok: true });

installClientDebugInstrumentation();
requestClientDebugRemoteFlush('before-sync');
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  return Promise.resolve({ ok: true });
};
requestClientDebugRemoteFlush('before-sync');
assert.equal(fetchCalls, 0);

resetClientDebugInstrumentationForTests();
globalThis.localStorage.setItem('cretli-debug-remote', '1');
installClientDebugInstrumentation();
requestClientDebugRemoteFlush('after-sync');
// Requests are batched: nothing is sent until the batch timer, a hide, or an error.
assert.equal(fetchCalls, 0);
flushClientDebugRemoteNow('test');
assert.equal(fetchCalls, 1);

// Many log events + flush requests collapse into ONE POST carrying every line.
const bodies = [];
globalThis.fetch = (url, init) => {
  bodies.push(JSON.parse(init.body));
  return Promise.resolve({ ok: true });
};
for (let i = 0; i < 50; i += 1) {
  appLogger.log('ui-freeze-http', `event-${i}`);
  requestClientDebugRemoteFlush('ui-freeze-http');
}
assert.equal(bodies.length, 0);
flushClientDebugRemoteNow('test');
assert.equal(bodies.length, 1);
assert.equal(bodies[0].lines.length, 50);
assert.ok(bodies[0].lines[49].includes('event-49'));
flushClientDebugRemoteNow('test');
assert.equal(bodies.length, 1);

globalThis.window = originalWindow;
globalThis.document = originalDocument;
globalThis.localStorage = originalLocalStorage;
globalThis.fetch = originalFetch;
resetClientDebugInstrumentationForTests();

console.log('client-debug-instrumentation.test.js: ok');
