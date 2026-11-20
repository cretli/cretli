import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createMcpServer, refreshContextMcpTools, refreshMcpServerTools } from '../lib/mcp/mcp-service.js';
import { disposeAllConnections, listTools } from '../lib/mcp/mcp-runtime.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { getMcpToolCatalogByKey } from '../lib/mcp/mcp-status.js';
import { mcpConnectionKey } from '../lib/mcp/mcp-runtime.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';
import { createBridgeCatalogLoader } from '../lib/mcp/mcp-bridge-catalog.js';
import { registerMcpRoutes } from '../lib/routes/mcp-routes.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-mutable-server.js');
const toolsFile = path.join(ISOLATED_DATA_DIR, 'mutable-tools.json');
const v1 = [{ name: 'make_doc', description: 'Make', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }];
const v2 = [{ name: 'make_doc', description: 'Make', inputSchema: { type: 'object', properties: { title: { type: 'string' }, net: { type: 'number' } } } }];
fs.writeFileSync(toolsFile, JSON.stringify(v1));

const created = await createMcpServer({
  name: 'Mutable',
  enabled: true,
  harnesses: ['codex'],
  scope: 'all',
  transport: 'stdio',
  connection: { command: process.execPath, args: [helper], env: { MCP_TOOLS_FILE: toolsFile } },
}, 0);
const serverId = created.server.id;
const rawServer = () => normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === serverId);
const ctx = (sessionId) => ({ harness: 'codex', sessionId, workspaceFolder: '/tmp/mcp-refresh', mode: 'agent' });
const cached = (sessionId) => getMcpToolCatalogByKey(mcpConnectionKey(ctx(sessionId), rawServer())).tools;
const properties = (tools) => Object.keys(tools[0].inputSchema.properties);

after(async () => {
  await disposeAllConnections();
  removeIsolatedDataDir();
});

test('refresh clears the catalog of every session and leaves config, revision and secrets alone', async () => {
  fs.writeFileSync(toolsFile, JSON.stringify(v1));
  await listTools(ctx('s1'), rawServer());
  await listTools(ctx('s2'), rawServer());
  assert.deepEqual(properties(cached('s1')), ['title']);
  fs.writeFileSync(toolsFile, JSON.stringify(v2));
  // Stale until refreshed: this is the reported bug.
  assert.deepEqual(properties(await listTools(ctx('s1'), rawServer())), ['title']);

  const docBefore = fs.readFileSync(path.join(ISOLATED_DATA_DIR, 'mcp.json'), 'utf8');
  const secretsPath = path.join(ISOLATED_DATA_DIR, 'mcp-secrets.json');
  const secretsBefore = fs.existsSync(secretsPath) ? fs.readFileSync(secretsPath, 'utf8') : null;
  const revisionBefore = loadMcpDocument().revision;

  const result = await refreshMcpServerTools(ctx('other'), serverId);
  assert.equal(result.ok, true);
  assert.equal(result.tools, 1);
  assert.equal(result.changed, true);
  assert.equal(cached('s1').length, 0);
  assert.equal(cached('s2').length, 0);

  assert.deepEqual(properties(await listTools(ctx('s1'), rawServer())), ['title', 'net']);
  assert.deepEqual(properties(await listTools(ctx('s2'), rawServer())), ['title', 'net']);

  assert.equal(fs.readFileSync(path.join(ISOLATED_DATA_DIR, 'mcp.json'), 'utf8'), docBefore);
  assert.equal(secretsBefore === null ? false : fs.readFileSync(secretsPath, 'utf8') !== secretsBefore, false);
  assert.equal(loadMcpDocument().revision, revisionBefore);
});

test('changed is false when the server list is the same', async () => {
  await listTools(ctx('s3'), rawServer());
  const result = await refreshMcpServerTools(ctx('x'), serverId);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

test('an unknown server is NOT_FOUND', async () => {
  await assert.rejects(refreshMcpServerTools(ctx('x'), 'missing'), { code: 'NOT_FOUND' });
  await assert.rejects(refreshContextMcpTools(ctx('x'), 'missing'), { code: 'NOT_FOUND' });
});

test('refresh by name or without a reference covers the chat scope', async () => {
  const byName = await refreshContextMcpTools(ctx('x'), 'mutable');
  assert.deepEqual(byName.map((row) => row.serverId), [serverId]);
  const all = await refreshContextMcpTools(ctx('x'));
  assert.deepEqual(all.map((row) => row.serverId), [serverId]);
  // Out of harness scope: the server is not part of this chat.
  assert.deepEqual(await refreshContextMcpTools({ ...ctx('x'), harness: 'opencode' }), []);
});

test('mcp_refresh runs through the builtin client and reports a hint', async () => {
  const context = ctx('builtin');
  const client = createInProcessMcpClient(context);
  const handlers = createCretliMcpToolHandlers(client, { ...context, mode: 'agent' });
  fs.writeFileSync(toolsFile, JSON.stringify(v1));
  await listTools(context, rawServer());
  fs.writeFileSync(toolsFile, JSON.stringify(v2));
  const res = await handlers.mcp_refresh({ server: 'Mutable' });
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.changed, true);
  assert.equal(res.structuredContent.items[0].tools, 1);
  assert.match(res.structuredContent.hint, /list_changed/);
  assert.match(res.content[0].text, /Mutable/);
  const again = await handlers.mcp_refresh({});
  assert.equal(again.structuredContent.changed, false);
  assert.match(again.structuredContent.hint, /No tool list changed/);
  const missing = await handlers.mcp_refresh({ server: 'nope' });
  assert.equal(missing.isError, true);
});

test('mcp_refresh is a mutating tool that Plan mode denies', async () => {
  const handlers = createCretliMcpToolHandlers(createInProcessMcpClient(ctx('plan')), { ...ctx('plan'), mode: 'plan' });
  const res = await handlers.mcp_refresh({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /PLAN_MODE_DENIED|Plan/i);
});

test('REST refresh returns ok, tools and changed; unknown id is 404', async () => {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    fs.writeFileSync(toolsFile, JSON.stringify(v1));
    await refreshMcpServerTools(ctx('x'), serverId);
    fs.writeFileSync(toolsFile, JSON.stringify(v2));
    const res = await fetch(`${base}/api/mcp/servers/${serverId}/refresh`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, tools: 1, changed: true, error: '' });
    const missing = await fetch(`${base}/api/mcp/servers/nope/refresh`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => http.close(resolve));
  }
});

test('bridge loader refresh notifies once when the list changed', async () => {
  let current = { tools: [{ name: 'a' }], pending: false };
  let notified = 0;
  const loader = createBridgeCatalogLoader(async () => current, () => { notified += 1; });
  await loader.load();
  await loader.refresh();
  assert.equal(notified, 0);
  current = { tools: [{ name: 'a' }, { name: 'b' }], pending: false };
  await loader.refresh();
  await loader.refresh();
  assert.equal(notified, 1);
  loader.dispose();
});
