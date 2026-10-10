/**
 * OpenCode managed-bridge re-add must be idempotent: the same semantic bridge
 * config (revision + mode + bridge identity) is not added twice, while a mode
 * or revision change re-adds and records a restart.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { syncOpenCodeManagedMcp } from '../lib/mcp/mcp-opencode-sync.js';
import { rememberMcpExecutionContext, resetMcpExecutionRegistryForTests } from '../lib/mcp/mcp-execution-registry.js';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { getContextRestartSummary, resetContextRestartsForTests } from '../lib/usage/context-restarts.js';

await createMcpServer({
  name: 'ExtIdem',
  enabled: true,
  harnesses: ['opencode'],
  connection: { command: 'node' },
}, 0);

resetMcpExecutionRegistryForTests();
resetContextRestartsForTests();

function mockClient(store, counts) {
  return {
    mcp: {
      async status() {
        return { data: Object.fromEntries([...store.keys()].map((name) => [name, { status: 'connected' }])) };
      },
      async add({ body }) {
        counts.adds += 1;
        store.set(body.name, body.config);
        return { data: { ok: true } };
      },
      async connect() {
        counts.connects += 1;
        return { data: { ok: true } };
      },
      async disconnect({ path }) {
        store.delete(path.name);
        return { data: { ok: true } };
      },
    },
  };
}

const store = new Map();
const counts = { adds: 0, connects: 0 };
const client = mockClient(store, counts);
const context = {
  sessionId: 'opencode-idem',
  chatId: 'chat-idem',
  workspaceFolder: '/tmp/ws',
  harness: 'opencode',
  mode: 'agent',
  revision: 5,
  getMode: () => context.mode,
};
rememberMcpExecutionContext(context, { getMode: () => context.mode });

const first = await syncOpenCodeManagedMcp({ client, workspaceFolder: '/tmp/ws', context });
assert.equal(first.ok, true);
assert.ok(!first.skipped);
assert.equal(counts.adds, 1);
assert.equal(counts.connects, 1);
assert.ok(store.has('cretli_bridge'));
const firstToken = store.get('cretli_bridge').environment.CRETLI_MCP_TOKEN;

// Same semantic config; the minted token rotates but the bridge is identical.
const second = await syncOpenCodeManagedMcp({ client, workspaceFolder: '/tmp/ws', context });
assert.equal(second.ok, true);
assert.equal(second.skipped, true);
assert.equal(counts.adds, 1);
assert.equal(counts.connects, 1);
assert.equal(store.get('cretli_bridge').environment.CRETLI_MCP_TOKEN, firstToken);

// `force` bypasses the guard: watcher orchestrators need a fresh listing mark
// per run even when the semantic bridge config is unchanged.
const forced = await syncOpenCodeManagedMcp({
  client,
  workspaceFolder: '/tmp/ws',
  context,
  force: true,
});
assert.equal(forced.ok, true);
assert.ok(!forced.skipped);
assert.equal(counts.adds, 2);

// A mode switch changes the mode-dependent tool set: re-add + record.
context.mode = 'plan';
const third = await syncOpenCodeManagedMcp({ client, workspaceFolder: '/tmp/ws', context });
assert.equal(third.ok, true);
assert.ok(!third.skipped);
assert.equal(counts.adds, 3);

// A revision bump changes the tool prefix: re-add + record.
context.revision = 6;
const fourth = await syncOpenCodeManagedMcp({ client, workspaceFolder: '/tmp/ws', context });
assert.equal(fourth.ok, true);
assert.ok(!fourth.skipped);
assert.equal(counts.adds, 4);

const summary = getContextRestartSummary();
assert.equal(summary.total, 2);
const chatRow = summary.chats.find((row) => row.chatId === 'chat-idem');
assert.equal(chatRow.byReason.mode_change, 1);
assert.equal(chatRow.byReason.mcp_revision, 1);

// A fresh client always registers; the guard never leaks across processes.
const freshStore = new Map();
const freshCounts = { adds: 0, connects: 0 };
const freshClient = mockClient(freshStore, freshCounts);
const fresh = await syncOpenCodeManagedMcp({ client: freshClient, workspaceFolder: '/tmp/ws', context });
assert.equal(fresh.ok, true);
assert.ok(!fresh.skipped);
assert.equal(freshCounts.adds, 1);

// A failed add is never cached, so the next attempt retries.
const failingCounts = { adds: 0, connects: 0 };
const failing = mockClient(new Map(), failingCounts);
failing.mcp.add = async () => {
  failingCounts.adds += 1;
  return { error: 'connect failed' };
};
const failed = await syncOpenCodeManagedMcp({ client: failing, workspaceFolder: '/tmp/ws', context });
assert.equal(failed.ok, false);
const retried = await syncOpenCodeManagedMcp({ client: failing, workspaceFolder: '/tmp/ws', context });
assert.equal(retried.ok, false);
assert.equal(failingCounts.adds, 2);

resetMcpExecutionRegistryForTests();
resetContextRestartsForTests();
removeIsolatedDataDir();
console.log('mcp-opencode-bridge-idempotency.test.js OK');
