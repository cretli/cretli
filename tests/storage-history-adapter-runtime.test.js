import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GENERATION, chatIdOf, makeCoordinator, makeRoot, userRec } from './fixtures/storage-history-adapter-harness.js';
import { CORE_MIGRATIONS, applyMigrations, readSchemaVersion } from '../lib/storage/migrations.js';
import { ensureSidecarTables } from '../lib/storage/history-sidecar.js';
import { bindDatasetGeneration, bootstrapHistoryStore, readDatasetBinding } from '../lib/storage/dataset-binding.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import {
  HISTORY_BACKEND_MARKER_FILE, assertHistoryBackendSelected, readHistoryBackendMarker, selectHistoryBackend,
} from '../lib/persist/chat-history-backend-marker.js';
import { StorageError } from '../lib/storage/errors.js';
import { openChatHistoryRuntime } from '../lib/persist/chat-history-runtime.js';
import {
  PENDING_CLIENT_SEQ_BLOCK, buildServerProducerId, createHistoryPendingBuffer, isServerProducerId,
} from '../lib/persist/history-pending-buffer.js';

/** @type {string} */
let root;
beforeEach(() => { root = makeRoot('cretli-history-runtime-'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('schema v4 upgrade of an imported v3 store (metadata migration 0004)', () => {
  /** Hand-build the state the stage-1 tool left behind: schema v3 + the three sidecar tables. */
  function importedV3(dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, { migrations: CORE_MIGRATIONS.slice(0, 3) });
    ensureSidecarTables(db);
    const state = db.prepare(`INSERT INTO chat_history_state (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, 2000, 0, ?)`);
    const event = db.prepare(`INSERT INTO chat_history_events (dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, kind, payload_json, created_at, revision)
      VALUES (?, ?, ?, 'legacy-import', 'legacy-import', 0, 'localUser', '{"kind":"localUser","text":"t"}', 0, ?)`);
    const importRow = db.prepare(`INSERT INTO legacy_import_chat (chat_id, source_sha256, source_bytes, cursor_session_id, updated_at_raw, import_state_updated_at,
      import_revision, import_next_seq, import_dataset_generation, import_chat_epoch, doc_extra_json, event_count, head_seq, content_digest)
      VALUES (?, 'sha', 1, ?, ?, 0, 1, 4, ?, 'legacy-import', ?, 1, 3, 'digest')`);
    // untouched since import
    state.run('chat-a', 'g1', 'legacy-import', 1, 4, 1000);
    event.run('g1', 'chat-a', 3, 1);
    importRow.run('chat-a', 'cursor-a', 'RAW-A', 'g1', '{"futureDocField":{"keep":"me"}}');
    db.prepare("INSERT INTO legacy_import_event_extra (chat_id, seq, extra_json) VALUES ('chat-a', 3, '{\"origin\":\"tool\"}')").run();
    // written after the import (revision moved)
    state.run('chat-b', 'g1', 'legacy-import', 2, 5, 2000);
    event.run('g1', 'chat-b', 3, 1);
    importRow.run('chat-b', 'cursor-b', 'RAW-B', 'g1', '{}');
    // native chat created through the A3a store after the import: no sidecar row at all
    state.run('chat-c', 'g1', 'epoch-c', 1, 2, 3000);
    db.prepare("INSERT INTO legacy_import_meta (id, format_version, plan_hash, dataset_generation, chat_epoch, producer_id, created_at) VALUES (1, 2, 'plan', 'g1', 'legacy-import', 'legacy-import', 0)").run();
    return db;
  }

  it('folds the sidecar into the live metadata tables, preserving untouched updatedAt and clearing a modified one', () => {
    const db = importedV3(path.join(root, 'v3.sqlite'));
    assert.equal(readSchemaVersion(db), 3);
    const result = applyMigrations(db);
    assert.deepEqual(result.applied, [4, 5, 6]);
    const meta = Object.fromEntries(db.prepare('SELECT * FROM chat_history_meta').all().map((row) => [row.chat_id, row]));
    assert.equal(meta['chat-a'].cursor_session_id, 'cursor-a');
    assert.equal(meta['chat-a'].updated_at_raw, 'RAW-A', 'an untouched chat keeps the original updatedAt string');
    assert.deepEqual(JSON.parse(meta['chat-a'].doc_extra_json), { futureDocField: { keep: 'me' } });
    assert.equal(meta['chat-b'].cursor_session_id, 'cursor-b');
    assert.equal(meta['chat-b'].updated_at_raw, null, 'a chat written after the import reports a real time');
    assert.equal(meta['chat-c'].cursor_session_id, '');
    assert.equal(meta['chat-c'].doc_extra_json, '{}');
    assert.deepEqual(db.prepare('SELECT chat_id, seq, extra_json FROM chat_history_event_extra').all().map((row) => ({ ...row })), [{ chat_id: 'chat-a', seq: 3, extra_json: '{"origin":"tool"}' }]);
    // The provenance tables are left exactly as they were.
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM legacy_import_chat').get().n), 2);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(readDatasetBinding(db), 'g1', 'the upgrade binds the store to the only generation its data (and import sidecar) proves');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // Idempotent: a second run applies nothing.
    assert.deepEqual(applyMigrations(db).applied, []);
    db.close();
  });

  it('refuses a partial sidecar atomically (schema stays v3, no new table)', () => {
    const db = importedV3(path.join(root, 'partial.sqlite'));
    db.exec('DROP TABLE legacy_import_event_extra');
    assert.throws(() => applyMigrations(db), (error) => error.code === 'corrupt' && error.details.conflictKind === 'history_sidecar_partial');
    assert.equal(readSchemaVersion(db), 3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'chat_history_meta'").get().n, 0);
    db.close();
  });

  it('upgrades a never-imported v3 store by giving every chat default metadata', () => {
    const db = new DatabaseSync(path.join(root, 'plain.sqlite'));
    applyMigrations(db, { migrations: CORE_MIGRATIONS.slice(0, 3) });
    db.prepare(`INSERT INTO chat_history_state (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
      VALUES ('plain', 'g', 'e', 0, 1, 2000, 0, 5)`).run();
    applyMigrations(db);
    assert.deepEqual({ ...db.prepare("SELECT cursor_session_id, updated_at_raw, deleted_at FROM chat_history_meta WHERE chat_id = 'plain'").get() },
      { cursor_session_id: '', updated_at_raw: null, deleted_at: null });
    db.close();
  });
});

describe('backend selection marker', () => {
  const coordinatorIn = () => {
    const coordinator = makeCoordinator(path.join(root, 'control'));
    coordinator.acquire();
    return coordinator;
  };

  it('defaults to legacy, selects only through explicit confirmed transitions and never returns to a writable legacy', () => {
    const controlDir = path.join(root, 'control');
    assert.equal(readHistoryBackendMarker(controlDir).backend, 'legacy');
    assert.equal(assertHistoryBackendSelected(controlDir, 'legacy').source, 'default');
    const coordinator = coordinatorIn();
    const select = (extra) => selectHistoryBackend({ controlDir, coordinator, selectedBy: 'test', datasetGeneration: GENERATION, ...extra });
    assert.throws(() => select({ backend: 'sqlite', expectedRevision: 0 }), (error) => error.code === 'history_backend_transition_refused');
    assert.throws(() => select({ backend: 'sqlite', expectedRevision: 3, confirmCutover: true }), (error) => error.code === 'history_backend_transition_refused', 'stale revision (CAS)');
    assert.throws(() => select({ backend: 'rollback-readonly', expectedRevision: 0, confirmRollback: true, exportManifestHash: 'h' }), (error) => error.code === 'history_backend_transition_refused', 'legacy -> rollback is not a transition');
    const chosen = select({ backend: 'sqlite', expectedRevision: 0, confirmCutover: true });
    assert.deepEqual([chosen.backend, chosen.revision, chosen.previous, chosen.datasetGeneration], ['sqlite', 1, 'legacy', GENERATION]);
    assert.throws(() => assertHistoryBackendSelected(controlDir, 'legacy'), (error) => error.code === 'history_backend_mismatch');
    assert.throws(() => assertHistoryBackendSelected(controlDir, 'sqlite', { datasetGeneration: 'other-gen' }), (error) => error.code === 'history_generation_mismatch');
    assert.throws(() => select({ backend: 'rollback-readonly', expectedRevision: 1 }), (error) => error.code === 'history_backend_transition_refused', 'rollback needs confirmation and an export hash');
    const rolled = select({ backend: 'rollback-readonly', expectedRevision: 1, confirmRollback: true, exportManifestHash: 'a'.repeat(64) });
    assert.equal(rolled.backend, 'rollback-readonly');
    assert.throws(() => select({ backend: 'sqlite', expectedRevision: 2, confirmCutover: true }), (error) => error.code === 'history_backend_transition_refused');
    assert.equal(readHistoryBackendMarker(controlDir).revision, 2);
    coordinator.close();
  });

  it('fails closed on an unreadable or inconsistent marker instead of defaulting to legacy', () => {
    const controlDir = path.join(root, 'control');
    fs.mkdirSync(controlDir, { recursive: true });
    const file = path.join(controlDir, HISTORY_BACKEND_MARKER_FILE);
    for (const text of ['{not json', JSON.stringify({ schema: 'x' }), JSON.stringify({ schema: 'cretli-history-backend-marker-v1', backend: 'sqlite', revision: 1 }), JSON.stringify({ schema: 'cretli-history-backend-marker-v1', backend: 'mongo', revision: 1 })]) {
      fs.writeFileSync(file, text);
      assert.throws(() => readHistoryBackendMarker(controlDir), (error) => error.code === 'history_backend_marker_invalid');
    }
  });

  it('only the live coordinator owner may change it', () => {
    const controlDir = path.join(root, 'control');
    const coordinator = makeCoordinator(controlDir);
    assert.throws(() => selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION }),
      (error) => error.code === 'history_backend_transition_refused');
    assert.equal(fs.existsSync(path.join(controlDir, HISTORY_BACKEND_MARKER_FILE)), false);
  });
});

describe('runtime wiring and exclusivity', () => {
  /** @returns {{ controlDir: string, coordinator: ReturnType<typeof makeCoordinator> }} */
  function selectSqlite() {
    const controlDir = path.join(root, 'control');
    const coordinator = makeCoordinator(controlDir);
    coordinator.acquire();
    bootstrapHistoryStore({ dbDir: path.join(root, 'db'), datasetGeneration: GENERATION });
    selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'test', datasetGeneration: GENERATION });
    return { controlDir, coordinator };
  }

  it('opens the legacy adapter by default without touching SQLite', async () => {
    let created = 0;
    const runtime = await openChatHistoryRuntime({ controlDir: path.join(root, 'control'), legacyFactory: () => { created += 1; return { backendKind: 'legacy' }; } });
    assert.equal(runtime.backendKind, 'legacy');
    assert.equal(created, 1);
    assert.equal(fs.existsSync(path.join(root, 'db')), false);
  });

  it('starts the sqlite backend only when the marker selects it, replays pending work and reports no notification during staging', async () => {
    const { controlDir, coordinator } = selectSqlite();
    const notified = [];
    const runtime = await openChatHistoryRuntime({
      controlDir, coordinator, dbDir: path.join(root, 'db'), pendingDir: path.join(root, 'pending'), hostOptions: { restartBackoffMs: { initial: 5, max: 20 } },
    });
    try {
      assert.equal(runtime.backendKind, 'sqlite');
      assert.deepEqual({ ...runtime.recovery, quarantined: runtime.recovery.quarantined.length }, { replayed: 0, committed: 0, quarantined: 0, unresolved: [] });
      const result = await runtime.adapter.appendChatHistoryEvents(chatIdOf(1), 'cursor', [{ rec: userRec('through the runtime') }]);
      assert.equal(result.ok, true);
      assert.equal(notified.length, 0, 'no notifier is wired unless the caller injects one');
      assert.equal(runtime.adapter.diagnose().datasetGeneration, GENERATION);
    } finally {
      await runtime.close();
      coordinator.close();
    }
  });

  it('never starts sqlite for a legacy marker and refuses a coordinator that is not the live owner', async () => {
    const controlDir = path.join(root, 'control');
    const bystander = makeCoordinator(controlDir);
    const legacy = await openChatHistoryRuntime({ controlDir, coordinator: bystander, dbDir: path.join(root, 'db'), pendingDir: path.join(root, 'pending'), legacyFactory: () => ({ backendKind: 'legacy' }) });
    assert.equal(legacy.backendKind, 'legacy');
    assert.equal(fs.existsSync(path.join(root, 'db')), false, 'a legacy marker never creates or opens the sqlite store');
    const owner = makeCoordinator(path.join(root, 'control3'));
    owner.acquire();
    bootstrapHistoryStore({ dbDir: path.join(root, 'db3'), datasetGeneration: GENERATION });
    selectHistoryBackend({ controlDir: path.join(root, 'control3'), coordinator: owner, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION });
    const idle = makeCoordinator(path.join(root, 'control4'));
    await assert.rejects(openChatHistoryRuntime({ controlDir: path.join(root, 'control3'), coordinator: idle, dbDir: path.join(root, 'db3'), pendingDir: path.join(root, 'pending3') }),
      (error) => error.name === 'StorageError', 'an idle coordinator cannot activate, so there is no adapter');
    assert.equal(fs.existsSync(path.join(root, 'pending3')), false);
    owner.close();
  });

  it('a startup barrier / open failure leaves NO adapter (no READY, no ACK) and writes nothing to the pending buffer', async () => {
    const { controlDir, coordinator } = selectSqlite();
    const dbDir = path.join(root, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, DEFAULT_STORAGE_DB_FILENAME), Buffer.alloc(4096, 7));
    await assert.rejects(openChatHistoryRuntime({
      controlDir, coordinator, dbDir, pendingDir: path.join(root, 'pending'), hostOptions: { restartBackoffMs: { initial: 5, max: 10 }, maxStartAttempts: 1 },
    }), (error) => ['corrupt', 'io', 'unsupported_runtime', 'conflict'].includes(error.code));
    assert.equal(fs.existsSync(path.join(root, 'pending')), false, 'nothing could have been dispatched');
    coordinator.close();
  });
});

describe('F11: unresolved pending recovery fails closed at startup', () => {
  /** Coordinator whose guarded host loses every write with an unknown-commit outcome. */
  const faultyCoordinator = (coordinator) => ({
    ...coordinator,
    guardHost: (host) => {
      const guarded = coordinator.guardHost(host);
      const fail = async () => { throw new StorageError('unknown_commit', 'injected store outage', { details: { commitState: 'unknown' } }); };
      return Object.freeze({ ...guarded, command: fail, commandBatch: fail });
    },
  });
  const open = (controlDir, coordinator) => openChatHistoryRuntime({
    controlDir, coordinator, dbDir: path.join(root, 'db'), pendingDir: path.join(root, 'pending'), hostOptions: { restartBackoffMs: { initial: 5, max: 20 } },
  });

  it('refuses to open (no adapter, no READY/ACK), keeps the pending entry and replays it once the store is healthy', async () => {
    const controlDir = path.join(root, 'control');
    const coordinator = makeCoordinator(controlDir);
    coordinator.acquire();
    bootstrapHistoryStore({ dbDir: path.join(root, 'db'), datasetGeneration: GENERATION });
    selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'test', datasetGeneration: GENERATION });
    const chat = chatIdOf(77);
    // A previous run left an unacknowledged command behind.
    const first = await open(controlDir, faultyCoordinator(coordinator));
    await assert.rejects(first.adapter.appendChatHistoryEvents(chat, 'cursor', [{ rec: userRec('left pending') }]));
    await first.close();
    const pendingFiles = () => fs.readdirSync(path.join(root, 'pending', 'entries')).filter((name) => name.endsWith('.json'));
    assert.equal(pendingFiles().length, 1, 'the failed write stays durable');
    // Restart while the fault persists: recovery cannot resolve it -> typed refusal, nothing served.
    await assert.rejects(open(controlDir, faultyCoordinator(coordinator)), (error) => error.code === 'history_recovery_unresolved' && error.details.unresolved === 1);
    assert.equal(pendingFiles().length, 1, 'unresolved pending is preserved, not acked or quarantined');
    assert.equal(fs.existsSync(path.join(root, 'pending', 'quarantine')) && fs.readdirSync(path.join(root, 'pending', 'quarantine')).length > 0, false);
    // Healthy restart replays the very same command.
    const healthy = await open(controlDir, coordinator);
    try {
      assert.deepEqual([healthy.recovery.replayed, healthy.recovery.unresolved.length], [1, 0]);
      assert.equal(pendingFiles().length, 0);
      const page = await healthy.adapter.getChatHistorySince(chat, 0, 10);
      assert.deepEqual(page.events.map((event) => event.rec.text), ['left pending']);
    } finally {
      await healthy.close();
    }
    coordinator.close();
  });

});

describe('durable pending buffer and producer identity', () => {
  const open = async (options = {}) => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'pending'), ...options });
    await buffer.open();
    return buffer;
  };
  const entry = (n, extra = {}) => ({ commandId: `hist.append.cmd-${n}`, producerId: 'server:run:r:attempt:a', operation: 'appendEvents', chatId: chatIdOf(n), payload: { events: [{ clientSeq: n, rec: userRec(`m${n}`) }], ...extra } });

  it('persists a command before dispatch, lists it in order after a restart and forgets it only on ack', async () => {
    const first = await open();
    await first.record(entry(2));
    await first.record(entry(1));
    const second = await open();
    assert.deepEqual(second.list().map((item) => item.commandId), ['hist.append.cmd-2', 'hist.append.cmd-1'], 'recorded order, not id order');
    assert.equal(await second.ack('hist.append.cmd-2'), true);
    assert.equal(await second.ack('hist.append.cmd-2'), false);
    const third = await open();
    assert.deepEqual(third.list().map((item) => item.commandId), ['hist.append.cmd-1']);
  });

  it('never reuses a clientSeq after a restart, even when the counter file lags behind a recorded entry', async () => {
    const first = await open();
    assert.equal(await first.reserveClientSeq('server:p', 3), 0);
    assert.equal(await first.reserveClientSeq('server:p', 2), 3);
    const second = await open();
    assert.equal(await second.reserveClientSeq('server:p', 1), PENDING_CLIENT_SEQ_BLOCK, 'the rest of the durable block is skipped, never reused');
    await second.record({ ...entry(1), producerId: 'server:q', payload: { events: [{ clientSeq: 5000, rec: userRec('x') }] } });
    const third = await open();
    assert.ok(await third.reserveClientSeq('server:q', 1) > 5000, 'numbers carried by a pending entry are never reissued');
  });

  it('refuses instead of dropping when full or oversized, and quarantines torn or foreign files', async () => {
    const small = await open({ maxEntries: 2, maxEntryBytes: 4096 });
    await small.record(entry(1));
    await small.record(entry(2));
    await assert.rejects(small.record(entry(3)), (error) => error.code === 'history_pending_full');
    await assert.rejects(open({ maxEntries: 9, maxEntryBytes: 200 }).then((b) => b.record(entry(4))), (error) => error.code === 'history_pending_entry_too_large');
    const dir = path.join(root, 'pending', 'entries');
    fs.writeFileSync(path.join(dir, 'abc.json.tmp'), 'torn');
    fs.writeFileSync(path.join(dir, 'foreign.json'), '{"v":1,"nope":true}');
    const reopened = await open({ maxEntries: 2, maxEntryBytes: 4096 });
    assert.equal(reopened.list().length, 2);
    assert.equal(fs.existsSync(path.join(dir, 'abc.json.tmp')), false, 'a torn temp file is not an entry');
    assert.equal(fs.readdirSync(path.join(root, 'pending', 'quarantine')).some((name) => name.startsWith('foreign.json')), true);
  });

  it('moves an unreplayable entry to quarantine instead of deleting it', async () => {
    const buffer = await open();
    await buffer.record(entry(7));
    assert.equal(await buffer.quarantine('hist.append.cmd-7', 'generation_mismatch'), true);
    assert.equal(buffer.list().length, 0);
    const kept = fs.readdirSync(path.join(root, 'pending', 'quarantine'));
    assert.equal(kept.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'pending', 'quarantine', kept[0]), 'utf8')).reason, 'generation_mismatch');
  });

  it('builds valid, stable server producer identities', () => {
    const id = buildServerProducerId({ runId: 'run-1', attemptId: 'attempt-2' });
    assert.equal(id, 'server:run:run-1:attempt:attempt-2');
    assert.equal(isServerProducerId(id), true);
    const hashed = buildServerProducerId({ runId: 'x'.repeat(300), attemptId: 'a b' });
    assert.match(hashed, /^server:h:[0-9a-f]{48}$/);
    assert.equal(hashed, buildServerProducerId({ runId: 'x'.repeat(300), attemptId: 'a b' }));
    assert.equal(isServerProducerId('queue-1'), false);
  });
});
