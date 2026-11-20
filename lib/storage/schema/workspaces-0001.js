/**
 * Workspaces store schema v1 (`store.workspaces`, file `workspaces.sqlite`).
 *
 * Cretli owns the workspace definition: name, folders, order, enabled flags and
 * the default folder live here, not in a Cursor/VS Code `.code-workspace` file.
 * A `.code-workspace` file is an optional import source only; its path is kept as
 * `imported_from` metadata and is never read after the import.
 *
 * - `workspaces`: one row per registry entry. `id` is the stable UUID, `legacy_id`
 *   is the id the rest of the app still keys by (a `.code-workspace` path for
 *   migrated file entries, `cretli:ws:<uuid>` otherwise). Todos, chats and
 *   delegations stay keyed by the working directory (`default_folder`), not by this id.
 * - `workspace_aliases`: every id a workspace was ever addressed by (legacy ids,
 *   ids from before a convert), so route keys, saved chats and tools keep resolving.
 * - `workspace_folders`: ordered folder list per workspace with the enabled flag.
 * - `workspace_overlays`: sidebar entries that are not registry rows (clone rows).
 * - `workspace_route_keys`: durable view ids (workspace and folder route UUIDs).
 * - `workspace_store_meta`: key/value (migration marker, additionalCursorContextDirs).
 */
export default Object.freeze({
  version: 1,
  name: 'workspaces',
  sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  legacy_id TEXT NOT NULL UNIQUE CHECK (length(trim(legacy_id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folders')),
  name TEXT NOT NULL DEFAULT '',
  sidebar_label TEXT NOT NULL DEFAULT '',
  default_folder TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0, 1)),
  sidebar_workspace_file TEXT NOT NULL DEFAULT '',
  imported_from TEXT NOT NULL DEFAULT '',
  imported_at INTEGER NOT NULL DEFAULT 0 CHECK (imported_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX workspaces_imported_from ON workspaces (imported_from) WHERE imported_from != '';

CREATE TABLE workspace_aliases (
  alias TEXT PRIMARY KEY CHECK (length(trim(alias)) > 0),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX workspace_aliases_workspace ON workspace_aliases (workspace_id);

CREATE TABLE workspace_folders (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(trim(path)) > 0),
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  enabled_set INTEGER NOT NULL DEFAULT 1 CHECK (enabled_set IN (0, 1)),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'cursor', 'cretli')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  PRIMARY KEY (workspace_id, path)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_overlays (
  key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  json TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_route_keys (
  workspace_key TEXT NOT NULL CHECK (length(trim(workspace_key)) > 0),
  folder_path TEXT NOT NULL DEFAULT '',
  route_id TEXT NOT NULL CHECK (length(route_id) = 36),
  PRIMARY KEY (workspace_key, folder_path)
) STRICT, WITHOUT ROWID;

CREATE TABLE workspace_store_meta (
  key TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
`,
});
