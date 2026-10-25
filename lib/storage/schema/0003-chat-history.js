/**
 * Chat history schema v3 (A3a pilot library).
 *
 * State identifies the current generation/epoch of a chat. Historical producer
 * and input identities deliberately reference only the stable chat row: resets
 * retain them while event retention is free to remove displayed history.
 */

const MAX_ID_LENGTH = 200;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export default Object.freeze({
  version: 3,
  name: 'chat-history',
  sql: `
CREATE TABLE chat_history_state (
  chat_id TEXT PRIMARY KEY
    CHECK (length(trim(chat_id)) > 0 AND length(chat_id) <= ${MAX_ID_LENGTH}),
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  next_seq INTEGER NOT NULL CHECK (next_seq BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  retention_limit INTEGER NOT NULL CHECK (retention_limit BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  trimmed_through_seq INTEGER NOT NULL CHECK (trimmed_through_seq BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_history_epochs (
  chat_id TEXT NOT NULL REFERENCES chat_history_state (chat_id),
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (chat_id, dataset_generation, chat_epoch)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_history_producers (
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  chat_id TEXT NOT NULL REFERENCES chat_history_state (chat_id),
  producer_id TEXT NOT NULL
    CHECK (length(trim(producer_id)) > 0 AND length(producer_id) <= ${MAX_ID_LENGTH}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'fenced')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= 0),
  PRIMARY KEY (dataset_generation, chat_id, producer_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_history_events (
  dataset_generation TEXT NOT NULL
    CHECK (length(trim(dataset_generation)) > 0 AND length(dataset_generation) <= ${MAX_ID_LENGTH}),
  chat_id TEXT NOT NULL REFERENCES chat_history_state (chat_id),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  producer_id TEXT NOT NULL
    CHECK (length(trim(producer_id)) > 0 AND length(producer_id) <= ${MAX_ID_LENGTH}),
  client_seq INTEGER NOT NULL CHECK (client_seq BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0 AND length(kind) <= ${MAX_ID_LENGTH}),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  PRIMARY KEY (dataset_generation, chat_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX chat_history_events_chat_seq ON chat_history_events (chat_id, seq);

CREATE TABLE chat_history_dedupe (
  dataset_generation TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL CHECK (client_seq BETWEEN 0 AND ${MAX_SAFE_INTEGER}),
  chat_epoch TEXT NOT NULL
    CHECK (length(trim(chat_epoch)) > 0 AND length(chat_epoch) <= ${MAX_ID_LENGTH}),
  event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
  request_digest TEXT NOT NULL
    CHECK (length(trim(request_digest)) > 0 AND length(request_digest) <= ${MAX_ID_LENGTH}),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (dataset_generation, chat_id, producer_id, client_seq),
  FOREIGN KEY (dataset_generation, chat_id, producer_id)
    REFERENCES chat_history_producers (dataset_generation, chat_id, producer_id)
) STRICT, WITHOUT ROWID;
`,
});
