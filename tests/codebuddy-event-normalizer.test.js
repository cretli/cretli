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
  usage: { input_tokens: 10, output_tokens: 5 },
});
assert.equal(success.length, 2);
assert.equal(success[0].kind, 'usage');
assert.equal(success[1].kind, 'result');
assert.equal(success[1].status, 'completed');
assert.equal(success[1].sessionId, 'cb-sess-1');

const failed = normalizeCodeBuddyMessage({
  type: 'result',
  subtype: 'error',
  error: 'boom',
});
assert.equal(failed[0].status, 'error');
assert.equal(failed[0].errorMessage, 'boom');

assert.deepEqual(normalizeCodeBuddyMessage(null), []);
assert.deepEqual(normalizeCodeBuddyMessage({ type: 'unknown' }), []);

// --- Native compaction is observed (compact_boundary / PreCompact / status) ---
const compactBoundary = normalizeCodeBuddyMessage({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'cb-sess-1',
  compact_metadata: { trigger: 'auto', pre_tokens: 180000 },
});
assert.equal(compactBoundary[0].kind, 'session');
const boundaryNotice = compactBoundary.find((event) => event.kind === 'notice');
assert.ok(boundaryNotice, 'a compact_boundary notice is emitted');
assert.equal(boundaryNotice.noticeType, 'compact');
assert.equal(boundaryNotice.phase, 'boundary');
assert.equal(boundaryNotice.trigger, 'auto');
assert.equal(boundaryNotice.preTokens, 180000);

const preCompact = normalizeCodeBuddyMessage({
  type: 'system',
  hook_event_name: 'PreCompact',
  session_id: 'cb-sess-1',
  trigger: 'manual',
});
assert.equal(preCompact.find((event) => event.kind === 'notice').phase, 'pre');
const postCompact = normalizeCodeBuddyMessage({
  type: 'system',
  hook_event_name: 'PostCompact',
  session_id: 'cb-sess-1',
});
assert.equal(postCompact.find((event) => event.kind === 'notice').phase, 'post');
const compactingStatus = normalizeCodeBuddyMessage({
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  session_id: 'cb-sess-1',
});
assert.equal(compactingStatus.find((event) => event.kind === 'notice').phase, 'pre');

console.log('codebuddy-event-normalizer.test.js OK');
