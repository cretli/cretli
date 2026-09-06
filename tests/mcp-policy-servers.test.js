import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { isMcpPlanCallDenied } from '../lib/mcp/mcp-policy.js';
import { prepareHarnessMcp, buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { qwenMcpAdapter } from '../lib/mcp/adapters/qwen-adapter.js';
import { codebuddyMcpAdapter } from '../lib/mcp/adapters/codebuddy-adapter.js';
import { rememberMcpExecutionContext, resetMcpExecutionRegistryForTests } from '../lib/mcp/mcp-execution-registry.js';

assert.equal(qwenMcpAdapter.callControl, 'bridge');
assert.equal(codebuddyMcpAdapter.callControl, 'bridge');

assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'chat_show',
  server: { kind: 'external', toolPolicy: { allowInPlan: [] } },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'chat_show',
  server: { kind: 'builtin-cretli' },
}), false);
assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'ping_read',
  server: { id: 'ext-1', kind: 'external', toolPolicy: { allowInPlan: ['ping_read'] } },
}), false);
assert.equal(isMcpPlanCallDenied({
  mode: 'ask',
  toolName: 'chat_show',
  server: { kind: 'external', toolPolicy: { allowInPlan: [] } },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'ask',
  toolName: 'chat_show',
  server: { kind: 'builtin-cretli' },
}), false);
assert.equal(isMcpPlanCallDenied({
  mode: 'ask',
  toolName: 'chat_delete',
  server: { kind: 'builtin-cretli' },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'agent',
  toolName: 'chat_delete',
  server: { kind: 'builtin-cretli' },
}), false);

const created = await createMcpServer({
  name: 'Docs',
  enabled: true,
  harnesses: ['qwen', 'codebuddy'],
  scope: 'all',
  transport: 'stdio',
  connection: { command: 'node', args: ['-e', 'process.stdin.resume()'] },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);

resetMcpExecutionRegistryForTests();
const context = buildMcpRuntimeContext({
  chat: { id: 'c1', cursorSessionId: 's1', workspaceFolder: '/tmp/qwen', agentTransport: 'qwen' },
  room: { sessionKey: 's1', chatId: 'c1', cwd: '/tmp/qwen', sdkMode: 'plan' },
  harness: 'qwen',
});
rememberMcpExecutionContext(context, { getMode: () => 'plan' });
const prep = prepareHarnessMcp(context);
assert.ok(prep.bridge);
assert.ok(prep.mcpServers.cretli_bridge);
assert.equal(Object.keys(prep.mcpServers).length, 1);
assert.ok(prep.servers.some((server) => server.kind === 'builtin-cretli'));
assert.ok(prep.servers.some((server) => server.id === created.server.id));

resetMcpExecutionRegistryForTests();
removeIsolatedDataDir();
console.log('mcp-policy-servers.test.js OK');
