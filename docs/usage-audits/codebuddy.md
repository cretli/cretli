# CodeBuddy: usage and context telemetry audit

Read-only audit. This leaf changes no adapter, no `USAGE_HARNESS_MATRIX`, no
`docs/usage-contract.md` and no shared contract file. No live CodeBuddy request
was made and no official docs were fetched; payload values come from the SDK type
declarations in `node_modules`, the adapter code and tests, not from real traffic.
Audit date 2026-10-22.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-codebuddy.test.js`. |
| `[CODE]` | Read from the Cretli source or the installed SDK `.d.ts`; not executed against the live service. |
| `[DOC]` | Provider documentation claim; no docs were fetched, so none are asserted here. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- Package `[CODE]`: `@tencent-ai/agent-sdk` version `0.1.30` (optional dependency, loaded lazily by `harnesses/codebuddy/codebuddy-sdk.js`). The SDK spawns the CodeBuddy CLI as a child process (`ProcessTransport`); the CLI binary version is `[UNCONFIRMED]` (resolved by `codebuddy-cli.js`, not pinned).
- Transport `[CODE]`: one long-lived SDK session per room (`codebuddy-live-session.js`, `codebuddy-agent-ws.js`), `send()` per turn. The file notes that CLI `--resume` replays the previous assistant message and ignores the new prompt, so Cretli does not resume per turn.
- Auth `[CODE]`: API key (`codebuddy-api-key.js`). Upstream model provider per request is `[UNCONFIRMED]`; `codebuddy-models.js` infers a provider label from the model id/vendor only.
- Official source: Tencent CodeBuddy Agent SDK documentation `[UNCONFIRMED]` (URL, version and date not fetched). The only source consulted is `node_modules/@tencent-ai/agent-sdk/lib/types.d.ts` (`0.1.30`).

## 2. Raw fields returned

The SDK `Usage` type `[CODE]` is Anthropic-style snake_case:
`input_tokens`, `output_tokens`, `cache_read_input_tokens?`, `cache_creation_input_tokens?`.
It appears on `message_start.message.usage`, `message_delta.usage` (only `input_tokens`/`output_tokens`), the full `assistant.message.usage`, and `result.usage`. There is no reasoning-token field, no context-window field and no per-model usage map.

| Field | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- |
| `input_tokens` | billing; with cache fields, possible prompt occupancy of that API call | one model message (API call) | snapshot per message (`message_start` partial, then final); `result.usage` is a run/session aggregate | Anthropic-style: `[UNCONFIRMED]` whether it excludes cache; Cretli's resolver assumes it excludes cache and adds cache back | own (main agent); subagent/consolidated split `[UNCONFIRMED]` |
| `output_tokens` | billing | message | snapshot, grows via `message_delta` | n/a | own |
| `cache_read_input_tokens` | billing (discounted); part of prompt occupancy | message | snapshot | subset of the real prompt | own |
| `cache_creation_input_tokens` | billing (premium); part of prompt occupancy | message | snapshot | subset of the real prompt | own |
| `result.usage` | run billing only, never occupancy | run (the CLI may include earlier prompts, per adapter comment) | cumulative | n/a | consolidated `[UNCONFIRMED]` |
| `result.total_cost_usd`, `duration_ms` | billing / timing | run | cumulative | n/a | consolidated |
| `compact_metadata.pre_tokens` / `post_tokens` | possible prompt occupancy (size before/after compaction) | compaction event | snapshot | n/a | own; `post_tokens` presence `[UNCONFIRMED]` |

## 3. Adapter mapping and normalized shape

`[CODE]` `harnesses/codebuddy/codebuddy-event-normalizer.js`:

- `readMessageUsage` picks `usage` from `message.usage`, `event.usage` or `rec.usage`. A message id is resolved from `message_start`; the final assistant message gets a different id (`completed-...`) and is aliased to the active `message_start` id.
- `readUsageDelta` keeps per-message maxima in `createCodeBuddyUsageState()` and emits only the positive increment per key, so partial plus completed snapshots of one message are counted once. A zero-valued key present in the snapshot is still emitted (for example `output_tokens: 0`).
- `result.usage` is used only when no message usage arrived (`hasMessageUsage` false), because it may cover earlier prompts.

Downstream `[CODE]`: `lib/usage/harness-usage.js#resolveHarnessUsageTokens('codebuddy')` runs `resolveClaudeResultUsage` (adds `cache_read` and `cache_creation` into `inputTokens`) then `fromClaudeUsage` (subtracts them again into `textInput`). Contract `resolveUsageContract('codebuddy')`: `measurementKind: delta`, `granularity: message`, `reasoningReported: false`.

`[OBSERVED]` raw `{input_tokens:100, output_tokens:10, cache_read_input_tokens:20}` resolves to `inputTokens: 120` and the bag `{textInput:100, textOutput:10, cachedInput:20, cacheWrite:0, reasoning:0}`.

Note: the contract flag `payloadInputIncludesCache: true` is inconsistent with the resolver, which treats raw `input_tokens` as excluding cache (it adds cache on top). If the real payload `input_tokens` already included cache, cache would be double counted. Which is true is `[UNCONFIRMED]` without live payloads; flagged for the contract owner, not changed here.

## 4. Stale and compaction behavior

- Usage is a per-message delta stream, so there is no stale cumulative snapshot to subtract, except the `result.usage` aggregate, which the adapter suppresses once message usage was measured `[OBSERVED]`.
- Native compaction `[CODE]`: `compact_boundary` (with `compact_metadata {trigger, pre_tokens}`), `status: 'compacting'` and `PreCompact`/`PostCompact` hooks become a `notice` of `noticeType: 'compact'`. `codebuddy-agent-ws.js` then calls `advanceRoomContextEpoch(room, 'compact_boundary')` so the ledger separates the pre- and post-compaction cache epochs `[OBSERVED]` for the notice itself in the test.
- `post_tokens` is read if present; whether CodeBuddy sends it is `[UNCONFIRMED]`.

## 5. Context window source

`codebuddy-models.js#catalogEntryFromCodeBuddyRow` reads `maxInputTokens` (or `contextWindowTokens`) from the model rows returned by the SDK model listing and stores `contextWindowTokens`. This is the model's maximum input size as reported by the catalog, not a per-run measurement; for the tested provider/model/config the value is `[UNCONFIRMED]` (no live listing). Prompt occupancy for the window must be derived from the latest message's `input_tokens + cache_read + cache_creation` (the `promptTokensForWindow` bucket), not from `result.usage`.

## 6. Session capabilities

| Capability | Status |
| --- | --- |
| Fresh session | Yes `[CODE]`: a new live session without a stored `codebuddySessionId`. |
| Reset | Cretli closes the live session and starts a new one; usage state is per prompt (`createCodeBuddyUsageState`). |
| Resume | SDK option `resume` / `resumeSessionAt` exist `[CODE]` (`types.d.ts`); `lib/delegation-session-resume.js` maps `codebuddySessionId`. Per-turn CLI `--resume` is avoided because it replays the previous answer. |
| Fork | SDK option `forkSession` exists `[CODE]`; not used by Cretli `[UNCONFIRMED]`. |
| Seed | No native seed API found; Cretli injects context in the prompt. |
| Native compaction | Automatic, signalled by `compact_boundary`; a manual trigger from Cretli was not found. |

## 7. Documentation claims vs Cretli-observed

- Provider docs: none fetched; no claim recorded.
- Cretli-observed `[OBSERVED]`: duplicate partial/completed snapshots are deduplicated; `result.usage` is a fallback only; compaction produces a notice with `preTokens`.
- Open items `[UNCONFIRMED]`: whether `input_tokens` includes cache, subagent scope, `post_tokens`, real context window per model, CLI version.

## 8. Fixtures

`tests/fixtures/usage/codebuddy/raw-stream-usage.json` (raw stream records and expected normalizer usage events) and `normalized-token-bag.json` (expected bag). Both are sanitized shapes without conversation text, checked by `containsConversationContent`.
