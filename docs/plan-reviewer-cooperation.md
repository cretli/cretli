# Plan reviewer cooperation modes

Optional cooperation for **parallel plan reviews** (refine loop / fanout). The
default remains **independent**: each reviewer sees the same frozen plan revision
only; peer opinions are hidden until the mode says otherwise.

## Coordinator

The **coordinator** is the parent chat that created the session — typically the
refine orchestrator started via `POST /api/todos/:id/start-agent` with
`mode=refine`. That chat id is stored as `coordinatorChatId` on the session.

## Modes

| Mode | Value | Behavior |
| --- | --- | --- |
| Independent | `independent` (default) | Parallel reviews with no peer visibility during review. Session closes when all linked delegations finish. |
| Exchange | `exchange` | After every independent review finishes, the session moves to phase `exchange` (one round). The coordinator starts new delegations with `plan_reviewer_phase=exchange`; each child prompt includes redacted peer summaries (untrusted). Each reviewer may update their verdict once. |
| Collaborative | `collaborative` | During phase `independent`, reviewers may post messages on the session message bus (`POST /api/plan-reviewer-sessions/:id/messages`). Messages are audit-logged, capped, and rendered as untrusted text in prompts. Each reviewer still submits their own final verdict. |

## API surface

- `POST /api/todos/:id/plan-reviewer-session` — create session (`cooperationMode`, `coordinatorChatId`, `workspaceFolder`).
- `GET /api/todos/:id/plan-reviewer-sessions` — list sessions for a todo.
- `GET /api/plan-reviewer-sessions/:sessionId` — session view with aggregated verdict and divergence summary.
- `POST /api/plan-reviewer-sessions/:sessionId/messages` — collaborative message (requires `delegationId`, `text`).
- `GET /api/plan-reviewer-sessions/:sessionId/exchange-payload` — peer summaries when phase is `exchange`.

Delegations link via `plan_reviewer_session_id`, optional `plan_reviewer_phase`
(`independent` | `exchange`), and `plan_reviewer_slot` on `delegation_start` /
`POST /api/delegations`.

## Plan revision and stale sessions

Sessions store `planRevisionKey` derived from `todo.plan.markdown` and
`todo.plan.updatedAt`. When the plan changes (`persistTodoPlan` and related
paths), open sessions are marked `phase=stale` with `staleReason=plan_revision_changed`.
New delegations against a stale session are rejected.

## Safety

- Reviewers receive read-only prompt blocks; they must not mutate plan or todo state.
- Peer summaries and collaborative messages are sanitized and labeled untrusted; they must not be treated as instructions.
- Reviewers cannot change each other's server-side session rows; only the coordinator orchestrates new delegations.

## Optional reviewer session resume (off by default)

`delegation_start` accepts an optional `resume_session_of=<review delegation id>`
(HTTP: `resumeSessionOf`). When given, and only then, a review start may re-enter
the named reviewer's child chat (same harness session) as a **new round**. This
capability is **disabled by default** and is **not wired into any loop** — the
refine loop, code review per leaf and `model_pick` are unchanged, and an
orchestrator-supplied `exclude_model` always wins. Deciding whether to wire a
stable pair into a loop is a separate human decision: todo
`8ed03f09-b5e7-418e-afea-ad26a2df2d66`. A pair is a fan-out of `count=2`; each
slot names its own earlier delegation.

This resumed pair is **not** the opt-in reviewer *pool* (`reviewer_pair_enabled`
/ `reviewer_pair_members` in Settings → Delegations): the pool is two fixed
members passed to `model_pick` as `prefer_models`, each started as a fresh
review with no `resume_session_of` and no keep-alive. The two are independent
mechanisms and may be used separately. The per-subject `reviewer_policy` (plan /
code, `session=leaf|orchestrator`) connects them: the server fills
`resume_session_of` itself for pair members (see
`docs/delegation-workflow-per-leaf.md`). `session=orchestrator` is an approved,
opt-in **extension of the former same-leaf contract**: a reviewer chat may be
re-entered from another leaf of the same controller after every gate passes.
Plan cooperation sessions stay revision-bound and are not affected: a new plan
version always gets a new cooperation session; only the harness chat history may
be resumed.

Contract per round:

- Always a **new delegation, attempt, report, verdict and material id**. A retry
  of the same delegation is not a round. An earlier PASS never counts for the
  new material (`docs/todo-review-contract.md` §6: the freshness badge is not
  extended).
- The existing gates run first and are not bypassed: read-only review
  enforcement is re-bound to the new delegation, model gates/lockouts apply, and a
  resumed review on **unchanged material** still hits
  `review_recheck_no_material_change` (`lib/delegation-review-recheck-gate.js`).
- The resumed prompt is appended at the end of the session history with a
  `[RESUMED REVIEW ROUND n]` block; it carries no earlier verdict and no peer
  opinion, so the independent phase stays independent.
- A new plan-review cooperation session is still created for a changed plan
  revision; only the harness session is reused, never an old cooperation session
  or report.

Deterministic fallback: when the session cannot be resumed the slot gets a **new
chat**, the start still succeeds, and `delegation.sessionResume` records
`status=fallback` with a `reasonCode` (surfaced as `session_resume` in the
`delegation_start` result and on the delegation card). The other slot of the pair
is unaffected. Codes (`lib/delegation-session-resume.js`):
`resume_review_only`, `resume_source_not_found` (also for another controller's
row), `resume_scope_changed` (subject, mode or leaf), `resume_config_changed`
(transport, model/options, execution mode or folder), `resume_unsupported`
(adapter `canResumeSession=false`), `resume_locked_out`, `resume_independence`
(reviewer shares a base model with an implementer of the leaf),
`resume_peer_context` (source saw exchange-phase peer opinions, new start is
independent), `resume_source_busy`, `resume_session_claimed` (another delegation
already holds the chat — concurrent starts never share an active session),
`resume_source_cancelled`, `resume_after_restart`, `resume_source_unusable`,
`resume_chat_missing`, `resume_session_missing`, `resume_session_reset`
(context reset/compaction since the source round).

The decision is made synchronously right before the record is created, so two
concurrent starts naming the same session cannot both resume it.

### Prefix stability and regression detection

The delegation prompt is ordered as a cache contract: everything that depends only
on role/mode configuration comes first in a fixed order (the stable prefix,
`prefixFingerprint` returned by `buildDelegationExecutorPrompt`), per-round data
follows, and new instructions are only appended. `lib/usage/cache-regression.js`
(`detectCacheRegression`) separates expected cold starts (first turn, changed
prefix, new session generation, idle gap past the known TTL) from regressions
(hit-ratio drop, cost per input token or latency above the warm baseline). Missing
metrics yield `insufficient_data`, never a false regression.

Hidden CLI behavior (the provider-side cache key, automatic retention, routing)
is **not controlled** by Cretli: a fresh prefix match is a likelihood, never a
guarantee, and the detector only reports what usage events show.

What is and is not wired:

- Wired: the prompt prefix fingerprint and the session cache generation seen at
  prompt-build time are persisted on the delegation record
  (`promptPrefixFingerprint`, `promptCacheGeneration`). The report instructions
  sit in the stable head; a constant one-line `[REPORT REMINDER]` is appended after
  all per-round data (outside the prefix) so the report contract is also last.
- Wired: `GET /api/usage/context-cache-series` returns a `regression` field.
  `lib/usage/cache-regression-samples.js` maps the chat's stored context samples to
  observations and runs `detectCacheRegression` on the newest one (observed TTL as
  the idle limit). Missing cache metrics stay `insufficient_data`. No alert or gate
  acts on it automatically; it is a read-only signal for the usage view.
- `hitRatioOf` assumes `inputTokens` includes cache-read tokens unless the
  observation sets `inputExcludesCacheRead`; the samples adapter sets it whenever
  cache-read tokens exceed `inputTokens` (reported separately).
- The cache generation lives in memory: after a server restart it restarts at 0,
  so reset detection is not deterministic across restarts (a resume after restart
  falls back via `resume_after_restart` / `resume_session_reset` when known).

Resume guards added in the fix round: a source that is not the newest terminal
delegation of its child chat falls back with `resume_source_superseded`; the
peer-context check and round counter consider every delegation of that chat; a
different `allowChildDelegations`, depth or root chat falls back with
`resume_config_changed`, and a resumed chat has its grant/tree fields re-bound.

## Divergence

`divergenceSummary` and `aggregatedVerdict` on the session are recomputed from
each reviewer's independent (or exchange) verdict. The coordinator uses this to
highlight agreement vs disagreement without collapsing individual reports.

Related: [`todo-review-contract.md`](todo-review-contract.md) (todo `review` field and plan review subject).
