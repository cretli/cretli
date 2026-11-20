import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeriodicJobRunner } from '../lib/periodic-job-runner.js';

/** Fake timers: manual control of boot timeouts and intervals. */
function fakeClock() {
  let time = Date.parse('2026-01-01T00:00:00Z');
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => time,
    setTimeoutFn: (fn) => { const id = nextId++; timeouts.set(id, fn); return id; },
    clearTimeoutFn: (id) => timeouts.delete(id),
    setIntervalFn: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearIntervalFn: (id) => intervals.delete(id),
    fireBoot() { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } },
    tick(ms = 0) { time += ms; for (const { fn } of [...intervals.values()]) fn(); },
    counts: () => ({ timeouts: timeouts.size, intervals: intervals.size }),
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const makeJob = (over = {}) => ({
  id: 'j', label: 'Job', intervalMs: 1000, settingKey: 'k', isEnabled: () => true, run: () => ({ ok: 1 }), ...over,
});

test('boot run at t=0 then every interval; records last result', async () => {
  const clock = fakeClock();
  let runs = 0;
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob({ run: () => { runs += 1; return { archived: runs, scanned: 3 }; } }));
  runner.start();
  assert.equal(runs, 0);
  clock.fireBoot(); await flush();
  assert.equal(runs, 1);
  clock.tick(1000); await flush();
  clock.tick(1000); await flush();
  assert.equal(runs, 3);
  const [row] = runner.getJobsStatus();
  assert.deepEqual(Object.keys(row).sort(), ['enabled', 'id', 'intervalMs', 'label', 'lastDurationMs', 'lastError', 'lastResult', 'lastRunAt', 'maxDurationMs', 'running', 'runs', 'settingKey', 'skipped']);
  assert.deepEqual(row.lastResult, { archived: 3, scanned: 3 });
  assert.equal(row.lastError, null);
  assert.ok(row.lastRunAt);
});

test('runOnStart:false schedules no boot run', async () => {
  const clock = fakeClock();
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob({ runOnStart: false }));
  runner.start();
  assert.deepEqual(clock.counts(), { timeouts: 0, intervals: 1 });
});

test('a tick is skipped while the previous run is in flight', async () => {
  const clock = fakeClock();
  let release;
  let runs = 0;
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob({ run: () => { runs += 1; return new Promise((r) => { release = r; }); } }));
  runner.start();
  clock.tick(1000);
  clock.tick(1000);
  await flush();
  assert.equal(runs, 1);
  assert.equal(runner.getJobsStatus()[0].running, true);
  assert.equal(runner.getJobsStatus()[0].skipped, 1);
  release({ done: true }); await flush();
  assert.equal(runner.getJobsStatus()[0].running, false);
  clock.tick(1000); await flush();
  assert.equal(runs, 2);
});

test('throwing and rejecting runs are caught; the next tick still runs', async () => {
  const clock = fakeClock();
  let runs = 0;
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob({
    run: () => {
      runs += 1;
      if (runs === 1) throw new Error('boom');
      if (runs === 2) return Promise.reject(new Error('rejected'));
      return { fine: true };
    },
  }));
  runner.start();
  clock.tick(1000); await flush();
  assert.equal(runner.getJobsStatus()[0].lastError, 'boom');
  clock.tick(1000); await flush();
  assert.equal(runner.getJobsStatus()[0].lastError, 'rejected');
  clock.tick(1000); await flush();
  assert.equal(runs, 3);
  assert.equal(runner.getJobsStatus()[0].lastError, null);
  assert.deepEqual(runner.getJobsStatus()[0].lastResult, { fine: true });
});

test('a disabled job never calls run and reports enabled:false', async () => {
  const clock = fakeClock();
  let runs = 0;
  let enabled = false;
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob({ isEnabled: () => enabled, run: () => { runs += 1; } }));
  runner.start();
  clock.fireBoot(); clock.tick(1000); await flush();
  assert.equal(runs, 0);
  assert.equal(runner.getJobsStatus()[0].enabled, false);
  enabled = true;
  clock.tick(1000); await flush();
  assert.equal(runs, 1);
  assert.equal(runner.getJobsStatus()[0].enabled, true);
});

test('start/stop are idempotent and stop leaves no timers', () => {
  const clock = fakeClock();
  const runner = createPeriodicJobRunner(clock);
  runner.register(makeJob());
  runner.start(); runner.start();
  assert.deepEqual(clock.counts(), { timeouts: 1, intervals: 1 });
  runner.stop(); runner.stop();
  assert.deepEqual(clock.counts(), { timeouts: 0, intervals: 0 });
});

test('runNow runs a known job and reports unknown ids', async () => {
  const runner = createPeriodicJobRunner(fakeClock());
  runner.register(makeJob());
  assert.equal(await runner.runNow('j'), true);
  assert.equal(await runner.runNow('nope'), false);
  assert.deepEqual(runner.getJobsStatus()[0].lastResult, { ok: 1 });
});

test('records per-run duration and jitter delays the first run', async () => {
  const clock = fakeClock();
  const delays = [];
  const runner = createPeriodicJobRunner({
    ...clock,
    random: () => 0.5,
    setTimeoutFn: (fn, ms) => { delays.push(ms); return clock.setTimeoutFn(fn); },
  });
  runner.register(makeJob({ jitterMs: 400, run: () => { clock.tick(0); return 1; } }));
  runner.start();
  assert.deepEqual(delays, [200]);
  assert.equal(clock.counts().intervals, 0);
  clock.fireBoot(); await flush();
  assert.equal(clock.counts().intervals, 1);
  const [row] = runner.getJobsStatus();
  assert.equal(row.runs, 1);
  assert.equal(typeof row.lastDurationMs, 'number');
});

test('external job timings record runs and skips', async () => {
  const m = await import('../lib/periodic-job-runner.js');
  m.resetExternalJobTimings();
  m.timeJob('x', () => 1);
  m.recordJobTiming('x', { durationMs: 0, skipped: true });
  const [row] = m.getExternalJobTimings();
  assert.equal(row.runs, 1);
  assert.equal(row.skipped, 1);
});

test('production auto-archive job declares jitter; random 0 keeps boot run immediate', async () => {
  const { chatAutoArchiveJob } = await import('../lib/chat-auto-archive-worker.js');
  assert.ok(chatAutoArchiveJob.jitterMs > 0);
  const clock = fakeClock();
  const delays = [];
  const runner = createPeriodicJobRunner({ ...clock, random: () => 0, setTimeoutFn: (fn, ms) => { delays.push(ms); return clock.setTimeoutFn(fn); } });
  runner.register({ ...chatAutoArchiveJob, isEnabled: () => false });
  runner.start();
  assert.deepEqual(delays, [0]);
});
