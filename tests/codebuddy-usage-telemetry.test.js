import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodeBuddyUsageState, normalizeCodeBuddyMessage } from '../lib/agent-harness/codebuddy-event-normalizer.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { recordHarnessUsageDelta } from '../lib/usage/harness-usage.js';

test('CodeBuddy streamed and completed messages count once even with a zero result', () => {
  const state = createCodeBuddyUsageState();
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'codebuddy', persistHistory: () => {}, recordUsage: (row) => records.push(row),
  });
  const room = kernel.createRoomState({ sessionKey: 'cb-stream-usage', chatId: 'cb-stream-chat' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'stream-run' });
  const messages = [
    { type: 'stream_event', event: { type: 'message_start', message: {
      id: 'm1', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20 },
    } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 10 } } },
    { type: 'assistant', message: { id: 'completed-m1', content: [], usage: {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20,
    } } },
    { type: 'assistant', message: { id: 'm2', content: [], usage: {
      input_tokens: 200, output_tokens: 30,
    } } },
    { type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } },
  ];
  for (const message of messages) {
    for (const item of normalizeCodeBuddyMessage(message, state)) {
      if (item.kind === 'usage') kernel.broadcastRoom(room, {
        type: 'sdkEvent', event: { type: 'usage', usage: item.usage },
      });
    }
  }
  const totals = records.filter((row) => row.eventType === 'delta').reduce((sum, row) => ({
    input: sum.input + row.tokens.textInput,
    output: sum.output + row.tokens.textOutput,
    cached: sum.cached + row.tokens.cachedInput,
  }), { input: 0, output: 0, cached: 0 });
  assert.deepEqual(totals, { input: 300, output: 40, cached: 20 });
});

test('CodeBuddy live CLI shape counts assistant usage once alongside identical result', () => {
  const state = createCodeBuddyUsageState();
  const usage = { input_tokens: 18865, output_tokens: 3,
    cache_creation_input_tokens: null, cache_read_input_tokens: null };
  const messages = [
    { type: 'stream_event', event: { type: 'message_start', message: {
      id: 'stream-id', usage: { input_tokens: 0, output_tokens: 0 },
    } } },
    { type: 'assistant', message: { id: 'assistant-id', content: [], usage } },
    { type: 'assistant', message: { id: 'assistant-id', content: [], usage } },
    { type: 'result', subtype: 'success', usage },
  ];
  const events = messages.flatMap((message) => normalizeCodeBuddyMessage(message, state));
  const deltas = events.filter((event) => event.kind === 'usage');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].usage.input_tokens, 18865);
  assert.equal(deltas[0].usage.output_tokens, 3);
});

test('CodeBuddy prefers per-message usage to session totals and resets each prompt', () => {
  for (let turn = 0; turn < 2; turn++) {
    const state = createCodeBuddyUsageState();
    const message = { type: 'assistant', message: {
      id: 'reused-id', content: [], usage: { input_tokens: 50, output_tokens: 5 },
    } };
    assert.equal(normalizeCodeBuddyMessage(message, state)[0].usage.input_tokens, 50);
    assert.deepEqual(normalizeCodeBuddyMessage(message, state), []);
    const result = normalizeCodeBuddyMessage({
      type: 'result', usage: { input_tokens: 1000, output_tokens: 100 },
    }, state);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'result');
  }
});

test('CodeBuddy result remains a fallback when message usage is empty', () => {
  const state = createCodeBuddyUsageState();
  normalizeCodeBuddyMessage({ type: 'assistant', message: {
    id: 'empty', usage: { input_tokens: 0, output_tokens: 0 },
  } }, state);
  const events = normalizeCodeBuddyMessage({
    type: 'result', usage: { input_tokens: 40, output_tokens: 4 },
  }, state);
  assert.equal(events[0].kind, 'usage');
  assert.equal(events[0].usage.input_tokens, 40);
});

test('CodeBuddy result message emits usage before result', () => {
  const events = normalizeCodeBuddyMessage({
    type: 'result',
    subtype: 'success',
    session_id: 'cb-sess-usage',
    duration_ms: 900,
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 300,
    },
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'usage');
  assert.deepEqual(events[0].usage, {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 300,
  });
  assert.equal(events[1].kind, 'result');
});

test('room-kernel records a codebuddy token delta from result usage', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'codebuddy',
    persistHistory: () => {},
    recordUsage: (partial) => {
      records.push(partial);
      return partial;
    },
  });
  const room = kernel.createRoomState({
    sessionKey: 'codebuddy-usage',
    chatId: 'codebuddy-usage-chat',
    modelId: 'hunyuan-3',
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  kernel.broadcastRoom(room, {
    type: 'sdkEvent',
    event: {
      type: 'usage',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 300,
      },
      totalCostUsd: 0.02,
    },
  });

  const deltas = records.filter((row) => row.eventType === 'delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].harness, 'codebuddy');
  assert.deepEqual(deltas[0].tokens, {
    textInput: 1000,
    textOutput: 200,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 300,
    cacheWrite: 0,
    reasoning: 0,
  });
});

test('resolveHarnessUsageDelta maps snake_case CodeBuddy usage via Claude resolver', () => {
  const partial = recordHarnessUsageDelta(
    { chatId: 'c1' },
    'codebuddy',
    {
      usage: {
        input_tokens: 400,
        output_tokens: 50,
        cache_read_input_tokens: 100,
      },
    },
    (row) => row,
  );
  assert.ok(partial);
  assert.equal(partial.tokens.textInput, 400);
  assert.equal(partial.tokens.cachedInput, 100);
});
