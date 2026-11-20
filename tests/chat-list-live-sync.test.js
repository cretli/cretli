import assert from 'node:assert/strict';
import { createChatListExplicitReloadGuard } from '../app_front/features/chat/chatListExplicitReload.js';
import { createChatListLiveSync } from '../app_front/features/chat/chatListLiveSync.js';

function createHarness() {
  const timers = [];
  let nextId = 1;
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    const wrapped = () => {
      clearTimeoutFn(id);
      fn();
    };
    timers.push({ id, fn: wrapped, ms });
    return id;
  };
  const clearTimeoutFn = (id) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const refreshCalls = [];
  const sync = createChatListLiveSync({
    refresh: async (query) => {
      refreshCalls.push(query);
    },
    setTimeoutFn,
    clearTimeoutFn,
    debounceMs: 150,
  });
  return { sync, timers, refreshCalls };
}

{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onChatsChanged();
  sync.onChatsChanged();
  sync.onChatsChanged();
  assert.equal(timers.length, 1, 'bulk archive coalesces to one timer');
  assert.equal(timers[0].ms, 150);
  timers[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(refreshCalls[0], { skipAutoSelect: true, includeArchived: false });
  sync.cancel();
}

{
  const { sync, timers, refreshCalls } = createHarness();
  const archiveOpen = { value: true };
  const syncArchived = createChatListLiveSync({
    refresh: async (query) => {
      refreshCalls.push(query);
    },
    shouldIncludeArchived: () => archiveOpen.value,
    setTimeoutFn: (fn, ms) => {
      const id = 99;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeoutFn: () => {},
    debounceMs: 150,
  });
  syncArchived.onChatsChanged();
  timers[timers.length - 1].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls[refreshCalls.length - 1].includeArchived, true);
  syncArchived.cancel();
}

{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onChatsChanged();
  sync.cancel();
  assert.equal(timers.length, 0);
  assert.equal(refreshCalls.length, 0);
}

{
  // reason:'title' notifies the title hook (once per frame) and still reloads the list once
  const titleCalls = [];
  const timers = [];
  const refreshCalls = [];
  const sync = createChatListLiveSync({
    refresh: async (query) => { refreshCalls.push(query); },
    onTitleChanged: (chatId) => titleCalls.push(chatId),
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  sync.onChatsChanged({ type: 'chatsChanged', reason: 'title', chatId: 'c1' });
  sync.onChatsChanged({ type: 'chatsChanged', reason: 'archive', chatId: 'c2' });
  sync.onChatsChanged();
  assert.deepEqual(titleCalls, ['c1']);
  timers[timers.length - 1]();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);

  // a throwing hook never blocks the list reload
  const throwing = createChatListLiveSync({
    refresh: async (query) => { refreshCalls.push(query); },
    onTitleChanged: () => { throw new Error('boom'); },
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
  });
  const before = timers.length;
  throwing.onChatsChanged({ reason: 'title', chatId: 'c1' });
  assert.equal(timers.length, before + 1);
}

/**
 * Fake clock + fake timers so the debounce window (`maxWaitMs`) can be asserted against
 * a continuous frame stream, which a trailing-only debounce would postpone forever.
 */
function createClockHarness(options = {}) {
  const clock = { now: 0 };
  /** @type {Map<number, { fn: () => void, at: number }>} */
  const timers = new Map();
  let nextTimerId = 1;
  const calls = {
    refresh: [],
    titlePatched: [],
    titleChanged: [],
    watcherChanged: 0,
  };
  const sync = createChatListLiveSync({
    refresh: async (query) => { calls.refresh.push({ at: clock.now, query }); },
    shouldIncludeArchived: () => false,
    onTitleChanged: (chatId) => calls.titleChanged.push(chatId),
    onWatcherChanged: () => { calls.watcherChanged += 1; },
    onTitlePatched: (chatId, title, titleSource) => {
      calls.titlePatched.push({ chatId, title, titleSource });
      return options.titlePatchResult !== false;
    },
    setTimeoutFn: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
    nowFn: () => clock.now,
    debounceMs: options.debounceMs ?? 150,
    maxWaitMs: options.maxWaitMs ?? 600,
  });
  /** Run every timer due before `clock.now + ms`, in chronological order. */
  async function advance(ms) {
    const target = clock.now + ms;
    for (;;) {
      let due = null;
      for (const entry of timers) {
        if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    clock.now = target;
    await Promise.resolve();
    await Promise.resolve();
  }
  return { sync, calls, timers, clock, advance };
}

{
  // The watcher rewrites its own row, never the chat list. Chats it creates or pins
  // broadcast a separate `create` frame, so a watcher frame must not trigger a reload.
  const h = createClockHarness();
  h.sync.onChatsChanged({ type: 'chatsChanged', reason: 'workspace-watcher', chatId: null });
  assert.equal(h.calls.watcherChanged, 1, 'watcher panels still get their hook');
  assert.equal(h.timers.size, 0, 'a watcher frame schedules no list reload');
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 0, 'GET /api/chats is never issued for a watcher frame');
  h.sync.cancel();
}

{
  // A title frame carrying the new title + titleSource patches one row in place.
  const h = createClockHarness();
  h.sync.onChatsChanged({
    type: 'chatsChanged',
    reason: 'title',
    chatId: 'c1',
    title: 'Fix login bug',
    titleSource: 'auto',
  });
  assert.deepEqual(h.calls.titlePatched, [{ chatId: 'c1', title: 'Fix login bug', titleSource: 'auto' }]);
  assert.deepEqual(h.calls.titleChanged, ['c1'], 'the settings-modal title hook still fires');
  assert.equal(h.timers.size, 0, 'a patched title schedules no list reload');
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 0, 'a titled frame with content never asks GET /api/chats');
  h.sync.cancel();
}

{
  // Backward compatibility: an older server sends the reason only, so the list must reload.
  const h = createClockHarness();
  h.sync.onChatsChanged({ type: 'chatsChanged', reason: 'title', chatId: 'c1' });
  assert.deepEqual(h.calls.titlePatched, [], 'no patch without frame content');
  assert.equal(h.timers.size, 1);
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 1, 'a bare title frame still reloads the list');
  h.sync.cancel();
}

{
  // A title frame for a row the client does not have (other workspace, list not loaded
  // yet) cannot be patched, so it must fall back to the reload instead of dropping it.
  const h = createClockHarness({ titlePatchResult: false });
  h.sync.onChatsChanged({
    type: 'chatsChanged',
    reason: 'title',
    chatId: 'c1',
    title: 'Fix login bug',
    titleSource: 'manual',
  });
  assert.equal(h.calls.titlePatched.length, 1);
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 1, 'a refused patch falls back to a full reload');
  h.sync.cancel();
}

{
  // Every structural reason (and an unknown one) keeps the safe full-reload default.
  for (const reason of ['create', 'delete', 'nest', 'archive', 'restore', 'update', '']) {
    const h = createClockHarness();
    h.sync.onChatsChanged({ type: 'chatsChanged', reason, chatId: 'c1' });
    assert.equal(h.timers.size, 1, `reason:${reason || 'none'} schedules one reload`);
    await h.advance(5000);
    assert.equal(h.calls.refresh.length, 1, `reason:${reason || 'none'} reloads the list`);
    h.sync.cancel();
  }
}

{
  // maxWait: frames arriving faster than the debounce must not postpone the refresh forever.
  const h = createClockHarness({ debounceMs: 150, maxWaitMs: 600 });
  h.sync.onChatsChanged({ reason: 'create', chatId: 'c1' });
  for (let i = 2; i <= 9; i += 1) {
    await h.advance(100);
    h.sync.onChatsChanged({ reason: 'create', chatId: `c${i}` });
  }
  assert.ok(h.calls.refresh.length >= 1, 'maxWait forces the reload under a continuous stream');
  assert.ok(h.calls.refresh[0].at <= 600, `refresh fired at ${h.calls.refresh[0].at}ms <= maxWait 600ms`);
  // Once the stream stops the window restarts and the trailing frames still coalesce.
  await h.advance(5000);
  assert.ok(h.calls.refresh.length >= 2, 'frames after the forced refresh are still synced');
  assert.ok(h.calls.refresh.length <= 3, `a 9-frame stream coalesces, got ${h.calls.refresh.length} reloads`);
  h.sync.cancel();
}

{
  // maxWait never makes the quiet case slower than the debounce.
  const h = createClockHarness({ debounceMs: 150, maxWaitMs: 600 });
  h.sync.onChatsChanged({ reason: 'create', chatId: 'c1' });
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 1);
  assert.equal(h.calls.refresh[0].at, 150, 'a lone frame still waits exactly the debounce');
  h.sync.cancel();
}

{
  const guard = createChatListExplicitReloadGuard();
  const h = createClockHarness();
  const syncWithGuard = createChatListLiveSync({
    refresh: async (query) => { h.calls.refresh.push({ at: h.clock.now, query }); },
    shouldSuppressChatsChanged: (frame) => guard.shouldSuppressChatsChanged(frame),
    setTimeoutFn: (fn, ms) => {
      const id = 1;
      h.timers.set(id, { fn, at: h.clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeoutFn: (id) => { h.timers.delete(id); },
    nowFn: () => h.clock.now,
    debounceMs: 150,
    maxWaitMs: 600,
  });
  guard.begin(['c-archive']);
  syncWithGuard.onChatsChanged({ reason: 'archive', chatId: 'c-archive' });
  assert.equal(h.timers.size, 0, 'explicit reload suppresses archive echo');
  syncWithGuard.onChatsChanged({ reason: 'restore', chatId: 'c-other' });
  assert.equal(h.timers.size, 1, 'restore for another chat still reloads');
  guard.end(['c-archive']);
  h.sync.cancel();
}

{
  // cancel() closes the max-wait window too: a later frame restarts a full window.
  const h = createClockHarness({ debounceMs: 150, maxWaitMs: 200 });
  h.sync.onChatsChanged({ reason: 'create', chatId: 'c1' });
  await h.advance(100);
  h.sync.cancel();
  assert.equal(h.timers.size, 0, 'cancel clears the pending timer');
  h.sync.onChatsChanged({ reason: 'create', chatId: 'c2' });
  assert.equal(h.calls.refresh.length, 0);
  await h.advance(5000);
  assert.equal(h.calls.refresh.length, 1);
  assert.equal(h.calls.refresh[0].at, 250, 'the window restarts after cancel');
  h.sync.cancel();
}

console.log('chat-list-live-sync.test.js OK');
