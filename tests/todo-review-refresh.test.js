import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTodoReviewRefresher } from '../app_front/features/todo/todoReviewRefresh.js';
import { resolveReviewBadge } from '../app_front/features/todo/todoReviewBadge.js';

/** Manual timer so debounce is deterministic. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer(fn) { const id = next++; pending.set(id, fn); return id; },
    clearTimer(id) { pending.delete(id); },
    fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()); },
    count: () => pending.size,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a burst of frames collapses into one fetch and the badge changes without a manual refresh', async () => {
  const timers = fakeTimers();
  let item = { review: { code: { state: 'pending' } } };
  let loads = 0;
  const painted = [];
  const refresher = createTodoReviewRefresher({
    load: async () => { loads += 1; return item; },
    apply: (data) => painted.push(resolveReviewBadge(data.review, 'code').state),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  item = { review: { code: { state: 'passed', reviewers: [{ harness: 'h', model: 'm' }] } } };
  refresher.schedule();
  refresher.schedule();
  refresher.schedule();
  assert.equal(timers.count(), 1);
  timers.fire();
  await tick();
  assert.equal(loads, 1);
  assert.deepEqual(painted, ['passed']);
});

test('a frame during an in-flight fetch yields exactly one follow-up fetch', async () => {
  const timers = fakeTimers();
  let release;
  let loads = 0;
  const refresher = createTodoReviewRefresher({
    load: () => { loads += 1; return new Promise((resolve) => { release = () => resolve({ n: loads }); }); },
    apply: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  refresher.schedule();
  timers.fire();
  await tick();
  assert.equal(loads, 1);
  refresher.schedule();
  timers.fire(); // fires while the first fetch is still in flight
  await tick();
  assert.equal(loads, 1, 'no parallel fetch');
  release();
  await tick();
  timers.fire();
  await tick();
  assert.equal(loads, 2, 'one follow-up after the in-flight fetch');
  release();
});

test('a hidden panel schedules nothing and a failed fetch leaves the list untouched', async () => {
  const timers = fakeTimers();
  let active = false;
  let applied = 0;
  const refresher = createTodoReviewRefresher({
    isActive: () => active,
    load: async () => { throw new Error('offline'); },
    apply: () => { applied += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  refresher.schedule();
  assert.equal(timers.count(), 0);
  active = true;
  refresher.schedule();
  timers.fire();
  await tick();
  assert.equal(applied, 0);
});

test('a null load result (workspace switched) is not applied; dispose stops everything', async () => {
  const timers = fakeTimers();
  let applied = 0;
  const refresher = createTodoReviewRefresher({
    load: async () => null,
    apply: () => { applied += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  refresher.schedule();
  timers.fire();
  await tick();
  assert.equal(applied, 0);
  refresher.dispose();
  refresher.schedule();
  assert.equal(timers.count(), 0);
});
