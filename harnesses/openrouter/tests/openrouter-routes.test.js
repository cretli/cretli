/**
 * OpenRouter plugin HTTP routes (GET /api/openrouter/models): cache and stale
 * markers on top of the core client. No real network: fetch is stubbed.
 */
import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from '../../../tests/helpers/isolated-data-dir.js';
import {
  OPENROUTER_PRICING_CACHE_FILE_NAME,
  resetOpenRouterPricingCacheMemory,
  writeOpenRouterPricingCache,
} from '../../../lib/providers/openrouter/openrouter-pricing-cache.ts';
import { invalidateOpenRouterModelsCache } from '../../../lib/providers/openrouter/openrouter-models.ts';
import { registerOpenRouterRoutes } from '../openrouter-routes.js';

const TEST_KEY = 'sk-or-v1-testkey123456';
const CACHE_PATH = path.join(ISOLATED_DATA_DIR, OPENROUTER_PRICING_CACHE_FILE_NAME);

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

function resetCaches() {
  resetOpenRouterPricingCacheMemory();
  invalidateOpenRouterModelsCache();
  fs.rmSync(CACHE_PATH, { force: true });
}

/**
 * @param {(base: string) => Promise<void>} fn
 */
async function withRoutes(fn) {
  const app = express();
  registerOpenRouterRoutes(app);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}/api/openrouter/models`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/openrouter/models exposes cached true only on cache hit', async () => {
  await withEnvKey(async () => {
    resetCaches();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('openrouter.ai')) {
        return { ok: true, async json() { return { data: [{ id: 'openrouter/b', name: 'Model B' }] }; } };
      }
      return originalFetch(input, init);
    };
    try {
      await withRoutes(async (base) => {
        const firstRes = await originalFetch(base);
        assert.equal(firstRes.status, 200);
        const firstBody = await firstRes.json();
        assert.equal(firstBody.ok, true);
        assert.equal(firstBody.cached, undefined);
        const secondBody = await (await originalFetch(base)).json();
        assert.equal(secondBody.cached, true);
      });
    } finally {
      globalThis.fetch = originalFetch;
      resetCaches();
    }
  });
});

test('GET /api/openrouter/models exposes stale marker and keeps pricing', async () => {
  await withEnvKey(async () => {
    resetCaches();
    writeOpenRouterPricingCache([
      { id: 'openrouter/alpha', name: 'Alpha', pricing: { prompt: '0.0000025', completion: '0.00001' } },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('openrouter.ai')) {
        return { ok: false, status: 503, async json() { return {}; } };
      }
      return originalFetch(input, init);
    };
    try {
      await withRoutes(async (base) => {
        const res = await originalFetch(`${base}?refresh=1`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.stale, true);
        assert.equal(body.modelsSource, 'stale');
        assert.match(body.warning, /503/);
        assert.equal(body.models[0].pricing.prompt, '0.0000025');
        assert.equal(typeof body.catalogFetchedAt, 'string');
      });
    } finally {
      globalThis.fetch = originalFetch;
      resetCaches();
    }
  });
});

removeIsolatedDataDir();
