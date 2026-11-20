/**
 * Task 2.3 — shared persistence queue (boot cache + activity maps).
 *
 * Run: node tests/chat-persistence-queue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_LAST_USED_STORAGE_KEY,
  createMemoryPersistenceAdapter,
  parseTimestampMapPayload,
} from '../app_front/features/chat/chatPersistenceAdapter.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY as BOOT_KEY,
  parseChatLocalBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';
import { createChatPersistenceQueue } from '../app_front/features/chat/chatPersistenceQueue.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';
import { __resetUiFreezeTraceActiveCacheForTest } from '../app_front/lib/uiFreezeTrace.js';

const sampleBootInput = {
  chats: [{ id: 'c1', title: 'One', updatedAt: '2026-01-01T00:00:00.000Z' }],
  workspaces: [{ id: 'ws', kind: 'file', workspaceFile: 'ws', name: 'ws', folders: [] }],
  activeChatId: 'c1',
  workspaceContext: { workspaceFile: 'ws', workspaceFolder: '' },
};

/**
 * @param {object} [overrides]
 */
function createTestQueue(overrides = {}) {
  const adapter = overrides.adapter || createMemoryPersistenceAdapter();
  let session = { sessionId: 'sess-a', generation: 1 };
  const pendingTimers = [];
  const queue = createChatPersistenceQueue({
    adapter,
    getSession: () => session,
    getBootCacheInput: () => sampleBootInput,
    getActivitySnapshots: () => ({
      activity: { c1: 100 },
      lastUsed: { c1: 200 },
    }),
    debounceMs: 20,
    schedule: (fn, delay) => {
      const handle = setTimeout(fn, delay);
      pendingTimers.push(handle);
      return handle;
    },
    cancelSchedule: (handle) => clearTimeout(handle),
    ...overrides,
  });
  return {
    queue,
    adapter,
    setSession(next) {
      session = { ...next };
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

function withFreezeDiagEnabled(run) {
  const map = new Map();
  const storage = {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
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
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  storage.setItem('cretli-ui-freeze-diag', '1');
  __resetUiFreezeTraceActiveCacheForTest();
  __resetUiFreezeCountersForTest();
  try {
    return run();
  } finally {
    __resetUiFreezeCountersForTest();
    __resetUiFreezeTraceActiveCacheForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

test('repeated boot-cache marks without data change produce zero builds and writes', async () => {
  await withFreezeDiagEnabled(async () => {
  const { queue, adapter, wait } = createTestQueue({ debounceMs: 5 });
  try {
    for (let i = 0; i < 5; i += 1) queue.markBootCacheDirty();
    await wait(30);
    await queue.flushNow();
    const stats = queue.getStats();
    assert.equal(stats.bootCacheBuilds, 1);
    assert.equal(stats.bootCacheWrites, 1);
    for (let i = 0; i < 5; i += 1) queue.markBootCacheDirty();
    await wait(30);
    await queue.flushNow();
    const after = queue.getStats();
    assert.equal(after.bootCacheBuilds, 1);
    assert.equal(after.bootCacheWrites, 1);
    assert.ok(parseChatLocalBootCache(adapter.read(BOOT_KEY)));
  } finally {
    /* withFreezeDiagEnabled resets counters */
  }
  });
});

test('many durable changes coalesce into one boot-cache write', async () => {
  const { queue, wait } = createTestQueue({ debounceMs: 15 });
  queue.markBootCacheDirty();
  queue.markBootCacheDirty();
  queue.markActivityDirty();
  queue.markActivityDirty();
  await wait(40);
  const stats = queue.getStats();
  assert.equal(stats.bootCacheWrites, 1);
  assert.equal(stats.activityFlushes, 1);
});

test('unchanged boot-cache revision skips build on flush', async () => {
  await withFreezeDiagEnabled(async () => {
    const adapter = createMemoryPersistenceAdapter();
    const { queue } = createTestQueue({ adapter, debounceMs: 0 });
    queue.markBootCacheDirty();
    await queue.flushNow();
    queue.markBootCacheDirty();
    await queue.flushNow();
    const stats = queue.getStats();
    assert.equal(stats.bootCacheBuilds, 1);
    assert.equal(stats.bootCacheWrites, 1);
  });
});

test('stale queue after session rotation does not restore boot cache', async () => {
  const adapter = createMemoryPersistenceAdapter();
  const { queue, setSession, wait } = createTestQueue({ adapter, debounceMs: 30 });
  queue.markBootCacheDirty();
  setSession({ sessionId: 'sess-b', generation: 2 });
  await wait(50);
  assert.equal(adapter.read(BOOT_KEY), null);
  assert.ok(queue.getStats().invalidatedFlushes >= 1);
});

test('invalidate after logout drops pending boot-cache flush', async () => {
  const adapter = createMemoryPersistenceAdapter();
  const { queue, wait } = createTestQueue({ adapter, debounceMs: 200 });
  queue.markBootCacheDirty();
  queue.invalidate({ clearBootRevision: true });
  await wait(250);
  assert.equal(adapter.read(BOOT_KEY), null);
});

test('invalidated boot flush keeps bootDirty for retry and skips snapshot signature', async () => {
  const adapter = createMemoryPersistenceAdapter();
  let idbEpoch = 0;
  const { queue, wait } = createTestQueue({
    adapter,
    debounceMs: 50,
    getIdbEpoch: () => idbEpoch,
  });
  queue.markBootCacheDirty();
  idbEpoch = 1;
  await wait(60);
  assert.equal(adapter.read(BOOT_KEY), null);
  assert.equal(queue.getBootRevision(), '');
  await queue.flushNow();
  assert.ok(parseChatLocalBootCache(adapter.read(BOOT_KEY)), 'bootDirty preserved after epoch invalidation');
});

test('memory adapter backend is agnostic to queue flush', async () => {
  const adapter = createMemoryPersistenceAdapter();
  const { queue } = createTestQueue({ adapter, debounceMs: 0 });
  queue.markBootCacheDirty();
  queue.markActivityDirty();
  await queue.flushNow();
  assert.ok(parseChatLocalBootCache(adapter.read(BOOT_KEY)));
  const activity = parseTimestampMapPayload(adapter.read(CHAT_ACTIVITY_STORAGE_KEY));
  const lastUsed = parseTimestampMapPayload(adapter.read(CHAT_LAST_USED_STORAGE_KEY));
  assert.equal(activity?.values?.c1, 100);
  assert.equal(lastUsed?.values?.c1, 200);
});
