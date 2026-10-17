# Storage caller inventory (A1)

Maps **mutation entry points** to registry store ids. Read-mostly callers are omitted
unless they perform read-modify-write (RMW). For store metadata see
[storage-registry.json](storage-registry.json).

Legend: **S** = synchronous on the Node event loop; **A** = async/worker/queued.

## HTTP routes (Express)

| Store id | Route module (representative) | Pattern | Sync |
| --- | --- | --- | --- |
| store.config-settings | `lib/routes/settings-routes.js` | RMW `config.json` | S |
| store.chats | `lib/routes/chats-routes.js` | RMW collection | S |
| store.chat-history | history routes / chat APIs | append batch → full rewrite per chat | S |
| store.todos | `lib/routes/todos-routes.js` | CAS + watcher lock | S |
| store.delegations | `lib/routes/delegation-routes.js` | owner lock / sqlite tx | S/A |
| store.delegation-mailbox | delegation inbox routes | RMW JSON | S |
| store.delegation-workflows | workflow routes | RMW JSON | S |
| store.delegation-ratings | rate endpoints | append JSONL | S |
| store.mcp-config | MCP settings routes | queued async journal write | A |
| store.usage-journal | `lib/routes/usage-routes.js` | append + ledger | S |
| store.workspace-watchers | `lib/routes/workspace-watcher-routes.js` | CAS under file lock | S |
| store.worktree-registry | `lib/routes/worktrees-routes.js` | RMW registry | S |
| store.notification-center | notification routes | RMW + prune | S |
| store.push-subscriptions | push subscribe routes | RMW subscriptions | S |
| store.widget-installations | widget routes | RMW | S |
| store.auth-sessions | login/logout (`lib/auth.js`) | sessions map flush | S |
| store.approval-audit | approval routes | append audit | S |
| store.harness-usage-limits | usage limit routes | RMW limits file | S |
| store.sidebar-layout | sidebar layout API | RMW `sidebar-layout.json` | S |
| store.benchmark-snapshots | benchmark routes | RMW `benchmark-snapshots.json` | S |
| store.model-pick-overrides | model pick settings | RMW `model-pick-overrides.json` | S |
| store.model-role-profiles | harness/model settings routes | RMW `model-role-profiles.json`, `model-score-heuristics.json` | S |

## WebSocket / harness runtime

| Store id | Module | Trigger | Sync |
| --- | --- | --- | --- |
| store.chat-history | `lib/agent-harness/*`, harness WS | stream append / coalesce flush | S |
| store.chats | harness lifecycle, fork/resume | metadata updates | S |
| store.recovery | `lib/recovery/recovery-lifecycle.js` | intent CAS, queue | S (SQLite) |
| store.delegations | `lib/delegation-service.js` | status/slot updates | S |
| store.usage-journal | harness usage hooks | append usage envelope | S |
| store.mcp-config | `lib/mcp/mcp-deepseek-patch.js`, `lib/deepseek/dsh-runtime-patch.js` | harness spawn: **non-atomic** `writeFileSync` of generated `mcp/*.yml` overlays (retained class, not the `mcp.json` journal path) | S |

## Background timers / schedulers

| Store id | Module | Notes |
| --- | --- | --- |
| store.workspace-watchers | `lib/workspace-watcher.js` | tick, lease, cycles |
| store.todos | watcher claim/release | `withTodosWatcherNudgeSuppressed` |
| store.workspace-memory | `lib/workspace-watcher-scout.js` | fact upserts |
| store.workspace-watcher-cycles | `lib/workspace-watcher-cycle-metrics.js` | cycle metrics |
| store.usage-journal | `lib/usage/usage-retention.js` | prune old journal days |
| store.notification-center | notification producers | fingerprint publish |
| store.auth-sessions | `lib/auth.js` | session sweep |
| store.model-pick-decisions | `lib/model-pick-decisions.js` | open decision rows |
| store.delegation-mailbox | ack/delivery loops | mailbox RMW |
| store.chat-title-history | `lib/persist/chat-title-history-persist.js` | title generation / chat rename hooks |
| store.model-pick-explore | `lib/model-pick-explore.js` → `lib/persist/model-pick-explore-persist.js` | background explore-state persist |
| store.model-pick-overrides | `lib/workspace-watcher-orchestrator.js` | background override writes (also HTTP — see above) |
| store.model-role-profiles | `lib/harness-models-snapshot.js` | models snapshot refresh; registry flags a temp write to verify under quiesce |

## MCP tools (server-side writers)

| Store id | Tools |
| --- | --- |
| store.todos | `todo_create`, `todo_update`, `todo_start`, … |
| store.workspace-memory | `wmem_add`, `wmem_delete` |
| store.delegations | delegation lifecycle via HTTP backing |
| store.workspace-watchers | `watcher_update`, `watcher_report`, … |

## Subprocess / CLI (when server running)

| Store id | Source | Notes |
| --- | --- | --- |
| store.delegations | child harness via server APIs only | no direct file write from child |
| store.worktree-registry | `lib/worktree-manager.js` git worktree | registry mutate |
| — | harness homes (`claude-home`, …) | **retained**, not app-state stores |

## Read-modify-write critical sections (DATA-02)

| Section | Stores touched | Risk |
| --- | --- | --- |
| Watcher todo claim | `store.todos`, `store.workspace-watchers` | nested lock reentrancy OK |
| Chat append batch | `store.chat-history` | whole-document rewrite; high write amplification |
| Chats list update | `store.chats` | lost update if concurrent HTTP without lock |
| MCP config save | `store.mcp-config` | two-file journal; must roll forward |
| Usage append | `store.usage-journal` | journal + index; lock dir serializes processes |
| Delegation slot | `store.delegations`, `store.recovery` | separate backends; no single TX today |
| Settings workspace registry | `store.config-settings` | RMW embedded sections in one file |

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
| `gap.plan-limit-history-direct` | `usage/plan-limits.jsonl`, `usage/limits.jsonl`, `usage/unclassified-errors.jsonl` | `lib/usage/plan-limit-history.js`, `lib/harness-usage-limits.js` | **yes** |
| `gap.delegation-json-shadow` | `delegations.json` | `lib/persist/delegation-migrate.js` (`lib/model-pick-history.js` read-only stat) | **yes** |

Any gap with `blocksConsistentSnapshot: true` **fails** a "complete data directory"
snapshot until quiesced or registered (DATA-08 / BACKUP-02). Three of five currently block.

Resolved since the first inventory draft: the generated DeepSeek overlays under
`data/mcp/` (`lib/mcp/mcp-deepseek-patch.js`, `lib/deepseek/dsh-runtime-patch.js`) are
no longer an unknown writer — they are registered on `store.mcp-config`
(`writers.known`, retained paths `mcp/dsh-mcp-bridge.yml`,
`mcp/dsh-mcp-bridge.yml.meta.json`, `mcp/dsh-runtime.cordis.patch.yml`). They still
write **non-atomically** (plain `writeFileSync`, no temp+rename), so B6 must gate or
tolerate a torn overlay; the files are regenerated at harness spawn.
