/**
 * Offline rollback export: SQLite store -> legacy chat-history documents PLUS a
 * control sidecar, preserving every durable write made after the import
 * (stage 1 of the history migration; docs/storage-history-migration.md).
 *
 * What it does and does not promise
 * - The export is built from a cleanly closed store that is only ever read
 *   (an immutable connection; a store with a WAL/journal is refused). The
 *   store file is hashed before and after; any change aborts the export
 *   (`source_changed_during_export`), so a write that happened while exporting
 *   can never be silently left behind.
 * - `legacy-chat-history/<chatId>.json` files are valid legacy documents (they
 *   pass the strict legacy reader) holding every retained event, including all
 *   events appended after the import.
 * - Plain legacy code has NO notion of dataset generation, producer, command
 *   receipt or fencing epoch. The export therefore does not claim that an
 *   unmodified legacy binary is safe to start on it. The `rollback-control/`
 *   sidecar carries the receipts, dedupe ledger, producer table, epochs, per
 *   event identity and the fencing high-water mark; a sidecar-aware legacy
 *   adapter (not written yet) must refuse to write unless the control actions
 *   in `control.json` were performed. `plainLegacyBinaryCompatible` is false.
 * - Nothing here stops a still-running new-version process from writing to the
 *   store. Quiescing and fencing the store is an operator/coordinator action
 *   recorded in `control.json`; the post-export hash check is how this tool
 *   detects that it did not hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STORAGE_DB_FILENAME } from './db-lifecycle.js';
import { CORE_MIGRATIONS } from './migrations.js';
import { STORAGE_APPLICATION_ID } from './schema/0001-core.js';
import {
  DEFAULT_MAX_LEGACY_FILE_BYTES, LEGACY_IMPORT_CHAT_EPOCH, LEGACY_IMPORT_PRODUCER_ID, digestLegacyDocument, readLegacyHistoryFile, refuse, sha256Hex,
  toLegacyDocumentObject,
} from './history-legacy-format.js';
import {
  PARTIAL_MARKER_FILE, assertOutputPath, assertRealDirectory, discardOwnPartial, fsyncDirectory, hashFile, lstatOrNull,
  openImmutableDatabase, publishDirectory, replaceOwnFileDurable, writeFileExclusiveDurable,
} from './history-migration-fs.js';
import { HISTORY_IMPORT_FORMAT_VERSION, digestCanonical, digestStoredChat, hasSidecarTables, readChatAsLegacy } from './history-sidecar.js';

export const ROLLBACK_PLAN_SCHEMA = 'cretli-history-rollback-plan-v1';
export const ROLLBACK_MANIFEST_SCHEMA = 'cretli-history-rollback-manifest-v1';
export const ROLLBACK_MANIFEST_FILE = 'manifest.json';
export const ROLLBACK_LEGACY_DIR = 'legacy-chat-history';
export const ROLLBACK_CONTROL_DIR = 'rollback-control';
export const ROLLBACK_CONTROL_FILE = 'control.json';
const SIDECAR_BATCH = 500;

/**
 * Open and sanity-check the store; the caller closes it.
 *
 * @param {string} storeDir
 */
function openSourceStore(storeDir) {
  const dir = assertRealDirectory(storeDir, 'Store directory');
  const dbPath = path.join(dir, DEFAULT_STORAGE_DB_FILENAME);
  const stat = lstatOrNull(dbPath);
  if (!stat || !stat.isFile()) refuse('store_missing', 'Store directory has no storage database');
  const db = openImmutableDatabase(dbPath);
  try {
    const applicationId = Number(db.prepare('PRAGMA application_id').get().application_id);
    const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (applicationId !== STORAGE_APPLICATION_ID) refuse('store_foreign_database', 'Database does not carry the Cretli application id');
    if (schemaVersion !== CORE_MIGRATIONS.length) refuse('store_schema_unsupported', 'Store schema version is not the one this tool understands', { schemaVersion, supported: CORE_MIGRATIONS.length });
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || String(Object.values(integrity[0])[0]) !== 'ok') refuse('store_integrity_failed', 'SQLite integrity_check failed on the source store');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) refuse('store_foreign_key_failed', 'SQLite foreign_key_check failed on the source store');
    return { db, dbPath, dir, schemaVersion };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Read-only description of what an export would contain.
 *
 * @param {{ storeDir: string }} options
 */
export function planRollbackExport(options) {
  const { db, dbPath, schemaVersion } = openSourceStore(options.storeDir);
  try {
    const fingerprint = hashFile(dbPath);
    const chats = [];
    for (const row of db.prepare('SELECT chat_id FROM chat_history_state ORDER BY chat_id').iterate()) {
      const read = readChatAsLegacy(db, String(row.chat_id), { maxBytes: DEFAULT_MAX_LEGACY_FILE_BYTES });
      if (!read) continue;
      const state = read.state;
      /** @type {string[]} */
      const warnings = [];
      if (!read.imported) warnings.push('chat_created_after_import');
      else if (!read.unchangedSinceImport) warnings.push('modified_since_import');
      if (state.chat_epoch !== LEGACY_IMPORT_CHAT_EPOCH) warnings.push('chat_epoch_changed');
      chats.push({
        chatId: read.doc.chatId, events: read.doc.events.length, headSeq: read.doc.headSeq, revision: Number(state.revision),
        datasetGeneration: String(state.dataset_generation), chatEpoch: String(state.chat_epoch), imported: read.imported,
        unchangedSinceImport: read.unchangedSinceImport, warnings,
      });
    }
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM command_receipts) AS receipts, (SELECT count(*) FROM chat_history_dedupe) AS dedupe,
      (SELECT count(*) FROM chat_history_producers) AS producers, (SELECT count(*) FROM chat_history_epochs) AS epochs,
      (SELECT hwm FROM storage_fencing WHERE id = 1) AS hwm, (SELECT count(*) FROM chat_history_stage) AS staged`).get();
    const trimmedAcked = Number(db.prepare(`SELECT count(*) AS n FROM chat_history_dedupe d WHERE NOT EXISTS (
      SELECT 1 FROM chat_history_events e WHERE e.dataset_generation = d.dataset_generation AND e.chat_id = d.chat_id AND e.seq = d.event_seq)`).get().n);
    return {
      schema: ROLLBACK_PLAN_SCHEMA, ok: true, source: { file: DEFAULT_STORAGE_DB_FILENAME, bytes: fingerprint.bytes, sha256: fingerprint.sha256, schemaVersion },
      totals: {
        chats: chats.length, events: chats.reduce((sum, chat) => sum + chat.events, 0), receipts: Number(counts.receipts),
        dedupeRows: Number(counts.dedupe), producers: Number(counts.producers), epochs: Number(counts.epochs),
        ackedWithoutRetainedEvent: trimmedAcked,
        // Fragments of large records that never reached their finalizing append. Not history: the export ignores them.
        uncommittedStagedRecords: Number(counts.staged),
      },
      storageFencingHwm: Number(counts.hwm), chats,
      planHash: digestCanonical({ schema: ROLLBACK_PLAN_SCHEMA, formatVersion: HISTORY_IMPORT_FORMAT_VERSION, sha256: fingerprint.sha256, bytes: fingerprint.bytes }),
    };
  } finally {
    db.close();
  }
}

/**
 * Stream a keyset-paged query into a JSONL file inside `controlDir`.
 *
 * @param {string} filePath
 * @param {(after: Record<string, unknown> | null) => Array<Record<string, unknown>>} fetchPage
 * @param {(row: Record<string, unknown>) => Record<string, unknown>} shape
 * @returns {{ lines: number, sha256: string, bytes: number }}
 */
function writeJsonlSidecar(filePath, fetchPage, shape) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  let lines = 0;
  try {
    for (let after = null; ;) {
      const page = fetchPage(after);
      if (page.length === 0) break;
      fs.writeSync(fd, page.map((row) => `${JSON.stringify(shape(row))}\n`).join(''));
      lines += page.length;
      after = page[page.length - 1];
      if (page.length < SIDECAR_BATCH) break;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const { sha256, bytes } = hashFile(filePath);
  return { lines, sha256, bytes };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} controlDir
 */
function writeControlSidecars(db, controlDir) {
  const page = (sql, keyColumns) => (after) => {
    const where = after ? `WHERE (${keyColumns.join(', ')}) > (${keyColumns.map(() => '?').join(', ')})` : '';
    return db.prepare(sql.replace('/*WHERE*/', where).replace('/*LIMIT*/', `LIMIT ${SIDECAR_BATCH}`)).all(...(after ? keyColumns.map((c) => after[c]) : []));
  };
  const parse = (value) => JSON.parse(String(value));
  return {
    'chat-state.jsonl': writeJsonlSidecar(path.join(controlDir, 'chat-state.jsonl'),
      page('SELECT * FROM chat_history_state /*WHERE*/ ORDER BY chat_id /*LIMIT*/', ['chat_id']),
      (r) => ({ chatId: r.chat_id, datasetGeneration: r.dataset_generation, chatEpoch: r.chat_epoch, revision: r.revision, nextSeq: r.next_seq,
        retentionLimit: r.retention_limit, trimmedThroughSeq: r.trimmed_through_seq, updatedAt: r.updated_at })),
    'epochs.jsonl': writeJsonlSidecar(path.join(controlDir, 'epochs.jsonl'),
      page('SELECT * FROM chat_history_epochs /*WHERE*/ ORDER BY chat_id, dataset_generation, chat_epoch /*LIMIT*/', ['chat_id', 'dataset_generation', 'chat_epoch']),
      (r) => ({ chatId: r.chat_id, datasetGeneration: r.dataset_generation, chatEpoch: r.chat_epoch, createdAt: r.created_at })),
    'producers.jsonl': writeJsonlSidecar(path.join(controlDir, 'producers.jsonl'),
      page('SELECT * FROM chat_history_producers /*WHERE*/ ORDER BY dataset_generation, chat_id, producer_id /*LIMIT*/', ['dataset_generation', 'chat_id', 'producer_id']),
      (r) => ({ datasetGeneration: r.dataset_generation, chatId: r.chat_id, producerId: r.producer_id, chatEpoch: r.chat_epoch, status: r.status, createdAt: r.created_at, retiredAt: r.retired_at })),
    'dedupe.jsonl': writeJsonlSidecar(path.join(controlDir, 'dedupe.jsonl'),
      page('SELECT * FROM chat_history_dedupe /*WHERE*/ ORDER BY dataset_generation, chat_id, producer_id, client_seq /*LIMIT*/', ['dataset_generation', 'chat_id', 'producer_id', 'client_seq']),
      (r) => ({ datasetGeneration: r.dataset_generation, chatId: r.chat_id, producerId: r.producer_id, clientSeq: r.client_seq, chatEpoch: r.chat_epoch,
        eventSeq: r.event_seq, requestDigest: r.request_digest, result: parse(r.result_json), createdAt: r.created_at })),
    'event-identity.jsonl': writeJsonlSidecar(path.join(controlDir, 'event-identity.jsonl'),
      page('SELECT dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, revision, created_at FROM chat_history_events /*WHERE*/ ORDER BY dataset_generation, chat_id, seq /*LIMIT*/', ['dataset_generation', 'chat_id', 'seq']),
      (r) => ({ datasetGeneration: r.dataset_generation, chatId: r.chat_id, seq: r.seq, chatEpoch: r.chat_epoch, producerId: r.producer_id, clientSeq: r.client_seq,
        revision: r.revision, createdAt: r.created_at, legacyProducer: r.producer_id === LEGACY_IMPORT_PRODUCER_ID })),
    'receipts.jsonl': writeJsonlSidecar(path.join(controlDir, 'receipts.jsonl'),
      page('SELECT * FROM command_receipts /*WHERE*/ ORDER BY dataset_generation, command_id /*LIMIT*/', ['dataset_generation', 'command_id']),
      (r) => ({ datasetGeneration: r.dataset_generation, commandId: r.command_id, requestDigest: r.request_digest, result: parse(r.result_json), createdAt: r.created_at })),
  };
}

/**
 * Build the rollback export. `confirmPlanHash` must be the hash of
 * `planRollbackExport` for the very store bytes being exported.
 *
 * @param {{
 *   storeDir: string,
 *   legacyOut: string,
 *   confirmPlanHash: string,
 *   cursorSessionIds?: Record<string, string>,
 *   discardPartial?: boolean,
 *   now?: () => number,
 *   faultHook?: (point: string, info: Record<string, unknown>) => void,
 * }} options
 */
export function applyRollbackExport(options) {
  const hook = options.faultHook ?? (() => {});
  const now = options.now ?? Date.now;
  const storeDir = assertRealDirectory(options.storeDir, 'Store directory');
  const { output, partial } = assertOutputPath(options.legacyOut, [storeDir]);
  const plan = planRollbackExport({ storeDir });
  if (options.confirmPlanHash !== plan.planHash) refuse('plan_hash_mismatch', 'confirmPlanHash does not match the store (it changed or the plan is for another store)', { expected: plan.planHash });
  if (lstatOrNull(partial)) {
    if (!options.discardPartial) refuse('export_partial_exists', 'A partial export exists; remove it with discardPartial after inspecting it');
    discardOwnPartial(partial);
  }
  const startedAt = new Date(now()).toISOString();
  fs.mkdirSync(partial, { mode: 0o700 });
  replaceOwnFileDurable(path.join(partial, PARTIAL_MARKER_FILE), `${JSON.stringify({ schema: 'cretli-history-rollback-marker-v1', planHash: plan.planHash, startedAt, state: 'exporting' }, null, 2)}\n`);
  const legacyDir = path.join(partial, ROLLBACK_LEGACY_DIR);
  const controlDir = path.join(partial, ROLLBACK_CONTROL_DIR);
  fs.mkdirSync(legacyDir, { mode: 0o700 });
  fs.mkdirSync(controlDir, { mode: 0o700 });
  const { db, dbPath } = openSourceStore(storeDir);
  /** @type {Array<Record<string, unknown>>} */
  const chatEntries = [];
  let controlFiles;
  try {
    // One read transaction: every chat and every sidecar row come from the same snapshot.
    db.exec('BEGIN');
    for (const row of db.prepare('SELECT chat_id FROM chat_history_state ORDER BY chat_id').iterate()) {
      const chatId = String(row.chat_id);
      const read = readChatAsLegacy(db, chatId, { maxBytes: DEFAULT_MAX_LEGACY_FILE_BYTES, cursorSessionId: options.cursorSessionIds?.[chatId] });
      if (!read) continue;
      const content = `${JSON.stringify(toLegacyDocumentObject(read.doc), null, 2)}`;
      writeFileExclusiveDurable(path.join(legacyDir, `${chatId}.json`), content);
      const digest = digestStoredChat(read);
      const overridden = options.cursorSessionIds !== undefined && chatId in options.cursorSessionIds;
      const importRow = hasSidecarTables(db) ? db.prepare('SELECT content_digest FROM legacy_import_chat WHERE chat_id = ?').get(chatId) : undefined;
      /** @type {string[]} */
      const warnings = [];
      if (!read.imported) warnings.push('chat_created_after_import');
      else if (!read.unchangedSinceImport) warnings.push('modified_since_import');
      if (read.state.chat_epoch !== LEGACY_IMPORT_CHAT_EPOCH) warnings.push('chat_epoch_changed');
      chatEntries.push({
        chatId, file: `${ROLLBACK_LEGACY_DIR}/${chatId}.json`, sha256: sha256Hex(content), bytes: Buffer.byteLength(content), events: read.doc.events.length,
        headSeq: read.doc.headSeq, revision: Number(read.state.revision), datasetGeneration: String(read.state.dataset_generation),
        chatEpoch: String(read.state.chat_epoch), contentDigest: digest, imported: read.imported, unchangedSinceImport: read.unchangedSinceImport,
        // For an untouched imported chat the export must equal the original legacy document (canonical digest; formatting is not preserved).
        matchesImportDigest: importRow && !overridden ? importRow.content_digest === digest : null, warnings,
      });
      hook('chat-exported', { chatId });
    }
    controlFiles = writeControlSidecars(db, controlDir);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* read transaction */ }
    db.close();
    throw error;
  }
  db.close();
  const after = hashFile(dbPath);
  if (after.sha256 !== plan.source.sha256 || after.bytes !== plan.source.bytes) {
    refuse('source_changed_during_export', 'The store changed while it was exported; writes made meanwhile are not in this export. The partial export was kept for inspection.');
  }
  for (const entry of chatEntries) {
    if (entry.matchesImportDigest === false && entry.unchangedSinceImport === true) {
      refuse('export_roundtrip_mismatch', 'An untouched imported chat does not export to its original content', { chatId: entry.chatId });
    }
  }
  const control = {
    schema: 'cretli-history-rollback-control-v1', formatVersion: HISTORY_IMPORT_FORMAT_VERSION,
    source: plan.source, storageFencingHwm: plan.storageFencingHwm,
    requiredMinimumFenceEpoch: plan.storageFencingHwm + 1,
    plainLegacyBinaryCompatible: false,
    legacyAdapterRequired: true,
    clientCacheInvalidationRequired: true,
    quarantineBrowserQueues: true,
    datasetGenerations: [...new Set(chatEntries.map((chat) => chat.datasetGeneration))].sort(),
    controlDirActions: [
      { action: 'quiesce-and-fence-new-store', detail: 'Stop every new-version writer and raise the control-directory fencing high-water mark to at least requiredMinimumFenceEpoch before any legacy writer starts (coordinator.md).' },
      { action: 'write-restore-pause-marker', detail: 'Keep the restore-pause marker until a sidecar-aware legacy adapter has loaded this control data.' },
      { action: 'advance-dataset-generation', detail: 'Publish a new dataset generation so old caches and browser queues are invalidated and quarantined for reconciliation.' },
      { action: 'verify-source-unchanged', detail: 'Re-run verify with the store directory immediately before publishing the legacy files; any difference means writes were lost from this export.' },
    ],
    sidecars: controlFiles,
    notice: 'Receipts, dedupe ledger, producers and per-event identity are carried only here. Plain legacy code ignores them, so retried commands cannot be answered from receipts after a rollback.',
  };
  replaceOwnFileDurable(path.join(controlDir, ROLLBACK_CONTROL_FILE), `${JSON.stringify(control, null, 2)}\n`);
  const modified = chatEntries.filter((chat) => /** @type {any} */ (chat).warnings.includes('modified_since_import')).length;
  const createdAfter = chatEntries.filter((chat) => /** @type {any} */ (chat).warnings.includes('chat_created_after_import')).length;
  const manifest = {
    schema: ROLLBACK_MANIFEST_SCHEMA, formatVersion: HISTORY_IMPORT_FORMAT_VERSION, createdAt: new Date(now()).toISOString(),
    runtime: { node: process.versions.node, sqlite: process.versions.sqlite }, planHash: plan.planHash, source: plan.source,
    totals: { ...plan.totals, chats: chatEntries.length, events: chatEntries.reduce((sum, chat) => sum + /** @type {number} */ (chat.events), 0) },
    chats: chatEntries,
    control: { file: `${ROLLBACK_CONTROL_DIR}/${ROLLBACK_CONTROL_FILE}`, sha256: hashFile(path.join(controlDir, ROLLBACK_CONTROL_FILE)).sha256 },
    summary: { chatsUnchangedSinceImport: chatEntries.length - modified - createdAfter, chatsModifiedSinceImport: modified, chatsCreatedAfterImport: createdAfter },
    limits: [
      'Event retention (2000 per chat) and legacy coalescing are applied exactly as in the store; ackedWithoutRetainedEvent counts acknowledged inputs whose event was retired by retention or reset, not lost by this export.',
      'A legacy document cannot express epoch, generation, producers or receipts; see rollback-control/ and plainLegacyBinaryCompatible=false.',
      'The tool detects a changed store (hash before/after); it does not stop writers.',
    ],
  };
  replaceOwnFileDurable(path.join(partial, ROLLBACK_MANIFEST_FILE), `${JSON.stringify({ ...manifest, manifestHash: digestCanonical(manifest) }, null, 2)}\n`);
  verifyPartialExport(partial, manifest);
  hook('before-publish', {});
  fs.rmSync(path.join(partial, PARTIAL_MARKER_FILE));
  fsyncDirectory(partial);
  publishDirectory(partial, output);
  return { manifest: { ...manifest, manifestHash: digestCanonical(manifest) }, output };
}

/**
 * Re-read what was written with the STRICT legacy reader and check it against
 * the manifest, so an export the legacy side could not load fails here.
 *
 * @param {string} exportDir
 * @param {{ chats: Array<Record<string, any>>, control: { sha256: string } }} manifest
 */
function verifyPartialExport(exportDir, manifest) {
  for (const chat of manifest.chats) {
    const filePath = path.join(exportDir, chat.file);
    const read = readLegacyHistoryFile(filePath, { expectedChatId: chat.chatId });
    if (read.sha256 !== chat.sha256 || digestLegacyDocument(read.doc) !== chat.contentDigest || read.doc.events.length !== chat.events) {
      refuse('export_verify_mismatch', 'Exported file does not match the manifest or the legacy reader', { chatId: chat.chatId });
    }
  }
  if (hashFile(path.join(exportDir, ROLLBACK_CONTROL_DIR, ROLLBACK_CONTROL_FILE)).sha256 !== manifest.control.sha256) {
    refuse('export_verify_mismatch', 'Control file does not match the manifest');
  }
}

/**
 * Verify a published export and (when given) that the store it came from is
 * byte-identical to the one exported. Run this immediately before any legacy
 * publication step; a mismatch means acknowledged writes are not in the export.
 *
 * @param {{ exportDir: string, storeDir?: string }} options
 */
export function verifyRollbackExport(options) {
  const exportDir = assertRealDirectory(options.exportDir, 'Export directory');
  if (lstatOrNull(path.join(exportDir, PARTIAL_MARKER_FILE))) refuse('export_incomplete', 'Directory still carries the incomplete-export marker');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(exportDir, ROLLBACK_MANIFEST_FILE), 'utf8'));
  } catch {
    return refuse('manifest_invalid', 'Manifest is missing or not valid JSON');
  }
  const { manifestHash, ...body } = manifest;
  if (manifest.schema !== ROLLBACK_MANIFEST_SCHEMA || digestCanonical(body) !== manifestHash) refuse('manifest_hash_mismatch', 'Manifest content does not match its hash');
  verifyPartialExport(exportDir, manifest);
  for (const [name, info] of Object.entries(JSON.parse(fs.readFileSync(path.join(exportDir, ROLLBACK_CONTROL_DIR, ROLLBACK_CONTROL_FILE), 'utf8')).sidecars)) {
    if (hashFile(path.join(exportDir, ROLLBACK_CONTROL_DIR, name)).sha256 !== /** @type {any} */ (info).sha256) refuse('export_verify_mismatch', 'A control sidecar differs from the control file', { name });
  }
  let sourceUnchanged = null;
  if (options.storeDir) {
    const dir = assertRealDirectory(options.storeDir, 'Store directory');
    const current = hashFile(path.join(dir, DEFAULT_STORAGE_DB_FILENAME));
    if (current.sha256 !== manifest.source.sha256 || current.bytes !== manifest.source.bytes) {
      refuse('source_changed_since_export', 'The store changed after the export; acknowledged writes made since are not in it');
    }
    sourceUnchanged = true;
  }
  return { ok: true, manifestHash, chats: manifest.chats.length, events: manifest.totals.events, sourceUnchanged };
}
