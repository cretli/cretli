import assert from 'node:assert/strict';

const calls = [];
const store = new Map();
const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
setNavigator({ vibrate: (pattern) => { calls.push(pattern); return true; } });
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
};

const { haptic, hapticsEnabled, HAPTICS_STORAGE_KEY } = await import('../app_front/lib/haptics.js');

assert.equal(hapticsEnabled(), true);
assert.equal(haptic('tick'), true);
assert.deepEqual(calls.pop(), 8);
haptic('success');
assert.deepEqual(calls.pop(), [10, 40, 14]);
haptic('unknown-kind');
assert.deepEqual(calls.pop(), 8, 'unknown kinds fall back to a tick');

// Kill switch.
store.set(HAPTICS_STORAGE_KEY, '0');
assert.equal(haptic('tick'), false);
assert.equal(calls.length, 0);
store.delete(HAPTICS_STORAGE_KEY);

// No Vibration API (iOS Safari): silent no-op.
setNavigator({});
assert.equal(haptic('tick'), false);

console.log('haptics.test.js: ok');
