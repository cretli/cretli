/**
 * Task 2.2: prepared ranking keys — one numeric key per chat from RAM, no storage
 * in the comparator, boot-cache cap equivalent to legacy getChatUpdatedAtMs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_ACTIVITY_STORAGE_KEY } from '../app_front/features/chat/chatPersistenceAdapter.js';
import {
  __resetChatActivityStoreForTest,
  getChatActivityStore,
} from '../app_front/features/chat/chatActivityStore.js';
import {
  buildChatLocalBootCache,
  CHAT_LOCAL_BOOT_CACHE_MAX_CHATS,
  sanitizeChatRowForBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';
import {
  comparePreparedActivityAtDesc,
  comparePreparedRankingUpdatedAtMsDesc,
  getChatUpdatedAtMs,
  prepareChatActivitySortKeys,
  prepareChatRankingUpdatedAtMs,
} from '../app_front/features/chat/chatListSort.js';
import { selectBackgroundWsChatIds } from '../app_front/features/chat/chatBackgroundPolicy.js';
import { getChatActivityAt } from '../app_front/features/chat/chatStore.js';

/**
 * Legacy boot-cache row selection (comparator calls getChatUpdatedAtMs per compare).
 *
 * @param {unknown[]} chats
 * @param {unknown} activeChatId
 * @returns {object[]}
 */
function selectChatsForBootCacheLegacy(chats, activeChatId) {
  const rows = (Array.isArray(chats) ? chats : [])
    .map(sanitizeChatRowForBootCache)
    .filter(Boolean);
  const activeId = typeof activeChatId === 'string' ? activeChatId.trim() : '';
  const kept = new Set();
  const required = [];
  const rest = [];
  for (const row of rows) {
    if (kept.has(row.id)) continue;
    if (row.watcherPinned === true || (activeId && row.id === activeId)) {
      required.push(row);
      kept.add(row.id);
      continue;
    }
    rest.push(row);
  }
  if (rows.length <= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS) return rows;
  rest.sort((left, right) => {
    const delta = getChatUpdatedAtMs(right) - getChatUpdatedAtMs(left);
    if (delta !== 0) return delta;
    return String(left.id).localeCompare(String(right.id));
  });
  const selected = required.slice();
  for (const row of rest) {
    if (selected.length >= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS) break;
    if (kept.has(row.id)) continue;
    selected.push(row);
    kept.add(row.id);
  }
  return selected;
}

/**
 * @param {number} count
 * @param {{ activeId?: string, pinnedId?: string, bumpActivity?: Record<string, number> }} [options]
 */
function buildSyntheticChats(count, options = {}) {
  const chats = [];
  for (let index = 0; index < count; index += 1) {
    const id = `chat-${String(index).padStart(5, '0')}`;
    const day = String((index % 28) + 1).padStart(2, '0');
    chats.push({
      id,
      title: id,
      cursorSessionId: `sess-${index}`,
      createdAt: `2020-03-${day}T00:00:00.000Z`,
      updatedAt: `2020-04-${day}T00:00:00.000Z`,
    });
  }
  if (options.pinnedId) {
    const pinned = chats.find((chat) => chat.id === options.pinnedId);
    if (pinned) {
      pinned.watcherPinned = true;
      pinned.updatedAt = '2015-01-01T00:00:00.000Z';
    }
  }
  if (options.bumpActivity) {
    for (const [id, ms] of Object.entries(options.bumpActivity)) {
      const row = chats.find((chat) => chat.id === id);
      if (row) row._lastOutputAt = ms;
    }
  }
  return chats;
}

function idsOf(rows) {
  return rows.map((row) => row.id);
}

/**
 * @param {Record<string, string>} [initial]
 */
function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  let reads = 0;
  return {
    getItem(key) {
      reads += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    get reads() {
      return reads;
    },
  };
}

const CAP_SIZES = [300, 301, 1000, 1500];

test('prepared boot-cache cap matches legacy for 300/301/1000/1500 chats', () => {
  for (const count of CAP_SIZES) {
    const pinnedId = `chat-${String(Math.min(999, count - 1)).padStart(5, '0')}`;
    const chats = buildSyntheticChats(count, {
      activeId: 'chat-00000',
      pinnedId,
    });
    const activeChatId = 'chat-00000';
    const legacyIds = idsOf(selectChatsForBootCacheLegacy(chats, activeChatId)).sort();
    const modernIds = idsOf(buildChatLocalBootCache({ chats, activeChatId }).chats).sort();
    assert.deepEqual(modernIds, legacyIds, `cap set equivalent at n=${count}`);
    assert.ok(modernIds.includes('chat-00000'), `active kept at n=${count}`);
    assert.ok(modernIds.includes(pinnedId), `watcherPinned kept at n=${count}`);
    assert.ok(modernIds.length <= CHAT_LOCAL_BOOT_CACHE_MAX_CHATS + 2, `cap respected at n=${count}`);
  }
});

test('ranking key is computed once per row; comparator uses prepared fields only', () => {
  const chats = buildSyntheticChats(400);
  const entries = prepareChatRankingUpdatedAtMs(chats);
  assert.equal(entries.length, chats.length);
  for (const entry of entries) {
    assert.equal(entry.updatedAtMs, getChatUpdatedAtMs(entry.chat), 'prepared key matches legacy fn');
  }
  const sorted = entries.slice().sort(comparePreparedRankingUpdatedAtMsDesc);
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1];
    const cur = sorted[index];
    assert.ok(
      prev.updatedAtMs > cur.updatedAtMs
      || (prev.updatedAtMs === cur.updatedAtMs && String(prev.chat.id) <= String(cur.chat.id))
    );
  }
});

test('boot-cache build has zero storage reads after activity hydrate', () => {
  const storage = createFakeStorage({
    [CHAT_ACTIVITY_STORAGE_KEY]: JSON.stringify({ 'chat-00001': 9_000_000_000_000 }),
  });
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    getChatUpdatedAtMs({ id: 'chat-00001', createdAt: '2020-01-01T00:00:00.000Z' });
    const readsAfterHydrate = storage.reads;
    const chats = buildSyntheticChats(1500);
    buildChatLocalBootCache({ chats, activeChatId: 'chat-00000' });
    assert.equal(storage.reads, readsAfterHydrate, 'no storage reads during capped boot-cache build');
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('activity change updates boot-cache ranking (newer activity wins a slot)', () => {
  const storage = createFakeStorage();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    const store = getChatActivityStore();
    const chats = buildSyntheticChats(350, { pinnedId: 'chat-00300' });
    const lowId = 'chat-00340';
    chats.find((chat) => chat.id === lowId).updatedAt = '2000-01-01T00:00:00.000Z';
    chats.find((chat) => chat.id === lowId).createdAt = '2000-01-01T00:00:00.000Z';
    const before = idsOf(buildChatLocalBootCache({ chats, activeChatId: 'chat-00000' }).chats);
    assert.equal(before.includes(lowId), false, 'low rank row excluded before activity bump');
    store.recordActivity(lowId, Date.now() + 1_000_000_000_000);
    const after = idsOf(buildChatLocalBootCache({ chats, activeChatId: 'chat-00000' }).chats);
    assert.equal(after.includes(lowId), true, 'activity bump promotes row into capped snapshot');
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});

test('background WS selection reads activity once per listed chat', () => {
  const now = 5_000_000;
  const chats = buildSyntheticChats(20).map((chat, index) => ({
    ...chat,
    activityAt: now - index * 1_000,
  }));
  let activityReads = 0;
  const getChatActivityAtSpy = (chat) => {
    activityReads += 1;
    return chat.activityAt;
  };
  selectBackgroundWsChatIds(chats, () => 'chat-00000', getChatActivityAtSpy, now);
  const eligibleCount = chats.filter(
    (chat) => chat?.id && chat?.cursorSessionId && chat.id !== 'chat-00000'
  ).length;
  assert.equal(activityReads, eligibleCount, 'one activity read per row before sort');

  const prepared = prepareChatActivitySortKeys(
    chats.filter((chat) => chat.id !== 'chat-00000'),
    (chat) => chat.activityAt
  );
  activityReads = 0;
  prepared.sort(comparePreparedActivityAtDesc);
  assert.equal(activityReads, 0, 'WS sort comparator does not re-read activity');
});

test('prepared activity keys match getChatActivityAt from RAM store', () => {
  const storage = createFakeStorage();
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  __resetChatActivityStoreForTest();
  try {
    getChatActivityStore().recordActivity('chat-a', 42_000);
    const chat = { id: 'chat-a', _lastOutputAt: 50_000, cursorSessionId: 's' };
    const [entry] = prepareChatActivitySortKeys([chat], getChatActivityAt);
    assert.equal(entry.activityAt, 50_000);
  } finally {
    __resetChatActivityStoreForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
