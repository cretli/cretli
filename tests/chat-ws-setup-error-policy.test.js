import assert from 'node:assert/strict';
import {
  isSdkSetupErrorCode,
  isSdkSetupErrorCoolingDown,
  resolveSdkSetupErrorRetryMs,
} from '../app_front/features/chat/chatWsReconnectPolicy.js';

assert.equal(isSdkSetupErrorCode('missing_api_key'), true);
assert.equal(isSdkSetupErrorCode('missing_cli'), true);
assert.equal(isSdkSetupErrorCode('missing_subscription'), true);
assert.equal(isSdkSetupErrorCode('no_cwd'), true);
assert.equal(isSdkSetupErrorCode('deepseek_error'), false);
assert.equal(isSdkSetupErrorCode(undefined), false);

assert.equal(resolveSdkSetupErrorRetryMs(1), 30_000);
assert.equal(resolveSdkSetupErrorRetryMs(2), 60_000);
assert.equal(resolveSdkSetupErrorRetryMs(3), 120_000);
assert.equal(resolveSdkSetupErrorRetryMs(50), 600_000);

const now = 1_000_000;
assert.equal(isSdkSetupErrorCoolingDown({}, now), false);
assert.equal(isSdkSetupErrorCoolingDown({ _sdkSetupErrorAt: now - 1_000, _sdkSetupErrorCount: 1 }, now), true);
assert.equal(isSdkSetupErrorCoolingDown({ _sdkSetupErrorAt: now - 31_000, _sdkSetupErrorCount: 1 }, now), false);
assert.equal(isSdkSetupErrorCoolingDown({ _sdkSetupErrorAt: now - 31_000, _sdkSetupErrorCount: 2 }, now), true);

console.log('chat-ws-setup-error-policy.test.js: ok');
