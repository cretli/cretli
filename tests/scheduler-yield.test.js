/**
 * Task 4.1 — scheduler.yield helper, macrotask fallback, cancellation, cleanup.
 *
 * Run: node tests/scheduler-yield.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SLICE_BUDGET_MS,
  __resetSchedulerYieldChannelsForTest,
  applyIfFresh,
  applyValueIfFresh,
  cancelDomWrite,
  createDefaultSchedulerYieldDeps,
  createSliceSession,
  forEachInTimeSlices,
  getActiveMessageChannelCountForTest,
  isDocumentHidden,
  isSchedulerYieldSupported,
  resolvePreferredYieldMode,
  scheduleDomWrite,
  yieldToNewTask,
} from '../app_front/lib/schedulerYield.js';

function createControllableDeps(overrides = {}) {
  let clock = 0;
  /** @type {Array<() => void>} */
  const timerQueue = [];
  /** @type {Array<() => void>} */
  const rafQueue = [];
  let schedulerYieldImpl = async () => {};
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close: () => {} };
      this.port2 = {
        postMessage: () => {
          setTimeout(() => {
            if (typeof this.port1.onmessage === 'function') {
              this.port1.onmessage({ data: 0 });
            }
          }, 0);
        },
        close: () => {},
      };
    }
  }
  const deps = {
    now: () => clock,
    scheduler: { yield: () => schedulerYieldImpl() },
    MessageChannel: TestMessageChannel,
    setTimeoutFn: (fn, _ms) => {
      timerQueue.push(fn);
      return timerQueue.length;
    },
    clearTimeoutFn: () => {},
    requestAnimationFrameFn: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrameFn: () => {},
    documentRef: { hidden: false },
    ...overrides,
  };
  return {
    deps,
    advanceTime(ms) {
      clock += ms;
    },
    flushTimers() {
      while (timerQueue.length) {
        const batch = timerQueue.splice(0);
        for (const fn of batch) fn();
      }
    },
    flushRaf() {
      while (rafQueue.length) {
        const batch = rafQueue.splice(0);
        for (const fn of batch) fn();
      }
    },
    setSchedulerYieldImpl(fn) {
      schedulerYieldImpl = fn;
    },
  };
}

test('feature detection uses scheduler.yield function, not user-agent', () => {
  assert.equal(isSchedulerYieldSupported({ scheduler: {} }), false);
  assert.equal(isSchedulerYieldSupported({ scheduler: { yield: async () => {} } }), true);
  assert.equal(resolvePreferredYieldMode({ scheduler: { yield: async () => {} } }), 'scheduler');
  assert.equal(
    resolvePreferredYieldMode({ scheduler: {}, MessageChannel: class {} }),
    'messageChannel',
  );
  assert.equal(resolvePreferredYieldMode({ scheduler: {}, MessageChannel: undefined }), 'setTimeout');
});

test('forced scheduler and messageChannel paths yield identical item order', async () => {
  __resetSchedulerYieldChannelsForTest();
  const items = Array.from({ length: 40 }, (_, i) => i);
  /** @param {'scheduler' | 'messageChannel'} mode */
  async function collectWithMode(mode) {
    const harness = createControllableDeps();
    harness.setSchedulerYieldImpl(async () => {
      harness.flushTimers();
    });
    const out = [];
    await forEachInTimeSlices(items, {
      deps: harness.deps,
      budgetMs: 5,
      forceYieldMode: mode,
      onItem: (n) => {
      harness.advanceTime(6);
      out.push(n);
    },
    });
    harness.flushTimers();
    return out;
  }
  const schedulerOut = await collectWithMode('scheduler');
  const fallbackOut = await collectWithMode('messageChannel');
  assert.deepEqual(schedulerOut, items);
  assert.deepEqual(fallbackOut, items);
  assert.deepEqual(schedulerOut, fallbackOut);
  assert.equal(getActiveMessageChannelCountForTest(), 0);
});

test('macrotask timers run between time slices (not microtask-only)', async () => {
  __resetSchedulerYieldChannelsForTest();
  let clock = 0;
  const deps = {
    ...createDefaultSchedulerYieldDeps(),
    now: () => clock,
  };
  let timerFired = false;
  const seen = [];
  await forEachInTimeSlices(Array.from({ length: 30 }, (_, i) => i), {
    deps,
    budgetMs: 2,
    forceYieldMode: 'setTimeout',
    onItem: (n) => {
      clock += 4;
      if (n === 0) {
        deps.setTimeoutFn(() => {
          timerFired = true;
        }, 0);
      }
      seen.push(n);
    },
  });
  assert.ok(timerFired, 'setTimeout input/timer should run between slice yields');
  assert.equal(seen.length, 30);
});

test('cancelled session prevents stale applyValueIfFresh', async () => {
  const session = createSliceSession();
  const token = session.captureToken();
  /** @type {number[]} */
  const applied = [];
  session.cancel();
  const ran = applyValueIfFresh(session, token, 42, (v) => applied.push(v));
  assert.equal(ran, false);
  assert.deepEqual(applied, []);
});

test('bumped revision prevents stale applyIfFresh after async gap', async () => {
  __resetSchedulerYieldChannelsForTest();
  const harness = createControllableDeps();
  const session = createSliceSession();
  const token = session.captureToken();
  let applied = false;
  const yieldPromise = yieldToNewTask(harness.deps, { forceMode: 'messageChannel' });
  harness.flushTimers();
  await yieldPromise;
  session.bumpRevision();
  applyIfFresh(session, token, () => {
    applied = true;
  });
  assert.equal(applied, false);
  assert.equal(getActiveMessageChannelCountForTest(), 0);
});

test('forEachInTimeSlices stops when session is cancelled mid-run', async () => {
  __resetSchedulerYieldChannelsForTest();
  const harness = createControllableDeps();
  harness.setSchedulerYieldImpl(async () => harness.flushTimers());
  const session = createSliceSession();
  const out = [];
  const promise = forEachInTimeSlices(Array.from({ length: 50 }, (_, i) => i), {
    session,
    deps: harness.deps,
    budgetMs: 2,
    forceYieldMode: 'messageChannel',
    onItem: (n) => {
      out.push(n);
      if (n === 4) session.cancel();
      harness.advanceTime(3);
    },
  });
  const result = await promise;
  assert.ok(out.length < 50, 'cancel should stop further items');
  assert.ok(out.includes(4));
  assert.equal(result.cancelled, true);
});

test('cancel inside a single slice skips remaining items and marks cancelled', async () => {
  const harness = createControllableDeps();
  const session = createSliceSession();
  const applyToken = session.captureToken();
  /** @type {number[]} */
  const seen = [];
  /** @type {number[]} */
  const applied = [];
  const result = await forEachInTimeSlices(Array.from({ length: 20 }, (_, i) => i), {
    session,
    deps: harness.deps,
    budgetMs: 10_000,
    onItem: (n) => {
      seen.push(n);
      applyValueIfFresh(session, applyToken, n, (v) => applied.push(v));
      if (n === 3) session.cancel();
    },
  });
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.deepEqual(applied, [0, 1, 2, 3]);
  assert.equal(result.processed, 4);
  assert.equal(result.cancelled, true);
});

test('bumpRevision inside a single slice skips remaining items and marks cancelled', async () => {
  const harness = createControllableDeps();
  const session = createSliceSession();
  const sliceToken = session.captureToken();
  /** @type {number[]} */
  const seen = [];
  /** @type {number[]} */
  const applied = [];
  const result = await forEachInTimeSlices(Array.from({ length: 20 }, (_, i) => i), {
    session,
    deps: harness.deps,
    budgetMs: 10_000,
    onItem: (n) => {
      seen.push(n);
      applyValueIfFresh(session, sliceToken, n, (v) => applied.push(v));
      if (n === 2) session.bumpRevision();
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(applied, [0, 1, 2]);
  assert.equal(result.processed, 3);
  assert.equal(result.cancelled, true);
});

test('budgetMs zero yields one item per slice without hanging', async () => {
  __resetSchedulerYieldChannelsForTest();
  const harness = createControllableDeps();
  harness.setSchedulerYieldImpl(async () => harness.flushTimers());
  const out = [];
  const result = await forEachInTimeSlices([1, 2, 3, 4, 5], {
    deps: harness.deps,
    budgetMs: 0,
    forceYieldMode: 'messageChannel',
    onItem: (n) => out.push(n),
  });
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(result.processed, 5);
  assert.equal(result.cancelled, false);
});

test('messageChannel yieldToNewTask runs after queued microtasks', async () => {
  __resetSchedulerYieldChannelsForTest();
  /** @type {Array<() => void>} */
  const timerQueue = [];
  class QueuedMessageChannel {
    constructor() {
      this.port1 = { onmessage: null, close: () => {} };
      this.port2 = {
        postMessage: () => {
          timerQueue.push(() => {
            if (typeof this.port1.onmessage === 'function') {
              this.port1.onmessage({ data: 0 });
            }
          });
        },
        close: () => {},
      };
    }
  }
  const deps = {
    ...createDefaultSchedulerYieldDeps(),
    MessageChannel: QueuedMessageChannel,
    setTimeoutFn: (fn, _ms) => {
      timerQueue.push(fn);
      return timerQueue.length;
    },
  };
  /** @type {string[]} */
  const order = [];
  const p = yieldToNewTask(deps, { forceMode: 'messageChannel' }).then(() => {
    order.push('yield-resolved');
  });
  queueMicrotask(() => order.push('microtask'));
  await Promise.resolve();
  assert.deepEqual(order, ['microtask'], 'MessageChannel delivery must not run as microtask');
  while (timerQueue.length) {
    const batch = timerQueue.splice(0);
    for (const fn of batch) fn();
  }
  await p;
  assert.deepEqual(order, ['microtask', 'yield-resolved']);
});

test('hidden document: slices complete via setTimeout without rAF', async () => {
  __resetSchedulerYieldChannelsForTest();
  let clock = 0;
  let rafRan = false;
  const deps = {
    ...createDefaultSchedulerYieldDeps(),
    now: () => clock,
    documentRef: { hidden: true },
    requestAnimationFrameFn: () => {
      rafRan = true;
      return 1;
    },
  };
  assert.equal(isDocumentHidden(deps), true);
  const out = [];
  const result = await forEachInTimeSlices([1, 2, 3, 4, 5], {
    deps,
    budgetMs: 1,
    forceYieldMode: 'setTimeout',
    onItem: (n) => {
      clock += 2;
      out.push(n);
    },
  });
  assert.equal(result.cancelled, false);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(rafRan, false, 'correctness must not depend on rAF in background');
});

test('scheduleDomWrite uses rAF when available', () => {
  const harness = createControllableDeps();
  let wrote = false;
  const id = scheduleDomWrite(() => {
    wrote = true;
  }, harness.deps);
  assert.equal(id, 1);
  assert.equal(wrote, false);
  harness.flushRaf();
  assert.equal(wrote, true);
  cancelDomWrite(id, harness.deps);
});

test('messageChannel cleanup: no active channels after slice run', async () => {
  __resetSchedulerYieldChannelsForTest();
  let clock = 0;
  const deps = {
    ...createDefaultSchedulerYieldDeps(),
    now: () => clock,
  };
  assert.equal(getActiveMessageChannelCountForTest(), 0);
  await forEachInTimeSlices(Array.from({ length: 20 }, (_, i) => i), {
    deps,
    budgetMs: 4,
    forceYieldMode: 'messageChannel',
    onItem: () => {
      clock += 5;
    },
  });
  assert.equal(getActiveMessageChannelCountForTest(), 0);
});

test('return from background: hidden flag toggled, slices still finish via macrotasks', async () => {
  __resetSchedulerYieldChannelsForTest();
  let clock = 0;
  const doc = { hidden: true };
  const deps = {
    ...createDefaultSchedulerYieldDeps(),
    now: () => clock,
    documentRef: doc,
  };
  const out = [];
  await forEachInTimeSlices([10, 20, 30], {
    deps,
    budgetMs: 1,
    forceYieldMode: 'setTimeout',
    onItem: (n) => {
      clock += 2;
      out.push(n);
      if (n === 20) doc.hidden = false;
    },
  });
  assert.deepEqual(out, [10, 20, 30]);
  assert.equal(isDocumentHidden(deps), false);
});

test('default slice budget constant is ~8 ms', () => {
  assert.equal(DEFAULT_SLICE_BUDGET_MS, 8);
});

test('yieldToNewTask setTimeout path resolves after timer flush', async () => {
  const deps = createDefaultSchedulerYieldDeps();
  let settled = false;
  const p = yieldToNewTask(deps, { forceMode: 'setTimeout' }).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'microtask flush must not complete macrotask yield');
  await p;
  assert.equal(settled, true);
});
