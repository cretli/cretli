import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import express from 'express';
import { listHarnessModels, requireKnownHarness } from '../lib/harness-catalog.js';
import { registerHarnessCatalogRoutes } from '../lib/routes/harness-catalog-routes.js';
import { saveSettings } from '../lib/persist/settings.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

function expectValidation(input) {
  let thrown = null;
  try {
    listHarnessModels(input);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown);
  assert.equal(thrown.code, 'VALIDATION');
  return thrown;
}

assert.equal(requireKnownHarness('sdk'), 'sdk');
assert.equal(requireKnownHarness('OpenCode'), 'opencode');
assert.throws(() => requireKnownHarness(''), { code: 'VALIDATION' });
assert.throws(() => requireKnownHarness('cursor-typo'), { code: 'VALIDATION' });

expectValidation({});
expectValidation({ harness: '' });
expectValidation({ harness: '   ' });
const unknown = expectValidation({ harness: 'cursor-typo' });
assert.match(unknown.message, /Unknown harness/);

const sdk = listHarnessModels({ harness: 'sdk' });
assert.ok(sdk.items.some((row) => row.id === 'auto' || row.id === 'composer-2'));

saveSettings({
  chatEnabledModels: [
    'grok-4.6::effort=high,fast=false',
    'grok-4.6::effort=medium,fast=false',
  ],
});
const grokList = listHarnessModels({ harness: 'sdk', query: 'grok' });
assert.ok(grokList.items.length > 0, 'enabled Grok variants must appear without a live Cursor catalog');
assert.ok(grokList.items.every((row) => /grok/i.test(`${row.id} ${row.label}`)));
assert.ok(grokList.items.some((row) => row.id === 'grok-4.6::effort=high,fast=false'));
assert.ok(grokList.items.some((row) => row.id === 'grok-4.6::effort=medium,fast=false'));
assert.equal(
  grokList.items.some((row) => row.id === 'composer-2'),
  false,
);

const app = express();
registerHarnessCatalogRoutes(app);
const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const port = httpServer.address().port;
const base = `http://127.0.0.1:${port}/api/harness-catalog/models`;

async function getModels(query) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

const missingHttp = await getModels({});
assert.equal(missingHttp.status, 400);
assert.equal(missingHttp.json.code, 'VALIDATION');

const emptyHttp = await getModels({ harness: '' });
assert.equal(emptyHttp.status, 400);
assert.equal(emptyHttp.json.code, 'VALIDATION');

const unknownHttp = await getModels({ harness: 'cursor-typo' });
assert.equal(unknownHttp.status, 400);
assert.equal(unknownHttp.json.code, 'VALIDATION');
assert.match(String(unknownHttp.json.error), /Unknown harness/);
assert.equal(Array.isArray(unknownHttp.json.items), false);

const sdkHttp = await getModels({ harness: 'sdk' });
assert.equal(sdkHttp.status, 200);
assert.ok(sdkHttp.json.items.length > 0);

httpServer.close();
removeIsolatedDataDir();
console.log('harness-catalog.test.js OK');
