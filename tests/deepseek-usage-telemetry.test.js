import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { applyDeepSeekRoomNotification } from '../lib/deepseek/deepseek-agent-ws.js';

/**
 * Full path for DeepSeek token accounting: a DSH `assistant/message` session
 * event carries `usage`, the normalizer turns it into a synthetic usage event,
 * and the room kernel records it as a canonical deepseek delta.
 */
test('DSH assistant/message usage becomes a deepseek token delta', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'deepseek',
    persistHistory: () => {},
    recordUsage: (partial) => {
      records.push(partial);
      return partial;
    },
  });
  const room = kernel.createRoomState({
    sessionKey: 'deepseek-usage',
    chatId: 'deepseek-usage-chat',
    modelId: 'deepseek-flash',
  });
  room.deepseekSessionId = 'dsh-usage-1';
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });

  const events = applyDeepSeekRoomNotification(room, {
    method: 'session.event',
    params: {
      sessionId: 'dsh-usage-1',
      event: {
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: 'hello' }] },
          usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 100, reasoningTokens: 20 },
        },
      },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'usage');
  for (const event of events) kernel.broadcastRoom(room, { type: 'sdkEvent', event });

  const deltas = records.filter((row) => row.eventType === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].harness, 'deepseek');
  assert.equal(deltas[0].model, 'deepseek-flash');
  assert.equal(deltas[0].chatId, 'deepseek-usage-chat');
  assert.deepEqual(deltas[0].tokens, {
    textInput: 900,
    textOutput: 50,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 100,
    reasoning: 20,
  });
});

test('a DSH assistant/message without usage records no zeroed delta', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'deepseek',
    persistHistory: () => {},
    recordUsage: (partial) => {
      records.push(partial);
      return partial;
    },
  });
  const room = kernel.createRoomState({ sessionKey: 'deepseek-no-usage', chatId: 'deepseek-no-usage-chat' });
  room.deepseekSessionId = 'dsh-no-usage';
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-2' });

  const events = applyDeepSeekRoomNotification(room, {
    method: 'session.event',
    params: {
      sessionId: 'dsh-no-usage',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'hello' }] } },
      },
    },
  });
  for (const event of events) kernel.broadcastRoom(room, { type: 'sdkEvent', event });

  assert.equal(records.filter((row) => row.eventType === 'delta').length, 0);
});

/**
 * The delegation card reads the run's cumulative usage from
 * `room._lastUsagePayload`, not the ledger. DSH sends one `usage` per step, so
 * `applyDeepSeekRoomNotification` must fold each step into a single running
 * total that `collectRoomDelegationMetrics` publishes at close.
 */
test('room._lastUsagePayload accumulates across DSH steps and resets per run', () => {
  const kernel = createAgentRoomKernel({
    transport: 'deepseek',
    persistHistory: () => {},
    recordUsage: () => {},
  });
  const room = kernel.createRoomState({
    sessionKey: 'deepseek-accum',
    chatId: 'deepseek-accum-chat',
    modelId: 'deepseek-flash',
  });
  room.deepseekSessionId = 'dsh-accum-1';
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-accum' });
  assert.equal(room._lastUsagePayload, null, 'a fresh run starts with no usage snapshot');

  const step = (usage) => applyDeepSeekRoomNotification(room, {
    method: 'session.event',
    params: {
      sessionId: 'dsh-accum-1',
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'step' }] }, usage },
      },
    },
  });

  step({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
  assert.deepEqual(room._lastUsagePayload, { inputTokens: 100, outputTokens: 20 },
    'the first step seeds the SDK-compatible payload');

  step({ inputTokens: 250, outputTokens: 35, cacheReadTokens: 40 });
  assert.deepEqual(room._lastUsagePayload, { inputTokens: 350, outputTokens: 55 },
    'the second step folds into the run total (cache stays disjoint)');

  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-accum-2' });
  assert.equal(room._lastUsagePayload, null, 'the next run drops the previous total');
});
