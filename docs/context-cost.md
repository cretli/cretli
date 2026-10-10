# Context cost: native trimming and cold-cache session restarts

Status: decision record for leaf `88b9cd24` (deterministic trimming of old tool
results). Supersedes the original "trim history in place" plan after the
7-harness audit.

## 1. Decision

Cretli **never rewrites the history of a live harness session**. Every harness
keeps an opaque session that Cretli cannot rewrite:

- `sdk` (Cursor SDK), `claude` (resume), `codex` (thread) keep server-side
  transcripts keyed by a session/thread id.
- `qwen`, `opencode`, `deepseek`, `codebuddy` keep their own internal stores.

There is no supported seam for editing past messages, so any client-side
"history surgery" would desynchronise Cretli's view from what the provider
actually sends. It is not built. The cost lever has two parts instead:

1. **Native deterministic trimming, configured per harness** (section 2). The
   harness does the trimming itself, deterministically and without an LLM.
2. **Cold-cache new session with a stub-trimmed summary** (section 3), the only
   Cretli-side lever for `sdk`, `claude` and `codex`.

## 2. Native per-harness trimming (already configured)

These are configuration surfaces, not history rewrites. Each module resolves
env override → setting → shipped default.

| Harness | Native knob | Module / doc |
| --- | --- | --- |
| `opencode` | `compaction.prune` (deterministic tool-output prune, no LLM), `compaction.auto` | [`lib/opencode/opencode-compaction-config.js`](../lib/opencode/opencode-compaction-config.js) |
| `qwen` | `context.clearContextOnIdle` (idle/size-based tool-result clear), `context.autoCompactThreshold` | [`lib/qwen/qwen-context-settings.js`](../lib/qwen/qwen-context-settings.js) |
| `deepseek` | lowered DSH compaction threshold (fires earlier than the default 0.8) | [`lib/deepseek/deepseek-compaction-config.js`](../lib/deepseek/deepseek-compaction-config.js) |
| `codebuddy` | built-in tool-result masking | CodeBuddy CLI; no Cretli rewrite |
| `codex` | opt-in `model_auto_compact_token_limit` / `model_post_turn_compact_threshold_percent` | [`lib/codex/codex-compaction-config.js`](../lib/codex/codex-compaction-config.js), [`docs/codex/COMPACTION.md`](./codex/COMPACTION.md) |

These are OFF unless a setting or env asks for them, except where the harness
ships its own default.

## 3. Cold-cache new session with a stub-trimmed summary

For `sdk`, `claude` and `codex` the only Cretli-side option is to start a **new
session** whose **first prompt** is a deterministic, stub-trimmed view of the
old history. Implemented in
[`lib/context/stub-trim.js`](../lib/context/stub-trim.js).

### 3.1 Stub format

Old, large tool results (long `cat`/log/diff output) are replaced by:

```
[trimmed tool result: <tool> · <chars> chars omitted]
cretli-ref chat=<chat-uuid> seq=<seq>
```

The second line is a valid `cretli-ref` pointer that an agent can load with MCP
`chat_event({ chat, seq, field: "text" })`. `readStubTrimPointer(stub)` parses
it back. User messages and assistant answers are always kept verbatim; small
tool results and the newest `keepRecentToolResults` results are kept verbatim.

`buildStubTrimmedHistory(events, options)` is pure: no I/O, no LLM, no clock,
never mutates its input. `events` are the persisted `{ seq, rec }` rows used by
`lib/context-compression-source.js`. The result is bounded by `maxEvents` and
`maxPromptChars` (see `STUB_TRIM_LIMITS`), so a single huge history cannot blow
up the first prompt.

### 3.2 Gate predicate

`resolveStubTrimGate` / `shouldStubTrimForNewSession` allow the trimmed new
session only when:

- the prompt cache is **cold**, per
  [`lib/usage/cache-state.js`](../lib/usage/cache-state.js)
  `estimateCacheState` (TTL expiry, context-epoch change, or a recorded
  restart/compaction invalidation), **or**
- the **estimated context tokens** meet the configured
  `contextTokenThreshold`.

It is denied when the cache is warm and the context is below the threshold. The
gate accepts no elapsed-time input of its own; a long pause only matters through
`estimateCacheState`, which owns the provider TTL logic. An `unknown` cache
state (harnesses with no documented TTL) is not treated as cold, so it needs the
context threshold to authorize a restart.

### 3.3 Safeguard

The trimmed envelope is marked `target = "new_session_first_prompt"` and
`persisted = false`. `assertNewSessionOnlyStubTrim(output)` throws unless both
hold, so the value cannot be fed back into a live session or written to a store.
No persisted event is modified: the function only reads the input and builds
fresh objects for stubbed rows.

## 4. Out of scope

- No client-side editing of a live session's history in any harness.
- No LLM summarisation in this path. LLM-based context compression already lives
  in `lib/context-compression.js` and its run service.
- No Settings/config.json change: the gate threshold and trim bounds are
  parameters with shipped defaults, not new persisted settings.
