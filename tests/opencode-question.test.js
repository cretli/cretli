import assert from 'node:assert/strict';
import {
  buildOpenCodeQuestionSdkEvent,
  normalizeOpenCodeQuestionItems,
  resolveOpenCodeQuestionResolvedRequestId,
} from '../lib/opencode/opencode-question.js';

const questions = normalizeOpenCodeQuestionItems([
  {
    question: 'Which option?',
    header: 'Pick one',
    options: [{ label: 'A', description: 'First' }],
    multiple: false,
    custom: true,
  },
]);
assert.equal(questions.length, 1);
assert.equal(questions[0].options[0].label, 'A');

const asked = buildOpenCodeQuestionSdkEvent({
  type: 'question.v2.asked',
  properties: {
    id: 'que_test',
    sessionID: 'ses_test',
    questions,
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(asked);
assert.equal(asked.type, 'opencode_question');
assert.equal(asked.requestId, 'que_test');

const resolved = resolveOpenCodeQuestionResolvedRequestId({
  type: 'question.v2.replied',
  properties: {
    sessionID: 'ses_test',
    requestID: 'que_test',
    answers: [['A']],
  },
}, { opencodeSessionId: 'ses_test' });
assert.equal(resolved, 'que_test');

console.log('opencode-question.test.js OK');
