import assert from 'node:assert/strict';
import {
  buildStuckRunRecoveryMessage,
  buildStuckRunRecoveryRetryMessage,
  isSdkRunAutoRecoveryEnabled,
  resolveSdkRunAutoRecoveryEnabled,
  resolveSdkRunAutoRecoveryGraceMs,
  resolveSdkRunStuckRecoveryCapMs,
  SDK_RUN_AUTO_RECOVERY_GRACE_MS,
  SDK_RUN_STUCK_RECOVERY_CAP_MS,
  shouldRetryStuckRunRecovery,
  shouldTriggerStuckRunRecovery,
} from '../lib/sdk/sdk-run-auto-recovery.js';

assert.equal(shouldRetryStuckRunRecovery(1), false);
assert.equal(resolveSdkRunAutoRecoveryGraceMs(''), SDK_RUN_AUTO_RECOVERY_GRACE_MS);
assert.equal(resolveSdkRunAutoRecoveryGraceMs('30000'), 30000);

const previousEnv = process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY;
delete process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY;
assert.equal(resolveSdkRunAutoRecoveryEnabled({ sdkRunAutoRecovery: false }), false);
assert.equal(resolveSdkRunAutoRecoveryEnabled({ sdkRunAutoRecovery: true }), true);
assert.equal(resolveSdkRunAutoRecoveryEnabled(null), true);

process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY = '1';
assert.equal(isSdkRunAutoRecoveryEnabled(), true);
assert.equal(resolveSdkRunStuckRecoveryCapMs('', null), SDK_RUN_STUCK_RECOVERY_CAP_MS);
assert.equal(
  resolveSdkRunStuckRecoveryCapMs('', { sdkRunStuckRecoveryCapSeconds: 90 }),
  90000
);
assert.equal(shouldTriggerStuckRunRecovery(360000, 300000, 60000), true);
assert.equal(
  shouldTriggerStuckRunRecovery(350000, 300000, 60000),
  true,
  'Cap applies even when below original budget + grace'
);
assert.equal(
  shouldTriggerStuckRunRecovery(170000, 300000, 60000),
  false,
  'Just below cap + grace should not trigger recovery'
);
assert.equal(
  shouldTriggerStuckRunRecovery(SDK_RUN_STUCK_RECOVERY_CAP_MS + 60000, 3000000, 60000),
  true,
  'Large idle budget must not delay stuck recovery past cap + grace'
);
assert.equal(
  shouldTriggerStuckRunRecovery(SDK_RUN_STUCK_RECOVERY_CAP_MS + 30000, 3000000, 60000),
  false,
  'Below cap + grace should not trigger recovery'
);
assert.match(buildStuckRunRecoveryMessage(360000, 300000), /Auto-recovery triggered/);
assert.match(buildStuckRunRecoveryRetryMessage(1), /retrying/i);
assert.equal(shouldRetryStuckRunRecovery(0), true);

process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY = '0';
assert.equal(isSdkRunAutoRecoveryEnabled(), false);
assert.equal(shouldTriggerStuckRunRecovery(999999, 300000, 60000), false);

if (previousEnv === undefined) {
  delete process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY;
} else {
  process.env.CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY = previousEnv;
}

console.log('All sdk-run-auto-recovery tests passed.');
