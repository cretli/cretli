import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectChatIdsFromList,
  readChatOrder,
  writeChatOrder,
  writeChatOrderForList,
} from '../app_front/features/sidebar/sidebarChatOrder.js';

function installLocalStorageStub() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

test('readChatOrder returns an empty list when nothing is saved', () => {
  delete globalThis.localStorage;
  assert.deepEqual(readChatOrder(), []);
});

test('writeChatOrder then readChatOrder round-trips ids', () => {
  installLocalStorageStub();
  writeChatOrder(['b', 'a']);
  assert.deepEqual(readChatOrder(), ['b', 'a']);
});

test('writeChatOrderForList merges the visible list into the saved order', () => {
  installLocalStorageStub();
  writeChatOrder(['x', 'a', 'b', 'y']);
  writeChatOrderForList(['b', 'a']);
  assert.deepEqual(readChatOrder(), ['x', 'b', 'a', 'y']);
});

test('collectChatIdsFromList reads data-chat-id', () => {
  const list = {
    querySelectorAll: () => [
      { dataset: { chatId: 'b' } },
      { dataset: { chatId: 'a' } },
      { dataset: {} },
    ],
  };
  assert.deepEqual(collectChatIdsFromList(list), ['b', 'a']);
});
