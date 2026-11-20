# Claude: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live Claude request was
made and no official docs were fetched (no network evidence); payload shapes come
from the installed SDK type declarations, the adapter code and its tests.
Audit date 2026-10-22.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-claude.test.js`. |
| `[CODE]` | Read from Cretli source or the installed SDK `.d.ts`; not run against the live service. |
| `[DOC]` | Provider documentation claim; only what the installed `.d.ts` doc-comments state, no web page fetched. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- Package `[CODE]`: `@anthropic-ai/claude-agent-sdk` `0.3.300` (pinned in `optional-packages/claude-agent-sdk/package.json`, installed by `scripts/install-optional-claude-sdk.js`). Message types come from `@anthropic-ai/sdk` `0.134.0` (`BetaUsage`). The bundled CLI binary (`claude-agent-sdk-linux-x64/claude`) reports `2.1.300 (Claude Code)`; the system `claude` is not on PATH.
- Transport `[CODE]`: `lib/claude/claude-agent-ws.js` drives `query()` (streaming session, `includePartialMessages`); events go through `createClaudeEventNormalizer()` in `lib/agent-harness/claude-event-normalizer.ts`.
- Auth / provider `[CODE]`: Anthropic API key, Claude subscription login, or a supported cloud provider (error map `authentication_failed`, `cloud_credential_error`). Which variant served a given run is `[UNCONFIRMED]`; no run was made here.
- Official source: package homepage <https://github.com/anthropics/claude-agent-sdk-typescript> (`package.json` `homepage`), version `0.3.300`, audit date 2026-10-22. The page was NOT fetched; the only provider text consulted is the doc-comments of the installed `sdk.d.ts`.

## 2. Raw fields returned

`BetaUsage` `[CODE]` (`@anthropic-ai/sdk` 0.134.0): `input_tokens`, `output_tokens`, `cache_creation_input_tokens | null`, `cache_read_input_tokens | null`, `cache_creation {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} | null`, `iterations | null`, `inference_geo | null`, `fallback_credit | null`. `result.modelUsage[model]` is `ModelUsage {inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, ...}`. `query.getContextUsage()` returns `SDKControlGetContextUsageResponse {categories[{name,tokens,kind}], totalTokens, maxTokens, rawMaxTokens, percentage, model, ...}`.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| `assistant.message.usage.input_tokens` | billing; uncached part of that call's prompt | one API call (`message.id`) | snapshot per call | EXCLUDES cache reads/writes `[DOC]`-style Anthropic semantics, `[UNCONFIRMED]` against a live payload; adapter adds the cache buckets back | own (main thread; subagent calls carry `parent_tool_use_id`) |
| `cache_read_input_tokens` | billing (discounted); part of prompt occupancy | API call | snapshot | separate bucket, additive to `input_tokens` | own |
| `cache_creation_input_tokens` | billing (premium); part of prompt occupancy | API call | snapshot | separate bucket, additive | own |
| `cache_creation.ephemeral_5m/1h_input_tokens` | billing sub-breakdown of cache writes by TTL; not additive | API call | snapshot | subset of `cache_creation_input_tokens` (adapter reports `cacheWrite5mTokens`/`cacheWrite1hTokens` as diagnostics only) | own |
| `output_tokens` (assistant / `message_start`) | billing; part of next call's prompt | API call; at `message_start` it is a partial count | snapshot, grows until `message_delta` | n/a | own |
| `stream_event message_delta.usage.output_tokens` | billing | API call | final output count of that call | n/a | own |
| `iterations`, `inference_geo`, `fallback_credit` | metadata, ignored by the adapter | `[UNCONFIRMED]` | `[UNCONFIRMED]` | none | `[UNCONFIRMED]` |
| `result.usage` | run billing, never occupancy | run | whether it is summed over all calls or the last call is `[UNCONFIRMED]` (the adapter comments call it a sum) | same buckets | consolidated for the query (main thread; subagent inclusion `[UNCONFIRMED]`) |
| `result.modelUsage[m].inputTokens/outputTokens/cache*` | per-model run billing | run, per model | cumulative per query `[UNCONFIRMED]` | separate cache fields | consolidated across models |
| `result.modelUsage[m].thinkingTokens` | subset of output `[DOC]` (d.ts comment); not read by the adapter; partial for resumed sessions | run | cumulative | none | consolidated |
| `result.modelUsage[m].contextWindow` | context window source | per model | snapshot | n/a | per model |
| `result.total_cost_usd`, `duration_ms` | cost, timing | run | cumulative | n/a | consolidated |
| `getContextUsage().totalTokens/maxTokens` | prompt occupancy (current window) and window | on demand | snapshot | n/a | own; reads via `claude-context-breakdown.js`, timeout-guarded |
| `compact_metadata.pre_tokens/post_tokens` | occupancy before/after compaction | compaction event | snapshot | n/a | own; `post_tokens` is optional |

## 3. Adapter mapping and normalized shape

`[CODE]` `lib/agent-harness/claude-event-normalizer.ts`:

- `resolveClaudeUsageBag(raw)` returns `{inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens?, cacheWrite1hTokens?}` with `inputTokens = input_tokens + cache_read + cache_creation`. `[OBSERVED]` raw `{input_tokens:15, output_tokens:70, cache_read_input_tokens:900, cache_creation_input_tokens:1000}` -> `inputTokens: 1915`.
- `result` emits `{kind:'usage', usage, final:true, totalCostUsd, durationMs, modelUsage, firstApiCallUsage, lastCallUsage, lastCallModel, lastCallContextWindowTokens}` `[OBSERVED]`.
- Each main-thread API call emits `context_usage` (from `message_start`, `message_delta`, `assistant`); the largest output per `message.id` wins and unchanged totals are suppressed `[OBSERVED]`. The first call also emits `api_call_usage {first:true}`. Subagent messages (`parent_tool_use_id`) are skipped `[OBSERVED]`.

Downstream `[CODE]`: `fromClaudeUsage` (`lib/usage/usage-normalize.js`) gives `cachedInput = cacheRead`, `cacheWrite`, `textInput = max(0, inputTokens - cacheRead - cacheWrite)`, `textOutput`; reasoning never set `[OBSERVED]`. Contract `resolveUsageContract('claude')`: `measurementKind: snapshot`, `granularity: run`, `payloadInputIncludesCache: true` (refers to the RESOLVED bag, not the provider payload), `reasoningReported: false`.

Observations to flag (not changed here): the contract names granularity `run` for `result.usage`, while occupancy is actually carried by the separate per-call `context_usage`/`lastCallUsage` events; `modelUsage.thinkingTokens` could populate reasoning but is not read.

## 4. Stale and compaction behavior

- The run-level `result.usage` must not be used as occupancy; the adapter keeps `lastCallUsage` (newest main-thread call, prompt + output) for that purpose and clears it on `result`, `reset` and `compact_boundary` `[OBSERVED]`, so a compacted transcript is not shown with the pre-compaction size.
- Native compaction `[CODE]`: `system`/`compact_boundary` becomes a `notice` with `noticeType:'compact'`, `trigger`, `preTokens`, `postTokens` `[OBSERVED]`. `claude-agent-ws.js` then calls `advanceRoomContextEpoch(room, 'compact_boundary')` because the prompt prefix (and cache) is rewritten.
- Whether `message_start` input counts are stable or revised later in the same call is `[UNCONFIRMED]`.

## 5. Context window source

1. `result.modelUsage[model].contextWindow` `[CODE]`: authoritative, read by `readClaudeModelContextWindow` `[OBSERVED]`; cached per model by `noteClaudeReportedContextWindows` and used as `getClaudeReportedContextWindow`. The adapter comment states the same model id may run on a 200K or 1M window by account, so a static table is unsafe `[DOC-via-code]`.
2. `query.getContextUsage()` `maxTokens` `[CODE]`: live window and current `totalTokens` (estimated breakdown).
3. `claude-models.js` catalog entries carry `contextWindowTokens` from `query.supportedModels()` rows when available; the value for the tested account/model is `[UNCONFIRMED]` (the fixture uses a synthetic `200000`).

Prompt occupancy of the current window = last call `inputTokens + outputTokens` (cache included in the resolved bag), or `getContextUsage().totalTokens`.

## 6. Session capabilities

| Capability | Status |
| --- | --- |
| Fresh session | Yes `[CODE]`: `query()` without `resume`. |
| Reset | `clearClaudeRoomSession` drops `room.claudeSessionId` (and the persisted id); usage state is per normalizer (`reset()`). |
| Resume | Yes `[CODE]`: `options.resume = room.claudeSessionId` for a resumable id; one retry without `resume` when the session is gone. |
| Fork | SDK exposes `forkSession` (option and function) `[CODE]`; use by Cretli not found in the audited path, `[UNCONFIRMED]`. |
| Seed | No native seed API found; context is injected in the prompt. |
| Native compaction | Automatic, signalled by `compact_boundary` (`trigger` `manual`/`auto`); manual trigger from Cretli not audited, `[UNCONFIRMED]`. |

## 7. Documentation claims vs Cretli-observed

- Provider docs (installed d.ts comments only): `thinkingTokens` is already inside `outputTokens`; `contextWindow` per model; `compact_metadata.post_tokens` optional.
- Cretli-observed `[OBSERVED]`: cache added to input, per-call context events with max-output-per-message rule, final usage with window, subagent exclusion, compaction notice and last-call clear.
- Open items `[UNCONFIRMED]`: live payloads, whether `input_tokens` excludes cache in the tested auth variant, `result.usage` scope (sum vs last call, subagents), real `contextWindow` for the account, `iterations`/`fallback_credit` semantics, `forkSession` use.

## 8. Fixtures

`tests/fixtures/usage/claude/raw-stream-usage.json` (sanitized raw stream records, no content blocks) and `normalized-token-bag.json` (expected resolved bags, disjoint bag and context events). Both pass `containsConversationContent` and contain no secrets or private paths. Test: `tests/usage-audit-claude.test.js`.
