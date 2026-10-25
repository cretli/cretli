/**
 * Core schema v1 of the consolidated store (A2).
 *
 * Only infrastructure tables live here. Chat, history and metadata tables are
 * added by their own domain migrations (A3a/A3b).
 *
 * `command_receipts` persists `(datasetGeneration, commandId, requestDigest,
 * result)` per docs/storage-contract.md "History operations and
 * acknowledgements". The primary key makes a commandId unique within one
 * dataset generation, so a second insert for the same command (with the same
 * or a different digest) is rejected by the database; the receipt API (S4)
 * returns the committed result for a matching digest and `conflict` otherwise.
 * Tables are STRICT so column types are enforced, not just declared.
 */

/** Upper bound for identity/digest text columns; generous but finite. */
const MAX_ID_LENGTH = 200;

/**
 * `PRAGMA application_id` brand ("CRET" as a big-endian int32). Opening a file
 * that carries another non-zero application_id is refused with `conflict`.
 * The pragma writes the file header inside the migration transaction.
 */
export const STORAGE_APPLICATION_ID = 0x43524554;

export default Object.freeze({
  version: 1,
  name: 'core',
  sql: `
PRAGMA application_id = ${STORAGE_APPLICATION_ID};

CREATE TABLE command_receipts (
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  command_id TEXT NOT NULL
    CHECK (length(trim(command_id)) > 0 AND length(command_id) <= ${MAX_ID_LENGTH}),
  request_digest TEXT NOT NULL
    CHECK (length(trim(request_digest)) > 0 AND length(request_digest) <= ${MAX_ID_LENGTH}),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (dataset_generation, command_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX command_receipts_created_at ON command_receipts (dataset_generation, created_at);
`,
});
