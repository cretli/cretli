import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import express from 'express';
import { registerBenchmarkSourcesRoutes } from '../lib/routes/benchmark-sources-routes.js';
import { getArtificialAnalysisApiKey, getArtificialAnalysisApiKeyMeta } from '../lib/benchmark-api-key.js';
import { loadSettings } from '../lib/persist/settings.js';
import { validateImportableSnapshot } from '../lib/benchmark-snapshot.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

after(removeIsolatedDataDir);

test('key save, API test and removal use server-side credentials and expose metadata only', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-api-test-'));
  const app = express();
  app.use(express.json());
  let callCount = 0;
  registerBenchmarkSourcesRoutes(app, {
    benchmarkSnapshotsFile: path.join(directory, 'snapshots.json'),
    benchmarkFetchUsageFile: path.join(directory, 'usage.json'),
    benchmarkFetchImpl: async (url, options) => {
      callCount += 1;
      assert.equal(options.headers['x-api-key'], 'example-api-key');
      return new Response(JSON.stringify({ data: [{ id: 'example', name: 'Example', evaluations: { artificial_analysis_intelligence_index: 40 } }] }), { status: 200 });
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = async (action, body, method = 'PUT') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/harness-benchmark-sources/${action}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return response.json();
  };
  try {
    const saved = await request('key', { apiKey: 'example-api-key' });
    assert.equal(saved.apiKey.saved, true);
    assert.equal(saved.apiKey.source, 'settings');
    assert.equal(loadSettings().artificialAnalysisApiKey, 'example-api-key');
    assert.equal(getArtificialAnalysisApiKey(), 'example-api-key');
    assert.ok(!JSON.stringify(saved).includes('example-api-key'));
    const connected = await request('test', {}, 'POST');
    assert.equal(connected.ok, true);
    assert.equal(connected.entryCount, 1);
    assert.equal(callCount, 1);
    assert.equal(fs.existsSync(path.join(directory, 'snapshots.json')), false);
    const cleared = await request('key', { clear: true });
    assert.equal(cleared.apiKey.saved, false);
    assert.equal(getArtificialAnalysisApiKey(), '');
    const missing = await request('test', {}, 'POST');
    assert.equal(missing.code, 'key_missing');
    assert.equal(callCount, 1);
    assert.deepEqual(getArtificialAnalysisApiKeyMeta({ env: { ARTIFICIAL_ANALYSIS_API_KEY: 'env-key' }, settings: { artificialAnalysisApiKey: 'saved-key' } }), { configured: true, saved: true, source: 'environment' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Artificial Analysis snapshots import without operator terms confirmations', () => {
  const result = validateImportableSnapshot({ sourceId: 'artificial-analysis', capturedAt: new Date().toISOString(), payload: { entries: [{ modelKey: 'example/model', releaseTier: 2, mappingDimension: 'release' }] } }, null);
  assert.ok(result);
});
