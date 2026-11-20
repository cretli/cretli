/**
 * Import-owned provenance tables and the store -> legacy document mapping
 * shared by the import verifier and the rollback export.
 *
 * Metadata (C-3, resolved in stage 2a): the legacy document's `cursorSessionId`,
 * unknown document keys, original `updatedAt` string and unknown event keys live
 * in the schema-v4 tables `chat_history_meta` / `chat_history_event_extra`
 * (schema/0004-chat-history-metadata.js), which the store's own commands
 * maintain after the import. The `legacy_import_*` tables stay what they were
 * in sidecar v2: an immutable record of how a chat was imported (source hash,
 * import-time revision markers, content digest), created by the offline tool
 * with `IF NOT EXISTS` and not part of `CORE_MIGRATIONS`. They are all-or-none:
 * one or two of the three present is a damaged sidecar and fails closed.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './command-receipts.js';
import {
  HistoryMigrationError, LEGACY_IMPORT_PRODUCER_ID, digestLegacyDocument, refuse,
} from './history-legacy-format.js';

/** Bumped whenever the legacy -> store mapping changes (invalidates plan hashes). */
export const HISTORY_IMPORT_FORMAT_VERSION = 2;

const SIDECAR_DDL = `
CREATE TABLE IF NOT EXISTS legacy_import_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  dataset_generation TEXT NOT NULL,
  chat_epoch TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS legacy_import_chat (
  chat_id TEXT PRIMARY KEY REFERENCES chat_history_state (chat_id),
  source_sha256 TEXT NOT NULL,
  source_bytes INTEGER NOT NULL,
  cursor_session_id TEXT NOT NULL,
  updated_at_raw TEXT NOT NULL,
  import_state_updated_at INTEGER NOT NULL,
  import_revision INTEGER NOT NULL,
  import_next_seq INTEGER NOT NULL,
  import_dataset_generation TEXT NOT NULL,
  import_chat_epoch TEXT NOT NULL,
  doc_extra_json TEXT NOT NULL CHECK (json_valid(doc_extra_json)),
  event_count INTEGER NOT NULL,
  head_seq INTEGER NOT NULL,
  content_digest TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS legacy_import_event_extra (
  chat_id TEXT NOT NULL REFERENCES chat_history_state (chat_id),
  seq INTEGER NOT NULL,
  extra_json TEXT NOT NULL CHECK (json_valid(extra_json)),
  PRIMARY KEY (chat_id, seq)
) STRICT, WITHOUT ROWID;
`;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function ensureSidecarTables(db) {
  // One transaction: a crash must not leave a partial table set that a later run would silently complete.
  const nested = db.isTransaction;
  if (!nested) db.exec('BEGIN IMMEDIATE');
  try {
    classifySidecar(db);
    db.exec(SIDECAR_DDL);
    if (!nested) db.exec('COMMIT');
  } catch (error) {
    if (!nested) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    }
    throw error;
  }
  assertSidecarCurrent(db);
}

const SIDECAR_TABLE_NAMES = Object.freeze(['legacy_import_meta', 'legacy_import_chat', 'legacy_import_event_extra']);

/**
 * Classify the import sidecar of an open store. A store that was never
 * imported has none of the tables (valid); an imported one has all three. One
 * or two of three means a table was dropped or never created: the lost
 * metadata cannot be told from "no metadata", so this refuses
 * (`sidecar_partial`) rather than exporting a chat without its provenance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {'none' | 'complete'}
 */
export function classifySidecar(db) {
  const row = db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN (${SIDECAR_TABLE_NAMES.map(() => '?').join(', ')})`).get(...SIDECAR_TABLE_NAMES);
  const present = Number(row?.n);
  if (present === 0) return 'none';
  if (present === SIDECAR_TABLE_NAMES.length) return 'complete';
  return refuse('sidecar_partial', 'Import sidecar tables are partially present; metadata may have been lost', { present, expected: SIDECAR_TABLE_NAMES.length });
}

const CHAT_TABLE_REQUIRED_COLUMNS = Object.freeze(['import_revision', 'import_next_seq', 'import_dataset_generation', 'import_chat_epoch']);

/**
 * Fail closed on a sidecar written by another format version: `IF NOT EXISTS`
 * would otherwise keep an old table without the revision marker and the export
 * would have to guess whether a chat changed.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
export function assertSidecarCurrent(db) {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('legacy_import_chat')").all().map((row) => String(row.name)));
  if (!CHAT_TABLE_REQUIRED_COLUMNS.every((name) => columns.has(name))) {
    refuse('sidecar_format_unsupported', 'Import sidecar was written by another format version; re-import into a fresh directory');
  }
  const meta = db.prepare('SELECT format_version FROM legacy_import_meta WHERE id = 1').get();
  if (meta && Number(meta.format_version) !== HISTORY_IMPORT_FORMAT_VERSION) {
    refuse('sidecar_format_unsupported', 'Import sidecar format version is not the current one', { found: Number(meta.format_version) });
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean} false when the store was never imported
 * @throws {HistoryMigrationError} `sidecar_partial` for one or two of the three tables
 */
export function hasSidecarTables(db) {
  return classifySidecar(db) === 'complete';
}

/**
 * @param {unknown} value
 * @returns {number} epoch milliseconds, or 0 when it is not a usable timestamp
 */
export function parseTimestampMs(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/**
 * Read one chat out of the store as the legacy document it represents. Used for
 * the import round-trip proof and for the rollback export, so both prove the
 * same mapping.
 *
 * Mapping rules (see docs/storage-history-migration.md):
 * - `headSeq = next_seq - 1`, events = every retained row in seq order;
 * - rows of the import producer keep their record exactly (including an
 *   original `clientSeq`); rows of any other producer lose the store-added
 *   `clientSeq`, because producer-scoped counters collide as legacy-wide keys;
 * - `cursorSessionId`, the `updatedAt` string and unknown document / event keys
 *   come from the import sidecar; `updatedAt` is the preserved original while
 *   the chat has not been written since the import, an ISO time afterwards.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} chatId
 * @param {{ cursorSessionId?: string, maxBytes?: number }} [options]
 * @returns {{ doc: import('./history-legacy-format.js').LegacyHistoryDocument, state: Record<string, unknown>, imported: boolean, unchangedSinceImport: boolean } | null}
 */
export function readChatAsLegacy(db, chatId, options = {}) {
  const state = db.prepare('SELECT * FROM chat_history_state WHERE chat_id = ?').get(chatId);
  if (!state) return null;
  const hasSidecar = hasSidecarTables(db);
  if (hasSidecar) assertSidecarCurrent(db);
  const meta = db.prepare('SELECT * FROM chat_history_meta WHERE chat_id = ?').get(chatId);
  if (!meta) refuse('meta_missing', 'Chat has no metadata row; the store is damaged or older than schema v4', { chatId });
  // A deleted chat is a tombstone: the legacy file is gone, so it exports as nothing.
  if (meta.deleted_at !== null && meta.deleted_at !== undefined) return null;
  const importRow = hasSidecar ? db.prepare('SELECT * FROM legacy_import_chat WHERE chat_id = ?').get(chatId) : undefined;
  if (options.maxBytes !== undefined) {
    const sum = db.prepare(`SELECT coalesce(sum(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM chat_history_events
      WHERE dataset_generation = ? AND chat_id = ?`).get(state.dataset_generation, chatId);
    if (Number(sum.bytes) > options.maxBytes) {
      refuse('export_chat_too_large', 'Exported chat would exceed the legacy file ceiling', { bytes: Number(sum.bytes), maxBytes: options.maxBytes });
    }
  }
  /** @type {Map<number, Record<string, unknown>>} */
  const extras = new Map();
  for (const row of db.prepare('SELECT seq, extra_json FROM chat_history_event_extra WHERE chat_id = ?').iterate(chatId)) {
    extras.set(Number(row.seq), JSON.parse(String(row.extra_json)));
  }
  const events = [];
  for (const row of db.prepare(`SELECT seq, producer_id, payload_json FROM chat_history_events
    WHERE dataset_generation = ? AND chat_id = ? ORDER BY seq ASC`).iterate(state.dataset_generation, chatId)) {
    const rec = JSON.parse(String(row.payload_json));
    if (row.producer_id !== LEGACY_IMPORT_PRODUCER_ID) delete rec.clientSeq;
    events.push({ seq: Number(row.seq), rec, extra: extras.get(Number(row.seq)) ?? null });
  }
  // A durable marker of the imported state, never wall-clock time: any append, coalesce, trim or reset moves
  // revision / next_seq or replaces the dataset generation / chat epoch.
  const unchangedSinceImport = Boolean(importRow)
    && Number(state.revision) === Number(importRow.import_revision)
    && Number(state.next_seq) === Number(importRow.import_next_seq)
    && String(state.dataset_generation) === String(importRow.import_dataset_generation)
    && String(state.chat_epoch) === String(importRow.import_chat_epoch);
  // `updated_at_raw` is cleared by the first write after the import, so it is the original string exactly while the chat is untouched.
  const updatedAt = meta.updated_at_raw !== null && meta.updated_at_raw !== undefined
    ? String(meta.updated_at_raw) : new Date(Number(state.updated_at)).toISOString();
  const cursorSessionId = options.cursorSessionId ?? String(meta.cursor_session_id);
  return {
    doc: {
      chatId, cursorSessionId, headSeq: Number(state.next_seq) - 1, updatedAt,
      docExtra: JSON.parse(String(meta.doc_extra_json)),
      events, warnings: [],
    },
    state, imported: Boolean(importRow), unchangedSinceImport,
  };
}

/**
 * Digest of a chat's logical content as read from the store, comparable with
 * `digestLegacyDocument` of the legacy file it was imported from.
 *
 * @param {ReturnType<typeof readChatAsLegacy>} read
 * @returns {string}
 */
export function digestStoredChat(read) {
  if (!read) throw new HistoryMigrationError('internal_missing_chat', 'Chat is not in the store');
  return digestLegacyDocument(read.doc);
}

/**
 * @param {unknown} value
 * @returns {string} sha256 hex of the canonical JSON of `value`
 */
export function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
