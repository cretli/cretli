# Chat history: legacy -> SQLite import, rollback export and async adapter (stages 1-2b)

Status: **stage 2b is implemented and tested; stage 3 operational cutover is prepared
but not executed.** Production callers use the backend-neutral async service and the
server opens exactly one marker-selected backend before serving requests. The default
on a fresh installation remains the legacy file store; a migration is not operationally
complete until the quiesced import, marker selection and cutover procedure (stage 3)
has been executed against the intended data directory.

Programme stages: **1** offline import/export + the startup exception record,
**2a** the async adapter, durable identities and the rollback contract, **2b** conversion
of production callers to the adapter (see "Stage 2b"), **3** the
operational cutover. Everything so far runs on synthetic fixtures and temporary
directories only, never on user data. Plan `94ec05ba` (unfinished performance work) is
untouched and **deferred**.

## Files

| File | Role |
| --- | --- |
| `lib/storage/history-legacy-format.js` | Strict reader and canonical digest of the legacy document |
| `lib/storage/history-import.js` | `planLegacyImport`, `applyLegacyImport` (staging, resumable), `verifyImportStaging` |
| `lib/storage/history-rollback.js` | `planRollbackExport`, `applyRollbackExport`, `verifyRollbackExport` |
| `lib/storage/history-sidecar.js` | Import provenance tables (all-or-none) and the store -> legacy mapping both tools share |
| `lib/storage/schema/0004-chat-history-metadata.js` | Schema v4: live document/event metadata (C-3 resolved) |
| `lib/storage/schema/0005-dataset-binding.js`, `lib/storage/dataset-binding.js` | Schema v5: immutable `storage_dataset_binding`; `bootstrapHistoryStore` / `bindDatasetGeneration` (offline) |
| `lib/storage/schema/0006-history-large-staging.js`, `lib/storage/history-large-record.js` | Schema v6: fragment staging tables; codec and limits of the large-record protocol |
| `lib/storage/chat-history-store.js` | Worker registry + facade: append/trim/reset/retire plus (2a) `deleteChat`, `copyChat`, `readSeqs`, `listHeads`, `readUsage` |
| `lib/persist/chat-history-adapter.js` | Backend-neutral async contract, query routing, batch read |
| `lib/persist/chat-history-backend-{legacy,sqlite,rollback}.js` | The three backends (exactly one is active) |
| `lib/persist/chat-history-backend-marker.js` | Control marker that selects the backend; guarded transitions |
| `lib/persist/chat-history-runtime.js` | Wiring: marker, coordinator, worker host, group commit, pending buffer, recovery |
| `lib/persist/history-pending-buffer.js` | Durable pending commands, producer `clientSeq` counters, producer id helpers |
| `lib/persist/chat-history-usage.js` | Pure usage summary (extracted from the legacy module, re-exported there) |
| `lib/persist/chat-history-errors.js` | `ChatHistoryAdapterError` and its stable codes |
| `lib/storage/history-migration-fs.js` | Path/symlink guards, exclusive durable writes, atomic publish |
| `scripts/storage-history-migrate.mjs` | CLI: `import`, `verify-import`, `rollback`, `verify-rollback` |
| `tests/storage-history-{import,rollback,cli,lossless}.test.js` | Stage 1 tests; fixtures in `tests/fixtures/storage-history-*.js` |
| `tests/storage-history-adapter{,-rollback,-runtime,-r2}.test.js` | Stage 2a tests (parity, metadata, crash/replay, fencing, rollback, marker, migration 0004, pending buffer) |

The ready `migration-runner.js` was evaluated and **not** used for the data copy: it
is a journaled mechanism for steps running on an existing store connection inside the
storage worker, and its resume model keys on a single store being migrated in place.
The import builds a brand-new store beside the source, so it uses the same primitives
(`openStorageDb`, the schema migrations, `runWalTruncateBarrier`) and its own
per-chat transactions as the resume unit. `coordinator.js` fencing is described under
"Rollback" because the tool itself holds no ownership.

## Legacy format (read from code, not from user data)

`lib/persist/chat-history-persist.js` writes `<dataDir>/chat-history/<chatId>.json`
with `writeJsonAtomic` (`JSON.stringify(doc, null, 2)`, temp file + rename; no
fsync of file or directory):

```
{ v: 1, chatId, cursorSessionId, headSeq, updatedAt, events: [{ seq, rec }] }
```

- `chatId` matches `/^[a-zA-Z0-9-]{1,128}$/`; `events` are in ascending `seq`.
- `seq = ++headSeq` per new event. **Coalescing**: a stream (assistant/thinking)
  item whose kind equals the stored tail's is merged into the tail record (same
  `seq`, no new sequence number), so gaps are not only retention. `headSeq` is
  monotonic and is kept when events are trimmed (retention `MAX_HISTORY_EVENTS` =
  2000, applied on append; `copyChatHistory` and hand edits can exceed it).
- `rec` kinds `sdk | localUser | meta` per `chat-history-validate.js`. A record sent
  by a client carries `clientSeq`; **dedupe is legacy-wide per chat** over the
  retained events only (a trimmed event forgets its key). An incoming item merged into the
  tail loses its `clientSeq`.
- The loader is forgiving and silent: it defaults missing fields and **drops events
  that fail validation**, and the next save makes the drop permanent.
- Not persisted: **revision** (`chat-history-revisions.js` is an in-memory counter,
  bumped per append batch and re-seeded from `headSeq` at start), the usage summary
  (derived on load, `summarizeChatHistoryUsage`), push notification state.
- Whole files are loaded and cached synchronously (8 files); pagination, exact-seq
  lookup, stream-boundary and turn-start extension are computed in memory.
- `copyChatHistory`/`copyChatHistoryUntil` (fork) copy events **with their original
  `seq`** and `headSeq`, stripping `clientSeq`.

## Mapping legacy -> store

| Legacy | Store | Notes |
| --- | --- | --- |
| `chatId` | `chat_history_state.chat_id` | Must also be a store identity (no leading `-`), else `legacy_chat_id_unmappable` |
| `headSeq` | `next_seq = headSeq + 1` | `headSeq` may exceed the last retained `seq` |
| each `{seq, rec}` | `chat_history_events` row, **same `seq`**, `payload_json = rec` verbatim | Gaps kept; unknown record fields kept |
| event order/count | `revision` = retained count, per-event `revision` = ordinal | Legacy revision is not durable; this is the baseline for new writes |
| retention | `retention_limit = 2000`; `trimmed_through_seq = firstRetainedSeq - 1` (empty chat: `headSeq`) | The file cannot distinguish trimming from coalescing gaps, so everything below the first retained `seq` is "unavailable" |
| `rec.clientSeq` | dedupe row under producer `legacy-import` (digest of the content a retry would produce); `events.client_seq` informational | One row per client-keyed retained event |
| identity | generation = operator-supplied `--dataset-generation`; epoch `legacy-import`; producer `legacy-import` created **retired** | Nobody can append as the import producer |
| `cursorSessionId`, `updatedAt` (raw string), unknown document keys, unknown event keys | `chat_history_meta` / `chat_history_event_extra` (schema v4; the tool also writes the `legacy_import_*` provenance tables) | Contract C-3 |
| receipts | none created | |

Everything is read back through the same mapping used by the rollback export and
compared per chat by canonical digest (order-independent, unknown fields included).

### Refusals (never repaired, truncated or silently mapped)

`legacy_invalid_json`, `legacy_invalid_utf8`, `legacy_duplicate_key`,
`legacy_not_object`, `legacy_unsupported_version`, `legacy_doc_field_missing`,
`legacy_doc_field_type`, `legacy_chat_id_invalid`, `legacy_chat_id_unmappable`,
`legacy_chat_id_mismatch`, `legacy_invalid_event`, `legacy_seq_not_ascending`,
`legacy_invalid_record` (the case the legacy loader would silently drop),
`legacy_record_not_json`, `legacy_record_too_large` (above the 3 MiB large-record cap; the
caller must decide, nothing is cut. Records between 256 KiB and 3 MiB are valid), `legacy_client_seq_invalid`,
`legacy_duplicate_client_seq` (the dedupe ledger would be ambiguous),
`legacy_head_seq_behind`, `legacy_file_too_large`, `legacy_not_regular_file` (symlink),
`legacy_unexpected_entry` (any entry other than a chat file, a temp file or one of the two protected files below), `legacy_recently_modified`. A file refused for any of
these blocks `apply`; the plan lists the file and code. Leftover
`<id>.json.<pid>.<ms>.tmp` files are reported as ignored (the legacy loader ignores
them too). The exact names `.cursorignore` and `.rgignore` (regular files only; a symlink or
directory with that name is still refused) are agent-protection metadata of the directory: the
plan lists them as `protectedIgnored` (name, bytes, SHA-256), binds them into `planHash`, the
manifest records `protectedIgnoredEntries`, and no tool imports, copies, moves or deletes them.
Warnings (do not block): `over_retention` (> 2000 events: kept; the first
append trims exactly as legacy would), `empty_with_head_seq`.

## Import tool

```bash
# plan (default; writes nothing, prints planHash and every refusal)
node scripts/storage-history-migrate.mjs import --legacy-dir <quiesced chat-history> --dataset-generation <G>
# apply: explicit new output + the plan hash you reviewed
node scripts/storage-history-migrate.mjs import --legacy-dir <dir> --dataset-generation <G> \
  --staging-out <new dir> --apply --confirm-plan <planHash> [--resume]
node scripts/storage-history-migrate.mjs verify-import --staging-dir <staging> [--legacy-dir <dir>]
```

Guarantees, each covered by a test: sources opened read-only and left byte/mtime
identical; output must not exist, sit in a real (non-symlink) directory and be
disjoint from the source; everything is built in `<out>.partial` (marker file,
exclusive-create files, fsynced) and published by one rename; one SQLite
transaction per chat so a crash (including a real `SIGKILL`) leaves the staging
store at a chat boundary and `--resume` continues after checking marker, plan hash
and per-chat source SHA-256 (a resumed run is logically identical to an
uninterrupted one); SQLite `integrity_check`, `foreign_key_check`, per-chat logical
comparison and total counts are verified before the manifest (`manifestHash`,
`db.sha256`, per-chat digests) is written; the staged store is closed cleanly
(WAL truncated) so it is one self-contained file. Memory is bounded by one legacy
file (default ceiling 256 MiB) plus the per-chat plan summary.

Not guaranteed: **no lock is taken on the source and live ownership is not
promised.** The operator runs it with every writer stopped; the tool detects (SHA-256
per file between plan, import and publication; a `--min-quiet-ms` mtime heuristic,
default 5000 in the CLI) but cannot prevent a concurrent writer. The staged store is
valid only for the generation it was built with.

## Rollback export

```bash
node scripts/storage-history-migrate.mjs rollback --store-dir <closed store dir>             # plan
node scripts/storage-history-migrate.mjs rollback --store-dir <dir> --legacy-out <new dir> \
  --apply --confirm-plan <planHash> [--cursor-session-map chats.json] [--discard-partial]
node scripts/storage-history-migrate.mjs verify-rollback --export-dir <out> --store-dir <dir>
```

Output (`manifest.json` + `manifestHash`):

- `legacy-chat-history/<chatId>.json` - valid legacy documents (they pass the strict
  reader; the file is the legacy pretty-printed format. For a chat that was imported and not
  written since it is **logically identical** to the original (same canonical digest:
  every key, value and array order; whitespace, trailing newline and key order may differ,
  so a compact or reordered source exports pretty-printed). Raw file bytes are not stored.
  "Not written since" is decided from a durable marker saved at import
  (`import_revision`, `import_next_seq`, dataset generation, chat epoch), never from timestamps;
  a sidecar of another format version fails closed with `sidecar_format_unsupported`, and a
  PARTIAL sidecar (one or two of the three `legacy_import_*` tables) fails closed with
  `sidecar_partial` instead of exporting a chat without its provenance; a store that was never
  imported has none of them and is valid). Every retained
  event of every chat is exported, including all events appended after the import and
  chats created after it. Events of producers other than `legacy-import` lose the
  store-added `clientSeq` (producer-scoped counters would collide as legacy-wide
  dedupe keys and silently drop a retried input); their identity is kept in the
  sidecar.
- `rollback-control/` - `control.json` plus JSONL: `chat-state`, `epochs`,
  `producers`, `dedupe`, `event-identity`, `receipts` (sha256 per file). Holds the
  `storage_fencing` high-water mark (`storageFencingHwm`, `requiredMinimumFenceEpoch`)
  and the control actions required before a legacy writer may run.

Safety: the store must be cleanly closed (a WAL/journal file is refused:
`store_not_cleanly_closed`); it is read through an immutable connection and hashed
before and after, so a write that lands during the export aborts it
(`source_changed_during_export`, nothing published). `verify-rollback --store-dir`
repeats that comparison right before any publication step: a store that accepted a
write after the export is `source_changed_since_export`. An acknowledged input whose
event was retired by retention or reset is counted (`ackedWithoutRetainedEvent`) and is
a policy loss identical to legacy, not a rollback loss.

**Compatibility, stated plainly:** a legacy document has no place for dataset
generation, chat epoch, producer, receipts or a fencing epoch. The export therefore
sets `plainLegacyBinaryCompatible: false` and `legacyAdapterRequired: true`. An
unmodified old binary can read the files but cannot honour fencing, answer retried
commands from receipts or reject writers of an older generation. A sidecar-aware
legacy adapter (not written) must refuse to write until the `controlDirActions` were
performed: quiesce and fence the new store (raise the control-directory HWM to at
least `requiredMinimumFenceEpoch`), keep the restore-pause marker, advance the dataset
generation (invalidate caches, quarantine browser queues for reconciliation) and
re-run `verify-rollback --store-dir`. Those actions are stage-3 operator steps; the
tool records them but executes none of them and does not stop a running new-version
process.

## Stage 2a: the async adapter (implemented, not wired)

`createChatHistoryAdapter` (`lib/persist/chat-history-adapter.js`) exposes the
operations of `lib/persist/chat-history-persist.js` as Promises over **exactly one**
backend. The backend is chosen by the control marker (below); the default, with no
marker, is `legacy`, which delegates to the existing synchronous code. Nothing
migrates data, flips the marker or dual-writes. The SQLite backend never opens a
database on the main thread and never blocks on a worker (no `Atomics`, no sync
facade); every database call is a worker-host request.

### Operations

| Adapter method | Legacy function | Result (same shape as legacy unless noted) |
| --- | --- | --- |
| `appendChatHistoryEvents(chatId, cursor, items, opts?)` | `appendChatHistoryEvents` | `{ ok, headSeq, appended:[{seq,rec}] }` **plus** ACK evidence `{ committed:true, replayed, receipts:[{commandId, datasetGeneration, chatEpoch, producerId, revision}], duplicates }`. `{ ok:false, code:'history_unnamespaced_input' }` for a refused input |
| `appendChatNotice` | `appendChatNotice` | same as append; `{ok:false,error:'Empty notice'}` |
| `getChatHistorySince(chatId, since, limit)` | same | `{ ok, chatId, cursorSessionId, headSeq, events, hasMore }`; limit clamped 1..2000, default 1000 |
| `getChatHistoryEvent(chatId, seq)` | same | exact lookup; a gap returns `event:null` (never a neighbour) |
| `getChatHistoryPage(chatId, {beforeSeq, limit})` | same | newest window, extended to the stream boundary and the opening user turn (older rows are read in 250-event chunks, never the whole chat), `oldestSeq`, `hasOlder` |
| `readChatHistoryFromHttpQuery`, `readChatHistoryBatch` | same | routing and the 32-chat batch rule are shared by all backends |
| `loadChatHistory(chatId, {maxBytes})` | same | `{ v, chatId, cursorSessionId, headSeq, updatedAt, events, usageSummary }` or `null`. **Explicit byte cap** (default 32 MiB): above it a typed `history_load_too_large`, never a cut |
| `getChatHistoryUsage(chatId)` | `loadChatHistory().usageSummary` | `{ usageSummary, headSeq }` computed inside the worker (counts by SQL, only `usage`/`context_usage`/`status` events parsed) |
| `copyChatHistory`, `copyChatHistoryUntil` | same | `{ ok, headSeq }` (+ `events` for `Until`, read back in pages). One `INSERT..SELECT` in the worker, preserving `seq`/`headSeq`, stripping `clientSeq`, ceiling 64 MiB per copy (`history_copy_too_large`) |
| `deleteChatHistory(chatId)` | same | resolves after the durable tombstone |
| `listChatHistoryHeadSeqs()` | same | `{ [chatId]: { headSeq, updatedAt } }`, read in keyset pages of 500; deleted chats are skipped |
| `recoverPending()`, `lookupReceipt()`, `lookupInput()`, `diagnose()` | - | backend-specific (see below) |

`seq` and `revision` are different things everywhere: `seq` is the event position
(`headSeq = next_seq - 1`, gaps from coalescing/trimming kept); `revision` is the
durable per-input counter used for CAS and receipts.

### Identity, producers and the write path

Server writes need no identity from the caller: the adapter learns the chat's
`chatEpoch` with a lenient read (`anyEpoch`), uses its configured `datasetGeneration`
(a chat held under another generation is `history_generation_mismatch`) and a server
producer `server:run:<runId>:attempt:<attemptId>` (`buildServerProducerId`, passed as
`opts.producerId`; the adapter default is a per-process `server:run:adapter:...`).
The producer's `clientSeq` is allocated from a **durable counter** (blocks of 1024 are
persisted before use, so a crash can skip numbers, never reuse one) and is stripped
from the records readers see (`presentHistoryRecord`). If the epoch moved between read
and write (`history_stale_epoch`), nothing committed and the adapter re-reads once.

A browser queue replay passes `opts.queueProducerId` (its persisted random producer)
and numeric `clientSeq` on **every** item, and should pin `opts.chatEpoch`: a pinned
stale epoch is refused, never refreshed. An input carrying a `clientSeq` **without** a
queue producer is a pre-cutover un-namespaced input: it is refused
(`history_unnamespaced_input`) and never replayed automatically; the explicit path is
`store.reconcileLegacyQueue` after review. Mixed named/unnamed items are refused.

Write path (`chat-history-backend-sqlite.js`): (1) fix `commandId`
(`hist.<op>.<uuid>`), producer and `clientSeq`s; (2) persist the command in the
**durable pending buffer** (`history-pending-buffer.js`, fsync + atomic rename, bounded:
4096 entries / 320 KiB each / 64 MiB; overflow is a typed `history_pending_full` /
`history_pending_entry_too_large`, never a drop) **before** dispatch; (3) dispatch
through the receipt-wrapped store (group commit capable; a batch is split into
commands of at most ~56 KiB, a single record up to 256 KiB goes alone, a larger one uses the
fragment protocol, see "Large records"); (4) only
the resolved promise is an ACK, then the entry is removed. Outcomes:

- success -> entry removed, result returned;
- `unknown_commit` -> `resolveUnknown` with the same command: `committed` -> success
  (`replayed:true`), `not_committed` -> the same command is retried (3 attempts);
  unreconcilable -> the entry **stays pending** and `history_commit_unknown` is thrown;
- a refusal known to be `not_committed` (stale epoch, fenced producer, record too large,
  fenced/paused owner, busy after retries) -> entry removed (the caller was told);
- a restart -> `recoverPending()` replays persisted commands in recorded order (a
  command that had committed is answered from its receipt: no duplicate, tested with a
  real worker kill); an entry of another dataset generation or one that is now
  definitively refused moves to `pending/quarantine/` (kept for an operator).

Microbatch (R4; format unchanged): the on-disk pending format is still v1 (one
`entries/<sha256(commandId)>.json` per command, same ACK-by-unlink). Concurrent
`record`/`recordMany` calls are coalesced in one `setImmediate` window (at most 256
entries / 8 MiB per group; the first request always fits). Inside the serialized mutation
every request is snapshotted, checked for unique command ids and quota-checked in order;
the group's files are then written in bounded parallel (temp + fsync + rename) and the
entries directory is fsynced **once** for the group. Nothing is indexed, resolved or
dispatched before that barrier. A failure removes every path the request created (also a
renamed file whose directory fsync failed) and the removal is proven by a second directory
fsync; if that cannot be proven the identities stay indexed and `history_cleanup_uncertain`
is returned, and further records are refused until they are acknowledged or the process
restarts (recovery may still replay them). Single-id `ack`s are coalesced into one
unlink group + one directory fsync (never two ids of the same logical batch, never a
duplicate id); a multi-id logical batch keeps sequential unlink + fsync per id so a crash
leaves a suffix. This is a performance change only: it is not production-ready on its
own (the libuv threadpool, default 4 threads, still bounds parallel file fsyncs), and no
physical-disk power-loss test was run.

### Notifications

The adapter does not notify. A caller (stage 2b) awaits the returned promise and only
then bumps the revision / broadcasts (`bumpChatHistoryRevision`,
`notifyChatHistoryUpdated`, `broadcastChatHistoryUpdate`, `clearChatHistoryRevision`
after a delete) - never before the ACK, never from staging tests. For commands
replayed by `recoverPending` (no awaiting caller) the backend invokes an optional
`onCommitted({operation, chatId, headSeq, appended, replayed, receipts, recovered?})`
hook after COMMIT; it is also called for live writes after the pending entry was
removed. A throwing hook never un-commits a write. By default no hook is wired.
(The legacy backend keeps its pre-existing synchronous notify-inside-the-call order.)

### C-3 resolved: schema v4 metadata (forward-only migration 0004)

`chat_history_meta(chat_id, cursor_session_id, doc_extra_json, updated_at_raw,
deleted_at)` and `chat_history_event_extra(chat_id, seq, extra_json)`.

- Writes: a non-empty `cursorSessionId` on an append replaces the stored one (also when
  every input was a duplicate; limit 4096 bytes, typed refusal above it, imported values
  are kept as they are); `updated_at_raw` (the original legacy string) is kept **only
  until the first write that changes the chat**, then `NULL` and the exporter uses an
  ISO time; unknown document keys stay for the life of the chat; unknown event keys are
  removed with their events (retention trim, `reset`, `deleteChat`) so they can never be
  re-attached to a new event of the same `seq`.
- Fork: the target gets only the requested cursor and no document/event extras
  (the legacy `cloneHistoryEvents` dropped them). Delete: tombstone (`deleted_at`), new
  epoch `del.<uuid>`, all producers fenced, events/extras/cursor/doc extras removed,
  receipts and the dedupe ledger kept; the chat reads as missing and exports as nothing.
- Upgrade of an imported v3 store: migration 0004 folds `legacy_import_*` into the new
  tables (untouched chats keep `updatedAt`, modified ones get `NULL`), leaves the
  provenance tables untouched, gives every other chat default metadata and refuses a
  **partial** sidecar atomically (`corrupt`/`history_sidecar_partial`, schema stays v3).
  The import tool writes the new tables itself, so a freshly staged store is already v4.
  The tools require `user_version == 4` (`store_schema_unsupported` otherwise).
- Hardening F6: `hasSidecarTables` / `readChatAsLegacy` / rollback plan treat 1-2 of the 3
  `legacy_import_*` tables as `sidecar_partial` (typed, fail closed); 0 tables is a valid
  never-imported store; `ensureSidecarTables` runs in one transaction and never completes
  a partial set. Tested by dropping each table (and a pair) after an import.

### Backend selection and exclusivity

`history-backend.json` in the coordinator control directory (outside every restore
path). Missing = `legacy` **only if no cutover witness and no store/pending footprint exists**
(otherwise `history_backend_marker_missing`, see round 2); unreadable/inconsistent = `history_backend_marker_invalid`
(fails closed, never defaults). Transitions are explicit, CAS on `revision`, need the
live coordinator owner and a `confirm*` flag: `legacy -> sqlite` (`confirmCutover`),
`sqlite -> rollback-readonly` (`confirmRollback` + the verified export's manifest hash).
There is **no** transition back to a writable legacy (see Rollback).
`openChatHistoryRuntime` starts the backend the marker names: `sqlite` requires the same
`datasetGeneration`, an acquired coordinator, a started worker host (startup barrier:
WAL TRUNCATE under FULL, integrity and FK checks, F29 - a failure leaves **no adapter**,
tested with a damaged store), `coordinator.activate(host)` and `guardHost` (every write
carries the owner epoch; a fenced, taken-over or restore-paused owner is refused, tested
with a taken-over owner and a pause), then replays pending commands **before** returning.

### Rollback (the one certified mode is READ-ONLY)

Plain legacy code has no generation, epoch, producer, receipt or fence, so a writable
legacy backend after new ACKs would need a crash-safe atomic ledger + atomic JSON
publishing + fencing that does not exist; a best-effort cross-store write would
silently lose or duplicate acknowledged data. The operational rollback is therefore:

1. Pause new-store writers (`coordinator.pauseForRestore`), stop the server, close the
   store cleanly. 2. `rollback` plan/apply (`--confirm-plan`), then `verify-rollback
   --store-dir` (any later write to the store invalidates the export). 3. Raise the control
   fence to at least `requiredMinimumFenceEpoch` and keep the restore-pause marker.
4. `selectHistoryBackend({ backend: 'rollback-readonly', confirmRollback, exportManifestHash })`.
5. Start: the rollback backend re-verifies the export (manifest, every chat file with the
   strict reader, every control sidecar hash, store unchanged, fence raised, pause marker)
   and **refuses to serve** otherwise (`history_rollback_not_verified`, with a named
   failed check; `allowUnverifiedControl` exists for diagnosis only).

In that mode: reads (`since`, event, page, load, list, usage) come from the exported
legacy documents including every acknowledged post-import write; **every** write
(`append`, notice, copy, delete, queue replay) is `history_rollback_read_only`;
`lookupReceipt({datasetGeneration, commandId, requestDigest?})` answers from the
exported ledger and only `outcome:'committed'` (same generation and digest) is an ACK -
a receipt of another generation, an unknown generation or a digest mismatch is
`stale_generation` / `digest_mismatch` and never acknowledges anything;
`lookupInput` answers whether a producer-scoped `clientSeq` was accepted. Operational
cost, stated plainly: while in this mode agent runs and browsers cannot persist new
history - it is a maintenance/emergency state, not a way to keep working. Writing
resumes only through the SQLite backend (a new run of stage 3 with the same or a new
generation). Nothing acknowledged is lost by the rollback itself (history older than the
2000-event retention is lost exactly as in legacy); the pre-cutover installation backup is
verified but does **not** contain post-cutover ACKs and cannot replace this export.

### Deliberate differences from the legacy file store

Dedupe is per producer, not per chat; a stream delta merges only into the tail of the
**same** producer (the first delta of a new run attempt starts a new event); a record
above 3 MiB, a cursor above 4096 bytes and a copy above 64 MiB are typed refusals
(legacy had none); a producer fenced by a delete/reset cannot append (legacy recreated
the file); a byte-bounded page may carry fewer than `limit` events and reports
`hasMore`; an append with no valid item writes nothing (legacy rewrote `updatedAt`); a
cursor-only change without an event is not supported; `loadChatHistory` returns a
fresh copy, not a shared cache object.

## Stage 2a round 2: fail-closed selection, logical batches (implemented, not wired)

Review round 1 and the parent's repros found that a selected sqlite backend could
come up on an empty store, that a lost marker fell back to legacy, that a stale
owner could rewrite the marker and that a multi-chunk append was not atomic from the
caller's point of view. Fixed, with tests in `tests/storage-history-adapter-r2.test.js`:

### Store selection (A)

- The runtime **never creates** a store. `openChatHistoryRuntime` refuses
  `history_store_missing` when `<dbDir>/cretli-store.sqlite` is absent or empty, creates no
  directory, and starts the worker host with `create: false`; the worker passes it to
  `openStorageDb` on **every start and restart**, so a file removed while the process
  runs is `missing`, not recreated.
- Schema **v5** adds `storage_dataset_binding` (one row, immutable by trigger). Before
  `activate` (so before the fence is raised and before any replay) the runtime calls the
  worker query `history.verifyDataset`: unbound -> `history_store_unbound`, another
  generation -> `history_generation_mismatch`. A fresh empty store therefore never passes
  for an existing dataset.
- Who writes the binding: the **offline** tools only. `bootstrapHistoryStore({ dbDir,
  datasetGeneration })` creates + migrates + binds; the stage-1 import tool binds the staged
  store from its first byte; migration 0005 infers the binding when upgrading an existing
  v3/v4 store (import sidecar, else the single generation its chats use; zero or several
  generations leave it unbound and the runtime refuses it until an operator binds it).
  `bindDatasetGeneration` refuses a file whose data belongs to another generation.

### Lost marker (B)

`selectHistoryBackend` writes a durable **witness** (`history-cutover-witness.json`, same
control directory, separate file) *before* the marker. `readHistoryBackendMarker` refuses
`history_backend_marker_missing` when the marker is absent but the witness exists, or
when the marker is older than the witness (restored copy, crash between the two writes).
Independently, the runtime passes the `dbDir`/`pendingDir` it was given: a store file or
pending-buffer footprint next to a missing marker refuses too, so safety does not rest on the
caller naming a directory *or* on the witness alone. Default `legacy` remains valid only
when none of these exist. Repair is an explicit operator action:
`repairHistoryBackendMarker({ controlDir, coordinator, selectedBy, confirmRepair: true })`
rebuilds the marker from the witness; it never selects anything new.
**Limit:** restoring the whole control directory from a backup older than the cutover
removes marker *and* witness together; the dbDir/pending footprint checks and the DB binding
are the remaining defence there, and stage 3 may add journal publishing on top.

### Live lease for marker writes (C)

`coordinator.withOwnedLease(operation, fn)` runs a synchronous section under the control
lock after proving the on-disk lease is ours and no higher mark exists (an expired lease
nobody took over is extended first). The marker CAS read, the witness and the marker
writes all happen inside it: a zombie owner after TTL/takeover is fenced and writes
nothing (`history_backend_transition_refused`, `cause: 'fenced'`).

### Logical append batches and the retry API for 2b (D)

`appendChatHistoryEvents(chatId, cursorSessionId, items, callOptions)`:

1. **Whole-input pre-validation, before any identity is allocated or recorded:** each
   record <= 3 MiB on the wire (256 KiB-3 MiB take the fragment path, see "Large records") (`history_record_too_large`), each chunk within the store's
   command budget, at most `HISTORY_BATCH_MAX_EVENTS` (1024) events and
   `HISTORY_BATCH_MAX_BYTES` (8 MiB) per call (`history_batch_too_large`), cursor session
   <= 4096 bytes. A refusal is atomic: nothing committed, nothing pending
   (`details.commitState: 'not_committed'`, `details.conflictKind` set).
2. **One durable plan per call:** all chunk commands (own `commandId`, pre-allocated
   `clientSeq`, epoch, producer) are written to the pending buffer as one batch
   `{ id, index, count, digest }` *before* the first dispatch (`recordMany`, budgeted as a
   whole; a write failure removes what was written). The batch is acknowledged together
   only after the result was assembled, including the post-commit `readStored`.
3. **Retry token.** Any error with `details.retryToken` (`history_commit_unknown`,
   `history_batch_incomplete` with `resumable: true`, `history_committed_readback_failed`)
   means the append may be partly or wholly committed. The caller **keeps the same
   inputs** and calls again with `callOptions.retryToken = details.retryToken` until it
   returns `ok` or a non-resumable error. The adapter re-drives the SAME commands - committed
   chunks are answered from their receipts (`replayed: true`) - and allocates no new
   commandId, clientSeq or epoch; the digest of the inputs must match
   (`history_batch_mismatch`), a finished/dropped token is `history_batch_unknown`.
   Without a token a repeated call is a **new** append (an identical stand-alone append can
   be intentional), so 2b callers must keep the token until ACK.
4. **Failure map.** Chunk 1 refused (known not committed): whole plan dropped, original
   error. Later chunk, transient: `history_batch_incomplete`, `resumable: true`, plan kept.
   Later chunk, definitive: `history_batch_incomplete`, `resumable: false`, rest
   quarantined; both carry `committedChunks`, `totalChunks`, `acceptedSeqs`, `headSeq`,
   `cause`/`conflictKind`, so the committed prefix is always findable.
   `history_commit_unknown` keeps the plan. Post-commit read failure:
   `history_committed_readback_failed` with `commitState: 'committed'`.
   - **Read-back is byte-paged.** `readSeqs` truncates by bytes, so `readStored` re-requests
     the seqs it did not get until all are read (every round must progress). `appended` is
     ALWAYS the stored (possibly coalesced) record, never the input record. A seq the store
     no longer holds gives `history_committed_readback_failed` with `cause:
     'history_seq_missing'`, `resumable: false` (plan acknowledged: it is fully committed and
     a retry cannot recover the record; `missingSeqs` lists it); a round without progress is
     `cause: 'history_readback_no_progress'`, `resumable: true`, plan kept.
   - **"Failed" is only reported after a durable discard.** A plan known not to have
     committed (chunk 1 refused; later chunk refused definitively) is acknowledged /
     quarantined BEFORE the refusal is returned; the adapter never swallows that I/O error.
     If the discard fails and the plan is still replayable the caller gets
     `history_cleanup_uncertain` (`commitState: 'uncertain'`, `resumable: true`,
     `retryToken` = batch id or, for a stand-alone command, the `commandId`;
     `refusedWith` = the original refusal code) or, for a later-chunk definitive refusal,
     `history_batch_incomplete` with `resumable: true, cleanup: 'failed'`. The plan and the
     committed prefix are kept: the caller retries with the SAME token (inputs unchanged);
     the adapter re-drives the recorded commands, so the write happens at most once, either
     by that retry or by `recoverPending()` after a restart (after which the token answers
     `history_batch_unknown`). If the failure left the plan unreplayable (entry 0 already
     removed), the original refusal / `resumable: false` is returned and the leftover
     suffix is only cleaned up at the next recovery (`ackCleanupFailures`).
   - **Stand-alone copy / delete.** `copyChatHistory`, `copyChatHistoryUntil` and
     `deleteChatHistory` accept a trailing `{ retryToken }` (the `commandId` from
     `history_cleanup_uncertain` or `history_commit_unknown`): the recorded command is
     re-driven (never re-recorded; chat / source must match, else `history_batch_mismatch`).
     2b callers must keep the token and retry until `ok` or a non-resumable error, and must
     not treat `history_cleanup_uncertain` as "not committed".
5. **Restart.** `recoverPending()` groups by batch: a complete plan is replayed in order and
   acknowledged together; a recorded *prefix* (crash while writing the plan; never
   dispatched) is quarantined as `batch_incomplete_record`; a *suffix* (acknowledgement had
   started, so everything committed) is acknowledged ONLY when the committed receipt of every remaining
   fragment is proven (R5); otherwise it is quarantined as `batch_suffix_unproven` (see R5 below).

### Pending buffer open (E)

Reads are bounded before the file is read: directory listing (`maxEntries` + 256),
`lstat` + `O_NOFOLLOW` per file, per-file ceiling, total bytes, <= 65536 counter files.
Over a bound -> `history_pending_corrupt`, no memory growth. A damaged, mismatched, oversize
or symlinked **counter** file is moved to `quarantine/*.counter-corrupt` and its producer is
**denied** (`history_producer_counter_corrupt`) on this and every later run - it is never read
as "counter 0". Missing-file policy: a producer with no counter file is a never-seen
producer starting at 0; that is safe because server producers carry a per-attempt random
component and queue producers bring their own `clientSeq`.

### Fork read-back (F)

`copyChatHistoryUntil` reads the committed copy back under `HISTORY_MAX_COPY_BYTES` (the
cap the store enforced before commit), so the default 32 MiB load cap cannot fail after a
commit. A read-back failure is `history_committed_readback_failed` with
`commitState: 'committed'`, `targetChatId`, `headSeq` - never a "not committed" error.

### Honest limits (G)

Software reviews of the F29 barrier and byte-bounded reads were done in the A3a leaves;
what stays uncertified is **physical** fsync failure / power loss (only simulated and
process-kill faults are tested). The startup gate stays FAIL under its recorded
exception. No production history was migrated; this is **not** a completed migration.

## Contract notes carried from stage 1 (C-1..C-10) and their status

C-1 identity (per chat epoch; imported chats start in `legacy-import`) - **done in the
adapter**. C-2 producers/commands - **done** (durable ids, `server:` and queue producers;
`reconcileLegacyQueue` is the explicit review path). C-3 - **resolved above**. C-4
`clientSeq` of imported rows is authoritative for `legacy-import` rows; server rows hide
the allocated one. C-5 coalescing boundary - documented difference above; the stream and
turn extensions are reproduced by the adapter pager. C-6 reads - **done**
(`readPage` byte-bounded; `oldestSeq`; exact lookup via `afterSeq`/`beforeSeq`; usage in
the worker). C-7 fork/delete/list/notice - **done** as store commands. C-8 revisions -
the store's durable `revision` is not the legacy in-memory counter; treat the cutover as
a discontinuity and notify after COMMIT. C-9 acknowledgement - **done** (pending buffer,
receipt reconciliation). C-10 ownership - **done** in the runtime (`guardHost`); a
caller that still reads the old files directly defeats it (see map).

## Integration map for stage 2b

Convert each caller to `await adapter.<method>`; notify only after the await; keep
legacy as the default backend until stage 3. `adapter` comes from
`openChatHistoryRuntime({ controlDir, ... })` (one per server process; the store must already exist and be bound - see round 2). "Gap" = needs
work beyond a mechanical `await`.

| Caller (module) | Adapter call | Required change / gap |
| --- | --- | --- |
| `lib/agent-harness/room-kernel.ts` (`persistHistory`), `lib/sdk/cursor-agent-sdk-ws.ts` (`flushPersistBuffer`) | `appendChatHistoryEvents(chatId, cursor, items, { producerId: buildServerProducerId({runId, attemptId}) })` | **Gap (high).** Make the flush async and ordered per chat; await the result before `bumpChatHistoryRevision`/`notifyChatHistoryUpdated`; on `history_commit_unknown` keep the buffer and stop later submissions of that stream; surface `history_producer_fenced` (chat deleted/reset) as a run-level error instead of a log line. Not measured: end-to-end throughput of the fsynced pending buffer under streaming load - benchmark in 2b |
| `lib/routes/chats-routes.js` POST `/api/chats/:id/history` | `appendChatHistoryEvents(..., { queueProducerId, chatEpoch })` | **Gap (high).** Browser must send its persisted queue `producerId` and last known `chatEpoch`; the response should return `committed`/`receipts` and the browser removes queue items only on it; old clients (no producer) get `history_unnamespaced_input`; 256-event/64 KiB batch and 256 KiB record limits are new refusals the route must map to HTTP 4xx |
| `lib/routes/chats-routes.js` GET history / batch, `lib/mcp/mcp-inprocess-client.js` | `readChatHistoryFromHttpQuery`, `readChatHistoryBatch` | Mechanical; follow `hasMore` (byte-bounded pages) |
| `lib/conversation-fork-execute.js`, `lib/sdk/sdk-history-isolation-fork.ts` | `copyChatHistory`, `copyChatHistoryUntil`, then `loadChatHistory` | Mechanical + handle `history_copy_too_large`/`history_load_too_large`; prefer paged reads over `loadChatHistory` |
| `lib/delegation-service.js`, `lib/delegation-mailbox.js`, `lib/chat-relation-history.js` | `appendChatHistoryEvents` (server producer), `loadChatHistory`/paged reads | **Gap (medium).** Full-history scans become async paged reads with a byte cap |
| `lib/workspace-watcher-pinned-chat.js` | `appendChatNotice`, then `broadcastChatHistoryUpdate(result.appended)` | Broadcast only after the await |
| `lib/persist/chats-persist.js` | head seq via `getChatHistorySince(id,0,1)` or a `listChatHistoryHeadSeqs` cache; `deleteChatHistory` | Await the delete, then `clearChatHistoryRevision`; the index/head cache must not read the files |
| `server.js` boot seed | `listChatHistoryHeadSeqs()` | Async at boot (paged); revision seeding waits for it. Startup cost is measured under the recorded A1 exception, not here |
| `mistral/`, `zai/`, `openrouter/`, `mimo/` agent-ws, `todo-plan-sync.js`, `delegation-source.js`, `context-compression-source.js`, `agent-finished-push.js` | `loadChatHistory(...).events` / `getChatHistoryUsage` | Async paged reads |
| `lib/sdk/sdk-context-stats.ts` | `getChatHistoryUsage` for counts | **Gap.** `historyFileBytes` (`stat()` of the file) has no SQLite equivalent: define a stored-bytes metric or drop it |
| `lib/agent-harness/history-store-guard.ts` | - | **Gap (required).** Add the SQLite store directory, `pending/` and the control directory to the agent path denylist |
| `app_front/lib/sdk-chat-history-store.js` | - | Treat an epoch/generation change as cache invalidation; persist the queue producer and the pending items |

Startup of the runtime must happen before any caller: `openChatHistoryRuntime` (marker
-> coordinator -> worker host + barrier -> `activate` -> `guardHost` -> recovery).

## What works and what is missing before cutover

Works (tested on synthetic data with real worker threads and worker-thread exits injected before and after COMMIT):
parity with the legacy backend for a scripted conversation (seq, gaps, coalescing, pages,
usage, fork, delete, list, notices); strict plan, staging import, crash/resume,
logical verification; metadata round trip (cursor, document and event extras, `updatedAt`)
through new writes, reset, fork and delete; migration 0004 on an imported v3 store;
64-256 KiB records through the group committer, 256 KiB-3 MiB records through the fragment protocol and the 3 MiB refusal; lost reply
(worker killed after COMMIT) and pre-COMMIT crash resolved without a duplicate; pending
commands replayed after a restart; stale epoch/generation, fenced producer, taken-over
owner and restore pause refused; rollback export after new ACKs served read-only with
receipt/dedupe lookups and tamper/stale-store refusal; marker transitions.

Missing (not claimed): the operational cutover and the fence/pause operator procedure
(stage 3); a writable legacy rollback (deliberately not offered); a
restore tool; a throughput benchmark of the adapter write path; a physical-disk fault
rehearsal (not reproduced - process kill only); the independent re-review of the F29
barrier recorded in `chat-history-store.md`; and the startup gate, which stays FAIL under
the recorded exception in [storage-gates.md](storage-gates.md). The live copy of any real
history directory and the production backup procedure are separate decisions.

## Stage 2b and the stage-3 operation (stage 2b complete; stage 3 prepared, not applied)

`openChatHistoryRuntime` fails closed when startup recovery leaves unresolved commands:
`history_recovery_unresolved` is thrown after the normal cleanup, the pending entries stay on disk
and no adapter (no READY, no ACK) is returned. The prepared cutover operation (backup evidence,
strict quiesced source plan, staging import, verify, atomic code apply with checkpoint, store
publication, coordinator-lease marker selection, pre-ACK rollback, post-check and rollback
rehearsal) is described in [storage-pre-cutover-runbook.md](storage-pre-cutover-runbook.md#stage-3-prepared-cutover-status-2026-10-19-prepared-not-executed).
It has been exercised on synthetic data only; production still uses the legacy backend.

## Verification

```bash
node --test tests/storage-history-import.test.js tests/storage-history-rollback.test.js tests/storage-history-cli.test.js tests/storage-history-lossless.test.js
node --test tests/storage-history-adapter.test.js tests/storage-history-adapter-rollback.test.js tests/storage-history-adapter-runtime.test.js tests/storage-history-adapter-r2.test.js
node --test tests/storage-chat-history-store.test.js tests/storage-db-lifecycle.test.js tests/storage-coordinator.test.js
node --test tests/storage-history-cutover.test.js tests/offline-snapshot-hook.test.js
node --test tests/storage-history-large-records.test.js
node scripts/storage-large-record-probe.mjs --rounds 7   # synthetic latency/queue/event-loop probe, informational
```

## Large records (256 KiB - 3 MiB)

Why: a read-only metadata preflight of the real legacy source (2026-10-19, not quiesced,
therefore informational) found 4,718 compatible histories (895,740 events, 1.655 GB) plus 81
histories (37,443 events) holding 128 records above 256 KiB: 83 between 256 KiB and 1 MiB, 45
between 1 and 4 MiB, the largest 2,686,612 bytes, none above 4 MiB, and no other strict refusal.
Legal user data therefore must not be refused by the migration, and nothing may be cut or only
the compatible chats migrated. The fix is a bounded, lossless path - not larger limits.

**Limits (unchanged):** regular command 64 KiB, single-event command 264 KiB, group batch
256 KiB, worker request and result 4 MiB, inline record 256 KiB, pending queue/time bounds, F29
barrier. **New, separate:** `HISTORY_MAX_LARGE_RECORD_BYTES` = 3 MiB (stored wire JSON including the
store-added `clientSeq`; 2,686,612 B fits with ~450 KiB spare), 32 KiB raw fragments (43,692
base64 characters, far below the 64 KiB command budget), staging quota (4 stages / 12 MiB per
chat, 64 stages / 64 MiB total), at most 96 fragments per record. A record above 3 MiB is
refused whole before anything is recorded (`history_record_too_large`, `commitState:
'not_committed'`, the caller still holds its input).

**Offline import / rollback export:** the strict reader's record cap is the large cap, so the 81
histories are accepted verbatim (the importer inserts rows directly; no fragments are involved,
staging stays empty). Unknown keys, sequence gaps, `headSeq`, extras and `clientSeq` are
preserved exactly as for small records; the rollback export streams the same rows back through
the same strict reader. `planRollbackExport.totals.uncommittedStagedRecords` reports staged
fragments that never finalized; the export ignores them (they are not history).

**Live write path (adapter):** `appendChatHistoryEvents` measures every record with the widest
`clientSeq`. Above 256 KiB the record becomes ONE pending entry of operation `appendLarge`
(whole record, one fsync, pending entry limit 3 MiB + 64 KiB for this operation only) inside the
usual logical batch. Dispatch derives deterministic commands from the entry's `commandId`:
`<id>.f<i>` = `stageFragment` (six in flight, each its own receipt), then `<id>.z` = the
finalizing `appendEvents`. A retry (`retryToken`, lost reply, restart `recoverPending`) first asks
for the `.z` receipt; if it exists the record is answered from it, otherwise the identical
fragment commands are re-driven (receipts make committed ones no-ops). The batch is acknowledged
and removed only after the post-commit `readStored` succeeded, exactly like small batches.
Consequences: fragments are invisible until the single finalizing transaction; crash before the
receipt leaves staging that the next retry completes; crash after the receipt leaves nothing to
redo; an epoch reset removes the stage and the retry is `history_stale_epoch` (plan dropped
durably); a quota refusal is retryable, happens before any ACK and keeps the caller's input.
`backend.gcLargeStaging({ olderThanMs })` runs `gcSupersededStages` and abandons stages of this
adapter's server producers that no pending entry references and that are older than
`olderThanMs` (default 1 h); browser-queue stages are never aged out because their pending input
lives in the browser.

**Reads:** unchanged APIs. One finalized record always fits one worker result; pages and
`readSeqs` are byte-paged (a page may carry fewer events and says `hasMore`), full loads keep
their explicit 32 MiB and copies their 64 MiB caps - nothing is silently shortened.

**Fork / trim / reset / rollback:** `copyChat` copies large rows byte for byte under its 64 MiB
ceiling; `trim` and retention drop whole rows; `reset`, `deleteChat` and a replaced fork target
delete the chat's staging; new large writes after cutover are part of the read-only rollback
export.

**Schema delta and prerequisites:** forward-only migration 6 (`chat_history_stage`,
`chat_history_stage_fragment`). Any store built by an earlier tool at schema 3-5 is upgraded when
opened by the runtime/importer; `planRollbackExport` supports exactly the current schema (6), so
stores must be opened (migrated) once by this build before an export. A binary older than this
migration refuses a v6 file. Pending buffers written before this change stay valid.

**Honest limits / risks.** Probe `scripts/storage-large-record-probe.mjs` (synthetic data, WSL2 ext4,
7 rounds per size, durable pending buffer and group committer; one run, informational, not a gate):

| Record | Fragments | Adapter write p50 / p95 | Read p50 | Response bytes | Main-thread loop delay max |
| --- | ---: | ---: | ---: | ---: | ---: |
| 256 KiB + 1 | 9 | 148 / 160 ms | 4 ms | 262,618 | 6 ms |
| 1 MiB | 32 | 202 / 224 ms | 9 ms | 1,049,051 | 8 ms |
| 2,686,612 B | 82 | 367 / 407 ms | 23 ms | 2,687,087 | 20 ms |
| 3 MiB cap | 96 | 414 / 445 ms | 28 ms | 3,146,203 | 21 ms |

Every response stays below the 4 MiB worker result; the event-loop max stays inside the 100 ms
budget (no p99 verdict from a probe). With a 2.7 MB write running, 8 lanes of small appends saw
p95 ~213 ms against ~70 ms quiet (about 3x): the single worker serves the fragments in between.
Worker queue age over the whole probe: p99 25 ms, max 32 ms; execute p99 46 ms, max 66 ms; no
busy rejection, expiry or worker loss. These are measurements on one machine, not gate
results - the four production workloads are **not** re-run here (no production caller exists;
stage 2b) and no PASS/FAIL gate result was changed. Main-thread cost per large write (stringify,
SHA-256, base64) is the ~20 ms stall above; `readUsage` still parses only usage-class events.
Production migration is not done and the startup waiver is untouched.

## R5: partial-plan recovery and bounded record/ack admission (implemented, not wired)

**Recovery of a partial plan (R4-P1).** A failed record (rename failure on index 0, cleanup
failure on index 1) or a failed cleanup can leave a pending file set that has the shape of an
interrupted acknowledgement (a suffix) although nothing was dispatched. `recoverPending()`
therefore no longer treats a suffix as acknowledged by shape: it looks up the committed receipt
of EVERY remaining fragment (read-only `resolveUnknown`). All committed -> the suffix is
acknowledged (a real interrupted ACK). Any fragment not committed -> the whole group is moved to
quarantine as `batch_suffix_unproven` (data preserved for the operator). A lookup error leaves the
fragments pending and reports them as `unresolved`. No new file format; schema 1-6 untouched.
Operator reconcile of a quarantined plan: inspect `quarantine/`, compare with the chat history and
re-send the input if it is absent; no automatic replay happens, so no duplicate can be created.

**Retry identity.** `history_cleanup_uncertain` from the record phase now carries the stable
logical `batchId` / `retryToken`. Only files that may still exist (cleanup failed) or, when the
directory could not be proven durable, every touched file stay indexed and fenced; a file whose
rename never happened is not indexed. If the plan is incomplete the retry token is refused
(`history_batch_unknown`): an unsafe replay is never driven and new ids are never accepted after
the uncertainty. The in-memory fence (`uncertainIds`) is not durable; a restart is not proof,
recovery decides by receipts as above. An unexpected exception while settling a group runs the same
prove-or-fence cleanup (it used to reject without the directory sync).

**Admission (R4-P2).** `recordMany` snapshots the input synchronously (private, frozen), then
reserves its entry count and bytes (wire bytes + 512 B header allowance) against
`index + reserved <= maxEntries (4096)` and `<= maxTotalBytes (64 MiB)` BEFORE the snapshot is
queued; over quota it rejects with `history_pending_full` (`commitState: not_recorded`) and the
caller's input is untouched. The reservation is released when the request settles (published to the
index, or refused). A single request larger than the quota is refused the same way. The ACK queue
holds at most `maxEntries` ids; a refused ACK (`history_pending_full`, `committed_unacknowledged`)
loses nothing - the pending file and the receipt stay for a later ACK or recovery. The first request
of a record group may exceed the group entry/byte bounds (explicit exception); the quota still applies.
Entry caps, regular 256 KiB / large 3 MiB / command 64 KiB limits and the 40 ms window are unchanged.

**WAIVER (user, R5).** The handler p95/p99 targets, startup and the full 4-workload benchmark are
deferred to AFTER the live cutover; the medium I/O test and all non-performance prerequisites stay
required BEFORE live. Production still runs the legacy backend; physical disk failure is not certified.
