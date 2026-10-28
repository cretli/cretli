# Architecture program — system map (stage 1)

Status: **audit artifact** for TODO `103827ff-c99a-4752-9fc1-ed3ebd382f40`
(program root `7ec86917-118f-4272-a7d6-d6cb2da3d7d8`). It describes the **current**
code at the pinned material in [architecture-baseline.md](architecture-baseline.md); it
changes no runtime behavior. Canonical architecture prose stays in
[ARCHITECTURE.md](ARCHITECTURE.md); the machine-readable store inventory stays in
[storage-registry.json](storage-registry.json) (owner: storage project `cf4fed89`).
This map adds what those documents do not: the cross-domain view, queues, timers,
blocking primitives and the cost drivers that stages 2–8 depend on.

Reproduce the numbers below with:

```bash
node scripts/architecture-sync-io-inventory.mjs --out docs/architecture-sync-io-inventory.json
```

## 1. Domains and owning modules

| Domain | Primary modules | Source of truth (see §3) | Notes |
| --- | --- | --- | --- |
| chats / history | `lib/persist/chats-persist.js`, `chat-history-persist.js`, `chat-history-revisions.js`, `lib/routes/chats-routes.js` | `chats.json`, per-chat history JSON | History protocol, receipts and epochs belong to storage A3a `aadeac30`. |
| runs / delegations / recovery | `lib/delegation-service.js` (5.7k lines), `lib/persist/delegations-persist.js`, `delegation-sqlite.js`, `lib/recovery/*`, `lib/chat-run-service.js` | `delegations.sqlite` (schema 4), `recovery.sqlite` (schema 3) | Recovery contract owner: `53efd61e` (R1–R20). |
| todos / workspaces / Watcher | `lib/persist/todos-persist.js`, `workspace-watchers-persist.js` (3.5k), `lib/workspace-watcher*.js`, `lib/routes/todos-routes.js` | JSON per key + `workspace-watchers.lock.sqlite` | Watcher runtime tick polls records; no LLM. |
| settings / auth / widgets | `lib/persist/settings.js`, `lib/auth.js`, `lib/widget/*`, `lib/routes/settings-routes.js` (1.5k) | JSON documents | Credentials follow their own boundary (`secrets.classification`). |
| usage / notifications | `lib/persist/usage-persist.js` (2.2k), `lib/notifications/*`, `lib/push.js` | usage JSONL journal (authoritative), notification JSON | Usage journal stays authoritative (storage-gates). |
| harness integrations | `lib/{sdk,claude,codex,opencode,qwen,deepseek,codebuddy,mistral,openrouter,zai,mimo}/*`, `lib/agent-harness/*` | provider homes (gap `gap.harness-provider-homes`) | One WS handler per harness; shared room kernel. |
| tools | Files `lib/routes/files-routes.js`, `fs-browse-routes.js`; Terminal `lib/ws/pty-ws-handler.ts`; Browser `lib/browser/*` (session manager 4.4k) | none (ephemeral) / screenshots as files | Browser has egress proxy and policy. |
| frontend | `app_front/chat.js` (11k), `App.js`, `api.js`, `features/*`, `components/ui/*` | server APIs + localStorage/IndexedDB caches | Sidebar already Lit with virtualized archive. |

Largest modules by lines (candidates for boundary work, not rewrites):
`app_front/chat.js` 11003, `app_front/lib/sdk-rich-view.js` 6740,
`lib/delegation-service.js` 5664, `lib/browser/session-manager.js` 4363,
`lib/workspace-watcher-scout.js` 4307, `app_front/todoPanel.js` 3982,
`lib/persist/workspace-watchers-persist.js` 3544, `lib/sdk/cursor-agent-sdk-ws.js` 3222.

## 2. Transports

| Transport | Entry | Count / shape | Auth and scope boundary |
| --- | --- | --- | --- |
| HTTP | `server.js` (793 lines) + `lib/routes/*.js` (52 files) | 145 GET, 137 POST, 13 PATCH, 12 DELETE, 10 PUT, 9 `use` registrations | `lib/auth.js` `requireAuth`; widget access (`req.widgetAccess`) filtered by `widgetInstallationId`; scope checks per chat (`findParent`) |
| WebSocket | `server.js:510` `new WebSocketServer({ server })` routed by `lib/ws/ws-router.ts` | PTY, task, server-log, front-build, browser, page bridge, Gemini Live relay, one handler per agent harness | `ws-auth-boundary.js`, `ws-origin.js`, `ws-keepalive.js`, widget handshake |
| MCP | `lib/mcp/*` (bridge `cretli_bridge`, builtin tools in `lib/mcp/builtin/*`: chats, todos, delegations, watcher, memory, lessons, browser, cache, keep-alive), in-process client `mcp-inprocess-client.js` | tool catalog + policy per harness and mode (`mcp-policy.js`, `mcp-capability-codes.js`) | integration token, read-only mode, orchestrator gate (`watcher-orchestrator-mcp-gate.js`), `chat-scope.js` |
| SDK multi-instance (optional) | Redis + sticky cookie, [MULTI-INSTANCE.md](MULTI-INSTANCE.md) | owner instance runs `@cursor/sdk` Agent and writes history; non-owner has a read-only stub room | Only SDK chat rooms; PTY/agent PTY sessions are not multi-instance |

Policy differences between transports (read-only tool modes, widget scope, MCP
capability codes) are **intentional**; shared domain commands in later stages must keep
them (program plan, architecture point 2).

## 3. Stores, writers and owners

The authoritative inventory is [storage-registry.json](storage-registry.json)
(`registryVersion 1`, 28 stores, 5 `inventoryGaps`). Summary by backend and lock rank
(ascending = lock acquisition order; the validator enforces it):

| Rank | Store id | Owner module | Backend | Durability | Mem cache |
| ---: | --- | --- | --- | --- | :-: |
| 10 | store.recovery | `lib/recovery/recovery-store.ts` | SQLite WAL schema 3 | `synchronous=FULL` | no |
| 20 | store.usage-journal | `lib/persist/usage-persist.js` | JSONL append | per-record fsync | yes |
| 30 | store.delegations | `lib/persist/delegations-persist.js` | JSON + SQLite lock (schema 2 registry row; SQLite schema 4 on disk) | atomic rename or WAL FULL | yes |
| 40 | store.workspace-watchers | `lib/persist/workspace-watchers-persist.js` | JSON + SQLite lock | atomic rename | yes |
| 50 | store.todos | `lib/persist/todos-persist.js` | JSON document per key | atomic rename | yes |
| 55 | store.workspace-memory | `workspace-memory-persist.js` | JSON per key | atomic rename | no |
| 60 | store.chats | `lib/persist/chats-persist.js` | one `chats.json` | atomic rename, no fsync protocol | yes |
| 65 | store.chat-history | `lib/persist/chat-history-persist.js` | JSON per chat | atomic rename, no fsync protocol | yes |
| 70–260 | 18 auxiliary stores (title history, mailbox, workflows, ratings, mcp-config, settings, auth-sessions, worktree registry, sidebar layout, watcher cycles, model-pick *, benchmark, notifications, push, widgets, approval audit, usage limits) | one `lib/persist/*` or feature module each | JSON documents / JSONL | atomic rename / append | settings and auth-sessions only |

`inventoryGaps` (blocking a consistent snapshot until closed): workspace-folders direct
write, webpack-cli watch lock, harness provider homes, plan-limit history direct write,
delegation JSON shadow. Their owner is storage B1/B7; this program does not add
writers (ADR rule R1).

**Single-writer fact.** Every domain row above has exactly one owner module, but the
registry also lists 3–4 known writers per major store across HTTP/WS/background/
subprocess/MCP channels (32 `background` entries in total). Stage 2 turns this into
"one command surface per domain"; it does not change the storage owner.

## 4. Read-modify-write and locks

| Mechanism | Where | Property |
| --- | --- | --- |
| In-process lock files | `lib/delegation-owner-lock.js` (`delegation-owner.lock`), `lib/child-process-registry.js`, `lib/opencode/opencode-port-registry.js`, `lib/webpack-cli-watch-lock.js` | cross-process exclusion by file; two of them poll with `Atomics.wait` |
| SQLite lock databases | `workspace-watchers.lock.sqlite`, `model-pick-decisions.lock.sqlite` | `DatabaseSync` transactions as mutex around JSON RMW |
| `.ledger.lock` | `lib/persist/usage-persist.js` | journal append coordination, polls with `Atomics.wait` |
| Critical sections table | [storage-callers.md](storage-callers.md) | per-store RMW sections; the migration owner of each is the storage project |

## 5. Sync I/O and blocking primitives (reproducible)

Output of `scripts/architecture-sync-io-inventory.mjs` over `lib/` + `server.js`
(794 files scanned; deterministic JSON in
[architecture-sync-io-inventory.json](architecture-sync-io-inventory.json)):

| Primitive | Count | Notes |
| --- | ---: | --- |
| synchronous fs calls | 807 in 189 files | top: `usage-persist.js` 37, `sdk/cursor-share.js` 17, `client-instance-logs.js` 16, `delegation-owner-lock.js` 15, `memory-monitor.js` 15, `sdk/cursor-context.js` 15 |
| synchronous child processes | 27 in 17 files | git-heavy: `worktree/git-worktree.js` 5, `delegation-metrics-git.js` 3, plus `execSync` in routes (`chats-routes.js` `spawnSync` of the agent CLI) |
| `Atomics.wait` | **7 call sites** in lib/ (+1 test script) | see below |
| `DatabaseSync` references | 73 in 7 files | delegation SQLite 25, recovery store 16, recovery queue 16, owner lease 6, watchers 5, model-pick 3, migrate 2 |
| `loadChats(` textual occurrences (static scan, includes the definition) | **135** | `chats-routes.js` 36, `chats-persist.js` 17, `delegation-service.js` 16, `todos-routes.js` 7 |

`Atomics.wait` sites (all block the calling thread — the main event loop — for the
given timeout; none is removed by stage 1):

| File | Purpose | Timeout | Owner for removal |
| --- | --- | --- | --- |
| `lib/persist/delegation-sqlite.js:118` | busy retry around SQLite open/migrate | 50 ms | delegation SQLite store; storage A2 `4fb174ca` (worker/transaction contracts) |
| `lib/persist/usage-persist.js:1389` | journal lock backoff | caller `ms` | usage journal (authoritative, unchanged by storage) → stage 6 gap |
| `lib/persist/workspace-watchers-persist.js:2916` | lock backoff | caller `ms` | storage A4 `6e483edd` (watcher transactions) |
| `lib/persist/model-pick-decisions-persist.js:51` | lock backoff | caller `ms` | storage A4/A5 |
| `lib/child-process-registry.js:130` | registry file lock | caller `ms` | stage 6 (existing registry is reused, not replaced) |
| `lib/delegation-owner-lock.js:159` | socket probe | `SOCKET_PROBE_MS` | recovery R3 (owner fencing, done) — read-only for this program |
| `lib/opencode/opencode-port-registry.js:83` | port registry lock | caller `ms` | stage 6 |

The storage contract forbids a synchronous facade that waits on a worker
(`Atomics.wait`); this inventory is the baseline against which that rule is audited.

## 6. Caches, queues, timers and lifecycles

| Item | Location | Bound / lifecycle | Gap |
| --- | --- | --- | --- |
| `chatsCache` (signature `ino:size:mtimeMs`) | `chats-persist.js` | one parsed array; every `loadChats()` returns a **full copy** (`copyChats`, O(N) per call) | primary cost driver C1 (see baseline) |
| History revisions index | `chat-history-persist.js` + `chat-history-revisions.js` | in-memory `Map` per chat, no size bound documented | unbounded growth with chat count |
| Registry-listed caches | 8 of 28 stores cache in memory and invalidate on flush | per store | bounds (count/bytes/age) not documented — stage 6 |
| Room kernel queue | `lib/agent-harness/room-kernel.js` | busy/currentRun/queue in memory; history 2 s buffer | durable intents/Stop owned by recovery R4/R5 |
| Persist queue (SQLite worker) | storage A2/A3a (not yet integrated) | gates: queue age p95 200 ms, burst max 2000 ms | n/a until A2 lands |
| Delegation mailbox / claims | `delegation-mailbox-persist.js`, `delegation-service.js` | SQLite-backed; slot counters | R10 done |
| Timers | 22 `setInterval` sites (server 2, ws keepalive, cursor SDK WS 2, watcher cycle, usage maintenance, keep-alive, diagnostics, health, auth, qwen/opencode WS, recovery producer…) | each owns its handle; shutdown cleanup per module | no central timer registry — stage 6 audit |
| `new Map()/Set()` module singletons | 609 occurrences, 103 top-level `const … = new Map()` in lib/ | per module | inventory needed for count/bytes/age limits |
| TTL constants | 46 `*_TTL*` constants | per feature | consistency review in stage 3 |
| Subprocesses | `lib/child-process-registry.js` + "Child process lifecycle" in [ARCHITECTURE.md](ARCHITECTURE.md) | existing registry/sweeper — reused, no second one | spawn inventory exists in ARCHITECTURE.md |
| WebSockets | `ws-session-registry.js`, `client-instance-registry.js`, `ws-keepalive.js` | registered/unregistered per connection | OK per module; listener leak check is a stage 6/8 test |
| Event-loop probe | `lib/routes/health-routes.js:19` `monitorEventLoopDelay({ resolution: 20 })` | 20 ms resolution | cannot prove budgets below ~20 ms; baseline uses 1 ms |

## 7. Cycles and coupling

`lib/delegation-service.js` (5.7k lines) imports persistence, workspace-watcher,
recovery, MCP and chat modules; `chats-persist.js` imports history, title history,
browser screenshots, push and chat-list broadcast modules. These couplings are why the
program starts with boundary contracts (stage 2) instead of data-layer swaps. A
dependency-cycle report (e.g. `madge`) is **not** part of the repository tooling and was
not run; adding it is a stage 2 deliverable, not a stage 1 claim.

## 8. Frontend state and rendering (current)

- Sidebar: Lit components in `app_front/features/sidebar/` (`cr-sidebar-*`), status
  patches, live-row limit, virtualized archive (`sidebarArchiveVirtualizer.js`),
  render metrics in `sidebarRenderMetrics.js` (opt-in through `uiFreezeTrace`).
- Chat: `app_front/chat.js` (11k lines) owns transport (`features/chat/chatTransport.js`),
  history replay lifecycle and local boot cache (`chatLocalBootCache.js`).
- Instrumentation: `uiFreezeCounters.js`, `uiFreezeTrace`, `freezeLogPersist.js`;
  synthetic baseline script `scripts/measure-ui-freeze-baseline.mjs`.
- Offline shell and boot guard: `app_front/features/pwa`, `public/sw.js`
  (see [offline-boot-hydration-2026-10-07.md](offline-boot-hydration-2026-10-07.md)).
