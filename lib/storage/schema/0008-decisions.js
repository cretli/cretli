/**
 * Schema v8: decision cards domain of the storage worker (docs/decision-cards.md).
 *
 * - `decisions`: one row per card. Indexed fields live in columns; the full card is `doc_json`
 *   (the worker never interprets it beyond the fields below). `seq` keeps creation order.
 * - `decision_meta`: singleton row holding the store revision, bumped by every committed change so
 *   `decisionsChanged` can carry a monotonic number.
 */
export default Object.freeze({
  version: 8,
  name: 'decisions',
  sql: `
CREATE TABLE decisions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  workspace_key TEXT NOT NULL CHECK (length(trim(workspace_key)) > 0),
  dedupe_key TEXT NOT NULL CHECK (length(trim(dedupe_key)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'deciding', 'decided', 'stale', 'expired')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  subject_updated_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json))
) STRICT, WITHOUT ROWID;

CREATE INDEX decisions_by_workspace ON decisions (workspace_key, status, seq);
CREATE INDEX decisions_by_dedupe ON decisions (dedupe_key, status);

CREATE TABLE decision_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;

INSERT INTO decision_meta (id, revision) VALUES (1, 0);
`,
});
