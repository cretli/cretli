# Context compression: decision table per harness

Evidence base: the per-harness audits in `docs/usage-audits/*.md` and the code
named below. Resume alone never proves an emptied window: a resumed session
reloads the transcript, so only a **new session id** plus a **seed** counts as
a fresh context.

## Decision table

| Harness | Native compaction | Auto summarize + fork + reset + seed | Notes / evidence |
| --- | --- | --- | --- |
| Cursor SDK (`sdk`) | Unconfirmed (hook names / proto fields only, `docs/usage-audits/cursor-sdk.md` §7) | **Yes — the only auto-enabled path** (`agentTransport === 'sdk'`) | Reset = `POST /api/chats/:id/reset-sdk-context` (new `cursorSessionId`, `sdkAgentId` dropped); seed is injected into the next send |
| Claude | Yes, automatic (`compact_boundary`); epoch advanced in `claude-agent-ws.ts` | No (respect native) | Manual trigger from Cretli unconfirmed |
| Codex | Yes, automatic (`compacted` rollout record, `docs/codex/COMPACTION.md`) | No (respect native) | Manual trigger unconfirmed |
| CodeBuddy | Yes, automatic (`compact_boundary`) | No (respect native) | Manual trigger unconfirmed |
| Qwen | Yes, automatic (`compact_boundary`) | No (respect native) | No manual trigger found |
| OpenCode | Yes (Cretli tunes `auto`/`prune`/`reserved`) | No (respect native) | `harnesses/opencode/opencode-compaction-config.js` |
| DeepSeek | Yes, configurable `compaction-basic` policy | No (respect native) | No Cretli-visible event |
| OpenRouter | Unavailable at provider (stateless) | No | Cretli-side trimming not traced: unconfirmed |
| Others (mimo, mistral, zai, plugins) | Unconfirmed | No | No evidence; nothing implemented |

"Resume without fresh-context guarantee" applies to every harness that resumes
by session/thread id (Claude, Codex, CodeBuddy, Qwen, OpenCode): resuming
reloads history, so it is never used as a compression step.

## Auto-run rules (implemented)

Gate (`evaluateAutoContextCompressionGate`, `lib/context-compression.js`): only a
`measured` snapshot with known input tokens (> 0), a known context window, the
**current** `contextMeterEpoch`, age <= 30 min and fill >= threshold. Never on
estimated / unknown / stale / run-total readings. One attempt per reading
(`buildAutoContextCompressionAttemptKey`, includes the epoch).

Boundary (`evaluateAutoContextCompressionBoundary`), checked before the summary
**and** again right before the reset: no active run (so no active tools), no
queued or in-flight message, no reset in flight, epoch unchanged since
scheduling. Unknown busy state counts as busy. The server additionally answers
`409 run_active` to an `auto` reset while the SDK room is busy.

## Failure, rollback and recovery

- The summary is stored in `chat.summaries` (durable, linked to the chat id)
  before any reset. If the boundary closes during summarising (new message), the
  reset is skipped and the live session is left untouched.
- Reset rotates `cursorSessionId` in one atomic `saveChats` write, then disposes
  the old room. If the rotation fails the old session and history are intact.
  Chat history is keyed by chat id and is never deleted or truncated by
  compression; the pre-reset transcript remains readable and the earlier session
  is the recovery path (manual summarize/seed can be re-run).
- The seed (`_contextSeedSummary`) is held in the browser only until the next
  send; after a page reload it is rebuilt from `chat.summaries` only by a manual
  re-run. A durable server-side seed checkpoint is **not implemented** (no
  evidence it is needed yet) — until then auto-run is limited to the Cursor SDK
  transport and stays opt-in (`autoContextCompressionEnabled`).
- Summary sections preserve goal, decisions, files touched, open tasks, errors
  and recent context (`STRUCTURED_SUMMARY_SECTIONS`).

## Tests

`tests/auto-context-compression-gate.test.js` (gate, epoch / old-peak reset,
boundary: active run, queued message, concurrent message, re-trigger, reset
rollback purity), `tests/chat-context-compression-recovery.test.js`.
