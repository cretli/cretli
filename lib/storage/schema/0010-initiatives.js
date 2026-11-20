/**
 * Schema v10: development-plan initiatives domain (docs/development-plans.md).
 *
 * - `initiatives`: current projection of one initiative; `doc_json` is the full record, indexed fields live in columns.
 * - `initiative_events`: append-only journal (one row per committed change, with the actor and a bounded payload).
 * - `initiative_relations`: typed edges between initiatives of one workspace (`alternative_to` is stored once, from < to).
 * - `initiative_links`: typed many-to-many references to Todo / Decision / research / Git outcomes (a minimal snapshot only).
 * - `initiative_research`: versioned research entries; an edit appends a new version, the old one stays.
 * - `initiative_todo_intents`: durable create-Todo-from-initiative operations (operation id + payload digest).
 * - `initiative_create_keys`: create idempotency (key + payload digest).
 * - `initiative_workspace_meta`: per-workspace revision used by keyset cursors.
 * - `initiative_meta`: singleton store revision.
 * Keys are workspace UUIDs (resolveWorkspaceRef(...).uuid), never legacy registry ids.
 */
export default Object.freeze({
  version: 10,
  name: 'initiatives',
  sql: `
CREATE TABLE initiatives (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  workspace_uuid TEXT NOT NULL CHECK (length(trim(workspace_uuid)) > 0),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  horizon TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  archived_at TEXT NOT NULL DEFAULT '',
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX initiatives_by_seq ON initiatives (seq);
CREATE INDEX initiatives_by_workspace ON initiatives (workspace_uuid, seq);

CREATE TABLE initiative_events (
  seq INTEGER PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  initiative_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (length(trim(type)) > 0),
  actor TEXT NOT NULL,
  revision INTEGER NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;
CREATE INDEX initiative_events_by_initiative ON initiative_events (initiative_id, seq);

CREATE TABLE initiative_relations (
  id TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('contributes_to', 'requires', 'supports', 'alternative_to')),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (from_id <> to_id),
  UNIQUE (type, from_id, to_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX initiative_relations_by_workspace ON initiative_relations (workspace_uuid, type);

CREATE TABLE initiative_links (
  id TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  initiative_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('todo', 'decision', 'research', 'git')),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE (initiative_id, kind, target_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE initiative_research (
  id TEXT PRIMARY KEY,
  workspace_uuid TEXT NOT NULL,
  initiative_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  seq INTEGER NOT NULL,
  doc_json TEXT NOT NULL CHECK (json_valid(doc_json)),
  UNIQUE (lineage_id, version)
) STRICT, WITHOUT ROWID;
CREATE INDEX initiative_research_by_initiative ON initiative_research (initiative_id, seq);

CREATE TABLE initiative_todo_intents (
  workspace_uuid TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
  initiative_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'created')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  todo_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_uuid, operation_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE initiative_create_keys (
  workspace_uuid TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  initiative_id TEXT NOT NULL,
  PRIMARY KEY (workspace_uuid, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE initiative_workspace_meta (
  workspace_uuid TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE initiative_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0)
) STRICT;
INSERT INTO initiative_meta (id, revision) VALUES (1, 0);
`,
});
