import assert from 'node:assert/strict';
import {
  buildSetupRetryMessage,
  SETUP_FAILURE_MAX_RETRIES,
  shouldRetrySetupFailure,
} from '../lib/sdk/sdk-setup-retry.js';

assert.equal(shouldRetrySetupFailure(0), true);
assert.equal(shouldRetrySetupFailure(1), true);
assert.equal(shouldRetrySetupFailure(2), false);
assert.equal(shouldRetrySetupFailure(2, 3), true);
assert.equal(buildSetupRetryMessage(1), 'Agent setup failed. Retrying (1/2)…');
assert.equal(typeof SETUP_FAILURE_MAX_RETRIES, 'number');

console.log('All sdk-setup-retry tests passed.');
