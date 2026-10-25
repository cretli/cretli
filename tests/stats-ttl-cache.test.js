/**
 * Stats TTL cache (shared by /api/delegations/runtime, /stats and
 * /api/review-loop-stats) and the health endpoint's event-loop lag window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsCacheKey, createStatsTtlCache } from '../lib/stats-ttl-cache.js';
import { EVENT_LOOP_LAG_WINDOW_MS, EVENT_LOOP_SAMPLE_RESOLUTION_MS, readEventLoopLag } from '../lib/routes/health-routes.js';

function fakeClock() {
  let at = 1_000;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

test('a hit inside the TTL reuses the value; after it the value is recomputed', async () => {
  const clock = fakeClock();
  const cache = createStatsTtlCache({ ttlMs: 1500, now: clock.now });
  let calls = 0;
  const compute = () => { calls += 1; return calls; };
  assert.equal(await cache.read('k', compute), 1);
  clock.advance(1000);
  assert.equal(await cache.read('k', compute), 1);
  clock.advance(600);
  assert.equal(await cache.read('k', compute), 2);
});

test('concurrent reads share one in-flight computation', async () => {
  const cache = createStatsTtlCache({ ttlMs: 1500 });
  let calls = 0;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const compute = async () => { calls += 1; await gate; return 'v'; };
  const reads = Array.from({ length: 15 }, () => cache.read('k', compute));
  release();
  assert.deepEqual(await Promise.all(reads), Array(15).fill('v'));
  assert.equal(calls, 1);
});

test('a failed computation is not cached', async () => {
  const cache = createStatsTtlCache({ ttlMs: 1500 });
  await assert.rejects(cache.read('k', () => { throw new Error('store broken'); }), /store broken/);
  assert.equal(await cache.read('k', () => 'ok'), 'ok');
});

test('ttl 0 disables caching and the entry count is bounded', async () => {
  const off = createStatsTtlCache({ ttlMs: 0 });
  let calls = 0;
  await off.read('k', () => { calls += 1; });
  await off.read('k', () => { calls += 1; });
  assert.equal(calls, 2);
  const bounded = createStatsTtlCache({ ttlMs: 1500, maxEntries: 3 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) await bounded.read(key, () => key);
  assert.equal(bounded.size(), 3);
});

test('the cache key separates every scope of the caller', () => {
  const base = { query: { workspaceFolder: '/ws/a' } };
  const keys = new Set([
    buildStatsCacheKey('stats', base),
    buildStatsCacheKey('runtime', base),
    buildStatsCacheKey('stats', { ...base, widgetAccess: { installationId: 'w1' } }),
    buildStatsCacheKey('stats', { ...base, widgetAccess: { installationId: '' } }),
    buildStatsCacheKey('stats', { query: { workspaceFolder: '/ws/b' } }),
    buildStatsCacheKey('stats', { query: { workspaceFolder: '/ws/a', workspaceFile: 'x.code-workspace' } }),
    buildStatsCacheKey('stats', { query: { workspaceFolder: '/ws/a', leafId: 'leaf' } }),
  ]);
  assert.equal(keys.size, 7);
  assert.equal(
    buildStatsCacheKey('stats', { query: { leaf_id: 'leaf', workspaceFolder: '/ws/a' } }),
    buildStatsCacheKey('stats', { query: { workspaceFolder: '/ws/a', leafId: 'leaf' } }),
  );
});

test('event-loop sampling retains the resolution selected by the overhead benchmark', () => {
  assert.equal(EVENT_LOOP_SAMPLE_RESOLUTION_MS, 20);
});

test('event-loop lag is read from a window, not reset by each health poll', () => {
  const first = readEventLoopLag();
  for (const key of ['p50', 'p99', 'max', 'windowMs']) assert.equal(typeof first[key], 'number', key);
  assert.ok([0, EVENT_LOOP_LAG_WINDOW_MS].includes(first.windowMs));
  // A burst of pollers sees the same numbers: reading never resets the sample.
  const burst = Array.from({ length: 5 }, () => readEventLoopLag().max);
  assert.ok(burst.every((max) => max >= first.max));
});
