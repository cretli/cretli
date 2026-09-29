import assert from 'node:assert/strict';
import {
  buildClaudePlanAuthorizeUrl,
  createClaudeCodeChallenge,
  parseClaudeAuthorizationCode,
} from '../lib/claude/claude-plan-login.js';

const challenge = createClaudeCodeChallenge('verifier-value');
assert.equal(challenge.length > 20, true);

const url = new URL(buildClaudePlanAuthorizeUrl({ challenge, state: 'state-1' }));
assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
assert.equal(url.searchParams.get('code_challenge'), challenge);
assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
assert.equal(url.searchParams.get('state'), 'state-1');
assert.equal(url.searchParams.get('response_type'), 'code');

const pasted = parseClaudeAuthorizationCode('abc#state-1', 'state-1');
assert.equal(pasted.ok, true);
if (pasted.ok) assert.equal(pasted.code, 'abc');

const mismatch = parseClaudeAuthorizationCode('abc#other', 'state-1');
assert.equal(mismatch.ok, false);

const fromUrl = parseClaudeAuthorizationCode(
  'https://console.anthropic.com/oauth/code/callback?code=from-url&state=state-1',
  'state-1',
);
assert.equal(fromUrl.ok, true);
if (fromUrl.ok) assert.equal(fromUrl.code, 'from-url');

console.log('claude-plan-login.test.js OK');
