/**
 * Task 5.1 — auth session boundary ordering (node, no real IDB).
 *
 * Run: node tests/chat-session-boundary.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryPersistenceAdapter } from '../app_front/features/chat/chatPersistenceAdapter.js';
import {
  __resetChatActivityStoreForTest,
  __setChatActivityStoreForTest,
  createChatActivityStore,
} from '../app_front/features/chat/chatActivityStore.js';
import {
  __resetChatPersistenceQueueForTest,
  __setChatPersistenceQueueForTest,
  createChatPersistenceQueue,
} from '../app_front/features/chat/chatPersistenceQueue.js';
import { applyChatAuthSessionBoundary } from '../app_front/features/chat/chatSessionBoundary.js';
import { __resetChatMetadataIdbForTest } from '../app_front/features/chat/chatMetadataIdb.js';
import {
  readChatLocalBootSync,
  writeChatLocalBootSync,
} from '../app_front/features/chat/chatLocalBootSync.js';
import {
  __resetChatBootListHydrationControllerForTest,
  getChatBootListHydrationController,
} from '../app_front/features/chat/chatLocalBootAsyncHydrate.js';

test('applyChatAuthSessionBoundary rotates session before adapter reads old payload', async () => {
  __resetChatActivityStoreForTest();
  __resetChatMetadataIdbForTest();
  const adapter = createMemoryPersistenceAdapter({
    'cretli-chat-activity': JSON.stringify({ stale: 999 }),
  });
  let sessionSerial = 0;
  const store = createChatActivityStore({
    adapter,
    createSessionId: () => `sess-${++sessionSerial}`,
  });
  __setChatActivityStoreForTest(store);
  store.hydrateLegacyOnce();
  const beforeId = store.getSession().sessionId;
  assert.equal(store.getActivityAt('stale'), 999);
  const reset = await applyChatAuthSessionBoundary({
    reason: 'logout-test',
    storage: null,
    idb: () => null,
  });
  assert.notEqual(reset.sessionId, beforeId);
  assert.equal(store.getActivityAt('stale'), 0);
  __resetChatActivityStoreForTest();
  __resetChatMetadataIdbForTest();
});

test('stale queue flush is invalidated after boundary', async () => {
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  __resetChatPersistenceQueueForTest();
  const adapter = createMemoryPersistenceAdapter();
  const store = createChatActivityStore({ adapter, createSessionId: () => 's1' });
  __setChatActivityStoreForTest(store);
  const queue = createChatPersistenceQueue({
    adapter,
    getSession: () => store.getSession(),
    getBootCacheInput: () => null,
    getActivitySnapshots: () => ({ activity: { c1: 50 }, lastUsed: {} }),
    debounceMs: 5,
  });
  __setChatPersistenceQueueForTest(queue);
  queue.markActivityDirty();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await applyChatAuthSessionBoundary({ reason: '401-test', idb: () => null });
  assert.equal(store.getActivityAt('c1'), 0);
  __resetChatMetadataIdbForTest();
  __resetChatActivityStoreForTest();
  __resetChatPersistenceQueueForTest();
});

test('auth session boundary clears sync bootstrap and cancels boot hydration (HTTP 401 / WS 4401 path)', async () => {
  __resetChatBootListHydrationControllerForTest();
  __resetChatMetadataIdbForTest();
  const storage = {
    data: Object.create(null),
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  writeChatLocalBootSync(storage, {
    activeChatId: 'a',
    chats: [{ id: 'a', title: 'A' }],
  });
  assert.ok(readChatLocalBootSync(storage));
  const hydration = getChatBootListHydrationController();
  hydration.setSessionScope({ sessionId: 'before', generation: 1 });
  const bootGuard = hydration.captureGuard();
  const isRunActive = hydration.captureRunEpoch();
  await applyChatAuthSessionBoundary({ reason: '4401', storage, idb: () => null });
  assert.equal(readChatLocalBootSync(storage), null);
  assert.equal(hydration.isGuardFresh(bootGuard), false);
  assert.equal(isRunActive(), false);
  __resetChatBootListHydrationControllerForTest();
  __resetChatMetadataIdbForTest();
});
