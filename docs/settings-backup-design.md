# Settings, exports, and backups

Status: amended after the Opus 5.5 review; not implemented or independently
re-reviewed. Shared decisions: [storage contract](storage-contract.md).

## Purpose

Let users save named settings snapshots, move their configuration to another
installation, export conversations, and recover Cretli data after a failure.
Use backend-independent repository contracts. The proposed target is a shared
SQLite database for related application state, described in
[unified persistence](persistence-design.md). Roll out gradually; basic portable
settings exports do not require completion of the whole database migration.

## Existing storage

Paths below are relative to the directory resolved by `lib/runtime-paths.js`
(`CRETLI_DATA_DIR`, otherwise `data/`). Inventory actual writers before implementation:

| Data | Existing source | Proposed treatment |
| --- | --- | --- |
| Server settings and workspace registry | `config.json`, `lib/persist/settings.js` | Portable settings with explicit field classification |
| Shared sidebar preferences | `sidebar-layout.json` | Include workspace layout; include chat references only with their chats |
| Device preferences | Allowlisted localStorage keys, including theme/language/chat preferences | Optional export from the current browser; optional application on import |
| Chat metadata and transcript | `chats.json`, `chat-history/`, `chat-title-history.json` | Export selected chats or all available server history |
| TODOs and workspace memory | `todos/`, `workspace-memory/` | Include in data backup; remap workspace keys on migration |
| Watcher and Scout configuration/state | `workspace-watchers.json` | Portable profiles omit execution state; backup preserves records with safe restore defaults |
| Delegations and related records | JSON stores in `lib/persist/`; optionally `delegations.sqlite` | Backend adapter includes attempts, outbox, mailbox, workflows and related records |
| Recovery intents and execution queues | `recovery.sqlite`, `lib/recovery/recovery-store.js` | Include retained state and approved payloads; restore paused, with no automatic launches |
| Usage and model decisions | Usage ledger/index and model-pick/rating stores | Optional data category; retain accounting without replaying actions |
| MCP configuration and credentials | `mcp.json`, `mcp-secrets.json`, `mcp-tx.json` | Portable definitions omit secrets; use the store transaction/recovery protocol |
| Attachments | Referenced files under `uploads/` | Optional category; missing attachments reported explicitly |

Browser IndexedDB history is a cache plus an offline queue, not a replacement
for the server archive. Reconcile this browser's pending records before export
or explicitly report their omission. Other devices' unsynchronized data cannot
be included. Export only retained events; do not imply recovery of pruned history.

## User experience

Add Settings → Data and backups, using existing layout recipes, Lit controls,
tokens, and PL/EN translations. Keep action/status controls outside the scroll body.

1. **Settings snapshots:** Save current settings with a name; list versions,
   inspect changes, download, and restore selected sections. Display saved/error
   status only after durable persistence succeeds. Create a snapshot before import.
2. **Export:** Choose Settings, Conversations, or Cretli data backup. Show scope,
   record counts, estimated size, attachments, browser preferences, and omissions.
   Conversations support one chat, a selection, a workspace, or all chats, with
   explicit inclusion of archived chats and related subchats.
3. **Import:** Choose a file, validate, select sections, map workspace paths,
   inspect conflicts and a change preview, then apply. Defaults preserve existing
   data. Missing secrets never clear credentials already set at the destination.
4. **Backups:** List timestamp, categories, size, encryption, completion and
   verification state; download or delete individual backups. Scheduled backups
   later add interval, retention, destination, and last successful backup.

Provide JSON and Markdown download in the chat menu. Markdown is for reading;
the structured archive is the importable format. Large jobs run server-side,
report progress, support cancellation before publication, and survive browser
disconnects. Local scheduled backups cannot include a disconnected browser's
preferences or offline queue.

## Formats and compatibility

Portable settings use a versioned JSON document. Chat/data archives use ZIP with
`manifest.json` and independently versioned category payloads. The manifest records
format version, Cretli version, creation time, profile, categories, record counts,
relative filenames, byte sizes, SHA-256 checksums, persistence backend, and omissions.
Include a random archive identity for repeat-import detection, not a machine identity.

Use logical data for portable exports; use a consistent store snapshot for disaster
recovery. Markdown is never interpreted as executable configuration. Unknown future
format/schema versions fail before writes; supported older versions migrate in staging.
Plugin configuration uses registered schemas. Missing plugins produce inactive
configuration and a report; import does not install plugins or execute their code.
Every imported executable/external connection definition starts disabled, including
MCP command/args/env, executable paths and endpoint URLs of installed plugins.
Preview displays the definition; a separate explicit activation is required.
Import performs no endpoint probes, process starts or outgoing push delivery.

Workspace exports contain logical workspace identifiers and a mapping table.
Local paths and network settings are optional machine-specific sections. A migration
recomputes path-derived filenames/keys (including TODO and memory storage), and maps
all related references. Unmapped workspaces remain inactive until mapped.

## Secret boundaries

Classify fields as portable, machine-specific, secret, or transient using an explicit
registry. Reuse existing settings validation and secret metadata where possible;
never export raw `config.json` as the portable format. Inspect MCP headers, environment
values, URLs and command arguments as well as obvious API-key fields. Unknown fields
are omitted from portable settings until classified.

Default settings snapshots and exports exclude API keys, tokens and MCP credentials.
An optional encrypted credential category may later include Cretli-managed secrets.
Do not copy `.env`, browser sessions, `sessions.json`, authentication signing material,
TLS private keys, SSH keys, native harness login stores, or whole harness home folders.
Retain destination authentication on restore; a fresh installation requires setup
and provider sign-in again. Environment overrides are reported but never exported.

Conversation text and attachments can themselves contain sensitive content. Label
these archives as containing conversation content; excluding credential stores does
not claim that transcripts are anonymized or secret-free.

Encrypted backups wrap the entire archive with authenticated encryption, a random
salt/nonce and a versioned password KDF. Implementation must select and document the
exact envelope/KDF parameters and add tamper/wrong-password tests. Never persist the
passphrase in settings, TODOs, logs, or browser storage. Scheduled encryption uses a
separate operator-provided key, not a plaintext key next to the backup. Loss of that
key/passphrase means the archive cannot be restored.

Before B5 implementation, freeze envelope v1 with a Node-supported KDF, bounded
parameters, authenticated ordered chunks and a final authenticated count/length/digest.
Authenticate header/indices; reject reordered, missing, truncated and appended chunks.
Decrypt into private owner-only staging; no restore parser/apply consumes unauthenticated
output and apply waits for full verification. Bound staging lifetime/size and clean
after recovery; document its reliance on host disk protection. Listing metadata outside
the envelope contains only date/profile/size/status, not prompts, paths or secrets.
Pre-restore copies follow the selected encryption policy; encrypted input requires
an encrypted recovery copy and a usable key before mutation. Never persist that key.

## Export and restore correctness

- Read stores strictly: corrupt JSON, failed reads, and unresolved MCP transactions
  fail the job; do not turn them into apparently valid empty exports through forgiving
  application loaders.
- B4 full backup/restore is offline: exclusive instance/store ownership, stopped
  managed processes, drained buffers and resolved journals; refuse active/unknown
  writers. B6 adds online copies through the shared maintenance coordinator: external
  lease, registered mutation/run gates, drain, retained-on-error flush, fixed store-lock
  order, fence checks and bounded staging. Release gates before compression; failed
  flush publishes nothing. Every participating writer must honor the coordinator.
- For SQLite, use a consistent database backup operation or a closed database after
  clean shutdown; never copy only a live `.sqlite` file while WAL writes continue.
  Read the configured backend and migration markers rather than archiving a stale
  alternate store. Preserve a backend-compatible recovery contract.
  Validate staged databases with integrity and foreign-key checks in addition to
  checksums. Runtime lock and ownership files are excluded from restored state.
- Validate archive limits, schemas, checksums, unique paths and identifiers, and
  reference integrity before writes. Reject traversal, absolute paths, symlinks,
  duplicate entries, prototype pollution and decompression bombs. Never follow
  attachment references outside their allowlisted storage root.
- Settings import merges selected sections after preview. Chat import creates new
  chat IDs by default, remaps parent/child and selected TODO/delegation references,
  and clears native provider session IDs. Out-of-scope links are reported and removed
  or resolved explicitly. Repeated imports are detected without duplicating history.
  Imported chats open as readable transcripts; continuation starts a new provider
  session with an explicit history handoff, not a stale resume ID.
  Persist import receipts by archive ID/digest/source-chat/options and destination ID
  with the commit. Same ID with changed digest fails; a deleted destination is reported
  without silent recreation. Re-export gets a new archive ID; preview shows retained
  lineage/content matches and requires an explicit choice to import a duplicate.
- Data recovery restores a consistent backup as a unit. MVP recovery uses a stopped
  server and a CLI; UI can prepare/download the backup and show recovery instructions.
  Selective merging of raw database snapshots is outside this contract.
- Before recovery, create and verify a recovery copy of the destination. Stage all
  output, persist a recovery journal outside the replaced data, and switch through
  a recoverable commit. Replace only registry-managed paths and backend markers;
  retain auth/TLS, native homes, control files, unrelated files and backup destination.
  Stage on each target filesystem; never rename a mount point or assume whole-directory
  replacement. A durable per-path roll-forward journal completes before stores open;
  verified previous content supports explicit rollback/reconciliation. Restore old
  backend markers through registered readers, then run supported forward migrations
  while paused; incompatible archive/runtime combinations fail at preview.
- After restore, invalidate caches and history revisions, signal a dataset generation
  change to clients, and quarantine old browser queues so they cannot append to a
  replaced transcript. Restart when needed. Preserve unsent local data for explicit
  reconciliation rather than deleting it.
  Persist generation/fence control outside replaced data. History HTTP/WS writes reject
  stale or missing generation after protocol rollout; legacy queues require explicit
  upgrade/reconciliation, never automatic stamping with the new generation.
- Imported/restored TODO execution claims are cleared; in-flight runs are marked
  interrupted. Watchers, Scouts, autopilot, schedules, automatic run recovery and
  undelivered command/mailbox/outbox execution stay paused until explicitly re-enabled.
  Restoring data must not launch agents, terminal commands, or MCP servers.
  An external pause flag is enforced by the registered automatic paths: watcher/Scout,
  run recovery, mailbox/outbox, title/archive background work, backup scheduler,
  push delivery and MCP auto-start. Test zero process starts and zero outgoing push.

The backup service uses store adapters for inventory, validation, snapshot, import,
cache invalidation and dependency handling. Initial locations: `lib/backup/`,
`lib/routes/backup-routes.js`, `app_front/features/settings/`, and a recovery CLI
under `scripts/`. These are proposed locations, not existing implementations.

The target shared database makes its related records transactionally consistent.
Until migration is complete, separate databases and legacy JSON stores still need
the cross-store snapshot barrier. After consolidation, package a verified database
copy and immutable referenced attachments pinned against garbage collection;
derive the manifest from the copied database, not newer live rows. Raw database
copies can contain conversation/queue payloads and still require the same content,
credential and encryption policies. Portable exports keep their JSON schemas
independent of the storage backend.

## API and operation

Proposed authenticated API: capabilities/inventory; create and inspect snapshots;
create export job; inspect/cancel/download job; stage import; preview import;
apply preview; list/delete backups; read/update backup policy. Tokens bind previews
to archive digest, options, destination revision and expiry; changed data requires
a fresh preview. Mutations use idempotency keys. Enforce admin-equivalent access and
existing origin/request protections; widget and agent callbacks must not gain backup
access through their narrower credentials.
Use durable settings revisions when available; legacy JSON previews use a raw-content
digest checked under its write lock at apply. Snapshot publication fsyncs the file,
renames it and syncs its directory where supported; document platform fallbacks.
Legacy `config.json` snapshots project classified fields and preserve destination
credentials through the restore adapter; they never blindly copy its embedded keys.

Publish archives only after final checksum verification, via temporary file and
atomic rename. Keep incomplete jobs separate and clean them on recovery. Stream
large payloads with configurable size/time/disk limits. Downloads require authorized
job IDs, never arbitrary filesystem paths. Log metadata/results, not payloads/secrets.

Scheduling is opt-in, off by default, with one job at a time, persisted last-success
state, restart-safe slot deduplication, and visible failure/retry status. Proposed
defaults after opt-in: daily backup and seven successful archives. Prune only after
a newer archive verifies; retain the last successful backup and protect manual or
pre-restore snapshots. Never recursively back up the backup directory. A local copy
does not cover disk loss: allow a configured directory on separate storage;
remote destinations and cloud connectors are later work.

## Delivery order and acceptance

1. **Inventory and contract (B1):** consume A1's single registry, add manifest/category
   schemas, logical mappings, strict validators, managed/retained paths, jobs and
   backend compatibility. The registry/maintenance contract has one owner, A1.
2. **Settings MVP:** named snapshots, portable JSON export/import, diff preview,
   section merge, pre-import snapshot and optional current-device preferences.
3. **Conversations:** JSON/Markdown export, selections/archives/subchats,
   attachment handling and import as new transcripts with reference mapping.
4. **Offline data recovery (B4):** full backup and restore CLI with stopped-server
   ownership, checksums plus database integrity checks, per-path journal/rollback,
   external generations/pause and registered old-backend readers/forward migrations.
   Require B3 and A1's recorded backend gate, not completion of database migration.
5. **Encryption:** versioned authenticated envelope and optional managed credentials;
   document key custody and restore without native login stores.
6. **Online backups and automation (B6):** implement and certify shared quiescence
   against every writer before enabling online copying or scheduled jobs. Add opt-in
   scheduler, destinations, retention, restart safety, disk limits and failures.
7. **Acceptance and documentation:** test all flows across fresh/existing installs,
   desktop/mobile, both backends, and old archive schemas; publish operator guidance.

Each stage includes its relevant UI, PL/EN copy and meaningful regression tests.
Acceptance must cover corrupt/truncated archives, unsupported versions, path remapping,
colliding/repeated imports, offline unsent messages, concurrent writers, active agents,
wrong password/tampering, full disk, failed download/publication, restore crashes and
rollback, authorization boundaries, and retention after a failed backup. A restore
drill verifies chats, history, TODOs, memory, accounting and attachments and proves
that no agents or pending commands start automatically.

Follow the shared contract's acyclic dependencies. B2/B3 use adapters and do not wait
for full migration. B4 accepts selected legacy/mixed stores and precedes A3b metadata
cutover. B6's online capability is blocked until its barrier-duration/event-loop and
writer-enforcement tests pass. B7 tests only accepted migration slices, retaining
unchanged usage journals and standardized stores when their gates select that outcome.

Automatic device preference synchronization, project repository backup, remote cloud
storage, and native harness-session migration are separate future features.
