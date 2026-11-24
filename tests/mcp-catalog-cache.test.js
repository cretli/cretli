import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS = '8000';

const { createMcpServer, updateMcpServer, refreshMcpServerTools } = await import('../lib/mcp/mcp-service.js');
const { callTool, listTools, resetMcpRuntimeForTests, snapshotPoolEntries, invalidateServerConnections } =
  await import('../lib/mcp/mcp-runtime.js');
const { collectBridgeCatalog } = await import('../lib/mcp/mcp-bridge-catalog.js');
const { loadMcpDocument } = await import('../lib/persist/mcp-persist.js');
const { normalizeMcpServers } = await import('../lib/mcp/mcp-config.js');
const { resetMcpStatusForTests } = await import('../lib/mcp/mcp-status.js');

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-spawn-counter-server.js');
const spawnLog = path.join(ISOLATED_DATA_DIR, 'spawns.log');

after(async () => {
  await resetMcpRuntimeForTests();
  removeIsolatedDataDir();
});

const spawns = () => (fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length : 0);
const ctx = (n) => ({ harness: 'openrouter', sessionId: `sess-${n}`, workspaceFolder: `/tmp/mcp-cache-${n}`, mode: 'agent' });
const current = (id) => normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === id);

async function addServer(name, env = {}) {
  const created = await createMcpServer({
    name,
    enabled: true,
    harnesses: ['openrouter'],
    transport: 'stdio',
    connection: { command: process.execPath, args: [fixture], env: { MCP_SPAWN_LOG: spawnLog, ...env } },
  }, loadMcpDocument().revision);
  return created.server.id;
}

async function reset() {
  await resetMcpRuntimeForTests();
  resetMcpStatusForTests();
  fs.rmSync(spawnLog, { force: true });
}

test('6 bridge sessions listing one server spawn one process', async () => {
  await reset();
  const id = await addServer('Shared');
  const rows = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => (
    collectBridgeCatalog(ctx(n), [current(id)], { listTools: (c) => listTools(c, current(id)) })
  )));
  for (const catalog of rows) assert.ok(catalog.rows[0].tools.some((tool) => tool.name === 'ping_read'));
  // Concurrent cold fetches are deduplicated, later ones come from the shared cache.
  assert.equal(spawns(), 1);
  for (const n of [7, 8]) await listTools(ctx(n), current(id));
  assert.equal(spawns(), 1);
  assert.equal(snapshotPoolEntries().length, 1);
});

test('callTool in another session spawns its own process', async () => {
  await reset();
  const id = await addServer('Call');
  await listTools(ctx(1), current(id));
  await listTools(ctx(2), current(id));
  assert.equal(spawns(), 1);
  const result = await callTool(ctx(2), current(id), 'ping_read', {});
  assert.equal(result.ok, true);
  assert.equal(spawns(), 2);
  assert.equal(snapshotPoolEntries().filter((e) => e.sessionId === 'sess-2').length, 1);
});

test('env/args change invalidates the shared catalog', async () => {
  await reset();
  const id = await addServer('Env');
  await listTools(ctx(1), current(id));
  await listTools(ctx(2), current(id));
  assert.equal(spawns(), 1);
  const doc = loadMcpDocument();
  await updateMcpServer(id, { connection: { command: process.execPath, args: [fixture], env: { MCP_SPAWN_LOG: spawnLog, X: '1' } } }, doc.revision);
  await listTools(ctx(3), current(id));
  assert.equal(spawns(), 2);
  const doc2 = loadMcpDocument();
  await updateMcpServer(id, { connection: { command: process.execPath, args: [fixture, '--x'], env: { MCP_SPAWN_LOG: spawnLog, X: '1' } } }, doc2.revision);
  await listTools(ctx(4), current(id));
  assert.equal(spawns(), 3);
});

test('mcp_refresh and invalidateServerConnections invalidate the cache', async () => {
  await reset();
  const id = await addServer('Refresh');
  await listTools(ctx(1), current(id));
  assert.equal(spawns(), 1);
  await refreshMcpServerTools(ctx(1), id);
  // The refresh itself spawns one diagnostic process and drops the shared catalog.
  assert.equal(spawns(), 2);
  await listTools(ctx(2), current(id));
  assert.equal(spawns(), 3);
  await listTools(ctx(3), current(id));
  assert.equal(spawns(), 3);
  await invalidateServerConnections(id);
  await listTools(ctx(4), current(id));
  assert.equal(spawns(), 4);
});

test('catalog expires after the TTL', async () => {
  await reset();
  const id = await addServer('Ttl');
  process.env.CRETLI_MCP_CATALOG_TTL_MS = '1';
  try {
    await listTools(ctx(1), current(id));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await listTools(ctx(2), current(id));
    assert.equal(spawns(), 2);
  } finally {
    delete process.env.CRETLI_MCP_CATALOG_TTL_MS;
  }
});
