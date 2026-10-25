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

### Price provenance (`pricing`)

Every event whose `usd` was computed by `priceUsage` carries an optional,
additive `pricing` block (not part of the schema version bump; legacy events
simply lack it):

| Field | Meaning |
| --- | --- |
| `source` | `token_rates` (static table, model-prefix match), `provider_fallback` (generic per-provider row for an unlisted model; always `estimated: true`), `openrouter_pricing`, `reported` (provider-reported `reportedUsd`) or `none` (unpriced). |
| `ratesVersion` / `ratesCapturedAt` | Version label and review date of the table (`TOKEN_RATES_VERSION`, `TOKEN_RATES_CAPTURED_AT`). |
| `rates` | Snapshot of the per-million rates actually applied (`textInput`, `cachedInput`, `cacheWrite`, `audioInput`, `textOutput`, `audioOutput`), enough to reproduce `usd` without the current table. |
| `charRatePerMillion` / `minuteRate` | Applied TTS / STT rates, when used. |
| `reportedUsd` | Echo of the reported cost when `source` is `reported`. |
| `reason` | Why an event is unpriced (`unknown_model`) when `source` is `none`. |

Rules: the block is written once at record time and is never recomputed. Changing
`TOKEN_RATES` affects only events recorded afterwards; history is repriced only
by an explicit migration. A model the table does not know yields `usd: null`
with `pricing.reason = 'unknown_model'` unless the provider has a labelled
fallback row (`openrouter`, `google`, `openai`), which is flagged
`provider_fallback` + `estimated: true` and so stays out of `totalUsd`.

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
- `GET /api/usage/resume-advice?chat_id=` — cheap-resume advice for one chat
  (see "Resume advice" in section 9).
- `POST /api/usage/settings` — partial patch of `retentionDays`, `alerts.*` and
  `resumeAdvice.*`; `{ pruneNow: true }` also runs the retention sweep immediately.
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
[`usage-settings.js`](../lib/usage/usage-settings.ts)):

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
    },
    "resumeAdvice": {
      "enabled": true,
      "minContextTokens": 100000
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
- **Auto-resume after a limit reset** is a separate top-level block,
  `usageLimitResume` (off by default), edited from the same Settings → Usage tab
  through `PATCH /api/usage/limit-resume/settings`. It is not part of the
  `usage` block and is not saved by `POST /api/usage/settings`. Keys, bounds and
  the notification catalogue: [`usage-limit-resume.md`](usage-limit-resume.md).

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
   extend `resolveHarnessUsageTokens` in `lib/usage/harness-usage.ts` so the
   stored bag is disjoint (uncached input, cache separated, reasoning relation
   applied).
5. **Route the events.** Harness loops that use the shared room kernel get
   `sdkPromptStarted` → `beginHarnessRun`, `sdkEvent` type `usage` →
   `recordHarnessUsageDelta`, and `sdkRunFinished` → `recordHarnessRunFinished`
   for free (`lib/agent-harness/room-kernel.ts`). A harness that owns its
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

- Read model: [`lib/usage/todo-usage.ts`](../lib/usage/todo-usage.ts) (pure),
  I/O: [`lib/usage/todo-usage-read.ts`](../lib/usage/todo-usage-read.ts),
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

`lib/usage/cache-state.ts#getCacheFreshness` (MCP `cache_freshness`,
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
  persisted: after a server restart the tracker itself has no observation and
  `confidence` is `none` (no false-warm). `GET /api/usage/cache-freshness`
  additionally returns a `countdown` that falls back to the persisted context
  samples, so a restarted server can still report a (flagged, estimated) expiry
  for a chat. Usage history lives in the ledger and is unaffected, so a restart
  never double counts.

### Resume advice (cheap-resume banner)

`GET /api/usage/resume-advice?chat_id=` (`lib/usage/resume-advice.ts`) is a
local read that decides whether the chat UI should offer a cheaper resume. It
makes no model request and never blocks sending. `show` is true only when the
feature is enabled, the harness has a known cache TTL (claude, codebuddy, qwen),
the chat is idle, the cache is cold (same retention logic as
`cache-freshness`, including the samples fallback after a restart) and the
context size (live tracker, else the latest persisted sample) is at least
`usage.resumeAdvice.minContextTokens`. `estimatedRewriteUsd` is a lower bound
(`contextTokens * text-input price`), `null` for subscription billing, unpriced
harnesses (codebuddy, qwen) and `auto`/`default` models. Settings -> Usage
exposes `usage.resumeAdvice.enabled` (default on) and `minContextTokens`
(default 100000, clamped 1000..10000000). The banner offers **New chat with
reference** (`POST /api/chats/:id/fork` with `mode: 'reference'`, a no-copy fork:
the new chat copies no history and no summaries, links to the old chat and its
first prompt names the old chat so the agent can read it on demand through
`chat_history` / `chat_show`; it still inherits the auto-compression settings.
An unsupported or non-string `mode` and `analyze` + `reference` return 400, a
parent without saved events 409) and **Send anyway**.

### Workflow / round breakdown

`GET /api/usage/workflow-breakdown` (`lib/usage/workflow-breakdown.ts`) groups
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

Plans live in memory; a minimal snapshot is also written to
`data/keep-alive-plans.json`. After a restart every restored plan is shown as
stopped with `server_restart` and is never resumed or caught up; a long suspend
inside a live process is evaluated once and ends as `cache_expired`, not as a
burst. At most one ping per plan is in flight, request ids are deterministic
(`keepalive:<delegationId>:<plan nonce>:<key>`) and replayed manual calls
return the first result (the replay map is bounded, oldest key evicted first),
so two paid requests are never created. The plan's nonce, active state and
session generation are captured before a ping is issued and re-checked when the
request returns: a ping superseded mid-flight (plan stopped or re-created,
session reset) is kept as a `superseded` entry with its run id for cost
attribution, is not counted in `pingsDone`, adds no cost or effectiveness claim,
is audited as `ping_superseded` and never revives the plan. Cancel and session
reset are detected by the next evaluation (`cancelled`, `session_reset`); there
is no separate push hook. Every plan
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
reason (translated label; an unknown code is shown raw), last deferral, pings left, budget left (or "Unknown"), spent, a stop
button and the benchmark gate.

### Benchmark and go/no-go gate

`node scripts/measure-cache-keepalive-benchmark.mjs --observations <file> --out`
compares **fresh**, **reuse** and **reuse + keep-alive** on the same fixture
version (`tests/fixtures/keep-alive-benchmark/fixture.json`) for both reviewers
and the coordinator, including every ping's cost, wall time and the seeded bugs
found. `--emit-template` prints the observation shape; `--simulate` only
exercises the pipeline and can never open the gate. `--verify-material` checks
the fixture material and exits non-zero on a problem; `--observations` and
`--simulate` run the same check first and refuse to build a report on a mismatch.

**Fixture material and provenance.** The fixture carries real review material
(`tests/fixtures/keep-alive-benchmark/material/round-*.md`) with the six seeded
bugs; `fixture.json` records per material `{id, file, sha256}` and, per seeded
bug, a `bugMarkers` snippet that must be present in its file. The runner writes
the report's `provenance` itself from the verified files: fixture id and
version, per-material id and sha256, `collector` (`measure-cache-keepalive-benchmark`
v1) and `collectedAt`; provenance inside an observations file is ignored. The
declared `source` alone is not trusted: the gate refuses `go` with
`provenance_missing` (absent, incomplete, unknown collector, or no fixture to
verify against) or `material_hash_mismatch` (fixture id/version, material ids or
sha256 differ from `fixture.json`, or the files on disk no longer match). The
provenance proves *which material* was measured, not that the token and cost
figures were produced honestly; those still come from real usage records.

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
`no_go` (`not_measured`, `cost_unknown`; a measured report would also need provenance). Consequently automatic keep-alive is **unavailable** until a
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

## Settings → Usage layout and MCP parity

The tab is split into sub-views: **Overview** (KPIs, token buckets, coverage,
chart, breakdown table), **Analysis** (executed choices, signals, cache
freshness, keep-alive, top consumers, limit burn, workflow rounds),
**Billing**, **Limits** (plan limits, auto-resume after a limit reset),
**Delegations** (model × role outcomes) and **Settings** (retention, alerts,
budgets, resume advice). Each sub-view fetches only its own endpoints; the
last one used is remembered per browser (`cretli-usage-view`). Overview and
Analysis share the range/metric/grouping bar and the collapsible
"More filters".

Everything the tab shows or edits is reachable from a chat through the builtin
MCP, with the same builders and normalizers as REST:

| Sub-view | MCP |
|---|---|
| Overview | `usage_summary` (same filters: range/from/to, tz, role, harness, origin, scope, subject, workspace, chat) |
| Analysis | `usage_top`, `usage_explain`, `usage_limit_burn`, `usage_advice`, `cache_freshness`, `keepalive_status` |
| Billing | `billing_list`, `billing_show`, `billing_forecast`, `billing_create`, `billing_update` |
| Limits | `usage_plan_limits`; auto-resume settings via `usage_settings` / `usage_settings_set` (`limit_resume`), `usage_resume_stop` |
| Delegations | `model_pick` observed blocks, `delegation_list` |
| Settings | `usage_settings` (read), `usage_settings_set` (`usage` patch) |

`usage_settings_set` and `usage_resume_stop` are mutating (Agent mode only)
and, like the billing tools, refused to delegation children. A cold Codex plan
read waits at most 3 s on `GET /api/usage/plan-limits` / `usage_plan_limits`
(`codex.reason = "pending"`); the read keeps running and fills its cache.

## Top consumers (`usage_top`, `usage_explain`)

Cache reads are 95-99% of raw tokens, so rankings use **fresh** tokens: input
without cache + cache write + output + reasoning. Cache-read volume, cache
share, limit hits (run events with `outcome=limit`), attempts and fresh tokens
per attempt are reported next to it.

| Surface | Entry point |
| --- | --- |
| HTTP | `GET /api/usage/top?groupBy=&metric=&limit=` and `GET /api/usage/explain?subjectType=&subjectId=` |
| MCP | `usage_top` (`group_by`: chat, delegation, leaf, model, harness, role, cycle, day) and `usage_explain` (`subject_type`: chat, delegation, leaf, cycle) |
| UI | Settings → Usage → "Top consumers" |

All three share `lib/usage/usage-top-read.ts` (I/O) and `lib/usage/usage-top.ts`
(pure aggregation). The `leaf` axis uses the same delegation join as the
workflow breakdown; events that cannot be joined land in `(unattributed)`.

Extras on the same surfaces:

- `usage_top` with `group_by=chat` flags rows `heavy_context` when the mean
  prompt volume per event is at least 3x the median of chats on the same
  harness (and the chat has >= 5 events and >= 1M fresh tokens): a restart or
  compaction candidate. Raw context sizes are not comparable across harnesses.
- `usage_limit_burn` (`GET /api/usage/limit-burn`, UI "Where limits burn")
  lists, for each usage-limit hit, the same-harness chats that consumed fresh
  tokens in the look-back (default 5 h, max 72 h). Hits of one harness/model
  within 10 minutes count as one. A chat blamed for several hits appears with
  the sum over those windows (`hitsBlamed` tells how many).
- On the `leaf` axis, usage without a delegation lands in `(not delegated)`
  (plain chats and watcher orchestrator chats); `(delegation not joined)` is a
  delegation whose attempt is missing from its record.
- `usage_advice` (`GET /api/usage/advice`) turns the above into rule-based
  findings with evidence: `uncached_model` (>= 20M fresh, >= 50 events, cache
  share <= 10%), `costly_leaf` (>= 5 attempts and >= 1M fresh per attempt),
  `heavy_context_chat` and `limit_hotspot` (blamed for >= 2 limit hits). The
  codebuddy models report `cached_tokens: 0`, so their cost cannot be cut by
  caching; shrink the prompts or route those roles elsewhere.
- `usage_top` with `group_by=resume` splits delegated usage into
  `harness|role|resumed` and `harness|role|fresh` using each delegation's
  `sessionResume.reasonCode`; rows carry `delegations` and
  `freshPerDelegation`. `usage_advice` raises `resume_hurts` when resumed
  delegations (>= 10 each side) cost >= 1.25x more fresh tokens per delegation
  than new-session ones for the same harness and role. The comparison uses the
  `weighted` index (fresh tokens + cache reads at 10%), so a harness that caches
  well is not blamed for a larger cached prefix, counts only delegations with a
  measured usage event, and is skipped when fewer than half of the seen
  delegations are measured. `low_measurement_coverage` flags those harness/role
  pairs instead (>= 20 delegations seen, < 50% measured).

## Codex fallback usage

The Codex SDK reports tokens only in `turn.completed`. A run stopped earlier
(the delegation child run is cancelled 2.5 s after the final `delegation_reply`,
plan-guard cancels, usage-limit errors) used to end with no usage at all. The
rollout watcher's per-call `context_usage` events (one idempotent
`measurementId` per API call) are now collected per run
(`noteHarnessCallUsage`); when the run finishes without any SDK usage report,
`recordHarnessFallbackUsage` records their sum as one partial delta (covered
requests, no final-usage proof). A run that did get `turn.completed` is never
touched, so nothing is counted twice, and calls observed before the run started
(a resumed session's replay) are ignored.

## First output time (`ttftMs`)

`ttftMs` on a `run` event is the time from the run start (`_runStartedAt`,
stamped by `beginHarnessRun`) to the first stream event that counts as output.
The definition lives in `lib/usage/harness-usage.ts`
(`FIRST_OUTPUT_EVENT_TYPES`, stamped once per run in the event hook, consumed in
`buildHarnessRunUsage`):

- **Counts as first output:** `assistant` messages, `thinking`, `text` deltas and
  `tool_call` events. A tool call with no preceding text is a valid first output.
- **Does not count:** `status`, `usage`, notices and other bookkeeping events.
- `ttftMs` is omitted (not `0`) when the run has no start stamp or no counting
  event was seen, for example a run that was cancelled or failed before the
  first event. Consumers must treat a missing value as "unknown".
- Before commit `8d7eb970` (2026-10-23) only `assistant` and `thinking` events
  stamped it, so runs that opened with text deltas or a tool call lost the
  value (about 12% of `claude` runs and some `zai` runs, per the commit message;
  that figure was measured by the fix author, not re-measured here).

## Qwen and Cursor SDK usage reporting

Both harnesses report usage through their own adapter, and both can legitimately
report nothing. The audit cards are
[`docs/usage-audits/qwen.md`](./usage-audits/qwen.md) (audit date 2026-10-22) and
[`docs/usage-audits/cursor-sdk.md`](./usage-audits/cursor-sdk.md).

**Qwen** (`harnesses/qwen/qwen-event-normalizer.js`, `qwen-agent-ws.js`):

- Each `assistant` stream record with a positive count in `input_tokens`,
  `output_tokens`, `cache_read_input_tokens` or `cache_creation_input_tokens`
  becomes one usage delta (granularity: API call).
- `result.usage` is used only when no assistant record carried usage, so a tool
  loop is not double counted.
- `fromQwenUsage` (`lib/usage/usage-normalize.js`) subtracts cache from
  `input_tokens`; Qwen never reports reasoning tokens.
- When a run produced output but no provider usage was seen,
  `buildHarnessRunUsage` sets `usageMissingReason`: `provider_reported_no_usage`
  for an `ok` run, `<outcome>_before_usage` otherwise. A missing measurement is
  therefore explicit, never silently `complete`.
- Whether the upstream provider includes cache in `input_tokens` is not
  confirmed against live traffic (audit 2026-10-22).

**Cursor SDK** (harness id `sdk`, `lib/sdk/cursor-agent-sdk-ws.ts`):

- The primary path is the streamed usage message of the SDK run.
- Fallback (commit `cf2fff5b`, 2026-10-23): when a finished run emitted no stream
  usage, `recordSdkRunUsageFallback` records the cumulative `Run.usage` through
  the normal snapshot path, tagged `usageSource: 'run.usage'`, so the delta,
  baseline and `delegationId` handling are shared.
- When the provider exposes no usage either, the room is marked
  `provider_reported_no_usage` and the run event carries the same
  `usageMissingReason` as Qwen. Cretli cannot obtain tokens the SDK does not
  report; it never estimates them.

## OpenCode coverage

OpenCode usage is read from the `message.updated` / `session.next.step.ended`
SSE events by `harnesses/opencode/opencode-usage.js` and written by
`harnesses/opencode/opencode-agent-ws.js`; the audit card is
[`docs/usage-audits/opencode.md`](./usage-audits/opencode.md). Coverage here
means: a finished delegation counts as measured when the ledger holds a
non-`run` usage event with its `delegationId` (`low_measurement_coverage`
applies the same join, see above).

Measurements (method as stated, date of each measurement given):

| Date | Window | Result | Source |
| --- | --- | --- | --- |
| 2026-10-21 | delegations started on or after 2026-10-20T11:45:28Z | `opencode` implement 0/5 measured, review 1/3 measured; every unmeasured run ended cancelled or failed. Small sample. | todo `3abf408a` |
| 2026-10-22 | last 30 days | review: 91 seen, 37 with no output, 37 measured; implement: 36 seen, 29 with no output, 3 measured. No `low_measurement_coverage` flag for `opencode`. About 20 delegations from 2026-09-30..2026-10-03 had output but no usage; none since. | todo `3fe63009` recompute |

Not measured as of 2026-10-23: the share of delegations that produced output
and have usage, on a sample of at least 15 such delegations after 2026-10-20.
The sample is too small and the follow-up todo `3abf408a` is deferred, so no
coverage percentage is claimed. The open question is whether the gap is a
missing `delegationId` on child-chat usage or a run ending before any usage
event; no per-call fallback exists for OpenCode (unlike the Codex fallback
above).
