# Todo archive and capacity management (design proposal)

Status: **proposal, needs human plan approval**. Supersedes the hard `TODOS_MAX_ITEMS = 2000`
cap in `lib/persist/todos-persist.js`.

## Problem

- The cap counts every todo, including finished ones. A long-lived workspace reaches it
  (about 1500 of 2000 items are `done`) and `todo_create` fails with `Limit of 2000 items reached`.
- Raising the cap does not help: document size is dominated by a few heavy fields
  (`leafMaterial` reaches ~370 KB per item; the whole document is ~30 MB), not by item count.
- There is no way to see what occupies the space or to free it in bulk.

## Design

1. **Archive tier.** A todo (or a whole finished subtree) can be archived. The active list keeps
   a light index row (`id`, `title`, `status`, `parentId`, `updatedAt`, `review` summary,
   `archivedAt`); heavy fields (`body`, `plan`, `changelog`, `leafMaterial`, `activity`) are
   loaded only on demand. Archiving is reversible (`restore`). Links by id (`cretli-ref`,
   `source_todo_id`, `linkedChatIds`) keep resolving.
2. **Cap applies to active items only.** Archived rows do not count. Near the cap the server warns
   and, if enabled, auto-archives per retention policy instead of failing.
3. **Retention policy** (Settings, per workspace): archive `done` subtrees older than N days;
   optional cap on heavy-field size per item (keep a checkpoint reference instead of full material).
4. **Management API / UI / MCP.** Server-side filters (status, review, harness, date range, text,
   subtree, archived on/off), a size/usage summary (counts and bytes per status, top-N heaviest),
   bulk actions (archive, restore, defer, delete), an Archive view. MCP: `todo_archive`,
   `todo_restore`, extra `todo_list` filters, usage in `todo_list` meta.
5. **Storage.** Implement in the SQLite todos backend (`docs/storage-todos-worker-decision.md`):
   a nullable `archived_at` column with an index, and heavy fields in separate columns fetched by
   id. Provide a JSON-backend equivalent only if the cutover is far away.

## Open prerequisite

The SQLite todos backend is implemented but **not cut over** (see
`docs/storage-todos-cutover-runbook.md`: the server does not yet call the todos runtime factory).
Decide whether the archive ships together with the cutover or on the JSON backend first.

## Acceptance sketch

- Creating a todo succeeds with 2000+ total rows when most are archived.
- Archive and restore round-trip preserves every field and all id links.
- Listing 2000 active rows never reads heavy fields.
- Usage summary matches the stored sizes; filters are covered by tests.
