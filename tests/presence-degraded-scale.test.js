import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import { openDelegationSqlite, upsertDelegationSqlite } from '../lib/persist/delegation-sqlite.js';
import { listDelegationsForChatIds } from '../lib/persist/delegations-persist.js';
import {
  subscribeChatListUpdates,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import {
  getAgentPresenceErrorCount,
  initAgentPresenceBus,
  scheduleAgentPresenceRefresh,
  flushAgentPresenceNow,
  __setPresenceSummarizeForTest,
  __setWatcherPresenceForTest,
  __resetAgentPresenceBusForTest,
} from '../lib/agent-presence-bus.js';
import { __resetAgentPresenceHooksForTest, setChatPresenceActivity } from '../lib/agent-presence-hooks.js';

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    closed: false,
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
    close() { this.closed = true; },
  });
}

function resetBus() {
  __resetAgentPresenceHooksForTest();
  __resetAgentPresenceBusForTest();
  __clearChatListUpdateClientsForTest();
  initAgentPresenceBus();
  __setWatcherPresenceForTest(() => []);
}

// --- 1. Injected failure: socket stays open, client gets `degraded`, one log entry. ---
{
  resetBus();
  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    __setPresenceSummarizeForTest(() => { throw new Error('boom'); });
    const sockets = Array.from({ length: 25 }, () => socket());
    for (const ws of sockets) subscribeChatListUpdates(ws, { kind: 'session' });
    for (const ws of sockets) {
      assert.equal(ws.closed, false, 'socket must stay open');
      assert.equal(ws.messages.length, 1);
      assert.equal(ws.messages[0].type, 'agentPresence');
      assert.equal(ws.messages[0].degraded, true);
      assert.deepEqual(ws.messages[0].states, {});
    }
    // A failing flush also degrades instead of throwing out of the timer.
    scheduleAgentPresenceRefresh();
    flushAgentPresenceNow();
    assert.equal(logged.length, 1, `expected one log entry, got ${logged.length}`);
    assert.ok(getAgentPresenceErrorCount() >= 25, 'errors are counted even when not logged');
    // Recovery: once computation works again the next attach is a normal snapshot.
    __setPresenceSummarizeForTest(() => ({}));
    const healthy = socket();
    subscribeChatListUpdates(healthy, { kind: 'session' });
    assert.equal(healthy.messages[0].degraded, undefined);
  } finally {
    console.error = origError;
    __setPresenceSummarizeForTest(null);
  }
}

// --- 1b. Activity changes invalidate the attach snapshot cache. ---
{
  resetBus();
  const BUSY = { state: 'busy', runId: 'r', delegationId: '', delegationStatus: '', attention: false, waitingAgentCount: 0 };
  __setPresenceSummarizeForTest(() => ({ x: BUSY }));
  const first = socket();
  subscribeChatListUpdates(first, { kind: 'session' });
  setChatPresenceActivity('x', { activityKey: 'tool.read', activityArg: 'f' });
  const second = socket();
  subscribeChatListUpdates(second, { kind: 'session' });
  assert.equal(second.messages[0].states.x.activityKey, 'tool.read', 'attach must not serve a stale cache');
  __setPresenceSummarizeForTest(null);
}

// --- 2. Scale: 50,000 chats, 100,000 delegations in a synthetic store. ---
{
  setDelegationStoreBackend('sqlite');
  const database = openDelegationSqlite();
  const CHATS = 50_000;
  const chatIds = Array.from({ length: CHATS }, (_, i) => `chat-${i}`);
  database.exec('BEGIN');
  for (let i = 0; i < 100_000; i += 1) {
    upsertDelegationSqlite(database, {
      id: `d-${i}`,
      revision: 1,
      status: i % 10 === 0 ? 'running' : 'completed',
      parentChatId: chatIds[i % CHATS],
      controllerChatId: chatIds[i % CHATS],
      childChatId: `child-${i}`,
      workspaceFolder: '/tmp/scale-ws',
      createdAt: new Date(1_700_000_000_000 + i).toISOString(),
    });
  }
  database.exec('COMMIT');

  resetBus();
  const summarize = (ids) => {
    const rows = listDelegationsForChatIds(ids || chatIds);
    const out = {};
    for (const row of rows) {
      if (row.status === 'running') out[row.parentChatId] = { state: 'busy', runId: '', delegationId: row.id };
    }
    return out;
  };
  __setPresenceSummarizeForTest(summarize);
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const origError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  const durations = [];
  try {
    // The first attach parses every delegation row into the process-wide parsed-row cache (the
    // delegation tick fills it at boot), so it is a warm-up and not part of the attach sample.
    summarize();
    for (let i = 0; i < 10; i += 1) {
      const ws = socket();
      const start = performance.now();
      subscribeChatListUpdates(ws, { kind: 'session' });
      durations.push(performance.now() - start);
      assert.equal(ws.messages[0].degraded, undefined, `attach degraded: ${errors.join('|')}`);
      assert.equal(Object.keys(ws.messages[0].states).length, 5_000);
      // Let the loop breathe between attaches, as real traffic would.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    console.error = origError;
    histogram.disable();
  }
  assert.equal(errors.filter((line) => /too many SQL variables/i.test(line)).length, 0);
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)];
  assert.ok(p95 <= 500, `attach p95 ${p95.toFixed(1)}ms > 500ms`);
  const loopP99 = histogram.percentile(99) / 1e6 - 5; // subtract the sampling resolution
  assert.ok(loopP99 <= 25, `event loop p99 ${loopP99.toFixed(1)}ms > 25ms`);
}

// --- 3. Guard: no `IN (?, ?, ...)` list built from an unbounded array in lib/. ---
{
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
  // Each entry is a bounded list; the justification lives in docs/in-clause-audit.md.
  const BOUNDED = new Map([
    ['storage/schema/0004-chat-history-metadata.js', 2],
    ['storage/history-sidecar.js', 1],
    ['storage/chat-history-store.js', 1],
    ['persist/delegation-mailbox-persist.js', 1],
    ['persist/delegation-sqlite.js', 1],
    ['recovery/recovery-store.ts', 1],
  ]);
  const hits = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts|mjs)$/.test(entry.name)) {
        const count = (fs.readFileSync(full, 'utf8').match(/IN \(\$\{[^}]*\.map\(\(\) => '\?'\)/g) || []).length;
        if (count) hits.set(path.relative(root, full), count);
      }
    }
  };
  walk(root);
  for (const [file, count] of hits) {
    assert.equal(BOUNDED.get(file), count, `unaudited unbounded-looking IN (?,...) in lib/${file}; see docs/in-clause-audit.md`);
  }
}

console.log('presence-degraded-scale ok');
