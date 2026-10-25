# Conversation export and import (B3)

Status: implemented backend, HTTP API and tests; Settings UI is not part of this slice.
Contract: [archive profiles](archive-profiles.md), [storage contract](../storage-contract.md),
[settings and backups](../settings-backup-design.md).

Code: `lib/backup/conversations-archive.js` (build/parse), `conversations-import.js`
(preview/apply/receipts), `conversations-store.js` (store port), `backup-jobs.js`,
`conversations-backup-service.js`, `lib/routes/conversations-backup-routes.js`,
`lib/backup/zip-store.js` (store-only ZIP). Tests: `tests/conversations-backup.test.js`.

## Export

`POST /api/conversations-backup/export` starts a **job** (HTTP 202) and returns a job id;
the work continues if the browser disconnects. Inputs: `scope` (`chat`, `selection`,
`workspace`, `all`), `chatIds`, `workspaceFolder`/`workspaceFile`, `includeArchived`,
`includeSubchats`, `includeAttachments`, `includeWorkspacePaths` (off by default),
`includeMarkdown`, `format` (`archive` = importable ZIP, `markdown` = reading copy only).
`POST .../export/estimate` returns counts, estimated size and omissions without writing.
Explicitly listed chats are always exported; archived chats and subchats are added only on
request. The finished archive is published after a read-back checksum
(`GET .../jobs/:id/download`, addressed by job id, never by path).

`conversations-v1` ZIP members: `manifest.json`, `chats/metadata.json`,
`chats/history.json`, `attachments/index.json`, `attachments/<uuid>.jpg`,
`markdown/conversations.md`. The manifest lists every category with size and SHA-256, the
attachment totals, `lineage.sourceArchiveIds` and `omissions` (excluded archived chats,
relations to chats outside the export, missing attachments, trimmed history).

Only the retained server transcript is exported. Trimmed events are not recreated, and
unsynchronized queues of this or other devices are never included (stated in every
manifest as a `browser_unavailable` omission). Archives contain conversation content and
attachments; they are not anonymized. Native harness session IDs, widget bindings and
TODO/delegation identifiers are never exported.

## Import

1. `POST .../import/stage` (raw `application/zip` body): the whole archive is validated in
   memory before anything is written - store-only ZIP, traversal/absolute/symlink/nested
   archive/duplicate/overlap checks, declared-size and total limits (no inflation, so no
   zip bomb), manifest schema, per-member SHA-256, no unlisted members, prototype-pollution
   keys, record validity and size, reference integrity and an acyclic fork graph.
   Any failure rejects the entire archive.
2. `POST .../import/preview` returns the **complete change plan** per chat with a status:
   `new`, `already_imported`, `destination_deleted`, `options_changed`, `content_match`,
   `duplicate` or `not_selected`, plus workspace resolution, relation remaps, attachment
   counts, lineage and existing matches. A preview is bound to the archive digest, the
   options, the chat-list revision and a plan fingerprint; changed state needs a fresh
   preview.
3. `POST .../import/apply` runs a non-cancellable job. New chat IDs are allocated, relations,
   workspace and attachment references are remapped, native session IDs are not imported
   (`cursorSessionId` is regenerated, `historyHandoff.required` marks that continuing starts a
   new session with an explicit transcript handoff), and a notice record is appended.

### Receipts and replay

`data/conversation-import-receipts.json` records (archive ID, archive digest, source chat ID,
per-chat options hash) -> destination chat ID. The options hash covers the resolved workspace
and `preserveArchived`. Consequences:

- Repeating an import, a lost response, or re-staging the same file returns the earlier
  mapping and creates nothing. Apply results are also persisted per preview ID.
- The same archive ID with a different digest fails with `ARCHIVE_DIGEST_CONFLICT`.
- A deleted destination is reported (`destination_deleted`) and not recreated.
- Different options for an already imported chat show `options_changed` and need
  `acknowledgeOptionChange: true`.
- Copying again is the separate explicit `duplicate: true` mode.
- A re-export gets a new archive ID and keeps its ancestry (`lineage`); the preview shows
  `content_match` (identical transcript already present, skipped unless `duplicate`) or an
  informational lineage match.

`historyHandoff` is a **marker only**: nothing in the run layer consumes it yet, so continuing an
imported chat does not yet hand the transcript to the new native session automatically. The
consumer (chat-run side) is a tracked follow-up. The visible import notice record is skipped
when the transcript already holds the maximum retained event count, so import never trims a
source event. When more than 4096 omissions exist, the manifest lists 4095 and ends with a
summary entry stating how many were not listed.

An apply job that failed, was cancelled or was interrupted does not block a retry with the same
preview; receipts keep a repeated apply from duplicating data.

A pending journal is written before any chat data; the chat-list write is the single commit
point. On failure everything staged (history, attachments) is removed. After a crash,
`recover()` (called at server start) rolls the batch forward if the chats exist or back
otherwise. An unreadable receipts file fails closed.

## Limits

512 MiB per uploaded archive by default (operational; the frozen contract maximum is 8 GiB),
5000 chats, 2000 events per chat, 256 KiB per record, 20000 attachments. History reads use
the existing history adapter, which cannot distinguish a missing from a corrupt history
file; the chat list is read strictly.
