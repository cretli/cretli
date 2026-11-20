/**
 * setPushEnabled() failure semantics (app_front/features/pwa/pushSubscription.js):
 * - a browser unsubscribe error or a `false` result must NOT look like "disabled";
 * - a server/local save failure must return `{ ok:false }`;
 * - enabling with a failed save rolls the fresh subscription back.
 *
 * Browser globals are mocked per process (the unit runner spawns one process per
 * file), so nothing leaks into other tests.
 */
import assert from 'node:assert/strict';
import { PUSH_STATES, isPushEnabled, readPushState, setPushEnabled } from '../app_front/features/pwa/pushSubscription.js';

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function createLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      const keys = Array.from(map.keys());
      return keys[index] ?? null;
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    dump() {
      return new Map(map);
    },
  };
}

const ENDPOINT = 'https://push.example/device';

/**
 * @param {{ unsubscribe?: () => Promise<boolean>, subscribe?: () => Promise<object> }} [options]
 */
function installBrowser(options = {}) {
  const storage = createLocalStorage({ 'cretli-push-enabled': '1' });
  defineGlobal('localStorage', storage);
  const subscription = {
    endpoint: ENDPOINT,
    unsubscribe: options.unsubscribe || (async () => true),
  };
  const registration = {
    pushManager: {
      async getSubscription() {
        return subscription;
      },
      async subscribe() {
        return options.subscribe ? options.subscribe() : subscription;
      },
    },
  };
  defineGlobal('Notification', {
    permission: 'granted',
    async requestPermission() {
      return 'granted';
    },
  });
  defineGlobal('window', { PushManager: function PushManager() {} });
  defineGlobal('navigator', { serviceWorker: { ready: Promise.resolve(registration) } });
  return { storage, subscription };
}

// --- readPushState reflects an active device ---------------------------------
installBrowser();
{
  const state = await readPushState();
  assert.equal(state.state, PUSH_STATES.ACTIVE);
  assert.equal(state.endpoint, ENDPOINT);
  assert.equal(state.permission, 'granted');
}

// --- a throwing unsubscribe is not a disable ---------------------------------
{
  const { storage } = installBrowser({
    unsubscribe: async () => {
      throw new Error('browser refused');
    },
  });
  const result = await setPushEnabled(false);
  assert.equal(result.ok, false, 'a throwing unsubscribe must not report ok');
  assert.equal(result.state, PUSH_STATES.ACTIVE, 'the subscription is still live');
  assert.match(result.message, /browser refused/);
  assert.equal(isPushEnabled(), true, 'the legacy flag must not be cleared');
  assert.equal(storage.getItem('cretli-push-enabled'), '1');
}

// --- unsubscribe() === false is not a disable --------------------------------
{
  const { storage } = installBrowser({ unsubscribe: async () => false });
  const result = await setPushEnabled(false);
  assert.equal(result.ok, false);
  assert.equal(result.state, PUSH_STATES.ACTIVE);
  assert.equal(storage.getItem('cretli-push-enabled'), '1');
}

// --- enabling rolls the fresh subscription back when the save fails ----------
{
  let rolledBack = false;
  const subscription = {
    endpoint: ENDPOINT,
    async unsubscribe() {
      rolledBack = true;
      return true;
    },
  };
  installBrowser({
    subscribe: async () => subscription,
  });
  defineGlobal('fetch', async (url) => {
    if (String(url).includes('/api/push/vapid-public')) {
      return { ok: true, status: 200, async json() { return { ok: true, available: true, publicKey: 'AQAB' }; } };
    }
    // subscribe POST succeeds; the local IndexedDB save is what fails in Node,
    // which must roll the just-created subscription back.
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  });
  const result = await setPushEnabled(true);
  assert.equal(result.ok, false, 'a failed save must not report ok');
  assert.equal(rolledBack, true, 'the fresh subscription is rolled back');
  assert.equal(isPushEnabled(), false, 'the legacy flag is not set on a failed enable');
}

// --- permission denied does not subscribe ------------------------------------
{
  installBrowser();
  defineGlobal('Notification', {
    permission: 'denied',
    async requestPermission() {
      return 'denied';
    },
  });
  const result = await setPushEnabled(true);
  assert.equal(result.ok, false);
  assert.equal(result.state, PUSH_STATES.BLOCKED);
}

// --- unsupported device ------------------------------------------------------
{
  defineGlobal('window', {});
  defineGlobal('navigator', {});
  defineGlobal('Notification', undefined);
  const result = await setPushEnabled(true);
  assert.equal(result.ok, false);
  assert.equal(result.state, PUSH_STATES.UNSUPPORTED);
}

console.log('push-set-push-enabled.test.js: ok');
