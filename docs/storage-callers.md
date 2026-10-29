# Storage caller inventory (A1)

Maps **mutation entry points** to registry store ids. Read-mostly callers are omitted
unless they perform read-modify-write (RMW). For store metadata see
[storage-registry.json](storage-registry.json).

Legend: **S** = synchronous on the Node event loop; **A** = async/worker/queued.

**Owner** = the future storage slice that converts the caller. Labels (defined here, derived
from each store's `domainOwner`/`adapters.migration`/`secrets.exportBoundary` in the registry):
`A3a` chat history, `A3b` chat metadata, `A4` operational state (TODO, watchers, recovery,
delegations), `A5` remaining state (settings, snapshots, memory, decisions, worktree registry,
MCP config, widget installations), `A6` cutover and removal of legacy writers, `B4` offline
recovery, or `stays-file: <reason>` for a store that deliberately keeps its file backend
(registry migration `none`/`retain-*`, or a credential/secret export boundary such as
`credential-boundary` and `never-in-app-data-export`). A caller inherits the owner of its
store id, so every row of one store id carries the same owner. `store.mcp-config` is owned by
A5 but only its settings part converts; the generated `mcp/*.yml` overlays stay files.
`tests/storage-callers-contract.test.js` enforces this table against the registry.

A3a now provides the opt-in library and schema in
[`lib/storage/chat-history-store.md`](../lib/storage/chat-history-store.md).
Production callers below still use the legacy adapter; no data or caller has moved.
The registry continues to describe that active backend. Caller conversion must
move each append/coalesce/retention critical section together and publish durable
history updates only after the new command commits.

## HTTP routes (Express)

| Store id | Route module (representative) | Pattern | Sync | Owner |
| --- | --- | --- | --- | --- |
| store.config-settings | `lib/routes/settings-routes.js` | RMW `config.json` (workspace sections excluded, see `store.workspaces`) | S | A5 |
| store.workspaces | `lib/routes/settings-routes.js` (`PATCH /api/settings`, `POST /api/workspace/refresh-from-file`) via `saveSettings` | sync SQLite transaction in `workspaces.sqlite`; replaces the registry, sidebar overlay, route keys and `additionalCursorContextDirs` (skipped when unchanged) | S | A5 |
| store.chats | `lib/routes/chats-routes.js` | RMW collection | S | A3b |
| store.chat-history | history routes / chat APIs | append batch → full rewrite per chat | S | A3a |
| store.todos | `lib/routes/todos-routes.js` | CAS + watcher lock | S | A4 |
| store.delegations | `lib/routes/delegation-routes.js` | owner lock / sqlite tx | S/A | A4 |
| store.delegation-mailbox | delegation inbox routes | RMW JSON | S | A4 |
| store.delegation-workflows | workflow routes | RMW JSON | S | A4 |
| store.delegation-ratings | rate endpoints | append JSONL | S | A4 |
| store.mcp-config | MCP settings routes | queued async journal write | A | A5 |
| store.usage-journal | `lib/routes/usage-routes.js` | append + ledger | S | stays-file: append journal kept unless a separate measured gate says otherwise |
| store.workspace-watchers | `lib/routes/workspace-watcher-routes.js` | CAS under file lock | S | A4 |
| store.worktree-registry | `lib/routes/worktrees-routes.js` | RMW registry | S | A5 |
| store.notification-center | notification routes | RMW + prune | S | A5 |
| store.push-subscriptions | push subscribe routes | RMW subscriptions | S | stays-file: credential boundary (VAPID private key), registry migration none |
| store.widget-installations | widget routes | RMW | S | A5 |
| store.auth-sessions | login/logout (`lib/auth.js`) | sessions map flush | S | stays-file: credential boundary (auth/session secrets), registry migration none |
| store.approval-audit | approval routes | append audit | S | A5 |
| store.harness-usage-limits | usage limit routes | RMW limits file | S | A5 |
| store.sidebar-layout | sidebar layout API | RMW `sidebar-layout.json` | S | A5 |
| store.benchmark-snapshots | benchmark routes | RMW `benchmark-snapshots.json` | S | A5 |
| store.model-pick-overrides | model pick settings | RMW `model-pick-overrides.json` | S | A5 |
| store.model-role-profiles | harness/model settings routes | RMW `model-role-profiles.json`, `model-score-heuristics.json` | S | A5 |

## WebSocket / harness runtime

| Store id | Module | Trigger | Sync | Owner |
| --- | --- | --- | --- | --- |
| store.chat-history | `lib/agent-harness/*`, harness WS | stream append / coalesce flush | S | A3a |
| store.chats | harness lifecycle, fork/resume | metadata updates | S | A3b |
| store.recovery | `lib/recovery/recovery-lifecycle.ts` | intent CAS, queue | S (SQLite) | A4 |
| store.delegations | `lib/delegation-service.js` | status/slot updates | S | A4 |
| store.usage-journal | harness usage hooks | append usage envelope | S | stays-file: append journal kept unless a separate measured gate says otherwise |
| store.mcp-config | `harnesses/deepseek/mcp-deepseek-patch.js`, `harnesses/deepseek/dsh-runtime-patch.js` | harness spawn: **non-atomic** `writeFileSync` of generated `mcp/*.yml` overlays (retained class, not the `mcp.json` journal path) | S | A5 |

## Background timers / schedulers

| Store id | Module | Notes | Owner |
| --- | --- | --- | --- |
| store.workspace-watchers | `lib/workspace-watcher.js` | tick, lease, cycles | A4 |
| store.todos | watcher claim/release | `withTodosWatcherNudgeSuppressed` | A4 |
| store.workspace-memory | `lib/workspace-watcher-scout.js` | fact upserts | A5 |
| store.port-exposures | `lib/port-exposure/runtime.js` | TTL expiry and reconcile job | stays-file: operational JSON ledger, registry migration none |
| store.apps-state | `lib/apps/runtime.js` | app runtime state | stays-file: small runtime JSON state, registry migration none |
| store.workspace-watcher-cycles | `lib/workspace-watcher-cycle-metrics.js` | cycle metrics | A4 |
| store.usage-journal | `lib/usage/usage-retention.ts` | prune old journal days | stays-file: append journal kept unless a separate measured gate says otherwise |
| store.notification-center | notification producers | fingerprint publish | A5 |
| store.auth-sessions | `lib/auth.js` | session sweep | stays-file: credential boundary (auth/session secrets), registry migration none |
| store.model-pick-decisions | `lib/model-pick-decisions.js` | open decision rows | A5 |
| store.delegation-mailbox | ack/delivery loops | mailbox RMW | A4 |
| store.chat-title-history | `lib/persist/chat-title-history-persist.js` | title generation / chat rename hooks | A3b |
| store.model-pick-explore | `lib/model-pick-explore.js` → `lib/persist/model-pick-explore-persist.js` | background explore-state persist | A5 |
| store.model-pick-overrides | `lib/workspace-watcher-orchestrator.js` | background override writes (also HTTP — see above) | A5 |
| store.model-role-profiles | `lib/harness-models-snapshot.js` | models snapshot refresh; registry flags a temp write to verify under quiesce | A5 |

## MCP tools (server-side writers)

| Store id | Tools | Owner |
| --- | --- | --- |
| store.todos | `todo_create`, `todo_update`, `todo_start`, … | A4 |
| store.workspace-memory | `wmem_add`, `wmem_delete` | A5 |
| store.workspaces | `wsreg_add` (a `.code-workspace` path is imported once), `wsreg_remove`; `todo_move` and `wsreg_*` accept any workspace id/alias from the SQL registry | A5 |
| store.delegations | delegation lifecycle via HTTP backing | A4 |
| store.workspace-watchers | `watcher_update`, `watcher_report`, … | A4 |

## Subprocess / CLI (when server running)

| Store id | Source | Notes | Owner |
| --- | --- | --- | --- |
| store.delegations | child harness via server APIs only | no direct file write from child | A4 |
| store.worktree-registry | `lib/worktree-manager.js` git worktree | registry mutate | A5 |
| — | harness homes (`claude-home`, …) | **retained**, not app-state stores | stays-file: harness homes are not app-state stores |

## Read-modify-write critical sections (DATA-02)

| Section | Stores touched | Risk |
| --- | --- | --- |
| Watcher todo claim | `store.todos`, `store.workspace-watchers` | nested lock reentrancy OK |
| Chat append batch | `store.chat-history` | whole-document rewrite; high write amplification |
| Chats list update | `store.chats` | lost update if concurrent HTTP without lock |
| MCP config save | `store.mcp-config` | two-file journal; must roll forward |
| Usage append | `store.usage-journal` | journal + index; lock dir serializes processes |
| Delegation slot | `store.delegations`, `store.recovery` | separate backends; no single TX today |
| Settings workspace registry | `store.workspaces` | load→mutate→`saveSettings` replaces the sections in one SQL transaction (lost update if two callers interleave, as before); no file is read per render |

## Synchronous callers (main-thread blocking)

All JSON persist modules listed as **S** above run on the HTTP/WS thread today.
SQLite **`store.recovery`** and lock-only SQLite files use `DatabaseSync` on the
main thread. A worker-backed consolidation must not wrap these with a blocking facade
(storage-contract DATA-02).

## Unresolved writers (mirrors registry `inventoryGaps` 1:1)

| Gap id | Paths | Writer(s) | Blocks consistent snapshot |
| --- | --- | --- | --- |
| `gap.workspace-folders-direct-write` | `<workspace>/.cursor/**` (non-data) | `lib/workspace-folders.js` `writeFileSync` | no |
| `gap.webpack-cli-watch-lock` | `webpack-cli-watch-lock.json` | `lib/webpack-cli-watch-lock.js` | **yes** |
| `gap.harness-provider-homes` | `claude-home/`, `codex-home/`, `codebuddy-home/`, `dsh-home/`, `qwen-home/`, `sdk-agent-store/`, `npm-cache/_npx/` | harness CLI installers, `lib/claude/*`, `lib/codex/*`, `lib/sdk/*` | no |
| `gap.plan-limit-history-direct` | `usage/plan-limits.jsonl`, `usage/limits.jsonl`, `usage/unclassified-errors.jsonl` | `lib/usage/plan-limit-history.ts`, `lib/harness-usage-limits.js` | **yes** |
| `gap.delegation-json-shadow` | `delegations.json` | `lib/persist/delegation-migrate.js` (`lib/model-pick-history.js` read-only stat) | **yes** |

Any gap with `blocksConsistentSnapshot: true` **fails** a "complete data directory"
snapshot until quiesced or registered (DATA-08 / BACKUP-02). Three of five currently block.

Resolved since the first inventory draft: the generated DeepSeek overlays under
`data/mcp/` (`harnesses/deepseek/mcp-deepseek-patch.js`, `harnesses/deepseek/dsh-runtime-patch.js`) are
no longer an unknown writer — they are registered on `store.mcp-config`
(`writers.known`, retained paths `mcp/dsh-mcp-bridge.yml`,
`mcp/dsh-mcp-bridge.yml.meta.json`, `mcp/dsh-runtime.cordis.patch.yml`). They still
write **non-atomically** (plain `writeFileSync`, no temp+rename), so B6 must gate or
tolerate a torn overlay; the files are regenerated at harness spawn.

## Workspaces store (`store.workspaces`)

Owner slice A5 (the settings sections moved out of `config.json` early, as a small separate SQLite store ahead of the rest of A5; the owner column above uses `A5` for it).

`workspaces.sqlite` holds the workspace definitions: registry rows (stable UUID,
current id, name, default folder, order, flags, `imported_from` metadata), ordered
folders with enabled flags, alias ids, clone overlays, durable route keys and
`additionalCursorContextDirs`. Schema: `lib/storage/schema/workspaces-0001.js`,
applied by `WORKSPACE_MIGRATIONS` in `lib/storage/migrations.js` (its own
`schema_version` lineage; the registry is read synchronously on the main thread, so
it is not part of the worker-owned consolidated store).

- Callers keep the settings-shaped API: `loadSettings()` serves the four sections from
  SQL, `saveSettings()` writes them to SQL and omits them from `config.json`.
- One-time migration (`migrateWorkspaceSettingsFromConfig`): on the first load that
  still finds the sections in `config.json`. `kind: 'folders'` rows are copied as is;
  `kind: 'file'` rows get a snapshot of the folders (overlay order first, then file
  folders the overlay did not know), keep their old id (the file path) as the current
  id and alias, and record the file path as `importedFrom`. `config.json` is cleaned
  by the next `saveSettings`.
- `.code-workspace` is read only by an explicit import (`PATCH /api/settings`
  `workspaceAddPath`, MCP `wsreg_add`) and the explicit "refresh from file"
  (`POST /api/workspace/refresh-from-file`, `GET /api/workspaces?sync=1`). A second
  import of the same file answers `duplicate_import` (HTTP 409) unless confirmed
  (`workspaceAddConfirmDuplicate` / `allow_duplicate`).
- Todos, chats and delegations stay keyed by the working directory (default folder).
- Rollback / backup export (B1): `exportConfigWithWorkspaces()` (settings.js) returns
  `config.json` merged with the SQL sections in the pre-SQL shape;
  `node scripts/workspaces-export-config.mjs [--write]` prints or applies it.

## Todos store (`store.todos`)

Owner slice: todos-worker (storage worker domain handler: `lib/storage/todos-store.js`).
The domain stays on its legacy synchronous JSON adapter (`lib/persist/todos-persist.js`)
until every caller and whole atomic command is converted (`docs/storage-contract.md`
"Inventory all synchronous callers"). L2 adds the Promise facade `lib/persist/todos-store.js`
(`listTodos`, `getTodo`, `addTodo`, `updateTodo`, `deleteTodo`, `moveTodo`, `batch`) with a
backend interface; the only backend is the legacy JSON adapter (same behavior, same
file locking). Errors carry `code` `CONFLICT` (stale `expectedUpdatedAt`), `NOT_FOUND`
or `VALIDATION`. `tests/todos-store-sync-api-guard.test.js` enforces this inventory:
converted files may not import `loadTodosData` / `addTodo` / `updateTodo` /
`saveTodosData` from `todos-persist.js`, and no unlisted file may start using them.

### Converted to the async facade (leaves L2–L3c)

| File | Notes |
|---|---|
| `lib/routes/todos-routes.js` | All list/read/create/patch/delete/start-agent paths await the facade; helpers `worktreeSubtreeConflict`, `resolveFullModePhases` are async. |
| `lib/routes/chats-routes.js` | `DELETE /api/chats/:id` unlinks the todo via `await updateTodo`. |
| `lib/routes/chat-agent-routes.js` | `set-todo-from-agent` awaits `updateTodo` before answering ok. |
| `lib/routes/workspace-watcher-routes.js` | `blocked` and `refresh-worktree` read via `await listTodos`. |
| `lib/mcp/mcp-inprocess-client.js` | list/get/create/update/move go through the facade (`moveTodo` for `moveTodoTree`). |
| `lib/mcp/mcp-external-operator-tools.js` | `resolveTodo` is async; plan approve awaits `updateTodo`. |
| `lib/mcp/builtin/todo-tools.js` | Only imports constants/helpers (`TODO_STATUSES`, `describeBodyTruncation`); mutations go through the client (async). |
| `lib/remote-api-client.js` | HTTP client only; no direct persist use. |
| `lib/model-pick-leaf-implement.js` | The no-candidate blocker awaits the read and CAS update. |
| `lib/orchestrator-leaf-resolution.js` | Leaf context resolution awaits a TODO read when no items were supplied. |
| `lib/review-lessons-checks.js` | Check proposals await creation and conflict resolution. |
| `lib/usage/todo-usage-read.ts` | Usage views await the TODO read before building statistics. |
| `server.js`, `lib/server-health/server-stall-watchdog.js` | The stall watchdog receives async todo adapters and awaits signature lookup and incident creation. |
| `lib/worktree-deps.js`, `lib/worktree-list.js` | Worktree reports, cleanup, and list preparation await the TODO read. |
| `lib/todo-plan-sync.js` | Plan export and run summaries await reads and CAS mutations. |
| `lib/todo-leaf-material.js` | Context, baseline, checkpoint, partial paths, and workflow revisions await the facade; material mutations use CAS. |
| `lib/feedback-triage.js`, `lib/persist/feedback-store.js`, `lib/mcp/builtin/feedback-tools.js` | Moved from 3b in 3d. Report filing, claim, submit and decide await the facade; see Leaf 3d status. |
| `lib/workspace-watcher.js`, `workspace-watcher-control.js`, `workspace-watcher-delegation-guard.js`, `workspace-watcher-history-repair.js`, `workspace-watcher-review-gate-guard.js` | Leaf 3d2, see below. |
| `lib/todo-review-sync.js`, `lib/todo-review-sync-hooks.js` | Async plan-boundary reads and review commands; boot/retry/auto-close wait for writes before emitting changes. |

Async facade imports may retain local aliases such as `listTodos as loadTodosData`; these do not import the synchronous persist API. Indirect
paths: MCP tools -> `client.updateTodo` -> in-process client or HTTP -> facade.

### Remaining synchronous callers (allowlist in the guard test)

Each still imports at least one sync function and is converted by a later leaf:
`lib/todo-move.js` (the legacy backend's own tree-move helper) and `lib/persist/todos-store.js` (the legacy
adapter itself). Both leave with the backend flip in leaf 3f. Leaf 3e moved `integrate-batch.js`,
`todo-review-backfill.js` and the scripts `architecture-http-fixture.mjs`, `architecture-stall-profile.mjs`,
`audit-automatic-prompts.mjs`, `manual-smart-merge-fixture.mjs`, `measure-todo-save.js` and `scout-pass-fixture.mjs`
to the converted list (see Leaf 3e status).
Other files only use non-guarded helpers (`getTodoById`, `linkTodoChat`, `deleteTodo`, review
writers, constants) and are not sync-API callers for the guard.


### Read-modify-write critical sections

All run under `withWorkspaceWatchersFileLock` inside `todos-persist.js` (`addTodo`,
`updateTodo`, `deleteTodo`, `writeTodoReview*`, `closeTodoLeafIfEligible`, `linkTodoChat`)
and in `lib/todo-move.js` (`moveTodoTree`, cross-workspace). Callers that read then
write in separate calls (`todos-routes.js` patch: read for the worktree check, then
`updateTodo` with `expectedUpdatedAt`) rely on the CAS field, not on a held lock; no lock
is held across an `await` outside the persist layer.

### Leaf 3a status

- `todos-persist.js` exposes `legacy*` names for the future private adapter; old exports remain as aliases until leaf 3f.
- `lib/todo-move.js` writes both workspaces through one call (`moveTodoDocuments`). Legacy behavior (unchanged from before): target first, then source. A failure writing the source leaves the items in both workspaces (duplicate, no loss) and chats stay linked; a failure writing the target changes nothing.
- `lib/delegation-takeover.js` no longer uses the sync API; it goes through the facade (`listTodos`, `updateTodo`, one atomic update per todo).
  Limitation (changed from the old whole-phase watcher lock around the todo phase): atomicity is per todo only.
  The phase reads one `listTodos` snapshot, then awaits independently locked `updateTodo` calls (each takes the
  watcher lock itself); no lock is held across the snapshot and the patches or between rows. A concurrent writer can
  interleave between the snapshot and a patch or between two rows, and the patches carry no `expectedUpdatedAt`, so
  a concurrent change to `orchestratorChatId` on a row is overwritten by the takeover value computed from the
  snapshot. Why this is acceptable: the patches are absolute (`orchestratorChatId` set to `to` or cleared), not
  read-modify-write deltas; the changelog note is deduplicated by the takeover id against the snapshot; the
  takeover phase is checkpointed only after the loop, so a crash mid-loop replays the whole phase from a fresh
  snapshot and already-applied rows produce no patch; and takeover execution is serialized per parent/chat by the
  caller's locks. Rows are not committed as one transaction: a failure mid-loop leaves earlier rows moved until the
  replay completes.
- `nudgeWorkspaceWatcherAfterTodosMutation` (workspace-watcher-nudge.js) publishes the nudge only after the mutation resolved.


### Leaf 3c status

- `todo-plan-sync.js`, `todo-leaf-material.js`, and `todo-review-sync*.js` use the async todos facade. Plan/summary/material read-modify-write operations send `expectedUpdatedAt` from the read row; conflicts reject instead of overwriting a concurrent edit.
- Review writes use dedicated async `writeTodoReview`, `writeTodoReviewBatch`, and `closeTodoLeafIfEligible` commands. The legacy adapter retains their lock, generation, decision-key, no-op, and nudge-suppression behavior. Review writes also check `expectedUpdatedAt` and `expectedGeneration` under the lock. A stale computation is queued for recomputation rather than installed over a newer plan or review.
- Boot repair awaits reads, snapshot computations, the workspace batch, and optional auto-close. HTTP/MCP plan changes and workflow revision lookups await their async helpers; plan export/run completion and verify tools await mutation before returning success. Review change events follow successful writes only.
- Delegation queue/start/retry/acceptance await review sync. Terminal delegation records still transition synchronously; their background review work is tracked per delegation, and status/history/outbox delivery, final-report acceptance, and shutdown settlement await it. Host verify result recording is async. This preserves the synchronous terminal API used by the remaining leaves.
- The synchronous `computeTodoReviewSnapshotFromRows` helper performs no todo-store reads. Watcher plan gates and backfill pass todo metadata through it; the async runtime wrapper resolves a missing plan boundary through `getTodo`.
- No caller holds a watcher file lock across an async todos operation. The optional auto-close guard is a synchronous callback within the legacy adapter's atomic command; replacing that callback with a worker command belongs to the backend cutover.
- The backend remains legacy JSON and the sync exports remain available to the remaining leaves through 3f. No storage migration or registry change is included.

### Leaf 3d0: atomic versioned watcher/todo command

Contract (ADR `storage-todos-worker-decision.md` §4): a decision that couples a watcher row (rank 40) with a todo (rank 50) is ONE synchronous, versioned command, `commitWatcherTodoCommand` (`lib/persist/todos-persist.js`, async facade `store.commitWatcherTodoCommand`). A sequential batch of facade calls or an async callback under `withWorkspaceWatchersFileLock` is not a substitute.

- **Mechanism**: a single `withWorkspaceWatchersFileLock` section (watcher lock 40, then the todo write on the same shared lock file, rank 50 — registry order preserved). Inside it: CAS on the todo `updatedAt`, the watcher row `updatedAt` and the MANDATORY watcher document `revision` (`expectedWatcherRevision`; missing or non-integer throws `WATCHER_REVISION_REQUIRED`, there is no `updatedAt`-only fallback because `updatedAt` has millisecond resolution and two writes can share it; the revision is bumped by every watcher document write), then an optional synchronous `fence` (claim/lease/cycle identity), then `decide` computes `todoPatch` and `watcherPatch`. Todo is written first (validation happens there), watcher second.
- **Rejection** is a result, never a partial write: `{ ok: false, reason }` with `no_row | watcher_conflict | todo_not_found | todo_conflict | fenced | skipped | watcher_write_failed`.
- **Rollback and crash atomicity**: before the first command byte a write-ahead journal (`watcher-todo-command.journal.json`, next to the watcher document) records the todo pre-image and the watcher document version. In-process failures (rejected watcher write, thrown error) restore the todo file byte-for-byte (temp file + rename) and drop the journal. For a process crash (SIGKILL between the two writes) every OUTERMOST `withWorkspaceWatchersFileLock` acquisition first runs the registered recovery hook, so no writer of either store can run before the interrupted command is resolved. The watcher document is the commit point: version moved means roll forward (todo stays), version unchanged means roll back (todo restored from the pre-image). A command that never returned was never acknowledged, so rollback is safe. A corrupt journal fails closed (`WATCHER_TODO_JOURNAL_CORRUPT`) rather than guessing. CAS and fence checks run after recovery, so their semantics are unchanged. The todo watcher nudge fires only after a fully committed command.
- **Guard**: `withWorkspaceWatchersFileLock` throws `WorkspaceWatchersLockAsyncCallbackError` (`code: WATCHER_LOCK_ASYNC_CALLBACK`) when its callback returns a Promise, so awaiting the async facade inside the callback fails loudly instead of releasing the lock mid-command. Covered by `tests/watcher-todo-command.test.js`.
- Claim/lease/CAS semantics of existing writers are unchanged; backend stays legacy JSON and the sync API stays until 3f. Leaf 3d converts the real coupled decisions to this command.

### Leaf 3d status (done)

Converted: `feedback-triage.js`, `persist/feedback-store.js`, the `cretli_feedback` MCP handler (now async) and the triage decision route.
Mechanism chosen for triage: the todo facade is awaited OUTSIDE `withWorkspaceWatchersFileLock`; the watcher write is a short synchronous `mutateWorkspaceWatcherRow` section committed by compare-and-set on an exact fingerprint of the row's triage fields (claims, proposals, decided keys, last-at; not `updatedAt`, which can collide within a millisecond).
- `claimFeedbackTriage`: reads the todo list, plans claims from a row snapshot, installs them only if the fingerprint is unchanged under the lock, otherwise recomputes (up to 5 attempts). A lost race can never double-claim a report.
- `submitFeedbackTriage`: validates the claim against a pre-lock snapshot (report key, duplicate hash), then consumes the claim and records the proposal under the lock, re-checking that the claim still exists.
- `decideFeedbackTriage`: the accept path uses `commitWatcherTodoCommand` (3d0). Side todos (the extracted idea) are created first through the facade, idempotently via `idempotencyKey`; then the report todo change (close with changelog for duplicate/reject, "extracted as" changelog for extract) and the proposal resolution are ONE versioned command with CAS on the report `updatedAt`, the watcher row `updatedAt` and the document revision. A conflict re-reads and retries (up to 5 attempts); a proposal that is no longer pending resolves to `skipped` without any write. A reject decision touches no todo, so it is a short `mutateWorkspaceWatcherRow` section with a CAS on `status === 'pending'`. Concurrent decisions on one proposal are also single-flighted in-process. Crash window: the extracted todo is created before the command, then its draft plan and changelog note are applied by a follow-up update. A crash in between leaves a bare idea with the proposal still pending; the retry re-reads the todo and applies only the missing plan and/or changelog note (never duplicating the note), then runs the command, so the final todo is complete. The follow-up update is a CAS (`expectedUpdatedAt` from the fresh read) with up to 5 re-read retries on `CONFLICT`: a non-blank plan (e.g. a concurrent user edit) is never overwritten and the note is added only while missing.
- `claimFeedbackTriage` and `submitFeedbackTriage` change only the watcher row (no todo write), so they do not need the coupled command; they use the fingerprint CAS above. No claim/lease/CAS semantics changed.
- `submitFeedback` keeps its pre-existing read-then-write behavior (separate calls, no CAS), now through the facade.
- Guard allowlist shrinks by `feedback-triage.js` and `persist/feedback-store.js`.

Remaining 3d callers: cycle and Scout are converted by leaf 3d4 and integration plus `delegation-*.js` by leaf 3d5 below; leaf 3d is complete. The sync API stays until 3f.

### Leaf 3d2: watcher core, control and review gate on the async facade

- `snapshotWorkspaceWatcher`, `tickWorkspaceWatcher`, `runWorkspaceWatcherHeartbeat`, `markWorkspaceWatcherTodoBlocked`, `claimWorkspaceTodo`, `claimNextWorkspaceTodo`, `releaseStaleWorkspaceTodoClaims(+Throttled)`, `reconcileWorkspaceWatchersOnBoot`, `getWorkspaceWatcherView`, `clearWorkspaceWatcherLoopStop`, `saveWorkspaceWatcherTodoPlanDraft`, `resolveWatcherClaimOwner`, the two `...ForOperator` helpers, `validateWorkspaceWatcherParentDelegation`, `checkReviewGateForTodoWrite` and the history-repair preview/apply are async and read/write todos through `todos-store.js`. Boot reconcile retries `SQLITE_BUSY` through `retryOnSqliteBusyAsync`.
- `claimWorkspaceTodo` no longer wraps its read-and-write in `withWorkspaceWatchersFileLock`. The claim touches only the todo and the `expectedUpdatedAt` CAS inside the todo write stays its arbiter (same `cas_conflict`/`not_ready`/`already_claimed` outcomes, lease TTL and replay rule). Holding the watcher lock across the awaited facade call would invert the lock order (watcher 40 -> todos 50).
- History repair reads todos through the facade before taking the watcher document lock; the locked preview is recomputed from that snapshot and each todo write keeps its own `expectedUpdatedAt` CAS.
- No lock is held across an await of the facade. The suppression flag of the legacy backend is read synchronously, so `withTodosWatcherNudgeSuppressed` wraps only the facade call (not the await).
- Guard allowlist shrinks by `workspace-watcher.js`, `-control`, `-delegation-guard`, `-history-repair`, `-review-gate-guard`; they move to the converted list. The sync API stays until 3f.

### Leaf 3d3: todo-recover and cycle-close on the async facade

- `lib/workspace-watcher-todo-recover.js`: `recoverWorkspaceWatcherTodo`, `releaseDoingWorkspaceWatcherTodo` and `observeWorkspaceTodoUnknownEscalations` are async and read todos through `todos-store.js`. The two former `withWorkspaceWatchersFileLock` sections (recover and manual release) are now ONE `commitWatcherTodoCommand` each (3d0): the pre-lock classification reads the todo list through the facade, then takes a synchronous watcher snapshot (row + document revision) with no await before the commit. The command checks the todo `updatedAt` (the caller's `expectedUpdatedAt`), the watcher row `updatedAt` and the document revision under the watcher lock (40) with the todo write on the same lock hold (50). `decide` re-classifies the todo from the committed row and items and returns the same `superseded` / `already-active` / `now_*` outcomes as before. A `watcher_conflict` re-reads and retries (up to 5 attempts, then `conflict`). A `todo_conflict` first re-reads the todo: a stored idempotency key answers the same replayed success as before, anything else is `conflict`. A workspace without a watcher row gets an empty one first, because the command needs a row to check against. Claim/lease/CAS and idempotency semantics are unchanged; the nudge, previously suppressed around the write, now fires after the committed command (the command's documented behaviour).
- `lib/workspace-watcher-cycle-close.js`: the todo readers (`loadWorkspaceWatcherTodoById`, `loadPrimaryTodoForWorkspaceWatcherCycle`, `readWorkspaceWatcherTodo`, `resolvePlanDraftTodoForCycleClose`, `resolveWorkspaceWatcherCycleTodoOutcomesForClose`) and the todo writers (`releaseWorkspaceWatcherCycleTodoClaim`, `applyReviewGateLabel`, `recordReviewGateWarning`, `applyWorkspaceWatcherBlockedEscalation`, `reconcileWorkspaceWatcherReviewWaits`, `applyParallelLeafMerge`) are async. None of them writes the watcher row, so they are todo-only writes whose `expectedUpdatedAt` CAS stays the arbiter (same reasoning as the claim in 3d2); the coupled close patch is applied by the callers through their own row mutator. `resolveWorkspaceWatcherCycleTodoOutcomes` and `buildWorkspaceWatcherCycleClosePatch` stay synchronous pure builders: the leaf outcomes are prefetched and the plan target todo is passed in as `planDraftTodo`. Cycle-close idempotency (replay by report id / cycle id, close at most once per cycle identity) is unchanged.
- Callers adapted: the boot reconcile slot in `workspace-watcher.js` and both the report and the reconcile slot in `workspace-watcher-cycle.js` no longer hold `withWorkspaceWatchersFileLock` across the close (they could not once the close awaits the facade). The cycle identity re-check inside the short `mutateWorkspaceWatcherRow` section is what makes a slot close at most once, and only the winner runs the after-close effects. The report path prefetches the todos for the cycle it found in a row snapshot and retries (up to 5 attempts, reason `close_prefetch_stale`) if the cycle changed before the mutator ran. The marker-write -> claim-release -> label sequence (review gate contract section 4.2) is therefore no longer one lock hold; it is idempotent and `reconcileWorkspaceWatcherReviewWaits` repairs a crash between the steps. `reconcileWorkspaceWatcherCycle`, the review-gate guard `afterWrite` / `reapplyReviewGateLabel` are async.
- Guard allowlist shrinks by `workspace-watcher-cycle-close.js` and `workspace-watcher-todo-recover.js`. The sync API stays until 3f.


### Leaf 3d4: cycle and Scout on the async facade

- `workspace-watcher-cycle.js` reads and writes todos through `todos-store.js`. Start reservation and the ready-to-doing claim are one `commitWatcherTodoCommand`: document revision, watcher revision and todo `updatedAt` are checked before the synchronous decision rechecks lease, ownership, pool/global parallel caps, daily budget and plan gates. The same claim TTL, execution identity and previous-attempt history are retained. A rejected command writes neither reservation nor claim; there is no separate claim failure rollback window. The prelaunch eligibility recheck also uses the command with a read-only decision. Tree stamping is async and keeps each todo's CAS.
- `workspace-watcher-scout.js` awaits todo reads, automatic idea/group creation and draft updates. Signal collection, preview, prior findings, finding record/resolve/submit and the action entry point are async; their control and HTTP callers await them. The subprocess merge test helper awaits recording too.
- Scout acceptance/rejection is decided in a short synchronous watcher mutation. Accepted findings are then materialized outside the mutex using the existing todo idempotency key; a second short mutation attaches the todo id only to an accepted decision. A competing reject cannot turn an accepted finding into a rejected one during the await. A crash or draft-write failure leaves an accepted decision without a todo link; a repeated accept repairs it idempotently, filling only a blank draft with the todo CAS and preserving an operator's nonblank plan. This is a two-phase side effect, not a cross-store transaction for Scout idea creation.
- No facade await runs under `withWorkspaceWatchersFileLock`; coupled cycle commands keep lock order watcher 40 -> todos 50. Limits `maxParallel` and `maxCyclesPerDay`, claim/lease rules and todo CAS remain unchanged. The sync API remains available until 3f.
- Regression coverage: `workspace-watcher-cycle-async.test.js` delays facade operations, probes the watcher mutex through a second SQLite connection, checks atomic reservation/claim and unchanged state on conflict, races Scout accept/reject and repairs an interrupted draft. Existing cycle, Scout, start-cycle, command-lock and delegation-guard suites remain enabled. The sync API guard moves cycle and Scout from the allowlist to the converted list.

### Leaf 3d5: integration and delegation modules on the async facade

- `workspace-watcher-integration.js` reads and writes todos only through `todos-store.js`. Every function that touches a todo is async: `resolveTreeWorktreeLeaf`, `markTreeWorktreeLeafDone`, `markTodoIntegrationReady`, `markTodoIntegrationPointer`, `readIntegrationTarget`, prepare/apply/merge/confirm/invalidate/no-code/reject, smart-merge report and rollback, `refuseWhenIntegrationLockedForWriter`, `automaticallyIntegrateWorkspaceTodo`. Todo writes keep their `expectedUpdatedAt` CAS, so claim/lease/CAS semantics are unchanged. Callers (routes, in-process MCP client, `integrate-batch.js`, scripts) await them.
- `delegation-retention.js`, `delegation-settings.js` (`readLeafTodoReviewerPair`), `delegation-slot-stop.js` (the cancel_unconfirmed todo block/clear writes go through a per-leaf serial queue; `settleCancelUnconfirmedTodoWrites` drains it) and `delegation-service.js` (`canChatSteerDelegation`, accept-context resolution, verify recording, takeover preparation, start-context reads) use the async facade. `delegation-takeover.js` prepares the takeover asynchronously, then executes it in a short synchronous section.
- Cycle close no longer awaits the facade inside the row mutator. The mutator is synchronous, so a todo write it needs (the integration result of a worktree leaf, the done mark of a tree-worktree leaf) is requested through a pending write: the mutator aborts with the stale marker, `reportWorkspaceWatcherCycle` runs the write outside the watcher lock, records its outcome (or error) and retries the close, which then consumes it. A failed integration write still closes as `integration_result_failed`. The tree-worktree probe is part of the close prefetch. A cycle that is closed by someone else between the write and the retry is reported as replayed/aborted exactly as before; the integration result write is idempotent by cycle id.
- Not converted on purpose: the read-only sync helpers `getTodoById` / `linkTodoChat` in `delegation-service.js` and `delegation-model-gates.js` (pure leaf-size and revision lookups inside synchronous decision functions). They are not part of the guarded sync API and move with the backend flip in 3f. The sync `loadTodosData` / `addTodo` / `updateTodo` / `saveTodosData` are no longer imported by any 3d-scope module; the guard moves `delegation-*.js` and `workspace-watcher-integration.js` to the converted list. `integrate-batch.js` moved to the converted list in leaf 3e.
- Regression coverage: existing `delegation-*`, `workspace-watcher-integration`, `integrate-batch`, `auto-integrator`, `worktree-merge`, tree-worktree close, `delegation-controller-guard` and the watcher mutex tests were updated to await the async functions without weakening any assertion.

### Leaf 3e status (done)

File consumers of the todos document, `integrate-batch.js` and the scripts move to the async facade (`todos-store.js`). The sync API stays until 3f; backend stays legacy JSON.

- Facade additions (optional backend methods, so a worker backend can implement them without a file): `getRevision(dataDir, cwd)` returns an opaque revision token of the committed document (empty string when nothing is committed; compare for equality only) and `exportSnapshot(dataDir, cwd)` returns a detached logical JSON copy of the document. The legacy backend answers them from the file signature and `loadTodosData`.
- `lib/workspace-watcher-control.js`: the view-cache key uses `getRevision` instead of `stat` of the todos file (`'none'` on empty or error, as before). It no longer imports `todosDocumentPath`.
- `lib/todo-review-backfill.js`: `runTodoReviewBackfill` and `backupTodoReviewBackfillDocument` are async. The rollback point is a logical snapshot `{ kind: 'cretli-todos-logical-snapshot', version: 1, workspaceFolder, takenAt, document }` written under `<data-dir>/backups/todo-review-backfill/`, not a copy of the storage file; the result no longer carries `todosDocumentPath`. `todo.review` is derived data, so rollback means reading the pre-run values from `document.items[].review` and restarting the server so the boot repair re-derives the snapshots (CLI text and `scripts/backfill-todo-review.js` updated). Reads and the review write go through `listTodos` / `writeTodoReview`.
- `lib/integrate-batch.js`: the four todo reads and the marker write await the facade. `createIntegrateBatch`, `checkBatchLegacyReport`, `buildEligibilityContext`, `resumeIntegrateBatch`, `cancelIntegrateBatch` and `abandonIntegrateBatch` return Promises (callers in `integrate-batch-routes.js`, `chat-agent-routes.js`, `mcp-inprocess-client.js` await them). Because resume/abandon now await between load and save of the batch store, they share the per-batch serialization queue with `handleBatchNext` and cancel; cancellation cannot be overwritten by an in-flight resume. Legacy report validation reads the batch epoch after the async todo read, so a concurrent abandon or resume revokes the previous capability. `annotateBatchEligibility` stays synchronous: it only receives items already read by its caller.
- Scripts: `measure-todo-save.js` (async API; document size from `exportSnapshot`, fixtures seeded through `updateTodo`), `scout-pass-fixture.mjs`, `audit-automatic-prompts.mjs`, `architecture-http-fixture.mjs`, `architecture-stall-profile.mjs` and `manual-smart-merge-fixture.mjs` use the facade.
- Guard: the allowlist shrinks to `lib/persist/todos-store.js` and `lib/todo-move.js`.
