import assert from 'node:assert/strict';
import { normalizeDeepSeekNotification } from '../lib/agent-harness/deepseek-event-normalizer.js';

assert.deepEqual(normalizeDeepSeekNotification(null), []);
assert.deepEqual(normalizeDeepSeekNotification({ type: 'unknown' }), []);

const idle = normalizeDeepSeekNotification({
  method: 'session.status',
  params: { sessionId: 'dsh-1', status: 'idle' },
});
assert.equal(idle[0].kind, 'status');
assert.equal(idle[0].status, 'idle');
assert.equal(idle[0].sessionId, 'dsh-1');

const assembledMessage = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'assistant/message',
      message: { content: [{ type: 'text', text: 'Hello from DeepSeek' }] },
    },
  },
});
assert.equal(assembledMessage[0].kind, 'session');
assert.equal(assembledMessage[0].sessionId, 'dsh-1');

const toolEvents = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'tool/call',
      id: 'call-1',
      name: 'bash',
      input: { command: 'ls' },
    },
  },
});
assert.equal(toolEvents[0].type, 'tool_call');
assert.equal(toolEvents[0].name, 'bash');
assert.equal(toolEvents[0].status, 'running');
assert.equal(toolEvents[0].call_id, 'call-1');

const resultEvents = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'tool/result',
      tool_use_id: 'call-1',
      name: 'bash',
      content: 'ok',
    },
  },
});
assert.equal(resultEvents[0].type, 'tool_call');
assert.equal(resultEvents[0].status, 'completed');
assert.equal(resultEvents[0].result, 'ok');
assert.equal(resultEvents[0].call_id, 'call-1');

const dshCall = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call_00_NkHBsMDnZsdFcxln98Ch2698',
        name: 'bash',
        arguments: '{"command":"ls -la","description":"List files in current directory"}',
      },
    },
  },
});
assert.equal(dshCall[0].name, 'bash');
assert.equal(dshCall[0].status, 'running');
assert.equal(dshCall[0].call_id, 'call_00_NkHBsMDnZsdFcxln98Ch2698');
assert.equal(dshCall[0].args.command, 'ls -la');

const dshResult = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          source: { kind: 'tool', callId: 'call_00_NkHBsMDnZsdFcxln98Ch2698' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_00_NkHBsMDnZsdFcxln98Ch2698',
            content: [{ type: 'text', text: 'total 12\n.' }],
          }],
        },
      },
    },
  },
});
assert.equal(dshResult[0].type, 'tool_call');
assert.equal(dshResult[0].status, 'completed');
assert.equal(dshResult[0].call_id, 'call_00_NkHBsMDnZsdFcxln98Ch2698');
assert.equal(dshResult[0].result, 'total 12\n.');

const orphanResult = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: { type: 'tool/result', message: { content: [{ type: 'text', text: 'ok' }] } },
  },
});
assert.equal(orphanResult[0].kind, 'session');

const inbox = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: { type: 'agent/inbox/spliced' },
  },
});
assert.deepEqual(inbox, [{ kind: 'session', sessionId: 'dsh-1' }]);

const subagent = normalizeDeepSeekNotification({
  method: 'subagent.started',
  params: { sessionId: 'child-1' },
});
assert.equal(subagent[0].type, 'assistant');

const chunkText = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello chunk' } },
    },
  },
});
assert.equal(chunkText[0].type, 'assistant');
assert.equal(chunkText[0].message.content[0].text, 'Hello chunk');

const quotaError = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'Insufficient Balance', code: 'QUOTA', status: 402 } },
        },
      },
    },
  },
});
assert.equal(quotaError[0].type, 'assistant');
assert.match(quotaError[0].message.content[0].text, /Insufficient Balance/);

const reasoning = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'The user said hej' } },
    },
  },
});
assert.equal(reasoning[0].type, 'thinking');
assert.equal(reasoning[0].text, 'The user said hej');

const blockEnd = normalizeDeepSeekNotification({
  method: 'session.event',
  params: {
    sessionId: 'dsh-1',
    event: {
      type: 'assistant/chunk',
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'block-end', block: { type: 'text', text: 'Hello chunk' } },
      },
    },
  },
});
assert.equal(blockEnd[0].kind, 'session');

const streamedThenAssembled = [
  {
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', text: 'Hej! ' } },
  },
  {
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', text: 'Vad vill du göra?' } },
  },
  {
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-end', block: { type: 'text', text: 'Hej! Vad vill du göra?' } } },
  },
  {
    type: 'assistant/message',
    message: { content: [{ type: 'text', text: 'Hej! Vad vill du göra?' }] },
  },
].flatMap((event) => normalizeDeepSeekNotification({
  method: 'session.event',
  params: { sessionId: 'dsh-1', event },
}));
const assistantTexts = streamedThenAssembled
  .filter((item) => item.type === 'assistant')
  .map((item) => item.message.content[0].text);
assert.deepEqual(assistantTexts, ['Hej! ', 'Vad vill du göra?']);

console.log('deepseek-event-normalizer.test.js OK');
