# Claude Agent SDK: limits and context data contract (inventory)

Blocked-leaf deliverable for TODO `4cca44fb` ("Claude limits: kontrakt SDK i
inwentaryzacja"). This document records **what the supported SDK actually
carries**, in which **unit**, over which **scope**, and what stays **unknown**.
It changes no behaviour: no unconfirmed API is implemented here, and the private
OAuth usage endpoint stays out of scope (see §8).

Every claim is tagged with exactly one of the following labels. A claim without a
label, or whose label is stronger than its evidence, is a defect.

| Tag | Meaning |
| --- | --- |
| `[DECLARED]` | Only the **type or shape** of a field as written in an SDK declaration under `optional-packages/claude-agent-sdk` (cite `file:line`; `sdk.d.ts` = `optional-packages/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). A declared type does not establish semantics or units. |
| `[OBSERVED]` | A value reproduced by a command **run in this leaf** (round 3, 2026-10-12), recorded with the command (§9). Values quoted from earlier notes, or from transcripts / `data/` files that were not re-read, are **not** observed. |
| `[INFERRED]` | A conclusion from indirect evidence (binary strings, naming, value ranges). The basis is stated next to it. |
| `[UNVERIFIED]` | A claim kept from an earlier note and not re-checked end to end in this leaf. Do not build on it. |
| `[UNKNOWN]` | Not established. No value and no semantics are asserted. |

Notes: Anthropic's published documentation was **not fetched** in this leaf, so no
statement here depends on it; anything that would is `[UNKNOWN]`. Cretli code is
cited by `file:line` and carries no label of its own.

## 1. Supported version

- `[OBSERVED]` (`cat optional-packages/claude-agent-sdk/package.json`) it pins
  `@anthropic-ai/claude-agent-sdk` **`0.3.284`** (exact, no caret) plus
  `@anthropic-ai/sdk ^0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`,
  in an isolated tree so the zod 4 peer never reaches the root install.
- `[OBSERVED]` (`grep -n '"version"\|"claudeCodeVersion"'` on the SDK `package.json`)
  the installed SDK is `0.3.284` and declares `"claudeCodeVersion": "2.1.284"`.
  `stat`/`md5sum` of `.../claude-agent-sdk-linux-x64/claude`: 243 059 896 bytes, md5
  `16a758ebef6694e279a10ff618ace012`. A second binary
  (`...-linux-x64-musl/claude`, 236 810 328 bytes) is also installed.
- `[UNVERIFIED]` CLI session transcripts written by that binary stamp
  `"version": "2.1.284"` (earlier note; transcripts not re-read in this leaf).
- `[OBSERVED]` (`grep -c 'unifiedWindows\|rate_limit_info\|utilization\|quotaLimits'`
  over `sdk.mjs`, `core.mjs`, `bridge.mjs` → `0`, `0`, `0`) the SDK JS layer carries
  none of those names. `[INFERRED]` from that count plus §3 that the limits values
  are produced by the CLI binary and the JS layer only relays them; `sdk.d.ts` is the
  published type surface.

## 2. The four data planes are not interchangeable

| Plane | Carries | Scope | Cretli today |
| --- | --- | --- | --- |
| `rate_limit_event` → `SDKRateLimitInfo` | plan-meter `utilization` (unit `[UNKNOWN]`, §3), status, one window type, reset | declared "for claude.ai subscription users" (`sdk.d.ts:5572`); account/plan scope `[INFERRED]` from that wording, not a session | normalized to a `rate_limit` notice, stored as a plan-limit snapshot |
| `result.usage` (`NonNullableUsage`) | token counts of the **main agent loop** | per-turn in streaming-input sessions, excludes subagents | stored as run telemetry; the Claude meter does not read it (§6), the non-Claude `usage` branch still does |
| `result.modelUsage` / `total_cost_usd` | per-model totals + cost | **cumulative for the whole `query()`**, includes Task subagents and internal compaction calls | stored as `modelUsage` on the usage event |
| `getContextUsage()` / `context_usage` | current context window occupancy (`[INFERRED]` from field names, §5) | one model, one moment `[INFERRED]` | never called: `[OBSERVED]` (`rg getContextUsage lib app_front server.js` → no hits) |

`[UNVERIFIED]` (fixture `tests/fixtures/claude/observed-run-usage-event.json`, copied
from an archived chat event not re-read in this leaf) the two token planes differ
from context occupancy: the run's aggregated
`usage.inputTokens` is **668 113** while the limiting model's
`modelUsage[...].contextWindow` is **1 000 000** and the helper model's is
**200 000**. 668 113 is a sum of per-call inputs across a turn — the shared prompt
prefix is counted once per API call — so it is a lower bound on nothing and an
upper bound on nothing. Dividing it by a context window yields a number with no
referent (§6).

`[UNKNOWN]` What Anthropic's published cost-tracking page says: it was **not
fetched**. `[OBSERVED]` (`sed -n 5618,5626p sdk.d.ts`) the field JSDoc on
`SDKResultError` reads: `usage` "MAIN AGENT LOOP ONLY — excludes Task subagent,
sidechain, and auxiliary model calls, and is per-turn in streaming-input sessions";
`modelUsage` "Per-model totals for every model call made through the query pipeline
… Cumulative across turns in streaming-input sessions … read the latest result
rather than summing"; `total_cost_usd` "An estimate, not a billing statement" and "a
mid-session /clear resets the running total". `[DECLARED]` `contextWindow: number`
and `maxOutputTokens: number` on `ModelUsage` (`sdk.d.ts:1436-1437`); their
semantics are `[UNKNOWN]` (no JSDoc read for them in this leaf).

## 3. `rate_limit_event` — declared shape; unit and emission not confirmed

`[DECLARED]` `SDKRateLimitEvent = { type: 'rate_limit_event', rate_limit_info:
SDKRateLimitInfo, uuid, session_id }` (`sdk.d.ts:5570-5577`). `[OBSERVED]` its JSDoc
reads "Rate limit event emitted when rate limit info changes" and "Rate limit
information for claude.ai subscription users" (`sed -n 5566,5582p sdk.d.ts`).

`[DECLARED]` `SDKRateLimitInfo` (`sdk.d.ts:5583-5606`): `status: 'allowed' |
'allowed_warning' | 'rejected'`; `resetsAt?: number`; `rateLimitType?: 'five_hour' |
'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' |
'overage'`; `utilization?: number`; `overageStatus?`, `overageResetsAt?`,
`overageDisabledReason?`, `isUsingOverage?`, `overageInUse?`, `surpassedThreshold?`,
`limitScope?: 'service' | 'channel' | 'group_pool'`, `errorCode?: 'credits_required'`,
`canUserPurchaseCredits?`, `hasChargeableSavedPaymentMethod?`.

**The published type gives no unit for `utilization`** (`utilization?: number`,
`sdk.d.ts:5587`, no JSDoc). The unit is therefore `[UNKNOWN]` at the declaration
level. The only further evidence is an inference from the producer's schema text:

- `[OBSERVED]` (`grep -aboE 'utilization is the fraction of the window used' <linux-x64/claude>`
  → offsets 101186891 and 199638436; `dd skip=199637600 count=1300 | tr -d '\000'`)
  the binary contains a zod schema `utilization:k().optional()` (a number, no unit)
  followed by `unifiedWindows:u({five_hour:u({utilization:k(),resetsAt:k().int()})…})`
  whose `.describe("@internal …")` text reads: "utilization is the fraction of the
  window used (usually 0-1, same scale as the top-level utilization field; values
  above 1 occur when usage legitimately runs past a window's cap …); resetsAt is unix
  epoch seconds."
- `[INFERRED]` Basis: that description text, which names the top-level field as
  having the "same scale". Conclusion: `SDKRateLimitInfo.utilization` is **plausibly**
  a 0–1 fraction that may exceed 1 and `resetsAt` plausibly epoch seconds. This is
  a string in a minified binary, not a runtime reading; no raw `rate_limit_event`
  payload was ever captured, so the unit is **not confirmed**. `[UNKNOWN]` is the
  correct status for any consumer that needs a guarantee.
- Existing, unconfirmed assumption already in Cretli code: `× 100` at
  `lib/agent-harness/claude-event-normalizer.ts:183` and, for raw payloads,
  `lib/usage/harness-usage.ts:659` (`resolveHarnessPlanLimitSnapshot`). Both presume
  the fraction hypothesis above; neither is supported by a captured payload.
- `[UNVERIFIED]` Store corroboration (earlier note; `data/` not re-read in this
  leaf): `data/usage/plan-limits.jsonl` held 2 644 rows on 2026-10-12, 455 Claude
  readings with a utilization, all integers 25…99 **after** Cretli's `× 100`. If
  true this is consistent with the fraction hypothesis, but the values are
  post-conversion, so it cannot confirm the raw unit. The binary text "when a
  window's rounded percentage o…" is `[OBSERVED]` (same `dd` output, cut at 1300
  bytes) and `[INFERRED]` to explain integer steps.
- `[UNVERIFIED]` Emission: 2 602 Claude rows in that store (earlier note) and 0 raw
  `"type":"rate_limit_event"` matches over CLI session transcripts (earlier grep,
  not re-run). Durable evidence in fixtures is post-normalization only; no raw
  payload exists.
- `[OBSERVED]` (`grep -ac` on the linux-x64 binary) the strings
  `Dropping rate_limit_event with invalid rate_limit_info` (4 lines) and
  `rate_limit_event forward failed` (2 lines) exist. `[INFERRED]` that the CLI
  validates and may drop malformed events, so absence of an event does not mean "no
  limit". `[UNKNOWN]` which branch fires at runtime.

### 3.1 Field-by-field canonical map

Canonical vocabulary is the existing one in `lib/usage/usage-contract.js`
(`USAGE_PROVENANCE`, `USAGE_MEASUREMENT_KINDS`, `USAGE_GRANULARITIES`,
`USAGE_COMPLETENESS`, `USAGE_ACCOUNTING_SCOPES`) — no new enum is invented here.

| SDK field | canonical field | unit / domain | scope | null & partial semantics | status |
| --- | --- | --- | --- | --- | --- |
| `status` | `status` | closed enum `allowed`, `allowed_warning`, `rejected` | account/plan window | absent ⇒ no verdict; must not default to `allowed` | `[DECLARED]` (`sdk.d.ts:5584`); `[UNVERIFIED]` all three values seen in the store |
| `utilization` | `utilization` | Cretli stores percent 0–100 (`harness-usage.js:659` assumes ×100); SDK raw unit `[UNKNOWN]` (fraction is an `[INFERRED]` hypothesis, §3) | the window named by `rateLimitType` | absent/`''`/non-finite ⇒ **unknown**, never `0`. Values outside `[0,1]` on the raw SDK field ⇒ treat unit as unknown; never silently scale | `[DECLARED]` `number` only (`sdk.d.ts:5587`); unit `[UNKNOWN]`; fraction `[INFERRED]` |
| `rateLimitType` | `windowType` | one enum member per event | that window only | absent ⇒ the reading is not attributable to a window. `[UNVERIFIED]` store breakdown (fixture matrix): 24 rejected rows have no window type; all 2 578 typed rows are `five_hour` (2 253) or `seven_day` (325). An earlier figure of 20 was wrong; 24 is the fixture figure and the matrix sums to 2 602 | `[DECLARED]` six-member enum (`sdk.d.ts:5586`); `[UNVERIFIED]` only `five_hour`, `seven_day` seen |
| `resetsAt` | `resetsAt` | `[DECLARED]` `number` (`sdk.d.ts:5585`); `[INFERRED]` epoch seconds (binary strings `resetsAt:k().int()` and "unix epoch seconds" on the sibling block); stored by Cretli as ISO | the named window | absent ⇒ reset unknown. Cretli accepts seconds **or** ms via a `< 1e12` heuristic, so a future ms payload would silently reinterpret | `[INFERRED]` seconds (same basis; no raw payload captured) |
| `overageStatus` / `overageResetsAt` / `overageDisabledReason` / `isUsingOverage` / `overageInUse` / `surpassedThreshold` | — | same status enum / epoch seconds / enum / boolean / boolean / number | overage lane, a **different** meter from the plan window | not mapped by Cretli: `buildClaudeRateLimitNotice` forwards only `overageStatus` and `isUsingOverage`, and `noteHarnessPlanLimit` persists neither | `[DECLARED]` types only (`sdk.d.ts:5588-5594`); Cretli state `[UNKNOWN]` |
| `limitScope` (`service`\|`channel`\|`group_pool`) | would be `scope` | enum | whose budget blocked | absent on a plain member denial **and from older CLIs** ⇒ absence is not "member cap" | `[DECLARED]` (`limitScope?`, `sdk.d.ts` in `SDKRateLimitInfo`); never seen in the store `[UNVERIFIED]` |
| `errorCode`, `canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod` | — | string / boolean / boolean | billing | unmapped | `[DECLARED]` |
| `uuid`, `session_id` | identity | — | event identity | `[UNKNOWN]` idempotency: no dedupe key is known, so a replayed event may re-write the snapshot | `[DECLARED]` (`sdk.d.ts:5575-5576`) |
| — | `metric` | which meter a row belongs to | — | `[UNVERIFIED]` Cretli has no `metric`/`source` column on plan-limit rows | `[UNKNOWN]` |
| — | `observedAt` | ISO | — | `[UNVERIFIED]` `noteHarnessPlanLimit` (`lib/usage/harness-health.ts`) stamps receive time; `[DECLARED]` field list (`sdk.d.ts:5583-5606`) has no provider sample time | receive-time only |
| — | `authScope` | `subscription` \| `api-key` \| provider | account | `[UNVERIFIED]` never stored on a plan-limit row; `[UNKNOWN]` whether rows from different auth scopes are distinguishable | `[UNKNOWN]` |

### 3.2 The `unifiedWindows` trap

`[OBSERVED]` (same `dd` command as §3; `grep -ac unifiedWindows` → 5 lines in the
linux-x64 binary) the producer schema also carries `unifiedWindows.five_hour /
seven_day / seven_day_overage_included`, each `{ utilization: number, resetsAt: int }`,
described `@internal` as read from `anthropic-ratelimit-unified-*` response headers.
`[UNVERIFIED]` the remaining description phrases quoted in earlier notes ("tracked on
every observation", "absent until the first response …", "always absent for API-key,
Bedrock, and Vertex sessions") were cut off by the 1300-byte excerpt and not re-read.

`[INFERRED]` this is the only producer field that would answer the parent TODO's
"session and week in one reading" wish. `[OBSERVED]` it is **not** in `sdk.d.ts`
(`grep -c unifiedWindows sdk.d.ts` → `0`). `[UNVERIFIED]` it never appears in any
Cretli-persisted payload (0 transcript matches, earlier grep). Consuming it would be an unconfirmed private
API. Recorded as a constraint, not implemented.

## 4. Compact boundary

`[DECLARED]` `SDKCompactBoundaryMessage = { type:'system',
subtype:'compact_boundary', compact_metadata: { trigger:'manual'|'auto',
pre_tokens:number, post_tokens?:number, duration_ms?:number, preserved_segment?,
preserved_messages? }, uuid, session_id }`.

`[UNVERIFIED]` (earlier note; the transcript was not re-read) the CLI session-file
representation is a **different serialization**: camelCase `compactMetadata` with
`preTokens`, `postTokens`, `durationMs`, `cumulativeDroppedTokens` and
`preCompactDiscoveredTools`, plus envelope fields. `[UNVERIFIED]` a prior count
reported 18 transcript frames with `compactMetadata` and 0 with `"compact_metadata"`.
`[OBSERVED]` (`grep -ac` on the linux-x64 binary) the strings `compactMetadata` (28
lines), `compact_metadata` (6) and `cumulativeDroppedTokens` (4) exist in the
binary; `[INFERRED]` that the producer knows both spellings. `[OBSERVED]`
(`grep -c cumulativeDroppedTokens sdk.d.ts` → `0`) the published type does not
declare `cumulativeDroppedTokens`. Fixture:
`tests/fixtures/claude/observed-compact-boundary.json` (content from an earlier read).

Semantics worth pinning before leaf `a0003cfd`:
- `[DECLARED]` `pre_tokens: number`, `post_tokens?: number` (`sdk.d.ts:3729-3730`).
  `[INFERRED]` from names that they are pre/post compaction token counts; semantics
  not otherwise established. `[UNVERIFIED]` Cretli's `buildClaudeCompactNotice` keeps
  them only when truthy, so a legitimate zero and an absent field collapse.
- `cumulativeDroppedTokens`: semantics `[UNKNOWN]` (undeclared). `[UNVERIFIED]` only
  that in the two fixture frames (earlier read, not re-read) it equals
  `preTokens - postTokens`.
- A boundary marks a context epoch change; Cretli advances the epoch at
  `lib/claude/claude-agent-ws.ts:999` (`advanceRoomContextEpoch(room,
  'compact_boundary')`, line re-read this leaf). `post_tokens` values (49 902 /
  11 590 in the fixture, source `[UNVERIFIED]`) are token counts and the event
  declares no denominator (`[DECLARED]`, `sdk.d.ts:3724-3745`).

## 5. Where a current context percentage could come from

1. `[DECLARED]` `query.getContextUsage(opts?: { detail?: 'summary' | 'full' }):
   Promise<SDKControlGetContextUsageResponse>` (`sdk.d.ts:3022-3024`), whose type
   (`sdk.d.ts:3933`) declares `totalTokens: number` (`:3944`), `maxTokens: number`,
   `rawMaxTokens: number`, `percentage: number` (`:3947`), `model: string`,
   `autoCompactThreshold?: number` (`:4001`), `categories[].kind: 'used' | 'free' |
   'buffer' | 'deferred'` and `apiUsage: {input_tokens, output_tokens,
   cache_creation_input_tokens, cache_read_input_tokens} | null` (`:4021`).
   `[UNKNOWN]` the semantics of `totalTokens`, `maxTokens`, `rawMaxTokens`,
   `percentage` and `apiUsage`: `[OBSERVED]` (`sed -n 3933,3960p sdk.d.ts`) these
   fields carry **no JSDoc** in 0.3.284, and no upstream page was fetched. Earlier
   notes quoted descriptions for them ("totalTokens as a rounded percentage of
   maxTokens", "latest API response, not running total"); those phrases have 0 hits
   in the SDK and are withdrawn. `[INFERRED]` from field names only that
   `totalTokens` / `maxTokens` are a numerator / denominator and `percentage` a
   ratio of them. `[OBSERVED]` the JSDoc on `categories[].kind` (`sdk.d.ts:3939-3941`)
   says "Classify on this, never on the English name". `[OBSERVED]` the
   `getContextUsage` JSDoc says "`detail: 'full'` counts each category with the
   token-count API; `'summary'` answers from the last response's usage and local
   estimates … Defaults to `'full'`" (`sed -n 3015,3022p sdk.d.ts`). `[OBSERVED]`
   Cretli never calls it (`rg getContextUsage lib app_front server.js` → no hits).
   `[UNKNOWN]` the minimum SDK / CLI version for `categories[].kind`
   (`grep -c 0.3.268 sdk.d.ts` → `0`). `[INFERRED]` it is a pull request: the
   declaration is a method returning a Promise and no event type carries it.
2. `[DECLARED]` `SDKAssistantMessage.context_usage?: SDKContextUsage`
   (`sdk.d.ts:3652`, type at `:3763`) with `total_tokens: number` (`:3771`),
   `raw_max_tokens: number` (`:3775`), `percentage: number` (`:3778`),
   `over_limit?: { kind: 'hard_limit' | 'compaction_window' }` (`:3783-3785`).
   `[OBSERVED]` (`sed -n 3763,3790p sdk.d.ts`) JSDoc: `total_tokens` "Estimated
   tokens in use, unclamped — may exceed raw_max_tokens when over limit";
   `percentage` "Rounded total_tokens / raw_max_tokens, 0-100+". Which turns carry it
   is `[UNKNOWN]` (not read in this leaf). Never seen in Cretli data: `[UNVERIFIED]`.
3. `[DECLARED]` `ModelUsage.contextWindow: number` (`sdk.d.ts:1436`), carried per
   model in `result.modelUsage`. `[OBSERVED]` in stored runs: 1 000 000 for
   `claude-opus-5-5` and `claude-sonnet-5-5`, 200 000 for `claude-haiku-5-5`,
   `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`. `[OBSERVED]` in session
   transcripts: the 200 000 models auto-compact at a prompt of about 152 000–168 000
   tokens, while Opus 5.5 and Sonnet 5.5 sessions reach 418 000 and 548 000 tokens
   with no compact boundary. The reported value therefore matches the window the
   CLI really runs on, and it is the meter's denominator (§6).
4. `[DECLARED]` compact `pre_tokens` (§4) — `[INFERRED]` one sample, at compaction
   time only.

`[INFERRED]` No event type among §5.1–5.4 is confirmed to carry per-turn occupancy, and
a full search of `sdk.d.ts` for other carriers was not run. Interim source (§6): the
per-call `message.usage` of main-thread assistant messages, whose occupancy meaning is
`[INFERRED]`. An always-on source-rooted value would still have to pull
(`getContextUsage`, §5.1) or stay an estimate.

## 6. What Cretli currently shows as "context %" for Claude (interim)

Code reading in this leaf; line numbers are for the tree this leaf was written against.

- **Numerator.** The newest main-thread API call's `message.usage`, summed as `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` (`resolveClaudeAssistantMessageUsage`, `lib/agent-harness/claude-event-normalizer.ts`). Calls with `parent_tool_use_id` (sub-agents) are excluded. The run-level `usage` total is a sum over calls and is not read for the meter. One call is reported several times and `noteCallUsage` merges them by `message.id`: the stream `message_start` gives the prompt size as soon as the call begins, every per-block `assistant` message repeats that start usage (its `output_tokens` is the count at stream start, a handful of tokens), and the stream `message_delta` gives the final `output_tokens`. The largest output seen for a call wins. `[OBSERVED]` on one session: each call's prompt equals the previous call's prompt plus its final output plus the tool results in between.
- **Denominator.** The window the SDK reports for the concrete `message.model` of that call: `result.modelUsage[model].contextWindow` (§5.3). It reaches the front as `lastCallContextWindowTokens` on the run's `usage` event, as `contextWindowTokens` on `sdkContextUsage` once any run of the server process has reported that model (`noteClaudeReportedContextWindows`, `lib/claude/claude-models.ts`), and as `lastCallContextWindowTokens` in the history summary, which also reads `modelUsage` of runs stored before the field existed. It is kept per chat (`_contextMeasuredWindowTokens`) and dropped when the call's model changes. Until a window is reported, `getModelContextWindowTokens(modelId)` is the fallback: 1 000 000 for `claude-opus-5*` / `claude-sonnet-5*`, 200 000 for the other Claude prefixes. Alias ids (`default`, `opus`, `sonnet`, `haiku`) have no fallback window, so tokens are shown without a percentage.
- **Delivery.** Three paths write `_contextMeasuredTokens` and `_contextUsageModelId` (`app_front/features/chat/chatContextMeter.js:71`, `:88`):
  1. Live: normalizer item `context_usage` (`claude-event-normalizer.js:635`) → `sdkContextUsage` broadcast (`lib/claude/claude-agent-ws.ts:1104–1105`, `{ log: false }`, not persisted or replayed) → `chatTransport.js:1492`.
  2. Reconnect: the run's `usage` event carries `lastCallUsage` / `lastCallModel` → `chatTransport.js:1523`.
  3. Reload: `summarizeChatHistoryUsage` (`lib/persist/chat-history-persist.js:72`) → `lastCallContextTokens` / `lastCallModel` in `contextStats.history` of `GET /api/chats/:id/diag` → one-shot `applyClaudeHistoryContextUsage`, requested from `startChatContextUsageSync` (`chatDiagnostics.js:182`). It is skipped once a live value exists or a reset has happened on the page.
- **Resets.** A compact boundary (`system/compact_boundary`) clears the server's last-call record (`claude-event-normalizer.js:570`). On the front, a model change (`chatTransport.js:473`) and a compact or session-reset run notice (`chatTransport.js:1703`) call `resetChatContextMeterState`.
- **Display.** Percent = measured tokens / window, rounded to 0.1 with a 0.1 floor for any positive value (`estimateContextFillPercent`, `lib/sdk/sdk-context-advisory.ts`). The ring centre (`cr-sdk-mode-bar.js`) shows `—` for no data, `<1` below 1 %, and `99+` when the rounded value exceeds 99 (`formatContextRingCenterLabel`). Provenance: `claude-measured` is labelled "Measured context"; without a measurement but with a local transcript it is `claude-estimated` (text estimate, labelled as one); otherwise `claude-no-data`.

Limitations (recorded, not fixed):
- After a compact boundary there is no occupancy value until the next main-thread call.
- Tool results appended after the last call are not counted until the next call starts (its `message_start` includes them), so the value reads low by that amount while tools run.
- The percentage is of the model window, not of the auto-compact threshold. `[OBSERVED]` the CLI compacts 200 000-window models at roughly 76–84 % of the window, so compaction arrives before the meter reaches 100 %.
- An account whose Opus 5.5 / Sonnet 5.5 runs on a 200 000 window is divided by the 1 000 000 fallback until its first run reports the real window.
- A run with no main-thread call records no last-call value. After a reload the meter shows no data until the next call; the live meter keeps its previous value.
- If a compaction is followed by a run that ends without a usage event, a reload can show the value from before the compaction, because the compact notice is not persisted.
- A history value hydrated after a model change made while the page was closed may be divided by the old model's window.
- The per-call semantics above are `[INFERRED]`, not checked against the CLI's own accounting.

Open (not fixed):
- `sdk` transport (Cursor SDK): the non-Claude branch of the `usage` handler (`chatTransport.js:1525–1534`) still stores run-level `usage.inputTokens` as the context input with provenance `sdk-live`. That is the mixed-plane problem (a run sum over a static window). It is outside the Claude meter.
- Diagnostics: `chatDiagnostics.js:530` computes `contextFill` from run-level `room.lastUsageInputTokens`, and that line also applies to Claude chats.

The source-rooted percentage (`getContextUsage()`) remains leaf `a0003cfd` (§10.1). Cretli does not read the SDK's `context_usage` field; the normalizer's `context_usage` item is Cretli's internal kind for the per-call value above.

## 6b. Utilization conversion sites (inventory only)

Cretli stores plan-limit percent **0–100**. The two existing `× 100` sites
(re-read this leaf) both rest on the **unconfirmed** assumption that the SDK value is
a fraction (§3): `lib/agent-harness/claude-event-normalizer.ts:183`
(`notice.utilization = Number(info.utilization) * 100`, with the code comment "SDK
utilization is a fraction") and `lib/usage/harness-usage.ts:659`
(`resolveHarnessPlanLimitSnapshot`, multiplier `id === 'claude' && info ? 100 : 1`).
The latter applies only to a raw `rate_limit_info`, the former to the notice; whether
exactly one runs per event depends on the room kernel path (`room-kernel.js:426-432`
calls the snapshot resolver) and was not traced end to end: `[UNVERIFIED]`.

`[UNVERIFIED]` Line numbers in the table below were carried from an earlier note;
only the first two rows were re-read.

| Location | Role |
| --- | --- |
| `lib/agent-harness/claude-event-normalizer.ts:183` | `× 100` on notice build (assumes fraction; unconfirmed) |
| `lib/usage/harness-usage.ts:659` | `× 100` on raw-event path (same assumption) |
| `lib/claude/claude-agent-ws.ts:760–762` | Forwards **already-percent** notice fields |
| `lib/agent-harness/room-kernel.ts:426–432` | Calls snapshot + `noteHarnessPlanLimit` (no math) |
| `lib/usage/harness-health.ts:101–121` | Persists percent as-is |
| `lib/usage/plan-limit-history.ts:69–78` | Persists percent as-is |
| `lib/harness-usage-limits.js:528–568` | Lockout on `rejected` only; no utilization math |
| `app_front/features/usage/planLimitsView.js:13,23–26` | **Display**: percent `/ 100` → `formatPercent` |
| `app_front/features/harness-health/harnessHealthModel.js:134–137,176` | **Display**: stored percent `/ 100` → 0–1 bar fraction |
| `app_front/features/chat/chatContextMeter.js:137–138` | Context fill via `estimateContextFillPercent` (different metric) |
| `lib/sdk/sdk-context-advisory.ts:219` | **Context estimate**: `(tokens / catalogWindow) * 100` — not plan limit |

## 7. Plan-limit store semantics (unverified; earlier-note rows)

`[UNVERIFIED]` Everything in this section about store contents comes from an
earlier read of `data/usage/plan-limits.jsonl` and `data/harness-plan-limits.json`
(recorded in fixture `observed-plan-limit-readings.json`); `data/` was not re-read
in this leaf:

- `[UNVERIFIED]` Window types present: `five_hour`, `seven_day`, and **absent**. Absent is not
  rare: **24** `rejected` rows with no window type (fixture matrix: `five_hour`
  allowed 2 103, `seven_day` allowed_warning 324, `five_hour` allowed_warning 131,
  no type rejected 24, `five_hour` rejected 19, `seven_day` rejected 1; sum 2 602).
  `[UNVERIFIED]` (rests only on those earlier-note counts) "always session + week" is false.
- `[UNVERIFIED]` `utilization` present **only** with `allowed_warning` (**455** rows: 324
  `seven_day` + 131 `five_hour`). `allowed` (**2 103** `five_hour` rows) and
  `rejected` (**44** Claude rows) carry none.
- `[UNVERIFIED]` The last-snapshot upsert keys on `harness:rateLimitType` and rebuilds the row, so
  a later reading without a percentage **removes the previously known percentage**.
  A prior live read of `harness-plan-limits.json` reported
  `{harness:'claude', rateLimitType:'five_hour', status:'rejected',
  resetsAt:'2026-10-12T12:30:00.000Z'}` with no `utilization` key, while history for
  the same window reached 99 % earlier; the upsert-by-key behaviour was not re-checked.
- `status: 'rejected'` also reaches the store from the **error-text** classifier
  (`lib/harness-usage-limits.js` `noteHarnessUsageLimit`, `source: 'error-text'`,
  which appends a plan-limit row without `rateLimitType`), not only from the
  structured event. The two producers are indistinguishable in the row.
  `[UNVERIFIED]` the lockout row recorded in the fixture is
  `{source:'error-text', code:'usage_limit', message:"You've hit your session
  limit · resets 2:30pm (…)", resetAt:'2026-10-12T12:30:00.000Z'}` — the prose path
  won the race against the structured path (`source:'rate-limit-event'`,
  `code:'rate_limit_five_hour'`), and the two disagree about whether this is a
  *session* limit or a *five_hour* window.
- Non-Claude harnesses write the same rows (`deepseek` 19, `opencode` 9, `codex` 6,
  `codebuddy` 1: all `rejected`, no window type, no utilization). The store is
  shared, so a Claude-specific unit rule must not be applied to other harnesses'
  rows. `lib/usage/harness-usage.ts:659` already encodes this as
  `× (id === 'claude' && info ? 100 : 1)` — a **shape-sensitive** conversion: a raw
  event (has `rate_limit_info`) converts, a normalized notice does not. Exactly one
  conversion holds only while that discriminator holds.
- `[UNKNOWN]` freshness. `[OBSERVED]` (`grep -ac seedSource` → 3 lines in the
  linux-x64 binary) the string `seedSource` exists; the other strings named in
  earlier notes (`fetchedAtMs`, "Showing last-known usage") were not re-checked.
  `[INFERRED]` the CLI may serve a persisted reading. The `[DECLARED]` field list
  (`sdk.d.ts:5583-5606`) has no sample-time or source field, so `[INFERRED]` Cretli
  cannot tell a fresh reading from a replayed one from `SDKRateLimitInfo` alone.
- `[UNKNOWN]` auth scope: no scope field is declared on `SDKRateLimitInfo`
  (`[DECLARED]`, `sdk.d.ts:5583-5606`) and `[UNVERIFIED]` no plan-limit row records
  one. `[OBSERVED]` (`sed -n 3025,3032p sdk.d.ts`) the `/usage` method's JSDoc says
  `rate_limits_available` "is false (and `rate_limits` null) for API key, Bedrock,
  Vertex, and other sessions where plan limits do not apply". `[INFERRED]` that
  without a stored scope, rows from different auth modes are not separable in the
  shared store; whether `rate_limit_event` is emitted for non-subscription sessions
  is `[UNKNOWN]`.

## 8. Declared-but-unused upstream surfaces (do not build on them silently)

| Surface | State | Why it matters |
| --- | --- | --- |
| `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` → `SDKControlGetUsageResponse` (`rate_limits.five_hour/seven_day/seven_day_oauth_apps/seven_day_opus/seven_day_sonnet/model_scoped[]/extra_usage`, each `{ utilization: number\|null "0-100", resets_at: string\|null }`, plus `subscription_type: string\|null`, `rate_limits_available: boolean`, `behaviors` from a **local transcript scan**) | `[DECLARED]` (`sdk.d.ts:3042`, `:4204-4295`), experimental by name; never called by Cretli `[UNVERIFIED]` | second, **percent**-scaled meter vocabulary; the name itself forbids reliance; `behaviors` reads every transcript touched in 7 days |
| `SDKAssistantMessage.usage_report?: SDKUsageReport` (`rate_limits.limits[] { kind, group, percent 0-100, resets_at, scope{model,surface}, severity, is_active }`) | `[DECLARED]` (`sdk.d.ts:3656`, `:6074`); never read by Cretli and never seen `[UNVERIFIED]` | `[INFERRED]` from the declared field names: meter rows with a `kind` discriminator; semantics `[UNKNOWN]`; only on `/usage` results |
| `unifiedWindows` (producer-internal) | `[OBSERVED]` in binary strings (§3.2); `[OBSERVED]` absent from `sdk.d.ts` | see §3.2 |
| `quotaLimits` on an `assistant` error frame (`status`, `rateLimitType`, `resetsAt`, `overageStatus`, `overageDisabledReason`, `isUsingOverage`, `unifiedRateLimitFallbackAvailable`, `upgradePaths`) + `error:'rate_limit'`, `apiErrorStatus:429`, `isApiErrorMessage` | `[UNVERIFIED]` 62 transcript frames (earlier note); `[OBSERVED]` (`grep -c`) 0 occurrences of `quotaLimits` and of `apiErrorStatus` in `sdk.d.ts`; Cretli hit count not re-run | session-file only, not a stream contract; the `overage_*` fields show a rejection can be an *org-level disable*, not a quota exhaustion |
| `POST /api/oauth/usage` (undocumented) | out of scope by instruction; `[UNVERIFIED]` only `/api/oauth/profile` is used, by `lib/claude/claude-plan-login.ts` | `[UNVERIFIED]` the profile yields plan identity fields; not re-checked here and not called |

Unit warning that the leaf exists to prevent: **the same word `utilization` is
described as a fraction for `unifiedWindows` in the CLI binary (`[INFERRED]` to apply
to `rate_limit_event`, §3) and, on `SDKControlGetUsageResponse`, as "Percentage of
the window used, 0-100" (`[OBSERVED]` JSDoc text, `sdk.d.ts:4232` and following).** Any future adapter merge must convert by
surface, not by field name.

## 9. Reproducing the observed evidence

```bash
# run in this leaf (round 3)
P=optional-packages/claude-agent-sdk/node_modules/@anthropic-ai
B=$P/claude-agent-sdk-linux-x64/claude
D=$P/claude-agent-sdk/sdk.d.ts
md5sum $B; stat -c %s $B
grep -aboE 'utilization is the fraction of the window used' $B
dd if=$B bs=1 skip=199637600 count=1300 2>/dev/null | tr -d '\000'
grep -ac 'Dropping rate_limit_event with invalid rate_limit_info' $B   # 4
grep -ac 'rate_limit_event forward failed' $B                          # 2
grep -ac unifiedWindows $B                                             # 5
grep -c unifiedWindows $D; grep -c 0.3.268 $D                          # 0, 0
grep -c cumulativeDroppedTokens $D; grep -c quotaLimits $D             # 0, 0
sed -n 5566,5606p $D; sed -n 3933,3960p $D; sed -n 3763,3790p $D
rg -n getContextUsage lib app_front server.js                          # no hits
# NOT run in this leaf: plan-limit store aggregates and transcript greps (data/ is
# out of bounds); every figure derived from them is [UNVERIFIED].
```

Sanitized fixtures live in `tests/fixtures/claude/`, each with a `_provenance`
block naming its source class and sanitization. Their "observed" content comes from
earlier reads and is `[UNVERIFIED]` here; "synthetic" files assume the unit
hypothesis and therefore cannot establish it. Nothing reads them yet: they are evidence for leaves `57d74653`, `a0003cfd` and `17a0de8d`, not
inputs to code.

| File | Class | What it proves |
| --- | --- | --- |
| `observed-plan-limit-readings.json` | store rows from an earlier read, post-normalization (`[UNVERIFIED]`) | which window types and statuses reached Cretli; a `rejected` reading with no percentage; the prose-classifier lockout for the same rejection. Says nothing about the raw SDK unit |
| `observed-run-usage-event.json` | archived usage event from an earlier read (`[UNVERIFIED]`) | `usage`/`modelUsage` shapes and the mixed-plane ratio the earlier meter produced (§6) |
| `observed-compact-boundary.json` | transcript frame from an earlier read (`[UNVERIFIED]`) | camelCase `compactMetadata` next to a marked synthetic twin of the snake_case envelope |
| `synthetic-rate-limit-event-examples.json` | synthetic contract example | the presence/absence matrix of `rate_limit_event` **assuming** the fraction hypothesis (not evidence of it), plus negative controls and the ruled-out `unifiedWindows` field |
| `synthetic-context-usage-examples.json` | synthetic contract example | the declared shape with numerator-, denominator- and percentage-named fields; their semantics are `[UNKNOWN]` (§5); never observed, never called |


## 10. Decision: what the next leaves may rely on

### 10.1 Verdict per next subtodo

| Subtodo | Verdict | Unknowns it depends on |
| --- | --- | --- |
| `57d74653` (plan-limit window UI / last-known percentage per window) | **May proceed only for the unit-independent part**: render the delivered windows, treat a missing `utilization` as unknown (never 0), keep the last known value per window with its own age. **Must not** add or change any unit conversion. | (a) raw `utilization` unit `[UNKNOWN]` (§3) — blocks any new scaling; (b) `authScope` `[UNKNOWN]` (§3.1, §7) — blocks per-account / per-scope attribution of stored rows; (c) provider sample time `[UNKNOWN]` — ages are Cretli receipt age only. |
| `a0003cfd` (source-rooted Claude context %) | **Blocked** for an SDK-declared percentage. The interim meter (§6) is a measured per-call token count over a catalog window and does not unblock this row. May proceed only as a design/decision step (poll trigger, labelling). | (a) semantics of `totalTokens` / `maxTokens` / `rawMaxTokens` / `percentage` / `apiUsage` `[UNKNOWN]` — no JSDoc, no upstream page fetched (§5.1); (b) which turns carry `context_usage` `[UNKNOWN]` (§5.2); (c) minimum version for `categories[].kind` `[UNKNOWN]`; (d) the interim numerator (per-call `message.usage` as occupancy) is `[INFERRED]` and its denominator is a catalog window, not an SDK value (§6). |
| `17a0de8d` (compact-boundary / context epoch handling) | **May proceed** for reading `compact_metadata.pre_tokens` / `post_tokens` and the existing epoch advance (`lib/claude/claude-agent-ws.ts:999`); **must not** present them as a percentage and **must not** depend on `cumulativeDroppedTokens`. | (a) `cumulativeDroppedTokens` semantics `[UNKNOWN]`; (b) camelCase-vs-snake_case transcript counts are `[UNVERIFIED]`, so a consumer must accept both spellings; (c) whether `post_tokens` is present is `[UNKNOWN]` (declared optional). |

### 10.2 What the next leaves may rely on

- `[DECLARED]` the `SDKRateLimitInfo` shape (`sdk.d.ts:5583-5606`): `status` enum,
  optional `resetsAt: number`, `rateLimitType`, `utilization?: number`. Optional means
  every field may be absent.
- `[INFERRED]` `resetsAt` is epoch seconds (binary strings, §3). Cretli's
  seconds-vs-ms heuristic is `[UNVERIFIED]`; do not widen it.
- **Defensive rule** (a design choice, not a measurement): the raw `utilization` is
  `[UNKNOWN]`-unit until a raw payload is captured; add no new scaling and do not
  clamp values outside `[0, 1]`.
- A missing `utilization` is unknown, not 0.
- `allowed_warning` / `rejected` semantics beyond the enum names are `[UNKNOWN]`;
  record lockout provenance rather than assume it.

### 10.3 Precondition: a captured raw payload

The earlier suggestion of a fixture-level unit test is **withdrawn as a unit
confirmation**: the synthetic fixture assumes a fraction and the observed store rows
are post-conversion, so no test over `tests/fixtures/claude/` can establish the SDK
unit. Before any new `× 100` / `/ 100` ships, a **raw `rate_limit_event` payload
captured from a live stream** is a precondition; this leaf does not have one and the
CLI does not persist such frames (`[UNVERIFIED]`, earlier note). Only with that
capture can a test pin the raw value against the stored percent. The two existing
`× 100` sites — `lib/agent-harness/claude-event-normalizer.ts:183` and
`lib/usage/harness-usage.ts:659` — are an existing, unconfirmed assumption already
in code; this document neither endorses nor changes them.

### 10.4 Blocked until a confirmed source is chosen

- A source-rooted current-context percentage for Claude: only `getContextUsage()`
  (§5.1) is a candidate and its field semantics are `[UNKNOWN]`. Until a source is
  confirmed, the Claude meter shows the measured last-call token count over the catalog
  window (§6). That is not an SDK-declared percentage, and its per-call semantics are
  `[INFERRED]`.
- Merging the `/usage` meters (`SDKUsageReport`, `usage_EXPERIMENTAL_…`): declared
  experimental; shapes may change.
- Per-model vs account scope of a limit: `[UNKNOWN]`.
- Any `overage` / `limitScope` / `errorCode` behaviour: declared only.

### 10.5 Explicitly not to do

- No consumption of `/api/oauth/usage`, `unifiedWindows` or `quotaLimits`.
- No new meter component or unit vocabulary beyond `lib/usage/usage-contract.js`.
- No run/modelUsage total presented as context occupancy (§2, §6).
