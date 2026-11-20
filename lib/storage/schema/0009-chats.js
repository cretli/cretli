/**
 * Schema v9: chats domain of the storage worker (ADR docs/storage-chats-metadata-decision.md, sections 3 and 6).
 * Opened only through the `chats.sqlite` store file on the CORE line; every store file gets the empty tables.
 *
 * - `chats`: one row per chat. Indexed and list-visible fields live in columns, the small list-visible
 *   remainder in `light_json`. `position` keeps the legacy array order (gaps allowed, order is `position, id`).
 *   `workspace_*_key` are `path.resolve(trim(value))` of the raw fields (`''` when empty), the same rule as
 *   `matchesWorkspaceScope`; the raw values stay in `workspace_folder` / `workspace_file` for the widget scope.
 * - `chat_details`: heavy and unknown fields (`extra_json`) plus the original top-level key order, in their own
 *   table so a title change or a read mark never rewrites them.
 * - `chat_scope_counts`: counters maintained in the same transaction as every chat mutation. One bucket per
 *   (raw file, raw folder, archived flag); every chat contributes to exactly one bucket. They serve `counts`
 *   and `archivedCountsByWorkspace` without any index on `chats`.
 * - `chat_store_meta`: singleton with the format version, the monotonic `store_revision`, `row_count` and the
 *   `next_position` allocator (so appending never scans `chats`).
 *
 * List indexes come as live/archived partial pairs (a row is in at most 4 of them). Relation indexes follow.
 * The file index carries `workspace_folder_key = ''` so the file-only rule (which ignores the chat folder) and
 * the folder-then-file rule are both served by bounded ranges.
 */
export default Object.freeze({
  version: 9,
  name: 'chats',
  sql: `
CREATE TABLE chats (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0 AND length(id) <= 512),
  position INTEGER NOT NULL CHECK (position >= 0),
  workspace_folder_key TEXT NOT NULL DEFAULT '',
  workspace_file_key TEXT NOT NULL DEFAULT '',
  workspace_folder TEXT NOT NULL DEFAULT '',
  workspace_file TEXT NOT NULL DEFAULT '',
  widget_installation_id TEXT NOT NULL DEFAULT '',
  widget_page_session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  todo_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  agent_transport TEXT NOT NULL DEFAULT '',
  cursor_session_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK (revision >= 1),
  light_json TEXT NOT NULL DEFAULT '{}'
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_details (
  chat_id TEXT PRIMARY KEY CHECK (length(trim(chat_id)) > 0 AND length(chat_id) <= 512),
  extra_json TEXT NOT NULL DEFAULT '{}',
  key_order_json TEXT NOT NULL DEFAULT '[]'
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_scope_counts (
  workspace_file TEXT NOT NULL,
  workspace_folder TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  workspace_file_key TEXT NOT NULL,
  workspace_folder_key TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  root_count INTEGER NOT NULL CHECK (root_count >= 0 AND root_count <= count),
  PRIMARY KEY (workspace_file, workspace_folder, archived)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_store_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  store_revision INTEGER NOT NULL CHECK (store_revision >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  next_position INTEGER NOT NULL CHECK (next_position >= 0)
) STRICT;

INSERT INTO chat_store_meta (id, format_version, store_revision, row_count, next_position) VALUES (1, 1, 0, 0, 0);

CREATE INDEX chats_global_live ON chats (last_activity_at DESC, id DESC) WHERE archived_at = '';
CREATE INDEX chats_global_archived ON chats (last_activity_at DESC, id DESC) WHERE archived_at <> '';
CREATE INDEX chats_folder_live ON chats (workspace_folder_key, last_activity_at DESC, id DESC)
  WHERE archived_at = '' AND workspace_folder_key <> '';
CREATE INDEX chats_folder_archived ON chats (workspace_folder_key, last_activity_at DESC, id DESC)
  WHERE archived_at <> '' AND workspace_folder_key <> '';
CREATE INDEX chats_file_live ON chats (workspace_file_key, (workspace_folder_key = ''), last_activity_at DESC, id DESC)
  WHERE archived_at = '' AND workspace_file_key <> '';
CREATE INDEX chats_file_archived ON chats (workspace_file_key, (workspace_folder_key = ''), last_activity_at DESC, id DESC)
  WHERE archived_at <> '' AND workspace_file_key <> '';
CREATE INDEX chats_widget_live ON chats (widget_installation_id, widget_page_session_id, last_activity_at DESC, id DESC)
  WHERE archived_at = '' AND widget_installation_id <> '';
CREATE INDEX chats_widget_archived ON chats (widget_installation_id, widget_page_session_id, last_activity_at DESC, id DESC)
  WHERE archived_at <> '' AND widget_installation_id <> '';
CREATE INDEX chats_by_parent ON chats (parent_id, id);
CREATE INDEX chats_by_todo ON chats (todo_id) WHERE todo_id <> '';
CREATE INDEX chats_by_cursor_session ON chats (cursor_session_id) WHERE cursor_session_id <> '';
`,
});
