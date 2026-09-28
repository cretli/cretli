---
name: cretli-multi-harness
description: Cretli multi-harness plan/implement/review/fix loop via MCP delegation_start. Use when a cheap parent must orchestrate children on other harnesses. Never Cursor Task; parent does not commit or push.
---

# Cretli multi-harness loop

Parent (this chat) orchestrates. Children return a report. This is existing MCP
delegation — not a new chat engine and not a server sequencer.

Pick a **mode** from the user request before the first child:

| Mode | Use when | Children |
|------|----------|----------|
| `named` | user named a harness and/or model, or one-shot “verify this plan on X” | one child, then stop |
| `loop` | implement/fix a change with review rounds | plan → implement → review → fix |
| `fanout-review` | N independent reviews, then parent synthesis | review only, no implement |

Use `named` when the user already chose the model. Default is `loop` unless they
asked for parallel opinions, robustness reviews, or “N subchats” without
implementation.

## Named model (skip the loop)

If the user names a harness and/or model (for example “DeepSeek 4.1 Flash”):

1. Resolve the id with `harness_list` and `model_list`. Prefer
   `enabled_only=true`. **Do not** call `model_pick`. **Do not** start a
   plan/implement/review loop, fanout, or `delegation_workflow_update`.
2. If `enabled_only=true` is empty, stop. Tell the user to add that model as a
   Settings favorite. Catalog rows without `enabled_only` are **not**
   start-eligible.
3. `delegation_start` once. One-shot plan audit uses `assignment=review` when
   the harness is certified. Use `delegation_wait` until terminal and
   `slot_occupied` is false, then summarize and stop.

## Start errors (do not reverse-engineer)

On `MODEL_UNAVAILABLE` (empty favorites) or `review_uncertified`:

- Tell the user what Settings or env flag is missing. Do **not** grep or read
  `lib/`, `data/config.json`, or other settings files, and do **not** patch
  favorites yourself.
- Do **not** retry `review` as `assignment=implement` unless the user agrees.
- `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1` is a user/ops choice, not a
  parent workaround.

## Do not

- Call Cursor `Task`. That list is not the Cretli catalog.
- Commit or push from the parent. Do not instruct children to commit or push.
- Edit the workspace while a **review** job is running (including after
  `completed` while `slot_occupied=true`).
- Start a second **implement** or **fix** while any job is active, including a
  completed job with `slot_occupied=true` (`run_stopping`). Wait until
  `slot_occupied` is false.
- Default width is two review children (`CRETLI_DELEGATION_REVIEW_FANOUT`
  unset/`2`). `=1` keeps a single review slot. When the flag is `2`, two
  concurrent **review** jobs are allowed; a third review is
  `review_fanout_full`. Queue extra reviews yourself — the server does not
  enqueue them. Mixed review+implement stays exclusive. This is not an
  executor pool.
- Ask a child to call `delegation_start` (depth is server-enforced).
- Edit Settings or `config.json` to add favorites. Tell the user instead.

## Pick a model

1. `harness_list` — only rows with **enabled**, **ready**, and **can_delegate**.
2. `model_list(harness, enabled_only=true)` for those harnesses, **or**
   `model_pick({ role, exclude_model?, exclude_harness? })`.
3. Prefer `model_pick`. Eligibility is the role matcher list; ranking is local
cost/quality/speed tiers (frozen table + regex, never scraped). Implement
prefers cheaper eligible favorites — not Astra-first. **Review never selects
a `*flash*` id** in `loop` / `fanout-review` (`model_pick`). Plan/review picks
skip harnesses that would return `review_uncertified` (Codex unless the
uncertified flag is on). A **named** Flash
id still starts if it is a Settings favorite and the assignment is allowed.
Empty Settings favorites for a harness are **unset**: no pick and, by default,
no `delegation_start` from that harness (`model_list(..., enabled_only=true)`
is empty). Catalog rows without that flag are not start-eligible. Legacy
`CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores start-with-any-id when the
list is empty (pick still skips that harness).
4. If `model_pick` returns nothing, stop that role as BLOCKED unless a
   documented fallback role still has a favorite.
5. `candidates[1]` is the infra fallback. Cap **1** infra retry per role after an empty `cancelled`, adapter failure, timeout, or usage/quota signal. The fallback must use a different model or harness; never start the same model/harness again for the same role after an infra failure. If no different candidate exists, stop as `BLOCKED` and report the concrete provider/quota reason.

### Premium-model restraint

Treat `cost_tier` as a **relative heuristic**, not a price quote. The catalog
does not know the user's plan, provider billing, token usage, or whether a
harness call has an incremental charge. Do not infer dollar costs or claim
that a model is free. Exact spend data is not required to make a conservative
selection policy.

Use the lowest-cost eligible favorite that can reasonably do the role. Reserve
the highest-cost tier (including `gpt-6-astra`, currently heuristic tier 5)
for exceptional cases: a high-impact or unusually complex task where a
concrete limitation of cheaper eligible choices is known, or a cheaper
candidate has already failed for a **quality** reason and another round is
justified. Do not select a premium model solely because the role is `plan` or
`review`, because it is available, or as an infra retry; infra retries use the
next different candidate under the existing retry rule. If no cheaper model
is eligible, use the normal eligibility/blocked rules rather than silently
inventing a cheaper option. Explain the exceptional reason briefly to the
user when selecting a premium model.

### Roles (axes)

| Role | Ranking | `assignment` |
|------|---------|--------------|
| `plan` | quality DESC, speed DESC, cost ASC | `review` (read-only) |
| `implement` | cost ASC, speed DESC, quality DESC | `implement` |
| `review` | quality DESC, cost ASC; `exclude_model` = last implementer **and** last reviewer | `review` |
| `fix` | speed DESC, cost ASC, quality last | `implement` |

Review requires a hard pre-exec deny or a read-only sandbox. Codex is excluded
unless `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`. DeepSeek review runs
with DSH `read-only` sandbox + headless approval. Event abort is not a write
block.

## Start a child

`delegation_start` requires `harness`, `model`, `idempotency_key`, and
**exactly one** source (the server already validates this; send one, not two):

- `plan_revision`, **or**
- `history_seq` **and** `content_hash`, **or**
- `task_text`

Idempotency key: stable per role and source, unique per round, for example
`mh-<role>-<short-source>-r<n>`. Replays with the same key and same params
return the existing job. An infra retry **must** use a new key (same key
returns the failed/cancelled job).

Set `assignment` to `review` or `implement` (plan/fix are mapped). In `loop`
or `fanout-review`, persist loop state with `delegation_workflow_update` (role,
round, last implementer, last reviewer, findings, deadline, `material_revision`,
and `idempotency_key` unique per review event) so a parent restart does not
reset the round cap. Skip workflow tools in `named` mode.
Replaying any previously applied key with the same parameters is a no-op; the
same key with different parameters is `CONFLICT`.

`material_revision` is a code/artifact id, not findings text. Prefer
`readDelegationMaterialRevision(cwd)` (short `HEAD` plus dirty `status`
fingerprint). Snapshot it before review and after implement/fix.

Tell the child to write in the **user's language** and end with exactly:

`TASK: audit|implement|review`

`VERDICT: PASS|FAIL|BLOCKED`

`TASK: audit` PASS means the audit/plan is complete, not that the product has
no defects. A thinking dump, one-liner, or empty `completed` body is not PASS.

## Wait

After N `delegation_start` calls (each with a **different** `idempotency_key`),
loop `delegation_wait({ ids, until: "all" })` while `status=pending`. Do not
busy-poll `delegation_show`. Default `timeout_ms` is 20000, max 25000 (below
the ~30s bridge HTTP timeout). Call again on `pending`. `until=any` returns
when the first listed job is terminal **and** `slot_occupied` is false.

A job is not free while `run_stopping=true` or `slot_occupied=true`, even if
`status=completed`. Do not start the next **implement** / **fix** until every
watched implement job has `slot_occupied` false. There is no `finished`
status.

`delegation_wait` returns per-id `status`, `slot_occupied`, `run_stopping`,
`task_outcome`, `verdict`, and a short summary — not the report body. Page
`delegation_show` / `delegation_inbox` for content. Follow
`truncated=true next_cursor=…` until the cursor is empty. List **text** uses
the full UUID (do not invent prefix lookup).

`delegation_inbox` list rows are 240-character previews and often omit the
ending `VERDICT`. Pass `id` and follow `next_cursor`, or page `delegation_show`.
Cross-workspace jobs need `scope=all` on `delegation_list` / `delegation_inbox`
(same idea as `chat_show`).

Missing `VERDICT` is `unspecified`. Two different VERDICT lines in one report
are `conflict`. Treat unspecified/conflict as not PASS. With fanout 2,
aggregate conservatively: BLOCKED wins, then FAIL, then conflict; PASS only if
every review is PASS.

With fanout 1, do not start the next child first. With fanout 2, a second
**review** may run in parallel; stop one job at a time (no cancel-all). Extra
reviews beyond the cap wait until a slot frees.

## Verdict → next step

- **PASS** on plan → implement. **PASS** on implement → review. **PASS** on
  review in `loop` → stop (success). **PASS** on fix → review again.
- **FAIL** or **conflict** on review → fix (if rounds remain), then review with
  `exclude_model` = last implementer/fixer, then the last reviewer.
- After a child **PASS** on implement/fix, independently reproduce 1–2 claims
  (test or minimal repo). Child PASS without that evidence is `unspecified`.
  If the reviewer cannot run `review-verify` (no native shell), the **parent
  MUST** run the catalog tests.
- **`waiting_for_input`** (OpenCode question/permission or SDK Ask on
  implement/fix): keep polling `delegation_wait`; do not infra-retry or free
  the fanout slot until the user approves in the child chat or the job reaches
  a terminal status.
- **Infra** (`failed`/`cancelled` with empty report, `code=adapter_timeout`,
  `adapter_incomplete`, first-event timeout, ChatGPT/Codex **usage limit**,
  harness quota, one-line thinking dump): wait until `slot_occupied` is false,
  then `model_pick` with `exclude_model` = the failed id. Review never picks
  `*flash*` ids. If the whole harness is dead (Codex usage cap, OpenCode not
  ready), also `exclude_harness` (e.g. `codex`). Start the next candidate with
  a **new** idempotency key (replay returns the failed job). Never retry the
  same model/harness after an infra failure. If no different candidate exists,
  stop as `BLOCKED` and include the provider/quota reason; do not burn three
  retries on a dead sub-chat. Example: child
  `1502cdb2` on `codex` / `gpt-6-astra` hit a usage limit — fall back to
  Composer on `sdk`. Cap 1 infra retry per role. Do not stop sibling fanout
  reviews. Do not infra-retry `VERDICT: FAIL`/`BLOCKED`.
- **BLOCKED**, unspecified after a full report read **and** infra retry,
  **interrupted**, or loop **timeout** → stop. Do not start another child in
  `loop` mode.

## Caps and tie-break

Store round/findings on `delegation_workflow_update` with a stable
`idempotency_key` per review event (for example `mh-workflow-r<n>-review`).
The server keeps every applied key→fingerprint, not only the last patch.
Replaying any previously applied key with the same parameters is a no-op (the
current state is unchanged). The same key with different parameters is
`CONFLICT`, including after later updates or reload. Distinct reviews increment
`consecutiveSameFail`. Default `max_rounds` is 4. Pass `material_revision` when
code or artifacts change (findings text is not a material revision). A second
identical FAIL (`findings_hash` unchanged **and** `material_revision` unchanged
**since the last FAIL review**) sets `stop_reason=same_findings`. Example
deadline (ISO-8601): `deadline_at: "2026-09-20T22:00:00.000Z"` — the worker
requests cancel and the parent waits for `slot_occupied=false`. Do not burn
remaining rounds after the same-findings stop.

## Handoff (parent model switch)

If this chat is handed to another harness, put these 10 lines in the first
parent message: mode, round, last implementer, last reviewer, material
revision, open findings (one line), whether a fix is in flight, full job
UUIDs, stop reason, next role. Do not start a second implement/fix.

## After the loop

Report files, tests, leftover gaps. In `fanout-review`, optionally
`todo_create` a synthesis plan when the user will implement later. The parent
still does not commit or push.
