---
name: cretli-delegation-review
description: Act as the read-only reviewer for a Cretli delegated assignment — verify a plan/TODO against the repo and send a final_report via delegation_reply with the correct attempt_id/run_id.
source: auto-skill
extracted_at: '2026-09-19T16:27:45.050Z'
---

# Cretli delegated review (read-only)

Use when assigned as the reviewer/executor of a Cretli delegation (`[ASSIGNMENT]`/`[TASK]`
blocks reference a `todo_id`, `delegation_id`, `parent_chat`). Default posture is
**review only**: do not implement, edit, commit, or start another delegation. If blocked or
materially ambiguous, ask the user and stop.

## 1. Load the assignment
- `todo_show(todo_id, field=body)` for the plan; also `field=plan` if the body is short.
- `delegation_show(delegation_id, field=report)` for status + executor + child_chat.

## 2. Verify claims against the repo (don't trust the plan)
For delegation-slot / concurrency claims, the enforcement logic lives in
`lib/delegation-service.js` + `lib/persist/delegations-persist.js`. Independently check
these, because a plan usually names only ONE of them:
- **Two enforcement sites, not one.** `createAndStart` (~`delegation-service.js:1066`) and
  `retryUnlocked` (~`:1526`) BOTH gate width via `findActiveDelegationForParent`
  (`delegations-persist.js:239`, returns the first slot-occupied row). A change at the start
  path alone leaves retry as a hidden second gate. Tests that lock this behavior:
  `tests/delegation-flow.test.js` (`parent_busy` on retry), `tests/delegation-phase3.test.js`,
  `tests/delegation-mailbox.test.js`.
- **Lock scoping = feasibility.** `withParentLock` (`delegation-service.js:126`) is a per-parent
  async mutex. Read whether it's released after accept or held for the whole run —
  `startDelegationChildRun` returns once `startChatRun` ACCEPTS (~`:1284`), so two jobs can
  both reach `running`. This decides whether "N concurrent" is even achievable. Keep any
  count/width check INSIDE the lock (TOCTOU otherwise).
- **Error-code mapping.** `lib/mcp/builtin/errors.js:57-59` maps `active_delegation_exists`,
  `parent_busy`, `still_active`, `job_in_progress`, `run_stopping`, `stale_running`,
  `nested_delegation_denied` → MCP CONFLICT. Check whether this mapping already closed a hole a
  doc claims is open (`docs/DELEGATION-MODERNIZATION-PHASE-3.md` D1/D3 may be stale).
- **Semantics of enums.** e.g. `normalizeDelegationAssignment`
  (`lib/delegation-request.js:50`) is binary `review|implement` — so "implement/fix exclusive"
  is actually complete; and `resolveDelegationChildExecutionMode` runs review children in
  `agent` mode, so "review is read-only" is only a PROMPT guard, not enforced.
- **Docs + duplicated text.** D10 (`DELEGATION-MODERNIZATION-PHASE-3.md`) and M12
  (`DELEGATION-STORE.md`) both defer a parallel executor pool. Skill forbid-text is duplicated
  in `.cursor/skills/cretli-multi-harness/SKILL.md` AND `.cursor/agents/cretli-multi-harness.md`
  — a plan that says "update the skill" (singular) misses one. Also check UI:
  `app_front/features/delegations/delegationCenter.js` reads per-row `slotOccupied`
  (`lib/delegation-query.js:144`).

## 3. Obtain the executing attempt_id / run_id (non-obvious)
`delegation_show` does NOT expose `attemptId`/`runId`. `delegation_reply` needs the LIVE ones
(they're "compared with the live run", not taken from the job record alone). Read them from the
store by matching the delegation id:
```bash
grep -n '"id": "<delegation_id>"' data/delegations.json
```
then read the ~30 lines below the match for `attemptId`, `runId`, `childChatId`.
(JSON store lives at `data/delegations.json`; if `getDelegationStoreBackend()` is `sqlite`,
query the `delegations` table's `json` column instead. Grep may skip `data/` due to .gitignore —
that's why the direct path/read works.)

## 4. Send the report
`delegation_reply` with: `chat_id` (the child/executor chat), `delegation_id`, the
`attempt_id` + `run_id` from step 3, `reply_kind=final_report`, `task_outcome=success|failure|blocked`,
a **stable `idempotency_key`** (e.g. `<topic>-final-report-<executor>-<attemptId-prefix>`), and
`message_text`. Per the assignment's format, start line 1 with `VERDICT: PASS|FAIL|BLOCKED`,
keep bullets few, and cite files. Reply is "queued"; it does NOT mark the job reviewed.

## Report verdict discipline
Mark FAIL/BLOCKED only if the plan is actually wrong/ambiguous. Prefer **PASS + an explicit list
of load-bearing gaps to close before implementing** when the direction is sound but the plan
omits an enforcement site, an error code, or an unverified assumption. Say so in the first bullet.
