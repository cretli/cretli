# DeepSeek: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live DeepSeek request
was made and no official docs were fetched (no network access in this run);
payload values come from the adapter code, installed package metadata and tests,
not from real traffic. Audit date 2026-10-22.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-deepseek.test.js`. |
| `[CODE]` | Read from the Cretli source or installed package; not executed against the live service. |
| `[DOC]` | Provider documentation claim; none fetched, so none asserted as verified. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- Package `[CODE]`: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client`, both `0.1.2-alpha.5` (DeepSeek Harness, "DSH"; `dsh` binary under `node_modules/.bin`). Cretli drives DSH over its SDK JSON-RPC (`session.event`, `session.status` notifications) via `harnesses/deepseek/deepseek-adapter.js` and `deepseek-agent-ws.js`.
- Provider/auth `[CODE]`: DeepSeek API key (`deepseek-api-key.js`); balance via `deepseek-balance.js`. The DSH LLM layer (`dsh-llm-deepseek`) talks to the DeepSeek chat-completions API.
- Official source `[UNCONFIRMED]`: DeepSeek API docs (usage object of chat completions, context caching) were not fetched; the URL, version and date cannot be cited. The wire-shape claims below are `[CODE]` from the comment in `lib/usage/usage-normalize.js#fromDeepSeekUsage` and the invented-value fixture, not verified against provider docs.

## 2. Raw fields returned

Two shapes reach Cretli.

DSH `TokenUsage` `[CODE]` (camelCase, on `session.event` `assistant/message` `data.usage`): `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, optionally `totalTokens`.

Raw wire `usage` `[CODE]` (snake_case, chat-completions): `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| DSH `inputTokens` | billing (uncached input); plus `cacheReadTokens` = prompt occupancy of that call | one assembled assistant message (a model step) | snapshot of that step (treated as delta) | disjoint: excludes cache reads | own session |
| DSH `cacheReadTokens` | billing (discounted); part of occupancy | step | snapshot | subset of the real prompt | own |
| DSH `cacheWriteTokens` | billing; part of occupancy | step | snapshot | separate bucket; whether DeepSeek ever reports it is `[UNCONFIRMED]` | own |
| DSH `outputTokens` | billing | step | snapshot | n/a | own |
| DSH `reasoningTokens` | billing, subset of output | step | snapshot | n/a | own |
| DSH `totalTokens` | billing sanity value, ignored by the bag | step | snapshot | includes cache reads (`1050 = 400 + 600 + 50` in the fixture) | own |
| wire `prompt_tokens` | billing; the whole prompt of that request, i.e. possible current occupancy | request | snapshot | INCLUDES cache hits (`hit + miss`) | own |
| wire `prompt_cache_hit_tokens` / `_miss_tokens` | billing split of the prompt | request | snapshot | hit is a subset of `prompt_tokens` | own |
| wire `completion_tokens` | billing | request | snapshot | n/a | own |
| child-session `usage` | billing only | step of a subagent | snapshot | disjoint, as DSH | consolidated (tagged, see 3) |

Nothing in either shape is a running total of the session or a context-window size; occupancy is derivable only per call as `inputTokens + cacheReadTokens` (DSH) or `prompt_tokens` (wire) `[OBSERVED]`.

## 3. Adapter mapping and normalized shape

`[CODE]` `harnesses/deepseek/deepseek-event-normalizer.js`:

- `readSessionEventUsage` reads `data.usage` of the event; DSH has no dedicated usage record. An `assistant/message` (or `assistant`) with `usage` becomes `{ type: 'usage', usage }`; its text is skipped to avoid duplicating streamed deltas.
- Child (in-process subagent) sessions: usage is forwarded as `{ type: 'usage', usage, consolidated: true, childSessionId }`, so the ledger never folds child tokens into the parent's own scope; text/tools of the child stay suppressed.

`[CODE]` `harnesses/deepseek/deepseek-agent-ws.js` folds each step's usage into `room._lastUsagePayload` (sum of `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) for delegation metrics. That sum is a per-run cumulative figure and must never be used as prompt occupancy; it is reset by `beginHarnessRun` on the next prompt.

Normalization `[CODE]` `lib/usage/usage-normalize.js#fromDeepSeekUsage`:

- DSH camelCase (`inputTokens`/`outputTokens` present): direct map to the bag (`textInput = inputTokens`, `cachedInput = cacheReadTokens`, `cacheWrite`, `textOutput`, `reasoning`).
- Raw wire: `cachedInput = prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens`; `textInput = max(0, prompt_tokens - cached)`; `textOutput = completion_tokens`; `reasoning = completion_tokens_details.reasoning_tokens`.

`[OBSERVED]` fixture `dsh-session-events.json`: the DSH event yields the bag `{textInput:400, textOutput:50, cachedInput:600, cacheWrite:0, reasoning:10}`; fixture `raw-wire-usage.json` yields the same input/cache split from `prompt_tokens: 1000` with `prompt_cache_hit_tokens: 600`. Both fixtures use invented values and contain no conversation text.

Contract `resolveUsageContract('deepseek')` `[OBSERVED]`: `measurementKind: delta`, `granularity: message`, `payloadInputIncludesCache: false`, `reasoningRelation: subset_of_output`, `explicitContextEpoch: true`.

Caveat: the raw wire path is accepted by the normalizer but the adapter's live path is DSH camelCase; whether DSH itself computes `inputTokens` as `prompt_cache_miss_tokens` is `[UNCONFIRMED]` (inferred from the disjointness comment, not verified against DSH source).

## 4. Stale and compaction behavior

- Usage is a per-step delta stream, so there is no stale cumulative snapshot to subtract. Reasoning is a subset of output, so it must not be added to output again.
- Native compaction `[CODE]`: DSH has a `compaction-basic` policy (`thresholdRatio`, `retainRatio`). `dsh-runtime-patch.js` rewrites the policy row; Cretli default is `thresholdRatio 0.5`, `retainRatio 0.16` (`deepseek-compaction-config.js`; env `CRETLI_DEEPSEEK_COMPACTION_THRESHOLD_RATIO` / `_RETAIN_RATIO`, or settings `deepseekCompaction`), versus DSH's own 0.8 trigger. The ratios apply to the declared window.
- The normalizer has no compaction event handling `[CODE]` (no `compact` match in `deepseek-event-normalizer.js` or `deepseek-agent-ws.js`), so a DSH-side compaction is not surfaced as a notice and no pre/post token figures are reported to Cretli. After compaction, the next step's `inputTokens + cacheReadTokens` simply drops; cache reads may fall to zero for that step. Whether DSH emits a compaction session event Cretli ignores is `[UNCONFIRMED]`.

## 5. Context window source

`[CODE]` `harnesses/deepseek/deepseek-model-ids.js` declares `contextWindow: 1_000_000` per model; the same value is exposed as `contextWindowTokens` by `deepseek-models.js` and written into the DSH model config by `dsh-runtime-patch.js` (`contextWindow: <n>`). So the window is a Cretli-side static declaration pushed into DSH, not a figure returned by the API in usage payloads. Whether it equals DeepSeek's actual limit for the tested model is `[UNCONFIRMED]` (docs not fetched).

## 6. Fresh session, reset, resume, seed, native compaction

- Fresh session / reset `[CODE]`: `deepseek-agent-ws.js` records a context restart through `recordContextRestart` with reasons `MODEL_CHANGE`, `PROCESS_RECREATED`, `MCP_REVISION`, `SESSION_DROP`; these bump the context epoch so cache series do not span a reset. A model change recreates the session.
- Resume `[CODE]`: the root DSH session id is remembered per room (`rememberRootDeepSeekSession`); re-attaching after a process recreate is tracked as a restart. Whether DSH reloads persisted history on resume (it ships `dsh-session-persistence-jsonl`) is `[UNCONFIRMED]` end to end.
- Seed `[UNCONFIRMED]`: no dedicated history-seeding path was found in the adapter; not exercised.
- Native compaction `[CODE]`: yes, configurable (section 4); no Cretli-visible event.

## 7. Provider documentation vs observed Cretli behavior

- `[DOC]` Nothing is asserted: provider docs were not reachable. The wire field names and the "`prompt_tokens` includes cache hits" convention come from the repo's own comments.
- `[OBSERVED]` Only normalization of the sanitized fixtures; no live payload was captured.

## 8. Findings for the contract owner (not changed here)

1. Per-call occupancy is `inputTokens + cacheReadTokens`; the run-level `_lastUsagePayload` sum is not occupancy.
2. No compaction signal is surfaced for DeepSeek, unlike CodeBuddy/Claude; context-drop detection has to rely on epochs and the usage drop.
3. Context window is a static 1M declaration; confirm against the provider docs before trusting it for percentage displays.
