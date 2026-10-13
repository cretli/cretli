import assert from 'node:assert/strict';
import { takeStreamDelta } from '../app_front/lib/sdk-chat-format.js';
import {
  CLAUDE_ASSISTANT_ERROR_MESSAGES,
  buildClaudeRateLimitNotice,
  collectClaudeIdleNotices,
  createClaudeEventNormalizer,
  normalizeClaudeMessage,
  resolveClaudeAssistantErrorMessage,
  resolveClaudeAssistantMessageUsage,
  resolveClaudeResultUsage,
  stringifyClaudeToolResult,
} from '../lib/agent-harness/claude-event-normalizer.js';
import { resolvePlanModeSdkEventDecision } from '../lib/sdk/sdk-plan-guard.js';

/**
 * @param {unknown} event
 * @returns {string}
 */
function readAssistantText(event) {
  if (!event || typeof event !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (event);
  if (rec.type !== 'assistant' || !rec.message || typeof rec.message !== 'object') return '';
  const message = /** @type {Record<string, unknown>} */ (rec.message);
  const content = Array.isArray(message.content) ? message.content : [];
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = /** @type {Record<string, unknown>} */ (block);
    if (item.type === 'text' && typeof item.text === 'string') out += item.text;
  }
  return out;
}

const sessionEvents = normalizeClaudeMessage({
  type: 'system',
  subtype: 'init',
  session_id: 'claude-sess-1',
});
assert.deepEqual(sessionEvents, [{ kind: 'session', sessionId: 'claude-sess-1' }]);

const assistantText = normalizeClaudeMessage({
  type: 'assistant',
  session_id: 'claude-sess-1',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello from Claude' }],
  },
});
assert.equal(assistantText.length, 1);
assert.equal(assistantText[0].type, 'assistant');
assert.equal(assistantText[0].message.content[0].text, 'Hello from Claude');

const toolEvents = normalizeClaudeMessage({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'README.md' } }],
  },
});
assert.equal(toolEvents[0].type, 'tool_call');
assert.equal(toolEvents[0].name, 'Read');
assert.equal(toolEvents[0].status, 'running');
assert.equal(toolEvents[0].call_id, 'call-1');
assert.equal(toolEvents[0].args.file_path, 'README.md');

const resultEvents = normalizeClaudeMessage({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
    ],
  },
});
assert.equal(resultEvents[0].type, 'tool_call');
assert.equal(resultEvents[0].status, 'completed');
assert.equal(resultEvents[0].result, 'ok');

const failedTool = normalizeClaudeMessage({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'call-2', is_error: true, content: 'permission denied' },
    ],
  },
});
assert.equal(failedTool[0].status, 'error');
assert.match(String(failedTool[0].result), /permission denied/);

const success = normalizeClaudeMessage({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'claude-sess-1',
  duration_ms: 900,
  total_cost_usd: 0.01,
  result: 'done',
});
assert.equal(success[0].kind, 'result');
assert.equal(success[0].status, 'completed');
assert.equal(success[0].sessionId, 'claude-sess-1');
assert.equal(success[0].durationMs, 900);

const failed = normalizeClaudeMessage({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  session_id: 'claude-sess-1',
  errors: ['boom'],
});
assert.equal(failed[0].status, 'error');
assert.equal(failed[0].errorMessage, 'boom');

// permission_denied is advisory: a notice, never an api_error that fails a run.
const denied = normalizeClaudeMessage({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Bash',
});
assert.equal(denied[0].kind, 'notice');
assert.equal(denied[0].noticeType, 'permission_denied');
assert.match(String(denied[0].message), /Bash/);
assert.equal(denied[0].errorType, 'permission_denied');

const deniedWithReason = normalizeClaudeMessage({
  type: 'system',
  subtype: 'permission_denied',
  tool_name: 'Edit',
  decision_reason: 'Denied by policy',
});
assert.equal(deniedWithReason[0].kind, 'notice');
assert.equal(deniedWithReason[0].message, 'Denied by policy');

// api_retry is SDK-side retrying: informational, not an error.
const retry = normalizeClaudeMessage({
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 5,
  retry_delay_ms: 1500,
  error: 'overloaded',
});
assert.equal(retry[0].kind, 'notice');
assert.equal(retry[0].noticeType, 'api_retry');
assert.equal(retry[0].attempt, 2);
assert.equal(retry[0].max_retries, 5);
assert.equal(retry[0].retry_delay_ms, 1500);
assert.equal(retry[0].error, 'overloaded');

// assistant.error keeps error semantics but maps the raw code to a friendly EN message.
const assistantError = normalizeClaudeMessage({
  type: 'assistant',
  error: 'rate_limit',
  message: { content: [] },
});
assert.equal(assistantError[0].kind, 'api_error');
assert.equal(assistantError[0].errorType, 'rate_limit');
assert.equal(assistantError[0].message, CLAUDE_ASSISTANT_ERROR_MESSAGES.rate_limit);
assert.match(String(assistantError[0].message), /rate limit/i);

const authError = normalizeClaudeMessage({
  type: 'assistant',
  error: 'authentication_failed',
  message: { content: [] },
});
assert.equal(authError[0].kind, 'api_error');
assert.equal(authError[0].errorType, 'authentication_failed');
assert.match(String(authError[0].message), /Anthropic API key|cloud provider credentials/);

assert.equal(
  resolveClaudeAssistantErrorMessage('model_not_found'),
  CLAUDE_ASSISTANT_ERROR_MESSAGES.model_not_found,
);
assert.match(resolveClaudeAssistantErrorMessage('brand_new_code'), /brand_new_code/);
assert.equal(resolveClaudeAssistantErrorMessage(''), 'Claude run failed.');

assert.deepEqual(normalizeClaudeMessage(null), []);
assert.deepEqual(normalizeClaudeMessage({ type: 'unknown' }), []);

assert.equal(stringifyClaudeToolResult([{ type: 'text', text: 'a' }, 'b']), 'a\nb');

const streamNormalizer = createClaudeEventNormalizer();
const firstDelta = streamNormalizer.normalize({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
});
const secondDelta = streamNormalizer.normalize({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
});
const assembled = streamNormalizer.normalize({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello' }] },
});
assert.equal(readAssistantText(firstDelta[0]), 'Hel');
assert.equal(readAssistantText(secondDelta[0]), 'Hello');
assert.equal(assembled.filter((event) => event.type === 'assistant').length, 0);

const thinkingEvents = createClaudeEventNormalizer().normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'Checking code…' },
  },
});
assert.equal(thinkingEvents[0].type, 'thinking');
assert.equal(thinkingEvents[0].text, 'Checking code…');

const turnNormalizer = createClaudeEventNormalizer();
const turnEvents = [
  ...turnNormalizer.normalize({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Analiza gotowa.\n\n' } },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Analiza gotowa.\n\n' }] },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'call-9', name: 'Bash', input: { command: 'ls' } }] },
  }),
  ...turnNormalizer.normalize({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Gotowe ✅' } },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Gotowe ✅' }] },
  }),
];
const rendered = { _sdkAssistantAcc: '' };
let visible = '';
for (const event of turnEvents) {
  if (event.type === 'tool_call') {
    delete rendered._sdkAssistantAcc;
    continue;
  }
  visible += takeStreamDelta(rendered, '_sdkAssistantAcc', readAssistantText(event));
}
assert.equal(visible, 'Analiza gotowa.\n\nGotowe ✅');

// --- Task 2: tool_use is announced only by the full `assistant` message ---
const guardNormalizer = createClaudeEventNormalizer();
const streamToolStart = guardNormalizer.normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call-77', name: 'Bash', input: {} },
  },
});
assert.deepEqual(streamToolStart, []);
const streamToolDelta = guardNormalizer.normalize({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf /tmp/x"}' } },
});
assert.equal(streamToolDelta.filter((event) => event.type === 'tool_call').length, 0);
const fullToolCall = guardNormalizer.normalize({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'call-77', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] },
});
assert.equal(fullToolCall.filter((event) => event.type === 'tool_call').length, 1);
assert.equal(fullToolCall[0].status, 'running');
assert.equal(fullToolCall[0].args.command, 'rm -rf /tmp/x');
const repeatedToolCall = guardNormalizer.normalize({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'call-77', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] },
});
assert.equal(repeatedToolCall.filter((event) => event.type === 'tool_call').length, 0);
// The guard now only sees the full-argument call, so an empty-input stream
// event can no longer be misclassified as read-only.
assert.equal(resolvePlanModeSdkEventDecision({ transport: 'claude', mode: 'plan', event: fullToolCall[0] }).deny, true);
assert.equal(streamToolStart.length, 0);

// --- Task 4: subagent messages (parent_tool_use_id) stay out of the answer ---
const subNormalizer = createClaudeEventNormalizer();
const mainText = subNormalizer.normalize({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Main answer' }] },
});
assert.equal(readAssistantText(mainText[0]), 'Main answer');
const subText = subNormalizer.normalize({
  type: 'assistant',
  parent_tool_use_id: 'tool-abc',
  message: { content: [{ type: 'text', text: 'Subagent internal reasoning' }] },
});
assert.equal(subText.filter((event) => event.type === 'assistant').length, 0);
const subThinking = subNormalizer.normalize({
  type: 'stream_event',
  parent_tool_use_id: 'tool-abc',
  event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'sub thinking' } },
});
assert.deepEqual(subThinking, []);
const subStreamText = subNormalizer.normalize({
  type: 'stream_event',
  parent_tool_use_id: 'tool-abc',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' sub stream' } },
});
assert.deepEqual(subStreamText, []);
const mainMore = subNormalizer.normalize({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' continues' } },
});
assert.equal(readAssistantText(mainMore[0]), 'Main answer continues');
const subTool = subNormalizer.normalize({
  type: 'assistant',
  parent_tool_use_id: 'tool-abc',
  message: { content: [{ type: 'tool_use', id: 'sub-call-1', name: 'Read', input: { file_path: 'x' } }] },
});
assert.equal(subTool.length, 1);
assert.equal(subTool[0].type, 'tool_call');
assert.equal(subTool[0].status, 'running');
assert.equal(subTool[0].parentToolUseId, 'tool-abc');
const subResult = subNormalizer.normalize({
  type: 'user',
  parent_tool_use_id: 'tool-abc',
  message: { content: [{ type: 'tool_result', tool_use_id: 'sub-call-1', content: 'sub result' }] },
});
assert.equal(subResult.length, 1);
assert.equal(subResult[0].parentToolUseId, 'tool-abc');
assert.equal(subResult[0].status, 'completed');
assert.equal(subResult[0].result, 'sub result');
const mainCall = subNormalizer.normalize({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'main-call-1', name: 'Bash', input: { command: 'ls' } }] },
});
assert.equal(mainCall.length, 1);
assert.equal(mainCall[0].parentToolUseId, undefined);

// --- Task E: result telemetry → usage event (camelCase, frontend shape) ---
const usageResult = normalizeClaudeMessage({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'claude-sess-1',
  duration_ms: 1234,
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 20,
  },
  modelUsage: { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 40, costUSD: 0.42 } },
});
assert.equal(usageResult[0].kind, 'usage');
assert.equal(usageResult[0].usage.inputTokens, 420);
assert.equal(usageResult[0].usage.outputTokens, 40);
assert.equal(usageResult[0].usage.totalTokens, 460);
assert.equal(usageResult[0].usage.cacheReadTokens, 300);
assert.equal(usageResult[0].usage.cacheWriteTokens, 20);
assert.equal(usageResult[0].totalCostUsd, 0.42);
assert.equal(usageResult[0].durationMs, 1234);
assert.equal(usageResult[0].modelUsage['claude-sonnet-4-6'].costUSD, 0.42);
assert.equal(usageResult[1].kind, 'result');
assert.equal(usageResult[1].status, 'completed');
assert.deepEqual(
  resolveClaudeResultUsage({ usage: { input_tokens: 0, output_tokens: 0 } }),
  null,
);

// --- Task E: rate_limit_event → advisory notice, never an error ---
const rateLimit = normalizeClaudeMessage({
  type: 'rate_limit_event',
  session_id: 'claude-sess-1',
  rate_limit_info: { status: 'allowed_warning', resetsAt: 1_800_000_000 },
});
assert.equal(rateLimit.length, 1);
assert.equal(rateLimit[0].kind, 'notice');
assert.equal(rateLimit[0].noticeType, 'rate_limit');
assert.equal(rateLimit[0].status, 'allowed_warning');
assert.equal(rateLimit[0].resetsAt, 1_800_000_000);
assert.match(String(rateLimit[0].message), /rate limit/i);
assert.match(String(rateLimit[0].message), /Resets at/);

// --- Task E: compact_boundary → advisory notice ---
const compact = normalizeClaudeMessage({
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'claude-sess-1',
  compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 40000 },
});
const compactNotice = compact.find((event) => event.kind === 'notice');
assert.ok(compactNotice, 'compact notice is emitted');
assert.equal(compactNotice.noticeType, 'compact');
assert.equal(compactNotice.trigger, 'auto');
assert.equal(compactNotice.preTokens, 180000);
assert.equal(compactNotice.postTokens, 40000);

// --- Task P: between-turn collection returns only notices ---
assert.deepEqual(
  collectClaudeIdleNotices({ type: 'tool_progress', tool_use_id: 't1' }).length,
  0,
);
assert.deepEqual(
  collectClaudeIdleNotices({ type: 'system', subtype: 'task_notification', session_id: 's' }).length,
  0,
);
assert.equal(
  collectClaudeIdleNotices({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual' },
  })[0].noticeType,
  'compact',
);
assert.equal(
  collectClaudeIdleNotices({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })[0].noticeType,
  'rate_limit',
);

// --- Usage gap: per-assistant-message usage and the ephemeral TTL split ---
const assistantUsage = resolveClaudeAssistantMessageUsage({
  type: 'assistant',
  message: {
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 },
    },
  },
});
assert.equal(assistantUsage.inputTokens, 150);
assert.equal(assistantUsage.cacheWriteTokens, 50);
assert.equal(assistantUsage.cacheWrite5mTokens, 50);
assert.equal(assistantUsage.cacheWrite1hTokens, undefined);

const resultWithSplit = resolveClaudeResultUsage({
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 },
  },
});
assert.equal(resultWithSplit.cacheWriteTokens, 7);
assert.equal(resultWithSplit.cacheWrite5mTokens, 4);
assert.equal(resultWithSplit.cacheWrite1hTokens, 3);

const usageGapNormalizer = createClaudeEventNormalizer();
const firstCallItems = usageGapNormalizer.normalize({
  type: 'assistant',
  message: {
    content: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 50,
    },
  },
});
const apiCallItem = firstCallItems.find((event) => event.kind === 'api_call_usage');
assert.ok(apiCallItem, 'the first API call of a turn is collected');
assert.equal(apiCallItem.first, true);
assert.equal(apiCallItem.usage.cacheWriteTokens, 50);
assert.equal(
  usageGapNormalizer.normalize({
    type: 'assistant',
    message: { content: [], usage: { input_tokens: 300, output_tokens: 5, cache_read_input_tokens: 80 } },
  }).filter((event) => event.kind === 'api_call_usage').length,
  0,
  'later API calls of the same turn do not re-announce the first call'
);
const usageGapResult = usageGapNormalizer.normalize({
  type: 'result',
  subtype: 'success',
  is_error: false,
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 },
  },
});
const usageGapUsage = usageGapResult.find((event) => event.kind === 'usage');
assert.equal(usageGapUsage.usage.cacheWriteTokens, 5);
assert.equal(usageGapUsage.usage.cacheWrite5mTokens, 5);
assert.deepEqual(usageGapUsage.firstApiCallUsage, apiCallItem.usage);
// A result ends the turn, so the next turn's first call is collected again.
const nextTurn = usageGapNormalizer.normalize({
  type: 'assistant',
  message: { content: [], usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 42 } },
});
assert.equal(nextTurn.filter((event) => event.kind === 'api_call_usage').length, 1);

// --- Plan-limit matrix: full / partial / missing / unknown window ---
{
  const notice = (info) => buildClaudeRateLimitNotice({ type: 'rate_limit_event', rate_limit_info: info });
  const full = notice({ status: 'allowed_warning', utilization: 0.5, resetsAt: 1_800_000_000, rateLimitType: 'five_hour' });
  assert.equal(full.utilization, 50);
  assert.equal(full.rateLimitType, 'five_hour');
  // Partial: no percentage and no reset stay absent (never 0 / never invented).
  const partial = notice({ status: 'rejected', rateLimitType: 'seven_day' });
  assert.equal('utilization' in partial, false);
  assert.equal('resetsAt' in partial, false);
  assert.doesNotMatch(partial.message, /Resets at/);
  for (const bad of [null, '', '  ', true, false, [], {}, 'abc', NaN, Infinity]) {
    assert.equal('utilization' in notice({ status: 'allowed', utilization: bad }), false, String(bad));
  }
  // A real zero is a reading; only absence is unknown.
  assert.equal(notice({ status: 'allowed', utilization: 0 }).utilization, 0);
  // Values outside [0,1] are neither clamped nor rescaled beyond the one x100.
  assert.equal(notice({ status: 'allowed_warning', utilization: 1.2 }).utilization, 120);
  // Unknown window type passes through verbatim as provenance.
  assert.equal(notice({ status: 'allowed', rateLimitType: 'brand_new_window' }).rateLimitType, 'brand_new_window');
}

// --- Context meter: per-call occupancy of main-thread API calls ---
{
  const callUsage = (input, output, cacheRead, cacheWrite) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  });
  const meterNormalizer = createClaudeEventNormalizer();
  const mainCallEvents = meterNormalizer.normalize({
    type: 'assistant',
    message: { model: 'claude-sonnet-4-20250514', content: [], usage: callUsage(10, 20, 1000, 500) },
  });
  const mainContext = mainCallEvents.find((event) => event.kind === 'context_usage');
  assert.equal(mainContext.usage.totalTokens, 1530);
  assert.equal(mainContext.model, 'claude-sonnet-4-20250514');
  const subAgentEvents = meterNormalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: 'tool-abc',
    message: { model: 'claude-haiku-4-5-20251001', content: [], usage: callUsage(5, 5, 90000, 0) },
  });
  assert.equal(subAgentEvents.filter((event) => event.kind === 'context_usage').length, 0);
  const turnEvents = meterNormalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: callUsage(10, 20, 1000, 500),
  });
  const turnUsage = turnEvents.find((event) => event.kind === 'usage');
  assert.deepEqual(turnUsage.lastCallUsage, mainContext.usage);
  assert.equal(turnUsage.lastCallModel, 'claude-sonnet-4-20250514');

  const placeholderEvents = createClaudeEventNormalizer().normalize({
    type: 'assistant',
    message: { model: '<synthetic>', content: [], usage: callUsage(3, 1, 0, 0) },
  });
  assert.equal(placeholderEvents.find((event) => event.kind === 'context_usage').model, null);

  const compactNormalizer = createClaudeEventNormalizer();
  compactNormalizer.normalize({
    type: 'assistant',
    message: { model: 'claude-sonnet-4-20250514', content: [], usage: callUsage(10, 20, 1000, 500) },
  });
  compactNormalizer.normalize({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 150000 },
  });
  const compactTurn = compactNormalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: callUsage(1, 1, 0, 0),
  });
  assert.equal('lastCallUsage' in compactTurn.find((event) => event.kind === 'usage'), false);
}

// --- Context meter: one call reported by several messages, and the SDK window ---
{
  const usageOf = (output) => ({
    input_tokens: 2,
    output_tokens: output,
    cache_read_input_tokens: 144991,
    cache_creation_input_tokens: 0,
  });
  const contextOf = (events) => events.filter((event) => event.kind === 'context_usage');
  const streamNormalizer = createClaudeEventNormalizer();
  // The prompt size is known as soon as the call starts.
  const started = contextOf(streamNormalizer.normalize({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usageOf(8) } },
  }));
  assert.equal(started.length, 1);
  assert.equal(started[0].usage.totalTokens, 145001);
  assert.equal(started[0].model, 'claude-opus-5-5');
  // Per-block messages of the same call repeat the start usage: no new event.
  const block = { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [], usage: usageOf(8) } };
  assert.equal(contextOf(streamNormalizer.normalize(block)).length, 0);
  // `message_delta` carries the final output count of the call.
  const finished = contextOf(streamNormalizer.normalize({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2442 } },
  }));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].usage.outputTokens, 2442);
  assert.equal(finished[0].usage.totalTokens, 147435);
  // A late per-block message must not roll the output back.
  assert.equal(contextOf(streamNormalizer.normalize(block)).length, 0);
  // Sub-agent stream events never move the main meter.
  assert.equal(streamNormalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: 'tool-abc',
    event: { type: 'message_start', message: { id: 'msg_sub', model: 'claude-haiku-5-5', usage: usageOf(1) } },
  }).length, 0);
  const runUsage = streamNormalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: usageOf(2442),
    modelUsage: {
      'claude-opus-5-5': { contextWindow: 1000000, maxOutputTokens: 128000 },
      'claude-haiku-5-5': { contextWindow: 200000, maxOutputTokens: 128000 },
    },
  }).find((event) => event.kind === 'usage');
  assert.equal(runUsage.lastCallUsage.totalTokens, 147435);
  assert.equal(runUsage.lastCallContextWindowTokens, 1000000);
  // The next call of a new turn is a new message id and starts from its own usage.
  const nextCall = contextOf(streamNormalizer.normalize({
    type: 'assistant',
    message: { id: 'msg_2', model: 'claude-opus-5-5', content: [], usage: usageOf(5) },
  }));
  assert.equal(nextCall[0].usage.totalTokens, 144998);
}

console.log('claude-event-normalizer.test.js OK');
