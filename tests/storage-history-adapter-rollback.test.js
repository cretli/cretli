import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openImmutableDatabase } from '../lib/storage/history-migration-fs.js';
import {
  GENERATION, bootParts, chatIdOf, makeRoot, userRec,
} from './fixtures/storage-history-adapter-harness.js';
import { SYNTHETIC_IDS, writeHandmadeLegacyDocs } from './fixtures/storage-history-synthetic.js';
import { applyLegacyImport, planLegacyImport } from '../lib/storage/history-import.js';
import { applyRollbackExport, planRollbackExport } from '../lib/storage/history-rollback.js';
import { readLegacyHistoryFile } from '../lib/storage/history-legacy-format.js';
import { classifySidecar, ensureSidecarTables, readChatAsLegacy } from '../lib/storage/history-sidecar.js';
import { createChatHistoryAdapter } from '../lib/persist/chat-history-adapter.js';
import { createRollbackReadOnlyHistoryBackend } from '../lib/persist/chat-history-backend-rollback.js';

const EXTRAS = SYNTHETIC_IDS.extras;
/** @type {string} */
let root;
/** @type {Array<Awaited<ReturnType<typeof bootParts>>>} */
let booted;

beforeEach(() => {
  root = makeRoot('cretli-history-rollback-adapter-');
  booted = [];
});
afterEach(async () => {
  for (const parts of booted) await parts.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Import the hand-made legacy documents into `<root>/db`, as the stage-1 tool would. */
function importedStore() {
  const legacyDir = path.join(root, 'legacy');
  writeHandmadeLegacyDocs(legacyDir);
  const plan = planLegacyImport({ legacyDir, datasetGeneration: GENERATION });
  assert.equal(plan.ok, true);
  const staging = path.join(root, 'staging');
  applyLegacyImport({ legacyDir, stagingOut: staging, datasetGeneration: GENERATION, confirmPlanHash: plan.planHash });
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.copyFileSync(path.join(staging, 'cretli-store.sqlite'), path.join(root, 'db', 'cretli-store.sqlite'));
  return { legacyDir };
}

/** @param {Parameters<typeof bootParts>[0]} [options] */
async function boot(options = {}) {
  const parts = await bootParts({ root, ...options });
  booted.push(parts);
  return parts;
}

/** Stop the adapter so the store file is cleanly closed, as the rollback tool requires. */
async function stop(parts) {
  await parts.close();
  booted.splice(booted.indexOf(parts), 1);
}

/** @param {string} storeDir @param {string} out */
function exportStore(storeDir, out) {
  const plan = planRollbackExport({ storeDir });
  return applyRollbackExport({ storeDir, legacyOut: out, confirmPlanHash: plan.planHash });
}

/** @param {string} exportDir */
function controlOf(exportDir) {
  return JSON.parse(fs.readFileSync(path.join(exportDir, 'rollback-control', 'control.json'), 'utf8'));
}

/** Healthy control state: fence raised, pause marker present. */
const verifiedControl = (exportDir) => ({ readHwm: () => controlOf(exportDir).requiredMinimumFenceEpoch, readRestorePause: () => true });

describe('imported metadata (C-3) through the adapter and the rollback export', () => {
  it('serves imported cursor/extras, keeps them across new writes and exports every new ACK losslessly', async () => {
    importedStore();
    const parts = await boot();
    const read = await parts.adapter.getChatHistorySince(EXTRAS, 0, 10);
    assert.equal(read.cursorSessionId, 'session-extras');
    assert.deepEqual(read.events.map((event) => event.seq), [3, 4, 9]);
    assert.equal(read.headSeq, 12);
    assert.equal(read.events[0].rec.clientSeq, 5, 'an imported client record keeps its original clientSeq');
    const written = await parts.adapter.appendChatHistoryEvents(EXTRAS, 'session-new', [{ rec: userRec('after cutover') }]);
    assert.equal(written.appended[0].seq, 13, 'sequence continues from the imported headSeq');
    const pin = (await parts.adapter.getChatHistorySince(EXTRAS, 0, 1)).identity;
    const queued = await parts.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('from a browser queue'), clientSeq: 4 }], { queueProducerId: 'queue-device-1', datasetGeneration: pin.datasetGeneration, chatEpoch: pin.chatEpoch });
    await stop(parts);

    const out = path.join(root, 'rollback');
    const exported = exportStore(path.join(root, 'db'), out);
    const doc = JSON.parse(fs.readFileSync(path.join(out, 'legacy-chat-history', `${EXTRAS}.json`), 'utf8'));
    assert.equal(doc.cursorSessionId, 'session-new');
    assert.deepEqual(doc.futureDocField, { keep: 'me' }, 'unknown document keys survive new writes');
    assert.equal(doc.schemaNote, 'unknown-top-level');
    assert.equal(doc.events[0].origin, 'legacy-tool', 'unknown event keys survive');
    assert.equal(doc.events[0].weight, 0.5);
    assert.deepEqual(doc.events.map((event) => event.seq), [3, 4, 9, 13, 14]);
    assert.equal(doc.headSeq, 14);
    assert.equal(doc.events[3].rec.text, 'after cutover');
    assert.equal('clientSeq' in doc.events[3].rec, false, 'server rows never carry the store-added clientSeq in a legacy file');
    assert.notEqual(doc.updatedAt, '2026-10-02T11:22:33.444Z', 'a written chat no longer reports the original updatedAt');
    assert.equal(Number.isNaN(Date.parse(doc.updatedAt)), false);
    const untouched = JSON.parse(fs.readFileSync(path.join(out, 'legacy-chat-history', 'bbbbbbbb-0000-4000-8000-000000000001.json'), 'utf8'));
    assert.equal(untouched.updatedAt, '2026-10-03T01:00:00.000Z', 'an untouched chat keeps its original updatedAt string');
    assert.equal(exported.manifest.summary.chatsModifiedSinceImport, 1);

    // The exported ledger answers for the acknowledged commands.
    const controlState = verifiedControl(out);
    const backend = createRollbackReadOnlyHistoryBackend({ exportDir: out, storeDir: path.join(root, 'db'), controlState });
    const adapter = createChatHistoryAdapter({ backend, kind: 'rollback-readonly' });
    const reread = await adapter.getChatHistorySince(EXTRAS, 0, 10);
    assert.deepEqual(reread.events.map((event) => event.seq), [3, 4, 9, 13, 14]);
    assert.equal(reread.cursorSessionId, 'session-new');
    assert.equal((await adapter.getChatHistoryEvent(EXTRAS, 13)).event.rec.text, 'after cutover');
    assert.equal((await adapter.loadChatHistory(EXTRAS)).headSeq, 14);
    assert.equal(Object.hasOwn(await adapter.listChatHistoryHeadSeqs(), EXTRAS), true);

    const receipt = written.receipts[0];
    assert.deepEqual(await adapter.lookupReceipt({ datasetGeneration: GENERATION, commandId: receipt.commandId }), { outcome: 'committed', ack: true, result: (await adapter.lookupReceipt({ datasetGeneration: GENERATION, commandId: receipt.commandId })).result });
    assert.equal((await adapter.lookupReceipt({ datasetGeneration: GENERATION, commandId: 'hist.append.unknown' })).outcome, 'not_found');
    const stale = await adapter.lookupReceipt({ datasetGeneration: 'gen-old-1', commandId: receipt.commandId });
    assert.deepEqual(stale, { outcome: 'stale_generation', ack: false }, 'a receipt of another generation never acknowledges a command');
    assert.equal((await adapter.lookupReceipt({ datasetGeneration: GENERATION, commandId: receipt.commandId, requestDigest: 'f'.repeat(64) })).ack, false);
    const input = await adapter.lookupInput({ datasetGeneration: GENERATION, chatId: EXTRAS, producerId: 'queue-device-1', clientSeq: 4 });
    assert.equal(input.found, true);
    assert.equal(input.seq, queued.appended[0].seq);
    assert.equal((await adapter.lookupInput({ datasetGeneration: GENERATION, chatId: EXTRAS, producerId: 'queue-device-1', clientSeq: 5 })).found, false);
    const diagnosis = adapter.diagnose();
    assert.equal(diagnosis.writable, false);
    assert.equal(diagnosis.plainLegacyBinaryCompatible, false);
    assert.equal(diagnosis.checks.every((check) => check.ok), true);
  });

  it('denies EVERY write in rollback read-only mode and does not touch the export or the store', async () => {
    importedStore();
    const parts = await boot();
    await parts.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('acked') }]);
    await stop(parts);
    const out = path.join(root, 'rollback');
    exportStore(path.join(root, 'db'), out);
    const before = fs.readFileSync(path.join(out, 'legacy-chat-history', `${EXTRAS}.json`), 'utf8');
    const adapter = createChatHistoryAdapter({
      backend: createRollbackReadOnlyHistoryBackend({ exportDir: out, storeDir: path.join(root, 'db'), controlState: verifiedControl(out) }), kind: 'rollback-readonly',
    });
    const refused = (promise) => assert.rejects(promise, (error) => error.code === 'history_rollback_read_only');
    await refused(adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('new write') }]));
    await refused(adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('queue write'), clientSeq: 1 }], { queueProducerId: 'queue-x' }));
    await refused(adapter.appendChatNotice(EXTRAS, 'notice'));
    await refused(adapter.copyChatHistory(EXTRAS, chatIdOf(90), 's'));
    await refused(adapter.copyChatHistoryUntil(EXTRAS, chatIdOf(91), 's', '2026-10-02T00:00:00.000Z'));
    await refused(adapter.deleteChatHistory(EXTRAS));
    assert.equal(fs.readFileSync(path.join(out, 'legacy-chat-history', `${EXTRAS}.json`), 'utf8'), before);
    assert.equal((await adapter.getChatHistorySince(EXTRAS, 0, 10)).events.length, 4, 'reads still work after the refusals');
  });

  it('refuses to serve until fencing and the pause marker are confirmed (diagnosis is explicit)', async () => {
    importedStore();
    const parts = await boot();
    await parts.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('acked') }]);
    await stop(parts);
    const out = path.join(root, 'rollback');
    exportStore(path.join(root, 'db'), out);
    const required = controlOf(out).requiredMinimumFenceEpoch;
    const attempt = (controlState, extra = {}) => () => createRollbackReadOnlyHistoryBackend({ exportDir: out, storeDir: path.join(root, 'db'), controlState, ...extra });
    assert.throws(attempt({ readHwm: () => required - 1, readRestorePause: () => true }), (error) => error.code === 'history_rollback_not_verified' && /fence_raised/.test(error.details.failed));
    assert.throws(attempt({ readHwm: () => required, readRestorePause: () => false }), (error) => error.code === 'history_rollback_not_verified' && /restore_pause_marker/.test(error.details.failed));
    assert.throws(attempt(undefined), (error) => error.code === 'history_rollback_not_verified');
    assert.throws(attempt(verifiedControl(out), { expectedManifestHash: 'e'.repeat(64) }), (error) => /manifest_matches_marker/.test(error.details.failed));
    const diagnostic = attempt(undefined, { allowUnverifiedControl: true })();
    assert.equal(diagnostic.diagnose().checks.some((check) => !check.ok), true, 'the diagnostic mode still reports what is missing');
  });

  it('refuses a tampered export (sidecar, chat file) and a store that took writes after the export', async () => {
    importedStore();
    const parts = await boot();
    await parts.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('acked') }]);
    await stop(parts);
    const storeDir = path.join(root, 'db');
    const out = path.join(root, 'rollback');
    exportStore(storeDir, out);
    const open = () => createRollbackReadOnlyHistoryBackend({ exportDir: out, storeDir, controlState: verifiedControl(out) });
    assert.doesNotThrow(open);
    for (const name of ['receipts.jsonl', 'dedupe.jsonl', 'producers.jsonl']) {
      const file = path.join(out, 'rollback-control', name);
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, ' ');
      assert.throws(open, (error) => error.code === 'history_rollback_not_verified', `tampered ${name}`);
      fs.writeFileSync(file, original);
    }
    const chatFile = path.join(out, 'legacy-chat-history', `${EXTRAS}.json`);
    const originalChat = fs.readFileSync(chatFile);
    fs.writeFileSync(chatFile, originalChat.toString().replace('after', 'AFTER').replace('acked', 'ACKED'));
    assert.throws(open, (error) => error.code === 'history_rollback_not_verified');
    fs.writeFileSync(chatFile, originalChat);
    assert.doesNotThrow(open);
    // A new-version writer that kept running after the export: its ACK is not in the export, so serving it is refused.
    const writer = await boot();
    await writer.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('acked after the export') }]);
    await stop(writer);
    assert.throws(open, (error) => error.code === 'history_rollback_not_verified');
  });
});

describe('metadata after a store-level reset is not re-attached', () => {
  it('drops event extras on reset, keeps document extras and never recreates metadata for new events', async () => {
    importedStore();
    const parts = await boot();
    const state = await parts.store.readRevision({ datasetGeneration: GENERATION, chatId: EXTRAS, chatEpoch: 'x', anyEpoch: true });
    await parts.store.reset({ datasetGeneration: GENERATION, chatId: EXTRAS, chatEpoch: state.chatEpoch, commandId: 'reset-extras', newChatEpoch: 'epoch-after-reset' });
    await parts.adapter.appendChatHistoryEvents(EXTRAS, '', [{ rec: userRec('first after reset') }], { producerId: 'server:run:post-reset:attempt:1' });
    await stop(parts);
    const db = openImmutableDatabase(path.join(root, 'db', 'cretli-store.sqlite'));
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM chat_history_event_extra WHERE chat_id = ?').get(EXTRAS).n), 0);
    const meta = db.prepare('SELECT * FROM chat_history_meta WHERE chat_id = ?').get(EXTRAS);
    assert.equal(meta.updated_at_raw, null);
    assert.equal(JSON.parse(meta.doc_extra_json).schemaNote, 'unknown-top-level');
    const read = readChatAsLegacy(db, EXTRAS);
    assert.equal(read.unchangedSinceImport, false);
    assert.deepEqual(read.doc.events.map((event) => event.extra), [null]);
    db.close();
  });

  it('a fork never inherits imported document or event extras; a delete removes them', async () => {
    importedStore();
    const parts = await boot();
    await parts.adapter.copyChatHistory(EXTRAS, chatIdOf(80), 'fork-cursor');
    await parts.adapter.deleteChatHistory(EXTRAS);
    await stop(parts);
    const db = openImmutableDatabase(path.join(root, 'db', 'cretli-store.sqlite'));
    const fork = readChatAsLegacy(db, chatIdOf(80));
    assert.deepEqual(fork.doc.docExtra, {});
    assert.equal(fork.doc.events.every((event) => event.extra === null), true);
    assert.equal(fork.doc.cursorSessionId, 'fork-cursor');
    assert.equal(readChatAsLegacy(db, EXTRAS), null, 'a tombstoned chat exports as nothing');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM chat_history_event_extra WHERE chat_id = ?').get(EXTRAS).n), 0);
    db.close();
    const out = path.join(root, 'rollback');
    exportStore(path.join(root, 'db'), out);
    assert.equal(fs.existsSync(path.join(out, 'legacy-chat-history', `${EXTRAS}.json`)), false);
    assert.equal(readLegacyHistoryFile(path.join(out, 'legacy-chat-history', `${chatIdOf(80)}.json`), { expectedChatId: chatIdOf(80) }).doc.events.length, 3);
  });
});

describe('F6: a partial import sidecar fails closed', () => {
  const TABLES = ['legacy_import_meta', 'legacy_import_chat', 'legacy_import_event_extra'];

  /** @param {string[]} dropped @returns {string} store dir */
  function storeWithDroppedTables(dropped) {
    importedStore();
    const dbPath = path.join(root, 'db', 'cretli-store.sqlite');
    const db = new DatabaseSync(dbPath);
    for (const table of dropped) db.exec(`DROP TABLE ${table}`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    return path.join(root, 'db');
  }

  for (const dropped of [[TABLES[0]], [TABLES[1]], [TABLES[2]], [TABLES[0], TABLES[2]]]) {
    it(`dropping ${dropped.join(' + ')} after the import is a typed refusal, not a chat without metadata`, () => {
      const storeDir = storeWithDroppedTables(dropped);
      const db = new DatabaseSync(path.join(storeDir, 'cretli-store.sqlite'));
      assert.throws(() => classifySidecar(db), (error) => error.code === 'sidecar_partial');
      assert.throws(() => readChatAsLegacy(db, EXTRAS), (error) => error.code === 'sidecar_partial');
      assert.throws(() => ensureSidecarTables(db), (error) => error.code === 'sidecar_partial', 'an existing partial set is never silently completed');
      db.close();
      assert.throws(() => planRollbackExport({ storeDir }), (error) => error.code === 'sidecar_partial');
    });
  }

  it('a store with NO sidecar table (never imported) is valid and exports its native chats', async () => {
    const parts = await boot();
    await parts.adapter.appendChatHistoryEvents(chatIdOf(95), 'native', [{ rec: userRec('native chat') }]);
    await stop(parts);
    const db = openImmutableDatabase(path.join(root, 'db', 'cretli-store.sqlite'));
    assert.equal(classifySidecar(db), 'none');
    const read = readChatAsLegacy(db, chatIdOf(95));
    assert.equal(read.imported, false);
    assert.equal(read.doc.cursorSessionId, 'native');
    db.close();
    const out = path.join(root, 'rollback');
    const exported = exportStore(path.join(root, 'db'), out);
    assert.deepEqual(exported.manifest.chats[0].warnings, ['chat_created_after_import', 'chat_epoch_changed']);
  });
});
