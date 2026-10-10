import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { applyDeepSeekRoomNotification } from '../lib/deepseek/deepseek-agent-ws.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';

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
    cacheWrite: 0,
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
  assert.deepEqual(room._lastUsagePayload, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }, 'the first step seeds the SDK-compatible payload including cache counters');

  step({ inputTokens: 250, outputTokens: 35, cacheReadTokens: 40, cacheWriteTokens: 3, reasoningTokens: 7 });
  assert.deepEqual(room._lastUsagePayload, {
    inputTokens: 350,
    outputTokens: 55,
    cacheReadTokens: 45,
    cacheWriteTokens: 3,
    reasoningTokens: 7,
  }, 'the second step folds into the run total and preserves cache/reasoning fields');

  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-accum-2' });
  assert.equal(room._lastUsagePayload, null, 'the next run drops the previous total');
});

/**
 * Parent and child usage stay in separate accounting scopes. The parent summary
 * does not contain the child's tokens (the normalizer forwards child usage
 * separately), so own and consolidated must never be summed, and the run
 * coverage must expose how many expected children actually reported.
 */
test('DeepSeek child usage is consolidated and run coverage marks incomplete children', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'deepseek',
    persistHistory: () => {},
    recordUsage: (partial) => {
      const event = createUsageEvent(partial);
      records.push(event);
      return event;
    },
  });
  const room = kernel.createRoomState({
    sessionKey: 'deepseek-consolidated',
    chatId: 'deepseek-consolidated-chat',
    modelId: 'deepseek-flash',
  });
  room.deepseekSessionId = 'dsh-root-cons';
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-cons' });

  const broadcast = (items) => {
    for (const item of items) kernel.broadcastRoom(room, { type: 'sdkEvent', event: item });
  };

  // Two child sessions are started: one reports usage, one never does.
  broadcast(applyDeepSeekRoomNotification(room, {
    method: 'subagent.started',
    params: { parentSessionId: 'dsh-root-cons', childSessionId: 'dsh-child-1', provider: 'codex' },
  }));
  broadcast(applyDeepSeekRoomNotification(room, {
    method: 'subagent.started',
    params: { parentSessionId: 'dsh-root-cons', childSessionId: 'dsh-child-2', provider: 'codex' },
  }));

  // Parent own usage.
  broadcast(applyDeepSeekRoomNotification(room, {
    method: 'session.event',
    params: {
      sessionId: 'dsh-root-cons',
      event: {
        type: 'assistant/message',
        data: {
          message: { content: [{ type: 'text', text: 'parent' }] },
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      },
    },
  }));

  // Child 1 consolidated usage; child 2 stays silent.
  broadcast(applyDeepSeekRoomNotification(room, {
    method: 'session.event',
    params: {
      sessionId: 'dsh-child-1',
      event: { type: 'assistant/message', data: { usage: { inputTokens: 40, outputTokens: 5 } } },
    },
  }));

  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'run-cons', status: 'completed' });

  const deltas = records.filter((row) => row.eventType === 'delta');
  const own = deltas.filter((row) => row.accountingScope === 'own');
  const consolidated = deltas.filter((row) => row.accountingScope === 'consolidated');
  assert.equal(own.length, 1, 'parent usage stays own');
  assert.equal(consolidated.length, 1, 'child usage is consolidated');
  assert.equal(consolidated[0].tokens.textInput, 40);
  assert.equal(own[0].tokens.textInput, 100);

  const run = records.find((row) => row.eventType === 'run');
  assert.equal(run.coverage.scope, 'consolidated');
  assert.equal(run.coverage.expectedChildren, 2);
  assert.equal(run.coverage.coveredChildren, 1);
  assert.equal(run.coverage.proof, false, 'a silent child keeps coverage partial');
  assert.equal(run.completeness, 'partial');
});

