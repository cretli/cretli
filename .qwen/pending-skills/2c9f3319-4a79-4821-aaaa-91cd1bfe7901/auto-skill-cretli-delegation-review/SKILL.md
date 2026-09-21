---
name: cretli-delegation-review
description: How to perform a read-only Cretli delegated review (VERDICT report via delegation_reply) and verify plan claims against the codebase instead of trusting the TODO text.
source: auto-skill
extracted_at: '2026-09-19T14:39:58.299Z'
---

Use this when acting as the reviewer for a Cretli delegated assignment (prompt starts "You are the reviewer for a Cretli delegated assignment...", [ASSIGNMENT] names files/TODO and demands `VERDICT: PASS|FAIL|BLOCKED` + delegation_reply final_report).

## Hard rules
- Read-only: no edits, no lint/tests, no new delegation, even though execution mode is "agent".
- If the assignment conflicts with the default role prompt, the [ASSIGNMENT] block wins.
- Cretli MCP tools (`todo_show`, `delegation_reply`, `delegation_show`, ...) are usually NOT loaded in-session; load each via `tool_search` with `select:mcp__cretli_bridge__mcp__cretli_builtincretl__<tool>` before first call.

## Verification method (treat plan claims as hypotheses)
1. Read the TODO body (`todo_show`, field=body) — note status: `ready` + missing artifacts = plan stage, which is correct, not a FAIL.
2. Glob for the files the plan proposes to create (e.g. `.cursor/agents/*.md`, `.cursor/skills/*/SKILL.md`, `lib/<new>.js`). Absence confirms "not yet implemented"; presence means the plan is stale.
3. For every behavioral claim, grep the named identifier and cite file + approximate line:
   - "one child slot per parent" → `findActiveDelegationForParent` + `active_delegation_exists` in `lib/delegation-service.js`.
   - "exactly one source" / idempotency → `sourceCount !== 1` validation in `lib/mcp/builtin/delegation-tools.js` (delegation_start).
   - prompt-only vs server-enforced: nested-delegation ban lives only in role text in `lib/delegation-prompt.js`; `delegationParentChatId` is stamped on child chats (`delegation-service.js`) but used only for reply/mailbox routing — nothing blocks a child calling delegation_start server-side. Grep the identifier's read sites to prove a guard exists or doesn't.
   - "empty Settings favorites = all enabled" divergence: `toRows()` in `lib/harness-catalog.js` uses `enabled.length === 0 || enabled.includes(id)`; `resolveDelegationModel` in `lib/delegation-executor.js` returns the requested model when `enabled.length === 0`. If a TODO states target semantics (model_pick should NOT treat empty as all-enabled) that read like a contradiction of current behavior, flag it as a wording/semantics gap for the implementer — not a FAIL.
   - Field-shape claims ("toRows has only id/label/enabled/available") → read the mapper; costTier exists in `lib/model-catalog-meta.js` but is dropped before MCP rows.
4. Check docs claims with one targeted grep (`docs/ARCHITECTURE.md` already documents delegation primitives, so new doc sections should extend, not duplicate).

## Report mechanics
- Read the delegation via `delegation_show` first if you need live status; its text output does NOT include attempt_id.
- Send `delegation_reply` with `reply_kind=final_report`, `task_outcome`, and a stable human-meaningful `idempotency_key` like `review-<delegationId8>-<todoId8>-final-v1` (replays are deduped server-side).
- `attempt_id`/`run_id`: safe to omit — the handler falls back to `session.attemptId`/`session.runId` (`args?.attempt_id || session?.attemptId` in `lib/mcp/builtin/delegation-tools.js`). Note the omission as a deviation in the report.
- Format: line 1 exactly `VERDICT: PASS|FAIL|BLOCKED`, then ≤12 bullets, each citing files; disagreements and deferred-phase confirmation included; keep it short.
