import assert from 'node:assert/strict';
import {
  getEffectiveOpenCodeApiKey,
  getOpenCodeApiKeyMetaForClient,
  isValidOpenCodeApiKeyFormat,
} from '../lib/opencode/opencode-api-key.js';

assert.equal(isValidOpenCodeApiKeyFormat('sk-or-v1-abc123456789'), false);
assert.equal(isValidOpenCodeApiKeyFormat('sk-zoyvdtest1234567890'), true);

const previous = process.env.OPENCODE_API_KEY;
process.env.OPENCODE_API_KEY = 'sk-zoyvdtest1234567890';
try {
  const meta = getOpenCodeApiKeyMetaForClient();
  assert.equal(meta.opencodeApiKeyFromEnv, true);
  assert.equal(meta.opencodeApiKeyEffective, true);
  assert.equal(getEffectiveOpenCodeApiKey(), 'sk-zoyvdtest1234567890');
} finally {
  if (previous === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = previous;
}

console.log('opencode-api-key.test.js OK');
