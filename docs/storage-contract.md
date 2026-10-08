# Shared storage contract

Status: amended design after the Opus 5.5 review, not implemented behavior.
Owner: persistence TODO A1 (`7a287da9-a8ce-4058-8379-3dde2e4a0504`).
Consumer: backup TODO B1 (`5cf09e77-8278-497e-bd97-91227686ac06`).
Related designs: [persistence](persistence-design.md),
[settings and backups](settings-backup-design.md).

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

The new storage/backup feature requires Node at least 22.16 and a supported bundled
SQLite with applicable correctness fixes; A1 records and tests the exact matrix.
Update the package/runtime checks in A2/B4 before using native backup APIs. Existing
installation export must return a typed unsupported-runtime result on older Node,
not fall back to copying a live SQLite main file.

Corrupt source histories are quarantined with raw-byte digests and an explicit
report. Never append over a corrupt history as a new empty document. Migration and
backup fail for a selected corrupt store; repair or explicit exclusion is a separate
operator action. The usage journal remains authoritative unless A1 measurements
justify its migration; its existing fsync/CRC/idempotency/retention and accounting
totals remain part of every backup and acceptance contract.
