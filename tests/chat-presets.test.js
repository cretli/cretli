import assert from 'node:assert/strict';
import {
  chatPresetKey,
  createChatPresetsStore,
  normalizeChatPreset,
} from '../app_front/features/chat/chatPresets.js';

function createMemoryStorage(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    key(index) { return Array.from(store.keys())[index] ?? null; },
    get length() { return store.size; },
  };
}

const previousStorage = globalThis.localStorage;
globalThis.localStorage = createMemoryStorage({
  'cretli-chat-favorite-presets': JSON.stringify([
    { harness: 'OpenCode', model: 'openai/gpt-5' },
    { harness: 'opencode', model: 'openai/gpt-5' },
    { harness: 'not-a-harness', model: 'auto' },
    { harness: 'sdk', model: '' },
  ]),
});

try {
  const store = createChatPresetsStore();
  assert.deepEqual(store.getPresets(), [
    { harness: 'opencode', model: 'openai/gpt-5' },
    { harness: 'sdk', model: 'auto' },
  ]);
  assert.equal(store.isFavorite({ harness: 'opencode', model: 'openai/gpt-5' }), true);
  assert.equal(store.toggleFavorite({ harness: 'codex', model: 'gpt-5' }), true);
  assert.equal(store.isFavorite({ harness: 'codex', model: 'gpt-5' }), true);
  assert.equal(store.toggleFavorite({ harness: 'codex', model: 'gpt-5' }), false);
  assert.equal(store.removeFavorite({ harness: 'sdk', model: 'auto' }), true);
  assert.equal(store.removeFavorite({ harness: 'sdk', model: 'auto' }), false);
  assert.deepEqual(normalizeChatPreset({ harness: 'QWEN', model: ' qwen3.8-max ' }), {
    harness: 'qwen',
    model: 'qwen3.8-max',
  });
  assert.equal(chatPresetKey({ harness: 'sdk', model: 'auto' }), 'sdk\u0000auto');
  console.log('chat-presets.test.js OK');
} finally {
  globalThis.localStorage = previousStorage;
}
