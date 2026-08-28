import assert from 'node:assert/strict';
import {
  computeSetupRetryDelayMs,
  SDK_AUTH_RECOVERY_RETRY_DELAY_MS,
  SDK_SETUP_RETRY_BASE_DELAY_MS,
  schedulePendingPromptRun,
} from '../lib/sdk/sdk-retry-delay.js';

assert.equal(computeSetupRetryDelayMs(1), SDK_SETUP_RETRY_BASE_DELAY_MS);
assert.equal(computeSetupRetryDelayMs(2), SDK_SETUP_RETRY_BASE_DELAY_MS * 2);
assert.equal(SDK_AUTH_RECOVERY_RETRY_DELAY_MS >= 2000, true);

let scheduled = 0;
schedulePendingPromptRun({ text: 'hi', mode: 'agent', clientSentAt: null, scheduleAfterMs: 0 }, () => {
  scheduled += 1;
});
queueMicrotask(() => {
  assert.equal(scheduled, 1);
  console.log('All sdk-retry-delay tests passed.');
});
