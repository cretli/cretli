import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { runOpenRouterAgentLoop } from '../lib/agent-harness/openrouter-agent-loop.js';
import { buildHarnessRunUsage, recordHarnessUsageDelta, resolveHarnessRunOutcome } from '../lib/usage/harness-usage.js';

/**
 * Exercises the room-kernel telemetry hook for every harness that owns a
 * `createAgentRoomKernel`. Records are captured through the injectable
 * `recordUsage` option, so no real ledger file is touched.
 */
function runHarnessStream(harness, { usage, expectTokens }) {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: harness,
    persistHistory: () => {},
    recordUsage: (partial) => {
      records.push(partial);
      return partial;
    },
  });
  const room = kernel.createRoomState({
    sessionKey: `${harness}-sess`,
    chatId: `${harness}-chat`,
    modelId: 'claude-sonnet-4-5::effort=medium',
    delegationId: 'del-1',
    delegationAttemptId: 'att-1',
    delegationAssignment: 'review',
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  if (usage) {
    kernel.broadcastRoom(room, { type: 'sdkEvent', event: { type: 'usage', usage } });
  }
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'run-1', status: 'completed' });

  const deltas = records.filter((row) => row.eventType === 'delta');
  const runs = records.filter((row) => row.eventType === 'run');
  if (expectTokens) {
    assert.equal(deltas.length, 1, `${harness} records one token delta`);
    assert.deepEqual(deltas[0].tokens, expectTokens, `${harness} token mapping`);
  } else {
    assert.equal(deltas.length, 0, `${harness} streams no tokens, so no delta`);
  }
  assert.equal(runs.length, 1, `${harness} records one run event`);
  for (const partial of [...deltas, ...runs]) {
    assert.equal(partial.harness, harness);
    assert.equal(partial.role, 'review');
    assert.equal(partial.delegationId, 'del-1');
    assert.equal(partial.attemptId, 'att-1');
    assert.equal(partial.model, 'claude-sonnet-4-5');
    assert.equal(partial.chatId, `${harness}-chat`);
    assert.equal(partial.feature, 'chat');
    assert.equal(partial.provider, harness === 'openrouter' ? 'openrouter' : 'other');
  }
  assert.equal(runs[0].outcome, 'ok');
  assert.equal(Number.isFinite(runs[0].latencyMs), true);
  return { records, deltas, runs };
}

const cases = [
  {
    harness: 'claude',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300 },
    expectTokens: { textInput: 1000, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 300, reasoning: 0 },
  },
  {
    harness: 'codex',
    usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 15 },
    expectTokens: { textInput: 600, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 400, reasoning: 15 },
  },
  {
    harness: 'openrouter',
    usage: { prompt_tokens: 40, completion_tokens: 12 },
    expectTokens: { textInput: 40, textOutput: 12, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
  },
  {
    harness: 'deepseek',
    usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 100, reasoningTokens: 20 },
    expectTokens: { textInput: 900, textOutput: 50, audioInput: 0, audioOutput: 0, cachedInput: 100, reasoning: 20 },
  },
  {
    harness: 'qwen',
    usage: { input_tokens: 10, output_tokens: 5 },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
  },
  {
    harness: 'opencode',
    usage: { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 2, reasoning: 0 },
  },
  {
    harness: 'codebuddy',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 2, reasoning: 0 },
  },
];

for (const testCase of cases) {
  test(`room-kernel telemetry for ${testCase.harness}`, () => {
    runHarnessStream(testCase.harness, testCase);
  });
}

test('run events classify errors and aborts', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'codex',
    persistHistory: () => {},
    recordUsage: (partial) => records.push(partial),
  });
  const failed = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1' });
  kernel.broadcastRoom(failed, { type: 'sdkPromptStarted' });
  kernel.broadcastRoom(failed, { type: 'sdkRunFinished', status: 'error', lastErrorCode: 'codex_error' });
  const aborted = kernel.createRoomState({ sessionKey: 's3', chatId: 'c3' });
  kernel.broadcastRoom(aborted, { type: 'sdkPromptStarted' });
  kernel.broadcastRoom(aborted, { type: 'sdkRunFinished', status: 'cancelled' });

  assert.equal(records[0].outcome, 'error');
  assert.equal(records[0].errorCode, 'codex_error');
  assert.equal(records[1].outcome, 'aborted');
});

test('duplicate sdkRunFinished records a run once', () => {
  const records = [];
  const kernel = createAgentRoomKernel({
    transport: 'codex',
    persistHistory: () => {},
    recordUsage: (partial) => records.push(partial),
  });
  const room = kernel.createRoomState({ sessionKey: 'dup-sess', chatId: 'dup-chat' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted' });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', status: 'completed' });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', status: 'completed' });
  assert.equal(records.filter((row) => row.eventType === 'run').length, 1);

  // A synthetic finish without sdkPromptStarted is still recorded, once.
  const bare = kernel.createRoomState({ sessionKey: 'bare-sess', chatId: 'bare-chat' });
  kernel.broadcastRoom(bare, { type: 'sdkRunFinished', status: 'error' });
  kernel.broadcastRoom(bare, { type: 'sdkRunFinished', status: 'error' });
  const bareRuns = records.filter((row) => row.chatId === 'bare-chat' && row.eventType === 'run');
  assert.equal(bareRuns.length, 1);
  assert.equal(bareRuns[0].outcome, 'error');
});

test('claude delta pricing follows auth mode and reported cost', () => {
  const previous = process.env.CRETLI_CLAUDE_AUTH_MODE;
  try {
    process.env.CRETLI_CLAUDE_AUTH_MODE = 'subscription';
    const sub = recordHarnessUsageDelta(
      { chatId: 'c1' },
      'claude',
      { totalCostUsd: 0.42, usage: { input_tokens: 1000, output_tokens: 100 } },
      (partial) => partial
    );
    assert.equal(sub.billingMode, 'subscription');
    assert.equal(sub.reportedUsd, undefined);

    process.env.CRETLI_CLAUDE_AUTH_MODE = 'api-key';
    const api = recordHarnessUsageDelta(
      { chatId: 'c1' },
      'claude',
      { totalCostUsd: 0.42, usage: { input_tokens: 1000, output_tokens: 100 } },
      (partial) => partial
    );
    assert.equal(api.billingMode, undefined);
    assert.equal(api.reportedUsd, 0.42);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_CLAUDE_AUTH_MODE;
    else process.env.CRETLI_CLAUDE_AUTH_MODE = previous;
  }
});

test('openrouter loop emits usage events instead of writing the ledger', async () => {
  const events = [];
  async function* streamUsage() {
    yield { deltaText: 'hi' };
    yield { usage: { prompt_tokens: 40, completion_tokens: 12 } };
    yield { finishReason: 'stop' };
  }
  const result = await runOpenRouterAgentLoop({
    model: 'test-model',
    cwd: process.cwd(),
    mode: 'agent',
    messages: [{ role: 'user', content: 'ping' }],
    extraTools: [],
    streamChatCompletion: streamUsage,
    callbacks: { onEvent: (event) => events.push(event) },
  });
  assert.equal(result.ok, true);
  const usage = events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].usage, { prompt_tokens: 40, completion_tokens: 12 });
});

test('run outcomes/limits are derived without leaking the error message', () => {
  assert.equal(resolveHarnessRunOutcome('completed'), 'ok');
  assert.equal(resolveHarnessRunOutcome('cancelled'), 'aborted');
  assert.equal(resolveHarnessRunOutcome('plan_guard_cancelled'), 'aborted');
  assert.equal(resolveHarnessRunOutcome('error', '429 rate limit exceeded'), 'limit');
  assert.equal(resolveHarnessRunOutcome('error', 'boom'), 'error');

  const partial = buildHarnessRunUsage({}, 'deepseek', {
    status: 'error',
    lastErrorMessage: '429 rate limit exceeded',
  });
  assert.equal(partial.outcome, 'limit');
  assert.equal(partial.errorCode, 'usage_limit');
  assert.equal(JSON.stringify(partial).includes('rate limit'), false);
});
