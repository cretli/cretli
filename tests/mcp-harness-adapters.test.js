import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { encodeMcpToolName } from '../lib/mcp/mcp-tool-names.js';
import { runOpenRouterAgentLoop } from '../lib/agent-harness/openrouter-agent-loop.js';
import { prepareHarnessMcp, buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { getHarnessMcpAdapter } from '../lib/mcp/adapters/index.js';
import { rememberMcpExecutionContext, resetMcpExecutionRegistryForTests } from '../lib/mcp/mcp-execution-registry.js';
import { writeDeepSeekMcpPatch } from '../lib/mcp/mcp-deepseek-patch.js';
import { resetMcpRuntimeForTests } from '../lib/mcp/mcp-runtime.js';
import fs from 'node:fs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
const created = await createMcpServer({
  name: 'Loop',
  enabled: true,
  harnesses: ['openrouter', 'sdk', 'codex', 'opencode', 'qwen', 'codebuddy', 'deepseek'],
  transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);

const harnesses = ['sdk', 'codex', 'opencode', 'qwen', 'codebuddy', 'deepseek', 'openrouter'];
for (const harness of harnesses) {
  const adapter = getHarnessMcpAdapter(harness);
  assert.ok(adapter, harness);
  const context = buildMcpRuntimeContext({
    chat: { id: `c-${harness}`, cursorSessionId: `s-${harness}`, workspaceFolder: '/tmp/mcp-h', agentTransport: harness },
    room: { sessionKey: `s-${harness}`, chatId: `c-${harness}`, cwd: '/tmp/mcp-h', sdkMode: 'plan' },
    harness,
  });
  rememberMcpExecutionContext(context, { getMode: () => 'plan' });
  const prep = prepareHarnessMcp(context);
  assert.ok(prep.servers.some((server) => server.kind === 'builtin-cretli'), harness);
  if (adapter.callControl === 'bridge') {
    assert.ok(prep.bridge, harness);
    assert.ok(prep.mcpServers.cretli_bridge, harness);
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-or-'));
const mcpContext = {
  harness: 'openrouter',
  sessionId: 'or-1',
  chatId: 'or-chat',
  workspaceFolder: cwd,
  mode: 'agent',
  revision: created.revision,
};
const toolName = encodeMcpToolName(created.server.id, 'ping_read');
let streams = 0;
async function* streamChatCompletion() {
  streams += 1;
  if (streams === 1) {
    yield {
      toolCallDeltas: [{
        index: 0,
        id: 'call-1',
        function: { name: toolName, arguments: '{"token":"loop"}' },
      }],
    };
    yield { finishReason: 'tool_calls' };
    return;
  }
  yield { deltaText: 'pong from agent' };
  yield { finishReason: 'stop' };
}

const events = [];
const result = await runOpenRouterAgentLoop({
  model: 'test',
  cwd,
  mode: 'agent',
  messages: [{ role: 'user', content: 'ping' }],
  extraTools: [],
  mcpContext,
  streamChatCompletion,
  callbacks: {
    onEvent: (event) => events.push(event),
  },
});
assert.equal(result.ok, true);
assert.match(JSON.stringify(result.messages), /pong:loop/);
assert.equal(streams, 2);

mcpContext.mode = 'plan';
streams = 0;
const writeName = encodeMcpToolName(created.server.id, 'write_note');
async function* streamWrite() {
  streams += 1;
  if (streams === 1) {
    yield {
      toolCallDeltas: [{
        index: 0,
        id: 'call-2',
        function: { name: writeName, arguments: '{"text":"nope"}' },
      }],
    };
    yield { finishReason: 'tool_calls' };
    return;
  }
  yield { deltaText: 'blocked' };
  yield { finishReason: 'stop' };
}
const denied = await runOpenRouterAgentLoop({
  model: 'test',
  cwd,
  mode: 'plan',
  messages: [{ role: 'user', content: 'write' }],
  mcpContext,
  streamChatCompletion: streamWrite,
  callbacks: { onEvent: () => {} },
});
assert.equal(denied.ok, true);
assert.match(JSON.stringify(denied.messages), /Plan mode blocked/i);

const patch = writeDeepSeekMcpPatch({
  command: process.execPath,
  args: [fixture],
  env: { CRETLI_MCP_TOKEN: 'test-token' },
});
assert.ok(patch);
assert.match(fs.readFileSync(patch, 'utf8'), /cretli_bridge/);
assert.match(fs.readFileSync(patch, 'utf8'), /dsh-mcp-client/);

resetMcpExecutionRegistryForTests();
await resetMcpRuntimeForTests();
removeIsolatedDataDir();
console.log('mcp-harness-adapters.test.js OK');
