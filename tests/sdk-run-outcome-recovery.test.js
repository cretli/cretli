import assert from 'node:assert/strict';
import {
  DELEGATION_FINAL_REPORT_ERROR_CODE,
  resolveSdkRunFailureDetail,
} from '../lib/sdk/sdk-run-outcome.js';
import {
  extractSdkRunOutcomeSnapshot,
  maybeRecoverMissedSdkRunOutcome,
} from '../app_front/features/chat/sdkRunOutcomeRecovery.js';

function createView() {
  return {
    appendRunFinishedCalls: [],
    appendMetaNoticeCalls: [],
    appendErrorCalls: [],
    appendRunFinished(status) {
      this.appendRunFinishedCalls.push(status);
    },
    appendMetaNotice(text) {
      this.appendMetaNoticeCalls.push(text);
    },
    appendError(text) {
      this.appendErrorCalls.push(text);
    },
  };
}

function createChat(view) {
  return { _sdkRichView: view };
}

{
  const view = createView();
  const chat = createChat(view);
  const snapshot = extractSdkRunOutcomeSnapshot({
    type: 'sdkRoomState',
    busy: false,
    hasCurrentRun: false,
    lastRunId: 'run-accepted',
    lastRunStatus: 'completed',
    lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE,
    lastRunResult: '',
  });
  const recovered = maybeRecoverMissedSdkRunOutcome(chat, snapshot);
  assert.equal(recovered, false);
  assert.deepEqual(view.appendRunFinishedCalls, []);
  assert.deepEqual(view.appendMetaNoticeCalls, []);
  assert.deepEqual(view.appendErrorCalls, []);
}

{
  const view = createView();
  const chat = createChat(view);
  const snapshot = extractSdkRunOutcomeSnapshot({
    type: 'sdkRoomState',
    busy: false,
    hasCurrentRun: false,
    lastRunId: 'run-accepted',
    lastRunStatus: 'cancelled',
    lastErrorCode: DELEGATION_FINAL_REPORT_ERROR_CODE,
    lastRunResult: '',
  });
  const failureDetail = resolveSdkRunFailureDetail({
    status: snapshot.lastRunStatus,
    result: snapshot.lastRunResult,
    lastErrorCode: snapshot.lastErrorCode,
  });
  assert.equal(failureDetail, '');
  const recovered = maybeRecoverMissedSdkRunOutcome(chat, snapshot);
  assert.equal(recovered, true);
  assert.deepEqual(view.appendRunFinishedCalls, ['cancelled']);
  assert.deepEqual(view.appendMetaNoticeCalls, []);
  assert.deepEqual(view.appendErrorCalls, []);
}

console.log('All sdk-run-outcome-recovery tests passed.');
