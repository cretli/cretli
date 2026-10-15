# Picking a model

Detail for `cretli-multi-harness` — read when a role needs a candidate, not
before.

## 1. Eligibility

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
   (`traits.review_can_run_tests: true`), then fewest delegations for the role
   in 7d, then fewest uses of that model in 7d, then least-recently-used, then
   id.
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
   (Codex unless the uncertified flag is on). A **named** Flash id still starts
   if it is a Settings favorite and the assignment is allowed. Empty Settings
   favorites for a harness are **unset**: no pick and, by default, no
   `delegation_start` from that harness (`model_list(..., enabled_only=true)`
   is empty). Catalog rows without that flag are not start-eligible. Legacy
   `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores start-with-any-id when the
   list is empty (pick still skips that harness).
4. If `model_pick` returns nothing, stop that role as BLOCKED unless a
   documented fallback role still has a favorite.
5. `candidates[1]` is the infra fallback. Cap **1** infra retry per role after
   an empty `cancelled`, adapter failure, timeout, or usage/quota signal. The
   fallback must use a different model or harness; never start the same
   model/harness again for the same role after an infra failure. If no
   different candidate exists, stop as `BLOCKED` and report the concrete
   provider/quota reason.

## 2. Roles (axes)

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

## 3. Fanout picks and review traits

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
`openrouter`, `mistral`, `opencode`, `codebuddy`, `qwen`, `codex`; `false` for `sdk` and
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

## 4. Premium-model restraint

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

## Reviewer pool (`prefer_models`, opt-in)

When `reviewer_pair_enabled` is on with a complete `reviewer_pair_members`
(Settings → Delegations), review picks pass the two members as `prefer_models`
(`[{ harness, model }, ...]`) and `count=2`: `picks[0]` and `picks[1]` are the
round's two reviewers (with `count=1` the survivor is returned again, never a
replacement). The picker never reads settings. Hard excludes (implementer,
`exclude_model(s)`, closure limits, lockouts) always win: a member removed by
them is replaced by the normal pick in `picks[1]` and the response carries
`rotation.pool = { members, honoured, degraded, missing }`. With no surviving
member the normal pick and the existing relaxation path apply. On infra/quota
failure of one member call `model_pick` again WITHOUT `prefer_models`, with
`exclude_models` = failed member + surviving member + implementer and `count=1`,
within the existing single retry; never block.
Omitting `prefer_models` leaves picks unchanged.
