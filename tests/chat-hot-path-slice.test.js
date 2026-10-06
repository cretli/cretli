/**
 * Task 8.1 — time-sliced hot paths match synchronous equivalents; stale apply aborts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  selectMonitoredChatIds,
  selectMonitoredChatIdsAsync,
} from '../app_front/features/chat/chatBackgroundPolicy.js';
import {
  buildChatLocalBootCache,
  buildChatLocalBootCacheDocAsync,
  writeChatLocalBootCacheToAdapterAsync,
} from '../app_front/features/chat/chatLocalBootCache.js';
import { createMemoryPersistenceAdapter } from '../app_front/features/chat/chatPersistenceAdapter.js';
import {
  reconcileServerChatsSync,
  reconcileServerChatsInTimeSlices,
} from '../app_front/features/chat/chatListServerReconcile.js';
import { getChatActivityAt } from '../app_front/features/chat/chatStore.js';
import {
  DEFAULT_SLICE_BUDGET_MS,
  SLICE_BUDGET_CALIBRATION_ITEMS,
  calibrateSliceBudgetMsFromSample,
  measureSyncChunkDurationMs,
} from '../app_front/lib/schedulerYield.js';

const instantYieldDeps = {
  now: () => 0,
  setTimeoutFn: (fn) => {
    fn();
    return 1;
  },
  clearTimeoutFn: () => {},
};

function makeChats(count) {
  const chats = [];
  for (let index = 0; index < count; index += 1) {
    chats.push({
      id: `chat-${index}`,
      title: `Chat ${index}`,
      cursorSessionId: `sess-${index}`,
      updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
    });
  }
  return chats;
}

test('selectMonitoredChatIdsAsync matches sync selection order', async () => {
  const rows = makeChats(200);
  rows[5]._serverRunState = { state: 'waiting' };
  rows[10].archivedAt = '2026-01-01T00:00:00.000Z';
  rows[10]._serverRunState = { state: 'attention' };
  const now = 1_800_000_000_000;
  const sync = [...selectMonitoredChatIds(rows, () => 'chat-0', getChatActivityAt, now)].sort();
  const asyncSet = await selectMonitoredChatIdsAsync(
    rows,
    () => 'chat-0',
    getChatActivityAt,
    now,
    { deps: instantYieldDeps, budgetMs: 0 },
  );
  const asyncIds = [...asyncSet].sort();
  assert.deepEqual(asyncIds, sync);
});

test('buildChatLocalBootCacheDocAsync matches sync doc for large lists', async () => {
  const chats = makeChats(450);
  const input = { chats, activeChatId: 'chat-0' };
  const syncDoc = buildChatLocalBootCache(input);
  const asyncBuilt = await buildChatLocalBootCacheDocAsync(input, {
    deps: instantYieldDeps,
    budgetMs: 0,
  });
  assert.equal(asyncBuilt.cancelled, false);
  assert.deepEqual(asyncBuilt.doc.chats.map((row) => row.id), syncDoc.chats.map((row) => row.id));
});

test('reconcileServerChatsInTimeSlices matches sync when apply stays fresh', async () => {
  const serverChats = makeChats(120);
  const runtimeById = new Map();
  runtimeById.set('chat-0', { id: 'chat-0', title: 'Old', summaries: [] });
  const ctx = {
    readChatBufferForChatRestore: () => null,
    chatBufferMax: 100,
    blockedTransitions: [],
    restoredTransitions: [],
    hydratePresenceChat: () => false,
    presenceDirtyIds: [],
  };
  const syncRows = reconcileServerChatsSync(serverChats, runtimeById, ctx);
  const sliced = await reconcileServerChatsInTimeSlices(serverChats, runtimeById, ctx, {
    isApplyFresh: () => true,
    deps: instantYieldDeps,
    budgetMs: 0,
  });
  assert.equal(sliced.cancelled, false);
  assert.deepEqual(sliced.rows.map((row) => row.id), syncRows.map((row) => row.id));
  assert.equal(sliced.rows[0].title, 'Chat 0');
});

test('reconcileServerChatsInTimeSlices aborts when apply token goes stale', async () => {
  const serverChats = makeChats(200);
  const runtimeById = new Map();
  const ctx = {
    readChatBufferForChatRestore: () => null,
    chatBufferMax: 100,
    blockedTransitions: [],
    restoredTransitions: [],
    hydratePresenceChat: () => false,
    presenceDirtyIds: [],
  };
  const aborted = await reconcileServerChatsInTimeSlices(serverChats, runtimeById, ctx, {
    isApplyFresh: () => false,
    deps: instantYieldDeps,
    budgetMs: 0,
  });
  assert.equal(aborted.cancelled, true);
  assert.equal(aborted.rows.length, 0);
});

test('default slice budget calibrates near 8 ms on noop sample', () => {
  const duration = measureSyncChunkDurationMs(SLICE_BUDGET_CALIBRATION_ITEMS, () => {}, {
    now: () => 0,
  });
  assert.equal(duration, 0);
  const budget = calibrateSliceBudgetMsFromSample(duration);
  assert.equal(budget, DEFAULT_SLICE_BUDGET_MS);
});

test('async boot persist aborts mid-build without mutating revision signature', async () => {
  const adapter = createMemoryPersistenceAdapter();
  const chats = makeChats(350);
  let applyChecks = 0;
  const revision = { lastSignature: '' };
  const result = await writeChatLocalBootCacheToAdapterAsync(
    adapter,
    { chats, activeChatId: 'chat-0' },
    revision,
    {
      deps: instantYieldDeps,
      budgetMs: 0,
      isApplyFresh: () => {
        applyChecks += 1;
        return applyChecks < 8;
      },
      canPersist: () => applyChecks < 8,
    },
  );
  assert.equal(result.cancelled, true);
  assert.equal(revision.lastSignature, '');
});

test('slice budget calibration tightens on expensive per-item sample', () => {
  let clock = 0;
  const duration = measureSyncChunkDurationMs(SLICE_BUDGET_CALIBRATION_ITEMS, () => {
    clock += 11;
  }, {
    now: () => clock,
  });
  assert.ok(duration >= SLICE_BUDGET_CALIBRATION_ITEMS);
  const budget = calibrateSliceBudgetMsFromSample(duration);
  assert.ok(budget < DEFAULT_SLICE_BUDGET_MS);
  assert.ok(budget >= 4);
});
