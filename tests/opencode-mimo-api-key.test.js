import assert from 'node:assert/strict';
import {
  normalizeOpenCodeMimoBaseUrl,
  OPENCODE_MIMO_DEFAULT_BASE_URL,
  OPENCODE_MIMO_MODEL_IDS,
  OPENCODE_MIMO_PROVIDER_ID,
} from '../lib/opencode/opencode-mimo-api-key.js';

assert.equal(OPENCODE_MIMO_PROVIDER_ID, 'cretli-mimo');
assert.deepEqual(OPENCODE_MIMO_MODEL_IDS, ['mimo-v2.6-pro', 'mimo-v2.6-flash']);
assert.equal(OPENCODE_MIMO_DEFAULT_BASE_URL, 'https://api.xiaomimimo.com/v1');

assert.equal(
  normalizeOpenCodeMimoBaseUrl('https://token-plan-ams.xiaomimimo.com/v1/'),
  'https://token-plan-ams.xiaomimimo.com/v1',
);
assert.equal(normalizeOpenCodeMimoBaseUrl(OPENCODE_MIMO_DEFAULT_BASE_URL), OPENCODE_MIMO_DEFAULT_BASE_URL);
assert.equal(normalizeOpenCodeMimoBaseUrl(''), '');

for (const invalid of [
  'http://token-plan-ams.xiaomimimo.com/v1',
  'https://user:secret@token-plan-ams.xiaomimimo.com/v1',
  'https://token-plan-ams.xiaomimimo.com/v1?key=secret',
  'https://token-plan-ams.xiaomimimo.com/v1#fragment',
  'https://token-plan-ams.xiaomimimo.com',
  'https://api.xiaomimimo.com/v1https://token-plan-ams.xiaomimimo.com/v1',
]) {
  assert.equal(normalizeOpenCodeMimoBaseUrl(invalid), '', `expected URL to be rejected: ${invalid}`);
}

console.log('opencode-mimo-api-key OK');
