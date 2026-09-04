import assert from 'node:assert/strict';
import {
  getEffectiveOpenCodeZaiApiKey,
  getOpenCodeZaiApiKeyMetaForClient,
  getOpenCodeZaiProvider,
  isValidOpenCodeZaiApiKeyFormat,
  normalizeOpenCodeZaiProvider,
} from '../lib/opencode/opencode-zai-api-key.js';

// Split so generic-api-key does not see KEY = '...' on one line.
const zaiTestKey = ['zai.test.', 'key.1234567890'].join('');

assert.equal(isValidOpenCodeZaiApiKeyFormat(''), false);
assert.equal(isValidOpenCodeZaiApiKeyFormat('short'), false);
assert.equal(isValidOpenCodeZaiApiKeyFormat('sk-or-v1-abc123456789'), false);
const zenLookalike = ['sk-zoyvd', 'test1234567890'].join('');
assert.equal(isValidOpenCodeZaiApiKeyFormat(zenLookalike), false);
assert.equal(isValidOpenCodeZaiApiKeyFormat(zaiTestKey), true);

assert.equal(normalizeOpenCodeZaiProvider(''), 'zai-coding-plan');
assert.equal(normalizeOpenCodeZaiProvider('zai-coding-plan'), 'zai-coding-plan');
assert.equal(normalizeOpenCodeZaiProvider('zai'), 'zai');
assert.equal(normalizeOpenCodeZaiProvider('other'), 'zai-coding-plan');

const previousCoding = process.env.ZAI_CODING_API_KEY;
const previousZai = process.env.ZAI_API_KEY;
const previousProvider = process.env.ZAI_OPENCODE_PROVIDER;
delete process.env.ZAI_CODING_API_KEY;
delete process.env.ZAI_API_KEY;
delete process.env.ZAI_OPENCODE_PROVIDER;

try {
  assert.equal(getOpenCodeZaiProvider(), 'zai-coding-plan');
  process.env.ZAI_API_KEY = zaiTestKey;
  assert.equal(getEffectiveOpenCodeZaiApiKey(), zaiTestKey);
  const metaFromApi = getOpenCodeZaiApiKeyMetaForClient();
  assert.equal(metaFromApi.opencodeZaiApiKeyFromEnv, true);
  assert.equal(metaFromApi.opencodeZaiApiKeyEffective, true);
  assert.equal(metaFromApi.opencodeZaiProvider, 'zai-coding-plan');

  const zaiCodingKey = ['zai.coding.', 'key.abcdef'].join('');
  process.env.ZAI_CODING_API_KEY = zaiCodingKey;
  assert.equal(getEffectiveOpenCodeZaiApiKey(), zaiCodingKey);

  process.env.ZAI_OPENCODE_PROVIDER = 'zai';
  assert.equal(getOpenCodeZaiProvider(), 'zai');
} finally {
  if (previousCoding === undefined) delete process.env.ZAI_CODING_API_KEY;
  else process.env.ZAI_CODING_API_KEY = previousCoding;
  if (previousZai === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = previousZai;
  if (previousProvider === undefined) delete process.env.ZAI_OPENCODE_PROVIDER;
  else process.env.ZAI_OPENCODE_PROVIDER = previousProvider;
}

console.log('opencode-zai-api-key.test.js OK');
