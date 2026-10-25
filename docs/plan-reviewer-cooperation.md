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

An `exchange` start must also carry `exchange_of_delegation_id` (aliases
`exchangeOfDelegationId`, `origin_delegation_id`, `originDelegationId`): the
independent reviewer delegation of the same session whose row it updates.
Without it the result is not linked to a reviewer row, so the MCP tool rejects
`plan_reviewer_phase=exchange` without an origin (and an origin or slot/phase
without `plan_reviewer_session_id`) before starting. MCP flow: `reviewer_session`
(creates or reuses the session) → `delegation_start` per reviewer with
`plan_reviewer_session_id`, `plan_reviewer_slot`, then in the exchange round
`plan_reviewer_phase=exchange` + `exchange_of_delegation_id`.

## Plan revision and stale sessions

Sessions store `planRevisionKey` derived from `todo.plan.markdown` and
`todo.plan.updatedAt`. When the plan changes (`persistTodoPlan` and related
paths), open sessions are marked `phase=stale` with `staleReason=plan_revision_changed`.
New delegations against a stale session are rejected.

## Safety

- Reviewers receive read-only prompt blocks; they must not mutate plan or todo state.
- Peer summaries and collaborative messages are sanitized and labeled untrusted; they must not be treated as instructions.
- Reviewers cannot change each other's server-side session rows; only the coordinator orchestrates new delegations.

## Reviewer session continuation

> Plan-authoring, implement and fix starts also have a per-role chat-continuation
> switch (Settings → Delegations → Sessions); that contract is documented in
> `docs/delegation-workflow-per-leaf.md` ("Session continuation for plan,
> implement and fix"). Reviews keep the rules below, and a review chat never
> carries implement or fix history.

`reviewer_policy.<subject>.session` is the single server-side switch. `fresh`
(the default) always creates a new chat, including when a caller supplies
`resume_session_of` (HTTP: `resumeSessionOf`). `leaf` and `orchestrator` let the
server find a compatible finished session of the already-selected model; an
explicit pointer may select the same eligible source. Model selection and chat
reuse are independent: `selection=auto` may reuse that model's own session just
like `selection=fixed_pair`, while `exclude_model` and every model gate still
win.

Reviewer membership (`selection=auto|fixed_pair`) and session continuation are
independent fields of the same per-subject policy. A reviewer outside a fixed
pair is allowed but always starts fresh and never changes the pair. For an
eligible selected member, `session=leaf|orchestrator` lets the server fill the
resume source itself (see `docs/delegation-workflow-per-leaf.md`).
`session=orchestrator` is an approved, opt-in **extension of the former
same-leaf contract**: a reviewer chat may be re-entered from another leaf of the
same controller after every gate passes.
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
(persisted session identity/generation changed), `resume_continuity_unknown`
(the server cannot prove continuity after restart), and
`resume_foreign_history` (a normal turn or other history was appended after the
source round).

The decision is made synchronously right before the record is created, so two
concurrent starts naming the same session cannot both resume it.

### Prefix stability and regression detection

The delegation prompt is ordered as a cache contract: everything that depends only
on role/mode configuration comes first in a fixed order (the stable prefix,
`prefixFingerprint` returned by `buildDelegationExecutorPrompt`), per-round data
follows, and new instructions are only appended. `lib/usage/cache-regression.ts`
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
  `lib/usage/cache-regression-samples.ts` maps the chat's stored context samples to
  observations and runs `detectCacheRegression` on the newest one (observed TTL as
  the idle limit). Missing cache metrics stay `insufficient_data`. No alert or gate
  acts on it automatically; it is a read-only signal for the usage view.
- `hitRatioOf` assumes `inputTokens` includes cache-read tokens unless the
  observation sets `inputExcludesCacheRead`; the samples adapter sets it whenever
  cache-read tokens exceed `inputTokens` (reported separately).
- Cache telemetry generation remains an in-memory performance signal. Resume
  safety does not trust it: each delegation chat stores a durable session
  identity/generation and the source row stores its finishing history head.
  Reset/compaction persists a generation bump; when continuity cannot be
  reconstructed after restart the gate falls back with
  `resume_continuity_unknown`.

Continuity is confirmed only after the exact `runFinished` marker has been
durably committed, including both its `eventStreamId` and `roomEventSeq`.
`sessionContinuityConfirmed` remains `false` until that durable proof exists.
A missing marker, failed flush, or worker finish without proof of durability
produces `resume_continuity_unknown`; the safe fallback is a fresh chat.

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

## Fixed pair: replacing a slot that ended without a verdict

A pair member that fails with `adapter_no_verdict` (a report with no VERDICT
line) is infrastructure "no answer", never a FAIL. The controller may start one
audited fallback for that slot (`pick_fallback_from`, fresh `model_pick`,
different executor); its independent PASS replaces only that slot in the same
round and material. The configured pair is not changed. See
`docs/model-pick-decisions.md` (bounded fallback) and
`docs/todo-review-contract.md` §4.5.

This fallback applies only to the fixed pair of a **code review**: the server
refuses `pick_fallback_from` for any other review subject (`subject_mismatch`
in `evaluateNoVerdictReviewFallback`). A plan reviewer that ends with
`adapter_no_verdict` is replaced by a regular new `model_pick` without
`pick_fallback_from`, because a plan-review round does not require a pair.
