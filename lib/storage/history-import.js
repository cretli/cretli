/**
 * Offline, strict legacy chat-history -> SQLite staging import (stage 1 of the
 * history migration; docs/storage-history-migration.md).
 *
 * This is NOT a live migration and not a cutover. It reads a quiesced legacy
 * `chat-history` directory (read-only), builds a brand-new store in a staging
 * directory and publishes that directory with one rename. It takes no lock on
 * the source and promises no live ownership: the operator runs it with every
 * writer stopped, and the tool only DETECTS a changed source (SHA-256 per
 * file between plan, import and verification). Nothing is dual-written and the
 * server never calls this module.
 *
 * Why direct inserts and not the append API: `appendEvents` allocates fresh
 * sequence numbers, coalesces, trims and rewrites records (it stamps
 * `clientSeq`). The import must keep the historical `seq` values, gaps,
 * unknown fields and `headSeq` exactly, so it writes the rows the schema
 * defines (state, epoch, producer, events, dedupe) itself, inside one
 * transaction per chat, with the same identity rules the store enforces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeRequestDigest } from './command-receipts.js';
import { HISTORY_RETENTION_LIMIT } from './chat-history-store.js';
import { DEFAULT_STORAGE_DB_FILENAME, openStorageDb, runWalTruncateBarrier } from './db-lifecycle.js';
import { DATASET_GENERATION_PATTERN } from './command-receipts.js';
import { bindDatasetGeneration } from './dataset-binding.js';
import {
  DEFAULT_MAX_LEGACY_FILE_BYTES, HistoryMigrationError, LEGACY_CHAT_ID_PATTERN, LEGACY_IMPORT_CHAT_EPOCH,
  LEGACY_IMPORT_PRODUCER_ID, digestLegacyDocument, readLegacyHistoryFile, refuse, sha256Hex,
} from './history-legacy-format.js';
import {
  PARTIAL_MARKER_FILE, assertOutputPath, assertRealDirectory, fsyncDirectory, hashFile, lstatOrNull,
  openImmutableDatabase, publishDirectory, replaceOwnFileDurable,
} from './history-migration-fs.js';
import {
  HISTORY_IMPORT_FORMAT_VERSION, digestCanonical, digestStoredChat, ensureSidecarTables, parseTimestampMs, readChatAsLegacy,
} from './history-sidecar.js';
import { toWireJson } from './worker-wire.js';

export const IMPORT_PLAN_SCHEMA = 'cretli-history-import-plan-v1';
export const IMPORT_MANIFEST_SCHEMA = 'cretli-history-import-manifest-v1';
export const IMPORT_MANIFEST_FILE = 'manifest.json';
/** Leftover of `writeJsonAtomic` (`<file>.json.<pid>.<ms>.tmp`): ignored by the legacy loader, reported here. */
const LEGACY_TEMP_PATTERN = /^[a-zA-Z0-9-]{1,128}\.json\.\d+\.\d+\.tmp$/;
/** Highest `seq` / `headSeq` an import accepts; a larger counter is corrupt or hostile input, never repaired. */
export const DEFAULT_MAX_IMPORT_SEQ = 2_147_483_647;
/**
 * Agent-protection files that live beside the legacy files. They are metadata of the directory, not history:
 * the plan lists them (name, size, SHA-256) as `protectedIgnored`, binds them into the plan hash, and neither
 * imports, copies, moves nor deletes them. Only these exact names qualify, and only as regular files.
 */
export const PROTECTED_IGNORE_FILES = Object.freeze(['.cursorignore', '.rgignore']);

/**
 * @typedef {{
 *   chatId: string, file: string, sha256: string, bytes: number, events: number, headSeq: number,
 *   firstSeq: number | null, lastSeq: number | null, contentDigest: string, warnings: string[],
 *   clientSeqEvents: number, docExtraKeys: number, eventExtraCount: number,
 * }} PlannedChat
 */

/**
 * @param {unknown} generation
 * @returns {string}
 */
function assertDatasetGeneration(generation) {
  if (typeof generation !== 'string' || !DATASET_GENERATION_PATTERN.test(generation)) {
    refuse('dataset_generation_invalid', 'datasetGeneration must match the receipt alphabet (letters, digits, _ . : -, at most 128 characters)');
  }
  return generation;
}

/**
 * Read-only plan: scan the legacy directory, strictly validate every file and
 * report what an apply would do. Writes nothing anywhere.
 *
 * @param {{
 *   legacyDir: string,
 *   datasetGeneration: string,
 *   maxFileBytes?: number,
 *   maxSeq?: number,
 *   minQuietMs?: number,
 *   nowMs?: () => number,
 * }} options
 */
export function planLegacyImport(options) {
  const legacyDir = assertRealDirectory(options.legacyDir, 'Legacy history directory');
  const datasetGeneration = assertDatasetGeneration(options.datasetGeneration);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_LEGACY_FILE_BYTES;
  const minQuietMs = options.minQuietMs ?? 0;
  const maxSeq = options.maxSeq ?? DEFAULT_MAX_IMPORT_SEQ;
  const nowMs = (options.nowMs ?? Date.now)();
  /** @type {PlannedChat[]} */
  const files = [];
  /** Files whose chat id collides with an earlier file (case-folded): excluded from the import and reported. */
  /** @type {Array<{ file: string, chatId: string, duplicateOf: string }>} */
  const quarantined = [];
  /** @type {Map<string, string>} case-folded chat id -> first file that claimed it */
  const claimed = new Map();
  /** @type {Array<{ file: string, code: string, details: Record<string, unknown> }>} */
  const refusals = [];
  /** @type {Array<{ file: string, bytes: number }>} */
  const ignored = [];
  /** @type {Array<{ file: string, bytes: number, sha256: string }>} */
  const protectedIgnored = [];
  const entries = fs.readdirSync(legacyDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = entry.name;
    if (LEGACY_TEMP_PATTERN.test(name) && entry.isFile()) {
      ignored.push({ file: name, bytes: fs.lstatSync(path.join(legacyDir, name)).size });
      continue;
    }
    if (PROTECTED_IGNORE_FILES.includes(name) && entry.isFile()) {
      const bytes = fs.readFileSync(path.join(legacyDir, name));
      protectedIgnored.push({ file: name, bytes: bytes.length, sha256: sha256Hex(bytes) });
      continue;
    }
    if (!name.endsWith('.json') || !LEGACY_CHAT_ID_PATTERN.test(name.slice(0, -5))) {
      refusals.push({ file: name, code: 'legacy_unexpected_entry', details: { type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other' } });
      continue;
    }
    const filePath = path.join(legacyDir, name);
    try {
      const quietAge = nowMs - fs.lstatSync(filePath).mtimeMs;
      if (minQuietMs > 0 && quietAge < minQuietMs) {
        throw new HistoryMigrationError('legacy_recently_modified', 'Legacy file was modified moments ago; a writer may still be running', { ageMs: Math.round(quietAge), minQuietMs });
      }
      const { doc, sha256, bytes } = readLegacyHistoryFile(filePath, { expectedChatId: name.slice(0, -5), maxFileBytes });
      const lastSeq = doc.events.at(-1)?.seq ?? 0;
      if (doc.headSeq > maxSeq || lastSeq > maxSeq) {
        throw new HistoryMigrationError('legacy_seq_over_limit', 'Legacy sequence number is above the import limit', { headSeq: doc.headSeq, lastSeq, maxSeq });
      }
      const identity = doc.chatId.toLowerCase();
      const first = claimed.get(identity);
      if (first !== undefined) {
        // The same chat claimed by two files (e.g. names differing only by case): which one is authoritative is unknowable.
        quarantined.push({ file: name, chatId: doc.chatId, duplicateOf: first });
        continue;
      }
      claimed.set(identity, name);
      files.push({
        chatId: doc.chatId, file: name, sha256, bytes, events: doc.events.length, headSeq: doc.headSeq,
        firstSeq: doc.events[0]?.seq ?? null, lastSeq: doc.events.at(-1)?.seq ?? null,
        contentDigest: digestLegacyDocument(doc), warnings: doc.warnings,
        clientSeqEvents: doc.events.filter((event) => 'clientSeq' in event.rec).length,
        docExtraKeys: Object.keys(doc.docExtra).length, eventExtraCount: doc.events.filter((event) => event.extra).length,
      });
    } catch (error) {
      if (!(error instanceof HistoryMigrationError)) throw error;
      refusals.push({ file: name, code: error.code, details: error.details });
    }
  }
  const totals = {
    chats: files.length,
    events: files.reduce((sum, file) => sum + file.events, 0),
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    warnings: files.reduce((sum, file) => sum + file.warnings.length, 0),
  };
  const planHash = digestCanonical({
    schema: IMPORT_PLAN_SCHEMA, formatVersion: HISTORY_IMPORT_FORMAT_VERSION, datasetGeneration,
    files: files.map((file) => [file.file, file.sha256, file.bytes]), ignored: ignored.map((item) => item.file),
    quarantined: quarantined.map((item) => [item.file, item.duplicateOf]),
    protectedIgnored: protectedIgnored.map((item) => [item.file, item.sha256, item.bytes]),
  });
  return {
    schema: IMPORT_PLAN_SCHEMA, ok: refusals.length === 0, datasetGeneration,
    chatEpoch: LEGACY_IMPORT_CHAT_EPOCH, producerId: LEGACY_IMPORT_PRODUCER_ID,
    totals, files, ignored, protectedIgnored, quarantined, refusals, planHash,
    // Rough upper bound, not a measurement: SQLite page overhead plus a rewritten payload.
    estimatedStagingBytes: Math.ceil(totals.sourceBytes * 1.5) + 64 * 1024,
  };
}

/**
 * Insert one validated legacy document as a complete chat, in the caller's
 * transaction. Mirrors the rows `appendEvents` would have produced, with the
 * historical sequence numbers kept.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ doc: import('./history-legacy-format.js').LegacyHistoryDocument, sha256: string, bytes: number }} source
 * @param {string} datasetGeneration
 * @param {number} importedAtMs
 * @returns {{ dedupeRows: number, revision: number }}
 */
function insertLegacyChat(db, source, datasetGeneration, importedAtMs) {
  const { doc } = source;
  const stateUpdatedAt = parseTimestampMs(doc.updatedAt);
  const revision = doc.events.length;
  db.prepare(`INSERT INTO chat_history_state
    (chat_id, dataset_generation, chat_epoch, revision, next_seq, retention_limit, trimmed_through_seq, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    doc.chatId, datasetGeneration, LEGACY_IMPORT_CHAT_EPOCH, revision, doc.headSeq + 1, HISTORY_RETENTION_LIMIT,
    // Everything below the first retained seq is unavailable; the legacy file cannot tell trimming from coalescing gaps.
    doc.events.length > 0 ? doc.events[0].seq - 1 : doc.headSeq, stateUpdatedAt,
  );
  db.prepare('INSERT INTO chat_history_epochs (chat_id, dataset_generation, chat_epoch, created_at) VALUES (?, ?, ?, ?)')
    .run(doc.chatId, datasetGeneration, LEGACY_IMPORT_CHAT_EPOCH, importedAtMs);
  // Retired from birth: nothing can append as the import producer, so it cannot be forged.
  db.prepare(`INSERT INTO chat_history_producers
    (dataset_generation, chat_id, producer_id, chat_epoch, status, created_at, retired_at) VALUES (?, ?, ?, ?, 'retired', ?, ?)`)
    .run(datasetGeneration, doc.chatId, LEGACY_IMPORT_PRODUCER_ID, LEGACY_IMPORT_CHAT_EPOCH, importedAtMs, importedAtMs);
  const insertEvent = db.prepare(`INSERT INTO chat_history_events
    (dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, kind, payload_json, created_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDedupe = db.prepare(`INSERT INTO chat_history_dedupe
    (dataset_generation, chat_id, producer_id, client_seq, chat_epoch, event_seq, request_digest, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertExtra = db.prepare('INSERT INTO legacy_import_event_extra (chat_id, seq, extra_json) VALUES (?, ?, ?)');
  const insertLiveExtra = db.prepare('INSERT INTO chat_history_event_extra (chat_id, seq, extra_json) VALUES (?, ?, ?)');
  let dedupeRows = 0;
  doc.events.forEach((event, index) => {
    const ordinal = index + 1;
    const createdAt = parseTimestampMs(event.rec.createdAt);
    const hasClientSeq = 'clientSeq' in event.rec;
    // events.client_seq is informational for imported rows: the record's own clientSeq (or its absence) is authoritative.
    insertEvent.run(datasetGeneration, doc.chatId, event.seq, LEGACY_IMPORT_CHAT_EPOCH, LEGACY_IMPORT_PRODUCER_ID,
      hasClientSeq ? /** @type {number} */ (event.rec.clientSeq) : 0, /** @type {string} */ (event.rec.kind),
      toWireJson(event.rec).json, createdAt, ordinal);
    if (hasClientSeq) {
      const { clientSeq, ...input } = /** @type {Record<string, any>} */ (event.rec);
      // The digest a retry of the same content would compute (history.input in chat-history-store.js).
      const digest = computeRequestDigest('history.input', { chatEpoch: LEGACY_IMPORT_CHAT_EPOCH, rec: input, createdAt: null, coalesce: true });
      insertDedupe.run(datasetGeneration, doc.chatId, LEGACY_IMPORT_PRODUCER_ID, clientSeq, LEGACY_IMPORT_CHAT_EPOCH, event.seq, digest,
        JSON.stringify({ clientSeq, seq: event.seq, revision: ordinal, duplicate: false }), createdAt);
      dedupeRows += 1;
    }
    if (event.extra) {
      const extraJson = toWireJson(event.extra).json;
      insertExtra.run(doc.chatId, event.seq, extraJson);
      insertLiveExtra.run(doc.chatId, event.seq, extraJson);
    }
  });
  // Live metadata (schema v4): what the store's own commands maintain from now on. The legacy_import_* rows stay as provenance.
  db.prepare('INSERT INTO chat_history_meta (chat_id, cursor_session_id, doc_extra_json, updated_at_raw) VALUES (?, ?, ?, ?)')
    .run(doc.chatId, doc.cursorSessionId, toWireJson(doc.docExtra).json, doc.updatedAt);
  db.prepare(`INSERT INTO legacy_import_chat
    (chat_id, source_sha256, source_bytes, cursor_session_id, updated_at_raw, import_state_updated_at,
     import_revision, import_next_seq, import_dataset_generation, import_chat_epoch, doc_extra_json, event_count, head_seq, content_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    doc.chatId, source.sha256, source.bytes, doc.cursorSessionId, doc.updatedAt, stateUpdatedAt,
    revision, doc.headSeq + 1, datasetGeneration, LEGACY_IMPORT_CHAT_EPOCH,
    toWireJson(doc.docExtra).json, doc.events.length, doc.headSeq, digestLegacyDocument(doc),
  );
  return { dedupeRows, revision };
}

/**
 * Prove that the store holds exactly what the legacy files say, per chat, by
 * reading it back through the same mapping the rollback export uses.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof planLegacyImport>} plan
 * @param {string} legacyDir
 * @returns {{ chatsCompared: number, eventsCompared: number, dedupeRows: number }}
 */
function compareStoreToSource(db, plan, legacyDir) {
  let eventsCompared = 0;
  for (const file of plan.files) {
    const source = readLegacyHistoryFile(path.join(legacyDir, file.file), { expectedChatId: file.chatId });
    if (source.sha256 !== file.sha256) refuse('source_changed_since_plan', 'A legacy file changed after it was planned', { file: file.file });
    const storedLast = db.prepare('SELECT max(seq) AS last_seq FROM chat_history_events WHERE chat_id = ?').get(file.chatId);
    if ((storedLast?.last_seq ?? null) !== file.lastSeq) {
      refuse('verify_last_seq_mismatch', 'Store last seq differs from the legacy file', { chatId: file.chatId, expected: file.lastSeq, actual: storedLast?.last_seq ?? null });
    }
    const stored = readChatAsLegacy(db, file.chatId);
    if (!stored || !stored.unchangedSinceImport) refuse('verify_chat_missing', 'Imported chat is missing or was modified in staging', { chatId: file.chatId });
    if (digestStoredChat(stored) !== digestLegacyDocument(source.doc) || stored.doc.events.length !== file.events) {
      refuse('verify_content_mismatch', 'Store content differs from the legacy file', { chatId: file.chatId });
    }
    const state = stored.state;
    if (Number(state.next_seq) !== file.headSeq + 1 || Number(state.revision) !== file.events) {
      refuse('verify_state_mismatch', 'Store sequence or revision differs from the legacy file', { chatId: file.chatId });
    }
    eventsCompared += file.events;
  }
  const total = db.prepare('SELECT (SELECT count(*) FROM chat_history_state) AS chats, (SELECT count(*) FROM chat_history_events) AS events').get();
  if (Number(total.chats) !== plan.files.length || Number(total.events) !== plan.totals.events) {
    refuse('verify_count_mismatch', 'Store totals differ from the plan', { chats: Number(total.chats), events: Number(total.events) });
  }
  const dedupe = Number(db.prepare('SELECT count(*) AS n FROM chat_history_dedupe').get().n);
  const expectedDedupe = plan.files.reduce((sum, file) => sum + file.clientSeqEvents, 0);
  if (dedupe !== expectedDedupe) refuse('verify_count_mismatch', 'Dedupe ledger size differs from the number of client-keyed events', { dedupe, expectedDedupe });
  return { chatsCompared: plan.files.length, eventsCompared, dedupeRows: dedupe };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function assertDatabaseIntegrity(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || String(Object.values(integrity[0])[0]) !== 'ok') refuse('verify_integrity_failed', 'SQLite integrity_check failed');
  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) refuse('verify_foreign_key_failed', 'SQLite foreign_key_check failed');
}

/**
 * Build the manifest of a completed staging store and its content hash.
 *
 * @param {{ plan: ReturnType<typeof planLegacyImport>, stagingDir: string, validation: any, schemaVersion: number, runtime: { node: string, sqlite: string }, createdAt: string }} input
 */
function buildManifest(input) {
  const { plan, stagingDir } = input;
  const dbFile = hashFile(path.join(stagingDir, DEFAULT_STORAGE_DB_FILENAME));
  const manifest = {
    schema: IMPORT_MANIFEST_SCHEMA, formatVersion: HISTORY_IMPORT_FORMAT_VERSION, createdAt: input.createdAt,
    runtime: input.runtime, datasetGeneration: plan.datasetGeneration, chatEpoch: plan.chatEpoch, producerId: plan.producerId,
    retentionLimit: HISTORY_RETENTION_LIMIT, planHash: plan.planHash,
    db: { file: DEFAULT_STORAGE_DB_FILENAME, bytes: dbFile.bytes, sha256: dbFile.sha256, schemaVersion: input.schemaVersion },
    totals: plan.totals,
    chats: plan.files.map((file) => ({
      chatId: file.chatId, sourceFile: file.file, sourceSha256: file.sha256, sourceBytes: file.bytes, events: file.events,
      headSeq: file.headSeq, lastSeq: file.lastSeq, nextSeq: file.headSeq + 1, revision: file.events, contentDigest: file.contentDigest,
      warnings: file.warnings,
    })),
    ignoredEntries: plan.ignored,
    protectedIgnoredEntries: plan.protectedIgnored,
    quarantinedEntries: plan.quarantined,
    validation: input.validation,
    limits: [
      'Offline staging only: no live ownership, no dual write, no production caller or cutover is implied.',
      'Source integrity is detected (SHA-256 per file), not locked.',
      'The staged store is valid only for the recorded datasetGeneration.',
    ],
  };
  return { ...manifest, manifestHash: digestCanonical(manifest) };
}

/**
 * @param {string} partial
 * @param {any} marker
 * @returns {void}
 */
function writeMarker(partial, marker) {
  replaceOwnFileDurable(path.join(partial, PARTIAL_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * @param {string} partial
 * @returns {Record<string, unknown> | null}
 */
function readMarker(partial) {
  try {
    return JSON.parse(fs.readFileSync(path.join(partial, PARTIAL_MARKER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build the staging store. Default callers run `planLegacyImport` first and pass
 * its `planHash` as `confirmPlanHash`; a source that changed since the plan, a
 * refused plan, an existing output or a foreign partial directory all stop the
 * run before any chat is written.
 *
 * Crash safety: every chat is one SQLite transaction, so a crash leaves the
 * staging store at a chat boundary; `resume: true` continues from the committed
 * chats after checking the marker, plan hash and per-chat source hashes. Resume
 * never touches the source or an existing final output.
 *
 * @param {{
 *   legacyDir: string,
 *   stagingOut: string,
 *   datasetGeneration: string,
 *   confirmPlanHash: string,
 *   resume?: boolean,
 *   maxFileBytes?: number,
 *   maxSeq?: number,
 *   minQuietMs?: number,
 *   now?: () => number,
 *   faultHook?: (point: string, info: Record<string, unknown>) => void,
 * }} options
 */
export function applyLegacyImport(options) {
  const legacyDir = assertRealDirectory(options.legacyDir, 'Legacy history directory');
  const { output, partial } = assertOutputPath(options.stagingOut, [legacyDir]);
  const hook = options.faultHook ?? (() => {});
  const now = options.now ?? Date.now;
  const plan = planLegacyImport({ legacyDir, datasetGeneration: options.datasetGeneration, maxFileBytes: options.maxFileBytes, maxSeq: options.maxSeq, minQuietMs: options.minQuietMs, nowMs: now });
  if (!plan.ok) refuse('plan_refused', 'The legacy directory has refusals; nothing was written', { refusals: plan.refusals.length });
  if (typeof options.confirmPlanHash !== 'string' || options.confirmPlanHash !== plan.planHash) {
    refuse('plan_hash_mismatch', 'confirmPlanHash does not match the current plan (source changed or wrong plan)', { expected: plan.planHash });
  }
  const startedAt = new Date(now()).toISOString();
  const marker = { schema: 'cretli-history-import-marker-v1', planHash: plan.planHash, datasetGeneration: plan.datasetGeneration, startedAt, state: 'importing' };
  const existing = lstatOrNull(partial);
  if (existing) {
    if (!options.resume) refuse('staging_partial_exists', 'A partial staging directory exists; pass resume to continue it or remove it deliberately');
    const found = existing.isDirectory() ? readMarker(partial) : null;
    if (!found || found.planHash !== plan.planHash || found.datasetGeneration !== plan.datasetGeneration) {
      refuse('staging_partial_mismatch', 'Partial staging directory belongs to a different plan or is not a migration directory');
    }
  } else {
    if (options.resume) refuse('staging_partial_missing', 'Nothing to resume');
    fs.mkdirSync(partial, { mode: 0o700 });
    writeMarker(partial, marker);
    fsyncDirectory(path.dirname(partial));
  }
  hook('after-marker', {});
  const handle = openStorageDb({ dir: partial, now });
  let resumed = 0;
  try {
    const db = handle.db;
    ensureSidecarTables(db);
    // The staged file belongs to exactly this generation from its first byte (schema v5 binding); the runtime refuses any other.
    bindDatasetGeneration(db, plan.datasetGeneration);
    const meta = db.prepare('SELECT * FROM legacy_import_meta WHERE id = 1').get();
    if (meta) {
      if (meta.plan_hash !== plan.planHash || meta.dataset_generation !== plan.datasetGeneration || Number(meta.format_version) !== HISTORY_IMPORT_FORMAT_VERSION) {
        refuse('staging_partial_mismatch', 'Staging store was created for a different plan');
      }
    } else {
      db.prepare(`INSERT INTO legacy_import_meta (id, format_version, plan_hash, dataset_generation, chat_epoch, producer_id, created_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)`).run(HISTORY_IMPORT_FORMAT_VERSION, plan.planHash, plan.datasetGeneration, plan.chatEpoch, plan.producerId, now());
    }
    const importedAtMs = Number(db.prepare('SELECT created_at FROM legacy_import_meta WHERE id = 1').get().created_at);
    const readSidecar = db.prepare('SELECT source_sha256 FROM legacy_import_chat WHERE chat_id = ?');
    for (const [index, file] of plan.files.entries()) {
      const done = readSidecar.get(file.chatId);
      if (done) {
        if (done.source_sha256 !== file.sha256) refuse('staging_partial_mismatch', 'Committed chat was imported from different source bytes', { chatId: file.chatId });
        resumed += 1;
        continue;
      }
      const source = readLegacyHistoryFile(path.join(legacyDir, file.file), { expectedChatId: file.chatId, maxFileBytes: options.maxFileBytes });
      if (source.sha256 !== file.sha256) refuse('source_changed_since_plan', 'A legacy file changed while importing', { file: file.file });
      db.exec('BEGIN IMMEDIATE');
      try {
        insertLegacyChat(db, source, plan.datasetGeneration, importedAtMs);
        hook('chat-before-commit', { index, chatId: file.chatId });
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw error;
      }
      hook('chat-committed', { index, chatId: file.chatId });
    }
    hook('before-verify', {});
    assertDatabaseIntegrity(db);
    compareStoreToSource(db, plan, legacyDir);
    db.prepare('UPDATE legacy_import_meta SET completed_at = ? WHERE id = 1').run(now());
    runWalTruncateBarrier(db);
    // Staging is a published artifact: no clean-shutdown marker.
    handle.close({ clean: false });
  } catch (error) {
    try { handle.close(); } catch { /* the original failure matters */ }
    throw error;
  }
  hook('before-manifest', {});
  const finalDb = openImmutableDatabase(path.join(partial, DEFAULT_STORAGE_DB_FILENAME));
  let schemaVersion;
  try {
    schemaVersion = Number(finalDb.prepare('PRAGMA user_version').get().user_version);
  } finally {
    finalDb.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    const leftover = lstatOrNull(path.join(partial, DEFAULT_STORAGE_DB_FILENAME + suffix));
    if (leftover && leftover.size > 0) refuse('staging_wal_remaining', 'Staging store still has a WAL after close; it is not a self-contained artifact');
  }
  const manifest = buildManifest({
    plan, stagingDir: partial, schemaVersion, createdAt: new Date(now()).toISOString(),
    runtime: { node: process.versions.node, sqlite: process.versions.sqlite },
    validation: { integrityCheck: 'ok', foreignKeyCheck: 'ok', logicalCompare: 'ok', chatsCompared: plan.files.length, eventsCompared: plan.totals.events, resumedChats: resumed },
  });
  replaceOwnFileDurable(path.join(partial, IMPORT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  // The sources must still be what the plan hashed; otherwise the staged copy is stale.
  for (const file of plan.files) {
    if (hashFile(path.join(legacyDir, file.file)).sha256 !== file.sha256) refuse('source_changed_since_plan', 'A legacy file changed before publication', { file: file.file });
  }
  hook('before-publish', {});
  fs.rmSync(path.join(partial, PARTIAL_MARKER_FILE));
  fsyncDirectory(partial);
  publishDirectory(partial, output);
  return { manifest, output, resumedChats: resumed };
}

/**
 * Re-verify a published staging directory against its manifest and, when given,
 * the legacy source: manifest hash, database hash, integrity, foreign keys and
 * per-chat logical equality. Read-only everywhere.
 *
 * @param {{ stagingDir: string, legacyDir?: string }} options
 */
export function verifyImportStaging(options) {
  const stagingDir = assertRealDirectory(options.stagingDir, 'Staging directory');
  if (lstatOrNull(path.join(stagingDir, PARTIAL_MARKER_FILE))) refuse('staging_incomplete', 'Directory still carries the incomplete-import marker');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stagingDir, IMPORT_MANIFEST_FILE), 'utf8'));
  } catch {
    return refuse('manifest_invalid', 'Manifest is missing or not valid JSON');
  }
  const { manifestHash, ...body } = manifest;
  if (manifest.schema !== IMPORT_MANIFEST_SCHEMA || digestCanonical(body) !== manifestHash) refuse('manifest_hash_mismatch', 'Manifest content does not match its hash');
  const dbPath = path.join(stagingDir, manifest.db.file);
  for (const suffix of ['-wal', '-shm']) {
    if (lstatOrNull(dbPath + suffix)) refuse('staging_wal_remaining', 'Staging store has WAL/SHM files; verify a cleanly closed store');
  }
  const dbFile = hashFile(dbPath);
  if (dbFile.sha256 !== manifest.db.sha256 || dbFile.bytes !== manifest.db.bytes) refuse('db_hash_mismatch', 'Staging database differs from the manifest');
  const db = openImmutableDatabase(dbPath);
  try {
    assertDatabaseIntegrity(db);
    let sourceChecked = 0;
    for (const chat of manifest.chats) {
      const storedLast = db.prepare('SELECT max(seq) AS last_seq FROM chat_history_events WHERE chat_id = ?').get(chat.chatId);
      if ((storedLast?.last_seq ?? null) !== (chat.lastSeq ?? null)) {
        refuse('verify_last_seq_mismatch', 'Store last seq differs from the manifest', { chatId: chat.chatId });
      }
      const stored = readChatAsLegacy(db, chat.chatId);
      if (!stored || !stored.unchangedSinceImport || digestStoredChat(stored) !== chat.contentDigest) {
        refuse('verify_content_mismatch', 'Store content differs from the manifest digest', { chatId: chat.chatId });
      }
      if (options.legacyDir) {
        const legacyDir = assertRealDirectory(options.legacyDir, 'Legacy history directory');
        const source = readLegacyHistoryFile(path.join(legacyDir, chat.sourceFile), { expectedChatId: chat.chatId });
        if (source.sha256 !== chat.sourceSha256 || digestLegacyDocument(source.doc) !== chat.contentDigest) {
          refuse('source_changed_since_plan', 'Legacy file differs from the one that was imported', { chatId: chat.chatId });
        }
        sourceChecked += 1;
      }
    }
    return { ok: true, manifestHash, chats: manifest.chats.length, sourceChecked };
  } finally {
    db.close();
  }
}

