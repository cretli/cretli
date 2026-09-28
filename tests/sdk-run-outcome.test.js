import assert from 'node:assert/strict';
import {
  applyFinalReportQuietStopToPayload,
  applyFinalReportQuietStopToSdkEvent,
  buildSdkRunFailureDetail,
  DELEGATION_FINAL_REPORT_ERROR_CODE,
  extractSdkStreamStatusError,
  isSdkRunFailureStatus,
  normalizeSdkRunStatus,
  persistSdkRunFinishedHistoryStatus,
  presentSdkActivityTrayStatus,
  readSdkRoomRunOutcome,
  resolveSdkRunFailureDetail,
  shouldKeepSdkActivityTrayStatus,
  shouldQuietCompleteAfterFinalReport,
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
assert.equal(
  shouldQuietCompleteAfterFinalReport({
    status: 'cancelled',
    runId: 'run-accepted',
    jobStatus: 'completed',
    finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
    finalReportRunId: 'run-accepted',
  }),
  true
);
assert.equal(
  shouldQuietCompleteAfterFinalReport({
    status: 'cancelled',
    jobStatus: 'completed',
    finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
  }),
  false
);
assert.equal(
  shouldQuietCompleteAfterFinalReport({
    status: 'cancelled',
    runId: 'run-later',
    jobStatus: 'completed',
    finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
    finalReportRunId: 'run-accepted',
  }),
  false
);
assert.equal(
  shouldQuietCompleteAfterFinalReport({
    status: 'cancelled',
    runId: 'run-accepted',
    jobStatus: 'running',
    finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
    finalReportRunId: 'run-accepted',
  }),
  false
);
const quietPayload = {
  type: 'sdkRunFinished',
  runId: 'run-accepted',
  status: 'cancelled',
  result: 'Run was cancelled before completion.',
};
applyFinalReportQuietStopToPayload(quietPayload, {
  jobStatus: 'completed',
  finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
  finalReportRunId: 'run-accepted',
});
assert.equal(
  persistSdkRunFinishedHistoryStatus({
    status: 'completed',
    lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE,
  }),
  'reported'
);
assert.deepEqual(
  presentSdkActivityTrayStatus({
    status: 'cancelled',
    lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE,
  }),
  { datasetStatus: 'reported', terminalStatus: 'completed' }
);
assert.equal(shouldKeepSdkActivityTrayStatus('reported', 'cancelled'), true);
assert.equal(shouldKeepSdkActivityTrayStatus('running', 'cancelled'), false);
const quietStatus = { type: 'status', status: 'cancelled', run_id: 'run-accepted' };
applyFinalReportQuietStopToSdkEvent(quietStatus, {
  jobStatus: 'completed',
  finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
  finalReportRunId: 'run-accepted',
});
assert.equal(quietStatus.status, 'completed');
assert.equal(quietStatus.lastErrorCode, DELEGATION_FINAL_REPORT_ERROR_CODE);
const laterPayload = {
  type: 'sdkRunFinished',
  runId: 'run-later',
  status: 'cancelled',
};
applyFinalReportQuietStopToPayload(laterPayload, {
  jobStatus: 'completed',
  finalReportAcceptedAt: '2026-09-19T13:16:00.000Z',
  finalReportRunId: 'run-accepted',
});
assert.equal(laterPayload.status, 'cancelled');
assert.equal(
  buildSdkRunFailureDetail('cancelled', '', { lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE }),
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
