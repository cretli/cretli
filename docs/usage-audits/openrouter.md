# OpenRouter: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live OpenRouter request
was made and the official docs were not fetched here, so payload values come from
the adapter code and tests, not from real traffic.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-openrouter.test.js`. |
| `[CODE]` | Read from the Cretli source; behavior not executed against the live API. |
| `[DOC]` | Provider documentation claim (`https://openrouter.ai/docs`); not fetched, so not verified. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- No OpenRouter SDK or CLI: there is no `openrouter` package in `node_modules`, so the version is n/a. Cretli calls the HTTP API directly with `fetch`.
- Transport `[CODE]`: `POST https://openrouter.ai/api/v1/chat/completions` with `stream: true` (SSE), `lib/providers/openrouter/openrouter-client.ts` (`postOpenRouterChatCompletion`, `streamOpenRouterChatCompletion`, `parseOpenRouterSseDataLine`). Request body is only `model`, `messages`, optional `tools`; no `stream_options` and no `usage: {include: true}`.
- Auth `[CODE]`: bearer API key (`openrouter-api-key.js`, `OPENROUTER_API_KEY`, keys start `sk-or-v1-`). Provider routing is OpenRouter's choice; Cretli sends no `provider` preferences, so the upstream provider is `[UNCONFIRMED]` per request.
- Official source: `https://openrouter.ai/docs` (API reference, usage accounting). `[UNCONFIRMED]` page version/date: not fetched in this leaf (audit date 2026-10-22).

## 2. Raw fields returned

Cretli reads `parsed.usage` from each SSE `data:` JSON object (`parseOpenRouterSseDataLine`); it is attached to the chunk, also for chunks without `choices`.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| `usage.prompt_tokens` | billing; also the closest proxy for prompt occupancy of that request | one request (one model response) | snapshot of that request, not cumulative across requests | `[DOC]` includes cached tokens; Cretli assumes so (`payloadInputIncludesCache:true`) | own request |
| `usage.completion_tokens` | billing | request | snapshot | n/a | own |
| `usage.total_tokens` | billing (redundant sum) | request | snapshot | n/a | own; Cretli ignores it |
| `usage.prompt_tokens_details.cached_tokens` | billing subset of `prompt_tokens` | request | snapshot | subset of prompt (cache read) | own |
| `usage.completion_tokens_details.reasoning_tokens` | `[DOC]` subset of completion | request | snapshot | n/a | Cretli ignores it (`reasoningReported:false`, relation `unknown`) |
| `usage.cost` | `[DOC]` billing in credits/USD | request | snapshot | n/a | Cretli ignores it; cost is computed from catalog pricing (`openrouter_pricing`) |

Cache write tokens (`cache_write_tokens`) `[UNCONFIRMED]`: not read; contract says `cacheWrite:false`.
There is no dedicated "current prompt occupancy" field. `prompt_tokens` of the latest request is the only candidate `[INFERRED]`; `promptTokensForWindow` returns it (1000 in the fixture, `[OBSERVED]`).

## 3. Adapter path and normalization

- `lib/agent-harness/llm-tool-loop.ts`: keeps `lastUsage` per streamed response (`chunk.usage`), and after each response emits `{ type: 'usage', usage }`, so one event per request, including every tool-loop iteration `[CODE]`.
- `lib/agent-harness/room-kernel.ts` calls `noteHarnessCallUsage` and `recordHarnessUsageDelta`; `lib/usage/harness-usage.js#resolveHarnessUsageTokens` -> `lib/usage/usage-normalize.js#fromOpenRouterUsage`.
- Raw shape: `{prompt_tokens, completion_tokens, total_tokens?, prompt_tokens_details:{cached_tokens}, completion_tokens_details?, cost?}`.
- Normalized bag `[OBSERVED]`: `cachedInput = cached_tokens`, `textInput = prompt_tokens - cached_tokens`, `textOutput = completion_tokens`, reasoning 0. Fixture: 1000/600/50 -> 400/600/50; billed total 1050; buckets in `tests/fixtures/usage/openrouter/normalized-token-bag.json`.
- Contract (`usage-contract.js`): `usageShape:'raw'`, `measurementKind:'delta'`, `granularity:'request'`, identity `providerEventId` (the SSE `id`, `gen-...`, is not currently forwarded by the loop `[CODE]`, so dedupe on that field is `[UNCONFIRMED]`).
- Own vs consolidated: the stream carries only the chat's own request; no child/consolidated usage `[CODE]`.
- Missing usage: if the provider sends no `usage` object, nothing is emitted and the run has no measurement `[CODE]`. Whether OpenRouter always sends it without `stream_options` is `[DOC]` and `[UNCONFIRMED]`.

## 4. Context window

- Source `[CODE]`: `lib/providers/openrouter/openrouter-models.ts` maps only `id`, `name` and `pricing` from `GET /models`; `context_length` is dropped there. `lib/model-catalog.js#readCatalogContextWindowTokens` can read `context_length` from a catalog row, but OpenRouter rows never carry it, so the window for OpenRouter is `[UNCONFIRMED]` (not provided by the adapter).
- Meaning `[DOC]`: `context_length` in `/models` is the model max (prompt + completion); the routed provider may allow less. Not verified.

## 5. Stale / compaction / reset / resume

- State is a local `room.conversationMessages` array resent in full on every request (`openrouter-agent-ws.js`), so `prompt_tokens` grows with history and is a fresh snapshot each time (never stale).
- Resume `[CODE]`: after restart the array is rebuilt from persisted chat history (`openrouter-conversation-hydrate.js`, plain user/assistant text only; tool turns are not restored).
- Fresh session / reset: a new chat (new `cursorSessionId`) starts an empty array. Seeding is only via that hydration or appended user messages.
- Native compaction: none at the provider (stateless API). Cretli-side compression helpers exist (`lib/context-compression.js`) but were not traced as applied to this harness: `[UNCONFIRMED]`. After any trimming, `prompt_tokens` drops accordingly.
- OpenRouter has no server session id, so no provider-side resume.

## 6. Provider claims vs observed in Cretli

- Claimed `[DOC]`, unverified: usage in the final SSE chunk, `prompt_tokens` includes cached tokens, `cost` field, `reasoning_tokens` detail.
- Observed in Cretli `[OBSERVED]/[CODE]`: the parser and normalizer behavior above, the per-request delta event, and that `reasoning_tokens`, `total_tokens`, `cost` are ignored.
- Gaps: no live payload, no model/provider-specific window, request does not ask for usage explicitly.
