# Architecture program — vertical DAG and ownership matrix (stage 1)

Status: **proposed** together with [architecture-target-adr.md](architecture-target-adr.md).
Nothing here starts work: stages 2–8 of the program stay blocked until a human
approves the root plan version that pins this file's SHA-256 (see the plan manifest).
"Go" below means the precondition for starting a vertical, not a decision to start it.
Budget numbers are the frozen targets in [architecture-baseline.md](architecture-baseline.md) §5.

Program stage TODOs (sequential order): S2 `b8853c2a`, S3 `c4f2c95b`, S4 `4ea7415a`,
S5 `15ab11b3`, S6 `ef0304e6`, S7 `b162ea36`, S8 `602a6a25`.

## 1. DAG table

Columns: vertical → owner TODO → contract → concrete files → storage/recovery
dependency → measurable budget → rollback → go / no-go and evidence.

| Vertical | Owner | Contract | Files | Storage / recovery dependency | Budget | Rollback | Go / no-go and evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **V0** Request-local chat index (baseline dependency) | user commit decision; coverage verification S2 (V0 is S2's "V0 coverage" in §3) | `findParent` resolves from one per-request snapshot; fresh snapshot per request | `lib/routes/delegations-routes.js`, `tests/delegation-route-chat-index.test.js` (+ unrelated `lib/mcp/mcp-vendor-map.js` to be split) | none (read side only) | `scopeIndexed` 20k chats, 50 lookups: P95 3.508 ms vs `scopeLegacy` P95 30.855 ms (n=30, exploratory); both from `architecture-chat-list-bench.json` | revert the `WeakMap` block | **Go for review**: 2/2 tests pass; **no-go to commit** without an explicit user order; evidence: baseline §2 |
| **V1** Chat catalog read model (kills `loadChats()` copy; 135 textual occurrences) | S2 contract → S3 implementation | `ChatCatalog` queries: get by id, list by scope/workspace, children, counts; read-only snapshot with revision; writes still only via `chats-persist.js` | `lib/persist/chats-persist.js` (read side), `lib/routes/chats-routes.js` (36), `lib/delegation-service.js` (16), `lib/routes/todos-routes.js` (7), `lib/browser/chat-browser-scope.js`, `lib/mcp/builtin/chat-scope.js` | **none on A3b**: `chats.json` writer/format unchanged; must not pre-empt metadata migration `c688a6a1` | get-by-id P99 ≤ 1 ms and zero-copy list at 20k; `scopeLegacy`-class request ≤ V0 figure; local read API P95 ≤ 100 ms | keep `loadChats()` as a facade returning the same shape; flip callers back per file | **No-go until** S2 freezes the contract and the root plan is re-approved; evidence: baseline §4.1 + new HTTP fixture (V9) |
| **V2** Sidebar / list DTO and sync | S4 (API/WS) then S5 (client) | lightweight list DTO (no history), revision + delta + gap resync | `lib/routes/chats-routes.js`, `lib/chat-list-updates.js`, `app_front/features/sidebar/*`, `app_front/features/chat/chatListLiveSync.js` | consumes A3a protocol after its gate; **R13** (`e304b86d`) owns recovery statuses in sidebar/history → collision | sidebar open ≤ 150/300 ms, search ≤ 100/200 ms, ≥ 95 % scroll frames | DTO version flag; old list endpoint kept during compatibility window (reads only) | **No-go** while R13 is unplanned/uncommitted for the sidebar; mark collision, assign to R13, split an independent gap |
| **V3** History page / search / replay | A3a `aadeac30` (producer); S3 read-side adapters; S4 consumer (API/WS), S5 client | A3a receipts/epochs/generation; consumer reads bounded pages by `seq` | `lib/persist/chat-history-persist.js`, `chat-history-revisions.js` (proposed owner A3a), `app_front/features/chat/chatServerRecovery.js` | **blocked by A2 `4fb174ca` → A3a**; no second protocol | switch to first content ≤ 200/400 ms; history page P95 ≤ 40 ms / P99 ≤ 90 ms (storage-gates) | A3a rollback + reverse export | **No-go** until A3a integrated and verified |
| **V4** Frontend shared entity model | S5 | existing signal/state model; any replacement needs a new contract | `app_front/state/`, `app_front/features/*` | consumes V2 DTO | no UI task > 100 ms; DOM cap documented; interaction P95 ≤ 100/200 ms | retain the established renderer/state path | **No-go** until a replacement contract and real desktop/mobile evidence exist |
| **V5** TODO / Watcher / delegation aggregates and runtime tick | S3 (aggregates) then S6 (tick) | tick polls active/queued records; counters via SQL aggregates | `lib/persist/todos-persist.js`, `workspace-watchers-persist.js`, `lib/workspace-watcher*.js`, `lib/delegation-service.js` | A4 `6e483edd` owns TODO/watcher/delegation **transactions**; R13/R14/R15/R16/R17/R18/R19/R20 own recovery UI, policy, scheduler, supervisor, OOM, corrections, crash tests, automatic opt-in | todo list P95 ≤ 100 ms at growth fixtures; event-loop P99 < 100 ms mixed | revert aggregate to full scan behind same function | **Split**: only gaps outside A4/R-scope go; conflicts are labelled and the vertical waits |
| **V6** Blocking primitives (7 `Atomics.wait`, 27 sync child, hot sync fs) | S6, only after profiling; storage-owned sites via A2/A4 | no new `Atomics.wait`; async/worker only where profile shows > 5 ms p99 gain | `lib/persist/usage-persist.js`, `child-process-registry.js` (reuse), `opencode-port-registry.js`, `lib/worktree/git-worktree.ts`, `delegation-metrics-git.js` | `delegation-sqlite.js`, `workspace-watchers-persist.js`, `model-pick-decisions-persist.js` belong to A2/A4; `delegation-owner-lock.js` belongs to R3 (done, read-only) | per-site stall attribution; event-loop max < 500 ms mixed | per-site revert | **No-go** until per-site profile exists (baseline §4.3) |
| **V7** Boot / navigation / Settings | S4 (settings API) and S5 (shell) | cached shell + bounded boot requests | `lib/routes/settings-routes.js`, `app_front/features/pwa`, `public/sw.js`, `app_front/api.js` | none | shell ≤ 500/1000 ms, settings API P95 ≤ 100 ms | revert endpoint/cache change | **No-go** until cold/warm/offline baseline exists |
| **V8** Files / Terminal / Browser overhead | S6 measure, S8 acceptance | measure Cretli overhead separately from the external operation | `lib/routes/files-routes.js`, `lib/ws/pty-ws-handler.ts`, `lib/browser/session-manager.js` | none | report only until measured | n/a | **Measure-first** |
| **V9** Observability and fixtures | S1 (this) → S3 builds fixtures → S8 extends | 1 ms event-loop sampling, correlation ids, n/P50/P95/P99/max report, 500/5000/20000 fixtures + growth fixtures | `scripts/architecture-chat-list-bench.mjs`, `scripts/storage-baseline-harness.mjs`, `lib/routes/health-routes.js` (20 ms histogram today) | storage-gates event-loop rules | every vertical reports before/after on identical data | n/a | **Go** (artifacts exist); HTTP/browser fixtures still missing |
| **V10** Migration integration and multi-instance compatibility | S7 (also carries V0 integration coordination, §3) | readiness matrix for A2–A6/B4; MULTI-INSTANCE.md regressions (owner writes history, stub is read-only, failover by lease) | `docs/MULTI-INSTANCE.md`, `lib/storage/*`, `lib/persist/delegation-migrate.js` (read-only here) | owned by storage; **not** a re-implementation of A4/A6 or R19/R20 | no regression of MULTI-INSTANCE limits | per-store reverse export per storage contract | **No-go** per vertical until its dependency is integrated |

DAG edges (must precede): V9 → V1 → V2 → V4; V0 → V1; A2 → A3a → V3 → V2 (history parts);
V1 → V5(aggregates) → V6; R13 → V2 (recovery statuses in sidebar); A4 → V5(transactions);
all → V10 → S8 acceptance.

## 2. Ownership and collision matrix

States checked at audit time through `todo_show`/`todo_list` (statuses are TODO
statuses; **integration is `unconfirmed` for every row except A1**, so "done" does not
prove the code is on the target branch — re-check before relying on it). Code
presence is a repository check at the snapshot `065f3d5`.

### 2.1 Storage project `cf4fed89` (status `doing`, integration `partial`)

| Item | TODO | Status / integration | Code at `065f3d5` | Owns | This program |
| --- | --- | --- | --- | --- | --- |
| A1 registry, baseline, decision | `7a287da9` | done / integrated | `lib/storage/store-registry.js`, `docs/storage-*.md`, harness | registry, gates, backend decision | read-only input |
| A2 backend and transaction contracts | `4fb174ca` | ready / unconfirmed | no history worker in `lib/storage/` | sqlite-worker, `Atomics.wait` removal for storage sites | consume, do not implement |
| A3a history pilot, idempotency | `aadeac30` | ready / unconfirmed | `lib/persist/chat-history-revisions.js` exists only as in-memory pull-sync index (not A3a) | history protocol, receipts, epochs, generation | V3 consumes after gate; **proposed owner of `chat-history-revisions.js`** |
| A3b chat metadata migration | `c688a6a1` | ready / unconfirmed | `chats.json` unchanged | metadata store; requires A3a + B4 | V1 must not change the writer |
| A4 transactions TODO/watcher/delegation/recovery | `6e483edd` | ready / unconfirmed | — | transactional contracts for those domains | V5 only reads aggregates |
| A5 remaining data, export and backup integration | `88131b70` | ready / unconfirmed | — | other stores | not touched |
| A6 cutover, regressions, restore drill | `9ef8ceca` | ready / unconfirmed | — | cutover | not touched |
| B4 offline backup/restore (**parent is backup project `68f1c312`, not `cf4fed89`**; ownership by that project, listed here only because A3b depends on it) | `09f85444` | ready / unconfirmed | — | restore for JSON/SQLite | prerequisite of A3b |

### 2.2 Recovery program `53efd61e` (status `doing`; aggregate integration 0/20 confirmed)

| Items | Status | Code at `065f3d5` | Owns | This program |
| --- | --- | --- | --- | --- |
| R1–R12 (contract, store, fencing, queue/Stop, lifecycle, adapters, boot reconciliation, shutdown, delegations/mailbox, watcher A–C, manual resume) | done (R8–R12 review passed; R1–R7 review state none) | `lib/recovery/*` present (contract, lifecycle, queue, store, owner lease, ids, adapter validation) | frozen contract: `docs/recovery-contract.md`, `recovery-lifecycle.md`, `recovery-store.md`, `recovery-queue.md`, `lib/recovery/recovery-contract.ts` | integrate API/state only; **do not change the contract** |
| Open R11/R12 follow-ups `0fa2cf8e`, `8238df90`, `936a7479` (production chat runs never create recovery records), `e43108ed` | ready | — | recovery | gap noted in V5/S6; assigned to recovery |
| R13 UI + watcher D `e304b86d` | ready (review state unknown) | — | sidebar/history recovery statuses | **collision with V2/V4** → V2 waits |
| R14 policy `deceb4da`, R15 scheduler `c3665531`, R16 supervisor `92ddf55f`, R17 OOM `bfddf491`, R18 corrections `ad5baa10`, R19 crash tests `b0e4df18`, R20 automatic opt-in `169307f8` | ready | — | recovery | no overlap allowed; S6/S7 coordinate only |

### 2.3 Other fixed ownerships

| Area | Owner | Rule |
| --- | --- | --- |
| UI design system (Lit, tokens, i18n, `cr-dialog`) | existing UI rules and active UI changes | extend, no competing rewrite |
| Child processes | `lib/child-process-registry.js` + ARCHITECTURE.md "Child process lifecycle" | reuse; no second registry/sweeper |
| `chat-history-revisions.js` | proposed A3a | one implementation only |
| Request-local chat index | V0 (user commit decision) | not committed by this leaf |

## 3. Child TODO drafts per vertical

| Stage TODO | Verticals it carries | First task |
| --- | --- | --- |
| S2 `b8853c2a` | V1 contract (ChatCatalog), V2/V5 command-query boundaries, V0 coverage | freeze `ChatCatalog` contract + contract tests; dependency-cycle report (`scripts/` tool) |
| S3 `c4f2c95b` | V1 implementation, V5 aggregates, V9 fixtures, V3 read-side adapters after A3a | HTTP fixtures 500/5000/20000 + growth, then read model |
| S4 `4ea7415a` | V2 DTO/sync, V3 history API consumer, V7 settings API | list DTO + delta/resync contract |
| S5 `15ab11b3` | V4, V2 client, V3 client, V7 shell | signal/state model and sidebar selectors |
| S6 `ef0304e6` | V5 tick, V6, V8 measure | per-site stall profile before any change |
| S7 `b162ea36` | V10, V0 integration coordination | readiness matrix vs A2–A6/B4 and MULTI-INSTANCE regressions |
| S8 `602a6a25` | acceptance of all | before/after on identical data |

Reconciliation of §1 and §3 (V4-F07): every vertical's §1 owner appears in the §3 row
of that stage. V0 = user commit decision + S2 coverage check (§3 S2, not S3). V3 =
A3a producer, S4 API consumer, S5 client, S3 read-side adapters (all after the A3a
gate). V8 = S6 measure, S8 accept (S6 row carries "V8 measure"). V9 = S1 artifacts,
S3 fixtures, S8 extension. V10 = S7, which also carries V0 integration coordination.

Deliverables stage 1 did **not** produce, with new owner (see baseline §6): dependency-
cycle report tool (S2, `scripts/`); 500/5000/20000 HTTP/E2E fixtures with ≥ 20
workspaces and growth fixtures (S3, V9); mobile profile, `sidebarRenderMetrics`
scenario, real browser runs (S5 measure, S8 accept); mixed ≥ 10 min load and 20-cycle
memory/listener check (S8, V9); Files/Terminal/Browser overhead (S6 measure, S8, V8).

## 4. Required vs deferrable verticals per stage

If a vertical is blocked by another program (storage A2–A6/B4, recovery R13–R20), the
stage may still be accepted only when its **required** verticals are done and every
**deferrable** vertical is recorded as blocked with the blocking item (never marked
done).

| Stage | Required | Deferrable if blocked by another program |
| --- | --- | --- |
| S2 | V1 contract, V0 coverage, dependency-cycle report | V2/V5 command-query boundaries touching R13/A4 scope |
| S3 | V9 fixtures (HTTP 500/5000/20000), V1 implementation | V3 read-side adapters (blocked by A2→A3a), V5 aggregates blocked by A4/R-scope |
| S4 | V2 list DTO + delta/resync for non-history lists, V7 settings API | V3 history API (A3a), V2 recovery-status parts (R13) |
| S5 | V4 signal/state model + sidebar selectors, V7 shell | V2 client parts waiting for R13; history views waiting for A3a |
| S6 | V6 per-site profile, V8 measurement | V5 tick (R15 scheduler), storage-owned V6 sites (A2/A4), owner-lock (R3) |
| S7 | V10 readiness matrix + MULTI-INSTANCE regressions, V0 coordination | per-store cutovers waiting for A3b/A4/A5/A6/B4 |
| S8 | acceptance of all non-deferred verticals with before/after on identical data | verticals blocked above, reported as blocked |

## Stage 2 artifacts

- Contract: [architecture-chat-catalog-contract.md](architecture-chat-catalog-contract.md) (`lib/chat-catalog.js`,
  `tests/chat-catalog-contract.test.js`).
- Dependency cycles: `scripts/architecture-dependency-cycles.mjs` -> `architecture-dependency-cycles.json`.
- V2/V5 command/query boundaries are contract text only; R13 `e304b86d` and A4 `6e483edd` parts are marked blocked there.

## Stage 3 artifacts and blocked verticals

Delivered in stage 3 (leaf `c4f2c95b`):

- **V9 fixtures**: `scripts/architecture-http-fixture.mjs` (seeded generator, isolated data dir) and
  `scripts/architecture-http-bench.mjs` (real Express + real chats routes over loopback HTTP) ->
  [architecture-http-baseline.md](architecture-http-baseline.md) / `architecture-http-baseline.json`.
  Smoke profile: `tests/architecture-http-fixture.test.js`.
- **V1 read model**: `ChatCatalog.page()` (keyset by store position, scope/archive filters before the limit,
  revision-stamped cursor) and `archivedCountsByWorkspace()` in `lib/chat-catalog.js`, exposed additively as
  `GET /api/chats/page`. `loadChats()`, the `chats.json` writer and `GET /api/chats` are unchanged, so the
  JSON path is its own fallback. Tests: `tests/chat-catalog-pagination.test.js`.

Blocked (recorded, NOT implemented; status checked with `todo_show` during stage 3, all `ready`):

| Vertical part | Blocker | Why |
| --- | --- | --- |
| V3 history read adapters (pages by seq on SQL) | A2 `4fb174ca` -> A3a `aadeac30` | The history backend and its seq/receipt protocol are produced by A3a; stage 3 must not create a second migration. |
| V5 TODO/Watcher/delegation SQL aggregates | A4 `6e483edd` (needs A3b `c68...` / B4 `09f85444`) | Transactions and domain cutover belong to A4. |
| V5 scheduler/supervisor/recovery counters | R13 `e304b86d` .. R20 | Recovery program owns policy and scheduler. |
| Store-level non-copy chat reads | storage owner (A2) | `loadChatsSnapshot()` still copies the whole list per call (O(N)); removing it needs a registry/adapter change owned by storage. |

## Stage 4 artifacts and blocked verticals

Delivered in stage 4 (leaf `4ea7415a`), all additive and read-side only:

- **V2 DTO + sync**: contract [architecture-list-sync-contract.md](architecture-list-sync-contract.md);
  `lib/chat-list-dto.js`, `lib/chat-list-sync.js`, `GET /api/chats/page?view=list`, `GET /api/chats/sync`,
  `ChatCatalog` `archived=tree` mode (archived-ancestor parity). Client state machine
  `app_front/features/chat/chatListSyncClient.js` (+ `getChatListSync`/`getChatListPage` in `app_front/api.js`,
  optional `requestListDelta` in `chatListLiveSync.js`). Tests: `tests/chat-list-sync.test.js`,
  `tests/chat-list-sync-client.test.js`, `tests/chat-list-live-sync-delta.test.js`.
- **V7 Settings**: `GET /api/settings` added to `scripts/architecture-http-bench.mjs`; numbers in
  [architecture-http-baseline.md](architecture-http-baseline.md).
- **Frozen API caps** recorded in baseline §5 and ADR D5 (human decision 2026-10-17).

Blocked (recorded, NOT implemented; statuses checked with `todo_show` during stage 4, all `ready`, integration `unconfirmed`):

| Vertical part | Blocker | Why |
| --- | --- | --- |
| V3 history consumer (pages by seq, replay, receipts, durable ACK, reject v1 writes after v2 cutover, keep unsent content until reconciliation) | A3a `aadeac30` (blocked by A2 `4fb174ca`) | A3a produces receipts, seq, datasetGeneration/chatEpoch and producer fencing; this stage must not create an alternative history protocol. The list sync client has no write path, so nothing here can write v1. |
| V2 recovery statuses in the sidebar (Przerwano po restarcie / Wznawianie / Oczekuje / Nieznany, resume actions) | R13 `e304b86d` (review state `unknown`) | R13 owns recovery statuses in the sidebar/history; DTO v1 deliberately carries no recovery field. When R13 lands it adds fields to DTO v2 (`dtoVersion` bump) rather than overloading v1. |
| WS frame carrying `seq` / push deltas | S5 + R13 coordination | `chatsChanged` frames are unchanged; clients treat any frame as a trigger for one coalesced `/api/chats/sync`. |
| Non-copy store read behind the catalog | storage owner (A2) | unchanged from stage 3. |

## Stage 5 artifacts and blocked verticals

Delivered in stage 5 (leaf `15ab11b3`), with the established renderer/state path retained:

- **Step 0 (stage-4 review fixes)**: `chatListSyncClient.js` scope binding, `archived=tree` delta parity pruning and `dispose()`
  (contract: [architecture-list-sync-contract.md](architecture-list-sync-contract.md)). Tests: `tests/chat-list-sync-client.test.js`.
- **V4 state model**: the experimental entity-store/shadow path was removed; the existing signal/state modules remain the only shipped model.
  A future sidebar model requires a new contract and acceptance evidence.
- **V7 shell**: measured and documented, **no `sw.js` change** (see [architecture-frontend-baseline.md](architecture-frontend-baseline.md));
  guard test `tests/sw-shell-assets.test.js`.

Blocked (recorded, NOT implemented; statuses checked with `todo_show` at stage 5, all `ready`, integration `unconfirmed`):

| Vertical part | Blocker | Why |
| --- | --- | --- |
| V2 recovery statuses in the sidebar / history (Przerwano po restarcie / Wznawianie / Oczekuje / Nieznany, Wznów / Pozostaw zatrzymane) | R13 `e304b86d` (status `ready`, code review state `unknown`) | R13 owns the recovery UI and its PL/EN strings; DTO v1 carries no recovery fields. Add them with DTO v2 once R13 lands. |
| V3 history views (windowed conversation history on the signal/state model, pages by seq, replay, durable ACK) | A3a `aadeac30` (status `ready`), blocked by A2 `4fb174ca` (status `ready`) | A3a produces the seq/receipt/generation protocol; no second history protocol is created here. The existing state boundaries are the seam the history view will plug into. |
| Introducing a replacement live sidebar model | new contract and acceptance of real-browser runs (frontend baseline) | The removed experimental path is not a migration target; the established renderer remains active. |

## Stage 6 artifacts and blocked verticals

Delivered in stage 6 (leaf `ef0304e6`), profile first, then one code change:

- **V6 profile** (before any code change): `scripts/architecture-stall-profile.mjs` (isolated tmp data dir, 1 ms event-loop sampling, per-site
  n/P50/P95/P99/max, P99 only stable from n >= 1000), results in [architecture-stall-profile.md](architecture-stall-profile.md) and
  [architecture-stall-profile.json](architecture-stall-profile.json). Test: `tests/architecture-stall-profile.test.js`.
- **V8 overhead** of Files / Terminal (ws + pty output, stub pty) / Browser (session bookkeeping, fake driver) measured separately from external
  operations; Chromium and real shell time are recorded as NOT measured.
- **One runtime change**, because it was the only stage-6-owned request-path site above the thresholds: `lib/files-list.js` sorts entries with one shared
  `Intl.Collator` instead of a per-comparison `localeCompare(..., options)` (identical ordering; 20 000-entry directory: P50 84 -> 39 ms, event-loop max
  101.8 -> 48 ms; exploratory). Test: `tests/files-list-order.test.js`. No queue, lock or lifecycle code was changed: every other stage-6 site is within the thresholds
  or reachable only with a second process.

Blocked or not changed (recorded, NOT implemented; statuses checked with `todo_show`/`todo_list` during stage 6: A2 `4fb174ca` and R15 `c3665531` are `ready`,
integration `unconfirmed`; A4 `6e483edd`, R16 `92ddf55f`, R17 `bfddf491` carry their stage-5 status `ready`, not re-read):

| Vertical part | Blocker / owner | Why |
| --- | --- | --- |
| V6 `Atomics.wait` in `delegation-sqlite.js:118` | A2 `4fb174ca` | storage-owned; removed with the sqlite-worker; not driven (contention-only) |
| V6 `Atomics.wait` in `workspace-watchers-persist.js:2916`, `model-pick-decisions-persist.js:51` | A4 `6e483edd` / A5 | storage-owned lock backoff; not driven |
| V6 `delegation-owner-lock.js:159` `isLockSocketLive` (always blocks 80 ms and never reports a live socket) | recovery R3 (done, read-only) | needs a recovery decision; evidence in the stall profile |
| V6 contended registry locks (`child-process-registry.js:130`, `opencode-port-registry.js:83`) | stage 6, deliberately unchanged | stall only with a second process (~50 ms per 40 ms hold); an async lock is a larger change than the measured single-instance benefit |
| V6 Files listing above ~6 000 entries in one directory (P99 47 ms at 20 000) | stage 6 follow-up | needs an async/chunked listing; residual below the 100 ms max gate |
| V5 tick: whole-mailbox read and an unconditional `loadChats()` copy per 5 s tick | A4 (mailbox reader/prefilter) + R15 `c3665531` (tick policy) | within thresholds today (tick P50 12 / max 19.7 ms at 3 000 mailbox rows); linear growth is an extrapolation, not measured |
| V5 scheduler / supervisor / OOM (R15 `c3665531`, R16 `92ddf55f`, R17 `bfddf491`) | recovery | out of scope; no second scheduler or supervisor |
| V8 real shell / Chromium / navigation time | stage 8 acceptance | external operations, excluded from Cretli overhead |

## Stage 7 evidence and readiness

Delivered in stage 7 (leaf `b162ea36`), evidence only — no migration, no cutover, no commit:

- **V10 readiness matrix**: [architecture-readiness-matrix.md](architecture-readiness-matrix.md) /
  `architecture-readiness-matrix.json` (dependency states re-read with `todo_show`, per-vertical go/no-go,
  explicit NO-GO list, rollback per vertical).
- **Multi-instance regression set** (docs/MULTI-INSTANCE.md semantics): `scripts/architecture-multi-instance-regression.mjs`
  runs 18 existing and new test files (18/18 passed); new `tests/multi-instance-regression.test.js` covers owner lease,
  non-owner refusal, TTL failover and the read-only stub through public functions with an in-memory Redis double.
- **V0 coordination**: file/hunk split between the V0 index fix, the unrelated `lib/mcp/mcp-vendor-map.js` and
  `lib/worktree/git-worktree.ts` changes, and the stage 1-6 artifacts (matrix section 8). The commit decision stays with the user.
- **Manifest for the next plan version**: `architecture-manifest-stage7.json`, produced by `scripts/architecture-manifest-stage7.mjs` (SHA-256 of all stage 1-8 documents, scripts,
  tests and changed sources) plus the plan v6 entries that are now stale. It is regenerated AFTER the last doc edit with
  `node scripts/architecture-manifest-stage7.mjs --write docs/architecture-manifest-stage7.json`; the plan v6 manifest stays stale until a human approves plan v7.

Still blocked (recorded, NOT implemented; statuses re-read with `todo_show` in stage 7: A2 `4fb174ca`, A3a `aadeac30`,
A3b `c688a6a1`, A4 `6e483edd`, A5 `88131b70`, A6 `9ef8ceca`, B4 `09f85444` and R13-R20 are all `ready` with integration
`unconfirmed`; only A1 `7a287da9` is integrated):

| Vertical part | Blocker | Why |
| --- | --- | --- |
| V3 history, V1 metadata store, V5 transactions, every V10 cutover | A2 → A3a → (A3a + B4) → A3b → A4 → A5 → A6 | none is integrated; reverse export tooling does not exist |
| V2 recovery statuses, V5 scheduler/supervisor/OOM | R13 `e304b86d`, R14-R20 | recovery program owns them |
| V4 replacement shared-state model, V7, V8 real-shell time | new contract and real browser acceptance (S8) | not executed |

## Stage 8 acceptance (leaf `602a6a25`)

Evidence only; no production code changed. [architecture-acceptance.md](architecture-acceptance.md) /
`architecture-acceptance.json` re-run the HTTP, chat-list and stall-profile benches plus the stage 2-6
contract tests and the multi-instance regression set (18/18) on synthetic fixtures. Overall verdict: **NOT ACCEPTED**.
Verticals V3, V5 and V10 are BLOCKED (A2-A6, B4, R13-R20), V7 and V8 are NOT MEASURED, the rest NOT ACCEPTED. Still open:
real browser/device runs, the >=10 min mixed load, 20-cycle stability, and the unpaged `GET /api/chats` exceeding 1 MiB.
Stage 7 and 8 files are untracked (no checkpoint); the acceptance test depends on the untracked readiness matrix. Also open: domain-boundary
cleanup (legacy list route and renderer), perf smoke/observability (`health-routes.js` 20 ms sampling), persist-queue-age and scope tests (NOT MEASURED).
