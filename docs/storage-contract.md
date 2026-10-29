# Shared storage contract

Status: amended design after the Opus 5.5 review, not implemented behavior.
Owner: persistence TODO A1 (`7a287da9-a8ce-4058-8379-3dde2e4a0504`).
Consumer: backup TODO B1 (`5cf09e77-8278-497e-bd97-91227686ac06`).
Related designs: [persistence](persistence-design.md),
[settings and backups](settings-backup-design.md),
[archive profiles (B1)](backup/archive-profiles.md).

## Registry and dependencies

There is one versioned registry, proposed as `lib/storage/store-registry.js`,
owned by A1 and consumed by both migration and backup. This document is its initial
contract. A1 produces the concrete inventory and baseline report before implementation
of either project; B1 adds archive schemas without duplicating the inventory.

Each registry entry specifies: stable store ID, domain owner, backend/schema version,
managed relative paths, bootstrap/backend markers, every writer and lock acquisition
order, buffered writes, secret-field classification, dependencies, strict raw-source
validator, logical export adapter, snapshot/flush strategy, restore/migration adapter,
durability/ACK contract, cache invalidation and automatic execution hooks. Include
recovery queues and retained usage journals even when their backends are unchanged.
Unknown writers, path aliases or unresolved transactions fail the snapshot capability
check instead of yielding a supposedly complete archive.

B1 adds three archive profiles on top of this registry (details in
[archive profiles](backup/archive-profiles.md); schemas in `lib/backup/schemas/`):

1. **`portable-settings-v1`** — versioned JSON with classified fields and explicit
   omissions; not a raw `config.json` dump.
2. **`conversations-v1`** — ZIP manifest plus JSON history payloads and optional Markdown
   (Markdown is never executable configuration).
3. **`data-backup-v1`** — ZIP with versioned `manifest.json`, random archive ID, per-member
   SHA-256 digests, persistence backend/schema markers, record counts and omissions.

Backup consumes one registry: export adapters, flush/lock participation and restore
capability checks reference the same store IDs and lock order. B1 defines the manifest
contracts and validation layer; A1 remains the sole registry implementer.

Dependency graph: A1 → B1 → B2 → B3 → B4 (offline recovery) → B5 → B6 → B7.
Separately, A1 plus its go/no-go record → A2 → A3a (history). A3b (metadata)
requires A3a and B4's verified offline recovery. A4 → A5 → A6 follows A3b.
B7 integrates the selected backend and approved A slices; if A stops at standardized
stores, B remains implementable on those stores. B2/B3 never depend on full migration.
These are explicit acceptance dependencies, not automatic TODO approval or execution.

## Backend decision and synchronous callers

A1 compares: current JSON/caches; incremental SQLite with bounded main-thread calls;
incremental SQLite in a worker. Use the same workloads, retention and FULL durability.
Freeze numerical latency, event-loop, queue-age, I/O and complexity budgets after
baseline and before selecting a variant. Adopt only a variant meeting correctness
and durability gates, interactive/critical-command budgets and measured I/O benefit.
Select the simpler passing variant when the worker adds no measured responsiveness
benefit. If neither SQLite variant meets the gates, stop consolidation and retain
standardized stores; B continues through the same adapters. No forced optimization
rounds or weakened durability to manufacture a passing result.

Inventory all synchronous callers and read-modify-write critical sections. Keep a
domain on its legacy synchronous adapter until its callers and whole atomic commands
are converted together. There is no synchronous facade waiting on a worker, no
`Atomics.wait` on the HTTP/WS thread, and no lock held across unrelated `await` calls.
If main-thread SQLite wins, measured maximum synchronous operation duration applies;
bulk backup/migration stays outside the interactive event loop.

## History operations and acknowledgements

Persist command receipts with `(datasetGeneration, commandId, requestDigest, result)`
in the same transaction as inserts, coalesced updates and history revision. Retrying
the same ID/digest returns its committed result; the same ID with another digest
fails. Generate IDs before dispatch and retain them on timeout/retry. Worker loss
after COMMIT cannot append a delta again. Preserve the mapping of every input record
when coalescing; do not silently drop deduplication identities.

Client record identity is `(datasetGeneration, chatId, producerId, clientSeq)`.
`producerId` is a random persisted queue identity, rotated only with a new queue
epoch; it is not a fingerprint. Multiple tabs coordinate sequence allocation
transactionally. Server streams use an explicit run/attempt producer and stable
operation IDs. Receipts survive event trimming for the chat's lifetime. An explicit
producer retirement may remove receipts only after requests from that producer
are fenced. A previously accepted, pruned record returns an already-accepted receipt,
not a fabricated new event.

Protocol-v2 writes require generation and producer identities. Old clients and
legacy queues without them cannot silently append after rollout: return a typed
upgrade/reconciliation response and preserve unsent content. Migrate historical
`clientSeq` as legacy metadata, not a guessed global uniqueness key. User-reviewed
reconciliation of a legacy queue creates new v2 identities; it is not automatic
replay and does not claim historical deduplication certainty.

Display-only stream updates may be provisional. Client accepted-record ACKs, server
persisted-history notifications, final-run durable completion and executable intent
ACKs occur after commit. Keep stream buffers until their receipt commits; failures
retain/retry with stable IDs and report persistence failure. Group-commit stream
batches under frozen byte/time limits; prioritize Stop, claims, intents and final
flush, without starving ordinary writes. FULL remains the default. Tests distinguish
provisional UI from acknowledged state; SIGKILL is not a power-loss simulation.

History revision increments on coalesced changes as well as new events and is
durable within a `(datasetGeneration, chatEpoch)` pair. Replacing/resetting history
rotates the epoch; recovery rotates the dataset generation outside the restored
payload. Old numeric revisions are never compared across these pairs.

## Maintenance and recovery control

Use one maintenance coordinator for migration and online backup. Bootstrap locates
its control directory outside all restore-managed paths, even when the data directory
is a mount point. Persist the maintenance lease, external fence/generation, restore
pause and recovery journal there; archives do not replace them.

Acquisition sequence: acquire coordinator lease; gate all registered mutation/run
entry points, including HTTP, WS and subprocess writers; wait for active mutations;
defer if provider work cannot drain safely; flush buffers without clearing failed
writes; acquire each store lock in the registry's fixed order; resolve journals;
verify owner/fence tokens; create the bounded snapshot. Release store locks and
gates after staging, before compression. Always release on failure; a failed flush
publishes no backup. A1 fixes time/event-loop budgets and lock order; B6 enables
online copying only after every participating writer honors the coordinator.

MVP full backup and restore are offline. Their CLI acquires exclusive instance and
store ownership, verifies managed processes are stopped and cleanly flushed, and
refuses an active or unknown writer. Per-file hard links are optional only for files
verified immutable after publication; append journals and SQLite use their own
snapshot strategy. Copy SQLite with a supported backup API or a cleanly closed
database; run `integrity_check` and `foreign_key_check` on staged copies.

Open-time checks: header, schema-history and `foreign_key_check` always run. The
O(size) `integrity_check` runs unless a valid `<db>.clean` marker vouches for the
file. The marker (main file size, mtime, `lastFullCheckAt`) is deleted by every open
and rewritten only by a close that was not abandoned and not tainted by a corrupt,
I/O, full-disk or unknown-commit failure. The full check is forced when the marker
is missing, malformed or mismatched, `-wal`/`-journal` is non-empty, `lastFullCheckAt`
is older than 7 days, `fullCheck: true` is passed, or `CRETLI_STORAGE_FULL_CHECK=1`
is set. Whenever the check runs, a corrupt store is refused as `corrupt`; corruption
that keeps size and mtime unchanged is caught by the periodic (7-day) check.

Restore replaces only registered managed paths and their backend markers. Preserve
auth/TLS/harness homes, control directory, backup destination and unknown unrelated
files. Stage and rename on each destination filesystem; never assume the entire
data root or a mount point can be renamed. A durable per-path roll-forward journal
tracks prepared/replaced/verified actions; startup completes recovery before opening
stores or launching any automatic work. Verified previous files support explicit
rollback/reconciliation. Unsupported schemas fail before replacement.

Pre-migration archives restore their original backend markers and approved schemas
through registered legacy readers; then supported forward migrations run while
paused, against the restored content. Never interpret an old JSON marker as a new
empty SQLite database, ignore a bootstrap override, or reopen an incompatible
backend. If no matching reader/migration exists, fail during preview. Rollback after
new writes requires reconciliation, not an old snapshot.

Server writes, including history HTTP/WS and offline replay, reject missing or stale
generation after the protocol rollout. Restore allocates a fresh external generation
and advances recovery fencing beyond both the snapshot and external high-water mark;
old ownership tokens and callbacks cannot become valid again. Preserve offline
queues for explicit reconciliation rather than stamping them with the new generation.

## Execution and runtime boundaries

Every imported executable or external connection definition (MCP command/args/env,
executable path, endpoint URL) starts disabled, even when its plugin is installed.
Preview displays the definition; separate explicit activation is required. Import
does not probe endpoints or install/run code. The external restore pause is enforced
by watcher/Scout, run recovery, mailbox/outbox, title/archive background work, backup
scheduler, push delivery and MCP auto-start. Offline restore tests observe zero
spawned processes and zero outgoing push; independent approved actions can resume
only through explicit re-enable controls.

The new storage/backup feature requires Node at least 22.18 and a supported bundled
SQLite (>= 3.51.0, `MIN_STORAGE_SQLITE_VERSION`) with applicable correctness fixes; A1 records and tests the exact matrix.
Update the package/runtime checks in A2/B4 before using native backup APIs. Existing
installation export must return a typed unsupported-runtime result on older Node,
not fall back to copying a live SQLite main file.

Advisory re-check (2026-10-23): `MIN_STORAGE_SQLITE_VERSION` 3.51.0 was re-checked
against the upstream SQLite release history and the CVE list published at
https://sqlite.org/cves.html (see also https://sqlite.org/changes.html); no
advisory affecting 3.51.0 and later was identified there, so the minimum stays
3.51.0. Re-run this check whenever the minimum or the tested Node pair changes.
Node floor: `engines.node` (package.json), `runtimeMatrix.enginesNode`
(docs/storage-registry.json) and `MIN_STORAGE_NODE_VERSION` must agree;
`tests/storage-runtime-check.test.js` fails on any mismatch, and
`scripts/start-server-node22.sh` exits with an error on an older Node.

Corrupt source histories are quarantined with raw-byte digests and an explicit
report. Never append over a corrupt history as a new empty document. Migration and
backup fail for a selected corrupt store; repair or explicit exclusion is a separate
operator action. The usage journal remains authoritative unless A1 measurements
justify its migration; its existing fsync/CRC/idempotency/retention and accounting
totals remain part of every backup and acceptance contract.

## Protected-class queue expiry retry

A request of a protected priority class (`stop`, `claim`, `intent`, `final`) whose queue wait expires is re-queued
by the worker host up to `protectedExpiryRetries` times (default 3). It never ran, so this is safe. Every re-queue
restarts the full `deadlineMs` window: the total wait can reach (1 + retries) x the caller's `deadlineMs`. `normal`
requests are never retried and still shed. Delegation mailbox (ack/report) history cards are submitted as `final`
(`MAILBOX_HISTORY_PRIORITY` in `lib/delegation-mailbox.js`, forwarded through `callOptions.priority` of
`appendChatHistoryEvents`).

## Todos SQLite backend, marker, migration, rollback

Implements ADR [storage-todos-worker-decision.md](storage-todos-worker-decision.md) sections 3 and 5 for
`store.todos`. **Production is not switched**: nothing in the server calls `openTodosRuntime`, and the
marker is written only by `scripts/migrate-todos-to-sqlite.js --apply`.

**Backend marker (`<dataDir>/todos-backend.json`).** Absent = legacy JSON (`todos/<key>.json`). `sqlite` =
exactly the named store (`todos.sqlite`, bound to the marker's dataset generation); a missing or empty
file, an unbound file or a generation mismatch is an error (`todos_store_missing`, `todo_store_unbound`,
`todo_generation_mismatch`), never an empty store and never a fallback to JSON. `legacy-rollback` = legacy
JSON over a verified rollback export whose manifest hash the marker pins. An unreadable or inconsistent
marker refuses (`todos_marker_invalid`). Writes are compare-and-swap on `revision`.

**Facade backend (`lib/persist/todos-backend-sqlite.js`).** Each mutation runs the unchanged legacy domain
function on a private overlay (a scratch copy of the workspace document), diffs the result against the
committed document and submits one worker transaction (`todos.batch`, or `todos.importDocument` for a
reorder/oversized diff) with per-item `expectedUpdatedAt` CAS and a document-level CAS. The shared
committed cache, the autopilot nudge and the facade's success all follow COMMIT; the cache entry is
invalidated after every command and rebuilt from the committed rows after a restart. Reads never wait for a
pending write. A CAS conflict against another writer re-runs on fresh state (3 attempts) and then rejects
with `CONFLICT`. `moveTodo` is one transaction (source rows, target rows, both document revisions, receipt).

**Known limits (reported, not hidden).**
- `commitWatcherTodoCommand` spans the watcher JSON document and the SQLite todo, so it is a staged,
  version-checked protocol: check the watcher row, commit the todo transaction, write the watcher row under
  its file lock with the same CAS, and on rejection compensate the todo with the inverse operations (CAS'd on
  the version just committed). No file lock is held across an `await`. A process crash between the todo
  commit and the watcher write leaves the todo change without the watcher write: there is no SQLite-side
  journal yet.
- Reads and mutations still materialise a whole workspace document on the main thread on a cache miss
  (the cache is keyed by the worker's document revision, so an unchanged workspace is not re-read). The
  indexed `todos.list` page is not what the facade's `listTodos` returns, because callers need full items.
- The group committer is not used by this backend (one worker transaction per command).

**Migration (`scripts/migrate-todos-to-sqlite.js`).** Offline, writers stopped. Plan (default / `--dry-run`)
writes nothing and prints the manifest (SHA-256, bytes, items, idempotency keys per file) and a plan hash.
`--apply --confirm-plan <hash>` imports into a new staging store, re-opens it read-only and verifies
workspace set, per-workspace counts, item IDs and order, `parentId`/`siblingIndex`, per-item field sets
(unknown fields) and the canonical hash of every exported document against the source; re-hashes the sources
(a changed source voids the run), publishes the closed store and only then writes the marker. The JSON files
are left byte-identical and made read-only.

**Rollback.** Before any durable ACK of the sqlite backend the original JSON still equals the store and is an
acceptable rollback source. After the first ACK (a command receipt, or documents that differ from the
imported ones) a plain JSON backup would lose writes and is rejected (`todos_rollback_source_stale`). The
tool `rollback-export` writes a fresh logical export (strict legacy documents) plus
`rollback-control/` (manifest with the store fingerprint, all receipts, fencing high-water mark); it hashes
the store before and after. `rollback-activate` verifies the export against the current store (a later write
makes it stale, `todos_rollback_export_stale`), preserves the previous `todos/` directory, installs the
export and selects `legacy-rollback`; the legacy runtime then starts only if the export still verifies
against the manifest hash pinned in the marker. `plainLegacyBinaryCompatible` is false: an older binary does
not read the marker and must not be pointed at these documents.


**Rollback runtime is sidecar-aware** (`lib/persist/todos-backend-rollback.js`). Under the `legacy-rollback`
marker `openTodosRuntime` needs an owner `fence` epoch strictly above the recorded high-water mark (the mark
is raised to it and never lowers; every mutation re-reads it and a fenced-out older owner is refused,
`todos_rollback_fenced`). Startup verifies the pinned manifest, the export documents and receipts, the
`todos-rollback-state.json` ledger (written by `rollback-activate` before the marker) and that every live
`todos/<key>.json` hashes as the last committed state; a modified, missing or extra document, a missing
ledger or a tampered manifest/receipts file fails closed. `backend.command({ datasetGeneration, commandId,
requestDigest }, method, args)` returns the recorded result of a sidecar or earlier receipt (digest must
match) without re-applying it. Every facade mutation goes through one choke point; `store.withCommand({ commandId, requestDigest }, fn)`
(AsyncLocalStorage) gives the mutations inside `fn` a command identity (a batch gets one ledger entry per
operation). Open, fence publication and each (fence re-check, mutation, ledger write) run under one
cross-process lockfile (`todos-rollback-state.lock`, stale owners taken over). Gap: existing production
callers do not pass a command id yet, so they have no ledger entry; a crash between a document write and the ledger update fails closed at the next start.
