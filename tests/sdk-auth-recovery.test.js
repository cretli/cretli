import assert from 'node:assert/strict';
import {
  buildSdkAuthRecoveryRetryMessage,
  buildSdkRateLimitRecoveryRetryMessage,
  isSdkAuthenticationError,
  isSdkRateLimitError,
  shouldRetrySdkAuthRecovery,
  shouldRetrySdkRateLimitRecovery,
} from '../lib/sdk/sdk-auth-recovery.js';

assert.equal(
  isSdkAuthenticationError('Authentication error If you are logged in, try logging out and back in.'),
  true
);
assert.equal(isSdkAuthenticationError('network timeout'), false);
assert.equal(isSdkRateLimitError('You have exceeded the rate limit of 30 requests per minute.'), true);
assert.equal(isSdkRateLimitError('[resource_exhausted] Error'), true);
assert.equal(isSdkRateLimitError('RESOURCE_EXHAUSTED'), true);
assert.equal(isSdkAuthenticationError('You have exceeded the rate limit of 30 requests per minute.'), false);
assert.equal(shouldRetrySdkAuthRecovery(0), true);
assert.equal(shouldRetrySdkAuthRecovery(1), false);
assert.equal(shouldRetrySdkRateLimitRecovery(0), true);
assert.equal(shouldRetrySdkRateLimitRecovery(1), false);
assert.match(buildSdkAuthRecoveryRetryMessage(1), /retrying the prompt/i);
assert.match(buildSdkRateLimitRecoveryRetryMessage(1), /retrying your prompt/i);

console.log('All sdk-auth-recovery tests passed.');
