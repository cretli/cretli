# Unified persistence for Cretli

Status: amended after the Opus 5.5 review; not implemented or independently
re-reviewed. Shared decisions: [storage contract](storage-contract.md). Related work:
[settings, exports, and backups](settings-backup-design.md).

## Recommendation and evidence

Standardize repository contracts first, then select a measured implementation.
The preferred candidate consolidates related state into local `cretli.sqlite`;
the baseline can retain standardized stores or choose bounded main-thread SQLite
when a worker adds no measured benefit.
Keep domain-specific tables and services. Store attachments as files with database
metadata; keep credentials and installation authentication outside the ordinary
application-data export. JSON remains the portable exchange format.

The recommendation is based on the current implementation, not measured speedups:

- `chat-history-persist.js` loads a chat document, maintains idempotency and stream
  coalescing, and rewrites the entire document for an append batch. Caching reduces
  reads but does not remove this write amplification.
- `chats-persist.js` rewrites the chat collection. TODO documents have per-workspace
  locks; other stores have different locking, caching and error policies.
- `atomic-write.js` uses temporary-file rename, without an fsync durability protocol.
  Rename avoids partial-file visibility; it does not provide a multi-store transaction
  or prevent lost updates in an uncoordinated read-modify-write operation.
- Delegations already have a SQLite backend and migration support. Recovery has its
  own `recovery.sqlite` and durable intent/queue semantics. Preserve those guarantees
  when consolidating; merely colocating their files gives no shared transaction.
- Usage has a journal and derived index. Preserve accounting/idempotency semantics
  when changing the backend, rather than recomputing history under current prices.

SQLite WAL supports concurrent reads with a serialized writer and requires a local
filesystem on one host. Multiple database files in WAL mode do not provide one atomic
commit across the files. These boundaries fit the proposed local Cretli deployment.
See [SQLite WAL documentation](https://www.sqlite.org/wal.html).
Deployments requiring sustained writers on multiple hosts need a separate server
database design and measurements; do not put the SQLite file on shared network storage.

## Storage boundaries

| Category | Target | Reason |
| --- | --- | --- |
| Workspaces, settings without credentials, named snapshots, sidebar | SQLite domain tables/versioned settings sections | Stable identities, revisions, coherent reads |
| Chat metadata, retained history, title history | SQLite rows with indexed chat/sequence keys | Incremental writes and bounded history queries |
| TODOs, watcher/Scout state, memory, delegations, recovery, mailbox/outbox | Same database, separate domain tables | Transactions for linked state and execution claims |
| Usage events and accounting projections | Existing journal by default; migration only after a justified measured gate | Preserve fsync, CRC, idempotency and historical accounting |
| Model decisions/ratings | Indexed domain tables if consolidation passes | Bounded summaries and retention |
| Attachments and generated large archives | Immutable files; metadata/checksums/jobs in SQLite | Avoid inflating row queries and database snapshots |
| Cretli-managed secrets, login/session signing keys, TLS, provider auth | Explicit separate credential/auth storage | Different permissions and export/restore boundaries |
| Browser IndexedDB/localStorage | Local cache, queue and device preferences | Preserve offline use; server remains authoritative |
| Process bootstrap | Environment/minimal bootstrap configuration | Locate/open database before settings are available |

Credentials separation is an export and access boundary, not an assumption that
chat content or operational payloads are secret-free. Regular database snapshots
may contain prompts. Encrypt copies when appropriate and keep decryption keys
outside them. Credential references remain opaque in ordinary settings.

## Schema and repository contracts

Use SQL columns for identity, relations, state, sequence, time, revisions and fields
used in queries. Allow validated, versioned JSON payloads for heterogeneous provider
events and plugin settings. Do not recreate one giant JSON document in a single row
or a universal entity table requiring scans for ordinary UI queries.

Proposed modules under `lib/storage/`: database lifecycle, worker protocol, migration
registry and shared error types. Domain repositories expose narrow asynchronous
operations in the worker variant; routes, MCP, schedulers and harnesses do not access
filesystem stores or SQL directly. Legacy synchronous APIs stay on their backend
until their callers and atomic commands migrate together. No synchronous facade
waits on a worker. Inventory critical sections and convert each into one transaction;
do not hold a legacy lock across unrelated awaits.
Avoid a generic ORM rewrite unless a concrete requirement justifies it.

Contracts include validated inputs, explicit missing/corrupt/I/O/conflict outcomes,
idempotency scopes, expected revisions/CAS, pagination, commit acknowledgement and
post-commit notifications. One command executes its whole transaction on one
connection. A worker message must not leave a transaction open for the main thread
to continue it later. Cancellation/timeout after submission can have an unknown
commit result; use idempotency lookup before retrying.

Use stable workspace IDs with paths as mutable metadata. Preserve existing IDs,
history sequence numbers, parent/child links, idempotency records and execution
fences during import. Migrate path-derived keys through a verified mapping table.
Add foreign keys, uniqueness and CHECK constraints consistent with existing domain
semantics; deletion must not cascade into usage records required for accounting.
All connections enable foreign-key checks; validate them after migrations.

Example transaction boundaries: claim TODO plus record run intent; complete a
delegation plus enqueue its report; append persisted history plus update its revision.
Publish WebSocket updates after commit. External agent launch and socket delivery
are not SQL transactions: retain durable intent, outbox, fencing and deduplication.
Do not claim exactly-once external execution solely because the database committed.

## Responsiveness and durability

The preferred candidate runs SQLite in a worker with a bounded request queue. Native
`DatabaseSync` calls are synchronous; moving them to that worker protects the HTTP/WS
event loop. Start with one owner connection and prepared queries; add read connections
only if measured benefit outweighs snapshot/cache coordination complexity. A1 compares
this with incremental SQLite on the main thread and current JSON. Adopt only a variant
passing correctness, durability, latency/event-loop and I/O gates. Select the simpler
passing variant or stop consolidation if neither passes; export/backup still proceeds
through standardized adapters.
See [Node.js SQLite API](https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html).

- Keep transactions short; no network calls, archive compression, provider execution
  or large payload formatting inside them. Bound batches by both bytes and duration,
  with fair scheduling so transcript streams cannot starve claims/Stop/intents.
- Insert new events or update only the current coalesced stream record; query history
  with indexed keyset pagination. A coalesced update can retain its sequence number,
  so persist a revision independent of the last sequence and notify accordingly.
- Use durable append command IDs, payload digests and receipts in the same transaction
  as coalesced updates/revisions. Resolve uncertain commit results by receipt before
  retry. Preserve every input identity; retry after COMMIT must not append delta twice.
- Deduplicate by generation/chat/producer/client sequence, not chat/client sequence.
  Receipts survive trimming until chat deletion or fenced producer retirement.
  Upgrade legacy queues through explicit reconciliation and reject unnamespaced
  writes; historical counters remain legacy metadata. Exact keys are in the contract.
- Acknowledge durable records only after commit. Stream display can be provisional;
  accepted client records, persisted-history notifications and final completion cannot.
  Retain failed-flush buffers, retry stable operation IDs and group-commit under frozen
  byte/time limits with bounded priority for Stop, claims, intents and final flush.
  Initial migration preserves retention behavior. Any change to retained history
  limits is a separate, explicit policy decision.
- Use WAL and `synchronous=FULL` as the default for all application-state commits.
  `NORMAL` can lose recent committed transactions on power loss; benchmark FULL
  with batching before considering any weaker, explicit durability option.
  See [SQLite synchronous modes](https://www.sqlite.org/pragma.html#pragma_synchronous).
- Bound busy retries/deadlines off the main thread. Preserve fencing and ownership
  checks even with one worker because maintenance tools/other processes may connect.
- Monitor queue age, commit/query latency, event-loop delay, busy failures and WAL
  growth. Schedule bounded checkpoints and maintenance; do not hold long read
  transactions during downloads. Caches have size limits and revision-based invalidation.
- Verify supported Node and bundled SQLite versions, backup/timeout APIs and upstream
  correctness fixes. The new feature requires Node at least `22.16`; A2 updates
  package/runtime checks and the compatibility matrix. Unsupported installations
  receive a typed feature error, never a live main-file copy fallback.

## File lifecycle and backup consistency

Publish attachment content to immutable storage before committing its database
reference; a failed commit leaves an orphan eligible for later cleanup. Removal
and garbage collection honor references and backup pins, with recovery checks for
missing files. SQL transactions alone cannot commit filesystem changes atomically.

A verified SQLite backup captures a coherent database generation. Build its archive
manifest from that copied database and pin the referenced immutable attachments
until packaging finishes. Attachment retention cannot delete pinned files. This
avoids keeping a read transaction open throughout compression/download. Use the
[SQLite backup mechanism](https://www.sqlite.org/backup.html), not a copy of a live
main database file without its committed WAL state.

During migration, some categories still live in legacy stores. Database snapshot
consistency does not extend to those stores: keep the cross-store barrier or stopped
server backup protocol until all categories in a backup share the new contract.
Settings/chat exports use logical repositories, so their format is independent of
backend. Full snapshots apply the credential and paused-execution recovery rules
in the backup design; restoring a database must not restart pending commands.

## Migration and rollout

1. **Baseline and contracts (A1):** own the shared registry and caller/critical-section
   inventory. Compare JSON, bounded main-thread SQLite and worker SQLite; freeze
   budgets and record go/no-go. B1 consumes the same registry.
2. **Infrastructure (A2):** implement the selected passing variant, runtime checks,
   atomic commands, stable IDs and migration framework. Stop consolidation when
   the gate selects retaining standardized stores; no forced worker conversion.
3. **Pilot (A3):** sequential children A3a history and A3b chat metadata. A3a tests
   incremental writes, command receipts, producer-scoped dedupe, generations and
   latency. A3b requires A3a and B4 offline recovery, and audits session IDs/callers
   separately. Keep legacy metadata authoritative during A3a.
4. **Operational state:** move TODO, watchers/Scouts, recovery and delegation-related
   tables in coordinated slices. Enable a cross-domain transaction only once all its
   writes use one connection. Preserve external effect protocols and FULL durability.
5. **Remaining state:** settings/snapshots, memory/sidebar and model decisions;
   integrate attachments and backend-independent exports. Keep usage on its journal
   unless a separate measured gate justifies migration.
6. **Cutover and acceptance:** recovery drills, concurrent/crash tests, dataset
   generation changes, operator documentation, and removal of legacy active writers.

Each slice uses maintenance mode/drained writers, a source backup, strict validation,
and a staged destination. Verify full-content digests, counts, identities, references,
schema versions and accounting totals before switching a durable backend marker.
The migration is resumable/idempotent. Never leave two authoritative writers or
acknowledge writes that only reached the legacy shadow copy.

Quarantine corrupt histories with raw-byte digests; selected corrupt sources fail
migration/export until repaired or explicitly excluded. Preserve recovery fencing
against the external control high-water mark and reject stale callbacks. Persist
revisions within generation/chat-epoch; restore rotates generation outside copied
data, and the server rejects stale or missing generations after protocol rollout.

Rollback after new writes requires reverse export/reconciliation or a forward repair;
switching back to the pre-migration JSON copy would discard acknowledged changes.
Quarantine that old generation. Leave unmigrated domains behind explicit adapters
and record their limits rather than implying cross-store atomicity.

## Measurement and acceptance gates

Use isolated synthetic data, not the live installation. Compare against current
JSON caches and main-thread/worker SQLite with documented hardware/runtime/filesystem, warmup,
payload sizes and retention. Test small, medium and growing datasets, stream bursts,
multiple tabs/agents and concurrent backup/usage work. Do not extrapolate a tiny
single-process insert loop into a responsiveness claim.

Measure p50/p95/p99 API/query/commit/queue latency, event-loop delay, bytes written,
CPU, memory, startup/replay time, cache behavior and WAL/checkpoint stalls. Freeze
numerical budgets after the baseline and before judging the pilot. Require reduced
history write amplification without material regression in interactive reads or
critical command latency. Raw throughput does not excuse missed durability guarantees.
Record go/no-go before A2 and after A3a. A rejected pilot can stop consolidation;
retaining standardized stores is a valid outcome. Freeze all numerical budgets
before variant selection, including maximum snapshot-barrier duration.

Correctness gates include failed commits/full disk, CAS conflicts, duplicate/reordered
requests, SIGKILL at transaction and migration boundaries, worker restart, changed
stream records without a new sequence, usage reconciliation and restore with stale
browser queues. No missing acknowledged records, duplicate claims or unintended
external launches are acceptable. A process-kill test does not simulate power loss;
document the filesystem/durability assumptions separately.

The target is one coherent application database with explicit domain contracts,
not one file format for every artifact. Adoption depends on these measurements
and compatibility tests; no speed multiplier is claimed before implementation.
