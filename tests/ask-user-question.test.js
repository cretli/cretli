import assert from 'node:assert/strict';
import {
  buildCanUseToolResult,
  buildQuestionAnswers,
  buildQuestionSdkEvent,
  createAskUserQuestionCanUseTool,
  isAskUserQuestionTool,
  normalizeQuestionItems,
  ASK_USER_QUESTION_TIMEOUT_MS,
} from '../lib/approval/ask-user-question.ts';

assert.equal(isAskUserQuestionTool('ask_user_question'), true);
assert.equal(isAskUserQuestionTool('AskUserQuestion'), true);
assert.equal(isAskUserQuestionTool('web_fetch'), false);
assert.equal(ASK_USER_QUESTION_TIMEOUT_MS, 600000);

const questions = normalizeQuestionItems([
  {
    question: 'Which port?',
    header: 'Port',
    options: [
      { label: '8081', description: 'Next to 8080' },
      { label: '8090', description: 'Dev server' },
    ],
    multiSelect: false,
  },
]);
assert.equal(questions.length, 1);
assert.equal(questions[0].header, 'Port');
assert.equal(questions[0].custom, true);
assert.equal(questions[0].multiple, false);
assert.equal(questions[0].options[0].label, '8081');

const asked = buildQuestionSdkEvent({
  requestId: 'ask-q-1',
  questions,
});
assert.equal(asked.type, 'opencode_question');
assert.equal(asked.requestId, 'ask-q-1');
assert.equal(asked.questions.length, 1);

const answers = buildQuestionAnswers(questions, [['8081']]);
assert.deepEqual(answers, { 0: '8081' });

const multi = normalizeQuestionItems([
  {
    question: 'Which extras?',
    header: 'Extras',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: true,
  },
]);
assert.equal(multi[0].multiple, true);
assert.deepEqual(buildQuestionAnswers(multi, [['A', 'B']]), { 0: 'A, B' });

const allowed = buildCanUseToolResult({
  behavior: 'allow',
  input: { questions },
  answers: { 0: '8081' },
});
assert.equal(allowed.behavior, 'allow');
assert.equal(allowed.updatedInput.answers[0], '8081');

const denied = buildCanUseToolResult({
  behavior: 'deny',
  message: 'User declined to answer',
});
assert.equal(denied.behavior, 'deny');
assert.match(denied.message, /declined/i);

let emitted = null;
const canUseTool = createAskUserQuestionCanUseTool({
  emitQuestion: (event) => {
    emitted = event;
  },
  waitForReply: async () => ({ answers: [['8090']] }),
  generateId: () => 'req-1',
});
const allowedFromCallback = await canUseTool(
  'ask_user_question',
  { questions: [{ question: 'Port?', header: 'Port', options: [{ label: '8090' }] }] },
  { signal: new AbortController().signal },
);
assert.equal(emitted.type, 'opencode_question');
assert.equal(emitted.requestId, 'req-1');
assert.equal(allowedFromCallback.behavior, 'allow');
assert.equal(allowedFromCallback.updatedInput.answers[0], '8090');

// Without an injected generator the request id uses the shared ask-q- prefix.
let defaultEmitted = null;
const defaultIdTool = createAskUserQuestionCanUseTool({
  emitQuestion: (event) => {
    defaultEmitted = event;
  },
  waitForReply: async () => ({ answers: [['8090']] }),
});
await defaultIdTool(
  'ask_user_question',
  { questions: [{ question: 'Port?', header: 'Port', options: [{ label: '8090' }] }] },
  { signal: new AbortController().signal },
);
assert.match(defaultEmitted.requestId, /^ask-q-\d+$/);

const passthrough = await canUseTool('web_fetch', { url: 'https://example.com' }, {
  signal: new AbortController().signal,
});
assert.equal(passthrough.behavior, 'allow');
assert.equal(passthrough.updatedInput.url, 'https://example.com');

const rejectedTool = createAskUserQuestionCanUseTool({
  emitQuestion: () => {},
  waitForReply: async () => ({ reject: true }),
  generateId: () => 'req-2',
});
const rejected = await rejectedTool(
  'ask_user_question',
  { questions: [{ question: 'Port?', header: 'Port', options: [{ label: '8081' }] }] },
  { signal: new AbortController().signal },
);
assert.equal(rejected.behavior, 'deny');

console.log('ask-user-question.test.js OK');
