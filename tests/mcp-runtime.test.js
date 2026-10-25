import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { callTool, listTools, testMcpServer, disposeConnection, mcpConnectionKey } from '../lib/mcp/mcp-runtime.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
const created = await createMcpServer({
  name: 'Fixture',
  enabled: true,
  harnesses: ['openrouter'],
  scope: 'all',
  transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);
const server = normalizeMcpServers(loadMcpDocument().servers)[0];
const context = {
  harness: 'openrouter',
  workspaceFolder: '/tmp/mcp-runtime',
  mode: 'agent',
  revision: created.revision,
};

const tested = await testMcpServer(context, server);
assert.equal(tested.ok, true);
assert.ok(tested.tools.some((tool) => tool.name === 'ping_read'));
assert.ok(tested.tools.some((tool) => tool.name === 'write_note'));

const tools = await listTools(context, server);
assert.ok(tools.some((tool) => tool.name === 'ping_read'));

const readResult = await callTool(context, server, 'ping_read', { token: 'abc' });
assert.equal(readResult.ok, true);
assert.match(String(readResult.output), /pong:abc/);

const planWrite = await callTool({ ...context, mode: 'plan' }, server, 'write_note', { text: 'nope' });
assert.equal(planWrite.denied, true);

const planRead = await callTool({ ...context, mode: 'plan' }, server, 'ping_read', { token: 'plan' });
assert.equal(planRead.ok, true);

await disposeConnection(mcpConnectionKey(context, server));
removeIsolatedDataDir();
console.log('mcp-runtime.test.js OK');
