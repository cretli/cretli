/**
 * Chat history schema v4: document metadata of the legacy history file that the
 * event tables of v3 cannot express (stage 2a of the history migration;
 * docs/storage-history-migration.md, contract C-3).
 *
 * - `chat_history_meta`: per chat `cursorSessionId`, unknown document keys
 *   (`doc_extra_json`), the preserved original `updatedAt` string
 *   (`updated_at_raw`, cleared by the first write after it was set) and a
 *   deletion tombstone (`deleted_at`).
 * - `chat_history_event_extra`: unknown keys of a legacy event outside `rec`.
 *
 * Forward-only. A v3 store written by the offline import tool carries the
 * import-owned sidecar tables (`legacy_import_*`); this migration folds their
 * metadata into the new tables, leaves the sidecar as an immutable provenance
 * record and refuses (typed `corrupt`) a PARTIAL sidecar set instead of
 * guessing which metadata was lost. A store with no sidecar table at all
 * (never imported) is valid and gets default metadata rows for its chats.
 */
import { StorageError, STORAGE_ERROR_CODES } from '../errors.js';

export const SIDECAR_TABLES = Object.freeze(['legacy_import_meta', 'legacy_import_chat', 'legacy_import_event_extra']);
const SIDECAR_CHAT_REQUIRED_COLUMNS = Object.freeze([
  'cursor_session_id', 'updated_at_raw', 'doc_extra_json', 'import_revision', 'import_next_seq', 'import_dataset_generation', 'import_chat_epoch',
]);

const DDL = `
CREATE TABLE chat_history_meta (
  chat_id TEXT PRIMARY KEY REFERENCES chat_history_state (chat_id),
  cursor_session_id TEXT NOT NULL DEFAULT '',
  doc_extra_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(doc_extra_json)),
  updated_at_raw TEXT,
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_history_event_extra (
  chat_id TEXT NOT NULL REFERENCES chat_history_state (chat_id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  extra_json TEXT NOT NULL CHECK (json_valid(extra_json)),
  PRIMARY KEY (chat_id, seq)
) STRICT, WITHOUT ROWID;

INSERT INTO chat_history_meta (chat_id) SELECT chat_id FROM chat_history_state;
`;

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function corrupt(kind, details = {}) {
  throw new StorageError(STORAGE_ERROR_CODES.CORRUPT, `History metadata migration refused: ${kind}`, {
    details: { operation: 'migrate', conflictKind: kind, ...details },
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {void}
 */
function foldSidecar(db) {
  const present = db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${SIDECAR_TABLES.map(() => '?').join(', ')})`)
    .all(...SIDECAR_TABLES).map((row) => String(row.name));
  if (present.length === 0) return;
  if (present.length !== SIDECAR_TABLES.length) {
    corrupt('history_sidecar_partial', { present: present.length, expected: SIDECAR_TABLES.length });
  }
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('legacy_import_chat')").all().map((row) => String(row.name)));
  if (!SIDECAR_CHAT_REQUIRED_COLUMNS.every((name) => columns.has(name))) corrupt('history_sidecar_format');
  db.exec(`
UPDATE chat_history_meta SET
  cursor_session_id = (SELECT i.cursor_session_id FROM legacy_import_chat i WHERE i.chat_id = chat_history_meta.chat_id),
  doc_extra_json = (SELECT i.doc_extra_json FROM legacy_import_chat i WHERE i.chat_id = chat_history_meta.chat_id),
  updated_at_raw = (SELECT CASE WHEN s.revision = i.import_revision AND s.next_seq = i.import_next_seq
      AND s.dataset_generation = i.import_dataset_generation AND s.chat_epoch = i.import_chat_epoch THEN i.updated_at_raw END
    FROM legacy_import_chat i JOIN chat_history_state s ON s.chat_id = i.chat_id WHERE i.chat_id = chat_history_meta.chat_id)
WHERE chat_id IN (SELECT chat_id FROM legacy_import_chat);

INSERT INTO chat_history_event_extra (chat_id, seq, extra_json)
SELECT x.chat_id, x.seq, x.extra_json FROM legacy_import_event_extra x
WHERE x.chat_id IN (SELECT chat_id FROM chat_history_state);
`);
  const orphan = Number(db.prepare(`SELECT count(*) AS n FROM legacy_import_event_extra x
    WHERE x.chat_id NOT IN (SELECT chat_id FROM chat_history_state)`).get().n);
  if (orphan > 0) corrupt('history_sidecar_orphan', { orphan });
}

export default Object.freeze({
  version: 4,
  name: 'chat-history-metadata',
  up(db) {
    // The sidecar check runs before any DDL so a refused upgrade leaves nothing behind (the runner also rolls back).
    const present = db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN (${SIDECAR_TABLES.map(() => '?').join(', ')})`)
      .get(...SIDECAR_TABLES);
    if (Number(present.n) !== 0 && Number(present.n) !== SIDECAR_TABLES.length) {
      corrupt('history_sidecar_partial', { present: Number(present.n), expected: SIDECAR_TABLES.length });
    }
    db.exec(DDL);
    foldSidecar(db);
  },
});
