---
name: cretli-delegation-report-delivery
description: Delivering the final report of a Cretli delegated round without losing it — a final_report is single-shot per attempt, so keep it short, front-load the TASK/VERDICT terminator, send it last, and supplement (never replace) via reply_kind=progress when the bridge refuses or dies.
source: auto-skill
extracted_at: '2026-10-07T14:30:48.293Z'
---

# Cretli delegation report delivery (the handoff, not the code)

Trigger: you are about to send a `delegation_reply` with `reply_kind=final_report` as a Cretli
executor (implement/review/fix child), or you already sent one and it came out wrong. Companion to
**cretli-delegation-implement** (the work itself) and **cretli-delegation-review** (read-only side);
the reply mechanics below apply to every role because they share `delegation_reply`.

## The core trap: a `final_report` is accepted ONCE per attempt
`delegation_reply` with `reply_kind=final_report` is single-shot for that `attempt_id`. Every later
attempt returns:

```
CONFLICT: A different final report was already accepted for this attempt.
```

So a **bad report cannot be replaced** — only supplemented. Observed 2026-10-07: I authored a ~6 KB
Polish report in one `message_text`; generation truncated it *inside* the verification section, after
the file list but **before** the `TASK:` / `VERDICT:` lines. It was accepted as-is (reply
`d8d2eafd… status=queued`), the four replacement attempts all failed (CONFLICT, then dead session),
and the parent was left holding a report with no verdict terminator. The code work was perfect; the
handoff was not.

## Rules that follow from that
- **Keep the payload short: ~2–3 KB.** If the report needs more, send a compact final_report
  containing the headline results + the two terminator lines, then deliver detail as
  `reply_kind=progress` messages — progress replies are NOT single-shot and never CONFLICT.
- **Front-load the terminator inside the body.** The brief demands exactly one `TASK: implement` and
  one `VERDICT: PASS|FAIL|BLOCKED`; a reviewer greps for them. Everything after the last test tail is
  optional; the terminator is not. Do not let it be the thing truncation eats.
- **Send the report as your LAST action.** Any tool call after the accepted final_report risks losing
  the channel before you can add the missing half. Verify everything first, then write.
- **Never paste a truncated send back into a retry** — re-author the whole thing, or the same cutoff
  recurs.
- Prefer writing the report to a scratch file first, then sending its contents in one pass; it makes
  the length visible before you commit the single shot.

## If a truncated / partial report is already accepted
1. Write the **complete** report to an artifact **outside the repo** —
   `/tmp/<scratch>/FINAL-REPORT.md`. Never inside: a scoped brief's "touch ONLY these files" rule
   makes a new repo file a scope violation.
2. Send the missing half as `reply_kind=progress`, opening with a one-line explanation ("v1 landed
   but was cut off before the terminator; this is the missing part; full text at `<path>`") and ending
   with the `TASK:` / `VERDICT:` lines. State plainly "pełny raport = v1 + ta wiadomość".
3. Also restate the report in the chat response, since the chat is the channel that cannot CONFLICT.

## Verdict nuance when delivery fails
- **No report landed at all** → `VERDICT: BLOCKED` with a "Delivery blocker" section (exact error
  string, the stable `idempotency_key` to replay with).
- **A substantive report DID land, only the supplement is undeliverable** → `VERDICT: PASS` (the code
  work is complete and verified) **plus** an explicit "Delivery blocker" paragraph naming the exact
  error, *which section* is missing from the accepted report, and the artifact path. Never let PASS
  silently imply "the parent has the whole report"; equally, do not mark BLOCKED and make a parent
  re-run a finished, green fix. Say which half is done.

## Bridge session death: diagnose and bound the retries
Symptom of infrastructure (not your payload): *every* `cretli_bridge` call returns
`MCP session is unknown or no longer active`, including read-only `ping_read` and `delegation_show` —
not just `delegation_reply`. A payload/validation error is yours; a session error on a read-only tool
is not, and retrying variants won't help.
- The session can die **mid-run**: calls that worked while you paged the [TASK] can start failing at
  final-reply time. One fresh read-only `delegation_show` right before concluding tells you which case
  you are in.
- **Bound the retry budget tightly.** One CONFLICT + one dead-session probe is enough evidence. I
  burned three sleeps (25 s, 60 s, 90 s) and four sends for nothing — this does not self-heal within a
  run. Reuse the **same stable `idempotency_key`** so a late-successful first send cannot duplicate.
- Omit `attempt_id`/`run_id` unless the error names the executing run; omit `chat_id` entirely (the
  prompt gives the *parent* chat — using it returns `chat_id must be this chat`).
- **Not every CONFLICT consumed the single-shot slot.** Two distinct CONFLICTs:
  `chat_id must be this chat. You cannot reply as another executor` is a **payload validation**
  rejection — nothing was accepted, so fix the payload and resend immediately with the *same*
  `idempotency_key` (observed 2026-10-07: I passed the delegation UUID as `chat_id`, got CONFLICT,
  resent with `chat_id` omitted and the same key, and it queued fine: `Queued reply … status=queued`).
  Only `A different final report was already accepted for this attempt` means the slot is gone. Check
  which string you got before declaring a delivery blocker.
- Size calibration: a ~5.5 KB Polish `final_report` DID land complete (terminator included) on
  2026-10-07, so truncation is a risk rather than a certainty at that length — keep the short-report +
  `progress`-supplement habit anyway, and re-read your own `message_text` for the terminator before
  sending.

## Honesty rules that make the report trustworthy
- Report **which new tests failed pre-fix (bites) vs which passed pre-fix (locks)**. A fake harness
  often cannot observe the leak mechanism, so a "security test" that was already green pre-fix is a
  contract lock, not evidence — label it that way instead of implying the whole set ran red.
- Attribute lint/test failures on a dirty shared branch before claiming "clean": get per-file counts
  (`npx eslint . -f json` piped through a small node reader) and name the foreign files. Delimit your
  own hunks by explicit line ranges, because `git diff --stat` totals mix someone else's WIP with
  yours.
- List stale comments/docs you were **forbidden** to touch (out of the allowed-file list) under
  "remaining problems" as a follow-up, rather than silently editing them.
