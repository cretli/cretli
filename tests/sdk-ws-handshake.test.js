import assert from 'node:assert/strict';
import {
  buildAgentHelloPayload,
  buildSdkHelloPayload,
  scheduleSdkWsEventLogReplay,
} from '../lib/sdk/sdk-ws-handshake.js';

const hello = buildSdkHelloPayload({
  sessionKey: 'session-abc',
  agentId: 'agent-1',
  modelId: 'composer-2',
  sdkMode: 'plan',
  eventStreamId: 'stream-1',
  busy: true,
  queuedPrompts: ['hello'],
});

assert.equal(hello.type, 'hello');
assert.equal(hello.sdkMode, 'plan');
assert.equal(hello.busy, true);
assert.deepEqual(hello.queuedPrompts, ['hello']);

const openCodeHello = buildAgentHelloPayload({
  sessionKey: 'session-oc',
  transport: 'opencode',
  modelId: 'zai/glm-5',
  sdkMode: 'agent',
});
assert.equal(openCodeHello.transport, 'opencode');

const sent = [];
scheduleSdkWsEventLogReplay({
  entries: [{ payload: { type: 'sdkEvent', roomEventSeq: 1 } }],
  send: (payload) => sent.push(payload),
  batchDelayMs: 0,
  setTimer: (fn) => fn(),
});

assert.equal(sent[0]?.type, 'replayBatchStart');
assert.equal(sent[1]?.type, 'replayBatch');
assert.equal(sent[2]?.type, 'replayBatchEnd');

console.log('All sdk-ws-handshake tests passed.');
