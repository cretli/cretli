/**
 * Chat history schema v6: durable staging of fragmented large records.
 *
 * A record above the regular 256 KiB cap (up to HISTORY_MAX_LARGE_RECORD_BYTES) is
 * transported as bounded fragments (one command each) and becomes an event only when
 * a single receipt-wrapped `appendEvents` command finalizes it. These two tables hold
 * the fragments in between:
 *
 * - `chat_history_stage`: one header per staged record, keyed by the same
 *   (generation, chat, producer, clientSeq) identity the dedupe ledger uses, plus the
 *   epoch it was staged under, the declared byte length/fragment count and the
 *   SHA-256 of the whole wire JSON. The header reserves quota (declared bytes).
 * - `chat_history_stage_fragment`: the fragment bytes (BLOB, one row per index).
 *
 * Nothing here is history: readers, rollback export and counts never look at these
 * tables. Rows disappear in the finalizing transaction, on reset/delete/fork of the
 * chat, or through the fenced `gcStaging` command. Forward-only; no data is moved.
 */
const MAX_ID_LENGTH = 200;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export default Object.freeze({
  version: 6,
  name: 'history-large-staging',
  sql: `
CREATE TABLE chat_history_stage (
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  chat_id TEXT NOT NULL
    CHECK (length(trim(chat_id)) > 0 AND length(chat_id) <= ${MAX_ID_LENGTH}),
  producer_id TEXT NOT NULL
    CHECK (length(trim(producer_id)) > 0 AND length(producer_id) <= ${MAX_ID_LENGTH}),
  client_seq INTEGER NOT NULL CHECK (client_seq BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  fragment_count INTEGER NOT NULL CHECK (fragment_count BETWEEN 1 AND 4096),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (dataset_generation, chat_id, producer_id, client_seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX chat_history_stage_chat ON chat_history_stage (chat_id);

CREATE TABLE chat_history_stage_fragment (
  dataset_generation TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  idx INTEGER NOT NULL CHECK (idx BETWEEN 0 AND 4095),
  data BLOB NOT NULL,
  PRIMARY KEY (dataset_generation, chat_id, producer_id, client_seq, idx),
  FOREIGN KEY (dataset_generation, chat_id, producer_id, client_seq)
    REFERENCES chat_history_stage (dataset_generation, chat_id, producer_id, client_seq) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
`,
});
