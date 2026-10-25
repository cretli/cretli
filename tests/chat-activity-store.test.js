/**
 * Task 2.1 — RAM activity/last-used store and the shared persistence adapter.
 *
 * Covers the leaf acceptance:
 * - per-key max-timestamp merge (never whole-map overwrite),
 * - legacy hydration exactly once, and cross-session rejection,
 * - session reset / another-tab invalidation rejecting stale data,
 * - a partial (non-authoritative) index never pruning activity of chats that
 *   have not been loaded yet,
 * - the render/comparator path using no storage after the one-time hydrate,
 * - the adapter contract shared with the 2.3 queue.
 *
 * Uses `node:test`; run with `node tests/chat-activity-store.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_ACTIVITY_STORAGE_KEY,
  CHAT_PERSISTENCE_INVALIDATION_KEY,
  CHAT_PERSISTENCE_SESSION_KEY,
  createMemoryPersistenceAdapter,
  createStoragePersistenceAdapter,
  isPersistenceAdapter,
  parseTimestampMapPayload,
  serializeSessionMarker,
  serializeTimestampMap,
} from '../app_front/features/chat/chatPersistenceAdapter.js';
import {
  __resetChatActivityStoreForTest,
  createChatActivityStore,
  getChatActivityStore,
  installChatActivityStorageListener,
} from '../app_front/features/chat/chatActivityStore.js';
import {
  getChatActivityAt,
  getChatLastUsedAt,
} from '../app_front/features/chat/chatStore.js';
import { getChatUpdatedAtMs } from '../app_front/features/chat/chatListSort.js';
import { buildChatLocalBootCache } from '../app_front/features/chat/chatLocalBootCache.js';

/**
 * @param {Record<string, string>} [initial]
 */
function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  let reads = 0;
  let writes = 0;
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      reads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      writes += 1;
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    resetCounters() {
      reads = 0;
      writes = 0;
    },
    get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

test('merge keeps the max timestamp per key and never replaces the whole map', () => {
  const store = createChatActivityStore({ adapter: createMemoryPersistenceAdapter(), now: () => 100 });

  assert.deepEqual(store.mergeActivity({ a: 100, b: 200 }, { force: true }), {
    applied: 2,
    changedIds: ['a', 'b'],
    rejected: false,
  });

  // A lower value must not move the key backwards...
  assert.equal(store.mergeActivity({ a: 50 }, { force: true }).applied, 0);
  assert.equal(store.getActivityAt('a'), 100);
  // ...and the merge must not drop keys absent from the incoming map.
  assert.equal(store.getActivityAt('b'), 200);

  assert.equal(store.mergeActivity({ a: 150 }, { force: true }).applied, 1);
  assert.equal(store.getActivityAt('a'), 150);

  // A brand-new key is added without touching the existing ones.
  assert.equal(store.mergeActivity({ c: 10 }, { force: true }).applied, 1);
  assert.equal(store.getActivityAt('b'), 200);
  assert.equal(store.getActivityAt('c'), 10);

  store.recordActivity('a', 120);
  assert.equal(store.getActivityAt('a'), 150, 'a local record also keeps the max');
  store.recordActivity('a', 175);
  assert.equal(store.getActivityAt('a'), 175);

  store.mergeLastUsed({ x: 10, y: 90 }, { force: true });
  store.mergeLastUsed({ x: 5 }, { force: true });
  assert.equal(store.getLastUsedAt('x'), 10);
  assert.equal(store.getLastUsedAt('y'), 90);
});

test('hydrates legacy maps exactly once and is storage-free afterwards', () => {
  const storage = createFakeStorage({
    [CHAT_ACTIVITY_STORAGE_KEY]: JSON.stringify({ chatA: 111 }),
  });
  const store = createChatActivityStore({ storage, now: () => 1_000 });

  const first = store.hydrateLegacyOnce();
  assert.equal(first.hydrated, true);
  assert.equal(first.reason, 'legacy');
  assert.equal(first.activity, 1);
  assert.equal(store.getActivityAt('chatA'), 111);

  const readsAfterHydrate = storage.reads;
  const second = store.hydrateLegacyOnce();
  assert.equal(second.hydrated, false);
  assert.equal(second.reason, 'already');

  // A thousand comparator-like reads must not touch storage again.
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(store.getActivityAt('chatA'), 111);
    assert.equal(store.getLastUsedAt('chatA'), 0);
  }
  assert.equal(storage.reads, readsAfterHydrate, 'no storage read after the one-time hydrate');
});

test('reset session rejects stale data and does not re-import old legacy maps', () => {
  const storage = createFakeStorage({
    [CHAT_ACTIVITY_STORAGE_KEY]: JSON.stringify({ legacy: 42 }),
  });
  const store = createChatActivityStore({ storage, now: () => 100 });

  assert.equal(store.getActivityAt('legacy'), 42, 'legacy data is hydrated once');
  const before = store.getSession();

  store.recordActivity('chatB', 500);
  const reset = store.resetSession({ reason: 'logout' });
  assert.ok(reset.generation > before.generation);
  assert.notEqual(reset.sessionId, before.sessionId);

  assert.equal(store.getActivityAt('chatB'), 0, 'RAM is dropped at the session boundary');
  assert.equal(store.getActivityAt('legacy'), 0, 'old legacy data is not re-imported');

  const rejectedBase = store.mergeActivity({ chatB: 900 }, before);
  assert.equal(rejectedBase.rejected, true);
  assert.equal(rejectedBase.applied, 0);
  assert.equal(store.getActivityAt('chatB'), 0, 'an old session payload cannot resurrect data');

  const rejectedByGeneration = store.mergeActivity({ chatB: 900 }, {
    sessionId: reset.sessionId,
    generation: before.generation,
  });
  assert.equal(rejectedByGeneration.rejected, true);
  assert.equal(store.getActivityAt('chatB'), 0);

  const accepted = store.mergeActivity({ chatB: 900 }, reset);
  assert.equal(accepted.rejected, false);
  assert.equal(accepted.applied, 1);
  assert.equal(store.getActivityAt('chatB'), 900);
});

test('another tab invalidates RAM and stale cross-tab payloads are rejected', () => {
  const adapter = createMemoryPersistenceAdapter();
  const store = createChatActivityStore({ adapter, now: () => 100 });
  store.recordActivity('chatA', 100);
  const previous = store.getSession();

  // Another tab rotated the shared session marker.
  const adopted = store.handleStorageEvent({
    key: CHAT_PERSISTENCE_SESSION_KEY,
    newValue: serializeSessionMarker({ id: 'session-other', generation: 7 }),
  });
  assert.equal(adopted.handled, true);
  assert.equal(adopted.reset, true);
  assert.equal(store.getSession().sessionId, 'session-other');
  assert.equal(store.getActivityAt('chatA'), 0);

  // A wrapped payload written by the old session must not be applied.
  const stalePayload = serializeTimestampMap({ chatA: 900 }, previous);
  const rejected = store.handleStorageEvent({
    key: CHAT_ACTIVITY_STORAGE_KEY,
    newValue: stalePayload,
  });
  assert.equal(rejected.rejected, true);
  assert.equal(store.getActivityAt('chatA'), 0);

  // An explicit invalidation event clears RAM without a new session marker.
  store.recordActivity('chatC', 700);
  const invalidated = store.handleStorageEvent({
    key: CHAT_PERSISTENCE_INVALIDATION_KEY,
    newValue: JSON.stringify({ at: 1, reason: 'manual' }),
  });
  assert.equal(invalidated.reset, true);
  assert.equal(store.getActivityAt('chatC'), 0);

  // A record after the boundary must still write a payload under a valid session.
  store.recordActivity('chatD', 800);
  const repersisted = parseTimestampMapPayload(adapter.read(CHAT_ACTIVITY_STORAGE_KEY));
  assert.ok(repersisted.sessionId, 'post-invalidation write carries a session id');
  assert.equal(repersisted.sessionId, store.getSession().sessionId);
  assert.equal(repersisted.values.chatD, 800);
});

test('a partial index never prunes activity of not-yet-loaded chats', () => {
  const store = createChatActivityStore({ adapter: createMemoryPersistenceAdapter(), now: () => 100 });
  store.recordActivity('loadedA', 100);
  store.recordActivity('notLoadedB', 200);

  const skipped = store.pruneToKnownIds(['loadedA'], { authoritative: false });
  assert.equal(skipped.pruned, 0);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.authoritative, false);
  assert.equal(store.getActivityAt('notLoadedB'), 200, 'partial index keeps unknown activity');

  const pruned = store.pruneToKnownIds(['loadedA'], { authoritative: true });
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.skipped, false);
  assert.equal(store.getActivityAt('loadedA'), 100);
  assert.equal(store.getActivityAt('notLoadedB'), 0);
  assert.equal(store.hasAuthoritativeIndex(), true);
});

test('persisted payloads round-trip through a reload with the same session', () => {
  const storage = createFakeStorage();
  const first = createChatActivityStore({ storage, now: () => 100 });
  first.recordActivity('chatA', 123);

  const stored = storage.getItem(CHAT_ACTIVITY_STORAGE_KEY);
  const parsed = parseTimestampMapPayload(stored);
  assert.equal(parsed.wrapped, true);
  assert.equal(parsed.sessionId, first.getSession().sessionId);
  assert.deepEqual(parsed.values, { chatA: 123 });

  // Same storage + session marker = a reload imports its own wrapped payload.
  const reloaded = createChatActivityStore({ storage, now: () => 200 });
  assert.equal(reloaded.getActivityAt('chatA'), 123);
});

test('a cross-tab payload arriving before the first local read is still applied', () => {
  const storage = createFakeStorage();
  const store = createChatActivityStore({ storage, now: () => 100 });
  const session = { id: 'shared-session', generation: 1 };
  storage.setItem(CHAT_PERSISTENCE_SESSION_KEY, serializeSessionMarker(session));
  const remote = serializeTimestampMap({ chatX: 777 }, { sessionId: session.id, generation: session.generation });

  const result = store.handleStorageEvent({ key: CHAT_ACTIVITY_STORAGE_KEY, newValue: remote });
  assert.equal(result.applied, 1);
  assert.equal(store.getActivityAt('chatX'), 777);
});

test('first migration rewrites legacy raw maps so the next reload keeps them', () => {
  const storage = createFakeStorage({
    [CHAT_ACTIVITY_STORAGE_KEY]: JSON.stringify({ legacy: 42 }),
  });
  const first = createChatActivityStore({ storage, now: () => 100 });
  assert.equal(first.getActivityAt('legacy'), 42);

  const migrated = parseTimestampMapPayload(storage.getItem(CHAT_ACTIVITY_STORAGE_KEY));
  assert.equal(migrated.wrapped, true, 'legacy raw map is rewritten in the wrapped form');
  assert.equal(migrated.sessionId, first.getSession().sessionId);

  const reloaded = createChatActivityStore({ storage, now: () => 200 });
  assert.equal(reloaded.getActivityAt('legacy'), 42, 'migrated payload survives a reload');
});

test('a reload after a session reset keeps the new session and rejects the old one', () => {
  const storage = createFakeStorage();
  const first = createChatActivityStore({ storage, now: () => 100 });
  first.recordActivity('oldSession', 100);
  const sessionA = first.getSession();

  first.resetSession({ reason: 'logout' });
  first.recordActivity('newSession', 200);
  const sessionB = first.getSession();
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);

  const reloaded = createChatActivityStore({ storage, now: () => 300 });
  assert.equal(reloaded.getActivityAt('newSession'), 200, 'reload keeps the current session data');
  assert.equal(reloaded.getActivityAt('oldSession'), 0, 'the previous session data is not imported');
  assert.equal(
    parseTimestampMapPayload(storage.getItem(CHAT_ACTIVITY_STORAGE_KEY)).sessionId,
    sessionB.sessionId
  );
});

test('adapter contract is shared by the memory and localStorage backends', () => {
  const memory = createMemoryPersistenceAdapter();
  const storage = createStoragePersistenceAdapter(() => createFakeStorage());
  assert.ok(isPersistenceAdapter(memory));
  assert.ok(isPersistenceAdapter(storage));
  assert.equal(memory.contractVersion, storage.contractVersion);
  assert.equal(memory.kind, 'memory');
  assert.equal(storage.kind, 'local-storage');

  const payload = serializeTimestampMap(new Map([['a', 5]]), {
    sessionId: 's1',
    generation: 2,
    updatedAt: 9,
  });
  const parsed = parseTimestampMapPayload(payload);
  assert.equal(parsed.wrapped, true);
  assert.equal(parsed.sessionId, 's1');
  assert.equal(parsed.generation, 2);
  assert.deepEqual(parsed.values, { a: 5 });

  const legacy = parseTimestampMapPayload(JSON.stringify({ b: 7 }));
  assert.equal(legacy.wrapped, false);
  assert.equal(legacy.sessionId, '');
  assert.deepEqual(legacy.values, { b: 7 });
  assert.equal(parseTimestampMapPayload('not json'), null);
  assert.equal(parseTimestampMapPayload(''), null);
});

test('render/boot-cache comparator is storage-free after the one-time hydrate', () => {
  const storage = createFakeStorage({
    [CHAT_ACTIVITY_STORAGE_KEY]: JSON.stringify({ chatA: 2_000_000_000_000 }),
  });
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    const chat = { id: 'chatA', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' };
    assert.equal(getChatUpdatedAtMs(chat), 2_000_000_000_000, 'activity contributes to the ranking');

    const readsAfterHydrate = storage.reads;
    for (let index = 0; index < 1_000; index += 1) {
      getChatUpdatedAtMs(chat);
    }
    assert.equal(storage.reads, readsAfterHydrate, 'repeated comparator calls do not read storage');

    // > cap rebuilds the boot cache through the same comparator; still no reads.
    const chats = Array.from({ length: 350 }, (_, index) => ({
      id: `chat-${index}`,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2021-01-01T00:00:00.000Z',
    }));
    const doc = buildChatLocalBootCache({ chats, activeChatId: 'chat-0' });
    assert.equal(doc.chats.length, 300);
    assert.equal(storage.reads, readsAfterHydrate, 'boot-cache build comparator reads no storage');
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('local and cross-tab activity update the ranking through the singleton', () => {
  const storage = createFakeStorage();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    const store = getChatActivityStore();
    store.recordActivity('chatA', 1_000);
    assert.equal(getChatUpdatedAtMs({ id: 'chatA' }), 1_000);

    // Another tab publishes a wrapped payload for the same session.
    const session = store.getSession();
    const remote = serializeTimestampMap({ chatB: 5_000 }, session);
    storage.setItem(CHAT_ACTIVITY_STORAGE_KEY, remote);
    const result = store.handleStorageEvent({
      key: CHAT_ACTIVITY_STORAGE_KEY,
      newValue: remote,
    });
    assert.equal(result.applied, 1);
    assert.equal(getChatUpdatedAtMs({ id: 'chatB' }), 5_000);

    // getChatActivityAt still merges the runtime `_lastOutputAt` from RAM.
    assert.equal(getChatActivityAt({ id: 'chatB', _lastOutputAt: 9_000 }), 9_000);
    assert.equal(getChatLastUsedAt('chatB'), 0);
    assert.equal(store.getActivityAt('chatA'), 1_000);
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('getChatActivityAt does not mutate the chat object (runtime identity preserved)', () => {
  const storage = createFakeStorage();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    const chat = { id: 'chatA', _lastOutputAt: 300, title: 'A' };
    const before = JSON.stringify(chat);
    assert.equal(getChatActivityAt(chat), 300);
    assert.equal(JSON.stringify(chat), before);
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('broadcastInvalidation rotates session and clears persisted maps', () => {
  const storage = createFakeStorage();
  const store = createChatActivityStore({ storage, now: () => 100 });
  store.recordActivity('chatA', 100);
  const before = store.getSession();
  const marker = store.broadcastInvalidation('manual-reset');
  assert.notEqual(marker.sessionId, before.sessionId);
  assert.equal(store.getActivityAt('chatA'), 0, 'calling tab drops RAM');
  const activityPayload = parseTimestampMapPayload(storage.getItem(CHAT_ACTIVITY_STORAGE_KEY));
  assert.equal(activityPayload.sessionId, marker.sessionId);
  assert.deepEqual(activityPayload.values, {}, 'persisted activity map is cleared under the new session');
  const invalidation = JSON.parse(storage.getItem(CHAT_PERSISTENCE_INVALIDATION_KEY) || '{}');
  assert.equal(invalidation.sessionId, marker.sessionId);
});

test('storage listener installs once and detaches cleanly', () => {
  /** @type {Array<(event: object) => void>} */
  const handlers = [];
  const target = {
    addEventListener(_type, handler) {
      handlers.push(handler);
    },
    removeEventListener(_type, handler) {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
  __resetChatActivityStoreForTest();
  try {
    const off = installChatActivityStorageListener(target);
    assert.equal(handlers.length, 1, 'one storage listener is installed at boot');
    off();
    assert.equal(handlers.length, 0, 'cleanup removes the listener');
  } finally {
    __resetChatActivityStoreForTest();
  }
});
