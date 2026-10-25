import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpServer, disposeMcpContext } from '../lib/mcp/mcp-service.js';
import {
  callTool,
  listTools,
  resetMcpRuntimeForTests,
  snapshotPoolEntries,
} from '../lib/mcp/mcp-runtime.js';
import {
  classifyOwner,
  currentOwnerGeneration,
  registerMcpOwnerSource,
  resetMcpOwnerRegistryForTests,
} from '../lib/mcp/mcp-owner-registry.js';
import { createMcpResourceObserver } from '../lib/self-check/mcp-process-invariants.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'helpers/mcp-fixture-server.js');
process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS = '8000';

const created = await createMcpServer({
  name: 'Owners', enabled: true, harnesses: ['sdk'], transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
}, 0);
const server = normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === created.server.id);
const ctx = (sessionId) => ({ harness: 'sdk', sessionId, workspaceFolder: '/tmp/mcp-owners', mode: 'agent', revision: created.revision });

/** @type {Map<string, object>} */
const rooms = new Map();
registerMcpOwnerSource('sdk', () => rooms.entries());
const teardown = (sessionId) => disposeMcpContext({ sessionId, workspaceFolder: '/tmp/mcp-owners' });

after(async () => {
  resetMcpOwnerRegistryForTests();
  await resetMcpRuntimeForTests();
});

test('pool entries carry age, active-call counter and owner generation', async () => {
  const room = { busy: false };
  rooms.set('s-meta', room);
  await listTools(ctx('s-meta'), server);
  const [entry] = snapshotPoolEntries().filter((e) => e.sessionId === 's-meta');
  assert.ok(entry.createdAt > 0 && entry.lastUsedAt >= entry.createdAt);
  assert.equal(entry.activeCalls, 0);
  assert.equal(entry.ownerGeneration, currentOwnerGeneration('s-meta'));
  assert.equal(classifyOwner(entry), 'live');
  rooms.delete('s-meta');
  assert.equal(classifyOwner(entry), 'ownerless');
  await teardown('s-meta');
  assert.equal(snapshotPoolEntries().filter((e) => e.sessionId === 's-meta').length, 0);
});

test('a harness without a registered source reports unknown, never ownerless', async () => {
  await listTools({ ...ctx('s-unk'), harness: 'openrouter' }, server);
  const [entry] = snapshotPoolEntries().filter((e) => e.sessionId === 's-unk');
  assert.equal(classifyOwner(entry), 'unknown');
  await teardown('s-unk');
});

test('room close during connect cancels the pending connect', async () => {
  rooms.set('s-race', {});
  const racing = listTools(ctx('s-race'), server).then(() => 'connected', () => 'rejected');
  await teardown('s-race');
  rooms.delete('s-race');
  assert.equal(await racing, 'rejected');
  assert.equal(snapshotPoolEntries().filter((e) => e.sessionId === 's-race').length, 0);
});

test('reopening the same sessionId right after close keeps the new generation connection', async () => {
  const oldRoom = {};
  rooms.set('s-reopen', oldRoom);
  await callTool(ctx('s-reopen'), server, 'ping_read', { token: 'x' });
  const oldGeneration = currentOwnerGeneration('s-reopen');
  const closing = teardown('s-reopen');
  rooms.delete('s-reopen');
  const newRoom = {};
  rooms.set('s-reopen', newRoom);
  await closing;
  await callTool(ctx('s-reopen'), server, 'ping_read', { token: 'x' });
  const entries = snapshotPoolEntries().filter((e) => e.sessionId === 's-reopen');
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0].ownerGeneration, oldGeneration);
  assert.equal(classifyOwner(entries[0]), 'live');
  // A stale entry from the old generation reads as ownerless.
  assert.equal(classifyOwner({ ...entries[0], ownerGeneration: oldGeneration }), 'ownerless');
  await teardown('s-reopen');
});

test('observation never closes live, delegation-without-client or unknown-owner connections', async () => {
  rooms.set('s-live', { clients: new Set(), busy: false });
  rooms.set('s-deleg', { clients: new Set(), busy: true, serverHold: true });
  await listTools(ctx('s-live'), server);
  await listTools(ctx('s-deleg'), server);
  await listTools({ ...ctx('s-unk2'), harness: 'openrouter' }, server);
  const before = snapshotPoolEntries().length;
  const observer = createMcpResourceObserver({ measure: () => ({ state: 'ok', children: 3, rssKb: 10, byProgram: {} }) });
  for (let i = 0; i < 8; i += 1) observer.sample();
  assert.equal(snapshotPoolEntries().length, before);
  assert.equal(observer.getReport().pool.unknownOwners, 1);
  for (const s of ['s-live', 's-deleg', 's-unk2']) await teardown(s);
  rooms.clear();
});

test('Cursor SDK room close releases pooled MCP connections on both close paths', () => {
  const src = fs.readFileSync(path.join(here, '../lib/sdk/cursor-agent-sdk-ws.ts'), 'utf8');
  assert.match(src, /function releaseSdkRoomMcp[\s\S]*?disposeMcpContext\(/);
  assert.equal((src.match(/releaseSdkRoomMcp\(sessionKey, /g) || []).length, 2);
});
