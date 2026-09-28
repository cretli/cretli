import assert from 'node:assert/strict';
import {
  buildStableSdkToolCallFallback,
  canonicalizeSdkToolStatus,
  findOpenSdkToolRecord,
  getRunningSdkToolCallCount,
  hasRunningSdkTools,
  isEmptyGenericSdkToolEvent,
  isOpenSdkToolStatus,
  isRunningSdkToolStatus,
  isTerminalSdkRunStatus,
  isTerminalSdkToolStatus,
  shouldKeepSdkThinkingSpinner,
  normalizeSdkCallId,
  normalizeSdkToolStreamEvent,
  resolveAbandonedToolStatus,
  resolveSdkToolCallId,
  setRunningSdkToolCallCount,
  shouldAcceptSdkToolStatus,
  updateRunningSdkToolState,
} from '../lib/sdk/sdk-thinking-state.js';
import { extractTodoSummaryFromToolEvent } from '../lib/sdk/sdk-todo-summary.js';

const runningByRun = new Map();

assert.equal(isRunningSdkToolStatus('running'), true);
assert.equal(isRunningSdkToolStatus(' RUNNING '), true);
assert.equal(isRunningSdkToolStatus('completed'), false);
assert.equal(isOpenSdkToolStatus('running'), true);
assert.equal(isOpenSdkToolStatus('pending'), true);
assert.equal(isOpenSdkToolStatus('started'), true);
assert.equal(isOpenSdkToolStatus('in_progress'), true);
assert.equal(isOpenSdkToolStatus(''), true);
assert.equal(isOpenSdkToolStatus('completed'), false);
assert.equal(isRunningSdkToolStatus('started'), true);
assert.equal(isRunningSdkToolStatus('in_progress'), true);
assert.equal(isRunningSdkToolStatus('pending'), false);
assert.equal(isTerminalSdkToolStatus('completed'), true);
assert.equal(isTerminalSdkToolStatus('cancelled'), true);
assert.equal(isTerminalSdkToolStatus('running'), false);
assert.equal(isTerminalSdkRunStatus('FINISHED'), true);
assert.equal(isTerminalSdkRunStatus('error'), true);
assert.equal(isTerminalSdkRunStatus('RUNNING'), false);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'run-1',
  activeKind: 'thinking',
  activeThinkingRunKey: 'run-1',
  runStatus: 'FINISHED',
  hasRunningTools: true,
}), false);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'run-1',
  activeKind: 'thinking',
  activeThinkingRunKey: 'run-1',
  suppressHistoryPersist: false,
  runStatus: 'RUNNING',
  hasRunningTools: false,
}), true);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'run-1',
  activeKind: 'assistant',
  activeThinkingRunKey: '',
  runStatus: 'RUNNING',
  hasRunningTools: true,
}), true);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'run-1',
  activeKind: 'thinking',
  activeThinkingRunKey: 'run-1',
  suppressHistoryPersist: true,
  runStatus: 'RUNNING',
  hasRunningTools: false,
}), false);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'local-run-9',
  activeKind: 'thinking',
  activeThinkingRunKey: 'local-run-9',
  suppressHistoryPersist: false,
  hasRunningTools: false,
  isLiveTurn: false,
}), false);
assert.equal(shouldKeepSdkThinkingSpinner({
  runKey: 'run-1',
  activeKind: 'thinking',
  activeThinkingRunKey: 'run-1',
  suppressHistoryPersist: false,
  runStatus: 'RUNNING',
  hasRunningTools: false,
  isLiveTurn: true,
}), true);
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
assert.equal(resolveSdkToolCallId({ callId: 'camel-3' }), 'camel-3');
assert.equal(resolveSdkToolCallId({ call_id: '  call-1  ', toolCallId: 'tc-2' }), 'call-1');
assert.equal(resolveSdkToolCallId({ call_id: 'call-aaa-0\nfc_bbb_0' }), 'call-aaa-0');
assert.equal(normalizeSdkCallId('call-aaa-0\nfc_bbb_0'), 'call-aaa-0');
assert.equal(resolveSdkToolCallId({}, 'fallback-id'), 'fallback-id');
assert.equal(normalizeSdkToolStreamEvent({
  type: 'sdk_message',
  message: { type: 'tool_call', name: 'read', call_id: 'inner-1' },
})?.call_id, 'inner-1');
assert.equal(normalizeSdkToolStreamEvent({
  type: 'tool_use',
  id: 'use-1',
  name: 'read',
  input: { path: '/tmp/a.js' },
})?.type, 'tool_call');
assert.equal(normalizeSdkToolStreamEvent({
  type: 'tool_result',
  tool_use_id: 'use-1',
  content: 'ok',
})?.call_id, 'use-1');

const openReadA = {
  callId: 'call-a',
  runKey: 'run-1',
  event: { name: 'read', status: 'running', args: { path: '/tmp/sdk-rich-view.js' } },
};
const openReadB = {
  callId: 'call-b',
  runKey: 'run-1',
  event: { name: 'read', status: 'running', args: { path: '/tmp/other.js' } },
};
assert.equal(findOpenSdkToolRecord([openReadA, openReadB], {
  callId: 'call-a',
  name: 'read',
  args: { path: '/tmp/sdk-rich-view.js' },
  runKey: 'run-1',
  status: 'running',
}), openReadA);
assert.equal(findOpenSdkToolRecord([openReadA, openReadB], {
  callId: 'call-c',
  name: 'read',
  args: { path: '/tmp/sdk-rich-view.js' },
  runKey: 'run-1',
  status: 'running',
}), null);
assert.equal(findOpenSdkToolRecord([openReadA, openReadB], {
  callId: 'call-c',
  name: 'read',
  args: { path: '/tmp/sdk-rich-view.js' },
  runKey: 'run-1',
  status: 'completed',
  result: { content: 'ok' },
}), openReadA);
assert.equal(findOpenSdkToolRecord([openReadA, openReadB], {
  callId: 'call-aaa-0',
  name: 'read',
  args: { path: '/tmp/sdk-rich-view.js' },
  runKey: 'run-1',
  status: 'completed',
}), openReadA);
assert.equal(findOpenSdkToolRecord([{
  callId: 'call-aaa-0',
  runKey: 'run-1',
  event: { name: 'glob', status: 'running', args: { globPattern: '**/*' } },
}], {
  callId: 'call-aaa-0',
  name: 'glob',
  args: { globPattern: '**/*' },
  runKey: 'run-1',
  status: 'completed',
})?.callId, 'call-aaa-0');
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
const expectedFallbackId = 'run-1:glob:globPattern:*.txt|targetDirectory:/tmp/terminals';
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

assert.equal(canonicalizeSdkToolStatus({ status: 'success' }), 'completed');
assert.equal(canonicalizeSdkToolStatus({ status: 'ok' }), 'completed');
assert.equal(canonicalizeSdkToolStatus({ status: 'done' }), 'completed');
assert.equal(canonicalizeSdkToolStatus({ status: 'finished' }), 'completed');
assert.equal(canonicalizeSdkToolStatus({
  status: 'running',
  result: { value: { todos: [{ id: '1', content: 'x', status: 'pending' }] } },
}), 'completed');
assert.equal(canonicalizeSdkToolStatus({ status: 'running' }), 'running');
assert.equal(canonicalizeSdkToolStatus({
  status: 'error',
  result: { status: 'success' },
}), 'error');
assert.equal(canonicalizeSdkToolStatus({
  status: 'cancelled',
  result: { status: 'success' },
}), 'cancelled');
assert.equal(canonicalizeSdkToolStatus({
  status: 'canceled',
  result: { status: 'success' },
}), 'cancelled');
assert.equal(canonicalizeSdkToolStatus({
  status: 'running',
  result: { error: 'denied' },
}), 'error');
assert.equal(canonicalizeSdkToolStatus({
  status: 'running',
  result: { status: 'error' },
}), 'error');
assert.equal(canonicalizeSdkToolStatus({ result: { success: false } }), 'completed');
assert.equal(shouldAcceptSdkToolStatus('running', 'success'), true);
assert.equal(shouldAcceptSdkToolStatus(
  'running',
  canonicalizeSdkToolStatus({ status: 'success' })
), true);
assert.equal(shouldAcceptSdkToolStatus('cancelled', 'success'), false);
assert.equal(shouldAcceptSdkToolStatus(
  'cancelled',
  canonicalizeSdkToolStatus({ status: 'success' })
), true);

const inputArgsTodos = [{ content: 'from-args', status: 'in_progress' }];
assert.equal(extractTodoSummaryFromToolEvent({
  args: { todos: inputArgsTodos },
  result: { todos: [] },
}), '');
assert.equal(extractTodoSummaryFromToolEvent({
  args: { todos: inputArgsTodos },
  result: { value: { todos: [] } },
}), '');
assert.equal(extractTodoSummaryFromToolEvent({
  args: { todos: inputArgsTodos },
  result: { value: { files: [] } },
}), '[in_progress] from-args');
assert.equal(extractTodoSummaryFromToolEvent({
  args: { todos: [{ content: 'old', status: 'pending' }] },
  result: { value: { todos: [{ content: 'from-result', status: 'completed' }] } },
}), '[completed] from-result');
assert.equal(extractTodoSummaryFromToolEvent({
  args: { todos: [{ content: 'old', status: 'pending' }] },
  result: { todos: [{ content: 'from-result-todos', status: 'completed' }] },
}), '[completed] from-result-todos');

console.log('All sdk-thinking-state tests passed.');
