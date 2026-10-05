import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import {
  resolveOpenCodeUsageFromStreamEvent,
  unwrapOpenCodeStreamEvent,
} from '../lib/opencode/opencode-usage.js';
import { fromOpenCodeUsage } from '../lib/usage/usage-normalize.js';
import { recordHarnessUsageDelta } from '../lib/usage/harness-usage.js';

const SESSION = 'oc-sess-usage-1';

test('message.updated with assistant tokens records a non-zero opencode delta', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'opencode',
    persistHistory: () => {},
    recordUsage: (partial) => {
      records.push(partial);
      return partial;
    },
  });
  const room = kernel.createRoomState({
    sessionKey: 'opencode-usage',
    chatId: 'opencode-usage-chat',
    modelId: 'zai-coding-plan/glm-5.2',
  });
  room.opencodeSessionId = SESSION;
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });

  const tokensByMessageId = new Map();
  const resolved = resolveOpenCodeUsageFromStreamEvent({
    type: 'message.updated',
    properties: {
      sessionID: SESSION,
      info: {
        id: 'msg-asst-1',
        role: 'assistant',
        tokens: { input: 120, output: 45, reasoning: 10, cache: { read: 30, write: 0 } },
      },
    },
  }, tokensByMessageId);
  assert.ok(resolved);
  kernel.broadcastRoom(room, { type: 'sdkEvent', event: resolved.sdkEvent });

  const deltas = records.filter((row) => row.eventType === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].harness, 'opencode');
  assert.deepEqual(deltas[0].tokens, {
    textInput: 120,
    textOutput: 45,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 30,
    reasoning: 10,
  });
});

test('session.next.step.ended with tokens records a delta when message.updated had none', () => {
  const tokensByMessageId = new Map();
  const resolved = resolveOpenCodeUsageFromStreamEvent({
    type: 'session.next.step.ended',
    properties: {
      sessionID: SESSION,
      assistantMessageID: 'msg-step-1',
      tokens: { input: 500, output: 80, reasoning: 0, cache: { read: 100, write: 0 } },
    },
  }, tokensByMessageId);
  assert.ok(resolved);
  assert.equal(resolved.sdkEvent.type, 'usage');
  const partial = recordHarnessUsageDelta(
    { chatId: 'c1' },
    'opencode',
    resolved.sdkEvent,
    (row) => row,
  );
  assert.ok(partial);
  assert.equal(partial.tokens.textInput, 500);
  assert.equal(partial.tokens.cachedInput, 100);
});

test('fromOpenCodeUsage does not subtract cache.read from input (disjoint counts)', () => {
  const tokens = fromOpenCodeUsage({
    input: 500,
    output: 20,
    reasoning: 0,
    cache: { read: 300, write: 0 },
  });
  assert.equal(tokens.textInput, 500);
  assert.equal(tokens.cachedInput, 300);
});

test('sync-wrapped message.updated.1 unwraps and yields usage', () => {
  const tokensByMessageId = new Map();
  const wrapped = {
    type: 'sync',
    id: 'sync-1',
    syncEvent: {
      type: 'message.updated.1',
      id: 'evt-1',
      seq: 2,
      aggregateID: 'msg-2',
      data: {
        sessionID: SESSION,
        info: {
          id: 'msg-sync-1',
          role: 'assistant',
          tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  };
  const unwrapped = unwrapOpenCodeStreamEvent(wrapped);
  assert.equal(unwrapped?.type, 'message.updated');
  const resolved = resolveOpenCodeUsageFromStreamEvent(wrapped, tokensByMessageId);
  assert.ok(resolved);
  assert.equal(resolved.delta.input, 10);
});
