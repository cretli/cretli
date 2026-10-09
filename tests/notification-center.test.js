/**
 * In-app notification centre (frontend): store semantics, actionUrl safety,
 * notification-centre sound gating, i18n key parity and the static bell markup.
 *
 * No DOM and no network are used: the store takes its request functions by
 * injection and the markup is inspected as text.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  createNotificationStore,
  formatNotificationRelativeTime,
  normalizeNotificationCenterPreferences,
  resolveNotificationActionUrl,
} from '../app_front/features/notifications/notificationStore.js';
import { createInAppSignalController } from '../app_front/features/pwa/inAppSignals.js';
import { hasUnreadNotificationItems } from '../app_front/features/notifications/notificationCenter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function notificationItem(overrides = {}) {
  return {
    id: overrides.id || 'n1',
    category: overrides.category || 'chat',
    severity: overrides.severity || 'info',
    title: overrides.title || 'Title',
    body: overrides.body || 'Body',
    actionUrl: overrides.actionUrl || '',
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    readAt: overrides.readAt === undefined ? null : overrides.readAt,
    dismissedAt: null,
    fingerprint: overrides.fingerprint || 'fp',
  };
}

/**
 * @param {{ revision?: number, unreadCount?: number, items?: object[] }} [overrides]
 * @returns {object}
 */
function snapshot(overrides = {}) {
  return {
    ok: true,
    revision: overrides.revision === undefined ? 1 : overrides.revision,
    unreadCount: overrides.unreadCount === undefined ? 0 : overrides.unreadCount,
    preferences: overrides.preferences,
    items: overrides.items || [],
  };
}

/** Fake API whose `snapshots` queue feeds `fetchList` (a function is called instead). */
function makeFakeApi() {
  const calls = { fetch: 0, read: [], dismiss: [] };
  const api = {
    calls,
    snapshots: [],
    readImpl: async () => ({ ok: true, revision: 2, changed: true }),
    dismissImpl: async () => ({ ok: true, revision: 3, changed: true }),
    async fetchList() {
      calls.fetch += 1;
      const next = api.snapshots.length ? api.snapshots.shift() : snapshot({ revision: 1, items: [] });
      return typeof next === 'function' ? next() : next;
    },
    async markRead(payload) {
      calls.read.push(payload);
      return api.readImpl(payload);
    },
    async dismiss(payload) {
      calls.dismiss.push(payload);
      return api.dismissImpl(payload);
    },
  };
  return api;
}

/** @returns {object} Player stub recording calls instead of touching device APIs. */
function fakePlayer() {
  const calls = { sound: [] };
  return {
    calls,
    isVibrationSupported: () => false,
    isSoundSupported: () => true,
    vibrate: () => ({ ok: true }),
    playSound: async (options) => {
      calls.sound.push(options || {});
      return { ok: true, reason: '' };
    },
    ensureUnlocked: async () => ({ ok: true }),
    getState: () => ({ soundSupported: true }),
  };
}

test('initial load applies the snapshot and does not fire the sound trigger', async () => {
  const api = makeFakeApi();
  const seen = [];
  api.snapshots.push(snapshot({
    revision: 4,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  const store = createNotificationStore({ api, onNewItems: (info) => seen.push(info) });

  const result = await store.fetchNow();

  assert.equal(result.ok, true);
  assert.equal(result.initial, true);
  assert.deepEqual(seen, [], 'the first snapshot is a baseline, not new signal');
  assert.equal(store.getRevision(), 4);
  assert.equal(store.getUnreadCount(), 2);
  assert.equal(store.getItems().length, 2);
  assert.equal(store.isInitialized(), true);
});

test('a newer revision reports genuine new unread items; stale frames are ignored', async () => {
  const api = makeFakeApi();
  const seen = [];
  api.snapshots.push(snapshot({ revision: 1, unreadCount: 1, items: [notificationItem({ id: 'a' })] }));
  const store = createNotificationStore({ api, onNewItems: (info) => seen.push(info) });
  await store.fetchNow();

  api.snapshots.push(snapshot({
    revision: 2,
    unreadCount: 2,
    items: [
      notificationItem({ id: 'a' }),
      notificationItem({ id: 'b', readAt: '2026-01-01T00:01:00.000Z' }),
      notificationItem({ id: 'c' }),
    ],
  }));
  const applied = await store.handleChangedFrame({ revision: 2, reason: 'publish' });

  assert.equal(applied.ignored, false);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].ids, ['c'], 'a is known and b is already read');
  assert.equal(store.getRevision(), 2);

  const fetchesBefore = api.calls.fetch;
  assert.equal((await store.handleChangedFrame({ revision: 2 })).ignored, true);
  assert.equal((await store.handleChangedFrame({ revision: 1 })).ignored, true);
  assert.equal((await store.handleChangedFrame({})).ignored, true);
  assert.equal(api.calls.fetch, fetchesBefore, 'a non-newer revision must not refetch');
});

test('the unread count follows the server value, not the row count', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({ revision: 1, unreadCount: 7, items: [notificationItem({ id: 'a' })] }));
  const store = createNotificationStore({ api });
  await store.fetchNow();
  assert.equal(store.getUnreadCount(), 7);
});

test('markRead is optimistic and rolls back on a failed request', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 5,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  const store = createNotificationStore({ api });
  await store.fetchNow();

  /** @type {(err: Error) => void} */
  let rejectRequest = () => {};
  api.readImpl = () => new Promise((_resolve, reject) => {
    rejectRequest = reject;
  });

  const pending = store.markRead('a');
  assert.equal(store.getUnreadCount(), 1, 'optimistic decrement');
  assert.ok(store.getItems().find((row) => row.id === 'a').readAt);

  rejectRequest(new Error('http_500'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(store.getUnreadCount(), 2, 'rollback restores the count');
  assert.equal(store.getItems().find((row) => row.id === 'a').readAt, null, 'rollback clears readAt');
});

test('markRead keeps the optimistic state after the server confirms', async () => {
  const api = makeFakeApi();
  const seen = [];
  api.snapshots.push(snapshot({
    revision: 5,
    unreadCount: 1,
    items: [notificationItem({ id: 'a' })],
  }));
  api.readImpl = async () => ({ ok: true, revision: 6, changed: true });
  const store = createNotificationStore({ api, onNewItems: (info) => seen.push(info) });
  await store.fetchNow();

  const result = await store.markRead('a');
  assert.equal(result.ok, true);
  assert.equal(store.getUnreadCount(), 0);
  assert.equal(store.getRevision(), 6);
  assert.deepEqual(seen, [], 'marking as read never triggers the new-item sound');
});

test('read and dismiss never fire the new-item sound', async () => {
  const api = makeFakeApi();
  const seen = [];
  api.snapshots.push(snapshot({
    revision: 1,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  const store = createNotificationStore({ api, onNewItems: (info) => seen.push(info) });
  await store.fetchNow();
  await store.markRead('a');
  await store.dismiss('b');
  assert.deepEqual(seen, []);
});

test('markAllRead is optimistic and rolls back on failure', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 2,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  api.readImpl = async () => { throw new Error('offline'); };
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const result = await store.markAllRead();
  assert.equal(result.ok, false);
  assert.equal(store.getUnreadCount(), 2);
  assert.equal(store.getItems().every((row) => !row.readAt), true);
});

test('an item published during a pending mark-all stays unread and is reported as new', async () => {
  const api = makeFakeApi();
  const seen = [];
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  const c = notificationItem({ id: 'c' });
  let current = snapshot({ revision: 1, unreadCount: 2, items: [a, b] });
  api.fetchList = async () => current;
  /** @type {(value: object) => void} */
  let resolveRead = () => {};
  api.readImpl = () => new Promise((resolve) => { resolveRead = resolve; });
  const store = createNotificationStore({ api, onNewItems: (info) => seen.push(info) });
  await store.fetchNow();
  assert.deepEqual(seen, []);

  const pending = store.markAllRead();
  assert.equal(store.getUnreadCount(), 0, 'the optimistic mark-all clears the badge');

  // The server publishes a brand-new item while the mark-all request is in flight.
  current = snapshot({ revision: 2, unreadCount: 1, items: [c, a, b] });
  store.applySnapshot(current);

  assert.equal(store.getItems().find((row) => row.id === 'c').readAt, null, 'the new row is not masked');
  assert.equal(store.getUnreadCount(), 1, 'the new row counts in the badge');
  assert.equal(seen.length, 1, 'the new row is reported for the sound');
  assert.deepEqual(seen[0].ids, ['c']);
  assert.deepEqual(seen[0].items.map((row) => row.id), ['c']);

  resolveRead({ ok: true, revision: 3, changed: true });
  await pending;
  assert.equal(store.getUnreadCount(), 1, 'the new row is still unread after the mark-all lands');
});

test('the mark-all overlay clears once the server confirms the captured ids', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  const readA = notificationItem({ id: 'a', readAt: '2026-01-01T00:01:00.000Z' });
  const readB = notificationItem({ id: 'b', readAt: '2026-01-01T00:01:00.000Z' });
  let current = snapshot({ revision: 1, unreadCount: 2, items: [a, b] });
  api.fetchList = async () => current;
  api.readImpl = async () => ({ ok: true, revision: 2, changed: true });
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const result = await store.markAllRead();
  assert.equal(result.ok, true);
  current = snapshot({ revision: 3, unreadCount: 0, items: [readA, readB] });
  store.applySnapshot(current);
  assert.equal(store.getUnreadCount(), 0);

  // A later snapshot that reports the captured rows unread again is not masked:
  // that proves the overlay was cleared once the server confirmed the reads.
  current = snapshot({ revision: 4, unreadCount: 2, items: [a, b] });
  store.applySnapshot(current);
  assert.equal(store.getUnreadCount(), 2);
  assert.equal(store.getItems().every((row) => !row.readAt), true);
});

test('the mark-all overlay clears when a captured id disappears server-side', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  const readB = notificationItem({ id: 'b', readAt: '2026-01-01T00:01:00.000Z' });
  let current = snapshot({ revision: 1, unreadCount: 2, items: [a, b] });
  api.fetchList = async () => current;
  api.readImpl = async () => ({ ok: true, revision: 2, changed: true });
  const store = createNotificationStore({ api });
  await store.fetchNow();

  assert.equal((await store.markAllRead()).ok, true);
  // 'a' was dismissed/pruned; 'b' confirms its read.
  current = snapshot({ revision: 3, unreadCount: 0, items: [readB] });
  store.applySnapshot(current);
  assert.equal(store.getItems().some((row) => row.id === 'a'), false);

  // A later snapshot lists 'a' unread again; a leftover overlay would mask it.
  current = snapshot({ revision: 4, unreadCount: 1, items: [a, readB] });
  store.applySnapshot(current);
  assert.equal(store.getUnreadCount(), 1);
  assert.equal(store.getItems().find((row) => row.id === 'a').readAt, null);
});

test('a failed mark-all rolls back fully and leaves no overlay', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  api.fetchList = async () => snapshot({ revision: 1, unreadCount: 2, items: [a, b] });
  api.readImpl = async () => { throw new Error('offline'); };
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const result = await store.markAllRead();
  assert.equal(result.ok, false);
  assert.equal(store.getUnreadCount(), 2);
  assert.equal(store.getItems().every((row) => !row.readAt), true);

  // A snapshot that lists the rows unread must not be masked by a stale overlay.
  store.applySnapshot(snapshot({ revision: 2, unreadCount: 2, items: [a, b] }));
  assert.equal(store.getUnreadCount(), 2);
  assert.equal(store.getItems().every((row) => !row.readAt), true);
});

test('a second mark-all after a pending first one clears the new row', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  const c = notificationItem({ id: 'c' });
  let current = snapshot({ revision: 1, unreadCount: 2, items: [a, b] });
  api.fetchList = async () => current;
  const readCalls = [];
  /** @type {(value: object) => void} */
  let resolveFirst = () => {};
  api.readImpl = (payload) => {
    readCalls.push(payload);
    if (readCalls.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.resolve({ ok: true, revision: 4, changed: true });
  };
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const first = store.markAllRead();
  current = snapshot({ revision: 2, unreadCount: 1, items: [c, a, b] });
  store.applySnapshot(current);
  assert.equal(store.getUnreadCount(), 1, 'only the new row is unread');

  resolveFirst({ ok: true, revision: 3, changed: true });
  await first;

  const second = await store.markAllRead();
  assert.equal(second.ok, true);
  assert.equal(second.changed, true, 'the second mark-all targets the new row');
  assert.equal(store.getUnreadCount(), 0);
  assert.deepEqual(readCalls.at(-1), { all: true });

  current = snapshot({
    revision: 5,
    unreadCount: 0,
    items: [
      notificationItem({ id: 'c', readAt: '2026-01-01T00:02:00.000Z' }),
      notificationItem({ id: 'a', readAt: '2026-01-01T00:02:00.000Z' }),
      notificationItem({ id: 'b', readAt: '2026-01-01T00:02:00.000Z' }),
    ],
  });
  store.applySnapshot(current);
  assert.equal(store.getUnreadCount(), 0);
});

test('a failed dismiss keeps a snapshot applied meanwhile and issues one refetch', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a' });
  const b = notificationItem({ id: 'b' });
  const c = notificationItem({ id: 'c' });
  api.fetchList = async () => {
    api.calls.fetch += 1;
    return snapshot({ revision: 2, unreadCount: 2, items: [a, b] });
  };
  /** @type {(err: Error) => void} */
  let rejectDismiss = () => {};
  api.dismissImpl = () => new Promise((_resolve, reject) => { rejectDismiss = reject; });
  const store = createNotificationStore({ api });
  await store.fetchNow();
  const fetchesBefore = api.calls.fetch;

  const pending = store.dismiss('a');
  assert.equal(store.getItems().some((row) => row.id === 'a'), false, 'optimistic removal');

  // A newer snapshot arrives while the dismiss request is in flight.
  store.applySnapshot(snapshot({ revision: 3, unreadCount: 3, items: [a, b, c] }));
  assert.equal(store.getRevision(), 3, 'the newer snapshot is applied');
  assert.equal(store.getItems().some((row) => row.id === 'c'), true);

  rejectDismiss(new Error('offline'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(store.getRevision(), 3, 'rollback must not restore the old revision');
  assert.equal(store.getItems().some((row) => row.id === 'a'), true, 'the item reappears');
  assert.equal(store.getItems().some((row) => row.id === 'c'), true, 'the newer snapshot is kept');
  assert.equal(api.calls.fetch, fetchesBefore + 1, 'exactly one coalesced refetch is issued');
});

test('reconcile keeps an overlay for a row hidden by the current filter', async () => {
  const api = makeFakeApi();
  const a = notificationItem({ id: 'a', category: 'chat' });
  const b = notificationItem({ id: 'b', category: 'models' });
  const prefsAll = {
    preset: 'all',
    categories: { chat: true, models: true, cli: true, system: true },
    showBadge: true,
    sound: true,
  };
  const prefsChatOff = {
    preset: 'custom',
    categories: { chat: false, models: true, cli: true, system: true },
    showBadge: true,
    sound: true,
  };
  let current = snapshot({ revision: 1, unreadCount: 2, preferences: prefsAll, items: [a, b] });
  api.fetchList = async () => current;
  /** @type {(err: Error) => void} */
  let rejectDismiss = () => {};
  api.dismissImpl = () => new Promise((_resolve, reject) => { rejectDismiss = reject; });
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const pending = store.dismiss('a');
  assert.equal(store.getItems().some((row) => row.id === 'a'), false);

  // 'chat' is filtered out server-side: 'a' is invisible, not known-gone.
  current = snapshot({ revision: 2, unreadCount: 1, preferences: prefsChatOff, items: [b] });
  store.applySnapshot(current);

  // Category back on and the server still lists 'a' unread: the dismiss overlay
  // must survive the filtered snapshot and keep hiding it.
  current = snapshot({ revision: 3, unreadCount: 2, preferences: prefsAll, items: [a, b] });
  store.applySnapshot(current);
  assert.equal(store.getItems().some((row) => row.id === 'a'), false, 'the overlay survived the filtered snapshot');

  rejectDismiss(new Error('offline'));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(store.getItems().some((row) => row.id === 'a'), true, 'rollback reveals the row again');
});

test('dismiss removes the item optimistically and restores it on failure', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 2,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  api.dismissImpl = async () => { throw new Error('network down'); };
  const store = createNotificationStore({ api });
  await store.fetchNow();

  const pending = store.dismiss('a');
  assert.equal(store.getItems().some((row) => row.id === 'a'), false, 'optimistic removal');
  assert.equal(store.getUnreadCount(), 1);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(store.getItems().some((row) => row.id === 'a'), true, 'rollback restores the row');
  assert.equal(store.getUnreadCount(), 2);
});

test('a stale GET started before a dismiss cannot resurrect the dismissed row', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 5,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  const store = createNotificationStore({ api });
  await store.fetchNow();

  let releaseFetch = () => {};
  const staleGate = new Promise((resolve) => { releaseFetch = resolve; });
  api.fetchList = async () => {
    api.calls.fetch += 1;
    await staleGate;
    // Pre-dismiss server state: same revision the client had, row still present.
    return snapshot({
      revision: 5,
      unreadCount: 2,
      items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
    });
  };
  const inFlight = store.fetchNow({ reason: 'frame' });

  api.dismissImpl = async () => ({ ok: true, revision: 6, changed: true });
  const dismissed = await store.dismiss('a');
  assert.equal(dismissed.ok, true);
  assert.equal(store.getItems().some((row) => row.id === 'a'), false, 'optimistic dismiss');

  releaseFetch();
  await inFlight;
  await store.fetchNow();
  assert.equal(store.getItems().some((row) => row.id === 'a'), false, 'stale GET must not resurrect the row');
});

test('a stale GET started before a read keeps the row read', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 5,
    unreadCount: 2,
    items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
  }));
  const store = createNotificationStore({ api });
  await store.fetchNow();

  let releaseFetch = () => {};
  const staleGate = new Promise((resolve) => { releaseFetch = resolve; });
  api.fetchList = async () => {
    api.calls.fetch += 1;
    await staleGate;
    return snapshot({
      revision: 5,
      unreadCount: 2,
      items: [notificationItem({ id: 'a' }), notificationItem({ id: 'b' })],
    });
  };
  const inFlight = store.fetchNow({ reason: 'frame' });

  api.readImpl = async () => ({ ok: true, revision: 6, changed: true });
  const result = await store.markRead('a');
  assert.equal(result.ok, true);
  assert.ok(store.getItems().find((row) => row.id === 'a').readAt, 'optimistic read');

  releaseFetch();
  await inFlight;
  const row = store.getItems().find((row) => row.id === 'a');
  assert.ok(row.readAt, 'stale GET must not clear the optimistic read');
});

test('two frames in quick succession coalesce into one GET plus one follow-up', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({ revision: 1, unreadCount: 1, items: [notificationItem({ id: 'a' })] }));
  const store = createNotificationStore({ api });
  await store.fetchNow();
  const baseFetches = api.calls.fetch;

  const resolvers = [];
  api.fetchList = async () => {
    api.calls.fetch += 1;
    return new Promise((resolve) => { resolvers.push(resolve); });
  };
  const first = store.handleChangedFrame({ revision: 2 });
  const second = store.handleChangedFrame({ revision: 3 });
  const third = store.handleChangedFrame({ revision: 4 });
  assert.equal(api.calls.fetch, baseFetches + 1, 'only one GET is in flight');

  resolvers[0](snapshot({ revision: 4, unreadCount: 0, items: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.calls.fetch, baseFetches + 2, 'requests coalesce into exactly one follow-up');

  resolvers[1](snapshot({ revision: 4, unreadCount: 0, items: [] }));
  await Promise.all([first, second, third]);
  assert.equal(api.calls.fetch, baseFetches + 2, 'no extra GETs');
});

test('a lower-revision frame is ignored but a forced refresh replaces state', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({ revision: 10, unreadCount: 1, items: [notificationItem({ id: 'a' })] }));
  const store = createNotificationStore({ api });
  await store.fetchNow();
  assert.equal(store.getRevision(), 10);

  const frame = await store.handleChangedFrame({ revision: 2 });
  assert.equal(frame.ignored, true, 'a frame older than the applied revision is ignored');

  // Server store reset/corrupt: revision restarts low. A forced full GET must win.
  api.snapshots.push(snapshot({ revision: 2, unreadCount: 1, items: [notificationItem({ id: 'z' })] }));
  await store.fetchNow({ reason: 'reconnect', force: true });
  assert.equal(store.getRevision(), 2);
  assert.equal(store.getItems().some((row) => row.id === 'z'), true, 'forced refresh replaces state');
  assert.equal(store.getItems().some((row) => row.id === 'a'), false);
});

test('applyPreferences normalises the shape and refetches the server-filtered list', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({ revision: 1, unreadCount: 1, items: [notificationItem({ id: 'a' })] }));
  const store = createNotificationStore({ api });
  await store.fetchNow();
  const fetchesBefore = api.calls.fetch;

  const prefs = store.applyPreferences({ preset: 'important', showBadge: false, sound: false });
  assert.equal(prefs.preset, 'important');
  assert.equal(prefs.showBadge, false);
  assert.equal(prefs.sound, false);
  assert.equal(prefs.categories.chat, true, 'missing categories fall back to the defaults');
  assert.equal(api.calls.fetch, fetchesBefore + 1);
});

test('normalizeNotificationCenterPreferences mirrors the server defaults', () => {
  const defaults = normalizeNotificationCenterPreferences(undefined);
  assert.deepEqual(defaults, {
    preset: 'all',
    categories: { chat: true, models: true, cli: true, system: true },
    showBadge: true,
    sound: true,
  });
  const custom = normalizeNotificationCenterPreferences({
    preset: 'custom',
    categories: { chat: false, models: true, cli: false, system: true, bogus: true },
    showBadge: false,
  });
  assert.equal(custom.preset, 'custom');
  assert.deepEqual(custom.categories, { chat: false, models: true, cli: false, system: true });
  assert.equal(custom.showBadge, false);
  assert.equal(custom.sound, true);
});

test('resolveNotificationActionUrl accepts only same-origin relative paths', () => {
  assert.equal(resolveNotificationActionUrl('/?panel=chat'), '/?panel=chat');
  assert.equal(resolveNotificationActionUrl('?panel=settings&tab=interface-notifications'), '?panel=settings&tab=interface-notifications');
  assert.equal(resolveNotificationActionUrl('  /x  '), '/x');
  assert.equal(resolveNotificationActionUrl('https://evil.example/x'), '');
  assert.equal(resolveNotificationActionUrl('http://evil.example'), '');
  assert.equal(resolveNotificationActionUrl('//evil.example/x'), '');
  assert.equal(resolveNotificationActionUrl('javascript:alert(1)'), '');
  assert.equal(resolveNotificationActionUrl('data:text/html,<script></script>'), '');
  assert.equal(resolveNotificationActionUrl('/a\\b'), '');
  assert.equal(resolveNotificationActionUrl('/x\n/y'), '');
  assert.equal(resolveNotificationActionUrl(''), '');
  assert.equal(resolveNotificationActionUrl(null), '');
  assert.equal(resolveNotificationActionUrl(`/${'a'.repeat(3000)}`), '');
});

test('formatNotificationRelativeTime is stable across the minute/hour/day boundaries', () => {
  const key = (value, params) => (params?.count ? `${value}:${params.count}` : value);
  assert.equal(formatNotificationRelativeTime('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:30.000Z'), key), 'notifications.timeJustNow');
  assert.equal(formatNotificationRelativeTime('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:05:00.000Z'), key), 'notifications.timeMinutes:5');
  assert.equal(formatNotificationRelativeTime('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T03:00:00.000Z'), key), 'notifications.timeHours:3');
  assert.equal(formatNotificationRelativeTime('2026-01-01T00:00:00.000Z', Date.parse('2026-01-03T00:00:00.000Z'), key), 'notifications.timeDays:2');
  assert.equal(formatNotificationRelativeTime('nonsense', Date.now(), key), '');
});

test('mark-all eligibility follows unread items when showBadge hides the count', async () => {
  const api = makeFakeApi();
  api.snapshots.push(snapshot({
    revision: 1,
    unreadCount: 3,
    preferences: { preset: 'all', showBadge: false, sound: false, categories: {} },
    items: [notificationItem({ id: 'u1', readAt: null })],
  }));
  const store = createNotificationStore({ api });
  await store.fetchNow();
  assert.equal(store.getUnreadCount(), 0, 'badge count is suppressed when showBadge is false');
  assert.equal(hasUnreadNotificationItems(store.getState()), true, 'mark-all must stay enabled');
  const markResult = await store.markAllRead();
  assert.equal(markResult.ok, true);
  assert.ok(store.getItems()[0].readAt, 'mark-all works while the badge count stays suppressed');
});

test('notification-centre sound respects the sound flag and dedupes item ids', () => {
  const player = fakePlayer();
  const controller = createInAppSignalController({ player, quietHours: null, preferences: {}, broadcastChannel: null });

  const first = controller.handleNotificationItems({ ids: ['a'], soundEnabled: true });
  assert.equal(first.emit, true);
  assert.equal(first.sound, true);
  assert.deepEqual(first.ids, ['a']);
  assert.equal(player.calls.sound.length, 1);

  const duplicate = controller.handleNotificationItems({ ids: ['a'], soundEnabled: true });
  assert.equal(duplicate.emit, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(player.calls.sound.length, 1, 'a repeated id never plays twice');

  const disabled = controller.handleNotificationItems({ ids: ['b'], soundEnabled: false });
  assert.equal(disabled.emit, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(player.calls.sound.length, 1);
});

test('pl and en dictionaries expose the same notification-centre keys', () => {
  for (const key of Object.keys(en.notifications)) {
    assert.equal(typeof pl.notifications[key], 'string', `pl notifications.${key}`);
  }
  for (const key of Object.keys(pl.notifications)) {
    assert.equal(typeof en.notifications[key], 'string', `en notifications.${key}`);
  }
  const enSettingsKeys = Object.keys(en.settings).filter((key) => key.startsWith('notificationCenter')).sort();
  const plSettingsKeys = Object.keys(pl.settings).filter((key) => key.startsWith('notificationCenter')).sort();
  assert.ok(enSettingsKeys.length >= 17, 'every notification-center settings string is translated');
  assert.deepEqual(enSettingsKeys, plSettingsKeys);
});

test('index.html places the bell before the settings button with a badge and a panel', () => {
  const bellIndex = indexHtml.indexOf('id="header-notifications-btn"');
  const settingsIndex = indexHtml.indexOf('id="header-settings-btn"');
  assert.ok(bellIndex > 0, 'the bell button exists');
  assert.ok(settingsIndex > bellIndex, 'the bell must come before the settings button');

  const bellStart = indexHtml.lastIndexOf('<button', bellIndex);
  const bellEnd = indexHtml.indexOf('</button>', bellIndex);
  const bellMarkup = indexHtml.slice(bellStart, bellEnd);
  assert.match(bellMarkup, /class="header-settings-btn header-notifications-btn"/);
  assert.match(bellMarkup, /mdi-bell-outline/);
  assert.match(bellMarkup, /id="header-notifications-badge"[^>]*hidden/);
  assert.match(bellMarkup, /data-i18n-aria="notifications\.bellAria"/);

  assert.ok(indexHtml.includes('id="header-notifications-panel"'), 'the dropdown panel exists');
  assert.ok(indexHtml.includes('id="notifications-list"'));
  assert.ok(indexHtml.includes('id="notifications-empty"'));
  assert.ok(indexHtml.includes('id="notifications-mark-all-btn"'));
  assert.ok(indexHtml.includes('id="notifications-settings-btn"'));
  assert.match(indexHtml, /id="header-notifications-panel"[^>]*role="region"/);
});

test('index.html exposes the notification-centre settings fieldset inside interface-notifications', () => {
  const sectionMatch = indexHtml.match(/<section[^>]*data-settings-tab="interface-notifications"[^>]*>/);
  assert.ok(sectionMatch, 'the notifications section exists');
  const sectionStart = sectionMatch.index;
  const sectionEnd = indexHtml.indexOf('</section>', sectionStart);
  assert.ok(sectionStart > 0 && sectionEnd > sectionStart);
  const section = indexHtml.slice(sectionStart, sectionEnd);
  assert.ok(section.includes('id="notification-center-options"'));
  for (const id of [
    'notification-center-preset',
    'notification-center-category-chat',
    'notification-center-category-models',
    'notification-center-category-cli',
    'notification-center-category-system',
    'notification-center-badge',
    'notification-center-sound',
    'notification-center-mark-all-btn',
    'notification-center-status',
  ]) {
    assert.equal(section.includes(`id="${id}"`), true, `missing #${id} in the notifications settings section`);
  }
});
