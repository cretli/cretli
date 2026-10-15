# Usage telemetry

Instance-wide, privacy-safe model/harness telemetry: a canonical usage event,
an append-only journal, a durable read-model, HTTP/WS read APIs, optional
alerts and journal retention.

The machine-readable contract (per-harness matrix, bucket semantics, identity)
lives in [`lib/usage/usage-contract.js`](../lib/usage/usage-contract.js) and its
matrix reference is [`docs/usage-contract.md`](./usage-contract.md). This
document covers the event shape, the endpoints, retention/alerts and the steps
to add a harness.

## 1. Canonical event

Every harness normalizes to one shape built by
[`createUsageEvent`](../lib/usage/usage-event.js). Fields:

| Field | Meaning |
| --- | --- |
| `id` | Event id (UUID). |
| `at` | ISO timestamp. |
| `provider` | Billing provider (`openai`, `google`, `azure`, `openrouter`, `mistral`, `cursor`, `other`). |
| `feature` | `voice-live`, `voice-tts`, `voice-stt`, `chat`, `other`. |
| `model`, `variant` | Model id (child usage always carries its own model). |
| `workspaceFile`, `chatId` | Opaque identifiers used for scoping/filters. |
| `cycleId` | Workspace-Watcher cycle stamp when the run belongs to one. |
| `harness` | `sdk`, `claude`, `codex`, `deepseek`, `qwen`, `opencode`, `codebuddy`, `openrouter`, `mistral`, `voice`, `other`. |
| `role` | `chat`, `plan`, `implement`, `review`, `fix`. |
| `eventType` | `delta` (token deltas) or `run` (one finished run, no token sums). |
| `outcome` | `ok`, `error`, `limit`, `aborted` (run events). |
| `errorCode` | Short, de-identified error code. |
| `latencyMs`, `ttftMs` | Durations. |
| `delegationId`, `attemptId`, `runId`, `sourceSessionId` | Durable correlation ids. |
| `tokens` | Disjoint token bag: `textInput`, `textOutput`, `audioInput`, `audioOutput`, `cachedInput`, `cacheWrite`, `reasoning`. |
| `characters`, `audioSeconds` | Non-token measurements. |
| `usd` | Server-priced cost (or `null`). Never accepted from a client. |
| `reportedUsd` | Provider-reported cost when the harness supplies one. |
| `billingMode` | `subscription` when there is no marginal USD cost. |
| `estimated` | `true` when `usd` came from the static rate table. |
| `source` | `server` or `client`. |
| `schemaVersion`, `normalizationVersion`, `contractRevision` | Version block. |
| `usageShape`, `measurementKind`, `granularity`, `inputIncludesCache`, `reasoningRelation` | Adapter semantics for this event. |
| `contextEpoch` | Context reset discriminator. |
| `provenance` | `reported`, `estimated`, `unknown`. |
| `accountingScope` | `own` or `consolidated` (never added together). |
| `lifecycle`, `completeness`, `measurementPresent` | Run coverage. |
| `coverage` | Coverage proof (`expectedRequests`, `coveredRequests`, ...). |
| `identityClass`, `logicalEventKey` | Exactly-once identity. |

Contract versions are bumped when the persisted shape or normalization
semantics change (`USAGE_SCHEMA_VERSION`, `USAGE_NORMALIZATION_VERSION`,
`USAGE_CONTRACT_REVISION`).

## 2. Storage layout

`data/usage/` is the instance store:

| Path | Purpose |
| --- | --- |
| `YYYY-MM-DD.jsonl` | Append-only journal, one UTC day per file. Each line is a versioned, checksummed envelope `{v,seq,kind,at,event,crc}`; a torn trailing line is treated as corrupt, not committed. Pruned by retention. |
| `ledger-index.json` | Rebuildable read-model: identity keys, snapshot baselines, runs, corrections, diagnostics. |
| `plan-limits.jsonl` | Append-only plan-window samplings (utilization/status/reset) per harness. |
| `limits.jsonl` | Append-only lockout rows (binary blocks). |
| `unclassified-errors.jsonl` | Capped samples of unrecognized provider errors. |
| `alert-state.json` | Per-period alert throttle fingerprints. |

The journal is the source of truth. `ledger-index.json` is never authoritative:
a crash between the journal append and the index write is recovered by tailing
the journal on the next refresh.

## 3. HTTP API

### Write

- `POST /api/usage/events` — client telemetry (e.g. voice). Accepts
  `provider`, `feature`, `model`, `usage`/`tokens`, `chatId`,
  `workspaceFile`. **A client-supplied `usd` is rejected with HTTP 400**;
  cost is always priced server-side. Prompts, responses, reports and file paths
  are ignored (the route only reads the documented fields).

### Read

All read endpoints accept the shared filter vocabulary (`from`, `to`, `tz`,
`range`, `role`, `harness`, `origin`, `scope`, `subject`, `workspaceFile`,
`chatId`). `range` is one of `today`, `month`, `24h`, `7d`, `30d`, `month7d`.

- `GET /api/usage/summary` — totals, disjoint buckets, cost provenance,
  zone-local days, KPI, coverage.
- `GET /api/usage/timeseries` — bucketed series (`bucket`, `groupBy`, `metric`).
- `GET /api/usage/models` — ranked per-model rows.
- `GET /api/usage/insights` — the single filter-consistent payload used by the
  chart, table, tooltips and CSV.
- `GET /api/usage/plan-limits` — latest plan windows and active lockouts.
- `GET /api/usage/settings` — normalized retention/alert settings plus the
  `data/usage/` directory summary (`bytes`, `files`, `dayFiles`, oldest/newest
  day).
- `POST /api/usage/settings` — partial patch of `retentionDays` and
  `alerts.*`; `{ pruneNow: true }` also runs the retention sweep immediately.
- `GET /api/delegations/stats` — model × role delegation outcomes shown in the
  Usage tab.

### WS / live

- The notification centre broadcasts `{ type: 'notificationsChanged', revision,
  reason }` on the chat-list channel whenever a row is published (including
  usage alerts). The client refetches the store on a newer revision.
- Usage alerts also produce a Web Push payload with
  `data.type = 'usage-alert'` and `data.url = '/?panel=settings&tab=usage'`.

## 4. Privacy guarantees

Telemetry records aggregate counters and opaque ids only. It must never contain
prompt text, model responses, report bodies, transcripts or source file paths.

- `createUsageEvent` copies only the documented fields; unknown fields (e.g.
  `prompt`, `response`, `report`, `filePath`) are dropped.
- `containsConversationContent` in the contract guards the matrix examples.
- `POST /api/usage/events` only reads its allow-list and rejects `usd`.
- Lockout history stores a short `code` and (up to 1000 chars) provider message
  for diagnostics, never a prompt; the plan-limit history stores numbers only.
- `tests/usage-privacy.test.js` asserts that forbidden fields and sentinel
  strings never reach the journal and that the client endpoint rejects `usd`.

## 5. Retention and alerts

Settings live in `data/config.json` under `usage` (see
[`usage-settings.js`](../lib/usage/usage-settings.js)):

```json
{
  "usage": {
    "retentionDays": 90,
    "alerts": {
      "planLimit": false,
      "lockout": false,
      "budget": false,
      "planLimitThresholdPercent": 80,
      "dailyBudgetUsd": null,
      "monthlyBudgetUsd": null
    }
  }
}
```

- **Retention** defaults to 90 days. `pruneUsageJournal` deletes only
  `YYYY-MM-DD.jsonl` day files older than the cutoff; auxiliary stores are
  untouched. Ledger identity keys/baselines are pruned separately with the
  30-day ledger floor (`USAGE_KEY_RETENTION_MS`).
- **Alerts are off by default.** When enabled, `usage-alerts.js` evaluates:
  plan windows at/above `planLimitThresholdPercent`, active lockouts, and
  daily/monthly spend at/above the configured USD budget. Each crossing
  notifies at most once per period (window reset time, or the calendar
  day/month), tracked in `data/usage/alert-state.json`.
- The maintenance loop (`usage-maintenance.js`) runs retention at server
  startup and every six hours, and polls alerts at startup and every five
  minutes. The per-period alert state keeps the shorter alert poll spam-free.
  It is best effort and never breaks the server.

## 6. Adding a harness to telemetry

1. **Declare the harness id.** Add it to `USAGE_HARNESSES` in
   `lib/usage/usage-event.js` and, if it is one of the required matrix
   harnesses, to `USAGE_MATRIX_HARNESSES` in `lib/usage/usage-contract.js`.
2. **Add the contract entry.** Add a `defineContract({...})` row to
   `USAGE_HARNESS_MATRIX`: `usageShape`, `measurementKind`, `granularity`,
   `payloadInputIncludesCache`, `bagInputIncludesCache`, `reasoningRelation`,
   cache flags, `defaultIdentityClass`, `identityFields`, `source` and a
   content-free `example`. Keep `docs/usage-contract.md` in sync.
3. **Add provider fallback** if the harness only exposes a provider name
   (`PROVIDER_HARNESS_FALLBACK`).
4. **Normalize the payload.** Add a `fromXxxUsage` adapter in
   `lib/usage/usage-normalize.js` and, when the harness emits a raw event,
   extend `resolveHarnessUsageTokens` in `lib/usage/harness-usage.js` so the
   stored bag is disjoint (uncached input, cache separated, reasoning relation
   applied).
5. **Route the events.** Harness loops that use the shared room kernel get
   `sdkPromptStarted` → `beginHarnessRun`, `sdkEvent` type `usage` →
   `recordHarnessUsageDelta`, and `sdkRunFinished` → `recordHarnessRunFinished`
   for free (`lib/agent-harness/room-kernel.js`). A harness that owns its
   socket calls `recordHarnessUsageSnapshot` (cumulative) or
   `recordHarnessUsageDelta` itself with the room.
6. **Price it.** Add provider rates in `lib/usage/usage-rates.js`, or set
   `reportedUsd` from the provider and `billingMode: 'subscription'` for
   prepaid plans.
7. **Test it.** Add a `tests/<harness>-usage-telemetry.test.js` following the
   existing harness telemetry tests, plus a matrix/contract assertion when the
   contract row changes.

## 6b. TODO usage statistics

Two read-only views over the *existing* ledger answer "what did this TODO
cost?". They never write usage, never re-price an event and never touch the
delegation or todo tree.

- Read model: [`lib/usage/todo-usage.js`](../lib/usage/todo-usage.js) (pure),
  I/O: [`lib/usage/todo-usage-read.js`](../lib/usage/todo-usage-read.js),
  routes: `lib/routes/todos-routes.js`.

### Join

A usage event is attributed to a TODO through its delegation:

```
delegation (leafId = todo id) -> attempt (attemptId + runId) -> usage event
```

The join key is `delegationId + attemptId + runId`. Consequences:

- a **retry** is a new attempt/run on the same delegation row, so it is a
  separate measurement, and a repeated delivery of one logical event (same
  `logicalEventKey`) is counted once (`unattributed.duplicateEvents`);
- a missing, mismatched or ambiguous attempt/run identity is left unmatched; no
  delegation-only fallback is used;
- an event without a `delegationId` (or with an unknown delegation) cannot be
  attributed. It is counted in `unattributed.events` only when the ledger event
  carries this workspace's `workspaceFile`. The ledger schema has no
  `workspaceFolder`, so unjoined events with no workspace key are reported
  separately as `unattributed.unscopedEvents` (also `diagnostics.unscopedEvents`)
  and are never summed into any total;
- `attempts` counts expected distinct attempts from delegation lifecycle records,
  including attempts with no ledger event; `delegations` counts their unique
  delegation ids.

### Tree attribution

`own` is the usage of the delegations bound to this very TODO; `consolidated`
is the usage of the delegations bound to its descendants. Both are returned
side by side and **must never be added**: the response carries `mixed` when
both are non-empty and deliberately has no combined total. Every event is
attributed to exactly one TODO, so a tree roll-up can never double count a
child (`duplicationGuard`).

The nested `summary` defaults to accounting scope `own`; callers may select
`accountingScope=consolidated`; `both` is rejected with 400. The separate `accountingScopes` field
always reports own and consolidated subtotals side by side. These use
`own`/`consolidated` in the ledger’s per-event accounting-scope sense, separate
from the TODO tree attribution axis.

### Missing data versus zero

| Situation | Value | Coverage |
| --- | --- | --- |
| No joined event at all | `usd: null`, `tokens: null` | `state: 'no_data'`, `costCoverage: 'none'`, note `no_usage_events` |
| Event measured `usd: 0` | `usd: 0` | `costCoverage: 'complete'` |
| Event without `usd` (history written before pricing) | `usd: null` | `unpricedEvents`, note `cost_is_not_recomputed_from_the_rate_table` |
| `billingMode: 'subscription'` | `usd: null` | `subscriptionEvents`, note `subscription_usage_is_not_zero_cost` |

A subscription is **not** a zero cost, and an unpriced historical event is
never re-priced from the rate table — it is reported as missing instead.

### Cost and time

- Cost comes from the ledger only: `usd` sums events the ledger already
  priced, `estimatedUsd` keeps rate-table estimates apart, and `reportedUsd`
  carries provider-reported cost. Run events carry no tokens and no cost.
- `attemptsDurationMs` is the **sum** of per-attempt wall time. `elapsedMs`
  is the **span** from the earliest queue/start to the latest finish. They
  differ whenever attempts overlap, and an open span is `null`.

### Endpoints

| Route | Meaning |
| --- | --- |
| `GET /api/todos/usage` | Workspace view: one row per TODO plus a `workspace` roll-up. Registered **before** the parametric `/api/todos/:id*` routes so `usage` is never captured as an id. |
| `GET /api/todos/:id/usage` | One TODO, `own` + `consolidated`. |

Query parameters (both routes):

| Parameter | Default | Rule |
| --- | --- | --- |
| `from`, `to` | — | ISO 8601 instant or `YYYY-MM-DD`; the range is `[from, to)`. |
| `range` | `30d` | Named range when no endpoint is given (`today`, `month`, `24h`, `7d`, `30d`, `month7d`). |
| `tz` | server default | IANA zone; an unknown zone is an error. |
| `limit` | `50` | `1..200`; anything else is 400. |
| `cursor` | — | Opaque cursor from the previous `nextCursor`. |
| `scope` | `both` | `own`, `consolidated` or `both`. |
| `accountingScope` | `own` | Ledger accounting scope: `own` or `consolidated`. `both` is rejected with 400 because the scopes are alternatives and summing them double counts; `accountingScopes` in each aggregate carries both subtotals side by side. |
| `include` | `all` | `all`, or `usage` for rows with at least one event. |
| `status` | — | Comma-separated TODO status filter. |
| `root` | — | Limit the workspace view to one subtree. |

Responses contain no filesystem paths (no `cwd`). Attempt counts (`attempts`,
`delegations`, `attemptsDurationMs`, `elapsedMs`) come from delegation lifecycle
records and are not narrowed by the window or model filter. The window is capped at 92 days. Responses carry `asOf`, `appliedFilters`,
`currency: 'USD'`, `window`, `limit`, `offset`, `total`, `returned` and
`nextCursor`. The workspace `workspace` total is computed over the selected
root/status subtree. Every sum (tokens, `usd`, `reportedUsd`, coverage
counters) is computed from the events that pass the model filter and the
selected `accountingScope`; the `status`/`root` filters select rows only and
never remove a descendant from its parent's `consolidated` side. `usd` is
`null` unless at least one event was priced by the ledger; estimated-only usage
is reported as `estimatedUsd` with `usd: null`.

Pagination: the cursor binds the normalized filters (`from`/`to` calendar days,
root, status, include, scope, model, accountingScope) and a data revision built
from stable fields only (TODO ids + `updatedAt`, delegation ids and attempt
keys, ledger event count). The rolling instant of a `30d` window is not bound,
so page 2 succeeds and every page repeats the same workspace totals. A changed
filter or new data returns 409 `CONFLICT` and requires pagination to restart.
Ordering uses stable TODO ids. Model-by-role summaries are exposed as
`byModelRole`.

Coverage: `coverage.ledger` carries `corrupt` and `retainedOut` from the ledger
read diagnostics (`retainedOut` is `1` when the window starts before the oldest
retained day file, so retention may have removed days that cannot be proven
present; older files outside the window never set it) (`null` when not supplied) and `missing`, the number of
lifecycle attempts with no joined event. `coverage.contractual.complete` is
`true` only when corrupt = 0, retainedOut = 0, missing = 0 and at least one
attempt is expected; otherwise it is `false`. Corruption is a counter that
makes the contract incomplete — it is not itself an error response.

Errors: `400` for an invalid window/limit/cursor/scope (code `VALIDATION`),
`409` for a cursor bound to stale data or filters (`CONFLICT`), `404` for an
unknown TODO (`NOT_FOUND`), and `503` with code
`USAGE_UNAVAILABLE` when the ledger cannot be read — never an empty result.
The list endpoint `GET /api/todos` gains no extra I/O.

### UI

The statistics have two entry points in the TODO panel; both read the two
endpoints above and add no backend surface.

- **Editor tab "Usage"** (`cr-todo-card`): one TODO. `own` and `consolidated`
  (descendants) are shown as separate columns and are never added together.
- **Workspace dialog** (chart icon in the TODO toolbar): a workspace summary,
  a model x role table and a per-TODO table with "load more" cursor paging.
  The scope is always the active workspace (`workspaceFolder`).

Code: `app_front/features/todo/todoUsageView.js` (pure view model, formatting,
state resolution), `todoUsageController.js` (fetch, abort, stale-response
guard), `crTodoUsage.js` (`<cr-todo-usage>` Lit section). Filters: period
(`24h`, `7d`, `30d`, `month`), status (workspace view), model and "only tasks
with usage".

Display rules:

| State | When |
| --- | --- |
| loading | request in flight and nothing to show yet |
| unavailable | HTTP 503 / `USAGE_UNAVAILABLE` (ledger unreadable) |
| error | any other failure (network, 4xx, 5xx) |
| empty | no attempts and no events in the window |
| partial | numbers exist but are unproven: unpriced events, corrupt/retained-out days, attempts without usage |
| ready | measured and contractually complete |

`null` is shown as an italic "—" with a "not measured" tooltip; a measured `0`
is shown as a number. An estimate-only cost is prefixed with `~`. Every new
request aborts the previous one and carries a sequence number, so a slow
response for an older filter or TODO never replaces a newer one. Tests:
`tests/todo-usage-ui.test.js`.

## 7. Tests

- `tests/usage-*.test.js` — contract, ledger, persistence, window, insights,
  routes, retention, alerts, privacy.
- `tests/todo-usage.test.js` — join, retry, tree duplication, own/consolidated,
  null versus zero, cost coverage, elapsed versus sum, filters, pagination.
- `tests/todos-routes-usage.test.js` — endpoint contract, window defaults and
  caps, cursor pagination, 400/404/503 mapping, workspace scoping.
- `tests/todo-usage-ui.test.js` — UI view model, null versus zero, view states,
  filters, stale-response guard, PL/EN keys.
- `tests/usage-settings.test.js`, `tests/usage-settings-routes.test.js` —
  retention/alerts settings normalization and the settings API.
- `tests/usage-privacy.test.js` — no conversation content or paths, client
  `usd` rejected.
- Per-harness telemetry: `tests/*-usage-telemetry.test.js` and
  `tests/usage-harness-hook.test.js`.

Run them with `node --test tests/usage-*.test.js` or the full unit runner
(`npm test`).

## 8. Acceptance and rollout

The stage-9 conformance suite runs the ten mandatory usage/model-pick
scenarios on one frozen fixture and cutoff
(`tests/usage-acceptance-usage.test.js`, `tests/usage-acceptance-decisions.test.js`,
`tests/usage-acceptance-policy.test.js`). The scenario-by-scenario evidence map
and the open criteria are in
[usage-acceptance-report.md](usage-acceptance-report.md). Enable and roll back
the stages with [usage-rollout.md](usage-rollout.md).

## 9. Cache freshness and session generations

`lib/usage/cache-state.js#getCacheFreshness` (MCP `cache_freshness`,
`GET /api/usage/cache-freshness?chat_id=`) is a local read of the in-memory
per-chat state; it never issues a model request or refreshes a cache.

- `expiresAt` / `expiresInMs` exist only when the harness TTL is known and the
  estimate is warm. An unknown TTL yields `unknown`, never a countdown.
- A reset (restart, compaction, epoch bump) opens a new `generation`, drops the
  estimate and the current context fill, and keeps the cumulative session
  totals: usage history is never rewritten.
- Cache (`cache`, `session`) and context fill (`context.inputTokens`) are
  separate dimensions; cached tokens still occupy the context window.
- Harnesses that do not report cache read/write expose that as
  `cache.telemetry.cacheRead/cacheWrite: false` instead of zeros.
- State is in-memory (`stateScope: process`, `stateSince`) and deliberately not
  persisted: after a server restart a chat has no observation, `confidence` is
  `none` and no estimate or countdown is produced (no false-warm). Usage history
  lives in the ledger and is unaffected, so a restart never double counts.

### Workflow / round breakdown

`GET /api/usage/workflow-breakdown` (`lib/usage/workflow-breakdown.js`) groups
delegated usage by leaf and round. The ledger already stamps `delegationId`,
`attemptId` and `runId`; the round is the 1-based ordinal of the attempt among
the leaf's attempts, so no new ledger field exists. Replayed logical events are
counted once (`duplicates`), unattributable events are reported as
`unmatched`, and cost keeps measured (`actualUsd`) separate from estimated.

## 10. Optional paid cache keep-alive and net-savings benchmark

Keeping a prompt cache warm is a **paid, opt-in** feature. It is off by
default: no plan exists until `keepalive_config` (or a manual ping)
creates one, no timer runs without an active automatic plan, and no user-global
setting is changed.

### What a ping is

A ping is a real provider request issued into the **same harness session** of a
finished review delegation (`startChatRun` on its child chat). It is not a
mailbox message (delivery without a request is never counted as success), not a
new chat, and not a review round: it creates no delegation, report or verdict
and changes no TODO status. The prompt asks for a one-word reply, but a warm ping
still reads the whole cached prefix, so it is never assumed cheap.

A ping is *effective* only when the provider usage of that very request shows a
cache read. Without usage it becomes `unconfirmed` with an unknown cost, which
stops a budgeted plan (`cost_unknown`).

### Modes and availability

| Mode | Needs |
| --- | --- |
| `off` (default) | nothing |
| `manual` | resumable adapter, harness session id |
| `auto` | everything for manual **and** a known TTL policy, a firm tariff, `budget_usd`, `expect_next_round_until`, and a passing benchmark gate |

When a prerequisite is missing `auto` is refused with a stable reason
(`resume_unsupported`, `ttl_unknown`, `cost_unknown`, `budget_required`,
`next_round_required`, `benchmark_missing`, `benchmark_no_go`); it is never
silently downgraded.

### Bounds

`max_pings` (default 3, hard 10), `min_interval_ms` (default 60 s, floor 30 s),
`max_duration_ms` (default 30 min, hard 2 h) and `budget_usd` (hard 5). A plan
stops (terminal) on: `cancelled`, `workflow_ended`, `session_reset`,
`chat_missing`, `deadline`, `ping_limit`, `budget_exhausted`, `cost_unknown`,
`provider_limit`, `ineffective` (2 pings without a cache read), `not_needed`
(past the declared next round or a newer round started on the session),
`cache_expired`, `not_economic`, `error`, `user_stopped`.
It **defers** (non-terminal) on `busy` (a run or a delegation is active in the
session — a review is never preempted), `user_command` (a non-keep-alive turn in
the last 2 minutes), `min_interval` and `not_due`. A manual ping skips only the
due-ness check, never a stop or deferral.

### Restart, dedupe, audit

Plans live in memory. A restart drops them and nothing is caught up; a long
suspend inside a live process is evaluated once and ends as `cache_expired`, not
as a burst. At most one ping per plan is in flight, request ids are
deterministic (`keepalive:<delegationId>:<key>`) and replayed manual calls
return the first result, so two paid requests are never created. Every plan
event (created/refused/requested/deferred/failed/settled/stopped) is audited
(bounded in-memory log plus a `[keep-alive]` console line).

### Cost accounting

Each settled ping carries its measured cost (or `null`). The remaining budget is
`null` ("unknown") as soon as one ping is unmeasured. Ping usage is attributed by
run id and appears in `GET /api/usage/workflow-breakdown` as a separate
`keep_alive` row per leaf (round `null`); it is not folded into a review round
and not reported as unmatched.

### MCP, REST and UI

`keepalive_status` (read-only), `keepalive_config`,
`keepalive_ping`, `keepalive_stop` (mutating, blocked in Plan/Ask).
REST: `GET /api/usage/keep-alive` (overview), `POST /api/usage/keep-alive`
(`status|configure|ping|stop`). Settings → Usage shows plans with mode, stop
reason, last deferral, pings left, budget left (or "Unknown"), spent, a stop
button and the benchmark gate.

### Benchmark and go/no-go gate

`node scripts/measure-cache-keepalive-benchmark.mjs --observations <file> --out`
compares **fresh**, **reuse** and **reuse + keep-alive** on the same fixture
version (`tests/fixtures/keep-alive-benchmark/fixture.json`) for both reviewers
and the coordinator, including every ping's cost, wall time and the seeded bugs
found. `--emit-template` prints the observation shape; `--simulate` only
exercises the pipeline and can never open the gate.

The gate is `go` only for a **measured** report with identical fixture versions,
all three participants in every arm, a known tariff for every cost (pings
included), a net saving against fresh *and* against plain reuse, no loss in
seeded bugs found and mostly effective pings. Otherwise it is `no_go` with
reasons. An unknown tariff gives an unknown cost, never a savings promise.

The benchmark measures resume **capability on a fixture**, not a real review
loop: the pair is not wired into loops (plan v3 decision, todo
`8ed03f09-b5e7-418e-afea-ad26a2df2d66`), so no conclusion about savings in loops
is drawn. The scheduler reads `data/keep-alive-benchmark.json` and recomputes
the gate from the stored report; a missing file is `no_go`. A negative result is
a valid outcome and keeps `auto` unavailable.

#### Result recorded with this change

No measured run exists in this repository. The pipeline was exercised with
`--simulate` only: source `simulated`, tariff unknown, all costs unknown, gate
`no_go` (`not_measured`, `cost_unknown`). Consequently automatic keep-alive is **unavailable** until a
measured report with a known tariff passes the gate; manual pings remain
available as an explicit, bounded, user-paid action.

## Plan-window mode in `model_pick`

Enabled by default per workspace (Settings → Delegations → Models):

- `plan_window_enabled` — soft 5h headroom tie-break plus the hard weekly
  threshold. Off restores the legacy per-harness plan-limit penalties.
- `plan_window_hard_free_percent` (1-20, default 5) — a weekly window
  (`seven_day*`) with at most this much free excludes the model from
  `model_pick` (`plan-window-exhausted`). Explicit named starts are unaffected.

Candidates expose `plan_headroom_level`; a started delegation stores a
`planHeadroomSnapshot` (shown on the delegation card) next to `pickReason`.
