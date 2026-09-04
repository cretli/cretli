import assert from 'node:assert/strict';
import { normalizeCodeBuddyMessage } from '../lib/agent-harness/codebuddy-event-normalizer.js';

const sessionEvents = normalizeCodeBuddyMessage({
  type: 'system',
  subtype: 'init',
  session_id: 'cb-sess-1',
  tools: ['Read'],
});
assert.deepEqual(sessionEvents, [{ kind: 'session', sessionId: 'cb-sess-1' }]);

const textEvents = normalizeCodeBuddyMessage({
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'Hello from CodeBuddy' }],
  },
});
assert.equal(textEvents.length, 1);
assert.equal(textEvents[0].type, 'assistant');
assert.equal(textEvents[0].message.content[0].text, 'Hello from CodeBuddy');

const toolEvents = normalizeCodeBuddyMessage({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'README.md' } },
    ],
  },
});
assert.equal(toolEvents[0].type, 'tool_call');
assert.equal(toolEvents[0].name, 'Read');
assert.equal(toolEvents[0].status, 'running');
assert.equal(toolEvents[0].call_id, 'call-1');

const resultEvents = normalizeCodeBuddyMessage({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', name: 'Read', content: 'ok' },
    ],
  },
});
assert.equal(resultEvents[0].type, 'tool_call');
assert.equal(resultEvents[0].status, 'completed');
assert.equal(resultEvents[0].result, 'ok');

const success = normalizeCodeBuddyMessage({
  type: 'result',
  subtype: 'success',
  session_id: 'cb-sess-1',
  duration_ms: 1200,
  total_cost_usd: 0.01,
});
assert.equal(success[0].kind, 'result');
assert.equal(success[0].status, 'completed');
assert.equal(success[0].sessionId, 'cb-sess-1');

const failed = normalizeCodeBuddyMessage({
  type: 'result',
  subtype: 'error',
  error: 'boom',
});
assert.equal(failed[0].status, 'error');
assert.equal(failed[0].errorMessage, 'boom');

assert.deepEqual(normalizeCodeBuddyMessage(null), []);
assert.deepEqual(normalizeCodeBuddyMessage({ type: 'unknown' }), []);

console.log('codebuddy-event-normalizer.test.js OK');
