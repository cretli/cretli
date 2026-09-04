import assert from 'node:assert/strict';
import {
  buildQwenCanUseToolResult,
  buildQwenQuestionAnswers,
  buildQwenQuestionSdkEvent,
  createQwenCanUseTool,
  isDeniedQwenToolResult,
  isFailedQwenToolResult,
  isQwenAskUserQuestionTool,
  normalizeQwenQuestionItems,
  QWEN_CAN_USE_TOOL_TIMEOUT_MS,
} from '../lib/qwen/qwen-question.js';

assert.equal(isQwenAskUserQuestionTool('ask_user_question'), true);
assert.equal(isQwenAskUserQuestionTool('AskUserQuestion'), true);
assert.equal(isQwenAskUserQuestionTool('web_fetch'), false);
assert.equal(QWEN_CAN_USE_TOOL_TIMEOUT_MS, 600000);

const questions = normalizeQwenQuestionItems([
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

const asked = buildQwenQuestionSdkEvent({
  requestId: 'qwen-q-1',
  questions,
});
assert.equal(asked.type, 'opencode_question');
assert.equal(asked.requestId, 'qwen-q-1');
assert.equal(asked.questions.length, 1);

const answers = buildQwenQuestionAnswers(questions, [['8081']]);
assert.deepEqual(answers, { 0: '8081' });

const multi = normalizeQwenQuestionItems([
  {
    question: 'Which extras?',
    header: 'Extras',
    options: [{ label: 'A' }, { label: 'B' }],
    multiSelect: true,
  },
]);
assert.equal(multi[0].multiple, true);
assert.deepEqual(buildQwenQuestionAnswers(multi, [['A', 'B']]), { 0: 'A, B' });

assert.equal(isDeniedQwenToolResult('[Operation Cancelled] Reason: Denied'), true);
assert.equal(isDeniedQwenToolResult('Listed 7 item(s)'), false);
assert.equal(isDeniedQwenToolResult('User declined to answer the questions.'), true);
assert.equal(isFailedQwenToolResult('[Operation Cancelled] Reason: Denied'), true);
assert.equal(
  isFailedQwenToolResult(
    'File `/tmp/example-site/index.php` has not been read in this session. Use the `read_file` tool first to load the current content (read the full file – overwriting replaces every byte, so any unseen bytes would be discarded) before overwriting it.',
  ),
  true,
);
assert.equal(isFailedQwenToolResult('Listed 7 item(s)'), false);

const allowed = buildQwenCanUseToolResult({
  behavior: 'allow',
  input: { questions },
  answers: { 0: '8081' },
});
assert.equal(allowed.behavior, 'allow');
assert.equal(allowed.updatedInput.answers[0], '8081');

const denied = buildQwenCanUseToolResult({
  behavior: 'deny',
  message: 'User declined to answer',
});
assert.equal(denied.behavior, 'deny');
assert.match(denied.message, /declined/i);

let emitted = null;
const canUseTool = createQwenCanUseTool({
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

const passthrough = await canUseTool('web_fetch', { url: 'https://example.com' }, {
  signal: new AbortController().signal,
});
assert.equal(passthrough.behavior, 'allow');
assert.equal(passthrough.updatedInput.url, 'https://example.com');

const rejectedTool = createQwenCanUseTool({
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

console.log('qwen-question.test.js OK');
