/**
 * Schema v7: todos domain of the storage worker (ADR docs/storage-todos-worker-decision.md, sections 2 and 3).
 *
 * - `todo_docs`: one row per workspace key (the per-workspace document): format version,
 *   document `updatedAt`, the idempotency map and unknown top-level fields.
 * - `todos`: one row per item, keyed `(workspace_key, id)`. Indexed light fields live in
 *   columns; `body`, `plan`, `changelog` and `review` are JSON text fetched only by detail
 *   reads. Every other field of the item (unknown ones included) is kept in `extra_json`
 *   and the original top-level key order in `key_order_json`, so a logical export
 *   reproduces the item exactly. `position` keeps the item order of the document (gaps are allowed; order is `position, id`).
 */
export default Object.freeze({
  version: 7,
  name: 'todos',
  sql: `
CREATE TABLE todo_docs (
  workspace_key TEXT PRIMARY KEY CHECK (length(trim(workspace_key)) > 0),
  doc_version INTEGER NOT NULL CHECK (doc_version >= 0),
  updated_at TEXT NOT NULL DEFAULT '',
  idempotency_json TEXT NOT NULL DEFAULT '{}',
  extra_json TEXT NOT NULL DEFAULT '{}'
) STRICT, WITHOUT ROWID;

CREATE TABLE todos (
  workspace_key TEXT NOT NULL REFERENCES todo_docs (workspace_key) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  parent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  sibling_index INTEGER,
  updated_at TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body_preview TEXT NOT NULL DEFAULT '',
  body_json TEXT,
  plan_json TEXT,
  changelog_json TEXT,
  review_json TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  key_order_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (workspace_key, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX todos_by_parent ON todos (workspace_key, parent_id, sibling_index, id);
CREATE INDEX todos_by_status ON todos (workspace_key, status, updated_at, id);
CREATE INDEX todos_by_updated ON todos (workspace_key, updated_at, id);
CREATE INDEX todos_by_position ON todos (workspace_key, position);
`,
});
