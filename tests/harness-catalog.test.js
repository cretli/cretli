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
const allSdk = listHarnessModels({ harness: 'sdk' });
const favSdk = listHarnessModels({ harness: 'sdk', enabledOnly: true });
assert.equal(listHarnessModels({ harness: 'sdk' }).items.length, allSdk.items.length);
assert.ok(allSdk.items.length > favSdk.items.length);
assert.ok(favSdk.items.every((row) => row.enabled !== false));
assert.ok(favSdk.items.some((row) => row.id === 'grok-4.6::effort=high,fast=false'));
assert.equal(favSdk.favorites_configured, true);
assert.equal(typeof favSdk.items[0].cost_tier, 'number');
assert.equal(typeof favSdk.items[0].quality_tier, 'number');
assert.equal(typeof favSdk.items[0].speed_tier, 'number');
assert.ok(Array.isArray(favSdk.items[0].roles));
assert.ok(favSdk.items.some((row) => row.roles.includes('plan')));

// Mistral favorites come from the live catalog; they must stay listable
// without a catalog snapshot even though the static fallback lacks their ids.
saveSettings({ mistralChatEnabledModels: ['mistral-large-4'] });
const favMistral = listHarnessModels({ harness: 'mistral', enabledOnly: true });
assert.deepEqual(favMistral.items.map((row) => row.id), ['mistral-large-4']);
assert.equal(favMistral.favorites_configured, true);
assert.ok(listHarnessModels({ harness: 'mistral' }).items.some((row) => row.id === 'mistral-medium-latest'));
saveSettings({ mistralChatEnabledModels: [] });

const previousEmptyPolicy = process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'deny';
saveSettings({ deepseekChatEnabledModels: [] });
const emptyDeepSeekFavorites = listHarnessModels({ harness: 'deepseek', enabledOnly: true });
assert.equal(emptyDeepSeekFavorites.items.length, 0);
assert.equal(emptyDeepSeekFavorites.favorites_configured, false);
assert.match(emptyDeepSeekFavorites.warning, /not start-eligible/);
const deepSeekCatalog = listHarnessModels({ harness: 'deepseek' });
assert.ok(deepSeekCatalog.items.some((row) => /flash/i.test(row.id)));
assert.ok(deepSeekCatalog.items.every((row) => row.enabled === false));
if (previousEmptyPolicy == null) delete process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
else process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = previousEmptyPolicy;

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
