import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { callTool, listTools, testMcpServer, disposeConnection, mcpConnectionKey } from '../lib/mcp/mcp-runtime.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers, createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';

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

process.env.CRETLI_TOOL_RESULT_COMPRESSION = '1';
try {
  const repeated = await callTool(context, server, 'ping_read', { token: 'same line\n'.repeat(1500) });
  assert.match(repeated.output, /full tool result: [a-f0-9]{64}/);
  assert.equal(repeated.compression.compressed, true);
  const id = repeated.output.match(/full tool result: ([a-f0-9]{64})/)[1];
  const builtin = createBuiltinCretliServer();
  const listed = await listTools(context, builtin);
  assert.ok(listed.some((tool) => tool.name === 'result_full'));
  let recovered = '';
  for (let offset = 0; offset < repeated.raw.content[0].text.length; offset += 4000) {
    const page = await callTool(context, builtin, 'result_full', { id, offset, length: 4000 });
    assert.equal(page.ok, true);
    assert.equal(page.compression.compressed, false, 'result_full pages are never compressed');
    assert.ok(page.output.startsWith(page.raw.content[0].text));
    recovered += page.raw.content[0].text;
  }
  assert.equal(recovered, repeated.raw.content[0].text);
} finally {
  delete process.env.CRETLI_TOOL_RESULT_COMPRESSION;
}
assert.ok(!(await listTools(context, createBuiltinCretliServer())).some((tool) => tool.name === 'result_full'));
const flagOff = await callTool(context, server, 'ping_read', { token: 'same line\n'.repeat(1500) });
assert.equal(flagOff.compression.compressed, false);
assert.equal(flagOff.output, flagOff.raw.content[0].text);

const planWrite = await callTool({ ...context, mode: 'plan' }, server, 'write_note', { text: 'nope' });
assert.equal(planWrite.denied, true);

const planRead = await callTool({ ...context, mode: 'plan' }, server, 'ping_read', { token: 'plan' });
assert.equal(planRead.ok, true);

await disposeConnection(mcpConnectionKey(context, server));
removeIsolatedDataDir();
console.log('mcp-runtime.test.js OK');
