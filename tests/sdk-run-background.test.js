import assert from 'node:assert/strict';
import {
  SDK_BACKGROUND_DECISIONS,
  canFollowSdkRunToCompletion,
  createSdkBackgroundWorkState,
  decideSdkRunStreamEnd,
  isTerminalSdkRunStatus,
  noteSdkBackgroundWorkEvent,
  noteSdkRunTerminalStatus,
  outstandingSdkBackgroundWork,
  resolveSdkBackgroundFollowupBudgetMs,
} from '../lib/sdk/sdk-run-background.js';

const state = createSdkBackgroundWorkState();
assert.equal(outstandingSdkBackgroundWork(state), 0);

const openEvent = {
  type: 'tool_call',
  name: 'task',
  call_id: 'tc-1',
  result: { value: { isBackground: true, backgroundReason: 'subagent' } },
};
const opened = noteSdkBackgroundWorkEvent(state, openEvent);
assert.equal(opened.opened, 'tc-1');
assert.equal(outstandingSdkBackgroundWork(state), 1);

const settledEvent = {
  type: 'tool_call',
  name: 'task',
  call_id: 'tc-1',
  status: 'completed',
  result: { value: { isBackground: false, backgroundReason: 'subagent' } },
};
const settled = noteSdkBackgroundWorkEvent(state, settledEvent);
assert.equal(settled.settledId, 'tc-1');
assert.equal(outstandingSdkBackgroundWork(state), 0);

assert.equal(isTerminalSdkRunStatus('finished'), true);
assert.equal(isTerminalSdkRunStatus('running'), false);

assert.equal(
  decideSdkRunStreamEnd({ runStatus: 'finished', outstanding: 3 }),
  SDK_BACKGROUND_DECISIONS.FINISH
);
assert.equal(
  decideSdkRunStreamEnd({ runStatus: 'running', outstanding: 0 }),
  SDK_BACKGROUND_DECISIONS.FINISH
);
assert.equal(
  decideSdkRunStreamEnd({ runStatus: 'running', outstanding: 2, canFollow: true, waitedMs: 0, budgetMs: 1000 }),
  SDK_BACKGROUND_DECISIONS.AWAIT
);
assert.equal(
  decideSdkRunStreamEnd({
    runStatus: 'running',
    outstanding: 2,
    canFollow: false,
    waitedMs: 0,
    budgetMs: 1000,
  }),
  SDK_BACKGROUND_DECISIONS.BUDGET_EXCEEDED
);
assert.equal(
  decideSdkRunStreamEnd({
    runStatus: 'running',
    outstanding: 2,
    canFollow: true,
    waitedMs: 2000,
    budgetMs: 1000,
  }),
  SDK_BACKGROUND_DECISIONS.BUDGET_EXCEEDED
);

const fromEnv = resolveSdkBackgroundFollowupBudgetMs(30_000, '120000');
assert.equal(fromEnv, 120_000);
const clamped = resolveSdkBackgroundFollowupBudgetMs(30_000, '1000');
assert.equal(clamped, 60_000);

assert.equal(canFollowSdkRunToCompletion({ wait() {} }), true);
assert.equal(canFollowSdkRunToCompletion(null), false);

const clearedState = createSdkBackgroundWorkState();
clearedState.pending.set('x', { reason: 'r', startedAt: Date.now() });
assert.equal(noteSdkRunTerminalStatus(clearedState), true);
assert.equal(outstandingSdkBackgroundWork(clearedState), 0);

console.log('sdk-run-background.test.js: ok');
