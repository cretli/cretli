/**
 * OpenRouter model list cache flag (no real network).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { test } from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  invalidateOpenRouterModelsCache,
  listOpenRouterModels,
} from '../lib/openrouter/openrouter-models.js';
import { registerOpenRouterRoutes } from '../lib/routes/openrouter-routes.js';

const TEST_KEY = 'sk-or-v1-testkey123456';

test('listOpenRouterModels sets fromCache only on TTL hit', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = TEST_KEY;
  invalidateOpenRouterModelsCache();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      async json() {
        return { data: [{ id: 'openrouter/a', name: 'Model A' }] };
      },
    };
  };
  try {
    const first = await listOpenRouterModels({});
    assert.equal(first.fromCache, false);
    assert.equal(fetchCalls, 1);
    const second = await listOpenRouterModels({});
    assert.equal(second.fromCache, true);
    assert.equal(fetchCalls, 1);
    const refreshed = await listOpenRouterModels({ refresh: true });
    assert.equal(refreshed.fromCache, false);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateOpenRouterModelsCache();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('GET /api/openrouter/models exposes cached true only on cache hit', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = TEST_KEY;
  invalidateOpenRouterModelsCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url.includes('openrouter.ai')) {
      return {
        ok: true,
        async json() {
          return { data: [{ id: 'openrouter/b', name: 'Model B' }] };
        },
      };
    }
    return originalFetch(input, init);
  };
  const app = express();
  registerOpenRouterRoutes(app);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/openrouter/models`;
    const firstRes = await originalFetch(base);
    assert.equal(firstRes.status, 200);
    const firstBody = await firstRes.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.cached, undefined);
    const secondRes = await originalFetch(base);
    const secondBody = await secondRes.json();
    assert.equal(secondBody.cached, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    invalidateOpenRouterModelsCache();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

removeIsolatedDataDir();
console.log('openrouter-models-cached.test.js OK');
