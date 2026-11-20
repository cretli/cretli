import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerMetrics } from '../lib/server-health/server-metrics.js';

function fixture() {
  let t = 1_000_000;
  const hist = { p50: 2e6, p99: 5e6, max: 9e6, reset() {}, percentile(p) { return p === 50 ? this.p50 : this.p99; }, get max_() { return 0; } };
  const histogram = { enable() {}, disable() {}, reset() {}, percentile: (p) => (p === 50 ? hist.p50 : hist.p99), get max() { return hist.max; } };
  let heap = 100e6;
  let gcCb = null;
  const metrics = createServerMetrics({
    sampleMs: 10_000,
    now: () => t,
    histogram,
    eventLoopUtilization: () => ({ utilization: 0.2, idle: 0, active: 0 }),
    heapUsed: () => heap,
    observeGc: (cb) => { gcCb = cb; return () => {}; },
  });
  return { metrics, hist, tick: (ms) => { t += ms; }, setHeap: (v) => { heap = v; }, gc: (d) => gcCb({ duration: d }) };
}

test('rolling windows summarize delay, ELU, GC, alloc rate and heap', () => {
  const f = fixture();
  f.metrics.start();
  for (let i = 0; i < 6; i += 1) {
    f.tick(10_000);
    f.setHeap(100e6 + (i + 1) * 10e6);
    f.gc(20);
    f.metrics.sample();
  }
  const snap = f.metrics.snapshot();
  assert.deepEqual(Object.keys(snap.windows), ['1m', '5m', '15m']);
  const one = snap.windows['1m'];
  assert.equal(one.samples, 6);
  assert.equal(one.eventLoopDelayMs.p50, 2);
  assert.equal(one.eventLoopDelayMs.p99, 5);
  assert.equal(one.eventLoopDelayMs.max, 9);
  assert.equal(one.elu, 0.2);
  assert.equal(one.gc.count, 6);
  assert.equal(one.gc.totalMs, 120);
  assert.equal(one.allocRateBytesPerSec, 1_000_000);
  assert.equal(one.heapUsedBytes.last, 160e6);
  f.metrics.stop();
});

test('old samples fall out of shorter windows but stay in longer ones', () => {
  const f = fixture();
  f.metrics.start();
  f.tick(10_000);
  f.metrics.sample();
  f.hist.p99 = 80e6;
  f.tick(10_000);
  f.metrics.sample();
  f.hist.p99 = 1e6;
  for (let i = 0; i < 7; i += 1) { f.tick(10_000); f.metrics.sample(); }
  const { windows } = f.metrics.snapshot();
  assert.equal(windows['1m'].eventLoopDelayMs.p99, 1);
  assert.equal(windows['5m'].eventLoopDelayMs.p99, 80);
  f.metrics.stop();
});

test('empty collector reports zero-sample windows and the real collector starts and stops', async () => {
  const f = fixture();
  assert.equal(f.metrics.snapshot().windows['15m'].samples, 0);
  const real = createServerMetrics({ sampleMs: 20 });
  real.start();
  await new Promise((r) => setTimeout(r, 90));
  const snap = real.snapshot();
  assert.ok(snap.windows['1m'].samples >= 1);
  assert.ok(snap.heapUsedBytes > 0);
  real.stop();
});
