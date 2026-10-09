/**
 * OpenRouter endpoint pricing cache: durable last-good copy, bounded refresh,
 * stale-while-revalidate and a purely local synchronous read path.
 * No real network: every fetch is injected.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  OPENROUTER_PRICING_CACHE_FILE_NAME,
  getOpenRouterEndpointPricing,
  listOpenRouterPricingModels,
  peekOpenRouterPricingCache,
  readOpenRouterPricingCache,
  resetOpenRouterPricingCacheMemory,
  writeOpenRouterPricingCache,
} from '../lib/openrouter/openrouter-pricing-cache.js';
import {
  OPENROUTER_MODELS_CACHE_TTL_MS,
  invalidateOpenRouterModelsCache,
  listOpenRouterModels,
  whenOpenRouterModelsRefreshSettles,
} from '../lib/openrouter/openrouter-models.js';
import { registerOpenRouterRoutes } from '../lib/routes/openrouter-routes.js';

const TEST_KEY = 'sk-or-v1-testkey123456';
const CACHE_PATH = path.join(ISOLATED_DATA_DIR, OPENROUTER_PRICING_CACHE_FILE_NAME);

/** Fixture rows mirror the OpenRouter GET /api/v1/models pricing shape (USD per token strings). */
const FIXTURE_MODELS = [
  {
    id: 'openrouter/alpha',
    name: 'Alpha',
    pricing: {
      prompt: '0.0000025',
      completion: '0.00001',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0.000001',
    },
  },
  {
    id: 'openrouter/beta',
    name: 'Beta',
    pricing: { prompt: '0.000001', completion: '0.000004' },
  },
];

/**
 * @param {Array<{ id: string, name: string, pricing?: object }>} models
 * @returns {{ ok: true, json: () => Promise<{ data: Array<object> }> }}
 */
function okJson(models) {
  return {
    ok: true,
    async json() {
      return { data: models };
    },
  };
}

/**
 * Drops both the in-memory cache and the persisted file between tests.
 */
function resetCaches() {
  resetOpenRouterPricingCacheMemory();
  invalidateOpenRouterModelsCache();
  try {
    fs.rmSync(CACHE_PATH, { force: true });
  } catch {
    // ignore
  }
}

/**
 * @param {{ now?: number }} [options]
 */
function seedCache(options = {}) {
  writeOpenRouterPricingCache(FIXTURE_MODELS, options);
}

/**
 * @param {() => Promise<void>} fn
 */
async function withEnvKey(fn) {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = TEST_KEY;
  try {
    await fn();
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
}

test('preserves the full OpenRouter pricing object on catalog rows', async () => {
  await withEnvKey(async () => {
    resetCaches();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => okJson(FIXTURE_MODELS);
    try {
      const listed = await listOpenRouterModels({});
      const alpha = listed.models.find((row) => row.id === 'openrouter/alpha');
      assert.ok(alpha, 'alpha row present');
      assert.deepEqual(alpha.pricing, FIXTURE_MODELS[0].pricing);
      assert.equal(listed.stale, false);
      assert.equal(typeof listed.fetchedAt, 'string');
      assert.equal(listed.modelsSource, 'live');
      // Additive shape: the legacy fields are untouched.
      assert.equal(Array.isArray(listed.catalog), true);
      assert.equal(listed.fromCache, false);
      assert.equal(listed.warning, '');
      assert.equal(fs.existsSync(CACHE_PATH), true, 'last-good copy persisted');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('persisted last-good copy survives a simulated restart', async () => {
  resetCaches();
  const fixedMs = Date.parse('2026-10-08T12:00:00.000Z');
  seedCache({ now: fixedMs });
  assert.equal(fs.existsSync(CACHE_PATH), true);

  // Simulate a process restart: drop memory, keep the data-dir file.
  resetOpenRouterPricingCacheMemory();
  const entry = readOpenRouterPricingCache({ dataDir: ISOLATED_DATA_DIR });
  assert.ok(entry, 'entry loaded from disk');
  assert.equal(entry.fetched_at, '2026-10-08T12:00:00.000Z');
  assert.deepEqual(entry.models, FIXTURE_MODELS);
  assert.equal(entry.source, 'openrouter-catalog');
  assert.equal(entry.source_class, 'endpoint_catalog');
  assert.equal(entry.source_version.length > 0, true);
  assert.equal(entry.attribution.length > 0, true);
});

test('serves the last good copy when live returns 429/5xx and never an empty list', async () => {
  await withEnvKey(async () => {
    for (const status of [429, 500, 503]) {
      resetCaches();
      seedCache();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: false, status, async json() { return {}; } });
      try {
        const listed = await listOpenRouterModels({ refresh: true });
        assert.equal(listed.models.length, FIXTURE_MODELS.length, `models kept on ${status}`);
        assert.equal(listed.stale, true, `stale flagged on ${status}`);
        assert.equal(listed.modelsSource, 'stale', `stale source on ${status}`);
        assert.match(listed.warning, new RegExp(String(status)), `warning names ${status}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
});

test('serves the last good copy when the network throws', async () => {
  await withEnvKey(async () => {
    resetCaches();
    seedCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNRESET');
    };
    try {
      const listed = await listOpenRouterModels({ refresh: true });
      assert.equal(listed.models.length, FIXTURE_MODELS.length);
      assert.equal(listed.stale, true);
      assert.match(listed.warning, /ECONNRESET/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('serves the last good copy when live returns an empty list', async () => {
  await withEnvKey(async () => {
    resetCaches();
    seedCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => okJson([]);
    try {
      const listed = await listOpenRouterModels({ refresh: true });
      assert.equal(listed.models.length, FIXTURE_MODELS.length);
      assert.equal(listed.stale, true);
      assert.match(listed.warning, /empty/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('a hanging refresh is bounded by the timeout and still serves the last good copy', async () => {
  await withEnvKey(async () => {
    resetCaches();
    seedCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      // A ref'd timer keeps the event loop alive in the test while the abort
      // signal (whose own timeout timer is unref'd) is the real bound.
      const keepAlive = setTimeout(() => reject(new Error('fetch never resolved')), 5000);
      const signal = init?.signal;
      const fail = () => {
        clearTimeout(keepAlive);
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
    try {
      const started = Date.now();
      const listed = await listOpenRouterModels({ refresh: true, timeoutMs: 80 });
      const elapsed = Date.now() - started;
      assert.equal(listed.models.length, FIXTURE_MODELS.length);
      assert.equal(listed.stale, true);
      assert.ok(elapsed < 3000, `bounded refresh (elapsed ${elapsed}ms)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('stale-while-revalidate returns stale immediately without blocking on refresh', async () => {
  await withEnvKey(async () => {
    resetCaches();
    seedCache({ now: Date.now() - OPENROUTER_MODELS_CACHE_TTL_MS - 1000 });
    const originalFetch = globalThis.fetch;
    let fetchSettled = false;
    /** @type {(() => void)|null} */
    let releaseFetch = null;
    globalThis.fetch = () => new Promise((resolve) => {
      releaseFetch = () => {
        fetchSettled = true;
        resolve(okJson([]));
      };
    });
    try {
      const listed = await listOpenRouterModels({ timeoutMs: 60_000 });
      assert.equal(fetchSettled, false, 'consumer returned while refresh was still in flight');
      assert.equal(listed.models.length, FIXTURE_MODELS.length);
      assert.equal(listed.stale, true);
      assert.equal(listed.modelsSource, 'stale');
      assert.ok(releaseFetch);
      releaseFetch();
      await whenOpenRouterModelsRefreshSettles();
      // The empty background refresh must not wipe the last good copy.
      const after = readOpenRouterPricingCache({ dataDir: ISOLATED_DATA_DIR });
      assert.equal(after.models.length, FIXTURE_MODELS.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('local pricing read is synchronous and performs no fetch', async () => {
  resetCaches();
  seedCache();
  // Drop memory so the read must resolve the persisted copy, still without network.
  resetOpenRouterPricingCacheMemory();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network forbidden on local pricing read');
  };
  try {
    const value = getOpenRouterEndpointPricing('openrouter/alpha', { dataDir: ISOLATED_DATA_DIR });
    assert.ok(value);
    assert.equal(typeof value.then, 'undefined', 'getter is synchronous');
    assert.equal(value.pricing.prompt, '0.0000025');
    assert.equal(fetchCalls, 0);
    const listed = listOpenRouterPricingModels({ dataDir: ISOLATED_DATA_DIR });
    assert.equal(listed.length, FIXTURE_MODELS.length);
    assert.equal(fetchCalls, 0);
    const entry = readOpenRouterPricingCache({ dataDir: ISOLATED_DATA_DIR });
    assert.ok(entry);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local pricing lookup is exact-match and case-sensitive', () => {
  resetCaches();
  seedCache();
  assert.ok(getOpenRouterEndpointPricing('openrouter/alpha', { dataDir: ISOLATED_DATA_DIR }));
  assert.ok(getOpenRouterEndpointPricing('openrouter/beta', { dataDir: ISOLATED_DATA_DIR }));
  // Near misses must not join by substring, prefix or case folding.
  assert.equal(getOpenRouterEndpointPricing('openrouter', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.equal(getOpenRouterEndpointPricing('alpha', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.equal(getOpenRouterEndpointPricing('openrouter/alph', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.equal(getOpenRouterEndpointPricing('OPENROUTER/ALPHA', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.equal(getOpenRouterEndpointPricing('openrouter/alpha/extra', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.equal(getOpenRouterEndpointPricing('', { dataDir: ISOLATED_DATA_DIR }), null);
});

test('every pricing value carries source/time/kind provenance and attribution', () => {
  resetCaches();
  const fixedMs = Date.parse('2026-05-01T08:30:00.000Z');
  seedCache({ now: fixedMs });
  const value = getOpenRouterEndpointPricing('openrouter/alpha', { dataDir: ISOLATED_DATA_DIR });
  assert.ok(value);
  assert.equal(value.source, 'openrouter-catalog');
  assert.equal(value.source_class, 'endpoint_catalog');
  assert.equal(value.kind, 'estimate');
  assert.equal(value.metric, 'usd');
  assert.equal(value.billing_class, 'api_metered');
  assert.equal(value.source_version, readOpenRouterPricingCache().source_version);
  assert.equal(value.fetched_at, '2026-05-01T08:30:00.000Z');
  assert.equal(value.observed_at, '2026-05-01T08:30:00.000Z');
  assert.match(value.attribution, /endpoint/i);
  assert.match(value.attribution, /not a subscription/i);
});

test('missing key with a last good copy still serves offline instead of an empty list', async () => {
  resetCaches();
  seedCache({ now: Date.now() - OPENROUTER_MODELS_CACHE_TTL_MS - 1000 });
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const listed = await listOpenRouterModels({});
    assert.equal(listed.models.length, FIXTURE_MODELS.length);
    assert.equal(listed.stale, true);
    assert.match(listed.warning, /API key/i);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('no cache and no live data returns the empty fallback, not a throw', async () => {
  resetCaches();
  const entry = readOpenRouterPricingCache({ dataDir: ISOLATED_DATA_DIR });
  assert.equal(entry, null);
  assert.equal(getOpenRouterEndpointPricing('openrouter/alpha', { dataDir: ISOLATED_DATA_DIR }), null);
  assert.deepEqual(listOpenRouterPricingModels({ dataDir: ISOLATED_DATA_DIR }), []);
  assert.equal(peekOpenRouterPricingCache({ dataDir: ISOLATED_DATA_DIR }), null);
});

test('GET /api/openrouter/models exposes stale marker and keeps pricing', async () => {
  await withEnvKey(async () => {
    resetCaches();
    seedCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('openrouter.ai')) {
        return { ok: false, status: 503, async json() { return {}; } };
      }
      return originalFetch(input, init);
    };
    const app = express();
    registerOpenRouterRoutes(app);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/openrouter/models?refresh=1`;
      const res = await originalFetch(base);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.stale, true);
      assert.equal(body.modelsSource, 'stale');
      assert.match(body.warning, /503/);
      assert.equal(body.models[0].pricing.prompt, '0.0000025');
      assert.equal(typeof body.catalogFetchedAt, 'string');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      globalThis.fetch = originalFetch;
    }
  });
});

removeIsolatedDataDir();
console.log('openrouter-pricing-cache.test.js OK');
