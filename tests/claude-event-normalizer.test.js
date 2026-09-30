import assert from 'node:assert/strict';
import { takeStreamDelta } from '../app_front/lib/sdk-chat-format.js';
import {
  CLAUDE_ASSISTANT_ERROR_MESSAGES,
  collectClaudeIdleNotices,
  createClaudeEventNormalizer,
  normalizeClaudeMessage,
  resolveClaudeAssistantErrorMessage,
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

console.log('claude-event-normalizer.test.js OK');
