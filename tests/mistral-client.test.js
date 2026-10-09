import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseMistralStreamEvent,
  streamMistralChatCompletion,
  toMistralMessages,
} from '../lib/mistral/mistral-client.js';
import { isMistralSdkAvailable } from '../lib/mistral/mistral-sdk.js';
import { isValidMistralApiKeyFormat } from '../lib/mistral/mistral-api-key.js';
import { parseKnownAgentTransport, usesHarnessWebSocket } from '../lib/agent-transport.js';
import { buildAgentHelloPayload } from '../lib/sdk/sdk-ws-handshake.js';
import { getToolsForMode } from '../lib/agent-harness/tool-definitions.js';

test('mistral is a known transport routed over the harness WebSocket', () => {
  assert.equal(parseKnownAgentTransport('Mistral'), 'mistral');
  assert.equal(usesHarnessWebSocket({ agentTransport: 'mistral' }), true);
  assert.equal(buildAgentHelloPayload({ transport: 'mistral' }).transport, 'mistral');
  assert.ok(getToolsForMode('plan', undefined, 'mistral').length > 0);
});

test('streamMistralChatCompletion normalizes SDK chunks to the shared shape', async () => {
  const seen = [];
  const client = {
    chat: {
      async stream(request) {
        seen.push(request);
        return (async function* events() {
          yield { data: { choices: [{ delta: { content: 'Hi' } }] } };
          yield { data: { choices: [{ delta: { toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: 'a' } } }] }, finishReason: 'tool_calls' }], usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } } };
        }());
      },
    },
  };
  const chunks = [];
  for await (const chunk of streamMistralChatCompletion({
    client,
    model: 'm',
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c0' }] }, { role: 'tool', tool_call_id: 'c0', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
  })) chunks.push(chunk);
  assert.equal(chunks[0].deltaText, 'Hi');
  assert.deepEqual(chunks[1].toolCallDeltas, [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }]);
  assert.equal(chunks[1].finishReason, 'tool_calls');
  assert.equal(chunks[1].usage.total_tokens, 7);
  assert.equal(seen[0].messages[0].toolCalls[0].id, 'c0');
  assert.equal(seen[0].messages[1].toolCallId, 'c0');
});

test('streamMistralChatCompletion yields an error chunk when the SDK throws', async () => {
  const client = { chat: { async stream() { throw Object.assign(new Error('boom'), { statusCode: 401 }); } } };
  const chunks = [];
  for await (const chunk of streamMistralChatCompletion({ client, model: 'm', messages: [] })) chunks.push(chunk);
  assert.deepEqual(chunks[0].error, { message: 'boom', code: '401' });
});

test('helpers behave without the optional SDK', async () => {
  assert.equal(parseMistralStreamEvent(null), null);
  assert.deepEqual(toMistralMessages([{ role: 'user', content: 'x' }]), [{ role: 'user', content: 'x' }]);
  assert.equal(isValidMistralApiKeyFormat('short'), false);
  assert.equal(isValidMistralApiKeyFormat('a'.repeat(32)), true);
  assert.equal(typeof (await isMistralSdkAvailable()), 'boolean');
});

test('parseMistralStreamEvent handles camelCase and snake_case shapes', () => {
  const camel = parseMistralStreamEvent({
    data: { choices: [{ delta: { content: 'a', toolCalls: [{ id: 't', function: { name: 'f', arguments: '{"x":1}' } }] }, finishReason: 'stop' }] },
  });
  assert.equal(camel.deltaText, 'a');
  assert.equal(camel.finishReason, 'stop');
  assert.equal(camel.toolCallDeltas[0].function.arguments, '{"x":1}');
  const snake = parseMistralStreamEvent({
    choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'g', arguments: { y: 2 } } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.equal(snake.toolCallDeltas[0].index, 2);
  assert.equal(snake.toolCallDeltas[0].function.arguments, '{"y":2}');
  assert.equal(snake.finishReason, 'tool_calls');
  assert.equal(snake.usage.total_tokens, 3);
});

test('parseMistralStreamEvent joins content-chunk arrays and handles usage-only events', () => {
  const parts = parseMistralStreamEvent({ choices: [{ delta: { content: [{ type: 'text', text: 'he' }, { type: 'image' }, { text: 'llo' }] } }] });
  assert.equal(parts.deltaText, 'hello');
  assert.equal(parts.toolCallDeltas, undefined);
  assert.deepEqual(parseMistralStreamEvent({ usage: { promptTokens: 5 } }).usage.prompt_tokens, 5);
  assert.equal(parseMistralStreamEvent({ choices: [] }), null);
});

test('tool call without arguments keeps arguments undefined', () => {
  const chunk = parseMistralStreamEvent({ choices: [{ delta: { toolCalls: [{ id: 'z', function: { name: 'n' } }] } }] });
  assert.equal(chunk.toolCallDeltas[0].function.arguments, undefined);
  assert.equal(chunk.toolCallDeltas[0].index, 0);
});

test('streamMistralChatCompletion does not report an error on a caller abort', async () => {
  const controller = new AbortController();
  const client = { chat: { async stream() { controller.abort(); throw new Error('aborted'); } } };
  const chunks = [];
  for await (const chunk of streamMistralChatCompletion({ client, model: 'm', messages: [], signal: controller.signal })) chunks.push(chunk);
  assert.deepEqual(chunks, []);
});

test('streamMistralChatCompletion reports a missing key without an injected client', async () => {
  const prev = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try {
    await assert.rejects(async () => {
      for await (const chunk of streamMistralChatCompletion({ model: 'm', messages: [] })) void chunk;
    }, /Missing Mistral API key|MISTRAL_SDK/);
  } finally {
    if (typeof prev === 'string') process.env.MISTRAL_API_KEY = prev;
  }
});
