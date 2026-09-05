import assert from 'node:assert/strict';
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_PROVIDER,
  listFallbackDeepSeekModels,
  resolveDefaultDeepSeekModel,
  isDeepSeekVisionModel,
} from '../lib/deepseek/deepseek-models.js';

assert.equal(DEFAULT_DEEPSEEK_MODEL, 'deepseek-v4-flash');
assert.equal(DEEPSEEK_PROVIDER, 'deepseek-official');
assert.equal(resolveDefaultDeepSeekModel(), 'deepseek-v4-flash');
assert.equal(isDeepSeekVisionModel('deepseek-v4-flash'), false);
assert.equal(isDeepSeekVisionModel('deepseek-v4-pro'), false);
assert.equal(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp'), true);

const fallback = listFallbackDeepSeekModels();
assert.ok(fallback.some((row) => row.value === 'deepseek-v4-flash'));
assert.ok(fallback.some((row) => row.value === 'deepseek-v4-pro'));
assert.ok(fallback.some((row) => row.value === 'deepseek-v4-flash-vision-exp'));
assert.equal(fallback.length, 3);

console.log('deepseek-models.test.js OK');
