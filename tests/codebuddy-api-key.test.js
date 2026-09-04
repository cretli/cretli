import assert from 'node:assert/strict';
import {
  getCodeBuddyApiKeyFromEnv,
  getEffectiveCodeBuddyApiKey,
  getCodeBuddyApiKeyMetaForClient,
} from '../lib/codebuddy/codebuddy-api-key.js';

const previous = process.env.CODEBUDDY_API_KEY;
process.env.CODEBUDDY_API_KEY = 'cb-test-key';

try {
  assert.equal(getCodeBuddyApiKeyFromEnv(), 'cb-test-key');
  assert.equal(getEffectiveCodeBuddyApiKey(), 'cb-test-key');
  const meta = getCodeBuddyApiKeyMetaForClient();
  assert.equal(meta.codebuddyApiKeyEffective, true);
  assert.equal(meta.codebuddyApiKeyFromEnv, true);
  assert.equal(typeof meta.codebuddyApiKeyStoredInSettings, 'boolean');
} finally {
  if (typeof previous === 'string') process.env.CODEBUDDY_API_KEY = previous;
  else delete process.env.CODEBUDDY_API_KEY;
}

delete process.env.CODEBUDDY_API_KEY;
const withoutEnv = getCodeBuddyApiKeyMetaForClient();
assert.equal(withoutEnv.codebuddyApiKeyFromEnv, false);
assert.equal(typeof withoutEnv.codebuddyApiKeyEffective, 'boolean');

console.log('codebuddy-api-key.test.js OK');
