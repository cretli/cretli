# Qwen: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live Qwen request was
made and no official docs were fetched (no network evidence); payload shapes come
from the SDK type declarations in `node_modules`, the adapter code and its tests.
Audit date 2026-10-22.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-qwen.test.js`. |
| `[CODE]` | Read from Cretli source or the installed SDK `.d.ts`; not run against the live service. |
| `[DOC]` | Provider documentation claim; none fetched, so none asserted. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- Package `[CODE]`: `@qwen-code/sdk` `0.1.8` (declared `^0.1.8`, `node_modules/@qwen-code/sdk/package.json`). The SDK spawns the Qwen Code CLI; the `qwen` binary is not on PATH in this environment, so the CLI version is `[UNCONFIRMED]`.
- Transport `[CODE]`: `harnesses/qwen/qwen-agent-ws.js` runs a `query()` per prompt and passes `options.resume = room.qwenSessionId` when a resumable id is stored. Events go through `createQwenEventNormalizer()` in `harnesses/qwen/qwen-event-normalizer.js`.
- Auth / provider `[CODE]`: API key (`qwen-api-key.js`); model catalog in `qwen-models.js` (token-plan models). Which upstream endpoint (DashScope OpenAI-compatible vs other) served a given run is `[UNCONFIRMED]`; the usage contract comment assumes DashScope OpenAI-compatible reports cache reads only.
- Official source (metadata from `node_modules/@qwen-code/sdk/package.json`): Qwen Code docs <https://qwenlm.github.io/qwen-code-docs/> (`homepage`), repository <https://github.com/QwenLM/qwen-code>, package `@qwen-code/sdk` version `0.1.8`, audit date 2026-10-22. The docs pages were NOT fetched (no network), so every provider documentation claim stays `[UNCONFIRMED]`; the only content consulted is the installed `0.1.8` `dist/index.d.ts` plus Cretli code.

## 2. Raw fields returned

SDK types `[CODE]`: `Usage {input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?, total_tokens?}`; `ExtendedUsage` adds `server_tool_use.web_search_requests`, `service_tier`, `cache_creation {ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`. `result.modelUsage[model]` is `ModelUsage {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, contextWindow}`. No reasoning-token field exists.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| `assistant.message.usage.input_tokens` | billing; with cache, possible prompt occupancy of that call | one API call (assistant message) | snapshot per call; successive calls are independent, adapter treats each as a delta | Cretli subtracts cache from it (`fromQwenUsage`), i.e. assumes it INCLUDES cache; matches the contract `payloadInputIncludesCache: true`, real payload `[UNCONFIRMED]` | own (main agent) |
| `output_tokens` | billing | API call | snapshot | n/a | own |
| `cache_read_input_tokens` | billing (discounted); part of prompt occupancy | API call | snapshot | subset of `input_tokens` | own |
| `cache_creation_input_tokens` | billing (premium) | API call | snapshot | subset of `input_tokens`; contract says writes are not guaranteed | own |
| `cache_creation.ephemeral_5m_input_tokens` | billing (cache write, 5-minute TTL tier); not occupancy | API call | snapshot; read by `fromQwenUsage` only when `cache_creation_input_tokens` is 0, summed into `cacheWrite` | subset of `input_tokens`; relation `[UNCONFIRMED]` (no payload) | own `[UNCONFIRMED]` |
| `cache_creation.ephemeral_1h_input_tokens` | billing (cache write, 1-hour TTL tier); not occupancy | API call | snapshot; summed with the 5m field as above | subset of `input_tokens`; `[UNCONFIRMED]` | own `[UNCONFIRMED]` |
| `server_tool_use.web_search_requests` | billing-adjacent request count (not tokens); not occupancy; ignored by the adapter | `[UNCONFIRMED]` (typed on `ExtendedUsage`, so per call or run) | count, `[UNCONFIRMED]` delta vs cumulative | none | `[UNCONFIRMED]` |
| `service_tier` | metadata string (pricing tier label), neither tokens nor occupancy; ignored by the adapter | `[UNCONFIRMED]` | label / snapshot | none | `[UNCONFIRMED]` |
| `total_tokens` | not read by the adapter | `[UNCONFIRMED]` | `[UNCONFIRMED]` | `[UNCONFIRMED]` | `[UNCONFIRMED]` |
| `result.usage` | run billing at most, never occupancy; adapter comment says it may cover only the last call | run (`[UNCONFIRMED]` whether cumulative or last-call) | `[UNCONFIRMED]` | as above | consolidated `[UNCONFIRMED]` |
| `result.modelUsage[m].*` | per-model run billing; `contextWindow` is the only window source | run, per model | cumulative per run `[UNCONFIRMED]` | separate cache fields | consolidated across models |
| `result.duration_ms`, `num_turns` | timing | run | cumulative | n/a | consolidated |
| `compact_metadata.pre_tokens` / `post_tokens` | possible prompt occupancy before/after compaction | compaction event | snapshot | n/a | own; `post_tokens` presence `[UNCONFIRMED]` |

## 3. Adapter mapping and normalized shape

`[CODE]` `harnesses/qwen/qwen-event-normalizer.js`:

- Each `assistant` record with any positive count in `input_tokens`, `output_tokens`, `cache_read_input_tokens` or `cache_creation_input_tokens` (`hasQwenUsageCounts`) emits `{kind:'usage', usage}` and sets `sawAssistantUsage`. Usage is read from `message.usage` or `rec.usage`.
- `result.usage` is emitted (with `durationMs` and `modelUsage`) only when `sawAssistantUsage` is false; the flag resets after each result so a tool loop is counted per call without double counting `[OBSERVED]`.
- No per-message id dedup: a repeated identical assistant record would be counted twice (unlike CodeBuddy). Whether Qwen emits partial usage snapshots of one message is `[UNCONFIRMED]`.

Downstream `[CODE]`: `lib/usage/harness-usage.ts` calls `fromQwenUsage` (`lib/usage/usage-normalize.js`): `cachedInput = cache_read_input_tokens`; `cacheWrite = cache_creation_input_tokens` or, when zero, the sum of `cache_creation.ephemeral_5m/1h_input_tokens`; `textInput = max(0, input_tokens - cachedInput - cacheWrite)`; `textOutput = output_tokens`; reasoning is never set. Contract `resolveUsageContract('qwen')`: `measurementKind: delta`, `granularity: run`, `reasoningReported: false`, `cacheWrite: false`.

`[OBSERVED]` raw `{input_tokens:1000, output_tokens:50, cache_read_input_tokens:400}` -> bag `{textInput:600, textOutput:50, cachedInput:400, cacheWrite:0, reasoning:0}`; ephemeral breakdown 100+50 yields `cacheWrite: 150`.

Inconsistency to flag (not changed here): the contract says `granularity: 'run'` while the adapter emits per assistant message (API call) and uses `result.usage` only as a fallback. The effective granularity is the API call.

## 4. Stale and compaction behavior

- Per-call deltas have no stale cumulative baseline to subtract; the only aggregate (`result.usage`) is suppressed once call usage was measured `[OBSERVED]`.
- Native compaction `[CODE]`: a `system` record with `compact_boundary` subtype or `compact_metadata` (`trigger`, `pre_tokens`, optional `post_tokens`) becomes a `notice` of `noticeType: 'compact'` `[OBSERVED]` for the notice. `qwen-agent-ws.js` then calls `advanceRoomContextEpoch(room, 'compact_boundary')` so cache epochs are separated.
- `qwen-context-settings.js` writes Qwen's own `settings.json`: `context.autoCompactThreshold` (default 0.85 of the window, per the file's comment citing Qwen's documented default `[DOC-via-code]`), `context.clearContextOnIdle`, `model.generationConfig.enableCacheControl`.

## 5. Context window source

Two sources, neither measured here:

1. `qwen-models.js#createQwenCatalogEntry` hard-codes `contextWindowTokens: 1_000_000` for every catalog model `[CODE]`. This is a Cretli constant, not a provider-reported value; its correctness per model is `[UNCONFIRMED]`.
2. `result.modelUsage[model].contextWindow` from the SDK `[CODE]`; `lib/persist/chat-history-usage.js` falls back to it for stored runs. Whether the CLI fills it for the tested provider/model/config is `[UNCONFIRMED]`.

Prompt occupancy for the window should come from the latest call's `input_tokens` (which includes cache under the current contract), not from `result.usage` or `modelUsage` totals.

## 6. Session capabilities

| Capability | Status |
| --- | --- |
| Fresh session | Yes `[CODE]`: `query()` without `resume`. |
| Reset | Cretli drops the stored `qwenSessionId` / room and starts a new query; usage state is per normalizer instance. |
| Resume | Yes `[CODE]`: `options.resume = room.qwenSessionId`; session ids come from `session_id` on stream records and `query.getSessionId()`; mapped for delegations in `lib/delegation-session-resume.js`. |
| Seed | No native seed API found; context is injected in the prompt. |
| Native compaction | Automatic (threshold setting), signalled by `compact_boundary`; no manual trigger from Cretli found. |

## 7. Documentation claims vs Cretli-observed

- Provider docs: none fetched; no claim recorded.
- Cretli-observed `[OBSERVED]`: per-call usage emitted, `result.usage` fallback only, cache subtracted from input, compaction notice with `preTokens`.
- Open items `[UNCONFIRMED]`: whether `input_tokens` truly includes cache, `total_tokens` semantics, `result.usage` scope, `post_tokens`, real `contextWindow` per model, upstream endpoint, CLI version.

## 8. Fixtures

`tests/fixtures/usage/qwen/raw-stream-usage.json` (sanitized raw stream records) and `normalized-token-bag.json` (expected bags). Both pass `containsConversationContent` and contain no secrets or private paths.
