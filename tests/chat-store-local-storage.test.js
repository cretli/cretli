import assert from 'node:assert/strict';
import {
  getSkipChatDeleteConfirm,
  getSkipChatArchiveConfirm,
  setSkipChatDeleteConfirm,
  setSkipChatArchiveConfirm,
} from '../app_front/features/chat/chatStore.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

function createThrowingStorage() {
  return {
    getItem() {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    },
    setItem() {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    },
    removeItem() {},
    key() {
      return null;
    },
    get length() {
      return 0;
    },
  };
}

runCase('getSkipChatDeleteConfirm returns false when localStorage throws', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createThrowingStorage();
  try {
    const actualValue = getSkipChatDeleteConfirm();
    assert.equal(actualValue, false);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

runCase('setSkipChatDeleteConfirm does not throw when localStorage throws', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createThrowingStorage();
  try {
    assert.doesNotThrow(() => setSkipChatDeleteConfirm(true));
    assert.doesNotThrow(() => setSkipChatDeleteConfirm(false));
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

runCase('getSkipChatArchiveConfirm returns false when localStorage throws', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createThrowingStorage();
  try {
    assert.equal(getSkipChatArchiveConfirm(), false);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

runCase('setSkipChatArchiveConfirm does not throw when localStorage throws', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createThrowingStorage();
  try {
    assert.doesNotThrow(() => setSkipChatArchiveConfirm(true));
    assert.doesNotThrow(() => setSkipChatArchiveConfirm(false));
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

runCase('archive skip preference round-trips through localStorage', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = createMemoryStorage();
  try {
    assert.equal(getSkipChatArchiveConfirm(), false);
    setSkipChatArchiveConfirm(true);
    assert.equal(getSkipChatArchiveConfirm(), true);
    setSkipChatArchiveConfirm(false);
    assert.equal(getSkipChatArchiveConfirm(), false);
    // The archive preference must be independent from the delete one.
    setSkipChatArchiveConfirm(true);
    assert.equal(getSkipChatDeleteConfirm(), false);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

if (failed > 0) {
  console.error(`\nchatStore localStorage tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll chatStore localStorage tests passed.');
