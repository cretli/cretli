#!/usr/bin/env node
/**
 * Live Mistral streaming + one tool call. Not part of `npm test`.
 *
 *   MISTRAL_API_KEY=... npm run test:live-mistral
 *
 * Without MISTRAL_API_KEY or @mistralai/mistralai the run is skipped. With
 * CRETLI_LIVE_MISTRAL=1 a skip is a failure.
 */

import { isMistralSdkAvailable } from '../../lib/mistral/mistral-sdk.js';
import { getEffectiveMistralApiKey } from '../../lib/mistral/mistral-api-key.js';
import { streamMistralChatCompletion } from '../../lib/mistral/mistral-client.js';

const requireLive = process.env.CRETLI_LIVE_MISTRAL === '1';
const model = process.env.CRETLI_LIVE_MISTRAL_MODEL || 'mistral-small-latest';

/**
 * @param {string} reason
 */
function skip(reason) {
  console.log(`SKIPPED: Mistral live tool call (${reason})`);
  if (requireLive) {
    console.error('CRETLI_LIVE_MISTRAL=1 requires a live run; skip is not a pass.');
    process.exit(2);
  }
  process.exit(0);
}

if (!getEffectiveMistralApiKey()) skip('MISTRAL_API_KEY not set');
if (!(await isMistralSdkAvailable())) skip('@mistralai/mistralai not installed');

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

/**
 * @param {Array<Record<string, unknown>>} messages
 * @returns {Promise<{ text: string, calls: Record<number, { id?: string, name?: string, args: string }>, finish: string }>}
 */
async function runTurn(messages) {
  let text = '';
  let finish = '';
  const calls = {};
  for await (const chunk of streamMistralChatCompletion({ model, messages, tools, timeoutMs: 60000 })) {
    if (chunk.error) throw new Error(`stream error: ${chunk.error.message}`);
    if (chunk.deltaText) text += chunk.deltaText;
    for (const delta of chunk.toolCallDeltas || []) {
      const entry = calls[delta.index ?? 0] || { args: '' };
      if (delta.id) entry.id = delta.id;
      if (delta.function?.name) entry.name = delta.function.name;
      if (delta.function?.arguments) entry.args += delta.function.arguments;
      calls[delta.index ?? 0] = entry;
    }
    if (chunk.finishReason) finish = chunk.finishReason;
  }
  return { text, calls, finish };
}

const messages = [{ role: 'user', content: 'Call read_file with path "package.json", then summarize it.' }];
const first = await runTurn(messages);
const call = Object.values(first.calls)[0];
if (!call?.name) {
  console.error('FAIL: model did not request a tool call', first);
  process.exit(1);
}
messages.push({
  role: 'assistant',
  content: first.text || null,
  tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' } }],
});
messages.push({ role: 'tool', tool_call_id: call.id, content: '{"name":"demo","version":"1.0.0"}' });
const second = await runTurn(messages);
if (!second.text.trim()) {
  console.error('FAIL: second turn returned no text', second);
  process.exit(1);
}
console.log('mistral live tool call OK:', call.name, '->', second.text.slice(0, 80));
