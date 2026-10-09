---
name: cretli-orchestrator-handoff-closeout
description: Taking over a Cretli orchestrator chat interrupted mid-loop by a harness handoff ([HARNESS HANDOFF CONTEXT], no transcript) — rebuild state from MCP (chat_show/chat_history, idempotency-key→todo-prefix trick, delegation_list on the source chat), know that reads cross chats but ack/verify/rate/workflow_update are parent-bound (OUT_OF_SCOPE/CONFLICT from the fork), check whether jobs already went terminal during the switch before re-delegating, and close the leaf by reproducing the reviewer's claims yourself + todo_update done, checking watcher_status active_cycles before assuming watcher_report is owed.
source: auto-skill
extracted_at: '2026-10-08T16:31:34.707Z'
---

# Closing out a delegation loop after a harness handoff

Trigger: the prompt contains a `[HARNESS HANDOFF CONTEXT]` block naming a source chat
("Continue the unfinished work of the source chat… No conversation transcript was available").
Everything must come from MCP — never from transcript files on disk.

Related: **cretli-orchestrator-resume-foreign-round** (resuming a FOREIGN cycle's unfinished fix
round — different trigger, new children get started there), **cretli-multi-harness** (loop contract).
The handoff case is usually **close-out only**: do not start new children until you know the loop
isn't already finished.

## 1. Rebuild state from MCP (cheap → precise)

1. `chat_show({chat: <source uuid>, tail: 60})` — the compact tail narrates the whole arc
   (slot contention, implement start, report reads, review failures, re-picks). Note job UUIDs
   and the last pending action.
2. Recover the **leaf/todo id from the idempotency key**: keys like `impl-6719a941-2026-10-08`
   embed the 8-hex todo prefix. `todo_show({todo_id: "6719a941"})` then gives title, body,
   status, and the `expected_updated_at` you'll need for the closing `todo_update`.
3. `delegation_list({chat_id: <source uuid>})` — works cross-chat and lists ALL jobs with
   status + executor in one line each. This instantly shows whether a job that was `running`
   at switch time is now terminal (it often is — the switch takes minutes).
4. `delegation_show` each relevant job, following `next_cursor` to the end — the `TASK:`/
   `VERDICT:` terminator lives past the first 4000 chars.
5. Only if details are missing: `chat_history({chat, before_seq/from_seq, include_tool_payloads: true})`
   on the interesting seq window (don't dump all 200+ events).

## 2. Permission boundary: the fork reads but cannot mutate the source's jobs

Observed 2026-10-08 (handoff fork of an OpenCode orchestrator):

| call | result from the handoff fork |
|---|---|
| `delegation_show` / `delegation_list({chat_id: source})` / `chat_show` / `chat_history` / `todo_show` / `todo_update` / `watcher_status` | **works** |
| `delegation_ack`, `delegation_verify`, `delegation_rate` on source jobs | `OUT_OF_SCOPE: … only the parent chat / jobs started by this parent chat` |
| `workflow_show`/`workflow_update` with `chat_id: <source>` | `CONFLICT: Workflow state applies only to the calling parent chat` |

Do not retry or work around these. Consequences to accept and report:
- Terminal reports keep their `unverified` flag on the delegation cards (cosmetic).
- `review_verify` stays `not recorded` even for a PASS review — substitute your OWN reproduction
  (step 3) as the hard evidence. If the reviewer had `review_can_run_tests=false`, its report
  should at least show the catalog runs; re-run them yourself.
- Writing workflow state to your own chat after a PASS is pointless — the loop ends on PASS.

## 3. Close-out = reproduce the reviewer's claims, then mark the leaf done

A review `VERDICT: PASS` from a job you didn't wait for is still a child claim. Before
`todo_update → done`:
1. Grep the cited `file:line` anchors — the tree should match the report exactly
   (function names AND line numbers matching is a strong signal the report is fresh).
2. Run the cited tests yourself: `node --test tests/<new>.test.js tests/<related>.test.js`.
3. Run the cited catalog area: `node scripts/review-verify.js <area-id>` (named area ids are
   cheap; the reviewer's report names the areas it ran).
4. `todo_show` for a FRESH `expected_updated_at` (other cycles mutate the tree/todo), then
   `todo_update({todo_id, expected_updated_at, patch: {status: "done"}})`.

## 4. Watcher report: check before assuming

`watcher_status` → if `active_cycles: -` (empty), there is no open cycle and NO `watcher_report`
is owed (it would be rejected from a non-orchestrator chat anyway: `not_orchestrator`). The
handoff chat is a continuation of a chat-lineage, not a watcher cycle orchestrator, unless
`watcher_status` says a cycle is actually active.

## 5. Finish visibly

- `chat_set_title` (the handoff chat usually has a placeholder name).
- Summarize: what the source had already done, what you reproduced (with numbers), the leaf
  status change, and the leftovers you could NOT do from the fork (unacked cards, unrecorded
  verify) plus any minor review observations worth an optional follow-up. The parent does not
  commit or push — say the changes sit uncommitted in the working tree.
