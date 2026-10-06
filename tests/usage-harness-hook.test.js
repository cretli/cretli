import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { runOpenRouterAgentLoop } from '../lib/agent-harness/openrouter-agent-loop.js';
import { normalizeClaudeMessage } from '../lib/agent-harness/claude-event-normalizer.js';
import { buildClaudeUsageSdkEvent } from '../lib/claude/claude-agent-ws.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import {
  buildHarnessRunUsage,
  recordHarnessUsageDelta,
  resolveHarnessRunOutcome,
} from '../lib/usage/harness-usage.js';

/**
 * Wraps the injectable `recordUsage` seam so the test asserts the canonical
 * event the ledger would persist (contract versions, identity, completeness)
 * instead of a raw partial.
 */
function recordThroughEvent(records) {
  return (partial) => {
    const event = createUsageEvent(partial);
    records.push(event);
    return event;
  };
}

function createKernel(harness, records) {
  return createAgentRoomKernel({
    transport: harness,
    persistHistory: () => {},
    recordUsage: recordThroughEvent(records),
  });
}

/**
 * Exercises the room-kernel telemetry hook for a harness through the same
 * `sdkEvent` boundary the WS adapters use.
 */
function runHarnessStream(harness, { usageEvent, expectTokens }) {
  const records = [];
  const kernel = createKernel(harness, records);
  const room = kernel.createRoomState({
    sessionKey: `${harness}-sess`,
    chatId: `${harness}-chat`,
    modelId: 'claude-sonnet-4-5::effort=medium',
    delegationId: 'del-1',
    delegationAttemptId: 'att-1',
    delegationAssignment: 'review',
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-1' });
  if (usageEvent) kernel.broadcastRoom(room, { type: 'sdkEvent', event: usageEvent });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'run-1', status: 'completed' });

  const deltas = records.filter((row) => row.eventType === 'delta');
  const runs = records.filter((row) => row.eventType === 'run');
  if (expectTokens) {
    assert.equal(deltas.length, 1, `${harness} records one token delta`);
    assert.deepEqual(deltas[0].tokens, expectTokens, `${harness} token mapping`);
    assert.equal(deltas[0].completeness, 'partial', `${harness} delta is never complete`);
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
    // Claude reaches this boundary as resolved camelCase (the output of
    // `resolveClaudeResultUsage`), not as raw snake_case.
    usageEvent: {
      type: 'usage',
      usage: { inputTokens: 1300, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 0 },
    },
    expectTokens: { textInput: 1000, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 300, cacheWrite: 0, reasoning: 0 },
  },
  {
    harness: 'codex',
    usageEvent: { type: 'usage', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 15 } },
    expectTokens: { textInput: 600, textOutput: 200, audioInput: 0, audioOutput: 0, cachedInput: 400, cacheWrite: 0, reasoning: 15 },
  },
  {
    harness: 'openrouter',
    usageEvent: { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 12 } },
    expectTokens: { textInput: 40, textOutput: 12, audioInput: 0, audioOutput: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 },
  },
  {
    harness: 'deepseek',
    usageEvent: { type: 'usage', usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 100, reasoningTokens: 20 } },
    expectTokens: { textInput: 900, textOutput: 50, audioInput: 0, audioOutput: 0, cachedInput: 100, cacheWrite: 0, reasoning: 20 },
  },
  {
    harness: 'qwen',
    usageEvent: { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 },
  },
  {
    harness: 'opencode',
    usageEvent: { type: 'usage', usage: { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } } },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 2, cacheWrite: 0, reasoning: 0 },
  },
  {
    harness: 'codebuddy',
    // CodeBuddy stays raw snake_case at the adapter boundary.
    usageEvent: { type: 'usage', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } },
    expectTokens: { textInput: 10, textOutput: 5, audioInput: 0, audioOutput: 0, cachedInput: 2, cacheWrite: 0, reasoning: 0 },
  },
];

for (const testCase of cases) {
  test(`room-kernel telemetry for ${testCase.harness}`, () => {
    runHarnessStream(testCase.harness, testCase);
  });
}

test('Claude result flows through the production normalizer, WS and kernel (1070 disjoint)', () => {
  const records = [];
  const kernel = createKernel('claude', records);
  const room = kernel.createRoomState({
    sessionKey: 'claude-prod',
    chatId: 'claude-prod-chat',
    modelId: 'claude-sonnet-4-5',
  });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-claude' });

  // Production normalizer: raw result.usage → resolved camelCase usage item.
  const items = normalizeClaudeMessage({
    type: 'result',
    subtype: 'success',
    session_id: 'claude-sess-prod',
    duration_ms: 1200,
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
    modelUsage: {
      'claude-sonnet-4-5': { inputTokens: 1050, outputTokens: 20, costUSD: 0.25 },
    },
  });
  const usageItem = items.find((item) => item.kind === 'usage');
  assert.ok(usageItem, 'the normalizer emits a usage item');
  assert.equal(usageItem.usage.inputTokens, 1050, 'resolved input includes cache read + write');
  assert.equal(usageItem.usage.cacheReadTokens, 900);
  assert.equal(usageItem.usage.cacheWriteTokens, 50);
  assert.equal(usageItem.final, true, 'result usage is marked as the final run report');
  assert.equal(usageItem.modelUsage['claude-sonnet-4-5'].costUSD, 0.25);

  // Production WS adapter (claude-agent-ws.js): `buildClaudeUsageSdkEvent`
  // copies `final`, cost, duration and modelUsage onto the sdkEvent. Using the
  // real function (instead of a hand-copied shape) covers the propagation path.
  const usageEvent = buildClaudeUsageSdkEvent(usageItem);
  assert.equal(usageEvent.final, true, 'the final coverage proof survives the WS boundary');
  assert.equal(usageEvent.totalCostUsd, 0.25);
  assert.equal(usageEvent.durationMs, 1200);
  assert.equal(usageEvent.modelUsage['claude-sonnet-4-5'].costUSD, 0.25);
  // A non-final usage item must not invent a coverage proof.
  const nonFinal = buildClaudeUsageSdkEvent({ kind: 'usage', usage: { inputTokens: 1 } });
  assert.equal('final' in nonFinal, false);
  kernel.broadcastRoom(room, { type: 'sdkEvent', event: usageEvent });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'run-claude', status: 'completed' });

  const deltas = records.filter((row) => row.eventType === 'delta');
  const runs = records.filter((row) => row.eventType === 'run');
  assert.equal(deltas.length, 1);
  assert.deepEqual(deltas[0].tokens, {
    textInput: 100,
    textOutput: 20,
    audioInput: 0,
    audioOutput: 0,
    cachedInput: 900,
    cacheWrite: 50,
    reasoning: 0,
  });
  const disjoint =
    deltas[0].tokens.textInput
    + deltas[0].tokens.cachedInput
    + deltas[0].tokens.cacheWrite
    + deltas[0].tokens.textOutput;
  assert.equal(disjoint, 1070, '100 uncached + 900 cache-read + 50 cache-write + 20 output');
  assert.equal(deltas[0].normalizationVersion, 2);
  assert.equal(deltas[0].schemaVersion, 2);
  assert.equal(runs[0].measurementPresent, true);
  assert.deepEqual(runs[0].coverage, {
    proof: true,
    expectedRequests: 1,
    coveredRequests: 1,
    scope: 'own',
  });
  assert.equal(runs[0].completeness, 'complete', 'a final coverage proof makes the run complete');
});

test('a child usage payload keeps its own model instead of the parent room model', () => {
  const partial = recordHarnessUsageDelta(
    { chatId: 'c1', modelId: 'parent-model' },
    'deepseek',
    { type: 'usage', model: 'child-model', usage: { inputTokens: 10, outputTokens: 2 } },
    (row) => row,
  );
  assert.ok(partial);
  assert.equal(partial.model, 'child-model');

  const event = createUsageEvent(partial);
  assert.equal(event.model, 'child-model');
});

test('run completeness distinguishes missing, unsupported and unproven coverage', () => {
  // Ended without any measurement -> missing.
  const missing = createUsageEvent(buildHarnessRunUsage({}, 'codex', { status: 'completed' }));
  assert.equal(missing.measurementPresent, undefined);
  assert.equal(missing.completeness, 'missing');

  // A harness outside the supported matrix -> unsupported.
  const unsupported = createUsageEvent(buildHarnessRunUsage({}, 'mystery', { status: 'completed' }));
  assert.equal(unsupported.completeness, 'unsupported');

  // Measurement present but no final proof -> partial, even with counts.
  const unproven = createUsageEvent(buildHarnessRunUsage(
    { _runHadMeasurement: true, _runUsageReports: 2, _runCoveredRequests: 2 },
    'codex',
    { status: 'completed' },
  ));
  assert.equal(unproven.measurementPresent, true);
  assert.deepEqual(unproven.coverage, {
    proof: false,
    expectedRequests: 2,
    coveredRequests: 2,
    scope: 'own',
  });
  assert.equal(unproven.completeness, 'partial');
});

test('run events classify errors and aborts', () => {
  const records = [];
  const kernel = createKernel('codex', records);
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
  const kernel = createKernel('codex', records);
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
      { totalCostUsd: 0.42, usage: { inputTokens: 1000, outputTokens: 100 } },
      (partial) => partial
    );
    assert.equal(sub.billingMode, 'subscription');
    assert.equal(sub.reportedUsd, undefined);

    process.env.CRETLI_CLAUDE_AUTH_MODE = 'api-key';
    const api = recordHarnessUsageDelta(
      { chatId: 'c1' },
      'claude',
      { totalCostUsd: 0.42, usage: { inputTokens: 1000, outputTokens: 100 } },
      (partial) => partial
    );
    assert.equal(api.billingMode, undefined);
    assert.equal(api.reportedUsd, 0.42);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_CLAUDE_AUTH_MODE;
    else process.env.CRETLI_CLAUDE_AUTH_MODE = previous;
  }
});

test('openrouter loop emits one usage event per loop response', async () => {
  const events = [];
  let call = 0;
  async function* streamUsage({ messages }) {
    call += 1;
    if (call === 1) {
      // First response asks for a tool, so the loop makes a second request.
      yield { deltaText: 'let me look' };
      yield { toolCallDeltas: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] };
      yield { finishReason: 'tool_calls' };
      yield { usage: { prompt_tokens: 40, completion_tokens: 12 } };
    } else {
      yield { deltaText: 'done' };
      yield { finishReason: 'stop' };
      yield { usage: { prompt_tokens: 80, completion_tokens: 8 } };
    }
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
  assert.equal(usage.length, 2, 'each loop response reports its own usage');
  assert.deepEqual(usage[0].usage, { prompt_tokens: 40, completion_tokens: 12 });
  assert.deepEqual(usage[1].usage, { prompt_tokens: 80, completion_tokens: 8 });
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
