# Internal operator decision (operator-in-Cretli, tree `e3060e01`, leaf 1)

Date: 2026-11-05. Status: **accepted by the owner on 2026-11-11, decision 10 with an amendment** (see
§10, "Owner amendment"). This ADR decides
how the operator role (today an external MCP client driving Cretli, plus a periodic
shell/cron check) moves *inside* Cretli as one operator that converses with the
owner, reacts to events and manages every registered workspace. It changes no code,
settings, registry entry or data. Every API, table, setting and tool named below is
either marked *(exists)* and was verified in this repository at the time of writing,
or marked *(proposed)*. Implementation belongs to the later leaves of tree
`e3060e01` (section 12) and each of them needs the plan approval it already has plus
refinement against this ADR **after** the owner accepts it.

Each decision below has the same layout: **Context**, **Variants**, **Recommendation**
(with rationale) and **Status**. The owner accepted decisions 1–9 as written and
decision 10 with the amendment in §10 on 2026-11-11. Review
acceptance for this leaf: two independent reviewers, then the owner.

Related documents: [workspace-watcher.md](workspace-watcher.md),
[decision-cards.md](decision-cards.md),
[mcp/OPERATOR-PLAYBOOK.md](mcp/OPERATOR-PLAYBOOK.md),
[voice-control-coverage.md](voice-control-coverage.md),
[usage-contract.md](usage-contract.md),
[model-pick-decisions.md](model-pick-decisions.md),
[INSTALL.md](INSTALL.md), [ARCHITECTURE.md](ARCHITECTURE.md).

## Summary of recommendations

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Scope | One global operator, one owner thread; workspace context loaded per run |
| 2 | Run model | Event → short run with fresh context + server-built briefing + journal; stable chat identity as the owner thread |
| 3 | Wake and cost | Typed event queue with priorities, coalescing, runs/hour and token budgets, model per event type |
| 4 | Permissions | Server-side grant table with `observe` / `propose` / `act`; a fixed never-by-operator list |
| 5 | Prompt injection | Agent-authored text is data only, typed ids only in privileged calls, cards for irreversible effects |
| 6 | Restart / self-modification | Durable restart intent, drain, supervisor-only restart, interrupted run resumed from queue, protected paths |
| 7 | Watcher and external operator | Watcher keeps the deterministic path; operator handles exceptions; external operator = emergency, lease-arbitrated |
| 8 | UI | One pinned operator chat + "awaiting you" panel + proposals as decision cards |
| 9 | Migration | Six stages with measurable gates; cron stays until the owner confirms |
| 10 | Voice | Voice model stays the speech/UI layer; operator is the management back end; limited card confirmation, never plans/push/data/secrets |

## 0. What exists today (verified)

- **Watcher** *(exists)*: deterministic, no LLM, one per workspace; in `autopilot` it
  starts one short-lived orchestrator chat per cycle which delegates implement /
  review / fix and ends with `watcher_report` (docs/workspace-watcher.md). Guardrails
  include a per-UTC-day cycle budget (`maxCyclesPerDay`), cooldown, backoff and quiet
  hours (`lib/workspace-watcher-guardrails.js`).
- **External operator** *(exists)*: an MCP client in `operator` mode using
  `operator_*` tools (`lib/mcp/mcp-external-operator-tools.js`): `operator_handoff`,
  `operator_note`, `operator_chat_send` / `_wait` / `_stop`, `operator_plan_approve`,
  `operator_plan_review_start`, `operator_integrate_tree` / `_status`,
  `operator_watcher_status` / `_pause` / `_clear_stop` / `_limits` / `_policy` /
  `_release_unknown`, `operator_settings_get` / `_set`, `operator_server_status`,
  `operator_todo_reserve` / `_release`, `operator_scout_enable`. Restart is
  deliberately not exposed (`operator_server_status` description).
- **Journal and lease** *(exists)*: `lib/persist/operator-journal-persist.js` keeps
  `operator_notes` (kinds `decision`, `question`, `in_progress`, `temporary_setting`,
  `lesson`), `operator_sessions`, `operator_leases` (per workspace, TTL 90 s,
  explicit `takeover=true`) and `operator_events` in `operator-journal.sqlite`.
  Today `operator_events` holds only the operator's own actions; state-transition
  producers and an event endpoint are leaf A7 of todo `ba147b08` *(proposed, not yet
  integrated)*.
- **Decision cards** *(exists)*: `lib/decisions/*`, [decision-cards.md](decision-cards.md).
  Human-only kinds `plan_approval`, `integration`, `policy_upgrade`; resolution via
  `POST /api/decisions/:id` accepts only a cookie session with CSRF and rejects
  `isAgentSessionRequest` (403 for bearer MCP, widget and agent sessions). Today's
  general-purpose adapter only delivers the answer to the source chat; typed
  server-side effects per kind are leaf 3 of this tree *(proposed)*.
- **Restart** *(exists)*: `POST /api/dev-actions` `restart-server`, gated by
  `resolveServerRestartGate` (`lib/server-restart-policy.js`): supervised or
  non-production only, refused with active delegations unless `force`, which records
  jobs as `interrupted` / `server_restart`. The supervisor (`lib/cretli-supervisor.js`)
  probes health, backs off, detects crash loops and can switch to safe mode.
  `autoRestart` is a sensitive Watcher policy field.
- **Voice** *(exists)*: `work` and `approval` action families, two-step confirm with a
  60 s window bound to id, workspace and chat, `untrusted: true` on todo/delegation text,
  no plan approval by voice ([voice-control-coverage.md](voice-control-coverage.md) §8–9).
- **Notifications** *(exists)*: producers under `lib/notifications/` (supervisor,
  memory monitor, condition checks, usage-limit resume, harness recovery).
- **Usage ledger** *(exists)*: [usage-contract.md](usage-contract.md); `model_pick`
  selects models per role from Settings favorites with observed outcomes
  ([model-pick-decisions.md](model-pick-decisions.md)).

Motivation (from the review of the external operator's sessions, 2026-10-30 to
2026-11-05): thousands of shell commands and hundreds of MCP calls through helper
scripts, 83 periodic checks of which most found no change, important events waiting
for the next tick, and a transcript so large that only compaction keeps it usable.

## 1. One global operator vs one per workspace

**Context.** The owner has several registered workspaces and wants one conversation.
Journal notes and the lease are per workspace *(exists)*; the external operator
already targets other registered workspaces with `workspace` plus a lease on each.

**Variants.**
- **A. One operator per workspace.** Strong isolation; but N threads for the owner, N
  budgets, cross-workspace questions ("what is waiting for me") need aggregation
  anyway, and idle workspaces still cost a configured identity.
- **B. One global operator with per-workspace context.** One identity and thread; each
  run loads the context of the workspace(s) its events concern.
- **C. Global router + per-workspace specialist runs.** B plus a second model tier;
  adds a second prompt surface without a measured need.

**Recommendation: B.** One owner thread matches the stated goal (talk to one
operator; execution chats are created automatically). Isolation is kept where it
matters: each run is bound to a **workspace set** derived from its events, tools take
the workspace from the run context (not free text), the lease is taken per workspace
for the duration of a mutating run, and the journal stays per workspace
*(exists)*. Cross-workspace actions in a single run are allowed only for `observe`
and `propose`; a mutating `act` is limited to one workspace per run *(proposed)*.
C is a later optimisation if triage cost dominates.

**Status: accepted (owner, 2026-11-11).**

## 2. Run model: events → short runs + journal; the owner thread

**Context.** The external operator accumulated a ~43 MB transcript and relies on
compaction. State that must survive is already externalised: todo state, the
workspace journal *(exists)* and the Watcher snapshot.

**Variants.**
- **A. One endless operator chat.** Simple UI; unbounded context cost, compaction
  loss, and one stuck turn blocks all events.
- **B. One chat per run, no stable identity.** Cheap and isolated; the owner has no
  single place to talk and continuity is lost.
- **C. Stable operator identity (one chat record, the owner thread) with each run as a
  fresh-context execution.** The thread shows a run header, the run's report and any
  proposals; the model context for run *n* is built by the server, not carried over.

**Recommendation: C.**
- **Identity** *(proposed)*: one chat of a new type `operator`, created once, not
  deletable or archivable by the operator itself, visible in the UI (decision 8).
- **Run** *(proposed)*: a record `{runId, trigger event ids, workspaces, model, state,
  startedAt, tokens, outcome}`. States: `queued`, `running`, `done`, `failed`,
  `interrupted`. At most one run executes at a time (the operator is serial; the
  Watcher already provides parallelism for the work itself).
- **Context** *(proposed)*: a server-built **briefing** — the batched trigger events,
  the open `operator_notes` of the involved workspaces, a compact state summary (the
  compact `operator_handoff` / `todo_list` / `watcher_show` shapes from leaf A1 of
  `ba147b08`), and the last run summaries. Not the raw history of earlier runs.
  Anything the model needs beyond that it fetches with read tools.
- **Memory**: the journal (`operator_note`: decisions, questions, in-progress,
  lessons) and todo/changelog state. A run must write what the next run needs
  before it ends; the server rejects a `done` outcome for a run that handled events
  but wrote neither a note nor a proposal nor an explicit "no action" outcome.
- **How the owner thread links runs**: every run appends to the one operator chat a
  header (trigger, workspaces, model), the tool-call summary and the final report.
  An owner message is itself an event (priority 0, decision 3) that starts a run
  whose briefing includes the last N thread messages (N small, e.g. 20; *proposed*)
  and the open questions. The owner never sees "sessions"; they see one stream.
- **Crash safety**: events are acknowledged only when the run that consumed them
  reaches `done`; an `interrupted` or `failed` run re-queues its unacked events once,
  then parks them with a visible marker (decision 6).

Whether the harness can start a genuinely fresh session inside a pinned chat record
is to be verified by leaf 2 before implementation; if not, fall back to variant B for
the execution chat with the stable thread as a rendered view over run records.

**Status: accepted (owner, 2026-11-11).**

## 3. Wake sources, priorities, cost limits, model per event type

**Context.** Cron-driven checks wake the operator every 30 minutes with mostly no
change; real events wait. Leaf A7 of `ba147b08` defines the first source set.

**Wake sources** (A7 events are *(proposed)* until integrated):

| Priority | Source | Origin |
| ---: | --- | --- |
| 0 | Owner message in the operator chat; voice request (decision 10) | UI / voice |
| 1 | Supervisor crash loop, safe mode, health kill; Watcher stopped automatically (`stopReason` set); memory/stall alarms | supervisor + Watcher + notifications |
| 2 | `review_failed`, `needs_rescope`, `blocked` / `needs_human` cycle reports | A7 producers |
| 3 | `integration_ready` | A7 producer |
| 4 | Daily "awaiting you" digest (plans to approve, reviews to accept, `needs_human`, blocked trees) | A7 digest producer |
| 5 | Heartbeat fallback | server timer |

The heartbeat is **deterministic first**: a cheap server-side check compares the
state hash with the last run's; it only queues a run when something changed or an
item has waited longer than a threshold. A heartbeat with no change makes **no LLM
call**. Stall events (> 30 s) are out of A7's scope and may join as priority 1 later.

**Cost limits** *(proposed defaults, all configurable in Settings, enforced
server-side by the queue, not by the prompt)*:
- Coalescing: events of the same workspace and kind inside a 60 s window become one
  trigger; identical `dedupeKey` collapses.
- Runs per hour: 12 global; per workspace 6. Priority 0 and 1 are exempt from the
  hourly cap but not from the per-run caps or the daily token budget (see below).
- Token budget: per-run cap (triage 60k, diagnosis 250k, integration 400k) and a daily
  global budget measured from the usage ledger ([usage-contract.md](usage-contract.md)).
  At 80 % the operator drops to triage-only. At 100 % the daily budget is a hard stop:
  no further LLM runs start, for any priority, and the owner is notified once. The
  only exception is a separate emergency reserve of 10 % of the daily budget, usable
  by priority 0/1 runs alone and with the per-run caps still applied; when the
  reserve is exhausted the hard stop applies to every priority, and the owner
  is notified a second time. Deterministic server actions (supervisor, Watcher stop)
  never depend on the operator's budget.
- Circuit breaker: three consecutive failed runs pause event-driven runs (owner
  messages still run) until cleared; reuses the Watcher's backoff idea.
- Queue bound: at most 200 pending events; overflow keeps the newest per
  (workspace, kind) and records a dropped counter in the journal.

**Model per event type** *(proposed; via `model_pick` against Settings favorites, not
hard-coded ids)*:

| Event | Role / tier |
| --- | --- |
| Digest, heartbeat-with-change, `integration_ready` triage | cheap triage model |
| `review_failed`, `needs_rescope`, `needs_human` | mid-tier; escalate to strong only if triage cannot classify |
| Supervisor crash loop, watcher stop diagnosis, integration conflicts | strong model |
| Owner message | mid-tier by default, strong on request |

**Variants considered.** (a) Fixed 30-minute poll (status quo, rejected: cost without
latency). (b) Pure event-driven without heartbeat (rejected: a lost event or a quiet
failure goes unnoticed). (c) Event-driven + deterministic heartbeat (chosen).

**Status: accepted (owner, 2026-11-11).** The numeric defaults are starting
values to be calibrated in stage 1 (decision 9) against measured usage.

## 4. Permission boundaries enforced in the server

**Context.** Boundaries must hold if the model is wrong or hijacked. The existing
model already works this way for cards and plans: the server, not a prompt, returns
403. External operator tools today include `operator_plan_approve`, used when the
owner explicitly instructs it — the internal operator must not inherit that.

**Variants.**
- **A. Prompt-level rules.** Rejected: not enforceable.
- **B. Reuse the external operator's tool set and lease unchanged.** Too broad
  (includes plan approval, sensitive settings).
- **C. A distinct internal principal with a server-side grant table.** Each tool call
  carries the principal; the server checks `(action, level, grant)` before the domain
  code runs, audits the call and returns 403 (`never` list) or a typed denial.

**Recommendation: C.** Levels:
- **observe** — read-only: todos, trees, Watcher state, delegations (summary),
  chats status, notifications, usage, journal, server status.
- **propose** — produce a record the human decides: `operator_note`, decision card of
  a new kind `operator_proposal` *(proposed)* with typed server adapters, draft todos
  in `idea`, draft plan text (never approval), prompt-change proposals (stay pending
  until a human approves; already the rule for the external operator).
- **act** — a server-executed change, only with an explicit, revocable, audited grant:

| Grant *(proposed)* | Covers |
| --- | --- |
| G1 todo structure | leaf scopes, ordering, move/defer, reserve/release, start plan review, message to an executor chat via the inbox |
| G2 local integration | run `operator_integrate_tree`-class integration (merge/smart-merge) **without** confirming it |
| G3 supervised restart | restart through the supervisor after a drain (decision 6) |
| G4 Watcher settings | non-sensitive limits and policy fields, pause/resume, clear a loop-guard stop |

Grants are granted progressively (decision 9), stored in Settings *(proposed)*, also
settable via `operator_settings_set` for the external operator, revocable at any
time, and every `act` call writes an audit entry (principal, grant, parameters,
result, run id).

**Never by the operator, regardless of grants** (a call returns 403; no grant exists):
plan approval (`plan.approvedAt`), confirming or rejecting an integration
(`humanAttested`), `policy_upgrade`, push or merge to a protected/main branch, any
operation on real data (deleting data, migrations of the live `data/` store, backup
restore), secrets and credentials, the sensitive Watcher fields (`requirePlanApproval`,
`planApprovalScope`, `requireReviewForDone`, `requireIndependentReview`,
`autoIntegrate`, `autoRestart`, `worktree.prepareCommand`, `worktree.dirtyPolicy`),
Watcher `mode`, changing its own grants, prompt or kill-switch. The operator may
**prepare** the corresponding human-only card (`plan_approval`, `integration`); the
owner decides it through the existing human channel. This is the same list as
decision-cards.md ("Server risk policy" and hard exceptions) plus the operator-specific
items.

**Status: accepted (owner, 2026-11-11).**

## 5. Prompt-injection protection

**Context.** Executor reports, todo bodies, changelog entries, review findings, chat
messages, commit messages, file contents and scout findings are written by agents that
read untrusted repositories and web pages. An operator that reads them and holds
tools is the classic confused-deputy target.

**Data-only (never instructions, never copied into privileged parameters):**
delegation reports and verdict text, todo titles/bodies/changelog, review findings,
chat messages from any non-owner principal, `operator_note` text authored outside the
operator, commit messages, diffs and file contents, scout findings, feedback
submissions, notification text derived from any of these. They are delivered in a
delimited envelope tagged with source and marked `untrusted: true` (the convention
already used for voice results), length-capped, with control characters stripped.

**Instruction channels (the only ones that can steer the operator):** the owner's
messages in the operator chat (authenticated UI session), voice input from the owner
(decision 10), and the operator's own system prompt plus the stored playbook. A
prompt change proposed by the operator stays pending until a human approves it
*(exists for the external operator)*.

**Variants.**
- **A. Rely on model robustness / prompt warnings.** Rejected as the only layer.
- **B. Structural controls in the server.** Chosen.
- **C. Block all `act` when any untrusted text was read in the run.** Too restrictive:
  every run reads reports.

**Recommendation: B**, concretely *(proposed)*:
1. Privileged tool parameters are **typed ids and enums** validated against server
   state; free text is accepted only in `note`/`message` fields, which are themselves
   data to the next reader.
2. Every `act` call carries a **precondition** (todo revision / event id) re-checked
   by the server; a mismatch is a denial (compare-and-swap, the pattern used by
   cards: `stale`).
3. `act` is permitted only for actions that **derive from a server-produced event or
   a card the owner decided**, not from a quoted instruction.
4. **Irreversible or externally visible** actions (restart with delegations, anything
   in the never list, anything touching real data) go through a decision card
   decided over the human channel; the card text is rendered from server fields plus
   quoted evidence marked untrusted.
5. Rate limits and per-run action caps (e.g. at most N `act` calls per run) bound a
   hijacked run's blast radius; exceeding them aborts the run and notifies the owner.
6. Every run stores the ids of the untrusted items it read, so an incident can be
   reconstructed from the audit.

**Status: accepted (owner, 2026-11-11).**

## 6. Restart and self-modification

**Context.** The operator runs inside the server it may need to restart, and may
integrate changes to Cretli's own code. A restart kills the run that requested it
(`SIGTERM` to harness children; `interrupted` / `server_restart`).

**Variants.**
- **A. No restart for the internal operator** (propose only; the owner or the external
  operator restarts). Safest, but leaves the manual step that motivated this work.
- **B. Direct restart call from a run.** Loses the run and risks active delegations.
- **C. Restart as a durable intent executed by the server outside the run.**

**Recommendation: C, under grant G3**, *(proposed)*:
1. The operator calls a `restart_request` tool with a reason. The server writes a
   durable **restart intent** (`{id, runId, reason, requestedAt}`) and ends the run
   as `done` with outcome `restart_requested`.
2. The server **drains**: sets "block new Watcher starts", waits for active
   delegations to finish (the gate `resolveServerRestartGate` already refuses
   otherwise); `force` is never used by the operator.
3. It restarts **only when supervised** (`isSupervised`); unsupervised or
   `NODE_ENV=production` without supervisor → denial, proposal card to the owner.
4. After boot, the queue's first event is `server_restarted` referencing the intent,
   so a fresh run verifies health (`operator_server_status` class read) and reports
   to the owner thread. An intent not confirmed within a timeout becomes a
   priority-1 event.
5. A run interrupted by a restart it did not request is marked `interrupted` and its
   unacked events are re-queued once (decision 2).
6. The supervisor's crash-loop and safe-mode behaviour (`lib/cretli-supervisor.js`)
   is the backstop: a bad restart must not loop; in safe mode the operator is
   `observe`/`propose` only and the external operator is the recovery path (decision 7).

**Self-modification.** The operator may integrate leaves into the working tree (G2)
but confirming the integration stays human. Changes touching **protected paths** —
the grant table, the operator tool gate, the decision-resolution route and human-only
checks, auth, the supervisor, and this operator's own run/queue code *(list to be
fixed in leaf 4)* — never restart automatically: a `restart_request` whose delta
since the last restart touches a protected path is converted to an `integration` /
confirmation card for the owner. The operator never edits its own grants or prompt.

**Status: accepted (owner, 2026-11-11).**

## 7. Relation to the Watcher and to the external operator

**Context.** The Watcher is deterministic and cheap and must stay the normal path.

**Who decides what.**

| Concern | Decides |
| --- | --- |
| Claiming the next ready leaf, starting cycles, guardrails, backoff, cycle budget | Watcher (server, no LLM) |
| Plan / implement / review / fix loop of one cycle | Cycle orchestrator chat (existing) |
| Exceptions: why a tree is stuck, rescope proposals, classification of failures, cross-workspace view | Internal operator |
| Conversation with the owner, digest | Internal operator |
| Plan approval, integration confirmation, push, real data, secrets | Human only |
| Watcher knobs | Internal operator under G4 (non-sensitive fields only), otherwise propose |
| Todo reservation | `reservedBy: operator` already makes the Watcher leave the todo alone *(exists)* |

The operator never starts a cycle itself and never re-implements guardrails; it
reads the Watcher's decision log (`GET /api/workspace-watcher/decisions`,
docs/workspace-watcher.md) and acts on exceptions.

**External operator and lease.** The lease is per workspace, TTL 90 s, explicit
`takeover=true` *(exists)*. *(Proposed)* the internal operator takes the lease under a
reserved internal client identity for each workspace only while a run mutates it,
releases it at the end, and treats a lost lease as an immediate run abort followed by
`standby` for that workspace until the owner resumes it. An external operator that
needs control uses the existing `takeover=true`, which is therefore the **emergency
override**. A global **kill switch** (internal operator enabled/disabled) is reachable
from Settings and from the external operator's settings tool *(proposed)*.

**Emergency mode.** The external operator is MCP over the same server: when Cretli is
down it cannot connect. The real emergency path is the host shell and the supervisor
(logs, `systemd`/launchd restart as documented in INSTALL.md); once the server is
back, the external operator can connect, take the lease and diagnose. `operator_guide`
and the playbook describe both modes (leaf 5).

**Variants.** (a) Internal operator replaces the Watcher: rejected, loses determinism
and cost profile. (b) Operator only advises, never acts: kept as stage 1. (c) Split
as above: chosen.

**Status: accepted (owner, 2026-11-11).**

## 8. UI

**Variants.** (a) A single chat only; (b) a dedicated panel only; (c) a pinned chat
plus a compact panel plus the existing Decisions panel.

**Recommendation: (c)** *(proposed)*:
- **One pinned operator chat** at the top of the chat list, labelled as the operator,
  not archivable by the operator. It shows the owner thread of decision 2 (run
  headers, reports, owner messages) and a state chip: `idle`, `running`, `queued N`,
  `paused`, `budget`, `standby`.
- **"Awaiting you" panel** (from the A7 digest data): plans to approve, reviews to
  accept, `needs_human`, blocked trees, pending proposals — each a link to the
  existing place that resolves it.
- **Proposals are decision cards** of kind `operator_proposal` (decision 4) in the
  existing Decisions panel and push channel. A card shows: one-line statement of the
  proposal; why now (the triggering event); the **effect preview** (what changes, on
  which todo, at which revision); evidence quotes visibly marked as agent-authored;
  options (Accept / Decline / Ask more) with a risk badge; a `stale` state when the
  subject changed. Human-only kinds keep their existing UI.
- **Operator settings**: enable switch (kill switch), grants G1–G4 with last-used
  time and audit link, cost limits, model choice per event type.

**Status: accepted (owner, 2026-11-11).**

## 9. Migration: cron, external operator, stage gates

**Context.** The current process works but is costly; it must not be switched off
before the replacement has proven itself. Cron (the periodic external check) and the
external operator stay until stage 4.

**Stages** (map to the tree leaves; a stage starts only when the previous gate is
met and the owner agrees):

| Stage | Content | Gate to leave it *(proposed thresholds)* |
| --- | --- | --- |
| 0 | Foundations of `ba147b08` integrated (A1 compact answers, A3 inbox, A7 events/digest); this ADR accepted | A7 acceptance tests pass; owner acceptance recorded |
| 1 | Internal operator in **observe + propose** next to cron (leaf 2) | ≥ 7 days; every state change the cron check reported also produced an event and run summary within 10 min (0 missed); run cost within the daily budget; 0 injection incidents; ≥ 80 % of reports judged useful by the owner on a sample |
| 2 | Proposals as decision cards with typed adapters (leaf 3) | ≥ 7 days; no duplicate or stale-applied cards; rejections logged; the 403 tests for agent resolution pass |
| 3 | Grants G1…G4 one at a time (leaf 4) | per grant: ≥ 7 days and ≥ 20 uses with 0 reverted by the owner; audit complete; revoke works |
| 4 | Cron off, external operator becomes emergency path (leaf 5) | **7 days with no missed event** confirmed by the owner; emergency procedure rehearsed on a server restart |
| 5 | Voice interface (leaf 6) | stages 1–2 stable; voice tests (decision 10) pass; live measurements remain a separate human run and are not a gate |

**Rollback** at any stage: the kill switch returns to cron + external operator, which
stay installed until stage 4; the queue is kept so nothing is lost. Cron is disabled
only after the owner confirms the stage 4 gate — a time gate, not an automated test.

**Status: accepted (owner, 2026-11-11).**

## 10. Voice as an operator interface (leaf 6)

**Context.** The voice layer (`lib/voice/*`, OpenAI Realtime and Gemini Live) has a
fixed tool registry with confirmation contracts. Accuracy and p95 measurements are
pending a paid human session and are not a condition of this ADR.

**Role split** *(proposed)*:
- **Voice model**: conversation, speech, quick UI actions exactly as today (navigation,
  chats, models, `work`, `approval`). It does not reason about the state of the
  project.
- **Operator**: management questions and commands ("what is happening in my-app",
  "why is a tree stuck"). The voice model forwards them as a priority-0 event with
  the transcript (data, not instructions to the voice model) and reads back the
  operator's **short spoken answer**.
- New read-only voice actions *(proposed)*: awaiting-you digest, Watcher and cycle
  state, todo and tree summary. Spoken forms drop paths and identifiers and are
  length-capped; operator- or agent-derived text carries `untrusted: true`.

**Management actions by voice.** Allowed: all reads above; pause/resume of the
Watcher (already available as `work` actions); asking the operator to investigate;
confirming an **operator_proposal card that is not human-only** with the contract
below. Not by voice (initially): restart, grant changes, scope extension of a leaf,
starting integrations.

**Card confirmation by voice (contract).**
1. The voice session may confirm a card only if it **read that card aloud in the same
   session** (as `describedRequestIds` binds approvals), the card kind is not
   human-only, and its action type is on a voice-allowed list *(proposed: defer,
   reorder, reserve, note)*.
2. The owner must say the card's **name repeated** (not a bare "yes"); window 60 s,
   bound to card id, workspace and chat; any other intervening action or id cancels
   it (same contract as `work`).
3. The confirmation reaches the **existing** resolution route
   (`POST /api/decisions/:id`) from the owner's authenticated UI tab (cookie + CSRF);
   no new route, no separate token, and neither the voice model nor the operator can
   resolve a card with their own credentials. How the voice session maps to the UI
   session: the voice tools already execute in the owner's browser tab, so the
   resolution call is made with that tab's session. The audit entry carries
   `source: voice`, which is **client-asserted and used for audit only, never for
   authorisation** — server rules (human-only kinds, CAS, `stale`) apply identically.
4. Risk: a spoken confirmation cannot prove who spoke (ambient audio, replayed TTS).
   Recommendation: the voice-allowed list is restricted to reversible
   housekeeping actions; any card with risk above medium needs an on-screen tap even
   when read aloud.

**Never by voice:** plan approval (existing contract: "No plan approval by voice"),
integration confirmation or rejection, `policy_upgrade`, push or merge, any real-data
operation, secrets, grants, kill-switch changes. Human-only cards can only be *read*
and the owner is pointed to the UI.

**Variants.** (a) Voice as plain text input to the operator chat with no actions
(simplest, no confirmation surface); (b) the contract above (chosen as a proposal);
(c) voice resolves all non-human-only cards. The **owner choice** to make: whether the
voice-allowed list may include medium-risk actions (as proposed above) or must stay
empty until the card risk table has a low-risk reversible kind (today none exists, so
the strict variant means no voice confirmation at all).

**Owner amendment (2026-11-11).** The never-lists in decision 4 and above bind the
**operator principal** (an AI acting on its own). The owner speaking is a human channel,
so an explicit, opt-in **full voice authority** mode lets the owner decide human-only
cards by voice:

- Off by default; switched on in Settings by the owner, revocable at any time, and every
  use is audited with `source: voice`.
- Covers `plan_approval`, `integration` and `policy_upgrade` cards (and the other card
  kinds above). Each needs: the card was read aloud in the same session; the owner says
  the card's name and a **voice passphrase** set in Settings (never sent to the model,
  checked on the client before the tool runs); a 60 s window bound to card id, revision,
  workspace and chat; any other action or id cancels it.
- The resolution still goes through the existing human route from the owner's UI session;
  the voice model and the operator cannot resolve these cards with their own credentials.
- Stays touch-only even in this mode: push or merge to a protected/main branch, any
  operation on real data, secrets and credentials, grants, kill-switch changes.
- Accepted risk: a spoken passphrase can be overheard; the mode is meant for a private
  car or room, and the owner can turn it off.

**Status: accepted with the owner amendment above (2026-11-11).**

## 11. Open questions for the owner

1. Are the numeric defaults in decision 3 acceptable as a starting point?
2. Is the voice-allowed action list in decision 10 acceptable, or should voice stay
   read-only until step-up verification for stolen sessions exists (the gap noted in
   decision-cards.md)?
3. Which paths count as protected for decision 6?
4. Is the stage 4 time gate (7 days, no missed events) the right bar?

## 12. Implementation leaves (refined by this ADR once accepted)

| Leaf | Result | Depends on |
| --- | --- | --- |
| 2 | Operator chat: run model, event queue, limits, observe/propose tools | accepted ADR + `ba147b08` A1/A3/A7 |
| 3 | `operator_proposal` card kind with typed adapters | leaf 2 |
| 4 | Grant table, Settings section, audit, protected paths | leaf 3 |
| 5 | Cron off after the owner's gate; external operator as emergency path; lease handover | leaf 4 |
| 6 | Voice interface per decision 10 | leaves 2–3 |

No implementation leaf starts before the owner accepts this ADR and the leaf is
re-read against it.
