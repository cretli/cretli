import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  hasChatRunAdapter,
  listChatRunAdapterTransports,
} from '../lib/chat-run-service.js';
import { isDelegationModelAvailable } from '../lib/delegation-executor.js';

await import('../lib/sdk/cursor-agent-sdk-ws.js');
await import('../lib/opencode/opencode-agent-ws.js');
await import('../lib/openrouter/openrouter-agent-ws.js');
await import('../lib/codebuddy/codebuddy-agent-ws.js');
await import('../lib/deepseek/deepseek-agent-ws.js');
await import('../lib/qwen/qwen-agent-ws.js');
await import('../lib/codex/codex-agent-ws.js');

const expectedTransports = [
  'sdk',
  'opencode',
  'openrouter',
  'codebuddy',
  'deepseek',
  'qwen',
  'codex',
];
const actualTransports = listChatRunAdapterTransports();
for (const transport of expectedTransports) {
  assert.equal(hasChatRunAdapter(transport), true, `missing adapter ${transport}`);
  assert.equal(actualTransports.includes(transport), true, `missing list entry ${transport}`);
  assert.equal(
    isDelegationModelAvailable({
      transport,
      model: transport === 'sdk' ? 'auto' : `${transport}/test`,
      settings: {},
    }),
    true,
    `model blocked for ${transport}`,
  );
}

assert.equal(
  isDelegationModelAvailable({
    transport: 'codex',
    model: 'codex/test',
    settings: { enabledHarnesses: ['opencode'] },
  }),
  false,
);

console.log('sdk-chat-run-adapter.test.js OK');
