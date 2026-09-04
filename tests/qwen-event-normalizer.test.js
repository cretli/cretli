import assert from 'node:assert/strict';
import { takeStreamDelta } from '../app_front/lib/sdk-chat-format.js';
import {
  createQwenEventNormalizer,
  normalizeQwenMessage,
} from '../lib/agent-harness/qwen-event-normalizer.js';

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

const sessionEvents = normalizeQwenMessage({
  type: 'system',
  subtype: 'init',
  session_id: 'qwen-sess-1',
});
assert.deepEqual(sessionEvents, [{ kind: 'session', sessionId: 'qwen-sess-1' }]);

const partialEvents = normalizeQwenMessage({
  type: 'partial',
  message: {
    content: [{ type: 'text', text: 'Hel' }],
  },
});
assert.equal(partialEvents.length, 1);
assert.equal(partialEvents[0].type, 'assistant');
assert.equal(partialEvents[0].message.content[0].text, 'Hel');

const assistantText = normalizeQwenMessage({
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'Hello from Qwen' }],
  },
});
assert.equal(assistantText.length, 1);
assert.equal(assistantText[0].type, 'assistant');
assert.equal(assistantText[0].message.content[0].text, 'Hello from Qwen');

const toolEvents = normalizeQwenMessage({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'README.md' } },
    ],
  },
});
assert.equal(toolEvents[0].type, 'tool_call');
assert.equal(toolEvents[0].name, 'Read');
assert.equal(toolEvents[0].status, 'running');
assert.equal(toolEvents[0].call_id, 'call-1');

const resultEvents = normalizeQwenMessage({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'call-1', name: 'Read', content: 'ok' },
    ],
  },
});
assert.equal(resultEvents[0].type, 'tool_call');
assert.equal(resultEvents[0].status, 'completed');
assert.equal(resultEvents[0].result, 'ok');

const deniedTool = normalizeQwenMessage({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call-denied',
        name: 'ask_user_question',
        content: '[Operation Cancelled] Reason: Denied',
      },
    ],
  },
});
assert.equal(deniedTool[0].status, 'error');
assert.match(String(deniedTool[0].result), /Denied/);

const priorReadTool = normalizeQwenMessage({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call-write',
        name: 'write_file',
        content: 'File `/tmp/example-site/index.php` has not been read in this session. Use the `read_file` tool first.',
      },
    ],
  },
});
assert.equal(priorReadTool[0].status, 'error');
assert.match(String(priorReadTool[0].result), /has not been read/);

const searchNormalizer = createQwenEventNormalizer();
const searchStart = searchNormalizer.normalize({
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'call-search',
        name: 'tool_search',
        input: { query: 'select:exit_plan_mode' },
      },
    ],
  },
});
assert.equal(searchStart[0].name, 'tool_search');
assert.equal(searchStart[0].args.query, 'select:exit_plan_mode');
const searchDone = searchNormalizer.normalize({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'call-search', name: 'tool', content: '1 missing' },
    ],
  },
});
assert.equal(searchDone[0].name, 'tool_search');
assert.equal(searchDone[0].status, 'error');
assert.equal(searchDone[0].args.query, 'select:exit_plan_mode');
assert.equal(searchDone[0].result, 'Not found: exit_plan_mode');

const success = normalizeQwenMessage({
  type: 'result',
  subtype: 'success',
  session_id: 'qwen-sess-1',
  duration_ms: 900,
});
assert.equal(success[0].kind, 'result');
assert.equal(success[0].status, 'completed');
assert.equal(success[0].sessionId, 'qwen-sess-1');

const failed = normalizeQwenMessage({
  type: 'result',
  subtype: 'error',
  error: 'boom',
});
assert.equal(failed[0].status, 'error');
assert.equal(failed[0].errorMessage, 'boom');

const quotaTelemetry = normalizeQwenMessage({
  type: 'system',
  subtype: 'ui_telemetry',
  session_id: 'qwen-sess-1',
  systemPayload: {
    uiEvent: {
      'event.name': 'qwen-code.api_error',
      error_message: '429 Your token-plan 1-week quota has been exhausted. The quota will reset at 09-10 09:31:00 UTC.',
      error_type: 'RateLimitError',
      status_code: 429,
    },
  },
});
assert.equal(quotaTelemetry[0].kind, 'session');
assert.equal(quotaTelemetry[1].kind, 'api_error');
assert.match(String(quotaTelemetry[1].message), /quota has been exhausted/);
assert.equal(quotaTelemetry[1].statusCode, 429);

assert.deepEqual(normalizeQwenMessage(null), []);
assert.deepEqual(normalizeQwenMessage({ type: 'unknown' }), []);

const streamNormalizer = createQwenEventNormalizer();
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

const duplicateNormalizer = createQwenEventNormalizer();
duplicateNormalizer.normalize({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
});
const repeatedSnapshot = duplicateNormalizer.normalize({
  type: 'stream_event',
  message: { content: [{ type: 'text', text: 'Hello' }] },
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
});
assert.equal(repeatedSnapshot.length, 0);

const turnNormalizer = createQwenEventNormalizer();
const phpEvents = [
  ...turnNormalizer.normalize({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'PHP 8.2 jest dostępny.\n\n' },
    },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'PHP 8.2 jest dostępny.\n\n' }] },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'call-1', name: 'run_shell_command', input: {} }],
    },
  }),
  ...turnNormalizer.normalize({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Serwer działa ✅' },
    },
  }),
  ...turnNormalizer.normalize({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Serwer działa ✅' }] },
  }),
];
const rendered = { _sdkAssistantAcc: '' };
let visible = '';
for (const event of phpEvents) {
  if (event.type === 'tool_call') {
    delete rendered._sdkAssistantAcc;
    continue;
  }
  const delta = takeStreamDelta(rendered, '_sdkAssistantAcc', readAssistantText(event));
  visible += delta;
}
assert.equal(visible, 'PHP 8.2 jest dostępny.\n\nSerwer działa ✅');

const thinkingEvents = createQwenEventNormalizer().normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: { type: 'thinking_delta', thinking: 'Checking PHP…' },
  },
});
assert.equal(thinkingEvents[0].type, 'thinking');
assert.equal(thinkingEvents[0].text, 'Checking PHP…');

console.log('qwen-event-normalizer.test.js OK');
