import assert from 'node:assert/strict';
import {
  formatOpenCodeSessionError,
  normalizeOpenCodeEvent,
  parseOpenCodeModel,
  processOpenCodeStreamEventForHarness,
  resolveOpenCodeSessionActivity,
} from '../lib/agent-harness/opencode-event-normalizer.js';
import { isHarnessErrorAssistantText, getSdkEventTerminalChunk } from '../app_front/lib/sdk-chat-format.js';
import { OpenCodeMessageRegistry } from '../lib/agent-harness/opencode-message-registry.js';

assert.deepEqual(parseOpenCodeModel('zai-coding-plan/glm-5.2'), {
  providerID: 'zai-coding-plan',
  modelID: 'glm-5.2',
});
assert.equal(parseOpenCodeModel('invalid'), null);

const registry = new OpenCodeMessageRegistry();
const sessionId = 'sess-1';

const textDeltaEvents = processOpenCodeStreamEventForHarness({
  type: 'message.updated',
  properties: { sessionID: sessionId, info: { id: 'm1', role: 'assistant' } },
}, { opencodeSessionId: sessionId, messageRegistry: registry });
assert.equal(textDeltaEvents.length, 0);

const partDelta = processOpenCodeStreamEventForHarness({
  type: 'message.part.updated',
  properties: {
    sessionID: sessionId,
    part: { type: 'text', text: 'Hello', messageID: 'm1' },
    delta: 'Hello',
  },
}, { opencodeSessionId: sessionId, messageRegistry: registry });
assert.equal(partDelta.length, 1);
assert.equal(partDelta[0].type, 'assistant');

const toolEvents = normalizeOpenCodeEvent({
  type: 'message.part.updated',
  properties: {
    sessionID: sessionId,
    part: {
      type: 'tool',
      messageID: 'm1',
      callID: 'call-1',
      tool: 'read_file',
      state: { status: 'completed', input: { path: 'a.txt' }, output: 'ok' },
    },
  },
}, { opencodeSessionId: sessionId, messageRegistry: registry });
assert.equal(toolEvents[0].type, 'tool_call');
assert.equal(toolEvents[0].name, 'read_file');
assert.equal(toolEvents[0].status, 'completed');

assert.equal(
  resolveOpenCodeSessionActivity({
    type: 'session.idle',
    properties: { sessionID: sessionId },
  }, { opencodeSessionId: sessionId }),
  'idle',
);

const userEchoSkipped = processOpenCodeStreamEventForHarness({
  type: 'message.updated',
  properties: {
    sessionID: sessionId,
    info: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
  },
}, { opencodeSessionId: sessionId, messageRegistry: registry });
assert.deepEqual(userEchoSkipped, []);

assert.equal(formatOpenCodeSessionError('plain error'), 'plain error');

const sessionErrorEvents = normalizeOpenCodeEvent({
  type: 'session.error',
  properties: {
    sessionID: sessionId,
    error: {
      name: 'APIError',
      data: {
        message: 'No payment method. Add a payment method here: https://opencode.ai/workspace/billing',
      },
    },
  },
}, { opencodeSessionId: sessionId });
assert.equal(sessionErrorEvents.length, 1);
assert.equal(sessionErrorEvents[0].kind, 'error');
assert.equal(sessionErrorEvents[0].type, undefined);
assert.match(sessionErrorEvents[0].message, /No payment method/);
assert.equal(/\[OpenCode error\]/.test(String(sessionErrorEvents[0].message || '')), false);
assert.equal(
  isHarnessErrorAssistantText(
    '[OpenCode error] No payment method. Add a payment method here: https://opencode.ai/workspace/billing'
  ),
  true
);
assert.equal(isHarnessErrorAssistantText('No payment method'), false);
assert.equal(
  getSdkEventTerminalChunk({}, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[OpenCode error] No payment method' }],
    },
  }),
  ''
);

console.log('opencode-event-normalizer.test.js OK');
