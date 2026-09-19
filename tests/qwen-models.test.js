import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  DEFAULT_QWEN_MODEL,
  catalogFromQwenModelsPayload,
  invalidateQwenModelsCache,
  listFallbackQwenModels,
  listQwenModels,
  remapQwenModelId,
  resolveDefaultQwenModel,
  resolveQwenRunModel,
} from '../lib/qwen/qwen-models.js';

assert.equal(DEFAULT_QWEN_MODEL, 'qwen3.8-max');
assert.equal(resolveDefaultQwenModel(), 'qwen3.8-max');

const tokenPlan = listFallbackQwenModels('token-plan');
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.8-max'));
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.7-plus'));
assert.ok(tokenPlan.some((row) => row.value === 'qwen3.8-flash'));
assert.equal(tokenPlan.some((row) => row.value === 'qwen-plus'), false);

const payg = listFallbackQwenModels('payg');
assert.ok(payg.some((row) => row.value === 'qwen-plus'));
assert.ok(payg.some((row) => row.value === 'qwen3-coder-plus'));

assert.equal(remapQwenModelId('qwen-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(remapQwenModelId('qwen3-coder-plus', 'token-plan'), 'qwen3.8-flash');
assert.equal(remapQwenModelId('qwen-plus', 'payg'), 'qwen-plus');
assert.equal(resolveQwenRunModel('qwen-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(resolveQwenRunModel('qwen3.7-plus', 'token-plan'), 'qwen3.7-plus');
assert.equal(resolveQwenRunModel('qwen-plus', 'payg'), 'qwen-plus');
assert.equal(resolveQwenRunModel(''), DEFAULT_QWEN_MODEL);
assert.equal(resolveQwenRunModel('   '), DEFAULT_QWEN_MODEL);

const mappedPayg = catalogFromQwenModelsPayload({
  data: [{ id: 'qwen-plus' }, { id: 'qwen3.8-max' }],
}, 'payg');
assert.ok(mappedPayg.some((row) => row.value === 'qwen-plus' && row.label === 'Qwen Plus'));

const mappedToken = catalogFromQwenModelsPayload({
  data: [{ id: 'qwen-plus' }, { id: 'qwen3.7-plus' }],
}, 'token-plan');
assert.deepEqual(mappedToken.map((row) => row.value), ['qwen3.7-plus']);

const previousKey = process.env.QWEN_API_KEY;
const previousDash = process.env.DASHSCOPE_API_KEY;
const previousEndpoint = process.env.QWEN_ENDPOINT;
const previousFetch = globalThis.fetch;
process.env.QWEN_API_KEY = 'qwen-test-key';
delete process.env.DASHSCOPE_API_KEY;
delete process.env.QWEN_ENDPOINT;

try {
  invalidateQwenModelsCache();
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/models$/);
    return new Response(JSON.stringify({
      data: [{ id: 'qwen-plus' }, { id: 'qwen3.8-max' }],
    }), { status: 200 });
  };
  const liveListed = await listQwenModels({ refresh: true });
  assert.equal(liveListed.modelsSource, 'live');
  assert.ok(liveListed.catalog.some((row) => row.value === 'qwen-plus' || row.value === 'qwen3.8-max'));

  globalThis.fetch = async () => new Response('nope', { status: 502 });
  const fallbackListed = await listQwenModels({ refresh: true });
  assert.equal(fallbackListed.modelsSource, 'fallback');
  assert.ok(fallbackListed.catalog.length > 0);
} finally {
  globalThis.fetch = previousFetch;
  if (typeof previousKey === 'string') process.env.QWEN_API_KEY = previousKey;
  else delete process.env.QWEN_API_KEY;
  if (typeof previousDash === 'string') process.env.DASHSCOPE_API_KEY = previousDash;
  if (typeof previousEndpoint === 'string') process.env.QWEN_ENDPOINT = previousEndpoint;
  invalidateQwenModelsCache();
  removeIsolatedDataDir();
}

console.log('qwen-models.test.js OK');
