import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_CRETILI_SERVER_ID } from '../lib/mcp/mcp-config.js';
import { callContextTool, createMcpServer, disposeMcpContext, listContextTools, resolveContextServers } from '../lib/mcp/mcp-service.js';
import { noteChatRowsForOperatorIndex, resetOperatorRunChatRegistry } from '../lib/operator/operator-run-chat-registry.js';
import { operatorRunChatRow } from './helpers/operator-run-chat-fixture.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
const created = await createMcpServer({
  name: 'Fixture',
  enabled: true,
  harnesses: ['claude', 'sdk'],
  scope: 'all',
  transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);

const context = (chatId) => ({ sessionId: 'op-mcp-session', harness: 'claude', workspaceFolder: '/tmp/operator-mcp', mode: 'agent', chatId, revision: created.revision });

test('an external server is visible to a normal chat and cut off for an operator run (listing and dispatch)', async () => {
  resetOperatorRunChatRegistry();
  noteChatRowsForOperatorIndex(operatorRunChatRow({ id: 'op-mcp' }));
  noteChatRowsForOperatorIndex({ id: 'normal-chat', pickPurpose: '' });
  try {
    const normal = resolveContextServers(context('normal-chat'));
    const external = normal.find((server) => server.id !== BUILTIN_CRETILI_SERVER_ID);
    assert.ok(external, 'precondition: the external server resolves for a normal chat');
    assert.ok((await listContextTools(context('normal-chat'), external.id)).some((tool) => tool.name === 'ping_read'));

    const servers = resolveContextServers(context('op-mcp'));
    assert.deepEqual(servers.map((server) => server.id), [BUILTIN_CRETILI_SERVER_ID]);
    await assert.rejects(() => listContextTools(context('op-mcp'), external.id), /not active/);
    const denied = await callContextTool(context('op-mcp'), external.id, 'ping_read', { token: 'abc' });
    assert.equal(denied.ok, false);
    assert.match(String(denied.error), /not active/);

    // The builtin server stays reachable and lists exactly the operator allowlist.
    const builtinTools = await listContextTools(context('op-mcp'), BUILTIN_CRETILI_SERVER_ID);
    assert.ok(builtinTools.some((tool) => tool.name === 'operator_report'));
    assert.ok(!builtinTools.some((tool) => tool.name === 'todo_update' || tool.name === 'cretli_feedback'));
    const normalBuiltin = await listContextTools(context('normal-chat'), BUILTIN_CRETILI_SERVER_ID);
    assert.ok(!normalBuiltin.some((tool) => tool.name === 'operator_note' || tool.name === 'operator_report'), 'hidden from every other chat');
    const externalClient = await listContextTools({ ...context(''), sessionId: 'external:c1' }, BUILTIN_CRETILI_SERVER_ID);
    assert.ok(!externalClient.some((tool) => tool.name.startsWith('operator_n') || tool.name === 'operator_report'), 'hidden from the external /mcp');
  } finally {
    resetOperatorRunChatRegistry();
    await disposeMcpContext(context('normal-chat'));
  }
});

test.after(() => removeIsolatedDataDir());
