import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getCachedSdkModelRows, resetAgentSdkModelsCache } from '../lib/routes/agent-sdk-routes.js';

test('concurrent callers share one SDK model request and later calls hit the cache', async () => {
  resetAgentSdkModelsCache();
  let calls = 0;
  const fetchRows = async () => { calls += 1; return [{ id: 'm1' }]; };
  const [a, b] = await Promise.all([getCachedSdkModelRows('k', fetchRows), getCachedSdkModelRows('k', fetchRows)]);
  assert.deepEqual(a, [{ id: 'm1' }]);
  assert.deepEqual(b, [{ id: 'm1' }]);
  await getCachedSdkModelRows('k', fetchRows);
  assert.equal(calls, 1);
});

test('a stale list is served at once while one refresh runs; another key fetches its own list', async () => {
  resetAgentSdkModelsCache();
  let calls = 0;
  const fetchRows = async (key) => { calls += 1; return [{ id: `${key}-${calls}` }]; };
  await getCachedSdkModelRows('k', fetchRows);
  const stale = await getCachedSdkModelRows('k', fetchRows, Date.now() + 10 * 60_000);
  assert.deepEqual(stale, [{ id: 'k-1' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await getCachedSdkModelRows('k', fetchRows), [{ id: 'k-2' }]);
  assert.deepEqual(await getCachedSdkModelRows('other', fetchRows), [{ id: 'other-3' }]);
});

test('a failed first request is not cached', async () => {
  resetAgentSdkModelsCache();
  let fail = true;
  const fetchRows = async () => { if (fail) throw new Error('network'); return [{ id: 'ok' }]; };
  await assert.rejects(getCachedSdkModelRows('k', fetchRows), /network/);
  fail = false;
  assert.deepEqual(await getCachedSdkModelRows('k', fetchRows), [{ id: 'ok' }]);
});
