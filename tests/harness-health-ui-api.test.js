/**
 * Behaviour tests for getHarnessHealth() in app_front/api.js and its wiring
 * through createHarnessHealthCache().
 *
 * The URL-keyed dedupe in dedupeGetJson() outlives the cache's generation
 * guard: a forced load after the lockout-clearing POST used to re-attach to
 * the still in-flight GET that started BEFORE the POST. Its response then
 * committed under the newest seq, resurrecting the stale lockout. A forced
 * (fresh) health load must therefore bypass dedupe and hit the network again,
 * without a cache-buster query (GETs already send cache: 'no-store').
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getHarnessHealth } from '../app_front/api.js';
import { createHarnessHealthCache } from '../app_front/features/harness-health/harnessHealthCache.js';

/**
 * Replaces globalThis.fetch with a stub whose responses resolve on demand.
 * Returns the recorded requests plus a restore() for the finally block.
 */
function stubFetch() {
  const previous = globalThis.fetch;
  /** @type {Array<{ url: string, init: object, respond: Function, fail: Function }>} */
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    let respond;
    let fail;
    const responsePromise = new Promise((resolve, reject) => {
      respond = resolve;
      fail = reject;
    });
    requests.push({
      url: String(url),
      init,
      respond: (payload) => respond({ status: 200, json: async () => payload }),
      fail: (error) => fail(error),
    });
    return responsePromise;
  };
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

test('normal loads of the same health URL share one HTTP fetch (dedupe lock)', async () => {
  const { requests, restore } = stubFetch();
  try {
    const a = getHarnessHealth({ from: '2026-02-01', to: '2026-02-07' });
    const b = getHarnessHealth({ from: '2026-02-01', to: '2026-02-07' });
    assert.equal(requests.length, 1, 'concurrent identical GETs must dedupe');
    requests[0].respond({ ok: true, tag: 'deduped' });
    assert.deepEqual(await a, { ok: true, tag: 'deduped' });
    assert.deepEqual(await b, { ok: true, tag: 'deduped' });
  } finally {
    restore();
  }
});

test('fresh:true bypasses dedupeGetJson and issues a second fetch with the same URL', async () => {
  const { requests, restore } = stubFetch();
  try {
    const preClear = getHarnessHealth({ from: '2026-03-01', to: '2026-03-07' });
    const forced = getHarnessHealth({ from: '2026-03-01', to: '2026-03-07', fresh: true });
    assert.equal(requests.length, 2, 'a fresh request must hit the network, not the in-flight map');
    assert.equal(requests[1].url, requests[0].url, 'no cache-buster: the URL stays byte-identical');
    assert.equal(requests[1].init.cache, 'no-store', 'GETs already bypass the HTTP cache');

    requests[1].respond({ ok: true, tag: 'post-clear' });
    assert.deepEqual(await forced, { ok: true, tag: 'post-clear' });
    requests[0].respond({ ok: true, tag: 'pre-clear' });
    assert.deepEqual(await preClear, { ok: true, tag: 'pre-clear' });
  } finally {
    restore();
  }
});

test('the forced cache load after invalidate+POST never commits the pre-POST payload', async () => {
  const { requests, restore } = stubFetch();
  try {
    const cache = createHarnessHealthCache({
      ttlMs: 60_000,
      now: () => 5_000,
      rangeQuery: () => ({ from: '2026-04-01', to: '2026-04-07' }),
      fetchHealth: ({ from, to, fresh }) => getHarnessHealth({ from, to, fresh }),
    });

    // The first expand starts GET #1. The unlock POST lands and the cache is
    // invalidated while GET #1 is still in flight — the exact review scenario.
    const superseded = cache.load(false);
    cache.invalidate();
    const forced = cache.load(true);
    // The controller schedules fetchHealth in a microtask; let both GETs start.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 2, 'the forced load must issue its own HTTP fetch');

    requests[1].respond({ ok: true, tag: 'post-clear' });
    const data = await forced;
    assert.equal(data.tag, 'post-clear');
    assert.equal(cache.getCached().tag, 'post-clear');

    // The pre-POST response arrives late; it must stay inert for good.
    requests[0].respond({ ok: true, tag: 'stale-lockout' });
    assert.equal(await superseded, null, 'a superseded GET resolves null');
    assert.equal(cache.getCached().tag, 'post-clear', 'the stale lockout can never be re-committed');
  } finally {
    restore();
  }
});
