# OpenCode: usage and context telemetry audit

Read-only audit for TODO `4b36354f`. This leaf changes no adapter, no
`USAGE_HARNESS_MATRIX`, no `docs/usage-contract.md` and no shared contract file.
No live OpenCode run was captured here, so payload values come from the SDK
type declarations and the adapter code, not from real traffic.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced against the working tree by `tests/usage-audit-opencode.test.js` or a command run in this leaf. |
| `[DECLARED]` | Type/shape only, from the installed SDK `.d.ts`. Units and runtime semantics are not established. |
| `[DOC]` | Provider documentation claim (`https://opencode.ai/docs`); not fetched in this leaf, so none is asserted as verified. |
| `[UNCONFIRMED]` | Not established here; no value or semantics asserted. |

## 1. Package, transport, auth

- `[OBSERVED]` installed `@opencode-ai/sdk` is `1.19.0` (`node_modules/@opencode-ai/sdk/package.json`, dependency of Cretli). The `opencode` CLI on this machine reports `1.19.0` (`opencode --version`).
- Transport: Cretli spawns/attaches an `opencode serve` HTTP instance (`harnesses/opencode/opencode-server-manager.js`, `opencode-instance-http.js`), creates a session with `client.session.create` and prompts with `client.session.promptAsync` (`opencode-agent-ws.js`). Usage arrives on the SSE event stream, not from the prompt response.
- Provider/auth variants are configured per OpenCode (API key helpers `opencode-api-key.js`, `opencode-mimo-api-key.js`). `[UNCONFIRMED]` which provider/model was used in any real run: the fixtures use `example-provider`/`example-model`.
- Official source: OpenCode docs `https://opencode.ai/docs` (SDK section). `[UNCONFIRMED]` page version/date: not fetched in this leaf.

## 2. Raw fields returned

Sources `[DECLARED]`: `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (`AssistantMessage`, `StepFinishPart`, `EventSessionCompacted`, `Model.limit`) and `dist/v2/gen/types.gen.d.ts` (`session.next.step.ended`).

| Field | Where | Class | Granularity | Shape | Cache relation | Scope |
| --- | --- | --- | --- | --- | --- | --- |
| `tokens.input` | `message.updated` `info` (assistant), `session.next.step.ended` | billing / run usage | message (v1) or step (v2) | cumulative snapshot per message `[INFERRED]` from the adapter's per-message diffing and the SDK types; no real capture | excludes cache (separate fields) `[DECLARED]` by the Cretli contract (`payloadInputIncludesCache:false`); not confirmed against real OpenCode traffic `[UNCONFIRMED]` | own session |
| `tokens.output` | same | billing | same | same | n/a | own |
| `tokens.reasoning` | same | billing | same | same | separate from `output` (`reasoningRelation:'separate'`) | own |
| `tokens.cache.read` / `.write` | same | billing; read is part of the prompt | same | same | disjoint from `input` | own |
| `cost` | same, `StepFinishPart` | billing (provider-computed USD) | message / step | cumulative per message | n/a | own; `[UNCONFIRMED]` how OpenCode prices unknown models. Cretli does not read it. |
| `summary` (boolean) | `AssistantMessage` | marker | message | flag | n/a | `[DECLARED]` presumably flags a compaction summary message; semantics `[UNCONFIRMED]`. Cretli ignores it. |
| `limit.context` / `limit.output` | provider `Model` | context window | model | static | n/a | `[DECLARED]` |

There is no field that is a direct "current prompt occupancy" snapshot. Occupancy can only be inferred as `input + cache.read + cache.write` of the latest assistant message `[INFERRED]` (that is what the contract's `promptTokensForWindow` computes: 840 for the fixture; the arithmetic is `[OBSERVED]` in the test, the meaning is a Cretli contract assumption). Whether OpenCode's own context meter uses the same sum is `[UNCONFIRMED]`.

## 3. Adapter path

- `harnesses/opencode/opencode-usage.js`: `unwrapOpenCodeStreamEvent` (strips v2 `sync` wrapper and `.N` suffix), `readOpenCodeTokenSnapshot` (clamps negatives, reads `input`, `output`, `reasoning`, `cache.read`, `cache.write`), `noteOpenCodeMessageTokenDelta` (per-message-id diff), `resolveOpenCodeUsageFromStreamEvent`, `buildOpenCodeUsageSdkEvent`.
- `harnesses/opencode/opencode-agent-ws.js#noteOpenCodeUsageFromEvent`: keeps `room._openCodeTokensByMessageId`, accumulates `room._lastUsagePayload` (input/output only, running sum of deltas) and broadcasts `{type:'sdkEvent', event:{type:'usage', usage:{tokens}}}`.
- `lib/usage/usage-normalize.js#fromOpenCodeUsage` maps to the token bag: `input→textInput`, `cache.read→cachedInput`, `cache.write→cacheWrite`, `output→textOutput`, `reasoning→reasoning`.
- Contract entry: `lib/usage/usage-contract.js` `opencode` (snapshot, granularity `message`, identity `sourceSessionId`+`messageId`, `explicitContextEpoch:true`, window semantics `disjoint`).

Raw payload (sanitized, `tests/fixtures/usage/opencode/raw-message-updated-sequence.json`) → normalized (`normalized-token-bag.json`):
`{input:500,output:20,reasoning:5,cache:{read:300,write:40}}` → `{textInput:500,textOutput:20,cachedInput:300,cacheWrite:40,reasoning:5}`; the transform and arithmetic (`promptTokensForWindow=840`, `billedTotalTokens=865`) are `[OBSERVED]` on the sanitized fixture; that real OpenCode payloads have this disjoint shape is `[DECLARED]`/`[UNCONFIRMED]`.

## 4. Behaviour observed in Cretli (tests)

- `[OBSERVED]` successive `message.updated` snapshots of one message id produce deltas (500/10 then 0/10 + reasoning 5); an identical replay yields nothing.
- `[OBSERVED]` a shrinking snapshot (same message id) is clamped to zero: lower counters are dropped, not subtracted, and the stored baseline is overwritten with the lower value, so a later rise re-counts the difference. Whether OpenCode can actually emit shrinking snapshots is `[UNCONFIRMED]`.
- `[OBSERVED]` user messages and token-less events are ignored.
- `[OBSERVED]` `session.next.step.ended` is unwrapped from `sync` and diffed per `assistantMessageID`; without a message id the step bag itself is the delta (code path, not covered by a fixture).
- Risk (code reading): v1 `message.updated` and v2 `session.next.step.ended` for the same message id share one diff map, so a server emitting both is deduplicated; two different message ids for the same step would double count `[UNCONFIRMED]`.
- Risk: the `_lastUsagePayload` running sum omits cache and reasoning, so any consumer of it sees a partial total.
- Own vs consolidated: usage is per OpenCode session id filtered by `isOpenCodeEventForSession`. Sub-agent/child sessions of OpenCode (task tool) are separate sessions; whether their usage is rolled into the parent message is `[UNCONFIRMED]`.

## 5. Context window source

`[DECLARED]` `Model.limit.context` in the SDK provider catalog. Cretli reads it as `contextWindowTokens` in `opencode-server-manager.js` (model listing, `Number(limit.context)`) and `opencode-model-resolve.js`. It is the provider/model catalog value (or a user config override), not a measured number; actual effective window for a given provider/model/config is `[UNCONFIRMED]` here. `limit.context` is not attached to usage events.

## 6. Reset, resume, seed, compaction

- Fresh session: `ensureOpenCodeSession` creates one via `session.create`; the id is persisted with `setChatOpenCodeSessionId`. `[OBSERVED]` (code).
- Reset: clearing the client with `resetSession:true` empties `room.opencodeSessionId`, so the next prompt starts a fresh session (`opencode-agent-ws.js`). No usage `contextEpoch` is emitted on that path `[UNCONFIRMED]` (contract declares `explicitContextEpoch:true`).
- Resume: the persisted session id is reused; delegation resume goes through `lib/delegation-session-resume.js`. Cached per-message baselines live in the room, so a server restart loses them: the first snapshot after restart is counted in full `[INFERRED]`.
- Seed: no Cretli path seeds an OpenCode session with prior history `[ABSENT]` in the adapter.
- Native compaction: OpenCode compacts itself; Cretli tunes `auto`/`prune`/`reserved` in `harnesses/opencode/opencode-compaction-config.js` and writes them from `opencode-server-manager.js`. The same file exports `summarizeOpenCodeSession`, a wrapper over the native `POST /session/:id/summarize`; it has no production caller (only `harnesses/opencode/tests/opencode-compaction-config.test.js`), so Cretli never triggers compaction itself `[OBSERVED]` by grep. The SDK declares `session.compacted {sessionID}` and `session.summarize` `[DECLARED]`; Cretli does not subscribe to `session.compacted` and does not record a context restart for it `[ABSENT]`. After compaction the next assistant message's `input+cache` drops, which is the only visible signal.
- Recorded restarts (`recordContextRestart` callers for `harness:'opencode'`, grep of `harnesses/opencode` and `lib`): (1) `opencode-agent-ws.js` – Plan/Ask/agent system-prompt key change, reason `SYSTEM_PROMPT_CHANGE`; (2) `harnesses/opencode/mcp-opencode-sync.js` – MCP bridge config fingerprint change versus the previously applied one for the same client+directory, reason from `openCodeRestartReason`: `MCP_REVISION` (revision changed), else `MODE_CHANGE` (mode changed), else `MCP_CONTENT_CHANGE`. No restart is recorded for session reset, native compaction or server restart.

## 7. Findings

1. `input` excludes cache, so occupancy must add `cache.read` and `cache.write`; the contract already does this.
2. No dedicated occupancy field exists; occupancy is an inference.
3. Compaction and session reset are not surfaced as usage epochs.
4. The context window is a catalog value and is not attached to usage events.
5. `cost` is available but unused.
