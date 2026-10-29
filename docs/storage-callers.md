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
| `lib/todo-review-sync.js`, `lib/todo-review-sync-hooks.js` | Async plan-boundary reads and review commands; boot/retry/auto-close wait for writes before emitting changes. |

Async facade imports may retain local aliases such as `listTodos as loadTodosData`; these do not import the synchronous persist API. Indirect
paths: MCP tools -> `client.updateTodo` -> in-process client or HTTP -> facade.

### Remaining synchronous callers (allowlist in the guard test)

Each still imports at least one sync function and is converted by a later leaf:
`lib/delegation-retention.js`, `delegation-service.js`, `delegation-settings.js`,
`delegation-slot-stop.js`, `feedback-triage.js`, `integrate-batch.js`,
`todo-move.js`, `todo-review-backfill.js`,
`persist/feedback-store.js`, every `workspace-watcher-*.js`
module listed in the guard (`control`, `cycle`, `cycle-close`, `delegation-guard`,
`history-repair`, `integration`, `review-gate-guard`, `scout`, `todo-recover`, and
`workspace-watcher.js`), and the scripts `architecture-http-fixture.mjs`,
`architecture-stall-profile.mjs`, `audit-automatic-prompts.mjs`,
`manual-smart-merge-fixture.mjs`, `measure-todo-save.js`, `scout-pass-fixture.mjs`.
Other files only use non-guarded helpers (`getTodoById`, `linkTodoChat`, `deleteTodo`, review
writers, constants) and are not sync-API callers for the guard.

L3b remains partial for `feedback-triage.js`: claim, proposal, and decision callbacks
run under the synchronous watcher document lock, which is also used by todo
mutations. The lock is released when the callback returns. Moving the todo read or
write to an awaited facade call outside that callback would split the atomic
decision. Converting this path needs a store command that holds the shared lock
through the complete watcher and todo operation. `persist/feedback-store.js` and
`integrate-batch.js` also remain on the synchronous API pending their command
boundary conversion.

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
