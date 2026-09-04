import assert from 'node:assert/strict';
import {
  getCodexApiKeyFromEnv,
  getEffectiveCodexApiKey,
  getCodexApiKeyMetaForClient,
  buildCodexProcessEnv,
} from '../lib/codex/codex-api-key.js';

const previous = process.env.CODEX_API_KEY;
process.env.CODEX_API_KEY = 'codex-test-key';

try {
  assert.equal(getCodexApiKeyFromEnv(), 'codex-test-key');
  assert.equal(getEffectiveCodexApiKey(), 'codex-test-key');
  const meta = getCodexApiKeyMetaForClient();
  assert.equal(meta.codexApiKeyEffective, true);
  assert.equal(meta.codexApiKeyFromEnv, true);
  assert.equal(typeof meta.codexApiKeyStoredInSettings, 'boolean');
} finally {
  if (typeof previous === 'string') process.env.CODEX_API_KEY = previous;
  else delete process.env.CODEX_API_KEY;
}

delete process.env.CODEX_API_KEY;
const withoutEnv = getCodexApiKeyMetaForClient();
assert.equal(withoutEnv.codexApiKeyFromEnv, false);
assert.equal(typeof withoutEnv.codexApiKeyEffective, 'boolean');

process.env.CODEX_API_KEY = 'codex-test-key';
process.env.OPENAI_API_KEY = 'openai-should-not-leak';
const chatgptEnv = buildCodexProcessEnv({ forceChatGpt: true });
assert.equal(chatgptEnv.CODEX_API_KEY, undefined);
assert.equal(chatgptEnv.OPENAI_API_KEY, undefined);
delete process.env.CODEX_API_KEY;
delete process.env.OPENAI_API_KEY;

console.log('codex-api-key.test.js OK');
