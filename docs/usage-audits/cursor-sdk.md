# Cursor SDK (`@cursor/sdk`): usage and context telemetry audit

Read-only audit for TODO `7fca0b18` ("Audyt usage kontekstu: Cursor SDK"). This
leaf changes no production code, no adapter, no usage matrix and no shared
contract. It records **what the Cursor SDK actually returns**, **what Cretli
does with it**, and **what remains unconfirmed** because no live SDK run was
captured here.

Every claim carries at least one tag; when two independent sources support the
same statement both tags are listed. A claim whose tag is stronger than its
evidence is a defect in this document.

| Tag | Meaning |
| --- | --- |
| `[OBSERVED]` | Reproduced by a command run in this leaf against the working tree (commands in §11). |
| `[DECLARED]` | Only the type/shape from the installed SDK's `.d.ts`, cited with `file:line`. A declared type does not establish units or runtime semantics. |
| `[DOC]` | A claim from the official Cursor SDK documentation page (§1.2), fetched in this leaf. It is a provider claim, not behaviour observed in Cretli. |
| `[CONFLICT]` | Two evidence sources disagree; both are cited. |
| `[INFERRED]` | A conclusion from indirect evidence (naming, arithmetic, bundle strings). The basis is stated next to it. |
| `[UNCONFIRMED]` | Not established here. No value and no semantics are asserted. |
| `[ABSENT]` | Searched for and not found in the cited surface. |

## 1. Package, version, evidence base

### 1.1 Installed package

- `[OBSERVED]` the installed `@cursor/sdk` is **`1.0.40`**. `package.json` declares
  `"@cursor/sdk": "^1.0.37"` (dependency, not a pinned exact version), and the
  SDK itself declares `"engines": { "node": ">=22.13" }`.
- `[OBSERVED]` there is **no SDK CLI**: the package declares `"bin": null`; it is
  a Node library. The installed per-platform helper is
  `node_modules/@cursor/sdk-linux-x64` (optional dependency `1.0.40`), used by
  the local runtime for sandboxing/ripgrep. Cretli loads the library through
  `lib/sdk/cursor-sdk.ts` (dynamic `import('@cursor/sdk')`); the separate Cursor
  CLI product is not used.
- `[OBSERVED]` (`md5sum` of the files read) the evidence base is:
  - `node_modules/@cursor/sdk/dist/esm/usage-types.d.ts` — 2 379 bytes, md5 `14b42ca410a42079de7484c53ef8c2bb`
  - `node_modules/@cursor/sdk/dist/esm/messages.d.ts` — 3 577 bytes, md5 `0428cca9e94fa5db762178aae28764f3`
  - `node_modules/@cursor/sdk/dist/esm/agent.d.ts` — 6 909 bytes, md5 `6909b1f48ba1ef67af9156256c48e874`
- `[OBSERVED]` the local Node used for the fixture transform is `v24.14.0`
  (`node -v`). This is the runtime requirement, not a claim about the hosted model.
- `[UNCONFIRMED]` the release date of `1.0.40`. The SDK changelog
  (`https://cursor.com/release-notes/sdk`) was fetched but returned no versioned
  content in this leaf.

### 1.2 Official source

- `[OBSERVED]` the installed `node_modules/@cursor/sdk/README.md` names
  `https://cursor.com/docs/api/sdk/typescript` as the documentation link. This
  leaf read the SDK page at **`https://cursor.com/docs/sdk/typescript`**
  (fetched as `https://cursor.com/docs/sdk/typescript.md`) on **2026-10-19**
  (HTTP 200).
- `[DOC]` that page is **not versioned** and does not state which package
  versions it describes. Every `[DOC]` claim below is therefore "current page on
  2026-10-19", not "documentation for 1.0.40".
- `[OBSERVED]` the page documents the same six `TokenUsage` fields, the
  `SDKUsageMessage` event and `Agent.getUsage()` that the installed `.d.ts`
  declares, so the page and the installed declarations do not contradict each
  other on field names.

## 2. Transport, provider and auth variant in Cretli

- `[OBSERVED]` harness is **`sdk`** and provider is **`cursor`**
  (`lib/usage/harness-usage.js#HARNESS_PROVIDERS`).
- `[OBSERVED]` Cretli runs the **local runtime only**. `connectAgent()` passes
  `model`, `local: { cwd, dirs, settingSources, customTools, store, mcpServers }`,
  `mode` and `mcpServers` to `Agent.create()` / `Agent.resume()`
  (`lib/sdk/cursor-agent-sdk-ws.ts`). No `cloud`, `repos` or
  `cloud.envVars` option is constructed anywhere in the adapter (`grep -n cloud
  lib/sdk/cursor-agent-sdk-ws.ts` → no hits), so the Cloud (Cursor-hosted VM)
  variant documented in `[DOC]` §Overview is **not exercised**.
- `[OBSERVED]` auth is an **API key**, not an interactive session:
  `getEffectiveCursorApiKey()` reads `CURSOR_API_KEY` first, then the
  `cursorApiKey` field in Cretli settings (`lib/sdk/cursor-api-key.ts`).
  `Cursor.auth.login()` is never called.
- `[DOC]` "Local describes where the agent loop and filesystem access run, not
  where the model runs. All inference goes through Cursor's hosted models in
  both modes." So "local" does not mean a local model.
- `[OBSERVED]` the transport between Cretli and the SDK is an in-process
  `AsyncGenerator<SDKMessage>` (`run.stream()` loop in `runPrompt()`,
  `lib/sdk/cursor-agent-sdk-ws.ts`),
  not HTTP from the adapter. Each message is broadcast to the browser as
  `{ type: 'sdkEvent', event: jsonSafe(event), roomEventSeq }`
  (`pushRoomEvent` → `broadcastRoom`, `lib/sdk/cursor-agent-sdk-ws.ts`).
- `[OBSERVED]` Cretli **never calls `agent.getUsage()` or `Agent.getUsage()`**
  (`grep -rn "\.getUsage\b\|getUsage(" lib app_front server.js tests` → no hits).
  The only token path is the streamed `SDKUsageMessage`.

## 3. Adapter path and exact field names

### 3.1 Raw boundary

`[DECLARED]` the forwarded message is `SDKUsageMessage` (`[OBSERVED]`: the
adapter forwards every stream message unchanged as `sdkEvent`):

```ts
// node_modules/@cursor/sdk/dist/esm/messages.d.ts — SDKUsageMessage
/** Per-turn token usage, emitted once at turn end when the runtime reported usage. */
export interface SDKUsageMessage {
    type: "usage";
    agent_id: string;
    run_id: string;
    usage: TokenUsage;
}
```

`TokenUsage` (`dist/esm/usage-types.d.ts`):

```ts
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
}
```

### 3.2 Cretli filter and mapping

- `[OBSERVED]` `rememberRoomUsagePayload()` (`lib/sdk/cursor-agent-sdk-ws.ts`)
  accepts a payload only when `payload.type === 'sdkEvent'`,
  `event.type === 'usage'` and `event.usage` is an object. It then calls
  `recordHarnessUsageSnapshot(room, 'sdk', event.usage, record)`.
  It reads **only** `event.usage`; `agent_id` and `run_id` are not used for
  identity or normalization.
- `[OBSERVED]` `fromSdkUsage()` (`lib/usage/usage-normalize.js`) maps:

| SDK field | Canonical bag field | Transformation |
| --- | --- | --- |
| `inputTokens` | `textInput` | `toCount` (finite, positive, else 0) |
| `outputTokens` | `textOutput` | `toCount` |
| `cacheReadTokens` | `cachedInput` | `toCount` |
| `cacheWriteTokens` | `cacheWrite` | `toCount` |
| `reasoningTokens` | `reasoning` | `toCount` |
| `totalTokens` | *(dropped)* | **not stored**; the contract layer recomputes derived totals |

- `[OBSERVED]` the ledger treats the stream as **cumulative within a run**:
  `recordHarnessUsageSnapshot()` diffs the new bag against
  `room._lastRecordedUsageTokens` and records only the difference
  (`lib/usage/harness-usage.js`; `beginHarnessRun()` resets
  the baseline). A late snapshot after `sdkRunFinished` still records a delta and
  never mints a second run event (covered by `tests/usage-cursor-sdk.test.js`).

## 4. Raw and normalized payload shapes

### 4.1 Raw adapter payload (sanitized fixture)

`tests/fixtures/usage/cursor-sdk/raw-sdk-usage-message.json`:

```json
{
  "type": "sdkEvent",
  "event": {
    "type": "usage",
    "agent_id": "agent-fixture-local-0001",
    "run_id": "run-fixture-local-0001",
    "usage": {
      "inputTokens": 1200,
      "outputTokens": 80,
      "cacheReadTokens": 900,
      "cacheWriteTokens": 50,
      "totalTokens": 2230,
      "reasoningTokens": 20
    }
  }
}
```

`totalTokens` is `input + output + cacheRead + cacheWrite` per the SDK's own
implementation (§5.2). The fixture is synthetic; it is not a captured live run.

### 4.2 Normalized token bag

`tests/fixtures/usage/cursor-sdk/normalized-sdk-token-bag.json` (the documented
transform `fromSdkUsage(raw.event.usage)`):

```json
{
  "tokens": {
    "textInput": 1200,
    "textOutput": 80,
    "audioInput": 0,
    "audioOutput": 0,
    "cachedInput": 900,
    "cacheWrite": 50,
    "reasoning": 20
  }
}
```

### 4.3 Normalized canonical event (shape only)

`[OBSERVED]` `createUsageEvent({ harness: 'sdk', provider: 'cursor', tokens, runId,
sourceSessionId, turnId })` (`lib/usage/usage-event.js`) adds the
contract block. With the bag above and all identity inputs present the block is:

```json
{
  "provider": "cursor",
  "feature": "chat",
  "harness": "sdk",
  "role": "chat",
  "eventType": "delta",
  "usageShape": "resolved",
  "measurementKind": "snapshot",
  "granularity": "turn",
  "inputIncludesCache": true,
  "reasoningRelation": "subset_of_output",
  "provenance": "reported",
  "accountingScope": "own",
  "lifecycle": "running",
  "completeness": "partial",
  "identityClass": "durable_sequence",
  "tokens": {
    "textInput": 1200,
    "textOutput": 80,
    "audioInput": 0,
    "audioOutput": 0,
    "cachedInput": 900,
    "cacheWrite": 50,
    "reasoning": 20
  }
}
```

`[OBSERVED]` `id` and `at` are generated per event, so they are omitted here.
`contextEpoch` is absent on this path because the Cursor SDK adapter never
advances the room epoch (it only calls `recordContextRestart()`, §7); the field
would appear only if a Cretli-local epoch had been set.

## 5. Field classification

### 5.1 Classified table

`Billing/run` = a quantity that is accounted or billed. `Occupancy?` = a
candidate numerator for "how full is the current prompt/context window". The SDK
returns **no field that unambiguously states occupancy** (§6).

| Field | Billing/run vs occupancy | Granularity | Shape | Cache relation | Own vs consolidated | Stale/compaction behaviour | Tag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `usage.inputTokens` | Billing **and** the only occupancy candidate (prompt size for that call) | **turn** (per `SDKUsageMessage`) | per SDK docs a per-turn value; **Cretli assumes cumulative within a run and diffs it** | SDK implementation treats it as **disjoint** from cache read/write; Cretli contract declares **inclusive** (`payloadInputIncludesCache: true`) | own (stream message; subagent inclusion unconfirmed) | no reset marker in the payload; Cretli resets its diff baseline per run (the baseline key includes the epoch, but the SDK adapter never advances it — §7) | `[CONFLICT]` |
| `usage.outputTokens` | Billing only; never occupancy | turn | same as above | contains `reasoningTokens` as a subset | own (same caveat) | — | `[DECLARED]`/`[DOC]` |
| `usage.cacheReadTokens` | Billing **and** occupancy component (the cached prefix) | turn | same as above | read of the prompt cache; occupies the window | own | — | `[DECLARED]`/`[DOC]` |
| `usage.cacheWriteTokens` | Billing **and** occupancy component (creation of the prefix) | turn | same as above | writes the prompt cache | own | — | `[DECLARED]`/`[DOC]` |
| `usage.totalTokens` | Billing-period total; **not** occupancy (no window denominator) | turn | **derived**, not a measured counter | per SDK `total = input + output + cacheRead + cacheWrite`; excludes reasoning | own | — | `[OBSERVED]` (bundle) + `[DOC]` |
| `usage.reasoningTokens` | Billing diagnostic; must not be added again | turn | same as above | subset of `outputTokens`; already inside `outputTokens` | own | — | `[DECLARED]`/`[DOC]` |
| `event.agent_id` | identity only | agent (durable) | opaque id | none | identity | survives resume (`Agent.resume`) | `[DECLARED]` |
| `event.run_id` | identity only | run | opaque id | none | identity (not used by the ledger; Cretli mints its own durable run id) | — | `[OBSERVED]` (see §8, F8) |
| `event.type` | routing only | message | tag `"usage"` | none | — | — | `[DECLARED]` |
| `Run.usage` / `RunResult.usage` (not consumed) | Billing run total; **not** occupancy (cumulative tokens are not a window fill) | **run** | **cumulative across turns** (`dist/esm/run.d.ts`) | inherited from turn usage | own run | — | `[DECLARED]`/`[DOC]` |
| `AgentUsage.usage` / `.runs[]` (not consumed) | Billed record; not occupancy | agent / run (cloud), turn-group (local) | cumulative | inherited | cloud totals are **consolidated** (include Task subagents and side chats); `runs[]` stays per-run | cost absent until the backend settles | `[DECLARED]`/`[DOC]` |
| `UsageCost.rawCostCents` / `chargedCents` (not consumed) | Billing only | run / agent | eventually consistent | none | follows the row it is attached to | cost can lag after the run ends | `[DECLARED]`/`[DOC]` |

### 5.2 Why `totalTokens` proves the cache relation

`[OBSERVED]` the installed bundle computes both `toTokenUsage()` and
`sumTokenUsage()` with `totalTokens: inputTokens + outputTokens + cacheReadTokens +
cacheWriteTokens` (`node_modules/@cursor/sdk/dist/esm/index.js`, symbol
`toTokenUsage`). The `turn-ended` builders in `dist/esm/448.js` and `index.js`
call that helper (`rr.q(t.usage)`). `[DOC]` the official Token usage table states
the same formula and says reasoning is excluded because it is already inside
`outputTokens`.

`[INFERRED]` if `inputTokens` already contained cache reads/writes (Cretli's
`payloadInputIncludesCache: true`), that sum would double-count the cached
prefix. The SDK's own arithmetic therefore implies **`inputTokens` is disjoint
from `cacheReadTokens`/`cacheWriteTokens`**. This is a contradiction with the
Cretli matrix entry, not with the installed declarations; see §8 F2.

### 5.3 Own vs consolidated scope

- `[OBSERVED]` Cretli marks every SDK snapshot `accountingScope: 'own'` unless
  `room.delegationAccountingScope === 'consolidated'`
  (`lib/usage/harness-usage.js#baseUsagePartial`). That is a Cretli routing
  decision, not a provider statement.
- `[DOC]` for `getUsage()` on a **cloud** agent, the totals count the agent's
  Task subagents and side chats and "can be larger than the sum of `runs`"; with
  `runId`, the totals count subagent/side-chat usage from the run start to the
  next run start. For **local** agents, entries are per-turn groups keyed by a
  usage UUID, and events without a UUID count toward totals only.
- `[UNCONFIRMED]` whether one `SDKUsageMessage` (a turn) already includes tokens
  spent by a `task` subagent in that turn. The docs describe `getUsage()` scope
  but do not state the stream message's subagent policy, and no live payload was
  captured.

## 6. Context window: source and meaning

### 6.1 The usage payload carries no context window

- `[ABSENT]` `TokenUsage`, `RunUsage`, `AgentUsage`, `SDKUsageMessage`,
  `ModelSelection`, `ModelListItem` contain no `contextWindow`,
  `contextWindowTokens`, occupancy or max-tokens field
  (`grep -rn "contextWindow\|contextLimit" node_modules/@cursor/sdk/dist/esm/*.d.ts`
  → no hits).
- `[DOC]` the official page documents token counts, `run.usage` and
  `getUsage()`; it does **not** document a context-window or occupancy value
  (grep of the fetched page for `context window`, `context limit`, `compaction`
  → no topic section). `[UNCONFIRMED]` whether any other Cursor SDK page
  documents one; not searched exhaustively.
- `[INFERRED]` an internal runtime field named `context_window_size` appears
  only in the minified bundle next to `messages_to_compact` and `preCompact`
  (`node_modules/@cursor/sdk/dist/esm/464.js`; see the §7 native-compaction row).
  It is not part of the published type surface and Cretli does not read it.

### 6.2 What Cretli uses instead

- `[OBSERVED]` `getModelContextWindowTokens()` (`lib/sdk/sdk-context-advisory.ts`)
  resolves the denominator in this order:
  1. a runtime-discovered value from `setDynamicModelContextWindows()` — populated
     by OpenCode model metadata, **not** by the Cursor SDK;
  2. a `context=` parameter on the model variant (e.g. `grok-4.7::context=500k`);
  3. a **hardcoded prefix table**: `gpt-5`/`composer-2` 272 000,
     `claude-opus-5`/`claude-sonnet-5` 1 000 000, `claude-haiku-5`/`claude-*-4`
     200 000, `gemini-3`/`gemini-2` 1 048 576, `kimi-k2` 256 000, `glm-5`
     128 000, `grok-4.6`/`grok-4.5` 500 000, `grok-` 256 000,
     `x-preview-f-free` 1 000 000, `hy3-free` 190 000;
  4. otherwise `null`, which suppresses the percentage.
- `[OBSERVED]` the doc comment on `getModelContextParamWindowTokens()` in
  `lib/sdk/sdk-context-advisory.ts` records
  that Cursor model rows carry no `contextWindowTokens`; the code confirms a
  Cursor-specific fallback to the static table.
- `[INFERRED]` therefore, for the tested provider/model/config (Cretli + Cursor
  local SDK), the context window is a **Cretli estimate from a static prefix
  table or an explicit variant parameter**, not a value reported by the SDK.

### 6.3 What Cretli uses as the numerator

- `[OBSERVED]` live: `resolveLiveContextUsageInputTokens()` returns
  `room.lastUsageInputTokens` (`lib/sdk/sdk-context-advisory.ts`).
  The room value is built in `getSdkRoomDiag()` as
  `estimateEffectiveUsageInputTokens(inputTokens, cacheReadTokens)`, i.e.
  `input - cacheRead` when `0 < cacheRead < input`
  (`lib/sdk/cursor-agent-sdk-ws.ts`).
- `[OBSERVED]` reload: `summarizeChatHistoryUsage()` stores
  `lastEffectiveUsageInputTokens` with the same subtraction
  (`lib/persist/chat-history-usage.js`), and the route prefers it
  (`lib/routes/chats-routes.js`, context-pressure assessment).
- `[OBSERVED]` the percentage is
  `Math.round((used / window) * 1000) / 10`
  (`buildContextPressureAssessment`, `lib/sdk/sdk-context-advisory.ts`).
- `[INFERRED]` consequence: the number labelled "context" is the **non-cached
  share of the last call's input**, divided by a static window. It is neither
  the full prompt (cache read still occupies the window) nor a provider-measured
  occupancy. Which direction the error goes depends on the unresolved cache
  relation (§8 F2): under the disjoint interpretation the SDK's `inputTokens`
  is already the non-cached part, so subtracting `cacheRead` again (when it is
  smaller) removes real prompt tokens; under the inclusive interpretation the
  subtraction removes the cached prefix from a total that did contain it. Either
  way the displayed fraction is an estimate, not a measurement.
- `[OBSERVED]` there is no `context_usage`-style event on the Cursor SDK path:
  the adapter handles only `type === 'usage'`; `summarizeChatHistoryUsage()`
  looks for `context_usage` but the SDK adapter never emits it
  (`lib/sdk/cursor-agent-sdk-ws.ts` has no `context_usage` producer).

## 7. Fresh session / reset / resume / seed / native compaction

| Capability | What exists | Cretli behaviour | Tag |
| --- | --- | --- | --- |
| **Fresh session** | `Agent.create()` returns a handle with a new `agent-<uuid>`; "a new `Agent.create()` always starts a fresh agent with a new `agentId`" | Called when there is no persisted `chat.sdkAgentId` (first use, or after a detected model change cleared the binding — see the Reset row) or when `Agent.resume()` throws (`connectAgent()`, `lib/sdk/cursor-agent-sdk-ws.ts`). New agent = fresh conversation. | `[OBSERVED]`/`[DOC]` |
| **Resume** | `Agent.resume(agentId, options)`; local conversation state loads from the checkpoint store, cloud from the service | Called with the persisted id; on failure it falls through to `Agent.create()` (the resume fallback in `connectAgent()`, `lib/sdk/cursor-agent-sdk-ws.ts`). `local.store` is set to the SDK's `JsonlLocalAgentStore` (`ensureSessionLocalStore`). | `[OBSERVED]`/`[DOC]` |
| **Reset (drop context)** | No `reset()`/`clear()` on `SDKAgent` in 1.0.40 (`dist/esm/agent.d.ts`) | Partial only, and the two start-input paths differ. **Model change:** `shouldSkipSdkAgentResumeForModelChange()` detects it against the live room's `_agentModelId` and `clearSdkAgentBinding()` (called from `connectAgent()`) closes the handle and clears `chat.sdkAgentId` via `setChatSdkAgentId(..., null)`; `persistedId` is then empty and the next prompt calls `Agent.create()`, i.e. a new agent. **Mode / system-prompt / MCP-revision change:** the handle is closed and `recordContextRestart()` is called, but `chat.sdkAgentId` is **not** cleared, so the next prompt still computes `persistedId` and calls `Agent.resume(persistedId, ...)` (falling back to `Agent.create()` only if the resume throws). That case is **not** a guaranteed fresh session. | `[OBSERVED]`/`[ABSENT]` |
| **Seed** | No public seed/initial-conversation option on `AgentOptions`; `initialState?: ConversationStateStructure` exists only on the internal `executor-types.d.ts` | Cretli never passes a seed. The first turn is always a normal `send()`. | `[ABSENT]`/`[OBSERVED]` |
| **Native compaction** | Not documented on the SDK page and not typed in `dist/esm/*.d.ts`. The bundled runtime contains a `preCompact` hook name and proto fields `message_count_at_last_compaction`, `messages_to_compact`, `is_first_compaction`, `context_window_size` (`dist/esm/464.js`) | Cretli does not subscribe to `preCompact` and does not read `context_window_size`. Its own "auto compression" is a client-side map-reduce over chat history (`lib/context-compression*.js`), not SDK compaction. | `[INFERRED]`/`[UNCONFIRMED]` |
| **Context epoch** | No epoch/reset marker in the usage payload | Two separate mechanisms. `recordContextRestart(input)` (`lib/usage/context-restarts.js`) only appends a ledger event and calls `notifyContextInvalidation()`; it does **not** touch `room._contextEpoch`. The epoch is advanced only by `advanceRoomContextEpoch(room, reason)` (same module), which sets `room._contextEpoch = current + 1`. The Cursor SDK adapter calls `recordContextRestart()` on model/mode/system-prompt/MCP/process rebuilds in `connectAgent()` (`lib/sdk/cursor-agent-sdk-ws.ts`) but never calls `advanceRoomContextEpoch()`, so the epoch stays unset on this path. When an epoch is set, the snapshot baseline key includes it (`buildHarnessBaselineKey()`, `lib/usage/harness-usage.js`) and the persisted event carries it (`baseUsagePartial()`, same module). | `[OBSERVED]` |
| **Billed usage (`getUsage`)** | `agent.getUsage()` / static `Agent.getUsage(agentId)` exist (`dist/esm/agent.d.ts`) | **Never called by Cretli.** `[DOC]` local-agent usage is enabled per account; until then it returns `403 feature_unavailable` as `UnknownAgentError` with `code === "feature_unavailable"`. | `[OBSERVED]`/`[DOC]` |

## 8. Provider claims vs Cretli behaviour vs unconfirmed

### 8.1 Confirmed by Cretli code

- The only Cursor SDK token source is `SDKUsageMessage`; `getUsage()`,
  `Run.usage` and `RunResult.usage` are ignored.
- The six `TokenUsage` fields are mapped one-to-one into the canonical bag and
  `totalTokens` is dropped.
- Snapshot values are diffed against the previous value **within the same run**,
  and the baseline is reset by `beginHarnessRun()` (new run / reconnect).
- The persisted canonical event declares `usageShape: resolved`,
  `measurementKind: snapshot`, `granularity: turn`,
  `payloadInputIncludesCache: true`, `bagInputIncludesCache: true`,
  `reasoningRelation: subset_of_output`, `cacheRead: true`, `cacheWrite: true`,
  `defaultIdentityClass: durable_sequence`, `explicitContextEpoch: true`
  (the `sdk` entry in `USAGE_HARNESS_MATRIX`, `lib/usage/usage-contract.js`).
- `[OBSERVED]` `explicitContextEpoch: true` is only a declaration. On this path
  the adapter records restarts but never advances `room._contextEpoch`, so the
  persisted event carries no `contextEpoch` (§7).
- The context window is not read from the payload; it comes from
  `getModelContextWindowTokens()` (static table / `context=` variant) and the
  denominator is therefore an estimate.
- The context numerator is `inputTokens - cacheReadTokens` (when
  `0 < cacheReadTokens < inputTokens`), both live and after reload.
- A late `usage` after `sdkRunFinished` is recorded as a token delta inside the
  24 h final-usage window and never creates a second run
  (`tests/usage-cursor-sdk.test.js`).

### 8.2 Provider documentation claims (fetched 2026-10-19)

- `[DOC]` `SDKUsageMessage` "is emitted once at the end of each turn that
  reported token usage, carrying **that turn's** `TokenUsage`. The cumulative
  total across turns stays on `run.usage` and `result.usage`."
- `[DOC]` `totalTokens = inputTokens + outputTokens + cacheReadTokens +
  cacheWriteTokens`, excluding `reasoningTokens`; `reasoningTokens` is a subset
  of `outputTokens`.
- `[DOC]` "Token counts are what the runtime reports; they say nothing about
  cost." Billed cost comes from `getUsage()`, which is `[DOC]` "eventually
  consistent" and can lag after a run ends.
- `[DOC]` `getUsage()` on cloud counts Task subagents and side chats; local is
  per-turn groups keyed by usage UUID; local usage is gated per account.
- `[DOC]` `Agent.resume(agentId)` reloads conversation state from the local
  checkpoint store or the cloud; a new `Agent.create()` always starts fresh.
- `[DOC]` no context-window or compaction field is documented on the SDK page.

### 8.3 Unconfirmed in this leaf

- `[UNCONFIRMED]` whether a real local run emits **one** `usage` message per run
  or one per turn. The docs say per turn; Cretli diffs successive messages as if
  they were cumulative. No live run was captured, so the real cadence is not
  established here.
- `[UNCONFIRMED]` the true `inputTokens` / cache relation from a live payload.
  The SDK's arithmetic implies disjoint; the Cretli matrix declares inclusive.
- `[UNCONFIRMED]` whether the stream message includes subagent/side-chat tokens.
- `[UNCONFIRMED]` whether the context meter's numerator matches any provider
  concept of occupancy for Cursor models.
- `[UNCONFIRMED]` native compaction behaviour, its trigger threshold, and
  whether it resets the usage counters.

## 9. Findings (recorded, not fixed)

**F1 — Per-turn vs cumulative `[CONFLICT]`.** `[DOC]` says each
`SDKUsageMessage` carries *that turn's* usage; `[OBSERVED]` Cretli diffs
successive messages within a run (`recordHarnessUsageSnapshot`). If a run has
more than one turn (background-subagent follow-up turns are documented to keep
yielding on the same run), the diff can under-count every later turn. If the
runtime really emits one cumulative snapshot per turn, the diff is correct. No
live payload settles this; the audit marks it unconfirmed.

**F2 — Cache relation `[CONFLICT]`.** The SDK's `toTokenUsage` and its published
formula add `input + output + cacheRead + cacheWrite`, which implies `input` is
disjoint from cache. The Cretli matrix sets `payloadInputIncludesCache: true`
and `bagInputIncludesCache: true`, so `partitionUsageTokens()` subtracts cache
from `textInput` (`lib/usage/usage-contract.js`). For the §4 fixture the
two views diverge numerically:

| Quantity | Disjoint view (SDK formula) | Cretli contract view |
| --- | --- | --- |
| SDK `totalTokens` | 2 230 | (dropped by `fromSdkUsage`) |
| `inputWithoutCache` | 1 200 | 1 200 − 900 − 50 = **250** |
| `promptTokensForWindow` | 1 200 + 900 + 50 = **2 150** | **1 200** |
| `billedTotalTokens` | 1 200 + 900 + 50 + 60 + 20 = **2 230** | 250 + 900 + 50 + 60 + 20 = **1 280** |

The contract numbers are what Cretli records today (`[OBSERVED]`, §11). They are
not proven wrong here, but they rest on the inclusive assumption the SDK
arithmetic contradicts. Marked unconfirmed until a real payload is captured.

**F3 — Identity class `[CONFLICT]`.** The matrix declares
`defaultIdentityClass: 'durable_sequence'` with
`identityFields: ['runId', 'sourceSessionId', 'turnId']`. `[OBSERVED]`
`recordHarnessUsageSnapshot()` passes only `baselineKey` and `snapshotTokens` to
`buildHarnessDeltaUsage()`; no `requestId`/`messageId`/`turnId`/`eventId` is
supplied, and `room._currentTurnId` is read in `buildHarnessBaselineKey()` but is
never assigned anywhere in `lib/`. With `runId` and `sourceSessionId` present but
no source event id, `buildLogicalUsageIdentity()` returns
`identityClass: 'none'`, `logicalEventKey: null`. The snapshot is still
idempotent through `baselineKey`/`snapshotTokens`, but the declared identity
class is not what the snapshot path produces. (When the event is built by hand
with `turnId`, the class becomes `durable_sequence`; the audit fixture test does
that only to assert the contract fields.)

**F4 — Context numerator is not occupancy `[INFERRED]`.** The meter uses
`inputTokens - cacheReadTokens` over a static window. The cache read is exactly
the cached prefix that still occupies the window, so the displayed percentage
understates prompt occupancy by the cached share. This is a modelling choice,
not a provider measurement, and it is labelled as "Estimated context" only when
the value is an estimate from text, not when it is a run measurement
(`formatContextUsageLabel`, `lib/sdk/sdk-context-advisory.ts`).

**F5 — Window denominator is unverified `[INFERRED]`.** The static prefix table
is the only denominator for models without a `context=` parameter, and the
installed SDK does not report a window. Any percentage for such a model is a
static-table estimate; a wrong table entry makes every percentage for that model
wrong by the same factor.

**F6 — Cost is unavailable on the consumed path `[OBSERVED]`.** The stream
message carries no `cost`; `UsageCost` exists only on `RunUsage`/`AgentUsage`
from `getUsage()`, which Cretli never calls. Cretli therefore records token
counts and prices them from its own rate table; it cannot record
provider-reported `chargedCents` for Cursor SDK runs.

**F7 — Late/stale snapshots are handled by the ledger, not the adapter
`[OBSERVED]`.** A `usage` arriving after `sdkRunFinished` is turned into a token
delta and, inside `USAGE_FINAL_USAGE_GRACE_MS` (24 h), the ended run's coverage
is corrected without changing the run count; past the window it is a `stale`
diagnostic. This is ledger behaviour (`lib/usage/usage-ledger.js`,
`lib/usage/harness-usage.js`), not something the SDK signals.

**F8 — SDK `run_id` is not the ledger `runId` `[OBSERVED]`.** `sdkPromptStarted`
has no `runId`; `beginHarnessRun()` mints/persists one through `beginUsageRun()`
(`lib/usage/harness-usage.js`). The `SDKUsageMessage.run_id` is ignored by
`rememberRoomUsagePayload()`. Both ids exist in different places
(`room._runId` vs `room.lastRunId`), so joining a Cursor SDK run id to a Cretli
usage event is not possible from the normalized event alone.

## 10. What the next leaves may rely on

- Rely on the field names and types in §3.1/§5; they are declared and installed.
- Rely on the mapping and bucket arithmetic in §4 and §11; they are reproduced
  by `tests/usage-audit-cursor-sdk.test.js`.
- Rely on the absence of a context-window/occupancy field in the usage payload.
- Do **not** treat `measurementKind: snapshot`, `inputIncludesCache: true` or
  `promptTokensForWindow()` for `sdk` as confirmed provider semantics; they are
  Cretli contract declarations contradicted by the SDK's own arithmetic (F2).
- Do **not** treat Cretli's "context %" for a Cursor SDK chat as a measured
  occupancy (F4/F5).
- Do **not** build on `getUsage()` or `Run.usage` before a live capture proves
  the account has the local-usage feature enabled and that the values match the
  stream totals.

## 11. Reproducing the evidence

Commands run in this leaf (working tree root):

```bash
node -e "console.log(require('./node_modules/@cursor/sdk/package.json').version)"
md5sum node_modules/@cursor/sdk/dist/esm/usage-types.d.ts \
       node_modules/@cursor/sdk/dist/esm/messages.d.ts \
       node_modules/@cursor/sdk/dist/esm/agent.d.ts
grep -n "interface TokenUsage" -A8 node_modules/@cursor/sdk/dist/esm/usage-types.d.ts
grep -n "SDKUsageMessage" -A6 node_modules/@cursor/sdk/dist/esm/messages.d.ts
grep -n "getUsage" -A12 node_modules/@cursor/sdk/dist/esm/agent.d.ts
grep -rn "\.getUsage\b\|getUsage(" lib app_front server.js tests   # -> no SDK getUsage call
grep -rn "contextWindow\|contextLimit" node_modules/@cursor/sdk/dist/esm/*.d.ts  # -> no hits
grep -roh ".\{200\}totalTokens:.\{100\}" node_modules/@cursor/sdk/dist/esm/*.js | head
node --input-type=module -e "import { fromSdkUsage } from './lib/usage/usage-normalize.js'; import { partitionUsageTokens } from './lib/usage/usage-contract.js'; const t = fromSdkUsage({inputTokens:1200,outputTokens:80,cacheReadTokens:900,cacheWriteTokens:50,totalTokens:2230,reasoningTokens:20}); console.log(JSON.stringify(t)); console.log(JSON.stringify(partitionUsageTokens(t,'sdk')));"
node tests/usage-audit-cursor-sdk.test.js
```

The official page was read from `https://cursor.com/docs/sdk/typescript.md` on
2026-10-19. Nothing under `data/` was read for this audit; no real chat,
transcript or credential was inspected.

## 12. Fixtures and guard test

| Artifact | Purpose |
| --- | --- |
| `tests/fixtures/usage/cursor-sdk/raw-sdk-usage-message.json` | Sanitized raw `sdkEvent`/`SDKUsageMessage` shape used by the transform. |
| `tests/fixtures/usage/cursor-sdk/normalized-sdk-token-bag.json` | Expected `fromSdkUsage()` output for that raw payload. |
| `tests/fixtures/usage/cursor-sdk/raw-sdk-usage-cumulative-sequence.json` | Two snapshots in one run plus the expected diffs Cretli records. |
| `tests/usage-audit-cursor-sdk.test.js` | Hermetic `node:test` guard: `containsConversationContent` on every fixture, the documented transform, the contract fields, and this document's SDK version. |

All fixtures are synthetic and machine-generated. They contain only type tags,
opaque ids and token counts; no conversation text, prompt, reply, transcript,
tool payload, credential or personal path. They pass
`containsConversationContent()` from `lib/usage/usage-contract.js`.
