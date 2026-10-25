import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import {
  disposeAllConnections,
  listTools,
  sweepIdleConnections,
} from '../lib/mcp/mcp-runtime.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { normalizeMcpServers } from '../lib/mcp/mcp-config.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers/mcp-fixture-server.js');
process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS = '8000';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitDead = async (pid) => {
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};

const created = await createMcpServer({
  name: 'Pool',
  enabled: true,
  harnesses: ['openrouter'],
  transport: 'stdio',
  connection: { command: process.execPath, args: [fixture] },
}, 0);
const server = normalizeMcpServers(loadMcpDocument().servers).find((row) => row.id === created.server.id);
const ctx = (sessionId) => ({
  harness: 'openrouter', sessionId, workspaceFolder: '/tmp/mcp-pool', mode: 'agent', revision: created.revision,
});

// Pooled child PIDs are visible through the fixture's parent-owned processes. `-P` limits the match
// to our own children: parallel test jobs run the same fixture and must not be counted.
const { execFileSync } = await import('node:child_process');
const fixtureProcs = () => execFileSync('pgrep', ['-P', String(process.pid), '-f', fixture], { encoding: 'utf8' })
  .split('\n').map(Number).filter((n) => n > 0 && n !== process.pid);
const pgrepSafe = () => { try { return fixtureProcs(); } catch { return []; } };

await listTools(ctx('s1'), server);
await listTools(ctx('s1'), server);
const pids = pgrepSafe();
assert.equal(pids.length, 1, 'repeated calls reuse one pooled stdio child');

// Idle sweep evicts a stale connection and its child exits.
assert.equal(await sweepIdleConnections(Date.now(), 60_000), 0, 'fresh connection is kept');
assert.equal(await sweepIdleConnections(Date.now() + 120_000, 60_000), 1, 'idle connection evicted');
assert.ok(await waitDead(pids[0]), 'evicted child exited');

// Shutdown closes every pooled connection.
await listTools(ctx('s2'), server);
await listTools(ctx('s3'), server);
const pids2 = pgrepSafe();
assert.equal(pids2.length, 2);
assert.equal(await disposeAllConnections(), 2);
for (const pid of pids2) assert.ok(await waitDead(pid), `child ${pid} closed on shutdown`);

removeIsolatedDataDir();
console.log('mcp-runtime-pool-shutdown: ok');
