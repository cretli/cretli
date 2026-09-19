import assert from 'node:assert/strict';
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
  assert.deepEqual(refreshCalls[0], { skipAutoSelect: true, includeArchived: true });
  sync.cancel();
}

{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onChatsChanged();
  sync.cancel();
  assert.equal(timers.length, 0);
  assert.equal(refreshCalls.length, 0);
}

console.log('chat-list-live-sync.test.js OK');
