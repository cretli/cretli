import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatListLiveSync } from '../app_front/features/chat/chatListLiveSync.js';

test('requestListDelta: a coalesced burst takes the delta path once and does not run the full refresh', async () => {
  const timers = [];
  let deltas = 0;
  let refreshes = 0;
  const sync = createChatListLiveSync({
    refresh: () => { refreshes += 1; },
    requestListDelta: async () => { deltas += 1; return true; },
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    nowFn: () => 0,
  });
  for (let i = 0; i < 50; i += 1) sync.onChatsChanged({ reason: 'update', chatId: 'c1' });
  timers.at(-1)();
  await new Promise((r) => setImmediate(r));
  assert.equal(deltas, 1);
  assert.equal(refreshes, 0);
});

test('requestListDelta: false or a thrown error falls back to the full refresh', async () => {
  for (const delta of [async () => false, async () => { throw new Error('x'); }]) {
    const timers = [];
    let refreshes = 0;
    const sync = createChatListLiveSync({
      refresh: () => { refreshes += 1; },
      requestListDelta: delta,
      setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
      clearTimeoutFn: () => {},
      nowFn: () => 0,
    });
    sync.onChatsChanged({ reason: 'archive', chatId: 'c1' });
    timers.at(-1)();
    await new Promise((r) => setImmediate(r));
    assert.equal(refreshes, 1);
  }
});
