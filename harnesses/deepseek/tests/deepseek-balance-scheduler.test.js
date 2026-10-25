import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDeepSeekBalanceScheduler } from '../deepseek-balance.js';

/** Manual timers: nothing fires unless the test calls fire(). */
function createFakeTimers() {
  const live = new Map();
  let nextId = 1;
  const make = (repeat) => (fn) => {
    const id = nextId++;
    live.set(id, { fn, repeat });
    return { id, unref() {} };
  };
  const clear = (handle) => live.delete(handle?.id);
  return {
    timers: { setInterval: make(true), setTimeout: make(false), clearInterval: clear, clearTimeout: clear },
    pending: () => live.size,
    /** Fire every live timer once (one-shot timers are removed after firing). */
    fireAll() {
      for (const [id, entry] of [...live]) {
        if (!entry.repeat) live.delete(id);
        entry.fn();
      }
    },
  };
}

test('stop() cancels the hourly check and the initial 15 s check', () => {
  const fake = createFakeTimers();
  let refreshes = 0;
  const stop = startDeepSeekBalanceScheduler({
    timers: fake.timers,
    readStatus: () => ({ accountId: '', stale: true }),
    refresh: async () => { refreshes += 1; return { ok: true }; },
  });
  assert.equal(fake.pending(), 2, 'interval and initial timeout are armed');
  stop();
  assert.equal(fake.pending(), 0, 'both timers are cleared');
  fake.fireAll();
  assert.equal(refreshes, 0, 'no balance read after stop()');
});

test('a tick that already fired before stop() still reads once; a stale tick after stop() does not', () => {
  const fake = createFakeTimers();
  let refreshes = 0;
  const stop = startDeepSeekBalanceScheduler({
    timers: fake.timers,
    readStatus: () => ({ accountId: '', stale: true }),
    refresh: async () => { refreshes += 1; return { ok: true }; },
  });
  fake.fireAll();
  assert.equal(refreshes, 2, 'running timers read while the scheduler is live');
  stop();
  fake.fireAll();
  assert.equal(refreshes, 2);
});

test('a restart (stop then start) inside the 15 s window yields exactly one initial read', () => {
  const fake = createFakeTimers();
  let refreshes = 0;
  const options = {
    timers: fake.timers,
    readStatus: () => ({ accountId: '', stale: true }),
    refresh: async () => { refreshes += 1; return { ok: true }; },
  };
  const stopFirst = startDeepSeekBalanceScheduler(options);
  stopFirst();
  const stopSecond = startDeepSeekBalanceScheduler(options);
  assert.equal(fake.pending(), 2, 'only the second scheduler is armed');
  stopSecond();
  assert.equal(fake.pending(), 0);
  assert.equal(refreshes, 0);
});
