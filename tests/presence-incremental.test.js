import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import { openDelegationSqlite, upsertDelegationSqlite } from '../lib/persist/delegation-sqlite.js';
import { listDelegationsForChatIds } from '../lib/persist/delegations-persist.js';
import { subscribeChatListUpdates, __clearChatListUpdateClientsForTest } from '../lib/chat-list-updates.js';
import {
  PRESENCE_ATTACH_WINDOW,
  initAgentPresenceBus,
  scheduleAgentPresenceRefresh,
  flushAgentPresenceNow,
  __getPresenceIndexForTest,
  __setPresenceSummarizeForTest,
  __setWatcherPresenceForTest,
  __resetAgentPresenceBusForTest,
} from '../lib/agent-presence-bus.js';
import { __resetAgentPresenceHooksForTest, setChatPresenceActivity, clearChatPresenceActivity } from '../lib/agent-presence-hooks.js';

function socket(protocol) {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0, messages, _presenceProtocol: protocol,
    send: (payload) => messages.push(JSON.parse(payload)),
  });
}
function resetBus() {
  __resetAgentPresenceHooksForTest();
  __resetAgentPresenceBusForTest();
  __clearChatListUpdateClientsForTest();
  initAgentPresenceBus();
  __setWatcherPresenceForTest(() => []);
}
const busy = (id) => ({ state: 'busy', runId: '', delegationId: id, delegationStatus: '', attention: false, waitingAgentCount: 0 });

// --- 1. Equivalence: deltas == full recompute on a 500-chat fixture. ---
{
  resetBus();
  const CHATS = 500;
  const truth = new Map();
  const summarize = (ids) => {
    const out = {};
    for (const id of ids || [...truth.keys()]) if (truth.has(id)) out[id] = truth.get(id);
    return out;
  };
  __setPresenceSummarizeForTest(summarize);
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff);
  const first = socket(2);
  subscribeChatListUpdates(first, { kind: 'session' });
  for (let round = 0; round < 40; round += 1) {
    const dirty = new Set();
    for (let k = 0; k < 25; k += 1) {
      const id = `chat-${next() % CHATS}`;
      dirty.add(id);
      if (next() % 3 === 0) truth.delete(id); else truth.set(id, busy(`d${next() % 9}`));
    }
    scheduleAgentPresenceRefresh([...dirty]);
    flushAgentPresenceNow();
    assert.deepEqual(__getPresenceIndexForTest(), summarize(), `round ${round}`);
  }
  // A late v2 attach sees the same set (windowed) and a v1 attach sees all of it.
  const v1 = socket(1);
  subscribeChatListUpdates(v1, { kind: 'session' });
  assert.deepEqual(v1.messages[0].states, summarize());
  assert.equal(v1.messages[0].partial, undefined, 'v1 frame carries no versioned fields');
  assert.equal(v1.messages[0].version, undefined);
}

// --- 2. Protocol: v2 gets a windowed, flagged first packet; v1 gets everything. ---
{
  resetBus();
  const all = {};
  for (let i = 0; i < PRESENCE_ATTACH_WINDOW + 50; i += 1) all[`c${i}`] = busy('d');
  __setPresenceSummarizeForTest(() => all);
  const v2 = socket(2);
  subscribeChatListUpdates(v2, { kind: 'session' });
  const m2 = v2.messages[0];
  assert.equal(m2.version, 2);
  assert.equal(m2.snapshot, true);
  assert.equal(m2.partial, true);
  assert.equal(m2.total, PRESENCE_ATTACH_WINDOW + 50);
  assert.equal(Object.keys(m2.states).length, PRESENCE_ATTACH_WINDOW);
  const v1 = socket(undefined);
  subscribeChatListUpdates(v1, { kind: 'session' });
  assert.equal(Object.keys(v1.messages[0].states).length, PRESENCE_ATTACH_WINDOW + 50);
  assert.equal(v1.messages[0].partial, undefined);
  // Most recently changed chats are in the window.
  scheduleAgentPresenceRefresh(['c0']);
  flushAgentPresenceNow();
  const v2b = socket(2);
  subscribeChatListUpdates(v2b, { kind: 'session' });
  assert.ok(v2b.messages[0].states.c0, 'recently changed chat enters the window');
}

// --- 3. Activity set/cleared on an indexed chat shows up in the next attach (read-time merge). ---
{
  resetBus();
  __setPresenceSummarizeForTest(() => ({ x: busy('d') }));
  subscribeChatListUpdates(socket(2), { kind: 'session' }); // warms the index
  setChatPresenceActivity('x', { activityKey: 'read', activityArg: 'f.js' });
  const withActivity = socket(2);
  subscribeChatListUpdates(withActivity, { kind: 'session' });
  assert.equal(withActivity.messages[0].states.x.activityKey, 'read');
  assert.equal(withActivity.messages[0].states.x.activityArg, 'f.js');
  clearChatPresenceActivity('x');
  const cleared = socket(2);
  subscribeChatListUpdates(cleared, { kind: 'session' });
  assert.equal(cleared.messages[0].states.x.activityKey, undefined, 'cleared activity must not linger in the index');
}

// --- 4. Scale: query counts are identical at 500, 5 000 and 50 000 chats. ---
{
  setDelegationStoreBackend('sqlite');
  const database = openDelegationSqlite();
  const profile = [];
  for (const CHATS of [500, 5_000, 50_000]) {
    const chatIds = Array.from({ length: CHATS }, (_, i) => `n${CHATS}-chat-${i}`);
    database.exec('BEGIN');
    for (let i = 0; i < CHATS * 2; i += 1) {
      upsertDelegationSqlite(database, {
        id: `n${CHATS}-d-${i}`, revision: 1, status: i % 10 === 0 ? 'running' : 'completed',
        parentChatId: chatIds[i % CHATS], controllerChatId: chatIds[i % CHATS], childChatId: `n${CHATS}-child-${i}`,
        workspaceFolder: '/tmp/scale-ws', createdAt: new Date(1_700_000_000_000 + i).toISOString(),
      });
    }
    database.exec('COMMIT');
    resetBus();
    // Counted at the delegation-store query entry point, below the presence bus.
    let summarizeCalls = 0;
    let storeQueries = 0;
    __setPresenceSummarizeForTest((ids) => {
      summarizeCalls += 1;
      storeQueries += 1;
      const out = {};
      for (const row of listDelegationsForChatIds(ids || chatIds)) {
        if (row.status === 'running') out[row.parentChatId] = busy(row.id);
      }
      return out;
    });
    const snap = () => ({ summarizeCalls, storeQueries });
    const delta = (a, b) => `${b.summarizeCalls - a.summarizeCalls}/${b.storeQueries - a.storeQueries}`;
    const t0 = performance.now();
    const a0 = snap();
    const cold = socket(2);
    subscribeChatListUpdates(cold, { kind: 'session' });
    const coldMs = performance.now() - t0;
    const a1 = snap();
    assert.equal(cold.messages[0].partial, CHATS / 10 > PRESENCE_ATTACH_WINDOW);
    assert.ok(Object.keys(cold.messages[0].states).length <= PRESENCE_ATTACH_WINDOW);
    for (let i = 0; i < 20; i += 1) subscribeChatListUpdates(socket(2), { kind: 'session' });
    const a2 = snap();
    scheduleAgentPresenceRefresh([chatIds[0]]);
    flushAgentPresenceNow();
    const a3 = snap();
    profile.push({ chats: CHATS, cold: delta(a0, a1), warm20: delta(a1, a2), flush1: delta(a2, a3), coldMs: +coldMs.toFixed(1) });
  }
  for (const row of profile) {
    assert.equal(row.cold, '1/1', `cold attach queries at ${row.chats}`);
    assert.equal(row.warm20, '0/0', `warm attach queries at ${row.chats}`);
    assert.equal(row.flush1, '1/1', `single-chat flush queries at ${row.chats}`);
  }
  console.log('presence-incremental scale profile', JSON.stringify(profile));
}

console.log('presence-incremental ok');
