import assert from 'node:assert/strict';
import {
  PAGE_RESUME_FINALIZE_MS,
  PAGE_RESUME_LOG_TAG,
  buildPageResumeLogPayload,
  computePageResumeDurations,
  createPageResumeTrace,
  formatResumeReadyState,
  markPageResumeProbeTimeout,
  markPageResumeStage,
  notePageResumeFirstMessage,
  setPageResumeDecision,
} from '../app_front/features/chat/pageResumeTrace.js';

assert.equal(PAGE_RESUME_LOG_TAG, 'page-resume');
assert.equal(PAGE_RESUME_FINALIZE_MS, 10000);

assert.equal(formatResumeReadyState(0), 'connecting');
assert.equal(formatResumeReadyState(1), 'open');
assert.equal(formatResumeReadyState(2), 'closing');
assert.equal(formatResumeReadyState(3), 'closed');
assert.equal(formatResumeReadyState(undefined), 'none');

const trace = createPageResumeTrace({
  chatId: 'chat-a',
  reason: 'visibility',
  backgroundMs: 30000,
  mobile: true,
  readyState: 1,
  startedAt: 1000,
});
assert.equal(trace.readyStateBefore, 'open');
assert.equal(trace.decision, 'unknown');
assert.equal(trace.probeTimedOut, false);
assert.equal(trace.logged, false);

markPageResumeStage(trace, 'decision', 1010);
setPageResumeDecision(trace, 'probe');
markPageResumeStage(trace, 'cachedRender', 1005);
markPageResumeStage(trace, 'probeSent', 1012);
markPageResumeStage(trace, 'wsOpen', 1500);
notePageResumeFirstMessage(trace, 'pong', 1600);
notePageResumeFirstMessage(trace, 'hello', 1700);
assert.equal(trace.firstMessageType, 'pong', 'Only the first server frame is recorded');
markPageResumeStage(trace, 'replayEnd', 2500);
markPageResumeStage(trace, 'catchUp', 2600);
markPageResumeStage(trace, 'uiReady', 2700);
markPageResumeProbeTimeout(trace);

assert.deepEqual(computePageResumeDurations(trace), {
  decisionMs: 10,
  cachedRenderMs: 5,
  probeSentMs: 12,
  wsOpenMs: 500,
  firstMessageMs: 600,
  replayEndMs: 1500,
  catchUpMs: 1600,
  uiReadyMs: 1700,
  totalMs: 1700,
});

const payload = buildPageResumeLogPayload(trace, 'catch_up_complete');
assert.equal(payload.chatId, 'chat-a');
assert.equal(payload.reason, 'visibility');
assert.equal(payload.mobile, true);
assert.equal(payload.notification, false);
assert.equal(payload.backgroundMs, 30000);
assert.equal(payload.readyStateBefore, 'open');
assert.equal(payload.decision, 'probe');
assert.equal(payload.probeTimedOut, true);
assert.equal(payload.firstMessageType, 'pong');
assert.equal(payload.completedBy, 'catch_up_complete');
assert.equal(payload.durations.totalMs, 1700);

const empty = createPageResumeTrace({ chatId: 'chat-b', reason: 'notification' });
assert.equal(empty.notification, true);
assert.equal(empty.startedAt > 0, true);
assert.deepEqual(buildPageResumeLogPayload(empty, 'deadline').durations, {
  decisionMs: null,
  cachedRenderMs: null,
  probeSentMs: null,
  wsOpenMs: null,
  firstMessageMs: null,
  replayEndMs: null,
  catchUpMs: null,
  uiReadyMs: null,
  totalMs: 0,
});

console.log('All page-resume-trace tests passed.');
