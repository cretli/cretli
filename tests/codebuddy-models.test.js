import assert from 'node:assert/strict';
import {
  DEFAULT_CODEBUDDY_MODEL,
  catalogEntriesFromCodeBuddyRows,
  catalogEntryFromCodeBuddyRow,
  inferCodeBuddyProvider,
  listFallbackCodeBuddyModels,
  parseAccountModelsFromCodeBuddyError,
  resolveCodeBuddyProductJsonPath,
  resolveCodeBuddyRunModel,
  resolveDefaultCodeBuddyModel,
} from '../lib/codebuddy/codebuddy-models.js';
import { isCodeBuddyCliFound, resolveBundledCodeBuddyCli } from '../lib/codebuddy/codebuddy-cli.js';

assert.equal(DEFAULT_CODEBUDDY_MODEL, 'default-model');
assert.equal(resolveDefaultCodeBuddyModel(), 'default-model');

const fromSdkShape = catalogEntryFromCodeBuddyRow({
  value: 'glm-5.2',
  displayName: 'GLM-5.2',
  description: 'account model',
});
assert.equal(fromSdkShape?.value, 'glm-5.2');
assert.equal(fromSdkShape?.label, 'GLM-5.2');
assert.equal(fromSdkShape?.provider, 'zhipu');

const fromDocsShape = catalogEntryFromCodeBuddyRow({
  modelId: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
});
assert.equal(fromDocsShape?.value, 'gpt-5.6-sol');
assert.equal(fromDocsShape?.provider, 'openai');

const fromProductShape = catalogEntryFromCodeBuddyRow({
  id: 'default-model',
  name: 'Default',
  vendor: 'e',
  maxInputTokens: 176000,
});
assert.equal(fromProductShape?.value, 'default-model');
assert.equal(fromProductShape?.provider, 'codebuddy');
assert.equal(fromProductShape?.contextWindowTokens, 176000);

assert.equal(catalogEntryFromCodeBuddyRow({ name: 'no-id' }), null);

const deduped = catalogEntriesFromCodeBuddyRows([
  { id: 'default-model', name: 'Default' },
  { value: 'default-model', displayName: 'Default again' },
  { modelId: 'fast-model', name: 'Fast' },
]);
assert.deepEqual(deduped.map((row) => row.value), ['default-model', 'fast-model']);

assert.equal(inferCodeBuddyProvider('kimi-k3'), 'moonshot');
assert.equal(inferCodeBuddyProvider('gemini-3.5-flash'), 'google');
assert.equal(inferCodeBuddyProvider('minimax-m3'), 'minimax');

assert.notEqual(DEFAULT_CODEBUDDY_MODEL, 'deepseek-v3.1');
assert.equal(resolveCodeBuddyRunModel(''), 'default-model');
assert.equal(resolveCodeBuddyRunModel('deepseek-v3.1'), 'default-model');
assert.equal(resolveCodeBuddyRunModel('glm-5.2'), 'glm-5.2');
const previousEdition = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
process.env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal';
assert.equal(resolveCodeBuddyRunModel('deepseek-v3.1'), 'deepseek-v3.1');
if (typeof previousEdition === 'string') process.env.CODEBUDDY_INTERNET_ENVIRONMENT = previousEdition;
else delete process.env.CODEBUDDY_INTERNET_ENVIRONMENT;

const parsedLinePerModel = parseAccountModelsFromCodeBuddyError(`
400 model [deepseek-v3.1] service info not found
Currently supported models for your account:
default-model
fast-model
glm-5.2
kimi-k3
Please use one of the models above.
`);
assert.deepEqual(parsedLinePerModel, ['default-model', 'fast-model', 'glm-5.2', 'kimi-k3']);

const parsedCommaList = parseAccountModelsFromCodeBuddyError(
  'Currently supported models for your account: default-model, fast-model, gpt-5.6-sol, glm-5.2',
);
assert.deepEqual(parsedCommaList, ['default-model', 'fast-model', 'gpt-5.6-sol', 'glm-5.2']);
assert.deepEqual(parseAccountModelsFromCodeBuddyError('no list here'), []);

const fallback = listFallbackCodeBuddyModels();
assert.ok(fallback.length > 0);
assert.ok(fallback.some((row) => row.value === 'default-model'));
assert.ok(fallback.some((row) => row.value === 'glm-5.2'));
assert.ok(fallback.some((row) => row.value === 'kimi-k3'));
assert.ok(!fallback.some((row) => row.value === 'gpt-5.1'));
const bundledCli = resolveBundledCodeBuddyCli();
if (bundledCli) {
  assert.equal(isCodeBuddyCliFound(), true);
  assert.ok(resolveCodeBuddyProductJsonPath().endsWith('product.json'));
}

console.log('codebuddy-models.test.js OK');
