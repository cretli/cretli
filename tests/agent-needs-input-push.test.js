import assert from 'node:assert/strict';
import {
  buildAgentNeedsInputPushPayload,
  readAgentNeedsInputDetail,
} from '../lib/agent-needs-input-push.js';

assert.equal(buildAgentNeedsInputPushPayload({}), null);
assert.equal(buildAgentNeedsInputPushPayload({ kind: 'other' }), null);

const permissionDetail = readAgentNeedsInputDetail({
  type: 'opencode_permission',
  action: 'bash',
  metadata: { command: 'node tests/chat-history-window-pull.test.js' },
  resources: ['ignored'],
});
assert.equal(permissionDetail, 'bash: node tests/chat-history-window-pull.test.js');

const permissionFromResource = readAgentNeedsInputDetail({
  type: 'opencode_permission',
  action: 'Write file',
  resources: ['src/app.js'],
});
assert.equal(permissionFromResource, 'Write file: src/app.js');

const questionDetail = readAgentNeedsInputDetail({
  type: 'opencode_question',
  questions: [{ question: 'Which model?', header: 'Model' }],
});
assert.equal(questionDetail, 'Which model?');

const permissionPayload = buildAgentNeedsInputPushPayload({
  chatId: 'chat-1',
  chatTitle: 'OpenCode run',
  kind: 'permission',
  requestId: 'per_1',
  detail: 'bash: npm test',
});
assert.equal(permissionPayload.title, 'Cretli — agent needs permission');
assert.match(permissionPayload.body, /OpenCode run/);
assert.match(permissionPayload.body, /bash: npm test/);
assert.equal(permissionPayload.tag, 'cretli-ask-chat-1-per_1');
assert.equal(permissionPayload.data.kind, 'permission');
assert.equal(permissionPayload.data.url, '/?source=pwa&panel=chat&chat=chat-1');

const questionPayload = buildAgentNeedsInputPushPayload({
  chatId: 'chat-2',
  chatTitle: 'Ask me',
  kind: 'question',
  requestId: 'que_1',
  detail: 'Pick a color',
});
assert.equal(questionPayload.title, 'Cretli — agent asked a question');
assert.match(questionPayload.body, /Pick a color/);
assert.equal(questionPayload.data.kind, 'question');

const longDetail = 'x'.repeat(200);
const clipped = buildAgentNeedsInputPushPayload({
  kind: 'question',
  chatId: 'c',
  detail: longDetail,
});
assert.ok(clipped.body.length <= 200);
assert.match(clipped.body, /…$/);
