import assert from 'node:assert/strict';
import {
  getDeepSeekApiKeyFromEnv,
  getEffectiveDeepSeekApiKey,
  getDeepSeekApiKeyMetaForClient,
} from '../lib/deepseek/deepseek-api-key.js';

const previous = process.env.DEEPSEEK_API_KEY;
process.env.DEEPSEEK_API_KEY = 'dsh-test-key';

try {
  assert.equal(getDeepSeekApiKeyFromEnv(), 'dsh-test-key');
  assert.equal(getEffectiveDeepSeekApiKey(), 'dsh-test-key');
  const meta = getDeepSeekApiKeyMetaForClient();
  assert.equal(meta.deepseekApiKeyEffective, true);
  assert.equal(meta.deepseekApiKeyFromEnv, true);
  assert.equal(typeof meta.deepseekApiKeyStoredInSettings, 'boolean');
} finally {
  if (typeof previous === 'string') process.env.DEEPSEEK_API_KEY = previous;
  else delete process.env.DEEPSEEK_API_KEY;
}

delete process.env.DEEPSEEK_API_KEY;
const withoutEnv = getDeepSeekApiKeyMetaForClient();
assert.equal(withoutEnv.deepseekApiKeyFromEnv, false);
assert.equal(typeof withoutEnv.deepseekApiKeyEffective, 'boolean');

console.log('deepseek-api-key.test.js OK');
