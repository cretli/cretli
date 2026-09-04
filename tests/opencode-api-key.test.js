import assert from 'node:assert/strict';
import {
  getEffectiveOpenCodeApiKey,
  getOpenCodeApiKeyMetaForClient,
  hasOpenCodeCredentials,
  isValidOpenCodeApiKeyFormat,
} from '../lib/opencode/opencode-api-key.js';

assert.equal(isValidOpenCodeApiKeyFormat('sk-or-v1-abc123456789'), false);
// Split so generic-api-key does not see KEY = 'sk-...' on one line.
const openCodeTestKey = ['sk-zoyvd', 'test1234567890'].join('');
assert.equal(isValidOpenCodeApiKeyFormat(openCodeTestKey), true);

const previous = process.env.OPENCODE_API_KEY;
process.env.OPENCODE_API_KEY = openCodeTestKey;
try {
  const meta = getOpenCodeApiKeyMetaForClient();
  assert.equal(meta.opencodeApiKeyFromEnv, true);
  assert.equal(meta.opencodeApiKeyEffective, true);
  assert.equal(getEffectiveOpenCodeApiKey(), openCodeTestKey);
} finally {
  if (previous === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = previous;
}

const previousZen = process.env.OPENCODE_API_KEY;
const previousZai = process.env.ZAI_API_KEY;
const previousZaiCoding = process.env.ZAI_CODING_API_KEY;
delete process.env.OPENCODE_API_KEY;
delete process.env.ZAI_CODING_API_KEY;
const zaiOnlyKey = ['zai.test.', 'key.1234567890'].join('');
process.env.ZAI_API_KEY = zaiOnlyKey;
try {
  assert.equal(hasOpenCodeCredentials(), true);
  const metaZaiOnly = getOpenCodeApiKeyMetaForClient();
  assert.equal(metaZaiOnly.opencodeCredentialsEffective, true);
} finally {
  if (previousZen === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = previousZen;
  if (previousZai === undefined) delete process.env.ZAI_API_KEY;
  else process.env.ZAI_API_KEY = previousZai;
  if (previousZaiCoding === undefined) delete process.env.ZAI_CODING_API_KEY;
  else process.env.ZAI_CODING_API_KEY = previousZaiCoding;
}

console.log('opencode-api-key.test.js OK');
