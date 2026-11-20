# Codex: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live Codex request was
made and no official docs were fetched (no network evidence); payload shapes come
from the SDK type declarations in `node_modules`, the adapter code and its tests.
Audit date 2026-10-22.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-codex.test.js`. |
| `[CODE]` | Read from Cretli source or the installed SDK `.d.ts`; not run against the live service. |
| `[DOC]` | Provider documentation claim; none fetched, so none asserted. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- Package `[CODE]`: `@openai/codex-sdk` `0.160.0` (declared `^0.160.0` in `package.json`). Installed CLI binary `codex-cli 0.160.0` (`codex --version`).
- Transport `[CODE]`: two paths in `lib/codex/codex-agent-ws.js`. (a) SDK: `codex.startThread()` / `codex.resumeThread(room.codexThreadId, ...)` and the streamed `ThreadEvent`s. (b) App-server (`isCodexAppServerEnabled()`, `lib/codex/codex-app-server.js`): JSON-RPC notifications mapped to the same event names by `normalizeCodexThreadEvent`. Which path served a given run depends on config; both were read in code only.
- Auth / provider `[CODE]`: API key (`CODEX_API_KEY` / `OPENAI_API_KEY`, `lib/codex/codex-api-key.js`) or ChatGPT plan login (`codex-chatgpt-auth.js`, `getCodexAuthMode() === 'chatgpt'`, which strips the API-key env vars). Whether usage numbers differ between the two variants is `[UNCONFIRMED]`.
- Official source: package metadata of `@openai/codex-sdk` `0.160.0` and its `dist/index.d.ts` (`Usage` type); repository <https://github.com/openai/codex>. Docs pages were NOT fetched, so every provider documentation claim is `[UNCONFIRMED]`.

## 2. Raw fields returned

Two independent sources exist.

**A. `turn.completed.usage`** (SDK `Usage`, `[CODE]` `dist/index.d.ts`): `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`. The SDK comment says "during a turn".

**B. Rollout JSONL** (`CODEX_HOME` session log, read by `lib/codex/codex-context-usage.js`): `event_msg` / `token_count` with `info.last_token_usage`, `info.total_token_usage`, `info.model_context_window`; `task_started.model_context_window`; `turn_context.payload.model`; `compacted` records; and `token_usage_record` records (`payload.usage`, `thread_token_usage`, `response_id`, `turn_id`). The rollout format is an internal CLI file; its stability is `[UNCONFIRMED]`.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| `turn.completed.usage.input_tokens` | billing; per-turn sum, NOT prompt occupancy | turn (may span several model calls, `[UNCONFIRMED]` whether summed) | per-turn value, treated as a delta | INCLUDES cached (`fromCodexUsage` subtracts it) | own thread |
| `usage.cached_input_tokens` | billing (discounted) | turn | delta | subset of `input_tokens` | own |
| `usage.cache_write_input_tokens` | billing (cache write) | turn | delta | subset of `input_tokens` per the adapter; real presence `[UNCONFIRMED]` | own |
| `usage.output_tokens` | billing | turn | delta | n/a | own |
| `usage.reasoning_output_tokens` | billing, subset of output | turn | delta | n/a | own |
| `last_token_usage.*` | latest model call; possible current prompt occupancy (`input_tokens` includes cache) | one call | snapshot; consecutive `token_count` events can repeat the same call | `cached_input_tokens <= input_tokens` enforced by the adapter | own root session |
| `total_token_usage.*` | thread-wide cumulative billing; never occupancy | thread | cumulative snapshot | as above | whole thread |
| `model_context_window` | window size, not usage | per session/model | constant | n/a | n/a |
| `token_usage_record.payload.usage` / `thread_token_usage` | same as last/total above | call / thread | snapshot / cumulative | as above | own |
| `thread.tokenUsage/updated` (app-server notification) | thread usage update; DROPPED by `normalizeCodexThreadEvent` | thread | `[UNCONFIRMED]` | `[UNCONFIRMED]` | `[UNCONFIRMED]` |

## 3. Adapter mapping and normalized shape

- Ledger path `[CODE]`: `normalizeCodexThreadEvent` (`lib/agent-harness/codex-event-normalizer.js`) maps `turn.completed` to `{kind:'turn',status:'completed'}` plus `{kind:'usage', usage}`; `usage` is passed through raw. `fromCodexUsage` (`lib/usage/usage-normalize.js`) then yields `cachedInput = cached_input_tokens`, `cacheWrite = cache_write_input_tokens`, `textInput = max(0, input - cached - cacheWrite)`, `textOutput = output_tokens`, `reasoning = reasoning_output_tokens`. `[OBSERVED]` raw 1000/400/50/250/30 -> `textInput 550, cachedInput 400, cacheWrite 50, textOutput 250, reasoning 30`. Contract `resolveUsageContract('codex')`: `measurementKind: delta`, `granularity: turn`, `payloadInputIncludesCache: true`, `reasoningRelation: subset_of_output`, identity `threadId`+`turnId`.
- Context path `[CODE]`: `parseCodexContextUsage` / `readCodexContextUsage` / `watchCodexContextUsage` (1 s poll, 512 KiB tail) emit `{type:'context_usage', source:'codex-cli', model, usage:{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens?,reasoningTokens?}, contextWindowTokens, observedAt, sessionUsage?, compactedAt?, measurementId?, turnId?}`. Occupancy comes from `last_token_usage`, never `total_token_usage`; the file header states this on purpose. `[OBSERVED]` last call 1300 input (1100 cached) with cumulative 2300 yields `usage.inputTokens 1300`, `sessionUsage.inputTokens 2300`.
- Validation `[OBSERVED]`: counters must be safe non-negative integers (a missing/negative value is `null`, not 0); `cached <= input`; `reasoning <= output`; a reading with `total_tokens <= 0` is skipped.
- Repeat suppression `[OBSERVED]`: a `token_count` identical in input/output/cache to the previous `token_usage_record` call reuses that call rather than creating a new one (`token_count` events can repeat; the adapter only de-duplicates against `token_usage_record` calls, so two identical `token_count`-only readings simply yield the same values).

## 4. Stale and compaction behavior

- `turn.completed.usage` is a per-turn delta; there is no cumulative baseline to subtract. `total_token_usage` is cumulative but only attached as `sessionUsage` for reconciliation.
- Native compaction `[CODE]`: a `compacted` rollout record makes the parser emit `{type:'context_usage', reset:true, observedAt}` and clear the last call `[OBSERVED]`. The next reading carries `compactedAt` `[OBSERVED]`; Codex logs a zero-input `token_count` right after `compacted` (per the code comment; not independently reproduced). `codex-agent-ws.js` calls `advanceRoomContextEpoch(room, 'compaction')` once per distinct `compactedAt`, ignoring ones older than the run start. Compaction threshold config: `lib/codex/codex-compaction-config.js`.
- Staleness: the watcher reads only the root session file tail; if the file is unlocatable or unparsable it returns `null` and the last context reading simply stays. A reading's age is visible through `observedAt`.

## 5. Context window source

1. `model_context_window` from the rollout (`task_started` first, then `token_count.info`) `[CODE]`: runtime-reported by the CLI. It is the CLI's configured window for the model/config of that run; whether it is the raw model limit or an effective (e.g. reduced for output/auto-compact headroom) window is `[UNCONFIRMED]`.
2. `lib/codex/codex-models.js` `contextWindowTokens` in the model catalog `[CODE]`: from the model list refresh; may be `null`. Equality with the rollout value for a given model is `[UNCONFIRMED]`.

The value `258400` in the fixture is an illustrative number, not a measured one.

## 6. Session capabilities

| Capability | Status |
| --- | --- |
| Fresh session | Yes `[CODE]`: `startThread(threadOptions)`. |
| Reset | Cretli drops the stored `room.codexThreadId` and starts a new thread; context epoch advances. |
| Resume | Yes `[CODE]`: `resumeThread(room.codexThreadId, ...)` with the thread id from `thread.started`, persisted by `setChatCodexThreadId`; see also `codex-review-guard-resume.js`. |
| Seed | No native seed API found; context is injected via the prompt. |
| Native compaction | Automatic in the CLI, signalled by the `compacted` rollout record; manual trigger from Cretli `[UNCONFIRMED]`. |

## 7. Provider claims vs observed in Cretli

- Provider (OpenAI Responses) semantics that `input_tokens` includes cached tokens: `[UNCONFIRMED]` against docs; Cretli's contract assumes it, and `fromCodexUsage` plus the `cached <= input` guard follow it.
- Whether `turn.completed.usage` sums all calls of a multi-call turn, and whether `cache_write_input_tokens` is ever non-zero for real runs: `[UNCONFIRMED]` (no live payload).
- Observed in Cretli code/tests only: the transforms above.
