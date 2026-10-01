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
   `model_pick({ role, exclude_model?, exclude_models?, exclude_harness?, exclude_harnesses?, chat_id?, rotation?, explore?, count?, diverse? })`.
3. Prefer `model_pick`. Eligibility is the role matcher list; ranking is the
   weighted score over local cost/quality/speed tiers (frozen table + regex,
   never scraped), then the tier axes as a tie-break. Only ties inside
   `rotation.band` (default 0.05, `data/model-role-profiles.json`) rotate. The
   within-band key order is: keep the proven winner (the newest implement→review
   cycle of that model in this chat PASSed — a fanout needs every review of the
   cycle to PASS), then fewest uses in this chat for the role, then — for
   `review` only — a harness that can run the review-verify catalog itself
   (`traits.review_can_run_tests: true`), then fewest
   delegations for the role in 7d, then fewest uses of that model in 7d, then
   least-recently-used, then id.
   Models already used in this chat for this role are avoided unless the
   following review PASSed (`chat_id` selects the chat; default is the calling
   chat). In `review`, the last implementer and last reviewer (real reviews — a
   plan-mode job does not count) are auto-excluded, but only as a
   **preference**: if that would leave no candidate, the pick retries without
   the history excludes (explicit `exclude_model` / `exclude_harness` stay
   hard) and the `reason` says `history exclude relaxed`. A harness with 0 jobs
   for the role in 14d gets a cold-start bonus on every 5th pick, counted from
   global role traffic across chats (a first pick in a new chat, or a missing
   `chat_id`, does not force explore; `explore: false` disables it). Active
   lockouts drop the model. A fresh plan limit at/above 90% is penalised; a
   fresh limit-hit history row penalises only the same model/base, or the whole
   harness when the row has no model (`reason` shows `plan-limit-penalty`).
   `rotation: off` restores pure score. `candidates` follows the actual
   selection: the rotation-ordered tie band first (position 1 prefers a
   different harness when one exists), then the rest by score. Each candidate
   carries a `reason` and an `observed` block from the last 30d for that
   harness + base model (`n`, `pass_rate`, `infra_fail_rate`, `median_min`, or
   null). Implement `pass_rate` is the following review cycle, never the
   child's own VERDICT. Review quality is the productive-verdict share (PASS,
   or FAIL confirmed by a fix + PASS); `useful_rate` is reported but does not
   enter the score. Every candidate is shrunk toward its role prior with
   `w = n/(n+10)`: observed quality `w`-blends into the heuristic tier, and
   `infra_fail_rate` blends toward the role's job-weighted mean infra rate, so
   a pair with no history inherits that prior instead of a free pass. The
   shrunk infra rate cuts the score by up to 50%, so a flaky provider drops
   below an equally-tiered one and the `reason` says `observed changed ranking`.
   A proven winner (`keep_winner`) stays in the tie band while it is within two
   bands of the best score, so an observed penalty cannot silently rotate it
   away. `adaptive: false` (or `adaptive.enabled=false` in
   `data/model-role-profiles.json`) restores pure heuristics.
   Implement prefers cheaper eligible favorites — not Astra-first. **Review
   never selects a `*flash*` id** in `loop` / `fanout-review` (`model_pick`).
   Plan/review picks skip harnesses that would return `review_uncertified`
   (Codex unless the uncertified flag is on). A **named** Flash
   id still starts if it is a Settings favorite and the assignment is allowed.
   Empty Settings favorites for a harness are **unset**: no pick and, by default,
   no `delegation_start` from that harness (`model_list(..., enabled_only=true)`
   is empty). Catalog rows without that flag are not start-eligible. Legacy
   `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores start-with-any-id when the
   list is empty (pick still skips that harness).
4. If `model_pick` returns nothing, stop that role as BLOCKED unless a
   documented fallback role still has a favorite.
5. `candidates[1]` is the infra fallback. Cap **1** infra retry per role after an empty `cancelled`, adapter failure, timeout, or usage/quota signal. The fallback must use a different model or harness; never start the same model/harness again for the same role after an infra failure. If no different candidate exists, stop as `BLOCKED` and report the concrete provider/quota reason.

### Fanout picks and review traits

For `fanout-review`, ask for the whole set in one call:
`model_pick({ role: "review", count: 2, diverse: true })`. `pick` is always
`picks[0]`, so `count: 1` (the default) is unchanged. With `count > 1`, extra
picks prefer a different harness and — when `diverse: true` — a different model
provider. Always **one pick per harness under `diverse: true`**: if there are
fewer distinct harnesses than `count`, `picks` is simply shorter (a same-harness
candidate is never added for diversity). Without `diverse`, extra slots still
prefer another harness but fall back to a second model on an already-used
harness so `picks` reaches `count`; it is shorter only when fewer than `count`
candidates exist. Give every pick its own `delegation_start` with a distinct
`idempotency_key`.

`exclude_models` / `exclude_harnesses` are the plural forms of the single
`exclude_model` / `exclude_harness` and merge with them; all excludes stay hard.
Use the plural form when a review must exclude the last implementer **and** the
last reviewer in one call.

Each `review` candidate carries `traits`: `review_can_run_tests` and its source
`review_can_run_tests_source`, plus short `known_failure_modes` tags (for example
`codex: usage_limit`, `opencode: adapter_incomplete`, `qwen: slow_read_loop`).
`review_can_run_tests` is a **prior** by default: `true` for `claude`,
`openrouter`, `opencode`, `codebuddy`, `qwen`, `codex`; `false` for `sdk` and
`deepseek` (deepseek's read-only dsh sandbox is unconfirmed until observed). The
server refines the prior per harness from the last 30 days of review reports:
at least **2** reports with a successful `node scripts/review-verify.js` trace
flip it to `true`, at least 2 reports that explicitly say they could not run it
flip it to `false`; fewer or a tie keep the prior. When observation wins, the
source is `observed` (otherwise `prior`). The band tie-break already prefers a
harness with `review_can_run_tests: true`, and the `reason` says
`review can run tests`. When the chosen reviewer cannot run
`node scripts/review-verify.js`, **you (the parent) MUST** run the relevant
catalog tests yourself after the report.

CodeBuddy (`codebuddy` / `hy3`, `hy4`) is a full implement/fix/review candidate
like any other harness — do not skip it in the model pick or the fanout.

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

Ranking = weighted score DESC, then these tier axes as tie-break. Inside
`rotation.band` the pick rotates (keep-winner/chat uses → review can run tests →
harness 7d → model 7d → least-recently-used → id). CodeBuddy favorites (`hy3`,
`hy4`) are eligible for implement/fix/review.

| Role | Score weights (tier tie-break) | `assignment` |
|------|-------------------------------|--------------|
| `plan` | quality .65, cost .2, speed .15 | `review` (read-only) |
| `implement` | cost .6, quality .25, speed .15 | `implement` |
| `review` | quality .7, cost .2, speed .1; soft-exclude last implementer **and** last reviewer (fallback when empty) | `review` |
| `fix` | speed .4, cost .4, quality .2 | `implement` |

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

After **every** report, persist the outcome before picking the next role: call
`delegation_workflow_update` with `last_verdict` (or `fanout_verdicts` for a
fanout), `report_text`, and the fresh `material_revision` from
`readDelegationMaterialRevision(cwd)`, under a stable per-review
`idempotency_key`. A parent restart must not lose the last verdict or the
artifact revision that verdict reviewed.

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
`task_outcome`, `interrupt_code`, `verdict`, and a short summary — not the
report body. Page `delegation_show` / `delegation_inbox` for content. Follow
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
  If the reviewer's `traits.review_can_run_tests` is `false` (no native shell or
  a read-only hook), the **parent MUST** run the catalog tests.
- **`waiting_for_input`** (OpenCode question/permission or SDK Ask on
  implement/fix): keep polling `delegation_wait`; do not infra-retry or free
  the fanout slot until the user approves in the child chat or the job reaches
  a terminal status.
- **Infra** (`failed`/`cancelled` with empty report, `code=adapter_timeout`,
  `adapter_incomplete`, first-event timeout, ChatGPT/Codex **usage limit**,
  harness quota, one-line thinking dump): wait until `slot_occupied` is false,
  then `model_pick` with `exclude_model` = the failed id. Review never picks
  `*flash*` ids. Use `exclude_harness` **only** with concrete evidence that the
  harness itself is unavailable, rate-limited, or over quota (a usage-limit
  error, `adapter not ready`, provider outage); otherwise exclude just that
  model with `exclude_model` and keep the harness. Start the next candidate
  with a **new** idempotency key (replay returns the failed job). Never retry
  the same model/harness after an infra failure. If no different candidate
  exists, stop as `BLOCKED` and include the provider/quota reason; do not burn
  three retries on a dead sub-chat. Example: child `1502cdb2` on `codex` /
  `gpt-6-astra` hit a usage limit — fall back to Composer on `sdk` and, because
  the quota evidence is concrete, use `exclude_harness=codex`. Cap 1 infra
  retry per role. Do not stop sibling fanout reviews. Do not infra-retry
  `VERDICT: FAIL`/`BLOCKED`.
- **BLOCKED**, unspecified after a full report read **and** infra retry, or
  loop **timeout** → stop. Do not start another child in `loop` mode.
- **`interrupted`**: only a job with `interrupt_code=server_restart` may be
  continued, and at most **once** per record. Continue it with a new
  idempotency key, then never continue that record again. `starting_timeout`,
  `running_orphan`, any other `interrupt_code`, and legacy interrupted rows
  with an empty code are stop-only — report the code to the user and do not
  retry the record.

## Rate the job (`delegation_rate`)

After you read a report, rate the finished job as its parent:

```
delegation_rate({ delegation_id, score, tags?, note? })
```

`score` is an integer **1–5** (5 = best). `tags` are optional telemetry only —
allow-list `missed_bug`, `false_positive`, `scope_creep`, `too_slow`, `great`
(max 5, de-duplicated); they never move the speed/cost axes. `note` is an
optional short line (max 500 chars).

Rules (the server enforces them; do not work around them):

- **Terminal jobs only** — rating a running job is `CONFLICT`.
- **Parent only** — the calling session must be the job parent; a child chat is
  rejected, and you cannot rate someone else's job (`OUT_OF_SCOPE`).
- **Anti-bias** — a parent cannot rate a job on its own base model
  (`self_model_rating_denied`); rate a job run by another model.
- **Immutable** — one rating per (job, rater). An identical replay succeeds
  (`replayed: true`), a changed payload is `CONFLICT`. There is no edit or
  delete; a mistake stays on record.
- The **user** rates from the delegation card in the UI (weight 2× yours in the
  aggregated mean). Never rate as the user.

**Required** — call `delegation_rate` in these two cases, do not skip it:

1. after a review cycle **FAIL → fix → PASS**: rate the review job that issued
   the FAIL (the cycle proved its findings were real);
2. when you **reject a report** — `conflict`, an empty/thinking-dump body, or a
   report you discard instead of acting on: rate that job down and tag why
   (typically `missed_bug` / `false_positive`).

Every other rating (a PASS review, an implement/fix job, an infra failure you
had to route around) is optional. Ratings feed `model_pick` quality for **all**
roles, including `review`.

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
