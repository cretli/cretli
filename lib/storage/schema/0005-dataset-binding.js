/**
 * Schema v5: immutable dataset binding of the store file (stage 2a r2).
 *
 * One singleton row `storage_dataset_binding` records WHICH dataset generation
 * this file belongs to. The history runtime compares it with the control
 * marker before a store is ever READY, so a wrong, replaced or freshly created
 * empty file can never pass for the dataset the marker selected. The row can be
 * inserted once; an UPDATE or DELETE is refused by trigger.
 *
 * Upgrading an existing v3/v4 store infers the binding from its own data
 * (the import sidecar, else the single generation its chats use). Zero or
 * several generations leave the store UNBOUND: the runtime refuses it until an
 * operator binds it explicitly (`bindDatasetGeneration`, offline bootstrap).
 */
/** Matches the receipt alphabet limit of a dataset generation. */
const MAX_ID_LENGTH_FOR_BINDING = 128;

const DDL = `
CREATE TABLE storage_dataset_binding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH_FOR_BINDING}),
  bound_at INTEGER NOT NULL CHECK (bound_at >= 0)
) STRICT;

CREATE TRIGGER storage_dataset_binding_no_update BEFORE UPDATE ON storage_dataset_binding
BEGIN SELECT RAISE(ABORT, 'storage_dataset_binding is immutable'); END;

CREATE TRIGGER storage_dataset_binding_no_delete BEFORE DELETE ON storage_dataset_binding
BEGIN SELECT RAISE(ABORT, 'storage_dataset_binding is immutable'); END;
`;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null} the single generation the store's own data proves, or null
 */
function inferGeneration(db) {
  const has = (name) => Boolean(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
  if (has('legacy_import_meta')) {
    const rows = db.prepare('SELECT dataset_generation AS g FROM legacy_import_meta').all();
    if (rows.length === 1) return String(rows[0].g);
  }
  if (!has('chat_history_state')) return null;
  const rows = db.prepare('SELECT DISTINCT dataset_generation AS g FROM chat_history_state').all();
  return rows.length === 1 ? String(rows[0].g) : null;
}

export default Object.freeze({
  version: 5,
  name: 'dataset-binding',
  up(db) {
    db.exec(DDL);
    const generation = inferGeneration(db);
    if (generation !== null && generation.trim() !== '' && generation.length <= MAX_ID_LENGTH_FOR_BINDING) {
      db.prepare('INSERT INTO storage_dataset_binding (id, dataset_generation, bound_at) VALUES (1, ?, ?)').run(generation, Date.now());
    }
  },
});
