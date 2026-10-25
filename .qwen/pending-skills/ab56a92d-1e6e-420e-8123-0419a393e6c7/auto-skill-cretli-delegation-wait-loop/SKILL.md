---
name: cretli-delegation-wait-loop
description: As the Cretli parent waiting on long-running delegation children, repeated identical delegation_wait calls and standalone sleeps are blocked — switch to a self-pacing loop_wakeup chain whose prompt is a complete state snapshot, probe child progress read-only via artifact mtimes (LOCAL time, not UTC) and per-file evidence rather than the tree fingerprint, and re-register MCP tools with tool_search select: names after "no longer available" registry notices.
source: auto-skill
extracted_at: '2026-10-07T18:36:42.464Z'
---

# Waiting on long-running delegation children without busy-polling

Trigger: you are the Cretli parent/orchestrator (Workspace Watcher cycle or manual
multi-harness loop). A child (implement/review/fix) runs for 10–40+ minutes and your
`delegation_wait` keeps answering `status=pending … slot_occupied=true`. The session then
starts **blocking** you: a repetition of the identical tool call is refused ("This was a
repeated tool call with identical arguments…"), and a bare `sleep 240` shell command is
**blocked** outright. This happened on 2026-10-07 (leaf 78abc5ba, implement child
`53fc3b1e`, qwen3.8-flash ~18 min; then review sibling ~6 min).

Companions: **cretli-multi-harness** (loop contract),
**cretli-orchestrator-resume-foreign-round** (head_seq stall judgment, foreign-slot
retry), **cretli-orchestrator-failed-child-partial-landing** (post-mortem when the wait
ends in `failed`). Read those before writing briefs; this skill is only the *waiting*.

## 1. Choose the right wait primitive

- **Short bounded waits (≤ ~10 min total)** — a standalone `sleep` is blocked *unless* the
  command carries a trailing comment `# intentional-sleep: <reason>` (allowed up to 10
  minutes). Use this for slot-contention retries and quick re-checks.
- **Long child waits (unbounded minutes)** — do NOT chain sleeps or repeat identical
  `delegation_wait`. Arm a one-shot `loop_wakeup` (delaySeconds 240–300 while actively
  expecting progress; longer only as a fallback heartbeat) and end the turn. On wake you
  get one fresh `delegation_wait` (it legitimately differs per turn), then re-arm the next
  wakeup **before ending that turn**. Chain of wakes = the parent-side equivalent of the
  skill's "call again on pending", minus the repetition blocks.
- Never cancel a running child for slowness alone; `running + slot_occupied=true` with no
  verdict is "still working" (see resume-foreign-round §5).

## 2. The wake prompt must be a complete, self-contained state snapshot

`loop_wakeup` is session-only and one-shot; the enqueued prompt is all future-you has.
Re-type every UUID **from actual tool output, never from memory** (UUID transcription
traps are documented in failed-child-partial-landing §6). Include:

- cycle id, parent chat, leaf/todo UUID;
- every live job UUID + its last-known status/verdict + executor harness/model;
- material revision at last persist, and which `workflow_update` idempotency keys are
  already applied (so a wake never replays a key with different params — that is a hard
  `CONFLICT`);
- the branch table: pending → re-arm (~300s); terminal+slot free → read report, persist
  verdict, next role; stuck past N minutes + no artifact progress → infra rules;
- close-out obligations for this leaf (verify backstop ids, todo done CAS token, rate/ack
  rules incl. `self_model_rating_denied` for your own base model, watcher report ids).

Progressive refinement works: when a probe confirmed the child was writing files, the next
wake prompt folded that in ("docs/workspace-watcher.md modified at 20:26 local — child is
active, not stuck").

## 3. Probe progress read-only — with two timezone/fingerprint traps

Distinguish "real progress" from "hung run" without touching the workspace and without
`chat_show` (which may be unregistered — see §5):

```bash
date -u +%H:%M:%S && ls -l --time-style=+%Y-%m-%d_%H:%M:%S docs/<expected deliverables>*.md && git status --porcelain | sha256sum | cut -c1-12
```

- **`ls` mtimes are LOCAL time; `date -u` is UTC.** On this workspace the local zone is
  Europe/Warsaw (UTC+2 in October), so a file stamped "20:26" was modified ~now while
  `date -u` says 18:26. First instinct was "18:31 mtime is in the future" — it was local.
  Convert before judging freshness.
- **The whole-tree `git status --porcelain` fingerprint drifts on its own.** Concurrent
  watcher cycles edit the same dirty tree; between cycle start and implement finish it
  moved `5c8cbde→06e9→9573→410e` without this leaf touching anything. A changed
  fingerprint is NOT your child's progress signal — probe the **specific expected
  artifacts' mtimes** (this run: the child was mid-edit of `docs/workspace-watcher.md`)
  and re-read the fingerprint fresh at each persist moment because `material_revision`
  must reflect reality at that instant.
- No expected file changed for 2+ consecutive wake cycles AND `running` persists: peek
  once via `chat_show`/`delegation_inbox` (if registered) for `head_seq` movement, then
  apply the skill's infra rules — do not invent a stuck verdict.

## 4. A suspiciously fast PASS is audited, not accepted

A review sibling that completes in ~2 minutes (claude/sonnet-5-5, job `ecb2e885`,
2026-10-07) still produced a substantive report (ran schedule 40 OK / profiles-api 28 OK /
watcher-scout 44 OK, caught a real ~+32-line shift in cited line numbers after the
implementer inserted a test). Cheap and fast ≠ rubber-stamp — but the parent still:

- pages the FULL report via `delegation_show` + `next_cursor` (the useful caveats sat in
  the tail past the 4000-char cut);
- runs `delegation_verify` for every `verify_required` job (the scout area's one catalog
  id is `workspace-watcher-scout`; check the catalog — several browser/sidebar/opencode
  areas have NO id, run those suites yourself);
- persists each fanout verdict under its own stable key (`fanout_verdicts:["PASS"]` while
  the sibling is still running is safe for a PASS — the double-count trap is FAIL-only:
  never re-carry `last_verdict: FAIL` with unchanged material), and aggregates
  conservatively (BLOCKED > FAIL > conflict; PASS only if every review PASSes).
- Remember `workflow_update` echoes `round=0/4` after a PASS — PASS resets the round
  counter; that is correct, not state loss.

## 5. MCP registry churn: tools "no longer available" usually just need re-registering

Mid-conversation the runtime announced all `cretli_bridge` tools were removed from the
startup set. The names remained callable after one `tool_search` with
`select:<exact-full-name>,…` (comma-separated list re-registers them in bulk). Rules:

- On any such notice, re-load the exact names you need via `tool_search` before assuming
  the capability is gone; keyword queries return a *different subset*, so use `select:`.
- A genuine miss survives the `select:` re-check ("Not found: …workspace_memory_add") —
  then adapt (e.g. `delegation_ack` did not exist in this session at all: note it in the
  cycle report instead of working around server gates).
- Filesystem evidence (mtimes, fingerprints, test runs) is a better progress probe than a
  blocked-then-maybe-missing `chat_show`, and requires no registry reload.
