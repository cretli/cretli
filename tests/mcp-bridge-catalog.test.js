import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { collectBridgeCatalog, createBridgeCatalogLoader } from '../lib/mcp/mcp-bridge-catalog.js';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { rememberMcpExecutionContext } from '../lib/mcp/mcp-execution-registry.js';
import { mintMcpIntegrationToken } from '../lib/mcp/mcp-integration-token.js';
import { requireAuth, setPassword } from '../lib/auth.js';
import { disposeAllConnections } from '../lib/mcp/mcp-runtime.js';
import { createMcpHandler } from '../scripts/cretli-mcp.js';

const builtin = { id: 'builtin-cretli', kind: 'builtin-cretli' };
const external = (id) => ({ id, kind: 'external' });
const core = [{ name: 'chrome_tools' }, { name: 'chrome_call' }];

test('an offline integration cannot discard core or healthy integration tools', async () => {
  const catalog = await collectBridgeCatalog({}, [external('offline'), builtin, external('healthy')], {
    listTools: async (_, id) => {
      if (id === 'offline') throw new Error('external connection failed');
      return id === builtin.id ? core : [{ name: 'ping' }];
    },
  });
  assert.deepEqual(catalog.rows.map((row) => row.server.id), [builtin.id, 'healthy']);
  assert.deepEqual(catalog.rows[0].tools, core);
  assert.deepEqual(catalog.failedServerIds, ['offline']);
  assert.equal(catalog.pending, false);
});

test('slow external integrations are concurrent and cannot hold up the first catalog', async () => {
  const started = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const listTools = async (_, id) => {
    started.push(id);
    if (id === builtin.id) return core;
    await blocked;
    return [{ name: id }];
  };
  const result = await collectBridgeCatalog({}, [builtin, external('one'), external('two')], { listTools, budgetMs: 5 });
  assert.deepEqual(started, [builtin.id, 'one', 'two']);
  assert.deepEqual(result.rows.map((row) => row.tools), [core]);
  assert.equal(result.pending, true);
  release();
});

test('a core catalog failure remains an error', async () => {
  await assert.rejects(collectBridgeCatalog({}, [builtin], { listTools: async () => { throw new Error('core failure'); } }), /core failure/);
});

test('late tools cause list_changed and become available without restarting the MCP client', { timeout: 3000 }, async () => {
  let reads = 0;
  let changed;
  const notification = new Promise((resolve) => { changed = resolve; });
  const loader = createBridgeCatalogLoader(async () => ++reads === 1
    ? { tools: core, pending: true }
    : { tools: [...core, { name: 'late_tool' }], pending: false }, changed, { pollMs: 5 });
  try {
    assert.deepEqual(await loader.load(), core);
    await notification;
    assert.equal((await loader.load()).at(-1).name, 'late_tool');
  } finally { loader.dispose(); }
});

test('catalog refresh stops on auth failure and does not notify after disposal', async () => {
  let reads = 0;
  let refreshed;
  const refresh = new Promise((resolve) => { refreshed = resolve; });
  const loader = createBridgeCatalogLoader(async () => {
    reads += 1;
    if (reads > 1) { refreshed(); throw new Error('revoked'); }
    return { tools: core, pending: true };
  }, () => assert.fail('failed refresh cannot change tools'), { pollMs: 5 });
  await loader.load();
  await refresh;
  loader.dispose();
  assert.equal(reads, 2);
});

test('catalog errors use JSON-RPC errors rather than invalid tools/list results', async () => {
  const handler = createMcpHandler({ listBridgeTools: async () => { throw new Error('catalog failed'); } });
  const reply = await handler({ id: 1, method: 'tools/list' });
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /catalog failed/);
  assert.equal(reply.result, undefined);
});

test('real stdio-to-HTTP handshake keeps Chrome tools when an external MCP server fails', { timeout: 10000 }, async () => {
  setPassword('catalog-test-password');
  await createMcpServer({ name: 'Offline', enabled: true, harnesses: ['codex'], transport: 'stdio',
    connection: { command: 'cretli-nonexistent-test-mcp-command' } }, 0);
  const context = { sessionId: 'catalog-test-session', chatId: 'catalog-test-chat', harness: 'codex',
    workspaceFolder: '/tmp/catalog-workspace', mode: 'agent' };
  const snapshot = rememberMcpExecutionContext(context);
  const token = mintMcpIntegrationToken({ ...context, incarnation: snapshot.incarnation });
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerMcpRoutes(app);
  const http = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/cretli-mcp.js', import.meta.url)), '--bridge'],
    env: { ...process.env, CRETLI_URL: `http://127.0.0.1:${http.address().port}`, CRETLI_MCP_TOKEN: token }, stderr: 'pipe' });
  transport.stderr?.resume();
  const client = new Client({ name: 'catalog-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name.endsWith('__chrome_tools')));
    assert.ok(tools.some((tool) => tool.name.endsWith('__chrome_call')));
    assert.ok(tools.some((tool) => tool.name.endsWith('__chat_show')));
  } finally {
    await client.close();
    await disposeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
});
