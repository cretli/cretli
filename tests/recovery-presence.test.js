import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  closeRecoveryStore,
  getRun,
  openRecoveryStore,
  transitionRun,
  writeRunIntent,
} from '../lib/recovery/recovery-store.ts';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.ts';
import { buildRecoveryPresenceMap, scanPresenceRuns } from '../lib/recovery/recovery-presence.ts';
import { resolveRecoveryAgentPresence, summarizeChatRunStates } from '../lib/agent-run-state.js';
import { seedInterruptedRuns } from './helpers/recovery-run-seed.js';
import { makeTempDir } from './helpers/temp-dir.js';

function setupChat() {
  return addChat('sess-recovery-presence', 'Interrupted chat', null, '/tmp/ws', 'model', {
    agentTransport: 'testfake',
  });
}

function seedRun(chatId, store, { to = 'interrupted', reason = 'server_restart' } = {}) {
  const ids = createRecoveryIds();
  writeRunIntent({
    logicalRunId: ids.logicalRunId,
    attemptId: ids.attemptId,
    requestId: ids.requestId,
    family: 'chat',
    owner: 'chat-run-service',
    chatId,
    sessionId: 's',
    harness: 'testfake',
  }, store);
  let run = getRun(ids.logicalRunId, store);
  run = transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'running' }, store).run;
  run = transitionRun({
    logicalRunId: ids.logicalRunId,
    expectedRevision: run.revision,
    to,
    reason,
  }, store).run;
  return { ids, run };
}

test('recovery presence mapping covers the sidebar states', () => {
  assert.deepEqual(resolveRecoveryAgentPresence({ state: 'recovering' }), {
    state: 'busy',
    runId: '',
    delegationId: '',
    delegationStatus: '',
    recoveryStatus: 'resuming',
    attention: false,
    waitingAgentCount: 0,
    inFlightChildCount: 0,
  });
  assert.equal(resolveRecoveryAgentPresence({ state: 'interrupted', reason: 'server_restart' }).recoveryStatus,
    'interrupted_restart');
  assert.equal(resolveRecoveryAgentPresence({ state: 'interrupted', reason: 'process_gone' }).recoveryStatus,
    'interrupted');
  assert.equal(resolveRecoveryAgentPresence({ state: 'unknown' }).recoveryStatus, 'unknown');
  assert.equal(resolveRecoveryAgentPresence({ state: 'waiting' }).state, 'waiting');
  assert.equal(resolveRecoveryAgentPresence({ state: 'completed' }), null);
});

test('a persisted interrupted run reaches the sidebar presence without a live run', () => {
  const chat = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    seedRun(chat.id, store);
    const map = buildRecoveryPresenceMap([chat.id]);
    assert.equal(map[chat.id].state, 'interrupted');

    const states = summarizeChatRunStates([chat.id]);
    assert.equal(states[chat.id].state, 'attention');
    assert.equal(states[chat.id].recoveryStatus, 'interrupted_restart');
    assert.equal(states[chat.id].attention, true);
  } finally {
    closeRecoveryStore(store);
  }
});

test('a newer chat keeps recovery presence when the global state cap is full', () => {
  const target = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    // The store lists runs oldest-first; more than the former 500-row global
    // cap must not hide the target chat behind older interrupted runs.
    seedInterruptedRuns(store, { count: 505, chatId: (index) => `other-${index}` });
    seedRun(target.id, store);

    const map = buildRecoveryPresenceMap([target.id], store);
    assert.equal(map[target.id].state, 'interrupted');
    assert.equal(map[target.id].chatId, target.id);

    const states = summarizeChatRunStates([target.id]);
    assert.equal(states[target.id].recoveryStatus, 'interrupted_restart');
    assert.equal(states[target.id].state, 'attention');
  } finally {
    closeRecoveryStore(store);
  }
});

test('a batch query keeps an older chat when another chat has 500+ newer runs', () => {
  const older = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    seedRun(older.id, store);
    const olderAt = new Date(Date.UTC(2020, 0, 1)).toISOString();
    const busyStart = Date.UTC(2021, 0, 1);
    const olderRow = store.db.prepare('SELECT json FROM recovery_runs WHERE chat_id = ?').get(older.id);
    const olderJson = { ...JSON.parse(olderRow.json), createdAt: olderAt, updatedAt: olderAt };
    store.db
      .prepare('UPDATE recovery_runs SET created_at = ?, updated_at = ?, json = ? WHERE chat_id = ?')
      .run(olderAt, olderAt, JSON.stringify(olderJson), older.id);
    seedInterruptedRuns(store, { count: 505, chatId: () => 'busy-chat', startAt: busyStart });

    // Precondition: A is strictly older than every one of B's 505 rows, so a
    // global DESC/LIMIT 500 query would drop A.
    const bounds = store.db
      .prepare('SELECT COUNT(*) AS n, MIN(updated_at) AS minAt FROM recovery_runs WHERE chat_id = ?')
      .get('busy-chat');
    assert.equal(Number(bounds.n), 505);
    assert.ok(Date.parse(olderAt) < Date.parse(bounds.minAt));
    assert.equal(
      store.db.prepare('SELECT updated_at AS at FROM recovery_runs WHERE chat_id = ?').get(older.id).at,
      olderAt,
    );

    const single = buildRecoveryPresenceMap([older.id], store);
    const batch = buildRecoveryPresenceMap([older.id, 'busy-chat'], store);
    assert.equal(single[older.id].state, 'interrupted');
    assert.equal(batch[older.id]?.chatId, older.id);
    assert.equal(batch['busy-chat'].state, 'interrupted');
  } finally {
    closeRecoveryStore(store);
  }
});

test('recovery stays visible next to another non-idle presence state', () => {
  const chat = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    seedRun(chat.id, store);
    const parent = addChat('sess-recovery-parent', 'Parent', null, '/tmp/ws', 'model', {
      agentTransport: 'testfake',
    });
    createDelegationRecord({
      parentChatId: parent.id,
      childChatId: chat.id,
      executor: { transport: 'testfake', model: 'testfake/test' },
      status: 'completed',
      runId: 'run-done',
    });
    const merged = summarizeChatRunStates([chat.id]);
    assert.equal(merged[chat.id].state, 'attention');
    assert.equal(merged[chat.id].delegationStatus, 'completed');
    assert.equal(merged[chat.id].recoveryStatus, 'interrupted_restart');
  } finally {
    closeRecoveryStore(store);
  }
});

test('recovering and unknown states stay visible on the sidebar', () => {
  const chat = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    const { ids, run } = seedRun(chat.id, store);
    transitionRun({
      logicalRunId: ids.logicalRunId,
      expectedRevision: run.revision,
      expectedState: 'interrupted',
      to: 'recovering',
    }, store);

    let states = summarizeChatRunStates([chat.id]);
    assert.equal(states[chat.id].state, 'busy');
    assert.equal(states[chat.id].recoveryStatus, 'resuming');
  } finally {
    closeRecoveryStore(store);
  }

  const unknownChat = setupChat();
  const unknownStore = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    seedRun(unknownChat.id, unknownStore, { to: 'unknown', reason: 'liveness_unknown' });
    const states = summarizeChatRunStates([unknownChat.id]);
    assert.equal(states[unknownChat.id].state, 'attention');
    assert.equal(states[unknownChat.id].recoveryStatus, 'unknown');
  } finally {
    closeRecoveryStore(unknownStore);
  }
});

test('a missing store yields no recovery presence instead of throwing', () => {
  closeRecoveryStore();
  assert.deepEqual(buildRecoveryPresenceMap(['missing-chat']), {});
});

test('presence scan is cached until the recovery runs change', () => {
  const chat = setupChat();
  const store = openRecoveryStore({ dataDir: makeTempDir('recovery-presence-') });
  try {
    const { ids, run } = seedRun(chat.id, store);
    const first = scanPresenceRuns(store);
    // No write in between: the very same array is served without a rescan.
    assert.equal(scanPresenceRuns(store), first);
    assert.equal(buildRecoveryPresenceMap([chat.id], store)[chat.id].state, 'interrupted');
    transitionRun({ logicalRunId: ids.logicalRunId, expectedRevision: run.revision, to: 'recovering' }, store);
    const second = scanPresenceRuns(store);
    assert.notEqual(second, first);
    assert.equal(buildRecoveryPresenceMap([chat.id], store)[chat.id].state, 'recovering');
  } finally {
    closeRecoveryStore(store);
  }
});
