---
name: cretli-multi-harness
description: Orchestrate Cretli children on other harnesses with MCP delegation_start (plan/implement/review/fix loop). Use when a cheap parent must run sub-chats or reviews. Never Cursor Task; the parent never commits or pushes.
---

# Cretli multi-harness loop

The parent (this chat) orchestrates; children return a report. This is existing
MCP delegation — not a new chat engine and not a server sequencer.

Pick a **mode** from the request before the first child:

| Mode | Use when | Children |
|------|----------|----------|
| `named` | the user named a harness and/or model, or a one-shot "verify this plan on X" | one child, then stop |
| `loop` | implement/fix a change with review rounds | plan → implement → review → fix |
| `fanout-review` | N independent reviews, then the parent synthesises | review only, no implement |

Use `named` when the user already chose the model. Default `loop` unless they
asked for parallel opinions, robustness reviews, or "N subchats" without
implementation.

## Non-negotiable invariants

- Never call Cursor `Task`. That list is not the Cretli catalog.
- Never commit, push or merge from the parent; never instruct a child to.
- Never edit the workspace while a **review** job is running, including after
  `completed` while `slot_occupied=true`.
- Never start a second **implement** or **fix** while any job is active,
  including a completed job with `slot_occupied=true` (`run_stopping`). Wait
  until `slot_occupied` is false.
- Pass `review_subject` explicitly on **every** review start: `code` for a code
  review, `plan` for a plan review. The server default is a safety net for
  ad-hoc starts; a job with no subject reads as `other` and never makes `code`
  or `plan` `passed`.
- Send **exactly one** source per `delegation_start`: `plan_revision`, or
  `history_seq` + `content_hash`, or `task_text`.
- Cap **1** infra retry per role. Never restart the same model/harness after an
  infra failure; if no different candidate exists, stop as `BLOCKED` with the
  concrete provider/quota reason.
- `todo.review` is server-written. Never set it with `todo_update` /
  `todo_create` (both reject `review`); read it with `todo_show`.
- Never edit Settings or `config.json` to add favorites. Tell the user instead.
- Never ask a child to call `delegation_start` unless the parent granted
  `allow_child_delegations` and depth/slot/budget gates allow it (default depth
  1 denies nested starts with `nested_delegation_denied`).

## Named model (skip the loop)

1. Resolve the id with `harness_list` and `model_list`. Prefer
   `enabled_only=true`. **Do not** call `model_pick`, and do not start a
   loop, fanout or `workflow_update`.
2. If `enabled_only=true` is empty, stop and tell the user to add that model as
   a Settings favorite. Catalog rows without `enabled_only` are not
   start-eligible.
3. `delegation_start` once. A one-shot plan audit uses `assignment=review` when
   the harness is certified. `delegation_wait` until terminal and
   `slot_occupied` is false, then summarise and stop.

## Start errors (do not reverse-engineer)

On `MODEL_UNAVAILABLE` (empty favorites) or `review_uncertified`: tell the user
what Settings or env flag is missing. Do **not** grep or read `lib/`,
`data/config.json` or other settings files, and do not patch favorites
yourself. Do not retry a `review` as `assignment=implement` unless the user
agrees. `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1` is a user/ops choice,
not a parent workaround.

## Details (read the file the step needs)

- `references/model-picking.md` — model roles, `model_pick` ranking, fanout
  picks, review traits and premium-model restraint.
- `references/loop-protocol.md` — starting a child, `delegation_wait`,
  verdict → next step, verify, ack, rating, caps, handoff.
- `references/watcher-autopilot.md` — Workspace Watcher autopilot cycles.

Read a reference only when the current step needs it; do not preload all three.

## Report contract

Tell every child to write in the **user's language** and end with exactly:

`TASK: audit|implement|review`

`VERDICT: PASS|FAIL|BLOCKED`

`TASK: audit` PASS means the audit/plan is complete, not that the product has
no defects. A thinking dump, one-liner, or empty `completed` body is not PASS.
