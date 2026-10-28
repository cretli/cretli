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

### Converted to the async facade (leaf L2)

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

Import aliases: none of the callers rename the sync functions (`as` imports). Indirect
paths: MCP tools -> `client.updateTodo` -> in-process client or HTTP -> facade.

### Remaining synchronous callers (allowlist in the guard test)

Each still imports at least one sync function and is converted by a later leaf:
`server.js`; `lib/delegation-retention.js`, `delegation-service.js`, `delegation-settings.js`,
`delegation-slot-stop.js`, `delegation-takeover.js`, `feedback-triage.js`, `integrate-batch.js`,
`model-pick-leaf-implement.js`, `orchestrator-leaf-resolution.js`, `review-lessons-checks.js`,
`todo-leaf-material.js`, `todo-move.js`, `todo-plan-sync.js`, `todo-review-backfill.js`,
`todo-review-sync-hooks.js`, `todo-review-sync.js`, `worktree-deps.js`, `worktree-list.js`,
`persist/feedback-store.js`, `usage/todo-usage-read.ts`, every `workspace-watcher-*.js`
module listed in the guard (`control`, `cycle`, `cycle-close`, `delegation-guard`,
`history-repair`, `integration`, `review-gate-guard`, `scout`, `todo-recover`, and
`workspace-watcher.js`), and the scripts `architecture-http-fixture.mjs`,
`architecture-stall-profile.mjs`, `audit-automatic-prompts.mjs`,
`manual-smart-merge-fixture.mjs`, `measure-todo-save.js`, `scout-pass-fixture.mjs`.
Other files only use non-guarded helpers (`getTodoById`, `linkTodoChat`, `deleteTodo`, review
writers, constants) and are not sync-API callers for the guard.

### Read-modify-write critical sections

All run under `withWorkspaceWatchersFileLock` inside `todos-persist.js` (`addTodo`,
`updateTodo`, `deleteTodo`, `writeTodoReview*`, `closeTodoLeafIfEligible`, `linkTodoChat`)
and in `lib/todo-move.js` (`moveTodoTree`, cross-workspace). Callers that read then
write in separate calls (`todos-routes.js` patch: read for the worktree check, then
`updateTodo` with `expectedUpdatedAt`) rely on the CAS field, not on a held lock; no lock
is held across an `await` outside the persist layer.
