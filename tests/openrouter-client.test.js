import assert from 'node:assert/strict';
import { parseOpenRouterSseDataLine } from '../lib/agent-harness/openrouter-client.js';
import { buildAgentHelloPayload } from '../lib/sdk/sdk-ws-handshake.js';
import { isValidOpenRouterApiKeyFormat } from '../lib/openrouter/openrouter-api-key.js';

assert.equal(parseOpenRouterSseDataLine('data: [DONE]').finishReason, 'stop');

const chunk = parseOpenRouterSseDataLine(
  'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
);
assert.equal(chunk?.deltaText, 'Hi');

const toolChunk = parseOpenRouterSseDataLine(
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}',
);
assert.ok(Array.isArray(toolChunk?.toolCallDeltas));
assert.equal(toolChunk.toolCallDeltas[0].function.name, 'read_file');

const hello = buildAgentHelloPayload({ sessionKey: 'abc', transport: 'openrouter' });
assert.equal(hello.transport, 'openrouter');

assert.equal(isValidOpenRouterApiKeyFormat('sk-or-v1-abc123456789'), true);
assert.equal(isValidOpenRouterApiKeyFormat('sk-zoyvd-test-key-not-openrouter'), false);
assert.equal(isValidOpenRouterApiKeyFormat(''), false);

console.log('openrouter-client.test.js OK');
