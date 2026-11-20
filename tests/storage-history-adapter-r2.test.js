/**
 * Stage 2a round 2: fail-closed store/marker selection, owned-lease marker
 * writes, logical append batches with retry tokens, bounded pending-buffer
 * open and the committed-readback contract. Synthetic data in temp dirs only.
 */
import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GENERATION, bootParts, chatIdOf, makeCoordinator, makeRoot, userRec } from './fixtures/storage-history-adapter-harness.js';
import { StorageError } from '../lib/storage/errors.js';
import { createStorageCoordinator } from '../lib/storage/coordinator.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { DEFAULT_STORAGE_DB_FILENAME, openStorageDb } from '../lib/storage/db-lifecycle.js';
import { bindDatasetGeneration, bootstrapHistoryStore, readDatasetBinding } from '../lib/storage/dataset-binding.js';
import {
  HISTORY_BACKEND_MARKER_FILE, HISTORY_CUTOVER_WITNESS_FILE, readHistoryBackendMarker, repairHistoryBackendMarker, selectHistoryBackend,
} from '../lib/persist/chat-history-backend-marker.js';
import { HISTORY_HANDLERS_PATH, openChatHistoryRuntime } from '../lib/persist/chat-history-runtime.js';
import { createHistoryPendingBuffer } from '../lib/persist/history-pending-buffer.js';
import { HISTORY_BATCH_MAX_EVENTS } from '../lib/persist/chat-history-backend-sqlite.js';

/** @type {string} */
let root;
/** @type {Array<{ close: () => Promise<void> }>} */
let opened = [];
beforeEach(() => { root = makeRoot('cretli-history-r2-'); opened = []; });
afterEach(async () => {
  for (const item of opened.reverse()) await item.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const dirs = () => ({ controlDir: path.join(root, 'control'), dbDir: path.join(root, 'db'), pendingDir: path.join(root, 'pending') });
const rt = { restartBackoffMs: { initial: 5, max: 20 } };

/** Offline cutover: bootstrap the store, then select sqlite under a live lease. */
function cutover(generation = GENERATION) {
  const { controlDir, dbDir } = dirs();
  const coordinator = makeCoordinator(controlDir);
  coordinator.acquire();
  bootstrapHistoryStore({ dbDir, datasetGeneration: generation });
  selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'test', datasetGeneration: generation });
  return coordinator;
}

/** @param {ReturnType<typeof makeCoordinator>} coordinator */
async function openRuntime(coordinator) {
  const runtime = await openChatHistoryRuntime({ ...dirs(), coordinator, hostOptions: rt });
  opened.push(runtime);
  return runtime;
}

describe('A: a selected sqlite store is never created or adopted by the runtime', () => {
  it('refuses a missing store directory and file without creating either', async () => {
    const { controlDir, dbDir, pendingDir } = dirs();
    const coordinator = makeCoordinator(controlDir);
    coordinator.acquire();
    selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION });
    await assert.rejects(openChatHistoryRuntime({ controlDir, dbDir, pendingDir, coordinator, hostOptions: rt }), (error) => error.code === 'history_store_missing');
    assert.equal(fs.existsSync(dbDir), false, 'no autocreate of the directory');
    assert.equal(fs.existsSync(pendingDir), false);
    fs.mkdirSync(dbDir);
    await assert.rejects(openChatHistoryRuntime({ controlDir, dbDir, pendingDir, coordinator, hostOptions: rt }), (error) => error.code === 'history_store_missing');
    assert.deepEqual(fs.readdirSync(dbDir), [], 'no empty database was created');
    coordinator.close();
  });

  it('parent repro: ACKed write, owner closed, whole dbDir removed, restart -> refuse instead of an empty READY store', async () => {
    const coordinator = cutover();
    const first = await openRuntime(coordinator);
    const chat = chatIdOf(1);
    assert.equal((await first.adapter.appendChatHistoryEvents(chat, 'c', [{ rec: userRec('acked') }])).ok, true);
    await first.close();
    coordinator.close();
    fs.rmSync(dirs().dbDir, { recursive: true, force: true });
    const next = makeCoordinator(dirs().controlDir);
    next.acquire();
    await assert.rejects(openChatHistoryRuntime({ ...dirs(), coordinator: next, hostOptions: rt }), (error) => error.code === 'history_store_missing');
    assert.equal(fs.existsSync(dirs().dbDir), false);
    next.close();
  });

  it('a removed file is also refused by the worker on a RESTART (create:false at every start)', async () => {
    const dbDir = path.join(root, 'db');
    fs.mkdirSync(dbDir);
    const host = createStorageWorkerHost({ dbDir, handlersPath: HISTORY_HANDLERS_PATH, create: false, restartBackoffMs: { initial: 5, max: 10 }, maxStartAttempts: 1 });
    await assert.rejects(host.start(), (error) => error.code === 'missing');
    await host.close({ timeoutMs: 500 }).catch(() => {});
    assert.deepEqual(fs.readdirSync(dbDir), []);
  });

  it('refuses a store bound to another generation, an unbound store and a freshly created empty store', async () => {
    const { controlDir, dbDir } = dirs();
    const coordinator = makeCoordinator(controlDir);
    coordinator.acquire();
    selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION });
    bootstrapHistoryStore({ dbDir, datasetGeneration: 'some-other-gen' });
    await assert.rejects(openChatHistoryRuntime({ ...dirs(), coordinator, hostOptions: rt }), (error) => error.code === 'history_generation_mismatch');
    fs.rmSync(dbDir, { recursive: true, force: true });
    // Created by a plain openStorageDb: valid schema, empty, never bound.
    fs.mkdirSync(dbDir);
    const handle = openStorageDb({ dir: dbDir, create: true });
    assert.equal(readDatasetBinding(handle.db), null);
    handle.close();
    await assert.rejects(openChatHistoryRuntime({ ...dirs(), coordinator, hostOptions: rt }), (error) => error.code === 'history_store_unbound');
    assert.equal(fs.existsSync(dirs().pendingDir), false, 'nothing was recorded before the binding check');
    coordinator.close();
  });

  it('the binding is immutable, bootstrap is idempotent and a file with foreign data cannot be bound', () => {
    const dbDir = path.join(root, 'db');
    assert.equal(bootstrapHistoryStore({ dbDir, datasetGeneration: GENERATION }).created, true);
    assert.equal(bootstrapHistoryStore({ dbDir, datasetGeneration: GENERATION }).created, false);
    assert.throws(() => bootstrapHistoryStore({ dbDir, datasetGeneration: 'g2' }), (error) => error.details.conflictKind === 'history_generation_mismatch');
    const db = new DatabaseSync(path.join(dbDir, DEFAULT_STORAGE_DB_FILENAME));
    assert.throws(() => db.exec("UPDATE storage_dataset_binding SET dataset_generation = 'x'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM storage_dataset_binding'), /immutable/);
    db.close();
    fs.mkdirSync(path.join(root, 'db2'));
    const other = openStorageDb({ dir: path.join(root, 'db2'), create: true });
    other.db.prepare(`INSERT INTO chat_history_state (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
      VALUES ('c', 'foreign', 'e', 0, 1, 2000, 0, 1)`).run();
    assert.throws(() => bindDatasetGeneration(other.db, GENERATION), (error) => error.details.conflictKind === 'history_generation_mismatch');
    other.close();
  });
});

describe('B: a lost marker after cutover never falls back to legacy', () => {
  it('marker deleted -> refuse with and without store paths; witness-only protection', async () => {
    const coordinator = cutover();
    const runtime = await openRuntime(coordinator);
    await runtime.adapter.appendChatHistoryEvents(chatIdOf(2), '', [{ rec: userRec('acked') }]);
    await runtime.close();
    coordinator.close();
    const { controlDir, dbDir, pendingDir } = dirs();
    fs.rmSync(path.join(controlDir, HISTORY_BACKEND_MARKER_FILE));
    const refused = (error) => error.code === 'history_backend_marker_missing';
    assert.throws(() => readHistoryBackendMarker(controlDir), refused);
    // The caller passes NO store arguments: the witness alone fails closed.
    let legacyCreated = 0;
    await assert.rejects(openChatHistoryRuntime({ controlDir, legacyFactory: () => { legacyCreated += 1; return {}; } }), refused);
    assert.equal(legacyCreated, 0);
    // Witness lost too: the store footprint fails closed when the caller names its directories.
    fs.rmSync(path.join(controlDir, HISTORY_CUTOVER_WITNESS_FILE));
    assert.equal(readHistoryBackendMarker(controlDir).source, 'default', 'no witness and no paths: nothing proves a cutover');
    await assert.rejects(openChatHistoryRuntime({ controlDir, dbDir, legacyFactory: () => ({}) }), refused);
    fs.rmSync(dbDir, { recursive: true, force: true });
    await assert.rejects(openChatHistoryRuntime({ controlDir, pendingDir, legacyFactory: () => ({}) }), refused, 'pending-buffer footprint');
  });

  it('a stale (older) marker is refused and an operator can repair marker and witness divergence', () => {
    const coordinator = cutover();
    const { controlDir } = dirs();
    const file = path.join(controlDir, HISTORY_BACKEND_MARKER_FILE);
    const chosen = fs.readFileSync(file, 'utf8');
    selectHistoryBackend({ controlDir, coordinator, backend: 'rollback-readonly', expectedRevision: 1, confirmRollback: true, exportManifestHash: 'a'.repeat(64), selectedBy: 't', datasetGeneration: GENERATION });
    fs.writeFileSync(file, chosen); // a restore brings back the revision-1 marker
    assert.throws(() => readHistoryBackendMarker(controlDir), (error) => error.code === 'history_backend_marker_missing');
    assert.throws(() => repairHistoryBackendMarker({ controlDir, coordinator, selectedBy: 't' }), (error) => error.code === 'history_backend_transition_refused', 'needs confirmRepair');
    const repaired = repairHistoryBackendMarker({ controlDir, coordinator, selectedBy: 't', confirmRepair: true });
    assert.deepEqual([repaired.backend, repaired.revision, repaired.exportManifestHash], ['rollback-readonly', 2, 'a'.repeat(64)]);
    assert.equal(readHistoryBackendMarker(controlDir).backend, 'rollback-readonly');
    assert.throws(() => repairHistoryBackendMarker({ controlDir, coordinator, selectedBy: 't', confirmRepair: true }), (error) => error.code === 'history_backend_transition_refused');
    coordinator.close();
  });

  it('a crash between witness and marker is detected and repaired, never read as legacy', () => {
    const coordinator = cutover();
    const { controlDir } = dirs();
    const file = path.join(controlDir, HISTORY_BACKEND_MARKER_FILE);
    fs.rmSync(file);
    assert.throws(() => selectHistoryBackend({ controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION }),
      (error) => error.code === 'history_backend_marker_missing', 'a second cutover attempt does not overwrite the witnessed state');
    repairHistoryBackendMarker({ controlDir, coordinator, selectedBy: 't', confirmRepair: true });
    assert.equal(readHistoryBackendMarker(controlDir).backend, 'sqlite');
    coordinator.close();
  });

  it('a fresh installation without any footprint still defaults to legacy', async () => {
    const { controlDir, dbDir, pendingDir } = dirs();
    fs.mkdirSync(dbDir);
    const runtime = await openChatHistoryRuntime({ controlDir, dbDir, pendingDir, legacyFactory: () => ({ backendKind: 'legacy' }) });
    assert.equal(runtime.backendKind, 'legacy');
  });
});

describe('C: the marker is written only by a coordinator with a LIVE lease', () => {
  it('TTL expiry + takeover: the zombie owner cannot change the marker or the witness', () => {
    const controlDir = path.join(root, 'control');
    let clock = 1000;
    const make = (pid) => createStorageCoordinator({ controlDir, autoRenew: false, pid, pidStart: 'test', ttlMs: 1000, now: () => clock, isOwnerAlive: () => true });
    const zombie = make(111);
    zombie.acquire();
    assert.equal(zombie.state, 'owner');
    clock += 5000; // the lease expired and the zombie did not notice
    const successor = make(222);
    successor.acquire();
    assert.equal(zombie.state, 'owner', 'its cached state still says owner');
    assert.throws(() => selectHistoryBackend({ controlDir, coordinator: zombie, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'zombie', datasetGeneration: GENERATION }),
      (error) => error.code === 'history_backend_transition_refused' && error.details.cause === 'fenced');
    assert.equal(fs.existsSync(path.join(controlDir, HISTORY_BACKEND_MARKER_FILE)), false);
    assert.equal(fs.existsSync(path.join(controlDir, HISTORY_CUTOVER_WITNESS_FILE)), false);
    assert.equal(zombie.state, 'fenced');
    const chosen = selectHistoryBackend({ controlDir, coordinator: successor, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 'successor', datasetGeneration: GENERATION });
    assert.equal(chosen.fenceEpoch, successor.epoch);
    successor.close();
  });

  it('an expired but untouched lease is extended inside the critical section, a released one is refused', () => {
    const controlDir = path.join(root, 'control');
    let clock = 1000;
    const owner = createStorageCoordinator({ controlDir, autoRenew: false, pid: 1, pidStart: 'test', ttlMs: 1000, now: () => clock });
    owner.acquire();
    clock += 5000;
    assert.equal(selectHistoryBackend({ controlDir, coordinator: owner, backend: 'sqlite', expectedRevision: 0, confirmCutover: true, selectedBy: 't', datasetGeneration: GENERATION }).revision, 1);
    owner.release();
    assert.throws(() => selectHistoryBackend({ controlDir, coordinator: owner, backend: 'rollback-readonly', expectedRevision: 1, confirmRollback: true, exportManifestHash: 'h', selectedBy: 't', datasetGeneration: GENERATION }),
      (error) => error.code === 'history_backend_transition_refused');
  });
});

/** Records of ~40 KiB: every record becomes its own chunk (command budget 64 KiB). */
const bigRecs = (count, label) => Array.from({ length: count }, (_, index) => ({ rec: userRec(`${label}${index}:${'p'.repeat(40 * 1024)}`) }));
const textsOf = (events) => events.map((event) => event.rec.text.split(':')[0]);

/** A definitive (never committed) store refusal. */
const refusal = (kind, retryable = false) => new StorageError('conflict', 'refused', { retryable, details: { operation: 'history', conflictKind: kind, commitState: 'not_committed' } });

describe('D: logical append batches', () => {
  /** @param {{ failOn: number, error: () => Error, times?: number }} fault */
  const failingChunk = ({ failOn, error, times = Infinity }) => {
    const state = { calls: 0, failed: 0, armed: true };
    const wrap = (store) => ({
      ...store,
      appendEvents: async (args) => {
        state.calls += 1;
        if (state.armed && state.calls >= failOn && state.failed < times) {
          state.failed += 1;
          throw error();
        }
        return store.appendEvents(args);
      },
    });
    return { state, wrap };
  };

  it('parent repro: [valid prefix, record above the 3 MiB large cap] is refused WHOLE before any commit, repeatedly, and the chat stays usable', async () => {
    const parts = await bootParts({ root });
    opened.push(parts);
    const chat = chatIdOf(3);
    const input = [{ rec: userRec('prefix') }, { rec: userRec('x'.repeat(3 * 1024 * 1024 + 1024)) }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', input), (error) => error.code === 'history_record_too_large' && error.details.commitState === 'not_committed');
    }
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 0, 'the prefix was not committed');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal((await parts.adapter.appendChatHistoryEvents(chat, '', [{ rec: userRec('ok') }])).ok, true);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', Array.from({ length: HISTORY_BATCH_MAX_EVENTS + 1 }, () => ({ rec: userRec('n') }))), (error) => error.code === 'history_batch_too_large');
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, 'c'.repeat(5000), [{ rec: userRec('n') }]), (error) => error.details.conflictKind === 'history_invalid_cursor_session');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('transient failure of chunk 2: prefix committed, plan pending, retryToken completes it exactly once', async () => {
    const fault = failingChunk({ failOn: 2, error: () => refusal('busy_for_test', true) });
    const parts = await bootParts({ root, wrapStore: fault.wrap });
    opened.push(parts);
    const chat = chatIdOf(4);
    const input = bigRecs(3, 'm');
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_batch_incomplete');
    assert.equal(error.details.resumable, true);
    assert.equal(error.details.committedChunks, 1);
    assert.equal(error.details.totalChunks, 3);
    assert.equal(error.details.acceptedSeqs.length, 1);
    assert.equal(typeof error.details.retryToken, 'string');
    assert.equal(parts.pendingBuffer.stats().entries, 3, 'the whole plan stays pending until the logical ACK');
    assert.deepEqual(textsOf((await parts.adapter.getChatHistorySince(chat, 0, 10)).events), ['m0']);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', bigRecs(3, 'other'), { retryToken: error.details.retryToken }), (cause) => cause.code === 'history_batch_mismatch');
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: 'hist.batch.nope' }), (cause) => cause.code === 'history_batch_unknown');
    fault.state.armed = false;
    const done = await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken });
    assert.equal(done.ok, true);
    assert.equal(done.replayed, true);
    assert.deepEqual(textsOf((await parts.adapter.getChatHistorySince(chat, 0, 10)).events), ['m0', 'm1', 'm2'], 'each input exactly once, in order');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    await assert.rejects(parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken }), (cause) => cause.code === 'history_batch_unknown', 'a finished token cannot be replayed');
  });

  it('definitive refusal of chunk 2: the committed prefix is reported, the rest is quarantined, nothing is replayed later', async () => {
    const fault = failingChunk({ failOn: 2, error: () => refusal('history_producer_fenced') });
    const parts = await bootParts({ root, wrapStore: fault.wrap });
    opened.push(parts);
    const chat = chatIdOf(5);
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', bigRecs(3, 'd')).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_batch_incomplete');
    assert.equal(error.details.resumable, false);
    assert.equal(error.details.conflictKind, 'history_producer_fenced');
    assert.deepEqual([error.details.committedChunks, error.details.acceptedSeqs.length], [1, 1]);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal(fs.readdirSync(path.join(root, 'pending', 'quarantine')).length, 3);
    fault.state.armed = false;
    const recovery = await parts.backend.recoverPending();
    assert.deepEqual([recovery.replayed, recovery.quarantined.length], [0, 0]);
    assert.deepEqual(textsOf((await parts.adapter.getChatHistorySince(chat, 0, 10)).events), ['d0']);
  });

  it('unreconcilable unknown commit at chunk 2 keeps the plan and a retryToken finishes it once', async () => {
    let calls = 0;
    let unknown = true;
    const wrap = (store) => ({
      ...store,
      appendEvents: async (args) => {
        calls += 1;
        if (unknown && calls === 2) throw new StorageError('unknown_commit', 'lost', { details: { operation: 'history', commitState: 'unknown' } });
        return store.appendEvents(args);
      },
      resolveUnknown: async () => { if (unknown) throw new Error('receipt lookup down'); return { outcome: 'not_committed' }; },
    });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(6);
    const input = bigRecs(2, 'u');
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_commit_unknown');
    assert.equal(error.details.resumable, true);
    assert.equal(parts.pendingBuffer.stats().entries, 2);
    unknown = false;
    assert.equal((await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken })).ok, true);
    assert.deepEqual(textsOf((await parts.adapter.getChatHistorySince(chat, 0, 10)).events), ['u0', 'u1']);
  });

  it('readStored failure AFTER the commit keeps the plan; the retry (or a restart) returns the result without duplicates', async () => {
    let failRead = true;
    const wrap = (store) => ({ ...store, readSeqs: async (args) => { if (failRead) throw new Error('read down'); return store.readSeqs(args); } });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const chat = chatIdOf(7);
    const input = [{ rec: userRec('after commit') }, { rec: userRec('second') }];
    const error = await parts.adapter.appendChatHistoryEvents(chat, '', input).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_committed_readback_failed');
    assert.equal(error.details.commitState, 'committed');
    assert.equal(error.details.acceptedSeqs.length, 2);
    assert.equal(parts.pendingBuffer.stats().entries, 1);
    failRead = false;
    const retried = await parts.adapter.appendChatHistoryEvents(chat, '', input, { retryToken: error.details.retryToken });
    assert.equal(retried.ok, true);
    assert.deepEqual(retried.appended.map((row) => row.rec.text), ['after commit', 'second']);
    assert.equal((await parts.adapter.getChatHistorySince(chat, 0, 10)).events.length, 2, 'exactly once');
    assert.equal(parts.pendingBuffer.stats().entries, 0);
  });

  it('restart in the middle of a batch completes it from the persisted plan, exactly once', async () => {
    const fault = failingChunk({ failOn: 2, error: () => refusal('busy_for_test', true) });
    const first = await bootParts({ root, wrapStore: fault.wrap });
    const chat = chatIdOf(8);
    const error = await first.adapter.appendChatHistoryEvents(chat, '', bigRecs(3, 'r')).then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_batch_incomplete');
    await first.close();
    const second = await bootParts({ root, coordinator: undefined });
    opened.push(second);
    const recovery = await second.backend.recoverPending();
    assert.deepEqual([recovery.replayed, recovery.unresolved.length, recovery.quarantined.length], [3, 0, 0]);
    assert.deepEqual(textsOf((await second.adapter.getChatHistorySince(chat, 0, 10)).events), ['r0', 'r1', 'r2']);
    assert.equal(second.pendingBuffer.stats().entries, 0);
    assert.deepEqual((await second.backend.recoverPending()).replayed, 0, 'idempotent');
  });

  it('a half-recorded plan is quarantined; a suffix WITHOUT committed receipts is quarantined too (never taken for an ACK)', async () => {
    const parts = await bootParts({ root });
    opened.push(parts);
    const base = (index, count, id) => ({
      commandId: `hist.append.${id}-${index}`, producerId: 'server:run:x:attempt:y', operation: 'appendEvents', chatId: chatIdOf(9),
      payload: { datasetGeneration: GENERATION, chatId: chatIdOf(9), chatEpoch: 'ep.x', producerId: 'server:run:x:attempt:y', events: [{ clientSeq: 100 + index, rec: userRec(`h${index}`) }], coalesce: true },
      batch: { id: `hist.batch.${id}`, index, count, digest: 'd' },
    });
    await parts.pendingBuffer.recordMany([base(0, 3, 'prefix'), base(1, 3, 'prefix')]);
    await parts.pendingBuffer.recordMany([base(1, 3, 'suffix'), base(2, 3, 'suffix')]);
    const recovery = await parts.backend.recoverPending();
    assert.deepEqual(recovery.quarantined.map((item) => item.reason), ['batch_incomplete_record', 'batch_incomplete_record', 'batch_suffix_unproven', 'batch_suffix_unproven']);
    assert.equal(parts.pendingBuffer.stats().entries, 0);
    assert.equal((await parts.adapter.getChatHistorySince(chatIdOf(9), 0, 10)).events.length, 0, 'neither shape dispatched anything');
  });

  it('refuses a recorded batch that does not fit the buffer without leaving a partial plan', async () => {
    const tiny = createHistoryPendingBuffer({ dir: path.join(root, 'tiny'), maxEntries: 2 });
    await tiny.open();
    const entry = (n) => ({ commandId: `hist.append.t${n}`, producerId: 'server:p', operation: 'appendEvents', chatId: chatIdOf(1), payload: { events: [] }, batch: { id: 'hist.batch.t', index: n, count: 3, digest: 'd' } });
    await assert.rejects(tiny.recordMany([entry(0), entry(1), entry(2)]), (error) => error.code === 'history_pending_full');
    assert.equal(tiny.stats().entries, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, 'tiny', 'entries')), []);
  });
});

describe('E: bounded, fail-closed pending buffer open', () => {
  const entry = (n) => ({ commandId: `hist.append.cmd-${n}`, producerId: 'server:run:r:attempt:a', operation: 'appendEvents', chatId: chatIdOf(n), payload: { events: [{ clientSeq: n, rec: userRec(`m${n}`) }] } });
  const open = async (options = {}) => {
    const buffer = createHistoryPendingBuffer({ dir: path.join(root, 'pending'), ...options });
    await buffer.open();
    return buffer;
  };

  it('a damaged counter file denies its producer (it is never read as counter 0), across restarts', async () => {
    const first = await open();
    assert.equal(await first.reserveClientSeq('server:p1', 5), 0);
    await first.reserveClientSeq('server:p2', 1);
    const producers = path.join(root, 'pending', 'producers');
    const target = fs.readdirSync(producers).find((name) => JSON.parse(fs.readFileSync(path.join(producers, name), 'utf8')).producerId === 'server:p1');
    fs.writeFileSync(path.join(producers, target), '{"v":1,"producerId":"server:p1","nextClientSe');
    for (let restart = 0; restart < 2; restart += 1) {
      const buffer = await open();
      assert.equal(buffer.stats().deniedProducers, 1);
      await assert.rejects(buffer.reserveClientSeq('server:p1', 1), (error) => error.code === 'history_producer_counter_corrupt');
      assert.ok(await buffer.reserveClientSeq('server:p2', 1) >= 1, 'other producers are unaffected');
    }
  });

  it('a counter file with a wrong name, a hostile value, an oversize body or a symlink is denied, not trusted', async () => {
    const first = await open();
    await first.reserveClientSeq('server:q1', 1);
    const producers = path.join(root, 'pending', 'producers');
    const [good] = fs.readdirSync(producers);
    fs.writeFileSync(path.join(producers, 'ab'.repeat(32) + '.json'), JSON.stringify({ v: 1, producerId: 'server:q1', nextClientSeq: 0 }));
    fs.writeFileSync(path.join(producers, 'cd'.repeat(32) + '.json'), JSON.stringify({ v: 1, producerId: 'server:q9', nextClientSeq: -4 }));
    fs.writeFileSync(path.join(producers, 'ef'.repeat(32) + '.json'), ' '.repeat(5000));
    fs.symlinkSync(path.join(producers, good), path.join(producers, '12'.repeat(32) + '.json'));
    const buffer = await open();
    assert.equal(buffer.stats().deniedProducers, 4);
    assert.equal(buffer.stats().openQuarantined, 4);
    assert.ok(await buffer.reserveClientSeq('server:q1', 1) >= 1, 'the genuine counter keeps its high-water mark');
  });

  it('refuses before reading when entries exceed the count or byte budget, and quarantines symlinks and oversized files unread', async () => {
    const seed = await open();
    for (const n of [1, 2, 3, 4]) await seed.record(entry(n));
    await assert.rejects(open({ maxEntries: 3 }), (error) => error.code === 'history_pending_corrupt');
    await assert.rejects(open({ maxTotalBytes: 400 }), (error) => error.code === 'history_pending_corrupt');
    const entries = path.join(root, 'pending', 'entries');
    fs.writeFileSync(path.join(entries, 'big.json'), 'x'.repeat(600 * 1024));
    const [one] = fs.readdirSync(entries).filter((name) => name !== 'big.json');
    fs.symlinkSync(path.join(entries, one), path.join(entries, 'link.json'));
    fs.rmSync(path.join(entries, one));
    const buffer = await open();
    assert.equal(buffer.stats().entries, 3);
    assert.equal(buffer.stats().openQuarantined, 2);
    for (let n = 0; n < 6000; n += 1) fs.writeFileSync(path.join(entries, `junk-${n}.tmp.x`), '');
    await assert.rejects(open(), (error) => error.code === 'history_pending_corrupt', 'a directory far over budget is refused without reading any file');
  });
});

describe('F: fork read-back never turns a committed copy into a "not committed" error', () => {
  it('copyChatHistoryUntil reads the committed copy under the copy cap, not the small load cap', async () => {
    const parts = await bootParts({ root, loadMaxBytes: 2000 });
    opened.push(parts);
    const source = chatIdOf(10);
    await parts.adapter.appendChatHistoryEvents(source, 's', Array.from({ length: 4 }, (_, i) => ({ rec: userRec(`f${i}:${'z'.repeat(3000)}`, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()) })));
    await assert.rejects(parts.adapter.loadChatHistory(source), (error) => error.code === 'history_load_too_large', 'the plain load keeps its cap');
    const forked = await parts.adapter.copyChatHistoryUntil(source, chatIdOf(11), 's2', '');
    assert.equal(forked.ok, true);
    assert.equal((await parts.adapter.getChatHistorySince(chatIdOf(11), 0, 10)).events.length, 4);
  });

  it('a read-back failure after the commit says COMMITTED and names the target', async () => {
    let failRead = false;
    const wrap = (store) => ({ ...store, readPage: async (args) => { if (failRead) throw new Error('read down'); return store.readPage(args); } });
    const parts = await bootParts({ root, wrapStore: wrap });
    opened.push(parts);
    const source = chatIdOf(12);
    await parts.adapter.appendChatHistoryEvents(source, 's', [{ rec: userRec('one') }]);
    failRead = true;
    const error = await parts.adapter.copyChatHistoryUntil(source, chatIdOf(13), 's2', '').then(() => null, (cause) => cause);
    assert.equal(error.code, 'history_committed_readback_failed');
    assert.deepEqual([error.details.commitState, error.details.targetChatId], ['committed', chatIdOf(13)]);
    failRead = false;
    assert.equal((await parts.adapter.getChatHistorySince(chatIdOf(13), 0, 10)).events.length, 1);
    assert.equal(parts.pendingBuffer.stats().entries, 0, 'the committed copy is not left pending');
  });
});
