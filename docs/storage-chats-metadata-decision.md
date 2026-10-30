# Chat list and metadata storage decision (perf plan leaf 3)

Date: 2026-10-30. Status: **proposed design; human approval pending**. This ADR
decides how to move the chat list and per-chat metadata (`chats.json`, registry id
`store.chats`) into SQLite under the storage worker, the way todos and chat history
already moved. It changes no code, registry entry, backend or data. Implementation
belongs to separate execution leaves (section 10) that need their own plan approval.
Production cutover is a **separate human decision** (section 11); finishing the ADR
or the leaves is not that decision.

Related documents: [storage-gates.md](storage-gates.md),
[storage-contract.md](storage-contract.md),
[storage-pre-cutover-runbook.md](storage-pre-cutover-runbook.md),
[storage-todos-worker-decision.md](storage-todos-worker-decision.md),
[storage-todos-cutover-runbook.md](storage-todos-cutover-runbook.md),
[storage-backend-decision.md](storage-backend-decision.md),
[storage-registry.md](storage-registry.md).

## 1. Context and measured problem

`lib/persist/chats-persist.js` keeps every chat as one object in a single
`data/chats.json` document (`{ chats: [...] }`). The measured production file is
**about 10.6 MB**. The module is synchronous end to end and has these costs:

- **Full rewrite per change.** `saveChats` and `commitChatUpdate` write the whole
  collection with a temp file and rename (`writeJsonAtomic` / `writeTextAtomic`).
  A one-field update (a title, a read mark, a session id) writes ~10.6 MB. A per-row
  text cache (`serializedRow`) saves CPU on unchanged rows but not bytes or I/O.
- **O(N) scans.** Reads parse or hash the file (`readChatsFileSignature`, a revision
  that is a hash of the bytes read), then walk the array. `ChatCatalog.page` in
  `lib/chat-catalog.js` is a keyset page over *array position*, but the catalog is
  built from a whole-collection snapshot (`peekChatsSnapshot`) and `archived=tree`
  still pays an O(rows) ancestor pass. `archivedCountsByWorkspace`, `counts`, and
  workspace-scoped lists walk every row.
- **Main-thread, synchronous.** The whole read-modify-write runs on the event loop.
  [architecture-stall-profile.md](architecture-stall-profile.md) records `updateChat`
  at 5,000 chats at P50 7.7 ms / P99 11 ms with the whole-file rewrite; the cost
  grows linearly with N and file size, so it is far larger at the 10.6 MB file and at
  the 50,000-chat target below.
- **No cross-process protection** (registry: "in-process synchronous RMW — no
  cross-process lock", rank 60), so a concurrent writer is a lost update.
- **Large fan-in.** The module is imported by dozens of `lib/` files. A source search
  at this revision finds `loadChats` in **67** `lib/`/`server.js` files, `updateChat`
  in **20**, `addChat` in **15**, `peekChats` in **5**, `getChatById` in **4**,
  `saveChats` in **3**, `peekChatsSnapshot`/`loadChatsSnapshot`/`peekChatsByIds` in
  **2** each, `removeChat` in **1**. These are file counts of textual matches (not
  unique runtime call sites); the conversion leaf must enumerate aliases and indirect
  paths (section 7).

Todos (`todos/*.json`) and chat history already run, or are prepared to run, in the
storage worker. Chats are the remaining large synchronous JSON document on the hot
path. The same approach applies: indexed rows, small worker transactions, an async
facade, a backend marker and a verified migration.

Out of scope: chat *history* (events; already `store.chat-history`), title history
(`store.chat-title-history`, separate store, kept as is), context-send manifests and
media. This ADR covers only the chat record (list/metadata).

## 2. Goals and gates

Goals: the cost of listing and of changing one chat must not depend on the number of
chats N; no whole-collection serialization on the main thread; no loosening of the
durability contract (`journal_mode=WAL`, `synchronous=FULL`).

### 2.1 Adopted from storage-gates.md as lower bounds

These are taken over from [storage-gates.md](storage-gates.md) unchanged. This ADR
may tighten them; it may **not** loosen them.

| Gate | p95 | p99 | Source section |
| --- | ---: | ---: | --- |
| API handler wall time (server-side persist only) | 120 ms | 250 ms | Interactive latency |
| SQLite worker queue wait + execute | 80 ms | 180 ms | Interactive latency |
| History/list page query (50 rows, indexed) | 40 ms | 90 ms | Interactive latency |
| Event-loop delay (mixed workload) | p99 ≤ 25 ms, at **1 ms** monitor resolution | | Event loop |

A run recorded at a coarser monitor resolution than 1 ms is not comparable and must
not be used for go/no-go (storage-gates.md). Event-loop max (single run) stays
≤ 100 ms. Related gates inherited as-is: steady queue age p95 ≤ 200 ms, burst max
≤ 2,000 ms; WAL checkpoint stall (FULL) p99 ≤ 500 ms; group commit batch
≤ 256 KiB / 40 ms; priority commands never starved > 500 ms.

### 2.2 Targets for this store (the floor from leaf 4)

| Target | Gate |
| --- | --- |
| List page (50 rows) at **50,000 chats** | p95 ≤ **40 ms**, p99 ≤ **90 ms** |
| Change write (one chat), API handler | p95 ≤ **120 ms**, p99 ≤ **250 ms** |
| Bytes written per change | ≤ **64 KiB** (database + WAL bytes actually written for one single-chat change, including index maintenance and the receipt) |
| Statements/queries per list page and per single-chat change | **independent of N** (a fixed small constant; asserted by a test that runs at N = 1,000 and N = 50,000 and compares counts) |

The 40/90 ms list gate equals the history-page gate and is therefore the floor, not a
stretch goal. The leaf-4 benchmark (section 10, leaf D) may set stricter numbers once
a first measurement exists; any tightening is recorded in the benchmark report and
this ADR is amended, never relaxed. A failed correctness, count/hash, ACK/CAS,
receipt, or numeric gate blocks cutover.

## 3. Data model

New schema migration in `lib/storage/schema/` (next free version after the current
`0008-decisions.js`; the number is assigned by the implementing leaf). Pattern follows
`0007-todos.js`: indexed light fields in columns, everything else kept as JSON so a
logical export reproduces the record exactly (including unknown fields and key
order). Tables are `STRICT`.

### 3.1 `chats`

One row per chat, primary key `id`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | non-empty, bounded length like `chat_history_state.chat_id` |
| `position` | INTEGER NOT NULL | preserves legacy array order for export and for the legacy sidebar order; gaps allowed (order is `position, id`) |
| `workspace_key` | TEXT NOT NULL | normalized workspace identity derived from `workspaceFolder` (fallback `workspaceFile`), same resolution the catalog uses in `isChatInScope`; `''` when none |
| `workspace_folder` | TEXT NOT NULL DEFAULT '' | raw value, kept for scope matching and export |
| `workspace_file` | TEXT NOT NULL DEFAULT '' | raw value |
| `widget_installation_id` | TEXT NOT NULL DEFAULT '' | scope for widget chats |
| `parent_id` | TEXT NOT NULL DEFAULT '' | `forkParentChatId` (fork tree) |
| `todo_id` | TEXT NOT NULL DEFAULT '' | `todoId` link |
| `title` | TEXT NOT NULL DEFAULT '' | |
| `agent_transport` | TEXT NOT NULL DEFAULT '' | |
| `cursor_session_id` | TEXT NOT NULL DEFAULT '' | looked up by `getChatByCursorSessionId` |
| `created_at` | TEXT NOT NULL | ISO string as stored |
| `updated_at` | TEXT NOT NULL DEFAULT '' | ISO string as stored (chat `updatedAt`) |
| `last_activity_at` | TEXT NOT NULL DEFAULT '' | the sort key for the list: `updated_at`, else `created_at`, computed on write by the facade so the order matches what the sidebar shows today; the migration records the derivation rule and the verification checks it |
| `archived_at` | TEXT NOT NULL DEFAULT '' | `''` = live; same truthiness as `isChatArchived` (trimmed non-empty) |
| `status` | TEXT NOT NULL DEFAULT '' | coarse lifecycle value if the record carries one (idle/running); empty otherwise. Only added if the current record has such a field; the migration leaf confirms the field list from the live data before freezing the schema |
| `pinned` | INTEGER NOT NULL DEFAULT 0 | `watcherPinned` and other sidebar flags used in list filters |
| `revision` | INTEGER NOT NULL | per-row version, incremented on every write; used for CAS |
| `light_json` | TEXT NOT NULL DEFAULT '{}' | small list-visible remainder (flags, mode, model, unread/read marks) returned with list rows |
| `extra_json` | TEXT NOT NULL DEFAULT '{}' | all other fields, unknown ones included |
| `key_order_json` | TEXT NOT NULL DEFAULT '[]' | original top-level key order for byte-faithful logical export |

Heavy or rarely read fields (session maps, context-compression state, fork
bookkeeping, long arrays) go to `extra_json` and are fetched only by detail reads
(`getChat`), never by list pages. The implementing leaf measures the real per-field
size distribution on a copy of the data and moves any field above ~1 KiB per row out
of `light_json`, so a list row stays small.

### 3.2 `chat_store_meta`

Single-row table (or key/value): `format_version`, `dataset_generation` binding
(same binding mechanism as `0005-dataset-binding.js` / todos), `store_revision`
(monotonic; incremented in every committed transaction that changes any chat; this
replaces the byte-hash revision that `readChatCatalog` derives today), `row_count`
(maintained in the same transaction, used by cheap `counts`).

### 3.3 Indexes

Chosen from the actual access paths (`ChatCatalog.list/page/children/counts`,
workspace-scoped sidebar, retention/auto-archive sweeps, `getChatByCursorSessionId`):

| Index | Serves |
| --- | --- |
| `(archived_at = '', workspace_key, last_activity_at DESC, id DESC)` as a partial index `WHERE archived_at = ''` | live list per workspace, keyset page |
| `(workspace_key, last_activity_at DESC, id DESC)` | list including archived, per workspace |
| `(last_activity_at DESC, id DESC)` | global recency list (no scope) |
| `(archived_at, workspace_key)` partial `WHERE archived_at <> ''` | archived list and archived counts per workspace |
| `(parent_id, id)` | `children`, fork subtree, tree-parity ancestors |
| `(todo_id)` partial `WHERE todo_id <> ''` | todo unlink on chat delete |
| `(cursor_session_id)` partial `WHERE cursor_session_id <> ''` | `getChatByCursorSessionId` |
| `(widget_installation_id, last_activity_at DESC, id DESC)` partial | widget scope |

Every index carries `id` as the final key part so keyset comparison is total. The
benchmark records `EXPLAIN QUERY PLAN` for each list query and fails if a query
scans the table. Each extra index adds write amplification; the byte gate in section
2.2 is measured with all indexes present, and an index that does not serve a listed
access path is dropped.

### 3.4 Ordering and the legacy array order

The legacy "position in the array" is today the cursor sequence and the visible
sidebar order. The new store sorts lists by `last_activity_at DESC, id DESC`. Where
the current UI depends on array order that differs from this (for example, new chats
appended at the end), the facade leaves `position` for export/rollback fidelity and
the list-API leaf defines the order explicitly and updates the front end in the same
change. The order change is called out in the leaf-B acceptance and is **not**
silently introduced.

## 4. Async facade contract

Follows the todos pattern ([storage-contract.md](storage-contract.md), "Todos SQLite
backend, marker, migration, rollback"; [storage-todos-worker-decision.md](storage-todos-worker-decision.md)
section 3). Names are design commitments for the execution leaves, not existing code.

- **Facade** `lib/persist/chats-persist.js` keeps its path and exported names where
  possible but every read/write that touches the store becomes `async`. A synchronous
  facade waiting on the worker is excluded by storage-contract.md (no `Atomics.wait`
  on the HTTP/WS thread, no lock across unrelated `await`).
- **Two adapters** behind the facade, selected by the backend marker:
  `chats-backend-legacy` (today's `chats.json` code, unchanged behavior, kept for
  rollback) and `chats-backend-sqlite` (new).
- **Backend marker** `<dataDir>/chats-backend.json`, same semantics as
  `todos-backend.json`: absent = legacy JSON; `sqlite` = exactly the named store
  (`chats.sqlite`, bound to the marker's dataset generation); a missing, empty,
  unbound or generation-mismatched store is an error (`chats_store_missing`,
  `chats_store_unbound`, `chats_generation_mismatch`) and **never** an empty store
  and **never** a fallback to JSON; `legacy-rollback` = legacy JSON over a verified
  rollback export whose manifest hash the marker pins; an unreadable marker refuses.
  Marker writes are compare-and-swap on `revision`. Startup chooses exactly the
  flagged backend.
- **Whether chats get their own `.sqlite` file or live in the shared worker database
  is decided by the first leaf** by checking how `todos.sqlite` and the history
  database are laid out at that revision (one database per domain is the default
  because it keeps backup/restore and rollback per domain independent). The decision
  and the reason are recorded in the leaf report; it does not change this ADR's
  contract.
- **Worker handlers** (small, bounded commands): `chats.page`, `chats.get`,
  `chats.getMany(ids ≤ 200)`, `chats.byCursorSession`, `chats.children`,
  `chats.counts`, `chats.add`, `chats.update` (field-level patch with
  `expectedRevision`), `chats.remove` (with cascading subtree handled in one
  transaction), `chats.archive` (batch, bounded), `chats.markRead`, and
  `chats.importBatch` (migration only). No handler ever receives or returns the whole
  collection. `handler-sql-guard.js` rules apply (no free-form SQL from callers).
- **Writes** run the unchanged domain function (normalization such as
  `withTitleSource`, `normalizeSdkMode`, auto-context thresholds, parent-cycle check
  `wouldCreateChatParentCycle`) on a private copy of the single row, diff it, and
  submit one worker transaction for that row: row CAS on `revision`, `store_revision`
  increment, receipt. Success, cache publication, push (`notifyChatCreated`),
  `broadcastChatListChanged` and all downstream dispatch happen **after COMMIT**.
  Cross-row changes (delete with subtree, archive subtree) are one transaction.
- **Cache.** Small immutable committed cache of recently used rows keyed by
  `(id, revision)`, rebuilt from committed rows after restart; no full-list cache.
  Reads never wait for a pending write; a CAS conflict against another writer re-runs
  on fresh state (3 attempts, then `CONFLICT`), as in the todos facade.
- **Receipts and unknown commit.** Every write has a stable `commandId`, dataset
  generation, handler name and payload digest. On `unknown_commit` the caller calls
  `resolveUnknown` with the same command and digest before retry; committed returns
  the stored result, not committed permits retry, unreconcilable or digest mismatch
  fails closed ([receipts.md](../lib/storage/receipts.md),
  [worker-protocol.md](../lib/storage/worker-protocol.md)). Payloads stay small
  because digest canonicalization runs on the main thread.
- **Lock order.** `store.chats` keeps registry rank 60 as the owner of chat-row
  transactions; the todos link (rank 50) is never held across an `await` of the chats
  worker. A chat delete that unlinks a todo stays two version-checked commands, as in
  the converted `DELETE /api/chats/:id` route, not a held lock.
- **Registry.** The implementing leaf replaces the `store.chats` entry in
  `docs/storage-registry.json` (backend `sqlite-wal-full`, marker
  `chats-backend.json`, managed paths for the store and marker, `chats.json` retained
  and read-only after cutover, ACK class for chat-row CAS, accurate writers list) and
  passes `node --test tests/storage-registry.test.js`. This document does not edit
  the registry.

## 5. List API: paginated reads with keyset cursors

The list is served only as pages. This is the shared pattern with leaf 4b
(`ed3d09c7`, the paginated-read leaf): same page size, same cursor shape and the same
revision/`nextCursor` response envelope, so the front end and routes use one
pagination helper for chats, todos and history. If leaf 4b has already fixed the
envelope when the chats leaf starts, the chats leaf adopts it verbatim; otherwise
leaf 4b follows what is written here. The two must not diverge.

- **Page size** 50 for the gated list page (today `CHAT_CATALOG_PAGE_DEFAULT_LIMIT`
  is 100 and `CHAT_CATALOG_PAGE_MAX_LIMIT` is 500 in `lib/chat-catalog.js`; leaf B sets
  the default to 50 together with the front end and keeps a bounded maximum). A limit
  outside the range is clamped. The gate in section 2.2 is measured at 50 rows.
- **Keyset cursor**, not offset: the cursor encodes `(last_activity_at, id)` of the
  last returned row plus the `store_revision` it was issued at, in an opaque string
  (same `decodeCursor` style as today's `${pos}@${revision}`, but the position is a
  sort key, not an array index). The query is
  `WHERE (last_activity_at, id) < (:la, :id) ... ORDER BY last_activity_at DESC, id DESC LIMIT :n+1`;
  the extra row decides whether `nextCursor` is `null`. Cost is O(page), independent
  of N and of how deep the cursor is.
- **Filters before the limit**: scope (workspace folder/file/widget) and archive
  filter (`live` / `archived` / `all`) are in the `WHERE`, so a page is never short
  because of filtered rows (preserves the current catalog behavior).
- **`archived=tree`** (live rows plus archived ancestors of live rows) must not need
  an O(N) pass. It is served by a recursive query bounded by the page (ancestors of
  the rows on the page via `(parent_id)`/`id` lookups), returning the ancestors in
  the same response and flagging them; the leaf defines the exact response shape and
  keeps sidebar parity with a test against the legacy catalog on the same fixture.
- **Revision semantics.** A cursor issued at one `store_revision` stays valid if the
  revision changes; keyset paging tolerates inserts/deletes between pages (a row can
  appear or disappear, never duplicate within a stable sort key). The response carries
  the current `store_revision` so clients detect that the list changed; stale cursors
  are not an error.
- **Counts** (`total/archived/live/roots`) and `archivedCountsByWorkspace` come from
  indexed `COUNT`s or maintained counters, not row scans.
- **Row shape.** List rows return indexed columns plus `light_json`; detail reads
  (`chats.get`) return the full record. No list read sends `extra_json`.
- The route `lib/routes/chats-routes.js` already exposes `nextCursor`; the HTTP
  contract stays additive. Clients that still expect the full list get a compatibility
  path only until the front end is converted, tracked in leaf B.

## 6. Write path

A change to one chat touches one row and its indexes, inside one worker transaction:

1. Read the current row (primary key) and verify `expectedRevision`.
2. Apply the patch (changed columns only; `light_json`/`extra_json` rewritten only if
   they changed).
3. `UPDATE chats SET ... WHERE id = :id AND revision = :expected` (one statement),
   `UPDATE chat_store_meta SET store_revision = store_revision + 1`, receipt insert.

Requirements:

- **≤ 64 KiB written bytes per change** (database + WAL, indexes and receipt
  included), measured in the benchmark with all indexes present. Row size is bounded
  by the heavy-field rule in section 3.1; a record that cannot fit is a migration
  finding, not a silent exception. The gate is a ceiling, expected typical values are
  far lower (a few pages of 4 KiB).
- **Query count independent of N**: a fixed number of statements per change (target
  ≤ 5), no `SELECT` over the table, no scan-based side effects. A test runs the same
  change at N = 1,000 and 50,000 and compares statement counts and
  `EXPLAIN QUERY PLAN`.
- **No whole-collection serialization on the main thread**; the legacy
  `serializeChatsFile` path exists only in the legacy adapter.
- **Latency**: handler p95 ≤ 120 ms / p99 ≤ 250 ms, worker queue + execute p95
  ≤ 80 ms / p99 ≤ 180 ms (section 2).
- **Batching**: independent concurrent commands may share a group commit
  (≤ 256 KiB / 40 ms) with per-command results; an acknowledgement is never early
  (storage-contract.md). High-churn read marks (`markChatReadState`) are coalesced in
  the facade within a bounded window and flushed as one command, but a success reply
  is returned only after the commit that contains it.
- **Crash window**: uncommitted queued commands vanish; a crash between COMMIT and
  reply is resolved by the receipt (`resolveUnknown`). No speculative shared state is
  published.

## 7. Callers requiring async conversion

The facade becomes async, so every caller and every read-modify-write section is
converted together (storage-contract.md: keep the legacy synchronous adapter until
callers and whole atomic commands are converted together). The inventory below is
from the textual search at this revision (see section 1 counts) and is **not** a list
of unique runtime call sites; leaf B starts by generating the exact list (aliases,
re-exports, indirect imports, `server.js`, `lib/**/*.ts`, scripts, tests) and records
it in the leaf report.

Groups, with representative files:

- **Routes/HTTP:** `lib/routes/chats-routes.js` (list, create, update, delete, read
  marks, archive), harness diagnostics routes, widget/chat creation endpoints.
- **Chat lifecycle and runs:** `lib/chat-run-service.js`, `lib/agent-run-state.js`,
  `lib/claude/claude-agent-ws.ts`, `lib/conversation-fork-execute.js`,
  `lib/fork-chat-text.js`, `lib/chat-message-guard.js`, session-id setters
  (`setChatSdkAgentId`, `setChatOpenCodeSessionId`, `setChatCodexThreadId`,
  `setChatClaudeSessionId`, `rotateChatSdkSession`, and siblings).
- **Catalog and listing:** `lib/chat-catalog.js` (reads from `peekChatsSnapshot`; to
  be replaced by page/get/counts calls), `lib/chat-tree.js`, `lib/chat-archive-guard.js`,
  `lib/chat-archive-policy.js`, `lib/chat-auto-archive.js`, `lib/chat-retention.js`.
- **Titles:** `lib/chat-title-agent.js`, `lib/chat-title-dispatcher.js`,
  `lib/chat-title-backfill.js`, `applyAutoTitle`, `setChatTitleLocked`.
- **Delegation and watcher:** `lib/delegation-service.js`,
  `lib/delegation-mailbox.js`, `lib/delegation-run-bridge.js`,
  `lib/delegation-takeover.js`, `lib/delegation-session-continuity.js`,
  `lib/delegation-runtime-worker.js`, `lib/delegation-runtime-boot.js`,
  `lib/workspace-watcher*.js` (cycle, control, nudge, scout, archive sweep, pinned
  chat, delegation guard, todo recover), `lib/orchestrator-leaf-resolution.js`,
  `lib/model-pick-service.js`, `lib/workspace-scout-chat.js`,
  `lib/usage-limit-resume-executor.js`, `lib/feedback-triage.js`.
- **Context, push, git:** `lib/context-compression-source.js`,
  `lib/chat-created-push.js`, `lib/agent-finished-push.js`, `lib/git-context.js`,
  `lib/git-switch-guard.js`, `lib/worktree-list.js`.
- **Direct file dependants (not through the facade):** `lib/boot-log.js`,
  `lib/backup/conversations-store.js`, `lib/sdk/sdk-history-isolation-fork-cli.ts`,
  and any backup/snapshot code that copies `chats.json` by path; these need an
  explicit adapter (logical export/snapshot) instead of a path into a read-only
  legacy file. `migrateChatWorkspaceIds` (settings-driven rewrite of workspace ids)
  becomes a bounded batch command.
- **Tests and scripts** that import the synchronous API or stat the JSON file.

Rules for conversion: a function that was an atomic synchronous read-modify-write is
either one worker command or an explicit version-checked sequence; no lock is held
across an `await` of the worker; code that relied on "sync read right after a sync
write" is audited because the committed cache publishes only after COMMIT.

## 8. Data migration plan

Adapted from the todos migration ([storage-todos-cutover-runbook.md](storage-todos-cutover-runbook.md))
and the history import; ownership, backup and rollback rules come from
[storage-pre-cutover-runbook.md](storage-pre-cutover-runbook.md) and the **single
writer** rule of [storage-contract.md](storage-contract.md).

### 8.1 Preconditions

- **Dependency on leaf 2a** (chat retention/archive for technical chats, delegated
  child chats): run the retention batch apply *before* the migration so the data to
  move is smaller (technical chats archived or removed under the reversible flag), the
  verified copy is smaller and faster, and the 50,000-chat benchmark fixture is
  derived from realistic post-2a data. The migration does not depend on 2a for
  correctness: if 2a has not run, the migration still imports every row, archived or
  not, and the plan hash records the counts.
- Runtime check passes (`checkStorageRuntime`: Node ≥ 22.18.0, bundled SQLite ≥ 3.51.0).
- The async facade and callers (leaf B) are merged and released; the migration tool
  alone does not switch production (marker alone is not a runtime switch until the
  reviewed runtime integration lands, as for todos).

### 8.2 Procedure (offline, single writer)

1. **Quiesce.** Through an independent service manager outside Cretli, pause clients,
   watcher claims, recovery launchers, queued browser commands and automatic outgoing
   work; stop HTTP/MCP/background/CLI writers; drain commands; inventory unknown
   `chats.json` writers (backup and snapshot code, scripts). File mtime quietness is
   not proof of exclusive ownership. There is exactly one writer: the migration
   process, then the storage worker owner.
2. **Backup copy.** Create a verified offline snapshot of the data directory with the
   existing snapshot procedure (`scripts/cretli-offline-snapshot.mjs`), stored outside
   every path that will be replaced. Extract into an isolated directory, verify every
   manifest checksum, counts, ownership and permissions. Additionally copy
   `chats.json` byte-for-byte to the operation directory and record its SHA-256.
3. **Rehearse** the migration, export verification and rollback on the extracted copy
   before touching production data. The synthetic rehearsal in the benchmark does not
   replace rehearsal on the installation's own backup.
4. **Plan (dry run, writes nothing).** `scripts/migrate-chats-to-sqlite.js` prints
   the source manifest: file SHA-256, bytes, chat count, count of archived/live rows,
   count per workspace key, set of ids, count of rows with unknown fields, the
   derivation rule for `last_activity_at`, and a plan hash.
5. **Apply** (`--apply --confirm-plan <hash>`): import into a *new staging* SQLite
   store through `chats.importBatch` in bounded batches (each ≤ the group-commit
   byte limit), outside the interactive event loop; no write to `chats.json`.
6. **Verify** by reopening the staging store read-only and comparing with the source:
   - **Counts:** total rows; per-workspace; live vs archived; rows per parent;
     non-empty `todo_id`; non-empty `cursor_session_id`.
   - **Identity and order:** the set of ids equals the source (no duplicates, none
     missing), and `position` reproduces the source array order.
   - **Field fidelity:** per-row field sets (unknown fields included) and key order.
   - **Hash:** logical export of the store (strict legacy document, `{ chats: [...] }`
     in `position` order, same serialization as the legacy writer) must hash
     **byte-identically** to the source canonical form. Verification fails closed on
     any mismatch; no row is "fixed up" silently.
   - **Derived columns:** `workspace_key`, `last_activity_at`, `archived_at`,
     `parent_id` recomputed from the source rows and compared with the stored ones.
   - Re-hash the source `chats.json`; a changed source voids the run.
   - Index and query-plan check: the list queries from section 5 use their indexes on
     the migrated data (`EXPLAIN QUERY PLAN`), and a first page + a full cursor walk
     returns exactly the live chat set.
7. **Publish.** Publish the closed, verified store, bind the dataset generation, and
   only then write the `chats-backend.json` marker (`sqlite`). `chats.json` is left
   byte-identical and made read-only; the pre-migration backup and its manifest stay.
   Startup then picks exactly the flagged backend and never creates an empty store.
8. **Resume** automatic work only after explicit operator action; verify zero
   automatic process starts and no outgoing push during the first open.

### 8.3 Rollback boundary

Same boundary as [storage-pre-cutover-runbook.md](storage-pre-cutover-runbook.md)
("Rollback boundaries") and the todos contract:

| State | Recovery |
| --- | --- |
| Library/facade changes only, marker absent | Return to the recorded release; no data restore. |
| Staging migration failed; legacy authoritative | Keep writers paused, discard only the identified staging output after saving diagnostics, restart the legacy release. |
| Marker published, **no new durable ACK** of the sqlite backend | Under exclusive ownership restore the verified previous marker state; original `chats.json` still equals the store and is an acceptable source. |
| **After the first durable ACK** of the sqlite backend | A plain `chats.json` backup would lose writes and is **rejected** (`chats_rollback_source_stale`). Stop writers, fence the store, preserve both datasets, produce a fresh logical export (strict legacy `{chats:[...]}` plus a `rollback-control/` manifest with store fingerprint, receipts and fence high-water mark), validate it, activate `legacy-rollback`, and run a sidecar-aware legacy adapter, **or** take an explicit human data-loss decision. |

The rollback tool (`rollback-export` / `rollback-activate`) mirrors the todos
tooling; an older binary must not be pointed at the migrated documents
(`plainLegacyBinaryCompatible` false). After any dataset restore, advance the
externally retained dataset generation/fence, invalidate server caches and client
revisions, and quarantine pending browser queues for explicit reconciliation. Never
dual-write opportunistically, never replace the whole data directory, never touch
auth/TLS or unrelated files.

## 9. Alternatives considered

- **Keep `chats.json`, add a sharded layout** (one file per chat or per workspace):
  fixes byte amplification but not O(N) listing or cross-row queries, adds many small
  files to back up and still has no cross-process protection. Rejected as the end
  state.
- **Main-thread SQLite (synchronous)**: simpler, but the storage-gates single-statement
  budget (p99 15 ms) and the plan's "no new synchronous main-thread I/O on hot paths"
  goal argue against it; the worker is already adopted for history and todos.
  Rejected.
- **In-memory index only over the JSON file**: already partly done
  (`chatsIndex`, `serializedRow`); it does not remove the full-file rewrite. Rejected.
- **Shared database with todos/history**: possible; decided per section 4 in the first
  leaf, with per-domain backup/rollback independence as the default.

## 10. Proposed execution leaves

Each leaf has its own plan approval, review by an independent model, and focused
tests. Leaves are sequential unless stated.

- **A. Worker handlers and schema.** Schema migration (section 3), handlers
  (section 4), handler tests, SQL guard coverage, receipts; the new store is opened
  only by tests. No production wiring. Acceptance: handlers pass unit tests, `EXPLAIN
  QUERY PLAN` shows indexed access, per-change statement count is fixed.
- **B. Facade and callers.** Async facade over legacy and SQLite adapters with the
  backend marker; conversion of every caller from section 7 together with their
  read-modify-write sections; `ChatCatalog` moved to page/get/counts; front-end
  consumption of the paginated list (shares the pagination helper with leaf 4b
  `ed3d09c7`); registry entry and `tests/storage-registry.test.js`. Default backend
  stays legacy. Acceptance: the whole existing chat test suite passes on both
  adapters; no direct `chats.json` access outside the legacy adapter; no lock across
  an `await`.
- **C. Migration and rollback.** `scripts/migrate-chats-to-sqlite.js` (plan, apply,
  verify with counts + hash, marker), `rollback-export` / `rollback-activate`,
  sidecar-aware legacy runtime, runbook `docs/storage-chats-cutover-runbook.md`.
  Acceptance: rehearsal on a synthetic 50,000-chat copy and on a copy of a real
  backup passes count and hash verification; rollback rehearsal before and after a
  durable ACK; failure injection (changed source, crash after COMMIT, worker loss).
- **D. Benchmark with gates.** `scripts/benchmark-chats.js` and a report
  (`docs/storage-chats-benchmark.md`): 1,000 / 10,000 / 50,000 chats, list page of 50
  (first page and deep cursor), single-chat change, no-op write, concurrent changes,
  200-command burst, worker loss after COMMIT. Reports hardware, Node/SQLite,
  dataset bytes, histogram resolution (1 ms), per-command queue/execute/ACK latency,
  bytes written (db + WAL), query counts, and compares with the legacy adapter on the
  same data. Every gate in section 2 is asserted; a FAIL blocks cutover and is
  reported, never waived or treated as zero when unmeasured.

Dependency on **2a**: leaf C and the realistic dataset of leaf D should be run after
the 2a retention apply so there is less data to migrate; leaves A and B do not wait
for it.

## 11. Cutover is a separate human decision

Completion of the ADR, leaves A-D, or the benchmark does not switch production. The
cutover follows the todos precedent: a human reviews the benchmark report and
rehearsal evidence, schedules the quiesced window, runs the verified-copy procedure
of section 8 on the real installation, and publishes the marker. A reviewed runtime
integration (the server actually opening the chats runtime) is a separate
prerequisite; a marker alone must not be treated as a live switch. This ADR is
subject to review by an independent model before leaf A starts.

## 12. Risks and open points

- **Record shape drift.** The chat record has many optional fields written by
  different harnesses. The first step of leaf A is to profile the real field and size
  distribution on a copy before freezing columns; unknown fields are preserved via
  `extra_json`, so a surprise cannot lose data, but may break the 64 KiB or list-row
  size targets.
- **Order semantics.** Section 3.4: any change from array order to
  `last_activity_at` order is explicit and reviewed with the front end.
- **Fan-in size.** About 70 files import the facade; the conversion is wide. Leaf B
  may be split by caller group, but the legacy adapter stays the default until all
  groups land.
- **Watcher/todo coupling** across stores (no SQLite-side journal) stays a staged,
  version-checked protocol; this ADR does not widen that gap.
- **Measurement gaps.** The 10.6 MB figure is a production observation; the
  50,000-chat target is synthetic. Production p99 for list and write is measured
  prospectively after cutover and is separate from the pre-cutover gates.
