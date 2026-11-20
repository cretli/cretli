import assert from 'node:assert/strict';
import {
  CLIENT_INSTANCE_ID_COOKIE,
  CLIENT_INSTANCE_ID_LS_KEY,
  getClientInstanceId,
  resetClientInstanceForTests,
} from '../app_front/lib/clientInstance.js';

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

function createThrowingStorage() {
  return {
    getItem() {
      throw new Error('storage blocked');
    },
    setItem() {
      throw new Error('storage blocked');
    },
    removeItem() {
      throw new Error('storage blocked');
    },
  };
}

resetClientInstanceForTests();
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;
const originalDocument = globalThis.document;

globalThis.localStorage = createMemoryStorage();
globalThis.sessionStorage = createMemoryStorage();

const firstId = getClientInstanceId();
const secondId = getClientInstanceId();
assert.equal(firstId, secondId);
assert.equal(globalThis.localStorage.getItem(CLIENT_INSTANCE_ID_LS_KEY), firstId);
assert.equal(globalThis.sessionStorage.getItem(CLIENT_INSTANCE_ID_LS_KEY), firstId);

resetClientInstanceForTests();
globalThis.localStorage = createMemoryStorage();
globalThis.sessionStorage = createMemoryStorage();
globalThis.document = {
  cookie: `${CLIENT_INSTANCE_ID_COOKIE}=${encodeURIComponent('cookie-id-12345678')}`,
};
const fromCookie = getClientInstanceId();
assert.equal(fromCookie, 'cookie-id-12345678');
assert.equal(globalThis.localStorage.getItem(CLIENT_INSTANCE_ID_LS_KEY), fromCookie);

resetClientInstanceForTests();
globalThis.localStorage = createThrowingStorage();
globalThis.sessionStorage = createThrowingStorage();
const unstableFirst = getClientInstanceId();
const unstableSecond = getClientInstanceId();
assert.equal(unstableFirst, unstableSecond);

globalThis.localStorage = originalLocalStorage;
globalThis.sessionStorage = originalSessionStorage;
if (originalDocument !== undefined) globalThis.document = originalDocument;
else delete globalThis.document;
resetClientInstanceForTests();

console.log('client-instance-id.test.js: ok');
