import assert from 'node:assert/strict';
import {
  buildStableSdkToolCallFallback,
  getRunningSdkToolCallCount,
  hasRunningSdkTools,
  isEmptyGenericSdkToolEvent,
  isOpenSdkToolStatus,
  isRunningSdkToolStatus,
  isTerminalSdkRunStatus,
  isTerminalSdkToolStatus,
  resolveAbandonedToolStatus,
  resolveSdkToolCallId,
  setRunningSdkToolCallCount,
  shouldAcceptSdkToolStatus,
  updateRunningSdkToolState,
} from '../lib/sdk/sdk-thinking-state.js';

const runningByRun = new Map();

assert.equal(isRunningSdkToolStatus('running'), true);
assert.equal(isRunningSdkToolStatus(' RUNNING '), true);
assert.equal(isRunningSdkToolStatus('completed'), false);
assert.equal(isOpenSdkToolStatus('running'), true);
assert.equal(isOpenSdkToolStatus('pending'), true);
assert.equal(isOpenSdkToolStatus(''), true);
assert.equal(isOpenSdkToolStatus('completed'), false);
assert.equal(isTerminalSdkToolStatus('completed'), true);
assert.equal(isTerminalSdkToolStatus('cancelled'), true);
assert.equal(isTerminalSdkToolStatus('running'), false);
assert.equal(isTerminalSdkRunStatus('FINISHED'), true);
assert.equal(isTerminalSdkRunStatus('error'), true);
assert.equal(isTerminalSdkRunStatus('RUNNING'), false);
assert.equal(resolveAbandonedToolStatus('finished'), 'cancelled');
assert.equal(resolveAbandonedToolStatus('COMPLETED'), 'cancelled');
assert.equal(resolveAbandonedToolStatus('error'), 'error');
assert.equal(resolveAbandonedToolStatus('cancelled'), 'error');
assert.equal(shouldAcceptSdkToolStatus('running', 'completed'), true);
assert.equal(shouldAcceptSdkToolStatus('completed', 'running'), false);
assert.equal(shouldAcceptSdkToolStatus('cancelled', 'completed'), true);
assert.equal(shouldAcceptSdkToolStatus('completed', 'cancelled'), false);
assert.equal(shouldAcceptSdkToolStatus('error', 'completed'), false);
assert.equal(shouldAcceptSdkToolStatus('completed', 'error'), true);
assert.equal(resolveSdkToolCallId({ call_id: 'call-1' }), 'call-1');
assert.equal(resolveSdkToolCallId({ toolCallId: 'tc-2' }), 'tc-2');
assert.equal(resolveSdkToolCallId({ call_id: '  call-1  ', toolCallId: 'tc-2' }), 'call-1');
assert.equal(resolveSdkToolCallId({}, 'fallback-id'), 'fallback-id');
assert.equal(isEmptyGenericSdkToolEvent({
  type: 'tool_call',
  name: 'tool',
  status: 'completed',
  call_id: '',
}), true);
assert.equal(isEmptyGenericSdkToolEvent({
  type: 'tool_call',
  name: 'bash',
  status: 'running',
  call_id: 'call-1',
  args: { command: 'ls -la' },
}), false);
assert.equal(isEmptyGenericSdkToolEvent({
  type: 'tool_call',
  name: 'tool',
  status: 'completed',
  call_id: 'call-1',
  result: 'ok',
}), false);
const inputFallbackEvent = {
  name: 'glob',
  args: { globPattern: '*.txt', targetDirectory: '/tmp/terminals' },
};
const expectedFallbackId = 'run-1:glob:globPattern:*.txt';
const actualFallbackId = buildStableSdkToolCallFallback(inputFallbackEvent, 'run-1');
assert.equal(actualFallbackId, expectedFallbackId);
const actualPairedFallbackId = buildStableSdkToolCallFallback(
  { ...inputFallbackEvent, status: 'completed' },
  'run-1'
);
assert.equal(actualPairedFallbackId, expectedFallbackId);

assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 0);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), false);

updateRunningSdkToolState(runningByRun, 'run-1', '', 'running');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 1);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), true);

updateRunningSdkToolState(runningByRun, 'run-1', 'running', 'running');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 1);

updateRunningSdkToolState(runningByRun, 'run-1', 'running', 'completed');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 0);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), false);

updateRunningSdkToolState(runningByRun, 'run-1', 'running', 'error');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 0);

updateRunningSdkToolState(runningByRun, 'run-1', '', 'running');
updateRunningSdkToolState(runningByRun, 'run-1', '', 'running');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 2);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), true);

updateRunningSdkToolState(runningByRun, 'run-1', 'running', 'completed');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 1);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), true);

updateRunningSdkToolState(runningByRun, 'run-1', 'running', 'completed');
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-1'), 0);
assert.equal(hasRunningSdkTools(runningByRun, 'run-1'), false);

setRunningSdkToolCallCount(runningByRun, 'run-2', 3);
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-2'), 3);
setRunningSdkToolCallCount(runningByRun, 'run-2', -10);
assert.equal(getRunningSdkToolCallCount(runningByRun, 'run-2'), 0);

console.log('All sdk-thinking-state tests passed.');
