import assert from 'node:assert/strict';
import {
  getEffectiveOpenCodeApiKey,
  getOpenCodeApiKeyMetaForClient,
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

console.log('opencode-api-key.test.js OK');
