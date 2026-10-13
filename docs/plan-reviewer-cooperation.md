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

## Divergence

`divergenceSummary` and `aggregatedVerdict` on the session are recomputed from
each reviewer's independent (or exchange) verdict. The coordinator uses this to
highlight agreement vs disagreement without collapsing individual reports.

Related: [`todo-review-contract.md`](todo-review-contract.md) (todo `review` field and plan review subject).
