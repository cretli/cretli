/**
 * OpenRouter model list cache flag (no real network).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  invalidateOpenRouterModelsCache,
  listOpenRouterModels,
} from '../lib/providers/openrouter/openrouter-models.ts';

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

removeIsolatedDataDir();
console.log('openrouter-models-cached.test.js OK');
