/**
 * Unit tests for the harness health cache/request-generation guard.
 *
 * These cover the race that let a GET started before the lockout-clearing POST
 * write the stale lockout back into the memoized payload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_HEALTH_CACHE_TTL_MS,
  createHarnessHealthCache,
} from '../app_front/features/harness-health/harnessHealthCache.js';

/** @returns {{ promise: Promise<any>, resolve: Function, reject: Function }} */
function deferred() {
  /** @type {Function} */
  let resolve;
  /** @type {Function} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the controller's queued fetch start (it schedules via a microtask). */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a controller whose GETs are manually resolved, plus a controllable
 * clock so TTL behaviour is deterministic.
 */
function createHarness() {
  /** @type {Array<{ query: object, resolve: Function, reject: Function }>} */
  const calls = [];
  let clock = 1_000;
  const cache = createHarnessHealthCache({
    ttlMs: 60_000,
    now: () => clock,
    rangeQuery: () => ({ from: '2026-01-01', to: '2026-01-07' }),
    fetchHealth: (query) => {
      const entry = deferred();
      calls.push({ query, resolve: entry.resolve, reject: entry.reject });
      return entry.promise;
    },
  });
  return { cache, calls, tick: (ms) => { clock += ms; } };
}

test('default TTL keeps the 60 s card contract', () => {
  assert.equal(HARNESS_HEALTH_CACHE_TTL_MS, 60 * 1000);
});

test('concurrent non-forced loads share one GET', async () => {
  const { cache, calls } = createHarness();
  const a = cache.load(false);
  const b = cache.load(false);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  calls[0].resolve({ ok: true, tag: 'one' });
  await Promise.all([a, b]);
  assert.equal(cache.getCached().tag, 'one');
});

test('a forced load supersedes an in-flight GET instead of reusing it', async () => {
  const { cache, calls } = createHarness();
  const first = cache.load(false);
  const forced = cache.load(true);
  await flush();
  assert.equal(calls.length, 2, 'force must issue its own GET');

  calls[0].resolve({ ok: true, tag: 'stale' });
  const firstResult = await first;
  assert.equal(firstResult, null, 'a superseded success resolves null');
  assert.equal(cache.hasCache(), false, 'the superseded response must not commit');

  calls[1].resolve({ ok: true, tag: 'fresh' });
  await forced;
  assert.equal(cache.getCached().tag, 'fresh');
});

test('a superseded request that fails resolves null instead of raising', async () => {
  const { cache, calls } = createHarness();
  const first = cache.load(false);
  const forced = cache.load(true);
  await flush();

  calls[0].reject(new Error('old GET failed'));
  assert.equal(await first, null, 'the stale failure must be inert');

  calls[1].resolve({ ok: true, tag: 'fresh' });
  await forced;
  assert.equal(cache.getCached().tag, 'fresh');
});

test('a pre-clear GET cannot resurrect the lockout after invalidate + force', async () => {
  const { cache, calls } = createHarness();
  const seed = cache.load(false);
  await flush();
  calls[0].resolve({ ok: true, tag: 'lockout' });
  await seed;
  assert.equal(cache.getCached().tag, 'lockout');

  // The POST cleared the lockout, then a fresh GET was requested.
  cache.invalidate();
  const late = cache.load(false);
  const afterPost = cache.load(true);
  await flush();
  assert.equal(calls.length, 3);

  calls[1].resolve({ ok: true, tag: 'stale-pre-post' });
  await late;
  assert.equal(cache.hasCache(), false, 'stale pre-POST payload must not return');

  calls[2].resolve({ ok: true, tag: 'post-clear' });
  await afterPost;
  assert.equal(cache.getCached().tag, 'post-clear');
});

test('a forced load asks the API client for a fresh (non-deduped) GET', async () => {
  const { cache, calls } = createHarness();
  const normal = cache.load(false);
  await flush();
  assert.notEqual(calls[0].query.fresh, true, 'normal loads must stay dedupable');

  const forced = cache.load(true);
  await flush();
  assert.equal(calls[1].query.fresh, true, 'force must bypass the URL-keyed dedupe at the API layer');

  calls[0].resolve({ ok: true, tag: 'one' });
  calls[1].resolve({ ok: true, tag: 'two' });
  assert.equal(await normal, null, 'the superseded normal load stays inert');
  await forced;
  assert.equal(cache.getCached().tag, 'two');
});

test('a failed forced refresh leaves the invalidated cache empty', async () => {
  const { cache, calls } = createHarness();
  const seed = cache.load(false);
  await flush();
  calls[0].resolve({ ok: true, tag: 'lockout' });
  await seed;

  cache.invalidate();
  const refresh = cache.load(true);
  await flush();
  calls[1].reject(new Error('network down'));
  await assert.rejects(refresh, /network down/);
  assert.equal(cache.hasCache(), false);
  assert.equal(cache.isCacheFresh(), false);
});

test('a non-ok payload is rejected and never cached', async () => {
  const { cache, calls } = createHarness();
  const load = cache.load(true);
  await flush();
  calls[0].resolve({ ok: false, error: 'boom' });
  await assert.rejects(load, /boom/);
  assert.equal(cache.hasCache(), false);
});

test('fresh cache is reused, TTL expiry refetches and invalidate forces a GET', async () => {
  const { cache, calls, tick } = createHarness();
  const first = cache.load(false);
  await flush();
  calls[0].resolve({ ok: true, tag: 'one' });
  await first;

  const reused = await cache.load(false);
  assert.equal(reused.tag, 'one');
  assert.equal(calls.length, 1);

  tick(HARNESS_HEALTH_CACHE_TTL_MS + 1);
  const expired = cache.load(false);
  await flush();
  assert.equal(calls.length, 2);
  calls[1].resolve({ ok: true, tag: 'two' });
  await expired;
  assert.equal(cache.getCached().tag, 'two');

  cache.invalidate();
  assert.equal(cache.hasCache(), false);
  const forced = cache.load(false);
  await flush();
  assert.equal(calls.length, 3);
  calls[2].resolve({ ok: true, tag: 'three' });
  await forced;
  assert.equal(cache.getCached().tag, 'three');
});
