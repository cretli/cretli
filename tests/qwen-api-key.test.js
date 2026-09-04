import assert from 'node:assert/strict';
import {
  getEffectiveQwenApiKey,
  getQwenApiKeyFromEnv,
  getQwenApiKeyMetaForClient,
  normalizeQwenEndpoint,
  resolveQwenBaseUrl,
  resolveQwenEndpoint,
  buildQwenProcessEnv,
  QWEN_ENDPOINT_URLS,
} from '../lib/qwen/qwen-api-key.js';

const previousQwen = process.env.QWEN_API_KEY;
const previousDashscope = process.env.DASHSCOPE_API_KEY;
const previousEndpoint = process.env.QWEN_ENDPOINT;
const previousBase = process.env.QWEN_BASE_URL;
delete process.env.QWEN_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
delete process.env.QWEN_ENDPOINT;
delete process.env.QWEN_BASE_URL;

try {
  process.env.QWEN_API_KEY = 'qwen-test-key';
  assert.equal(getQwenApiKeyFromEnv(), 'qwen-test-key');
  assert.equal(getEffectiveQwenApiKey(), 'qwen-test-key');
  const meta = getQwenApiKeyMetaForClient();
  assert.equal(meta.qwenApiKeyEffective, true);
  assert.equal(meta.qwenApiKeyFromEnv, true);

  delete process.env.QWEN_API_KEY;
  process.env.DASHSCOPE_API_KEY = 'dash-alias-key';
  assert.equal(getQwenApiKeyFromEnv(), 'dash-alias-key');
  assert.equal(getEffectiveQwenApiKey(), 'dash-alias-key');

  assert.equal(normalizeQwenEndpoint(''), 'payg');
  assert.equal(normalizeQwenEndpoint('token-plan'), 'token-plan');
  assert.equal(normalizeQwenEndpoint('coding-plan'), 'coding-plan');
  assert.equal(normalizeQwenEndpoint('custom'), 'custom');
  assert.equal(normalizeQwenEndpoint('unknown'), 'payg');

  assert.equal(resolveQwenEndpoint(), 'payg');
  assert.equal(resolveQwenBaseUrl(), QWEN_ENDPOINT_URLS.payg);

  process.env.QWEN_ENDPOINT = 'token-plan';
  assert.equal(resolveQwenEndpoint(), 'token-plan');
  assert.equal(resolveQwenBaseUrl(), QWEN_ENDPOINT_URLS['token-plan']);

  process.env.QWEN_ENDPOINT = 'coding-plan';
  assert.equal(resolveQwenBaseUrl(), QWEN_ENDPOINT_URLS['coding-plan']);

  process.env.QWEN_ENDPOINT = 'custom';
  process.env.QWEN_BASE_URL = 'https://example.test/v1/';
  assert.equal(resolveQwenBaseUrl(), 'https://example.test/v1');

  process.env.QWEN_ENDPOINT = 'payg';
  process.env.QWEN_API_KEY = 'qwen-test-key';
  const envOverlay = buildQwenProcessEnv({ model: 'qwen-plus' });
  assert.equal(envOverlay.OPENAI_API_KEY, 'qwen-test-key');
  assert.equal(envOverlay.QWEN_API_KEY, 'qwen-test-key');
  assert.equal(envOverlay.OPENAI_BASE_URL, QWEN_ENDPOINT_URLS.payg);
  assert.equal(envOverlay.OPENAI_MODEL, 'qwen-plus');
  assert.equal(envOverlay.QWEN_MODEL, 'qwen-plus');
  assert.ok(String(envOverlay.HOME || '').endsWith('qwen-home'));
} finally {
  if (typeof previousQwen === 'string') process.env.QWEN_API_KEY = previousQwen;
  else delete process.env.QWEN_API_KEY;
  if (typeof previousDashscope === 'string') process.env.DASHSCOPE_API_KEY = previousDashscope;
  else delete process.env.DASHSCOPE_API_KEY;
  if (typeof previousEndpoint === 'string') process.env.QWEN_ENDPOINT = previousEndpoint;
  else delete process.env.QWEN_ENDPOINT;
  if (typeof previousBase === 'string') process.env.QWEN_BASE_URL = previousBase;
  else delete process.env.QWEN_BASE_URL;
}

console.log('qwen-api-key.test.js OK');
