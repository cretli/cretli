import assert from 'node:assert/strict';
import {
  buildOpenCodeQuestionSdkEvent,
  normalizeOpenCodeQuestionItems,
  postOpenCodeQuestionResponse,
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

const askedFromData = buildOpenCodeQuestionSdkEvent({
  type: 'question.v2.asked',
  properties: {},
  data: {
    id: 'que_data',
    sessionID: 'ses_test',
    questions,
  },
}, { opencodeSessionId: 'ses_test' });
assert.ok(askedFromData);
assert.equal(askedFromData.requestId, 'que_data');

assert.equal(
  buildOpenCodeQuestionSdkEvent({
    type: 'question.v2.asked',
    properties: {
      id: 'que_leak',
      sessionID: 'ses_other',
      questions,
    },
  }, {}),
  null,
);

const originalFetch = globalThis.fetch;
/** @type {Array<{ url: string, init?: RequestInit }>} */
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  if (fetchCalls.length === 1) {
    return new Response(JSON.stringify({
      _tag: 'QuestionNotFoundError',
      requestID: 'que_test',
      message: 'Question request not found: que_test',
    }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(null, { status: 204 });
};
try {
  await postOpenCodeQuestionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'que_test',
    sessionId: 'ses_test',
    directory: '/home/ar2oor/www/cretli',
    answers: [['A']],
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);
assert.match(fetchCalls[0].url, /\/api\/session\/ses_test\/question\/que_test\/reply/);
assert.match(fetchCalls[0].url, /directory=/);
assert.match(fetchCalls[0].url, /location%5Bdirectory%5D=/);
assert.equal(
  /** @type {Record<string, string>} */ (fetchCalls[0].init?.headers)?.['x-opencode-directory'],
  encodeURIComponent('/home/ar2oor/www/cretli'),
);
assert.match(fetchCalls[1].url, /\/question\/que_test\/reply\?/);

fetchCalls.length = 0;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({
    _tag: 'QuestionNotFoundError',
    requestID: 'que_gone',
    message: 'Question request not found: que_gone',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } });
};
try {
  await postOpenCodeQuestionResponse({
    baseUrl: 'http://127.0.0.1:4096',
    requestId: 'que_gone',
    sessionId: 'ses_test',
    directory: '/home/ar2oor/www/cretli',
    answers: [['A']],
  });
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(fetchCalls.length, 2);

console.log('opencode-question.test.js OK');
