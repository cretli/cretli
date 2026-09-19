import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_PROVIDER,
  catalogFromDeepSeekModelsPayload,
  getDeepSeekChatEnabledModels,
  invalidateDeepSeekModelsCache,
  listDeepSeekModels,
  listFallbackDeepSeekModels,
  remapDeepSeekModelId,
  normalizeDeepSeekChatEnabledModels,
  resolveDefaultDeepSeekModel,
  isDeepSeekVisionModel,
} from '../lib/deepseek/deepseek-models.js';
import { listDeepSeekDshCatalogModels } from '../lib/deepseek/deepseek-model-ids.js';
import { saveSettings } from '../lib/persist/settings.js';

const previousDefault = process.env.DEEPSEEK_DEFAULT_MODEL;
delete process.env.DEEPSEEK_DEFAULT_MODEL;

assert.equal(DEFAULT_DEEPSEEK_MODEL, 'deepseek-flash');
assert.equal(DEEPSEEK_PROVIDER, 'deepseek-official');
assert.equal(resolveDefaultDeepSeekModel(), 'deepseek-flash');
assert.equal(isDeepSeekVisionModel('deepseek-flash'), true);
assert.equal(isDeepSeekVisionModel('deepseek-v4-flash'), true);
assert.equal(isDeepSeekVisionModel('deepseek-v4-pro'), false);
assert.equal(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp'), true);
assert.equal(remapDeepSeekModelId('deepseek-v4-flash'), 'deepseek-flash');
assert.equal(remapDeepSeekModelId('deepseek-v4-flash-vision-exp'), 'deepseek-flash');
assert.equal(remapDeepSeekModelId('deepseek-v4-pro'), 'deepseek-v4-pro');
assert.deepEqual(
  normalizeDeepSeekChatEnabledModels(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']),
  ['deepseek-flash', 'deepseek-v4-pro'],
);

const fallback = listFallbackDeepSeekModels();
assert.ok(fallback.some((row) => row.value === 'deepseek-flash'));
assert.ok(fallback.some((row) => row.value === 'deepseek-v4-pro'));
assert.equal(fallback.some((row) => row.value === 'deepseek-v4-flash-vision-exp'), false);
assert.equal(fallback.length, 2);

const mapped = catalogFromDeepSeekModelsPayload({
  data: [
    { id: 'deepseek-flash' },
    { id: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-pro' },
  ],
});
assert.deepEqual(mapped.map((row) => row.value), ['deepseek-flash', 'deepseek-v4-pro']);
assert.equal(mapped[0].label, 'DeepSeek V4.1 Flash');

const dshCatalog = listDeepSeekDshCatalogModels();
const flashRoute = dshCatalog.find((row) => row.id === 'deepseek-flash');
const proRoute = dshCatalog.find((row) => row.id === 'deepseek-v4-pro');
assert.ok(flashRoute);
assert.deepEqual(flashRoute.inputModalities, ['text', 'image']);
assert.ok(proRoute);
assert.deepEqual(proRoute.inputModalities, ['text']);

saveSettings({ deepseekChatEnabledModels: ['deepseek-v4-flash', 'deepseek-v4-pro'] });
assert.deepEqual(getDeepSeekChatEnabledModels(), ['deepseek-flash', 'deepseek-v4-pro']);

const previousKey = process.env.DEEPSEEK_API_KEY;
const previousFetch = globalThis.fetch;
process.env.DEEPSEEK_API_KEY = 'dsh-test-key';

try {
  invalidateDeepSeekModelsCache();
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.deepseek.com/models');
    return new Response(JSON.stringify({
      data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    }), { status: 200 });
  };
  const liveListed = await listDeepSeekModels({ refresh: true });
  assert.equal(liveListed.modelsSource, 'live');
  assert.ok(liveListed.catalog.some((row) => row.value === 'deepseek-flash'));

  globalThis.fetch = async () => new Response('nope', { status: 502 });
  const fallbackListed = await listDeepSeekModels({ refresh: true });
  assert.equal(fallbackListed.modelsSource, 'fallback');
  assert.ok(fallbackListed.catalog.some((row) => row.value === 'deepseek-flash'));
} finally {
  globalThis.fetch = previousFetch;
  if (typeof previousDefault === 'string') process.env.DEEPSEEK_DEFAULT_MODEL = previousDefault;
  if (typeof previousKey === 'string') process.env.DEEPSEEK_API_KEY = previousKey;
  else delete process.env.DEEPSEEK_API_KEY;
  invalidateDeepSeekModelsCache();
  removeIsolatedDataDir();
}

console.log('deepseek-models.test.js OK');
