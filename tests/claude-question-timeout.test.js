import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeQuestionResolvedPayload,
  createRoomClaudeCanUseTool,
  handleClaudeOpenCodeQuestionReply,
  resolveClaudeQuestionTimeoutMs,
  sendPendingClaudeQuestionsToClient,
} from '../lib/claude/claude-agent-ws.js';
import {
  armClaudeSessionIdleTimer,
  syncClaudeSessionIdleWithPendingQuestions,
} from '../lib/claude/claude-session.js';

const SAMPLE_TOOL_INPUT = {
  questions: [{
    question: 'Pick one',
    header: 'Test',
    options: [{ label: 'A', description: '' }],
  }],
};

function mkRoom(extra = {}) {
  return {
    clients: new Set(),
    _activeRunMode: 'agent',
    sdkMode: 'agent',
    delegationAssignment: '',
    _pendingQuestions: new Map(),
    _claudeQuestionWaiters: new Map(),
    ...extra,
  };
}

test('resolveClaudeQuestionTimeoutMs defaults to 30 minutes', () => {
  const prev = process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS;
  delete process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS;
  assert.equal(resolveClaudeQuestionTimeoutMs(), 30 * 60 * 1000);
  process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS = '120000';
  assert.equal(resolveClaudeQuestionTimeoutMs(), 120000);
  if (prev === undefined) delete process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS;
  else process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS = prev;
});

test('buildClaudeQuestionResolvedPayload maps timeout to expired status', () => {
  assert.deepEqual(
    buildClaudeQuestionResolvedPayload('req-1', { reject: true, reason: 'timeout' }),
    { type: 'questionResolved', requestId: 'req-1', status: 'expired', reason: 'timeout' },
  );
  assert.deepEqual(
    buildClaudeQuestionResolvedPayload('req-2', { reject: true, reason: 'cancelled' }),
    { type: 'questionResolved', requestId: 'req-2', status: 'cancelled', reason: 'cancelled' },
  );
  assert.deepEqual(
    buildClaudeQuestionResolvedPayload('req-3', {}),
    { type: 'questionResolved', requestId: 'req-3', status: 'answered' },
  );
});

test('question stays pending until CRETLI_CLAUDE_QUESTION_TIMEOUT_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prev = process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS;
  process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS = '5000';
  const room = mkRoom();
  const canUseTool = createRoomClaudeCanUseTool(room);
  const run = canUseTool('AskUserQuestion', SAMPLE_TOOL_INPUT, {});
  await Promise.resolve();
  assert.equal(room._pendingQuestions.size, 1);
  t.mock.timers.tick(4999);
  assert.equal(room._pendingQuestions.size, 1);
  t.mock.timers.tick(2);
  const result = await run;
  assert.equal(result.behavior, 'deny');
  assert.equal(room._pendingQuestions.size, 0);
  if (prev === undefined) delete process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS;
  else process.env.CRETLI_CLAUDE_QUESTION_TIMEOUT_MS = prev;
  t.mock.timers.reset();
});

test('idle timer does not arm while a question is pending', () => {
  const session = {
    alive: true,
    idleTimer: null,
    query: { close() {} },
    input: { close() {} },
  };
  const room = mkRoom({
    _claudeSession: session,
    _pendingQuestions: new Map([['q1', { type: 'opencode_question', requestId: 'q1' }]]),
  });
  armClaudeSessionIdleTimer(room, session, 100);
  assert.equal(session.idleTimer, null);
  room._pendingQuestions.clear();
  syncClaudeSessionIdleWithPendingQuestions(room);
  assert.notEqual(session.idleTimer, null);
});

test('late opencodeQuestionReply yields questionReplyRejected', () => {
  const room = mkRoom();
  const sent = [];
  const ws = {
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(String(raw))),
  };
  const ok = handleClaudeOpenCodeQuestionReply(room, ws, {
    requestId: 'missing',
    answers: [['A']],
  });
  assert.equal(ok, false);
  assert.deepEqual(sent, [{
    type: 'questionReplyRejected',
    requestId: 'missing',
    reason: 'expired',
  }]);
});

test('replayed pending question is tagged replay:true and keeps event intact', () => {
  const event = {
    type: 'opencode_question',
    requestId: 'q-1',
    questions: [{ question: 'Pick one' }],
  };
  const room = mkRoom({
    _pendingQuestions: new Map([['q-1', event]]),
  });
  const sent = [];
  const ws = {
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(String(raw))),
  };
  sendPendingClaudeQuestionsToClient(room, ws);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'sdkEvent');
  assert.equal(sent[0].replay, true);
  assert.deepEqual(sent[0].event, event);
});

test('sendPendingClaudeQuestionsToClient is a no-op without pending questions', () => {
  const room = mkRoom({ _pendingQuestions: new Map() });
  const sent = [];
  const ws = {
    readyState: 1,
    send: (raw) => sent.push(JSON.parse(String(raw))),
  };
  sendPendingClaudeQuestionsToClient(room, ws);
  assert.deepEqual(sent, []);
});
