import assert from 'node:assert/strict';
import {
  buildSdkRunFailureDetail,
  extractSdkStreamStatusError,
  isSdkRunFailureStatus,
  normalizeSdkRunStatus,
  readSdkRoomRunOutcome,
  resolveSdkRunFailureDetail,
  trackSdkRoomRunOutcome,
} from '../lib/sdk/sdk-run-outcome.js';

assert.equal(isSdkRunFailureStatus('error'), true);
assert.equal(isSdkRunFailureStatus('finished'), false);
assert.equal(isSdkRunFailureStatus('completed'), false);
assert.equal(isSdkRunFailureStatus('cancelled'), true);
assert.equal(normalizeSdkRunStatus('finished'), 'completed');
assert.equal(normalizeSdkRunStatus('plan_guard_cancelled'), 'cancelled');
assert.equal(normalizeSdkRunStatus('run_setup_failed'), 'error');
assert.equal(buildSdkRunFailureDetail('error', 'boom'), 'boom');
assert.equal(
  buildSdkRunFailureDetail('error', ''),
  'Run ended with error, but SDK returned no details.'
);
assert.equal(buildSdkRunFailureDetail('plan_guard_cancelled', ''), '');
assert.equal(
  resolveSdkRunFailureDetail({ status: 'plan_guard_cancelled', result: '' }),
  ''
);
assert.match(buildSdkRunFailureDetail('cancelled', ''), /cancelled before completion/i);
assert.match(
  buildSdkRunFailureDetail('cancelled', '', { lastErrorCode: 'run_stuck_auto_recovery' }),
  /idle budget/i
);
assert.equal(
  extractSdkStreamStatusError({
    type: 'status',
    status: 'ERROR',
    message: 'Authentication error If you are logged in, try logging out and back in.',
  }),
  'Authentication error If you are logged in, try logging out and back in.'
);
assert.equal(
  resolveSdkRunFailureDetail({
    status: 'error',
    result: '',
    lastErrorMessage: 'Authentication error',
  }),
  'Authentication error'
);
assert.match(
  resolveSdkRunFailureDetail({
    status: 'cancelled',
    result: '',
    lastErrorCode: 'run_cancelled',
  }),
  /cancelled before completion/i
);

const room = {};
trackSdkRoomRunOutcome(room, {
  type: 'sdkRunFinished',
  runId: 'run-1',
  status: 'error',
  result: 'Authentication error',
  lastErrorCode: 'cursor_auth_error',
  lastErrorMessage: 'Authentication error',
});
trackSdkRoomRunOutcome(room, {
  type: 'sdkError',
  code: 'run_failed',
  message: 'Agent crashed',
});
assert.deepEqual(readSdkRoomRunOutcome(room), {
  lastRunId: 'run-1',
  lastRunStatus: 'error',
  lastRunStatusNormalized: 'error',
  lastErrorCode: 'cursor_auth_error',
  lastErrorMessage: 'Authentication error',
});

console.log('All sdk-run-outcome tests passed.');
