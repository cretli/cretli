import assert from 'node:assert/strict';
import {
  DEEPSEEK_EMPTY_RUN_ERROR,
  hasDeepSeekAssistantText,
  hasDeepSeekTurnWork,
  isDeepSeekSessionCollision,
  pinDeepSeekRootSessionId,
  readDeepSeekTurnEndError,
  readDeepSeekTurnEndReason,
  resolveDeepSeekRunStatus,
  shouldRetryDeepSeekRunWithoutSession,
} from '../lib/deepseek/deepseek-run-outcome.js';

const ROOT = 'session-root';
const CHILD = 'session-child';
const inputCollisionMessage = `session "${ROOT}" already has a persisted log on disk that does not match this live session (id collision)`;

const textMessage = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
});
const turnEnd = (reason) => ({ type: 'turn/end', data: { turn: 1, reason } });
const sessionEvent = (sessionId, event) => ({ method: 'session.event', params: { sessionId, event } });

const inputCollisionResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [turnEnd({ kind: 'error', error: { message: inputCollisionMessage, code: 'UNKNOWN' } })],
};
const inputOtherErrorResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [turnEnd({ kind: 'error', error: { message: 'provider overloaded', code: 'UNKNOWN' } })],
};
const inputEmptyIdleResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [{ type: 'agent/inbox/spliced', data: { inserted: [] } }],
  notifications: [{ method: 'session.status', params: { sessionId: ROOT, status: 'idle' } }],
};
const inputCompletedResult = {
  finalResponse: 'hello',
  sessionId: ROOT,
  events: [textMessage('hello'), turnEnd({ kind: 'completed' })],
};
const inputAssistantOnlyResult = {
  finalResponse: 'hello',
  sessionId: ROOT,
  events: [textMessage('hello')],
};
const inputReasoningOnlyResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [{ type: 'assistant/chunk', data: { chunk: { type: 'reasoning', text: 'thinking' } } }],
};
const inputToolResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [{ type: 'tool/call', data: { name: 'bash' } }],
};
const inputCollisionAfterWorkResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [
    { type: 'tool/call', data: { name: 'bash' } },
    turnEnd({ kind: 'error', error: { message: inputCollisionMessage, code: 'UNKNOWN' } }),
  ],
};
// Root succeeded while a workflow child hit the session collision. The child
// must not turn the parent turn into an error or force a replay.
const inputChildCollisionResult = {
  finalResponse: 'parent answer',
  sessionId: ROOT,
  events: [textMessage('parent answer'), turnEnd({ kind: 'completed' })],
  notifications: [sessionEvent(CHILD, turnEnd({ kind: 'error', error: { message: inputCollisionMessage } }))],
};
const inputNotificationCollision = {
  finalResponse: '',
  sessionId: ROOT,
  events: [],
  notifications: [
    sessionEvent(ROOT, turnEnd({ kind: 'error', error: { message: inputCollisionMessage, code: 'UNKNOWN' } })),
  ],
};

assert.equal(isDeepSeekSessionCollision(inputCollisionMessage), true);
assert.equal(isDeepSeekSessionCollision('provider overloaded'), false);

// Root terminal reason, scoped to the root session.
assert.equal(String(readDeepSeekTurnEndReason(inputCompletedResult, { rootSessionId: ROOT })?.kind), 'completed');
assert.equal(readDeepSeekTurnEndError(inputCollisionResult, { rootSessionId: ROOT }), inputCollisionMessage);
assert.equal(readDeepSeekTurnEndError(inputOtherErrorResult, { rootSessionId: ROOT }), 'provider overloaded');
assert.equal(readDeepSeekTurnEndError(inputCompletedResult, { rootSessionId: ROOT }), '');
assert.equal(readDeepSeekTurnEndError(inputChildCollisionResult, { rootSessionId: ROOT }), '');
assert.equal(readDeepSeekTurnEndError(inputNotificationCollision, { rootSessionId: ROOT }), inputCollisionMessage);

// A delivered answer, and real side effects, are distinct from reasoning deltas.
assert.equal(hasDeepSeekAssistantText(inputCompletedResult, { rootSessionId: ROOT }), true);
assert.equal(hasDeepSeekAssistantText(inputReasoningOnlyResult, { rootSessionId: ROOT }), false);
assert.equal(hasDeepSeekTurnWork(inputCompletedResult, { rootSessionId: ROOT }), true);
assert.equal(hasDeepSeekTurnWork(inputToolResult, { rootSessionId: ROOT }), true);
assert.equal(hasDeepSeekTurnWork(inputReasoningOnlyResult, { rootSessionId: ROOT }), false);

// Retry only on a proven collision, once, and never after side effects.
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputCollisionResult, ROOT, { rootSessionId: ROOT }), true);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputCollisionResult, ''), false);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputOtherErrorResult, ROOT, { rootSessionId: ROOT }), false);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputEmptyIdleResult, ROOT, { rootSessionId: ROOT }), false);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputCompletedResult, ROOT, { rootSessionId: ROOT }), false);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputCollisionAfterWorkResult, ROOT, { rootSessionId: ROOT }), false);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputNotificationCollision, ROOT, { rootSessionId: ROOT }), true);
assert.equal(shouldRetryDeepSeekRunWithoutSession(inputChildCollisionResult, ROOT, { rootSessionId: ROOT }), false);

assert.deepEqual(resolveDeepSeekRunStatus(inputCollisionResult, { rootSessionId: ROOT }), {
  status: 'error',
  errorMessage: inputCollisionMessage,
  reasonKind: 'error',
  isSessionCollision: true,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputOtherErrorResult, { rootSessionId: ROOT }), {
  status: 'error',
  errorMessage: 'provider overloaded',
  reasonKind: 'error',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputEmptyIdleResult, { rootSessionId: ROOT }), {
  status: 'error',
  errorMessage: DEEPSEEK_EMPTY_RUN_ERROR,
  reasonKind: '',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputReasoningOnlyResult, { rootSessionId: ROOT }), {
  status: 'error',
  errorMessage: DEEPSEEK_EMPTY_RUN_ERROR,
  reasonKind: '',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputToolResult, { rootSessionId: ROOT }), {
  status: 'error',
  errorMessage: DEEPSEEK_EMPTY_RUN_ERROR,
  reasonKind: '',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputCompletedResult, { rootSessionId: ROOT }), {
  status: 'completed',
  errorMessage: '',
  reasonKind: 'completed',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputAssistantOnlyResult, { rootSessionId: ROOT }), {
  status: 'completed',
  errorMessage: '',
  reasonKind: '',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputChildCollisionResult, { rootSessionId: ROOT }), {
  status: 'completed',
  errorMessage: '',
  reasonKind: 'completed',
  isSessionCollision: false,
});
assert.deepEqual(resolveDeepSeekRunStatus(inputChildCollisionResult), {
  status: 'completed',
  errorMessage: '',
  reasonKind: 'completed',
  isSessionCollision: false,
});

const inputChildOnlyTextResult = {
  finalResponse: '',
  sessionId: ROOT,
  events: [],
  notifications: [
    sessionEvent(CHILD, textMessage('child answer')),
    sessionEvent(CHILD, turnEnd({ kind: 'completed' })),
  ],
};
assert.equal(hasDeepSeekAssistantText(inputChildOnlyTextResult), false);
assert.deepEqual(resolveDeepSeekRunStatus(inputChildOnlyTextResult), {
  status: 'error',
  errorMessage: DEEPSEEK_EMPTY_RUN_ERROR,
  reasonKind: '',
  isSessionCollision: false,
});

assert.equal(pinDeepSeekRootSessionId({
  roomRootId: ROOT,
  usedSessionId: ROOT,
  resultSessionId: CHILD,
  childSessionIds: [CHILD],
}), ROOT);
assert.equal(pinDeepSeekRootSessionId({
  roomRootId: '',
  usedSessionId: ROOT,
  resultSessionId: CHILD,
  childSessionIds: new Set([CHILD]),
}), ROOT);

assert.deepEqual(
  resolveDeepSeekRunStatus({ finalResponse: '', sessionId: ROOT, events: [turnEnd({ kind: 'aborted', reason: { kind: 'user' } })] }, { rootSessionId: ROOT }),
  { status: 'cancelled', errorMessage: 'DeepSeek turn was cancelled (user).', reasonKind: 'aborted', isSessionCollision: false },
);
assert.equal(
  resolveDeepSeekRunStatus({ finalResponse: '', sessionId: ROOT, events: [turnEnd({ kind: 'blocked' })] }, { rootSessionId: ROOT }).status,
  'error',
);
assert.match(
  resolveDeepSeekRunStatus({ finalResponse: '', sessionId: ROOT, events: [turnEnd({ kind: 'max-tokens' })] }, { rootSessionId: ROOT }).errorMessage,
  /output-token/,
);
assert.equal(
  resolveDeepSeekRunStatus({ finalResponse: '', sessionId: ROOT, events: [turnEnd({ kind: 'brand-new-reason' })] }, { rootSessionId: ROOT }).status,
  'error',
);

console.log('deepseek-run-outcome.test.js OK');
