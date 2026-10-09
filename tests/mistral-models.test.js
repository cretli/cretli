import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogFromMistralModelsPayload,
  listFallbackMistralModels,
  getMistralChatEnabledModels,
  listMistralModels,
  resolveDefaultMistralModel,
} from '../lib/mistral/mistral-models.js';
import { listHarnessModels } from '../lib/harness-catalog.js';

test('payload mapping skips non-chat and duplicate models', () => {
  const catalog = catalogFromMistralModelsPayload({
    data: [
      { id: 'mistral-large-latest', capabilities: { completionChat: true }, maxContextLength: 256000 },
      { id: 'mistral-embed', capabilities: { completionChat: false } },
      { id: 'mistral-large-latest' },
    ],
  });
  assert.deepEqual(catalog.map((row) => row.value), ['mistral-large-latest']);
  assert.equal(catalog[0].contextWindowTokens, 256000);
});

test('fallback catalog is used without a key', async () => {
  const prevKey = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try {
    const listed = await listMistralModels({ refresh: true });
    assert.equal(listed.modelsSource, 'fallback');
    assert.equal(listed.catalog.length, listFallbackMistralModels().length);
    assert.equal(resolveDefaultMistralModel(), 'mistral-medium-latest');
  } finally {
    if (typeof prevKey === 'string') process.env.MISTRAL_API_KEY = prevKey;
  }
});

test('harness catalog knows mistral', async () => {
  const result = listHarnessModels({ harness: 'mistral' });
  assert.ok(JSON.stringify(result).includes('mistral-medium-latest'));
});

test('payload mapping accepts a bare array, snake_case fields and rejects garbage', () => {
  const catalog = catalogFromMistralModelsPayload([
    { id: ' codestral-latest ', capabilities: { completion_chat: true }, max_context_length: 32000 },
    { id: 'no-chat', capabilities: { completion_chat: false } },
    { id: '' },
    null,
  ]);
  assert.deepEqual(catalog.map((row) => row.value), ['codestral-latest']);
  assert.equal(catalog[0].contextWindowTokens, 32000);
  assert.deepEqual(catalogFromMistralModelsPayload(undefined), []);
  assert.deepEqual(catalogFromMistralModelsPayload({ data: 'x' }), []);
});

test('fallback catalog is a copy and contains the default model', () => {
  const first = listFallbackMistralModels();
  assert.ok(first.some((row) => row.value === resolveDefaultMistralModel()));
  first.pop();
  assert.ok(listFallbackMistralModels().length > first.length);
});

test('enabled chat models normalize to a string array', () => {
  const enabled = getMistralChatEnabledModels();
  assert.ok(Array.isArray(enabled));
  assert.ok(enabled.every((id) => typeof id === 'string' && id.length > 0));
});
