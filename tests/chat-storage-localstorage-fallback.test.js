import assert from 'node:assert/strict';
import {
  appendSdkChatHistoryRecordsSync,
  flushSdkChatHistoryWrites,
  migrateSdkChatHistoryOutOfLocalStorage,
  SDK_CHAT_HISTORY_STORAGE_PREFIX,
} from '../app_front/lib/sdk-chat-history-store.js';
import {
  migrateChatBuffersOutOfLocalStorage,
  persistChatBuffer,
} from '../app_front/lib/chatBufferStore.js';

let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log('OK:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

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
      return Array.from(map.keys())[index] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function createSdkRecord(index) {
  return { kind: 'sdk', event: { type: 'assistant', text: `${index}:${'x'.repeat(4000)}` } };
}

async function withoutIndexedDb(fn) {
  const previousStorage = globalThis.localStorage;
  const previousIdb = globalThis.indexedDB;
  const storage = createMemoryStorage();
  globalThis.localStorage = storage;
  delete globalThis.indexedDB;
  try {
    return await fn(storage);
  } finally {
    globalThis.localStorage = previousStorage;
    if (previousIdb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIdb;
  }
}

await runCase('no IndexedDB: history falls back to localStorage under a 200KB cap', () =>
  withoutIndexedDb(async (storage) => {
    const chatId = 'chat-fallback';
    const records = [];
    for (let i = 0; i < 200; i++) records.push(createSdkRecord(i));
    appendSdkChatHistoryRecordsSync(chatId, 'session-1', records);
    await flushSdkChatHistoryWrites(chatId);
    const stored = storage.getItem(SDK_CHAT_HISTORY_STORAGE_PREFIX + chatId);
    assert.ok(stored, 'expected a fallback doc in localStorage');
    assert.ok(stored.length <= 200_000, `fallback doc too large: ${stored.length}`);
    const doc = JSON.parse(stored);
    assert.ok(doc.events.length > 0, 'fallback doc must keep the newest events');
    assert.ok(doc.events.length < records.length, 'fallback doc must be trimmed');
  })
);

await runCase('no IndexedDB: migration keeps localStorage docs', () =>
  withoutIndexedDb(async (storage) => {
    const key = `${SDK_CHAT_HISTORY_STORAGE_PREFIX}chat-keep`;
    const doc = { v: 1, cursorSessionId: 'session-1', events: [createSdkRecord(0)] };
    storage.setItem(key, JSON.stringify(doc));
    const summary = await migrateSdkChatHistoryOutOfLocalStorage(['chat-keep']);
    assert.equal(summary.removedKeys, 0);
    assert.ok(storage.getItem(key), 'doc must survive when IndexedDB is unavailable');
  })
);

await runCase('no IndexedDB: chat buffers fall back to localStorage and survive migration', () =>
  withoutIndexedDb(async (storage) => {
    persistChatBuffer('chat-buffer', 'hello buffer', 'cretli-chat-buffer-');
    const key = 'cretli-chat-buffer-chat-buffer';
    assert.equal(storage.getItem(key), 'hello buffer');
    const summary = await migrateChatBuffersOutOfLocalStorage('cretli-chat-buffer-', ['chat-buffer']);
    assert.equal(summary.removedKeys, 0);
    assert.equal(storage.getItem(key), 'hello buffer');
  })
);

await runCase('migration is a no-op without chat ids', () =>
  withoutIndexedDb(async (storage) => {
    const key = `${SDK_CHAT_HISTORY_STORAGE_PREFIX}chat-unknown`;
    storage.setItem(key, 'not-json');
    const summary = await migrateSdkChatHistoryOutOfLocalStorage([]);
    assert.equal(summary.removedKeys, 0);
    assert.ok(storage.getItem(key));
  })
);

if (failed > 0) {
  console.error(`\nchat storage fallback tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll chat storage fallback tests passed.');
