# Scalable todo architecture (design proposal, v5)

Status: **proposal v6; independent plan review PASS by GPT-6.1 Sol (round 6) and Opus 5.5 (final confirmation, round 5);
needs human plan approval before any implementation.** Date: 2026-11-10.
Extends and replaces the design in [todo-archive-and-capacity.md](todo-archive-and-capacity.md)
and builds on [storage-todos-worker-decision.md](storage-todos-worker-decision.md).

Changes in v5 (round 4 findings): glob-, shadow- and branch-aware scope matching with a row cap; every source row stamped for staged moves and k-way merge for published jobs; writers wait for GC deletion; post-commit outbox drain; `sibling_index` only on detail.

Changes in v4 (round 3 findings): sparse `order_key` instead of dense sibling index; materialized parallel-scope contributions; identity-bearing fingerprint; staged move published through constant-size metadata; idempotency stays inline (hashed) on JSON; review outbox in the delegation transaction; pin epochs and GC `deleting` fence; inline execution of container operations up to 1000 rows.

Changes in v3 (round 2 findings): branch-level blocked/ready/root/depth are no longer stored (O(depth) read-time walk plus claim-time validation); integration proof becomes a versioned Merkle-style fingerprint; bulk operations are fenced journaled jobs with staged cross-workspace move; material publication has pins, directory fsync and GC grace; phase 0 uses a byte budget, not an item count.

Changes from v1 (all round 1 blocking review findings): per-status roll-up counters instead of a done
counter; stored derived read models (review, integration, readiness) with bounded maintenance;
`leafMaterial` kept lossless and deduplicated by path-level delta, not deleted; idempotency moved to
its own table; dedicated watcher/review commands with change sets; legacy `GET /api/todos` left
unchanged and versioned instead of truncated; maintained count dimensions; global (not per-module)
conversion gate; scale proof and runtime wiring moved **before** cutover; a scale-compatible rollback;
a crash-safe expand/contract protocol for phase 0; storage-registry/backup coverage for every new path.

## 1. Goal

Todos stay fast and are never lost, independent of how many exist. Target **10^6 todos in a
workspace** with no code path that reads or serializes "all todos":

- UI loads one page at a time (keyset pagination, virtual scroll); tree children on expand;
- a write touches one row plus O(depth) ancestor counters; a read returns indexed columns; heavy
  text is fetched by id;
- the item-count cap disappears (a safety bound replaces it);
- old data is archived (queryable, linkable, restorable). The system never deletes todo content.

## 2. Current state (verified 2026-11-10)

| Fact | Evidence |
| --- | --- |
| Production todos are JSON files, one per workspace, `data/todos/` (19 files, 69 MB). Largest: 32.5 MB, 2000 items (1514 done, 242 deferred, 196 idea, 33 doing, 15 ready), max tree depth 5. Another workspace has only 219 items but 25.5 MB: size is dominated by `leafMaterial`, not by count. | files in `data/todos/`; Opus review |
| By field in the 2000-item file: `leafMaterial` 14.5 MB (49%), `body` 3.6, `review` 2.9, `changelog` 2.4, `plan` 2.3, `integration` 1.4, document-level `idempotency` 2.9 MB (1904 keys, raw args not hashes, `todos-persist.js:1347-1360`). Row metadata is about 0.5 MB. | analysis |
| `leafMaterial` is dominated by full path-to-hash repo manifests (`baseManifest` ~14 MB, `lastCheckpoint.manifest` ~9.5 MB in the 25.5 MB workspace); 79 of 99 sampled manifests are distinct, so whole-blob content addressing dedupes poorly. | Opus review |
| Hard cap `TODOS_MAX_ITEMS = 2000` at `todos-persist.js:66,1296,1434`, `todos-routes.js:470`; the cap check runs before idempotency replay (`:1434`), so an at-cap retry of an already-created todo also fails. | code |
| SQLite todos backend exists (`todos-backend-sqlite.js`, `todos-store.js`, migration CLI, marker, rollback export) but production startup does not call `openTodosRuntime` (only `scripts/benchmark-todos.js:85`). Default stays JSON (`todos-store.js:64,107-115`). **The todos migration to SQLite has not happened**; chats (B-series) and delegations (`delegations.sqlite`, 200 MB) are further along. | code |
| Benchmark `storage-todos-benchmark.md` (2026-10-30) fails: changed-write ACK p95 494 ms (limit 120), event-loop max 357 ms, burst-200 97 s, 2411 whole-document main-thread serializations (limit 0), export hash mismatch. The overlay code (`todos-backend-sqlite.js:190-249`) supports the diagnosis that the backend emulates the whole-document API; it does **not** prove the cause of the export hash mismatch, which stays an open defect. | benchmark, code |
| `GET /api/todos` returns the entire list (cached per file revision); `GET /api/todos/:id` enriches the whole list and loads all chats, then `find`s the item (`todos-routes.js:651-712`, `:247`). Mutation responses also call `jsonTodosPayload` with a whole document (`:1192,1229,1548,1727`). The front end replaces its model from `data.items` and does not follow cursors (`core/api/todos.js:23-38`, `todoListRefresh.js:116`). The external MCP client backs `todo_list` / `todo_next_ready` with the full list (`remote-api-client.js:403-404`). | code |
| Caller census (today): `updateTodo` 136 sites in 38 files, `addTodo` 48 in 20; many callers use the async facade `listTodos`, including aliases named `loadTodosData`. | Opus review |

Conclusion: SQLite alone is not the fix. The document-in/document-out access pattern is. We change
the access pattern first (storage-agnostic, shippable on JSON) and the storage second.

## 3. Architecture

### 3.1 Row-level repository

Async `TodoRepository`; callers never get "all todos". Every list/count/search is bounded
(`limit <= 200`); there is no `listAll`.

```
getRow / getDetail(ws, id, fields?)         point reads (id or >=8-char prefix via (ws,id) index)
listPage(ws, {filter, sort, cursor, limit}) keyset page
listChildren(ws, parentId, {cursor, limit}) tree expand
counts(ws, filter)                          reads maintained counters (3.4), O(1) per dimension
search(ws, text, {cursor, limit})           FTS5 over title+preview+body
readyLeaves(ws, {limit})                    bounded eligibility query (3.3)
create / patch / move / archive / restore / delete   one transaction each, returns a ChangeSet
reviewWrite(ws, id, {expectedGeneration, decisionKey, ...})   review-generation CAS (3.7)
watcherCommand(...)                         coupled todo+watcher command (3.7)
streamSubtree(ws, rootId)                   resumable, chunked iterator for bulk jobs
revision(ws)
```

`ChangeSet = { id, statusBefore/After, planApprovedChanged, parentChanges[], countsDelta }`. It
drives the watcher nudge (replaces the `previousDoc`/`savedDoc` diff in `workspace-watcher-nudge.js:37-67`),
cache invalidation and WS events. No shared cache publication or downstream dispatch before the
transaction commits (ADR section 3).

### 3.2 Schema (SQLite, WAL, `synchronous=FULL`)

```
todo(ws, id, PK(ws,id), parent_id, order_key, status, is_leaf, subtree_open,
     title, priority, run_mode, non_blocking, blocked_reason, assignee_*, claimed_by_chat_id,
     claim_lease_until, has_plan, plan_approved_at, self_blocked,
     review_code_state, review_plan_state, review_generation,
     n_review_<state>..., integration_state,            -- review aggregate = per-state child counters
     material_fp, tree_fp, fp_version,                  -- integration proof, see 3.3.1
     open_descendants,                                  -- first open siblings via partial index on subtree_open
     n_idea, n_ready, n_doing, n_done, n_deferred,           -- direct-child status counters
     frozen_by_job,                                      -- bulk-job fence, see 3.3.2
     has_leaf_material, base_commit, last_checkpoint_commit,
     created_at, updated_at, archived_at, source_todo_id, preview TEXT(<=400))
todo_blob(ws, id, kind, content, bytes)      body|plan|changelog|review|integration|activity|
                                             execution|extra(unknown fields, lossless round-trip)
todo_material_ref(ws, id, kind, base_ref, delta_ref)         see 3.5
todo_chat_link(ws, todo_id, chat_id, role)                   indexed both directions
todo_idempotency(ws, key, args_sha256, todo_id, created_at)  PK(ws,key); replaces the 2.9 MB map
workspace_counts(ws, dim, key, n)                            maintained counters (3.4)
workspace_meta(ws, revision, schema_version, park_root_id, ...)  "Na pozniej" root id stored, not found by title
todo_fts  FTS5 external-content over title, preview and body
```

Indexes, all `ws`-prefixed, then `staged_job_id` (NULL for normal rows; lets staged-move rows be read as separate ranges, 3.3.2), and archive-aware (the archive predicate is in the key, not a filter):
`(parent_id, archived_at IS NULL, order_key, id)`; partial `(parent_id, order_key, id)` WHERE `subtree_open=1` (first/second open sibling in O(log n)); `(archived_at IS NULL, status, updated_at DESC, id)`;
`(archived_at IS NULL, review_code_state, status, updated_at DESC, id)`; same with `review_plan_state`;
`(archived_at, updated_at DESC, id)` for the archive view; partial `(claimed_by_chat_id)`;
partial `(status)` for `doing`/`ready`; partial `(priority, id)` WHERE `status='ready' AND is_leaf=1`; `(archived_at IS NULL, integration_state, updated_at DESC, id)`;
`(source_todo_id)`; `(ws,id)` PK serves prefix resolution. Every supported filter combination has a
named access plan and a gate on **rows visited** (not only latency) on skewed fixtures (3.9).

**Sibling order is a sparse `order_key`** (fractional/lexorank string), not a dense integer. Today
every save renumbers every sibling group 0..n-1 (`normalizeTodoTreeFields` -> `renumberTodoSiblings`,
`todos-persist.js:1021-1034`, `todo-tree.js:270-282`), which would make create/delete/reorder/move
O(siblings) (parentless todos form one shared group). In the repository, insert, move and delete
touch one row; positional `sibling_index` input from existing API/MCP callers is translated to an
`order_key` between its neighbours, and list rows return `order_key` (clients order by it). The dense `sibling_index` is returned on
detail reads only, as a rank counted on the index; for groups wider than 10 000 it is reported as
`null` with `approximate: true` rather than scanning (a documented contract change for that edge case). A group is rebalanced as a fenced bulk job
(3.3.2) only when keys run out. Gates: insert at the front and delete in the middle of a
100 000-child parent and of a 100 000-root workspace, within the ACK limits. The importer converts
existing dense indices to evenly spaced keys.

### 3.3 Roll-ups and derived read models (v3: node-local facts, branch state computed on read)

**v3 rule: nothing whose value depends on a whole subtree or on all siblings is stored per
row.** Stored per row: node-local facts and O(1)-mergeable aggregates. Branch-level
questions (is this node blocked, is it ready) are answered by an O(depth) ancestor walk at read
time, and claims re-validate against authoritative rows inside the claim transaction. This removes
the fan-out of "one leaf done unblocks a whole later sibling subtree" and the
"ancestor plan approval removed invalidates a subtree" problem (no stored `blocked`,
`is_ready_leaf`, `nearest_approved_plan_id`, `root_id`, `depth`; they are computed; reparent is a single-row update on `todo` plus the contribution maintenance in 3.3.2).

Stored for readiness: `self_blocked` (own `blockedReason` or own unapproved plan gate),
`open_descendants` and `subtree_open` (propagated up only when a node's count crosses 0, so a
status flip costs O(depth) at most). The sequential-sibling rule (`todo-tree.js:392-430`) reads the
first two open siblings of each ancestor from the partial index on `subtree_open=1`, O(log n) per
ancestor, with no forward scan past 100 000 closed siblings. **Parallel scope collisions** (`todo-parallel-scope.js:344-376,478-503,574-585`) union the scopes of
the *open descendants* of every `doing` sibling; scopes include **globs** (`lib/*.js` blocks
`lib/a.js`), a node's own scope **shadows** its descendants (the walk stops there, `:363-366`), and
any open descendant with no scope makes the whole branch "unknown" (a collision). The index only
narrows; the decision uses the existing matcher:

- `todo_scope_contrib(ws, group_id, branch_child_id, todo_id, kind, pattern, dir_bucket)` has one row
  per (open node, scope pattern, enclosing `parallel` ancestor group), `kind` = `scope` or `unknown`.
  Rows are kept **unfiltered** (no shadow filtering), so a scope change on an intermediate node rewrites
  only that node's rows. `dir_bucket` is the literal directory prefix before the first glob; it makes
  glob rows findable by prefix/ancestor/descendant bucket lookups;
- unknown scope is **branch-qualified** (`kind='unknown'` rows with `branch_child_id`), not a per-group
  counter, so a candidate's own branch never blocks itself;
- candidate check: bucket lookups in the group for branches whose branch row is `doing` (and not the
  candidate's own branch), then the existing `leafScopePathsCollide` on the found rows, plus an
  O(depth) shadow check that no node between the contributor and its branch child has its own scope.
  If more than `scope_row_cap` (default 5 000) rows are found the candidate is treated as colliding
  (conservative, `capped`);
- maintained in the writing transaction when a node opens/closes or its scope changes: O(depth x
  patterns of that node), only through `run_mode=parallel` ancestors. Property test against
  `isTodoBlockedByParallelSiblingScope`, including globs, scoped containers and unknown scope.
Gate: a `doing` container with 100 000 open descendants.
Collision checks run only for returned candidates, never by rescanning siblings.
`readyLeaves` scans the partial index `status='ready' AND is_leaf` with the O(depth) walk,
a rows-visited cap and a `capped` flag. Gate: "status flip under a 100 000-child sequential and
parallel parent" (section 5).

Parent status is the 5-state rule in `lib/todo-tree.js:292-317` (`synchronizeTodoParentStatuses`):
it yields done/deferred/doing/ready/idea, depends on the parent's previous status, and bumps the
parent's CAS token only when the status changes. A `done` counter cannot reproduce it, so:

- each parent stores **per-status direct-child counters** (`n_idea..n_deferred`) plus its single
  stored `status` (no separate `computed_status`); archived children keep counting toward the parent;
- the repository applies the *same function* (ported, not re-derived) to the counters and the
  parent's previous status, in the child's transaction, walking up while the status changes (O(depth));
- counter-only changes do **not** touch `updated_at`;
- review aggregate of a parent is **counter-based** (per-state child counters, merged with the
  existing `aggregateTodoReviewStates` rule, `todo-review-state.js:371`), never recomputed over
  100 000 children;
- equivalence of stored and recomputed values is enforced by a property test against the current
  in-memory implementation (`todo-tree.js`) and by a verifier that reports drift. The verifier is
  a *monitor*, not a safety mechanism: correctness comes from claim-time validation.

#### 3.3.1 Integration proof fingerprint (versioned, incremental)

`fingerprintTodoTree` (`todo-integration-proof.js:44-64`) hashes the sorted material of the whole
subtree, including `body`, `plan`, `execution`, `chatId` (`:28-36`); stored evidence compares it
by exact equality (`todo-integration-read.js:101-148`). It cannot be kept incrementally as is, so:

- **v2 fingerprint**: `material_fp(node)` = `H("todo-node-v2" || id || parent_id || own material)` (same material fields as v1,
  plus node and edge identity, domain-separated); `tree_fp(node)` = `H("todo-tree-v2" || material_fp(node) || combine(tree_fp(child_i)))` where `combine` is an
  order-independent multiset hash (sum of the child hashes modulo 2^256), so changing one
  descendant updates each ancestor in O(1) -> O(depth) in total, independent of the number of siblings;
- identity is part of the hash, so replacing a child by another id with identical material, swapping equal-material subtrees, or reparenting a root all change the proof (v1 behavior, `todo-integration-proof.js:59-64`); tests cover each of these;
- all material-change triggers recompute `material_fp` in the writing transaction (body, plan,
  execution, chat link, id/parent change) and propagate the delta up;
- evidence stores `fingerprintVersion`; "is the proof still valid" stays a read-time comparison of
  the evidence's fingerprint with the current `tree_fp` (no stored coverage flag to invalidate);
- migration: an offline streaming pass verifies every v1 evidence with the **old** algorithm once, then
  re-stamps it as v2. Gate: **0 integration-state changes across the import**; plus gates for
  "body edit under a 100 000-child parent" (ACK) and "proof validity after the edit".

#### 3.3.2 Bulk structural operations (fenced, not single huge transactions)

Reparent and reorder are single-row updates on `todo` (no stored `root_id`/`depth`, sparse `order_key`), **plus** maintenance of `todo_scope_contrib` (3.3) when the moved subtree has open scoped nodes and the old or new ancestor chain contains a `parallel` group, O(1) plus two O(depth) counter
chains. Two further operations change `group_id`/`branch_child_id` of scope contributions: **reparent**
into/out of a `parallel` group and switching a container's `run_mode` to/from `parallel`. They rewrite the
contribution rows of the open scoped nodes in the affected subtree (not the `todo` rows): inline when
that is <= 1000 rows (one transaction, in the caller's request, so a reparent stays one atomic
operation), otherwise a fenced bulk job with the same atomic publication as 3.3.2 (contributions of the
new group are staged and switched by `published_jobs`; claims under the subtree get `409 todo_in_bulk_job`
meanwhile, which is conservative). Most reparents are O(1) because most subtrees have no open contributors (including `kind='unknown'` rows) or no parallel ancestor. Property tests compare contributions against a recomputation from the tree
after random reparent and run-mode sequences. Operations that really touch many rows are: container state propagation
(ready/deferred/restore of a container, `todos-persist.js:2103-2143`), archive/restore of a subtree, and
cross-workspace move. Their contract:

- subtrees of **up to 1000 rows run inline in the caller's request** (one transaction, result in the `todo_update` response exactly as today, so the agent-visible contract is unchanged); only larger ones use a job:
- a `bulk_job` row (journal) owns the operation; the **subtree root is fenced** (`frozen_by_job`):
  writers and claims under it get a retryable `409 todo_in_bulk_job`; readers see each row as
  currently committed (every chunk leaves every row individually valid);
- chunks <= 1000 rows, each with its own CAS on the row version; the job is resumable after a
  crash from the journal and cancellable (cancellation rolls forward or back whole chunks, never
  half a row); ACK to the caller is given when the job is *accepted* with a job id; completion
  is observable via `GET /api/todo-jobs/:id` and a ChangeSet event;
- **cross-workspace move**: if the subtree is <= 1000 rows, one transaction (as in the ADR).
  Otherwise staged, with visibility behind **constant-size metadata**: (1) fence the source subtree
  *first* (no concurrent change after the snapshot point); (2) copy into the target with
  `staged_job_id` set, and stamp **every** source row with `pending_move_job` (in chunks, while fenced; it has
  no effect before publication); (3) precompute count/roll-up deltas in the job row; (4) **publish in one small
  transaction**: `bulk_job.state='published'`, apply the precomputed deltas, attach the target root,
  and mark the job published (no per-row write). Every query, flat or tree, point read or search, includes
  the predicate `(staged_job_id IS NULL OR staged_job_id IN published_jobs)` and
  `(pending_move_job IS NULL OR pending_move_job NOT IN published_jobs)` against the tiny `published_jobs`
  table (rows live only until cleanup finishes), so no per-row flip is needed and **every** source row (not just the root) is hidden as soon as the job is
  published. Queries over the target read the `staged_job_id IS NULL` range and one extra range per
  published job (k-way merge, at most 4 concurrent staged moves per store). Known, accepted
  degradation: a cross-workspace move above 1000 rows is rare and administrative; while its cleanup
  backlog drains (cleanup runs at priority, chunked), `listPage`/`readyLeaves` p99 <= 100 ms instead of
  25 ms and rows visited are bounded by the backlog; gated in section 5. Tests cover non-root ids in both
  workspaces before publication, after it and throughout cleanup; (5) cleanup (delete source rows, clear
  `staged_job_id`, reassign chat links) runs in idempotent resumable chunks and then removes the job
  from `published_jobs`. Material refs move by reference (no file copy); cross-workspace links resolve
  through the job map until cleanup ends;
- writer latency while a job runs is a gate (section 5).

### 3.4 Counts

`counts` must not be `GROUP BY` over active rows (that is O(N)). `workspace_counts` holds
maintained dimensions: status, review_code_state, review_plan_state, archived, and the cross
dimension status x review_code_state; they are updated in the write transaction via `ChangeSet.countsDelta`.
Combinations beyond these dimensions are served by index plans with a result `limit` and a
"capped" flag, never an unbounded scan. A rebuild-counts command and the verifier above guard drift.

### 3.5 `leafMaterial` (49% of the data) — lossless

It is **not** only an integration artifact: it is read by `workspace-watcher-scheduler.js:164`,
`workspace-watcher-review-gate.js:69`, `delegation-service.js:2112,2393`, `review-verify-baseline.js`,
`lib/todo-leaf-material.js` (scope, sibling baselines, checkpoint recovery). Therefore:

- light columns `has_leaf_material`, `base_commit`, `last_checkpoint_commit` serve the hot paths;
- manifests are stored as **a shared base plus a per-leaf delta** (path-level), or chunk-deduplicated,
  because whole-blob hashing dedupes poorly; payload bytes live in `data/todo-material/` (content
  addressed) referenced from `todo_material_ref`;
- **nothing is deleted by default.** Compaction to a reference is an opt-in retention contract
  (Settings), requires tested durable reconstruction (a commit id alone is insufficient for
  project-mode manifests) and the owner's explicit approval; until then retention = lossless;
- **publication protocol** (power-loss and GC safe), identical on JSON (phase 0) and SQLite:
  1. commit a **pin** (`todo_material_pin(hash, writer_id, lease_until)`; on JSON a small pin file in
     `data/todo-material/pins/`, directory fsynced) *before* the content exists;
  2. write the content to a temp file in the same directory, fsync the file, `rename` to its hash
     name, **fsync the directory** (same primitive as `history-migration-fs.js:160-164`);
  3. in one transaction commit the reference row(s) (including delta -> base edges) and delete the pin;
  4. GC deletes a hash only when its refcount is 0 **and** no live pin exists **and** the file is older
     than a grace period (default 24 h), never while a backup/export holds the maintenance lock, and
     **serialized with pin acquisition and reference publication**: GC first marks the hash `deleting`
     in one transaction (fails if a pin or reference appears), then unlinks, then removes the mark; a
     writer that finds the hash `deleting` **waits/retries until the deletion completes**, then acquires
     a fresh pin and republishes; reference publication rejects a `deleting` hash, so a reference can
     never point to content that GC is about to unlink. On JSON the
     same ordering is enforced by the workspace todo lock;
  5. pins carry a writer epoch and lease. The reference-commit transaction *consumes* the pin
     (`DELETE ... WHERE id=? AND epoch=? AND lease_until>now` must affect one row), so a paused writer
     whose pin expired and was discarded by recovery cannot commit: it aborts and republishes with a
     fresh pin. Restart recovery removes expired pins, then orphans are collected under rule 4. Reference closure
     (every delta's base present) is verified on backup, restore and migration;
- `data/todo-material/` (and `pins/`) is added to `storage-registry.json`
  (`managedPaths`/`retainedPaths`), the offline backup set, the rollback export and the migration
  source manifest;

### 3.6 Archive tier

`archived_at` on the same table. Archived rows are excluded from default listings, counts and
watcher queries by index predicate, remain addressable by id (`cretli-ref`, `source_todo_id`, chat
links), searchable (`archived=1`) and restorable. Archiving a finished subtree is a **chunked,
resumable bulk job** (3.3), not one giant transaction; partially archived trees keep valid
roll-ups (archived children still count). Only whole done subtrees may be archived under a parent,
and the parent's readiness/fingerprint are recomputed by the same invalidation rules. Retention
policy (default: `done` subtrees older than 30 days; owner decision) is opt-in. The functional
cap is removed; the safety bound (default 5 000 000 per workspace) returns a clear error.

### 3.7 Concurrency domains

- **Ordinary patch:** CAS on `updated_at` (`expected_updated_at`).
- **Review outbox:** the cross-store intent is written **atomically with the delegation mutation**,
  in `delegations.sqlite` (the authoritative source of review verdicts): a `review_outbox(todo_id,
  source_generation, payload)` row in the same transaction as the verdict. A drainer applies it to
  the todo store with an idempotent `reviewWrite` keyed by `source_generation`, right after the
  delegation transaction commits (post-commit trigger), and at startup and on a timer only for recovery;
  gate: time from verdict to the todo's review state. While an outbox row exists for a todo, its review state is reported as `pending`, and any
  gate that needs a PASS (claim, integration, close) treats `pending` as not-PASS, so a stale or
  missing PASS cannot be acted on. A crash between the two stores leaves the outbox row, never a
  silent gap.
- **Review writes:** keep their own contract — they deliberately preserve `updatedAt`, use
  `expectedGeneration`/`decisionKey` and suppress scheduling nudges (`todos-persist.js:2155-2194,
  2237-2268`; `todo-review-sync-hooks.js:398-399`). Dedicated `reviewWrite` op with `review_generation`.
  Denormalized review state originates from `delegations.sqlite`; a durable reconciliation record is
  written first (outbox), so a crash between the two stores cannot leave a stale PASS; the
  verifier re-derives from delegations and reports drift.
- **Watcher coupling:** `commitWatcherTodoCommand` (`todos-persist.js:2534-2637`, 8 files) checks
  watcher revision, watcher timestamp and todo CAS together with a journal across two stores.
  Specified as a version-checked two-store command (ADR section 4) with fencing and recovery on
  restart; no caller holds the watcher file lock across an `await` of the repository.
- **Group commit** for independent commands with per-command receipts; no early acknowledgement
  (`post-commit-todo-cas`).
- **Cross-workspace move:** one transaction up to 1000 rows (ADR section 4); larger subtrees follow the staged protocol in 3.3.2.

### 3.8 API

- **Legacy `GET /api/todos` is unchanged** (full, current shape) until every consumer is migrated;
  new behavior is opt-in by version (`?v=2` or `Accept` negotiation). Consumers to migrate first:
  `core/api/todos.js`, `todoListRefresh.js`, `todoDetail.js`, `remote-api-client.js` (MCP
  `todo_list`/`todo_next_ready`/prefix resolution). The old route is deprecated only after all move.
- New routes `GET /api/todos/page`, `/children`, `/counts`, `/search` are registered **before**
  `/api/todos/:id` (whose skip list covers only `usage` and `integrate-batch`, `todos-routes.js:688`).
- `GET /:id` becomes an indexed point read; **mutation responses return the affected rows and the
  ChangeSet**, not a whole-workspace payload (`jsonTodosPayload` on a document is removed).
- **Cursor semantics:** keyset on `(sort_key, id)`, bound to workspace + filter + sort; pages carry
  the `revision` they were read at. A row updated between pages may be seen twice or skipped by the
  "recency" sort; this is accepted and documented, and the client dedupes by id and refetches the
  visible window when `revision` advances. Sorts that need stability (tree order, status tabs) use
  immutable keys.
- **ETag** is derived from `revision` plus the versions of joined sources (chats, worktrees,
  delegations); short TTL stays for sources without versions.
- MCP: `todo_list` keeps `cursor`/`limit` (already exists, `todo-tools.js:450-451`) and gains
  `archived`, `parent_id`; new `todo_archive`, `todo_restore`, `todo_counts`.

### 3.9 Front end

Virtual scroll for flat views; tree loads children per expanded node (cache keyed
`(parentId, revision)`, **bounded LRU**, as are detail caches). Tab counts/badges come from
`/counts`. `collectTodoSubtreeIds`/`buildTodoIndex` users (`todoStatusIcon.js:1`,
`todoIntegrationRules.js:2`, `todoReviewBadge.js:17`, `todoTreeView.js:10,664`, `todoBatchSelection.js`)
switch to server data (`blocked`/`ready` returned by the API, aggregates). Selection and batch actions
work on ids and server-side filters ("all matching"). Search is server-side. Live updates apply
by id from ChangeSets; a revision gap refetches only visible pages. The client no longer computes
readiness itself.

## 4. Phases (each shippable and reversible; each has a named gate)

**Phase 0 — safe relief on JSON (expand/contract).** In this order:
1. *Reader first*: ship code that reads both inline and externalized material/idempotency and
   archive references, behind no data change. Older binaries cannot read externalized data, so
   rollback = a shipped *inline-back* tool plus a documented minimum version.
2. Fix the cap/idempotency ordering bug (idempotency replay before cap check) and replace the raw-args
   idempotency map with `args_sha256` (keeping replay compatibility with existing keys).
3. Externalize `leafMaterial` with the 3.5 write-order, registered in
   `storage-registry.json`, backup set and migration source manifest **before** any data moves.
   Verified by hash; crash tests at each publication boundary (file written / row committed / GC).
4. Replace the item cap by a **byte budget**: the serialized workspace document may be at most
   24 MB (warning at 80%, `todo_create` refused with a clear error above it). With the heavy half
   gone the real 2000-item file is about 15 MB, ~7.5 KB per item, so the budget allows roughly
   3 000 items; the earlier "10 000 items" idea would mean ~75 MB of synchronous stringify per write
   and is rejected. Gate: write ACK and event-loop max measured on the largest real file before
   and after.
   Idempotency stays **inline in the same document** on JSON (create and mapping commit together as
   today, `todos-persist.js:1593-1601`, so a crash cannot produce a duplicate), but as hashed
   `args_sha256` entries (about 190 KB instead of 2.9 MB for 1904 keys), still bounded by
   `TODOS_MAX_IDEMPOTENCY_ENTRIES` (`todos-persist.js:68`). The separate `todo_idempotency` table
   arrives only with SQLite, where the create row and the mapping share a transaction. No sidecar file.
   *No JSONL archive in phase 0* (rejected in review: multi-file removal without a crash-safe
   protocol, and the migration reads only `todos/*.json`). Archiving waits for phase 5.

   **Phase 0b status (expand step, no data moved).** Shipped: `lib/todo-material-store.js` (content-addressed
   store under `data/todo-material/`, pin -> fsync -> temp -> rename -> fsync-dir publication, `consumePin`
   after the document write, `gc` with the `deleting` mark and a single-runner `gc.lock`, restart `recover`);
   the todos loader hydrates `{ $ref: 'sha256:<hex>', bytes }` references (missing or corrupt file = error,
   never dropped material); the writer is opt-in via `CRETLI_TODO_MATERIAL_EXTERNAL=1` (default off, done
   items only, ordering publish -> document write -> consume pin); `todo-material/**` is a managed path of
   `store.todos`, so the offline backup set carries it, and the migration source manifest and the rollback
   activation verify reference closure; `scripts/externalize-todo-material.js` is the dry-run-first offline
   tool with `--inline-back`. Writers, GC and recovery share one store fence (`store.lock`, link-created, owner id plus persisted fencing
   token, fenced stale reclamation): a commit validates pins, writes and fsyncs the document (file and
   directory) and releases the pins inside the fence. GC fails closed when any todos document is unreadable.
   The rollback export ships the referenced material and activation restores it before publishing documents.
   Not done yet: running the tool on real data, scheduled GC, delta/base
   manifests, and the SQLite pin table. Older binaries cannot read references: use `--inline-back` before
   downgrading.

**Phase 1 — repository interface and global conversion.** Introduce `TodoRepository` with a
JSON-backed implementation; convert callers in vertical slices (HTTP list/detail/patch, watcher claim and
coupled command, MCP, move/takeover, review sync/backfill, integration, scripts). Inventory first:
every `loadTodosData`/`listTodos`/`exportSnapshot` use, aliases, adapters, response builders,
indirect consumers. Gate: a **repo-wide** guard test (not per-module) fails on any import of the
document API outside the shim; the shim fails closed above 64 MB of document (above the largest current file, so no workspace breaks mid-conversion); mutation responses
no longer build whole-workspace payloads.

**Phase 1 slice 1 status (read side, JSON backend).** Shipped: `lib/persist/todo-repository.js`
(`getRow`, `getDetail`, `listPage`, `listChildren`, `counts`, `revision`; no `listAll`, `limit` capped at 200)
over the `store.todos` facade, with a per-workspace light-row index keyed by the committed revision
(LRU of 4 workspaces; nothing is serialized per request; the cached index retains the complete raw items, so memory is bounded by workspace count, not by heavy-field bytes). Routes `GET /api/todos/page`,
`/api/todos/counts` and `/api/todos/:id/children` are registered before `/api/todos/:id`, whose skip list now
also covers `page` and `counts`. `GET /api/todos/:id` is a point read (id or unique >=8-char prefix; an ambiguous
prefix answers 409): the legacy enrichment runs on the item, its ancestors and its subtree only (plus the whole
subtree of an ancestor holding tree-scoped integration evidence, because its fingerprint covers it).
Cursors are keyset `(sortKey, id)` bound to workspace + filter + sort and stamped with the revision; a row
that changes between pages may repeat or be skipped under `sort=updated` (client dedupes by id and refetches
on `revision` change; `stale: true` flags a page read after the cursor's revision); `sort=tree` keys derive
from `siblingIndex` structure only. Light rows carry the stored (not container-rolled-up) code/plan review
state. Legacy `GET /api/todos` is unchanged. `tests/todo-document-api-ratchet.test.js` fails when
whole-document readers (`listTodos(`, `loadTodosData`, `exportSnapshot`, `jsonTodosPayload`) grow outside the
shim. Not done: mutation responses, `search`, front-end migration, converting the remaining callers.

**Phase 1 slice 2 status (MCP/agent read path).** `todo_list`, `todo_show` and the id/prefix resolution
behind the todo tools no longer load or serialize the whole list per call. They go through
`lib/todo-read-model.js` on the repository, which gained `listWindow` (document-order window + exact
filtered `total`; filters: exact status, review state with the container rule, derived integration
state/detail, `title body` substring), `resolveItem`, `readNeighbours` and `gateClosure`. The index
additionally keeps, per revision, the derived integration summary of every row (computed once at build
over the loaded document), a document position, a source-todo back-reference map and a lazily built
lowercase `title body` text for `query`. `execution_state` is computed over the plan-gate closure of the
rows on the page (ancestors, one child per chain node, source chains). The legacy whole-list readers stay
exported from `todo-tools.js` (`readTodoListLegacy`, `readTodoShowLegacy`, `resolveTodoIdOrPrefixLegacy`)
as the parity reference and for clients without the bounded methods; `tests/todo-read-model-parity.test.js`
compares both byte-for-byte on a 350-row mixed fixture and asserts `todo_list` / `todo_show` < 100 ms on
5,000 rows. Also converted: operator `resolveTodo` and delegation leaf lookup, remote `getTodo` (point read).

**`todo_next_ready` deliberately stays document-based** (`readTodoNextReadyLegacy`, public contract
unchanged): readiness (ancestor plan gates, earlier sequential siblings, `nonBlocking`, parallel scope
collisions, source chains) is branch state that cannot be re-derived exactly from a partial closure. It
moves to a bounded read only once the node-local readiness facts of section 3.3 exist (phase 2). A first
bounded attempt was rejected in review (root-scoped output leaked sibling leaves, source-chain rows became
output, capped output was not an exact prefix, the cap did not bound the request) and removed.
Still whole-document on purpose: `todo_next_ready`; `todo_show` loads all direct children of the shown node
(review aggregate needs them); mutation tools (`todo_create`/`todo_update`/`todo_start` rollback and
held-warning leaf checks, `delegation_start`); operator watcher snapshot; the remote client keeps
`listTodos` for REST consumers.

**Phase 2 — SQLite repository implementation** (schema above) in the storage worker, reusing host,
receipts, fencing, marker, export. Includes: *runtime wiring* of `openTodosRuntime` in startup
(fail-closed backend selection, shutdown, restart acceptance criteria) behind the marker; importer
that builds rows, blobs, counters, derived columns, FTS and material refs from JSON, verifying
per-status counts and logical export hashes; root-causing the earlier export-hash mismatch.

**Phase 3 — paged API and front end** on top of the repository (works on JSON from phase 1,
before SQLite exists, so it is testable early). Version-negotiated routes; consumers migrated; then
legacy deprecation.

Front-end design (consumer inventory, F1/F2/F3 slices, gates): [todo-front-paging-design.md](todo-front-paging-design.md).

**Phase 4 — scale proof (gates in section 5), then cutover.** Scale proof comes **first**:
synthetic generator and the gates below pass on the SQLite repository. Only then the quiesced
cutover (verified copy, rehearsal, marker). A **scale-compatible rollback**: streaming,
schema-versioned exporter and a rollback backend that accepts post-cutover writes at full size,
retaining receipt/fence identity and `data/todo-material/`; the existing rollback machinery
(in-memory whole-document export, still capped at 2000 in the legacy save path,
`todos-backend-rollback.js:211-238`, `todos-persist.js:1296-1301,1434-1439`) is **not** adequate
and is reworked before the first durable SQLite ACK.

**Phase 5 — archive, retention, cap removal.** `archived_at` bulk jobs, Archive view, retention
settings (opt-in), remove the soft cap, keep the safety bound.

## 5. Gates (not to be lowered; evidence = benchmark report like `storage-todos-benchmark.md`)

Fixtures: **smoke** (CI-lite) 10^5 light rows + 10^3 realistic heavy rows; **full** 10^6 light rows
with blobs sampled from the production distribution only for a 1% subset (so FTS and storage-scale evidence is limited to that subset and is documented as such) (scaling the ~16 KB average to 10^6
rows would be tens of GB before index/WAL; blobs are not scaled linearly). Skewed shapes: 95% archived,
50 000 active, deep trees (depth 6), wide parents (100 000 children).

| Gate | Limit |
| --- | --- |
| `listPage` 50 rows (status/review/plan combinations), p95 / p99; and rows visited | 10 / 25 ms; <= 500 visited |
| `listChildren` 50, p99; wide parent (100 000 children) | 15 ms |
| `counts` p99 (maintained dimensions) | 5 ms |
| point `getDetail` / prefix resolve, p99 | 10 ms |
| FTS5 search 50 hits (title+body), p99 | 60 ms |
| `readyLeaves` 50 with 50 000 active, p99 | 25 ms |
| `patch`/`create` ACK p95 / p99; incl. depth-6 ancestor roll-up | 20 / 50 ms |
| status flip / body edit under a 100 000-child sequential and a parallel parent (ACK; proof validity) | 50 ms p99 |
| `listPage`/`readyLeaves` p99 during a 100k-row staged-move cleanup | <= 100 ms |
| claim during a running bulk job (stale eligibility rejected) | 100% rejected or valid |
| integration-state changes across import (fingerprint v1 -> v2) | 0 |
| power-loss/crash tests for material pin -> publish -> reference -> GC | pass |
| bulk job (100k-row archive/reparent): writer p99 during it | <= 50 ms |
| burst of 200 independent commands | <= 2 s |
| event-loop p99 / max | <= 25 / <= 100 ms |
| whole-workspace reads or serializations on main thread | 0 (routine paths) |
| page response size | <= 120 KB |
| committed-row cache memory (bounded LRU) | <= 64 MB for any N |
| cold start / cache rebuild at 10^6 rows | <= 5 s to first list response |
| import of the real 32 MB workspace; export hash round trip | equal hashes; time recorded |
| roll-up equivalence: stored vs `todo-tree.js` over randomized trees/ops (incl. archive/restore of partial trees) | 0 differences |
| verifier drift on counts / readiness / aggregates after chaos tests | 0 |
| crash tests: each material/archive/bulk-job boundary, backup/restore reference closure, receipt replay, concurrent cursor mutation | pass |

## 6. Risks and open decisions (owner)

1. Caller-conversion volume (~38 + ~20 files for update/add, plus facade callers): the schedule risk.
   Mitigation: shim + repo-wide guard + vertical slices.
2. Reproducing the 5-state roll-up and readiness semantics exactly (property tests are the gate).
3. Retention of `leafMaterial`: default lossless; any compaction needs explicit approval.
4. Archive default (30 days after `done`?) and whether archived rows appear in `todo_list` without a flag (proposal: no).
5. Order confirmation: phases 1 and 3 give most of the user-visible win on JSON; SQLite cutover follows them.
6. FTS covers title + preview + **body** (existing `todo_list` `query` contract matches body).
7. Parking root ("Na pozniej") id stored in `workspace_meta` instead of title search (`todo-tree.js:679-689`).
8. Phase 0 byte budget (proposal 24 MB serialized document, warning at 80%).

## 7. Non-goals

No change to the agent-visible todo model (ids, statuses, CAS, review contract). No system
deletion of todo content or material without an approved retention contract. No multi-node scaling.
