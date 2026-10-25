import assert from 'node:assert/strict';
import {
  readLastSelectedHarness,
  saveLastSelectedHarness,
  readLastSelectedModel,
  saveLastSelectedModel,
  getShowSendFieldEnabled,
  setShowSendFieldEnabled,
  healLegacyShowSendFieldPreference,
} from '../app_front/features/chat/chatSettingsPrefs.js';

function createMemoryStorage(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
  };
}

const previousStorage = globalThis.localStorage;
globalThis.localStorage = createMemoryStorage();

try {
  assert.equal(readLastSelectedHarness(), '');
  assert.equal(readLastSelectedModel(), 'auto');

  saveLastSelectedHarness('opencode');
  assert.equal(readLastSelectedHarness(), 'opencode');

  saveLastSelectedHarness('openrouter');
  assert.equal(readLastSelectedHarness(), 'openrouter');

  saveLastSelectedHarness('sdk');
  assert.equal(readLastSelectedHarness(), 'sdk');

  saveLastSelectedHarness('unknown-harness');
  assert.equal(readLastSelectedHarness(), '');

  saveLastSelectedModel('opencode/x-preview-f-free');
  assert.equal(readLastSelectedModel(), 'opencode/x-preview-f-free');

  saveLastSelectedModel('');
  assert.equal(readLastSelectedModel(), 'auto');

  assert.equal(getShowSendFieldEnabled(), true);

  globalThis.localStorage.setItem('cretli-chat-show-send-field', 'false');
  assert.equal(getShowSendFieldEnabled(), true, 'legacy false must not hide the send bar');
  healLegacyShowSendFieldPreference();
  assert.equal(globalThis.localStorage.getItem('cretli-chat-show-send-field'), 'true');

  setShowSendFieldEnabled(false);
  assert.equal(getShowSendFieldEnabled(), false);
  assert.equal(globalThis.localStorage.getItem('cretli-chat-hide-send-field'), '1');

  setShowSendFieldEnabled(true);
  assert.equal(getShowSendFieldEnabled(), true);
  assert.equal(globalThis.localStorage.getItem('cretli-chat-hide-send-field'), '0');

  console.log('chat-settings-prefs.test.js OK');
} finally {
  globalThis.localStorage = previousStorage;
}
