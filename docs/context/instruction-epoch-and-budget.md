# Context budget and instruction epochs

Stage 06 of the context unification plan. Two independent mechanisms, both
conservative by default.

## Soft budget (`lib/context/context-budget.ts`)

- Measures what Cretli adds to a turn: characters and **estimated** tokens
  (`chars / 4`). The record says `estimate.kind = "estimated"` and
  `separateFrom = ["usage", "cache", "cost"]`; it never reads or feeds provider
  usage, cache counters or cost.
- Soft: over the limit (default 12000 estimated tokens, setting `budget.mode`
  `soft` | `off`) it adds a warning and a reduction suggestion. It never blocks
  a send and never trims. `trimmed` is always empty.
- Required (never shortened): message/task, seed, AGENTS.md, active
  `alwaysApply` rules, mode hint, current plan/criteria, explicitly selected
  skill. Optional: skills catalog descriptions, page context, delegation
  reports, title hint. Suggested reduction order: catalog descriptions, then
  optional resources.
- Surfaced in `assemble().budget`, `manifest.budget` and the send snapshot
  (`snapshot.budget`).
- Legacy limits keep their behaviour and are listed in `CONTEXT_LEGACY_LIMITS`
  (delegation task 100000 chars, report 8000, handoff 24000, skill file 64 KiB,
  skill description 1000). They are per-input character limits, not a model
  window.
- Bounded text keeps a marker with sizes and a reference
  (`buildTruncationMarker`): delegation reports point to `delegation_show <id>`,
  clipped handoffs to `chat_history of the source chat`.

### Hard provider window error

`buildProviderWindowError` / `isProviderWindowError`. The Claude adapter turns a
window error into `code: context_window_exceeded` with the sizes of the last
send's Cretli contribution (estimated, history and tool output not included) and
the options `change_context_set`, `start_new_session`, `compress_history`.
`autoRetry` is always `false`: nothing is resent with shortened instructions.
Other adapters keep their existing error text until they are wired the same way.

## Instruction epoch (`lib/context/instruction-epoch.ts`)

Cretli delivers rules/skills as a message prefix and cannot read a harness's
native memory. The epoch records **what Cretli did**, never what the model
remembers (`memoryKnowledge: "not_claimed"` in manifests).

- Default delivery is the fallback: the static block and the current plan go
  out on **every** turn (`staticMode: always`). This is a change from the
  earlier default, which deduplicated for most harnesses.
- `instructions.dedupe = proven_adapters` (default `off`) opts in to skipping
  the static block on later turns, only for transports in
  `INSTRUCTION_RETENTION_PROOFS` (today: `claude`) that also have an observed
  native session id. OpenRouter, Codex, Qwen, SDK and the rest never dedupe.
- Epoch bumps (state dropped, next turn re-delivers required blocks):
  new native session id, failed resume (`clearClaudeRoomSession`), session
  created without resume, model/mode/MCP rebuild of the Claude session,
  compaction and `compact_boundary` (`advanceRoomContextEpoch`), history
  hydrate/trim (OpenRouter helpers `planOpenRouterInstructionDelivery` and
  `runLlmToolLoop.onHistoryTrimmed`). Process restart and room reset lose the
  in-memory decoration state or create a new room, which re-delivers by
  construction. The decoration session key carries the epoch.

## Limitations

- Estimates are heuristic and not provider token counts.
- Seed delivery has no separate epoch bump: after a reset the new room has no
  decoration state, so the static block is re-delivered with the seed turn; the
  seed itself is classed as required in the budget.
- The OpenRouter room runner is not part of this tree; the hydrate/trim
  contract is implemented as pure helpers and a tool-loop callback, and covered
  by tests, but must be called by the runner when it exists.
- Window error enrichment is wired for Claude only.

## Rollback

- Behaviour: keep `instructions.dedupe = off` (default) and `budget.mode = off`
  to disable both features' effects; nothing else needs a migration.
- Code: revert the stage commit; the new settings keys are ignored by older
  builds only if removed from stored settings (`instructions.dedupe`,
  `budget.mode`) because unknown keys are rejected by the resolver.
