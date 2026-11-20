import assert from 'node:assert/strict';
import { createChatListResumeSync } from '../app_front/features/chat/chatListResumeSync.js';

/**
 * Minimal fake timer harness — captures the scheduled callback so the test
 * decides when the deferred refresh fires.
 */
function createHarness() {
  const timers = [];
  let nextId = 1;
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    const wrapped = (...args) => {
      clearTimeoutFn(id);
      fn(...args);
    };
    timers.push({ id, fn: wrapped, ms });
    return id;
  };
  const clearTimeoutFn = (id) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const refreshCalls = [];
  const sync = createChatListResumeSync({
    refresh: async (query) => {
      refreshCalls.push(query);
      if (query.fail) throw new Error('boom');
    },
    setTimeoutFn,
    clearTimeoutFn,
    deferMs: 1200,
  });
  return { sync, timers, refreshCalls };
}

// Initial page load (visible, never hidden) must not refresh.
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onVisible();
  assert.equal(timers.length, 0, 'no refresh scheduled without a prior hidden phase');
  assert.equal(refreshCalls.length, 0);
  sync.cancel();
}

// hidden -> visible schedules exactly one deferred refresh with skipAutoSelect.
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onHidden();
  sync.onVisible();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1200);
  timers[0].fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(refreshCalls[0], { skipAutoSelect: true });
  sync.cancel();
}

// Repeated visible events coalesce into a single refresh; armed resets after fire.
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onHidden();
  sync.onVisible();
  sync.onVisible();
  sync.onVisible();
  assert.equal(timers.length, 1, 'coalesced into one timer');
  timers[0].fn();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  sync.onVisible();
  assert.equal(timers.length, 0, 'not re-armed until the next hidden phase');
  sync.cancel();
}

// A pending refresh is dropped when a new hidden->visible cycle starts.
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onHidden();
  sync.onVisible();
  sync.onHidden();
  sync.onVisible();
  assert.equal(timers.length, 1, 'previous timer replaced');
  timers[0].fn();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  sync.cancel();
}

// bfcache restore (pageshow persisted=true) refreshes even without a hidden event.
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onPageshow(true);
  assert.equal(timers.length, 1);
  timers[0].fn();
  await Promise.resolve();
  assert.equal(refreshCalls.length, 1);
  sync.onPageshow(false);
  assert.equal(refreshCalls.length, 1, 'plain pageshow is ignored');
  sync.cancel();
}

// Refresh failures are swallowed (background safety net must not throw).
{
  const { sync, timers, refreshCalls } = createHarness();
  sync.onHidden();
  sync.onVisible();
  refreshCalls.push({ fail: true });
  assert.doesNotReject(async () => {
    timers[0].fn();
    await Promise.resolve();
    await Promise.resolve();
  });
  sync.cancel();
}

console.log('chat-list-resume-sync.test.js OK');
