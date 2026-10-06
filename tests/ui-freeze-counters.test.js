/**
 * Task 0.1 — freeze instrumentation counters, monitoring qualification and the
 * boot-cache integration. Pure helpers plus one flag-on integration check.
 *
 * No DOM is required. The integration block flips the freeze diagnostics flag
 * through a fake localStorage and resets both module singletons, then asserts
 * that a boot-cache build is counted and timed.
 */
import assert from 'node:assert/strict';

import {
  INSTRUMENTED_SPAN_NAMES,
  MONITORING_REASON_NAMES,
  createUiFreezeCounters,
  formatUiFreezeCountersSnapshot,
  getUiFreezeCounters,
  snapshotUiFreezeCounters,
  __resetUiFreezeCountersForTest,
} from '../app_front/lib/uiFreezeCounters.js';
import { setChatPendingRemoteHistoryFlag } from '../app_front/features/chat/chatPendingRemoteHistoryFlag.js';
import { __resetUiFreezeTraceActiveCacheForTest } from '../app_front/lib/uiFreezeTrace.js';
import {
  classifyMonitoringReasons,
  selectMonitoredChatIds,
} from '../app_front/features/chat/chatBackgroundPolicy.js';
import {
  CHAT_LOCAL_BOOT_CACHE_KEY,
  buildChatLocalBootCache,
  readChatLocalBootCache,
} from '../app_front/features/chat/chatLocalBootCache.js';

assert.deepEqual(
  [...MONITORING_REASON_NAMES],
  ['active', 'recent', 'live', 'busy', 'waiting', 'attention'],
);
assert.ok(INSTRUMENTED_SPAN_NAMES.includes('sidebar.archive.render'));

/** @param {{ now?: () => number, active?: () => boolean, windowMs?: number }} [options] */
function createMeter(options = {}) {
  /** @type {Array<{ category: string, event: string, payload: Record<string, unknown> }>} */
  const events = [];
  const meter = createUiFreezeCounters({
    now: options.now || (() => 0),
    active: options.active || (() => true),
    windowMs: options.windowMs || 1000,
    trace: (category, event, payload) => events.push({ category, event, payload: payload || {} }),
  });
  return { meter, events };
}

// --- inactive meter allocates nothing and emits nothing -----------------------------
{
  const { meter, events } = createMeter({ active: () => false });
  assert.equal(meter.allocated(), false);
  meter.bump('cache.builds');
  meter.recordSpan('boot-cache.build', 5);
  meter.recordMountedRows(10);
  meter.beginPendingBatch();
  meter.recordPendingFlip(true);
  meter.endPendingBatch();
  meter.recordMonitoringQualification({ reason: 'active', archived: false });
  meter.flush();
  assert.equal(meter.allocated(), false, 'inactive meter never materialises state');
  assert.equal(events.length, 0, 'inactive meter emits nothing');
  assert.deepEqual(meter.snapshot().counters, {});
}

// --- active meter: counters, spans, rows, pending net, monitoring split -------------
{
  let clock = 200_000;
  const { meter, events } = createMeter({ now: () => clock });
  assert.equal(meter.allocated(), false, 'lazy until the first active observation');

  meter.bump('ui.renders');
  meter.bump('ui.renders');
  meter.bump('storage.reads', 3);
  meter.recordSpanStart('boot-cache.build', { sourceChats: 301 });
  meter.recordSpan('boot-cache.build', 12.5, { sourceChats: 301 });
  meter.recordSpanStart('boot-cache.build');
  meter.recordSpan('boot-cache.build', 7.5);
  meter.recordMountedRows(42);
  meter.recordMountedRows(19);
  assert.equal(meter.allocated(), true, 'first active observation materialises the meter');

  meter.beginPendingBatch();
  meter.recordPendingFlip(true);
  meter.recordPendingFlip(true);
  meter.recordPendingFlip(false);
  assert.equal(meter.endPendingBatch(), 1, 'batch net = true flips - false flips');

  meter.recordMonitoringQualification({ reason: 'attention', archived: true });
  meter.recordMonitoringQualification({ reason: 'waiting', archived: false });
  meter.recordMonitoringQualification({ reason: 'not-a-reason', archived: false });

  const snap = meter.snapshot();
  assert.equal(snap.counters['ui.renders'], 2);
  assert.equal(snap.counters['storage.reads'], 3);
  assert.deepEqual(snap.spans['boot-cache.build'], {
    count: 2,
    totalMs: 20,
    maxMs: 12.5,
    lastMs: 7.5,
  });
  assert.deepEqual(snap.mountedRows, { last: 19, max: 42 });
  assert.deepEqual(snap.pending, {
    batches: 1,
    setTrue: 2,
    setFalse: 1,
    net: 1,
    lastBatchNet: 1,
  });
  assert.deepEqual(snap.monitoring, {
    'attention|archived=true': 1,
    'waiting|archived=false': 1,
    'unknown|archived=false': 1,
  });

  // Span start also emits a pre-work line (a freeze that never returns still
  // leaves the path in the buffer) and a granular end line for the timeline.
  const spanStarts = events.filter((entry) => entry.event === 'span-start');
  assert.equal(spanStarts.length, 2);
  assert.equal(spanStarts[0].payload.name, 'boot-cache.build');
  const spanEvents = events.filter((entry) => entry.event === 'span');
  assert.equal(spanEvents.length, 2);
  assert.equal(spanEvents[0].payload.name, 'boot-cache.build');

  // Rolling the 1s window folds everything into one snapshot and resets the window.
  clock += 1000;
  meter.bump('ui.renders');
  const snapshots = events.filter((entry) => entry.event === 'snapshot');
  assert.equal(snapshots.length, 1, 'one aggregated snapshot for the rolled window');
  assert.equal(snapshots[0].payload.epoch, 200);
  assert.equal(snapshots[0].payload.counters['ui.renders'], 2);
  assert.equal(snapshots[0].payload.spans['boot-cache.build'].count, 2);
  assert.equal(snapshots[0].payload.monitoring['attention|archived=true'], 1);
  assert.equal(snapshots[0].payload.pending.batches, 1);

  meter.flush();
  assert.equal(events.filter((entry) => entry.event === 'snapshot').length, 2, 'flush emits the live window');
}

// --- pending flag helper counts only true/false transitions -------------------------
{
  /** @type {Map<string, string>} */
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
    const chat = { id: 'c1', _pendingRemoteHistory: true };
    const meter = getUiFreezeCounters();
    assert.ok(meter);
    meter.beginPendingBatch();
    assert.equal(setChatPendingRemoteHistoryFlag(chat, true), false, 'same value → no flip');
    assert.equal(setChatPendingRemoteHistoryFlag(chat, false), true);
    assert.equal(setChatPendingRemoteHistoryFlag(chat, false), false);
    assert.equal(meter.endPendingBatch(), -1);
    const snap = meter.snapshot();
    assert.equal(snap.pending.setTrue, 0);
    assert.equal(snap.pending.setFalse, 1);
  } finally {
    __resetUiFreezeCountersForTest();
    __resetUiFreezeTraceActiveCacheForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

// --- formatted snapshot is plain text without chat content ---------------------------
{
  const { meter } = createMeter();
  meter.bump('ui.renders');
  meter.recordSpan('sidebar.layout.apply', 4);
  meter.recordMountedRows(3);
  meter.beginPendingBatch();
  meter.recordPendingFlip(true);
  meter.endPendingBatch();
  meter.recordMonitoringQualification({ reason: 'active', archived: false });
  const text = formatUiFreezeCountersSnapshot(meter.snapshot());
  assert.match(text, /ui\.renders=1/);
  assert.match(text, /span:sidebar\.layout\.apply count=1/);
  assert.match(text, /rows\.last=3/);
  assert.match(text, /pending\.batches=1 setTrue=1 setFalse=0 net=1/);
  assert.match(text, /monitoring:active\|archived=false=1/);
}

// --- monitoring qualification classifier ---------------------------------------------
{
  const notQualified = { id: 'idle', cursorSessionId: 's' };
  assert.deepEqual(classifyMonitoringReasons(notQualified, { activeChatId: 'other' }), []);
  assert.deepEqual(classifyMonitoringReasons({ id: 'no-session' }, {}), []);

  const active = { id: 'a', cursorSessionId: 's' };
  assert.deepEqual(
    classifyMonitoringReasons(active, { activeChatId: 'a', getChatActivityAt: () => 0 }),
    ['active'],
  );

  const recent = { id: 'r', cursorSessionId: 's' };
  assert.deepEqual(
    classifyMonitoringReasons(recent, {
      activeChatId: '',
      now: 100_000,
      getChatActivityAt: () => 99_000,
    }),
    ['recent'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(recent, {
      activeChatId: '',
      now: 100_000,
      getChatActivityAt: () => 0,
    }),
    [],
  );

  const busy = { id: 'b', cursorSessionId: 's', _serverRunState: { state: 'busy' } };
  assert.deepEqual(classifyMonitoringReasons(busy, {}), ['live', 'busy']);
  const waiting = { id: 'w', cursorSessionId: 's', _serverRunState: { state: 'waiting' } };
  assert.deepEqual(classifyMonitoringReasons(waiting, {}), ['live', 'waiting']);
  const attention = { id: 't', cursorSessionId: 's', _serverRunState: { state: 'attention' } };
  assert.deepEqual(classifyMonitoringReasons(attention, {}), ['attention']);

  // Selection semantics unchanged: the classifier's reasons reproduce the old set.
  const chats = [active, recent, busy, waiting, attention, notQualified, { id: 'x' }];
  const ids = selectMonitoredChatIds(
    chats,
    () => 'a',
    (chat) => (chat.id === 'r' ? 99_999 : 0),
    100_000,
  );
  assert.deepEqual([...ids].sort(), ['a', 'b', 'r', 't', 'w']);

  // The instrumented path (onQualified) must select exactly the same chats.
  const instrumentedIds = selectMonitoredChatIds(
    chats,
    () => 'a',
    (chat) => (chat.id === 'r' ? 99_999 : 0),
    100_000,
    { onQualified: () => {} },
  );
  assert.deepEqual([...instrumentedIds].sort(), [...ids].sort());

  // onQualified reports the same reasons the classifier returns.
  const reported = [];
  selectMonitoredChatIds(
    chats,
    () => 'a',
    (chat) => (chat.id === 'r' ? 99_999 : 0),
    100_000,
    { onQualified: (chat, reasons) => reported.push([chat.id, reasons.join('/')]) },
  );
  assert.deepEqual(reported, [
    ['a', 'active'],
    ['r', 'recent'],
    ['b', 'live/busy'],
    ['w', 'live/waiting'],
    ['t', 'attention'],
  ]);
}

// --- flag-on integration: boot-cache build/write/read are counted and timed ----------
{
  /** @type {Map<string, string>} */
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
    assert.ok(getUiFreezeCounters(), 'flag on → shared meter exists');
    const doc = buildChatLocalBootCache({ chats: [{ id: 'c1' }, { id: 'c2' }] });
    assert.equal(doc.chats.length, 2);
    assert.ok(map.has(CHAT_LOCAL_BOOT_CACHE_KEY) === false, 'build alone does not write');
    readChatLocalBootCache(storage);
    const snap = snapshotUiFreezeCounters();
    assert.ok(snap.counters['cache.builds'] >= 1, 'build counted');
    assert.ok(snap.counters['cache.reads'] >= 1, 'read counted');
    assert.ok(snap.counters['storage.reads'] >= 1, 'storage read counted');
    assert.ok(snap.spans['boot-cache.build'].count >= 1, 'build span recorded');
  } finally {
    __resetUiFreezeCountersForTest();
    __resetUiFreezeTraceActiveCacheForTest();
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
}

// --- flag-off integration: the shared accessor stays null ----------------------------
{
  __resetUiFreezeTraceActiveCacheForTest();
  __resetUiFreezeCountersForTest();
  assert.equal(getUiFreezeCounters(), null, 'flag off → callers skip all counting');
  assert.equal(snapshotUiFreezeCounters(), null);
}

console.log('ui-freeze-counters.test.js OK');
