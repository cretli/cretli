import assert from 'node:assert/strict';
import { getGithubTokenFromGhCli, isGithubGhCliFallbackEnabled } from '../lib/github-token.js';

const previousFallbackEnv = process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK;

delete process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK;
assert.equal(isGithubGhCliFallbackEnabled(), true);

process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK = '0';
assert.equal(isGithubGhCliFallbackEnabled(), false);

process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK = '1';
let callCount = 0;
const inputRunner = () => {
  callCount += 1;
  return { status: 0, stdout: 'ghp_test_token\n' };
};
const actualToken = getGithubTokenFromGhCli({ runner: inputRunner, nowMs: 1, forceRefresh: true });
assert.equal(actualToken, 'ghp_test_token');

const cachedToken = getGithubTokenFromGhCli({ runner: inputRunner, nowMs: 2 });
assert.equal(cachedToken, 'ghp_test_token');
assert.equal(callCount, 1);

const failedToken = getGithubTokenFromGhCli({
  runner: () => ({ status: 1, stdout: '', stderr: 'not logged in' }),
  nowMs: 3,
  forceRefresh: true,
});
assert.equal(failedToken, '');

if (typeof previousFallbackEnv === 'string') {
  process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK = previousFallbackEnv;
} else {
  delete process.env.CURSOR_REMOTE_GH_CLI_TOKEN_FALLBACK;
}

console.log('All github-token tests passed.');
