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

## 7. Tests

- `tests/usage-*.test.js` — contract, ledger, persistence, window, insights,
  routes, retention, alerts, privacy.
- `tests/usage-settings.test.js`, `tests/usage-settings-routes.test.js` —
  retention/alerts settings normalization and the settings API.
- `tests/usage-privacy.test.js` — no conversation content or paths, client
  `usd` rejected.
- Per-harness telemetry: `tests/*-usage-telemetry.test.js` and
  `tests/usage-harness-hook.test.js`.

Run them with `node --test tests/usage-*.test.js` or the full unit runner
(`npm test`).
