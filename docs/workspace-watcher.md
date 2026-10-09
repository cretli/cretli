# Workspace Watcher

The Workspace Watcher is a **deterministic, server-side guard** that runs one
per workspace (keyed by the normalized workspace folder). It watches ready
todos, live chats and delegations and, when autopilot is enabled, starts the
next piece of work through the multi-harness loop. The guard itself contains
**no LLM**: it only snapshots, decides and applies guardrails. The LLM runs in a
short-lived orchestrator chat that the watcher starts for one cycle and then
forgets.

This document is the operator/debugging reference. The condensed architecture
summary lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md); this file adds the
guarantees, the notification behavior and a practical `decisionLog` guide.

## Contents

- [Architecture](#architecture)
- [Modes](#modes)
- [Lifecycle of a cycle](#lifecycle-of-a-cycle)
- [Guarantees](#guarantees)
- [Workspace Memory](#workspace-memory)
- [Scout](#scout)
- [Worktree execution, Git context and integration](#worktree-execution-git-context-and-integration)
- [Notifications](#notifications)
- [Policy reference](#policy-reference)
- [Control surfaces](#control-surfaces)
- [Debugging through the decision log](#debugging-through-the-decision-log)
- [Tests](#tests)

## Architecture

```
todo / chat / delegation signals
        │
        ▼
snapshotWorkspaceWatcher()      lib/workspace-watcher.js
        │  ready leaves, busy/unknown chats, delegation slots, waiting chats
        ▼
decideWorkspaceWatcherAction()  lib/workspace-watcher.js   (pure)
        │  guardrails: lib/workspace-watcher-guardrails.js  (pure)
        ▼
tickWorkspaceWatcher()          lib/workspace-watcher.js   (CAS write + lease)
        │  records one bounded decision line
        ▼
runWorkspaceWatcherAutopilot()  lib/workspace-watcher-cycle.js
        │  reconcile → tick → start
        ▼
startWorkspaceWatcherCycle()    lib/workspace-watcher-cycle.js
        │  reserve (lease + activeCycles slot) → CAS claim todo → start chat run
        ▼
one short-lived orchestrator chat  (the parent of one multi-harness loop)
        │  model_pick + delegation_start → implement / review / fix
        ▼
watcher_update action "report"  (tool: watcher_report)
        │
        ▼
close cycle → release claim + lease → next tick may start the next cycle
```

The watcher store is optional. A corrupt or unreadable watcher document is
reported in reconcile errors and never rethrown, so a damaged watcher file
cannot degrade the delegation runtime; the bytes are left untouched for an
operator to repair.

| File | Role |
|------|------|
| `lib/persist/workspace-watchers-persist.js` | Durable row, singleton lease, bounded decision log, CAS document, cross-process file lock |
| `lib/workspace-watcher.js` | Snapshot, pure decision, tick, boot reconcile, todo claim/release |
| `lib/workspace-watcher-guardrails.js` | Pure budget / cooldown / backoff / quiet hours / loop guard |
| `lib/workspace-watcher-cycle.js` | Start, report, reconcile and the autopilot pass |
| `lib/workspace-watcher-cycle-close.js` | Shared close accounting (used by report, runtime reconcile and boot reconcile) |
| `lib/workspace-watcher-orchestrator.js` | Resolve the cheap orchestrator harness/model (favorites, readiness, usage limits) |
| `lib/workspace-watcher-prompt.js` | The single source of the one-cycle prompt contract |
| `lib/workspace-watcher-control.js` | REST/MCP-facing control semantics |
| `lib/routes/workspace-watcher-routes.js` | HTTP transport |
| `lib/mcp/builtin/watcher-tools.js` | MCP tools |
| `lib/workspace-watcher-event-schedule.js` | Debounced per-workspace pass (1.5 s) |
| `lib/workspace-watcher-live.js` + `lib/agent-presence-bus.js` | Live fan-out over the existing chat-list WebSocket |

### Durable state

Each row stores: `mode`, `enabled`, `paused`, `stopReason`, `policy`, the
singleton `lease`, up to `policy.maxParallel` entries in `activeCycles`,
`cycleCount`, bounded `reports`, bounded `cycleChats`, `failures` (per todo),
`findings`, `planRequests`, `cycles` (`{ day, count }`) `lastCycleAt`,
`backoffUntil`, `notified` and the bounded `decisions` log. Each cycle record
is `{ cycleId, todoIds, startedAt, chatId, runId, phase,
startDeadlineAt, planOnly, mode, requestedHarness, requestedModel,
requestedSource, reportedOutcome, reportedAt, reportId }`. `activeCycle`
mirrors slot 0 for older servers that still read the v1 field only.

`cycleId` is reserved **before** the adapter is asked to start and is reused as
the chat-run `requestId`, so a retry replays instead of duplicating.

`cycleCount` is a **monotonic row counter** incremented once per cycle closed
through `buildWorkspaceWatcherCycleClosePatch` (a real report or reconcile). It
does **not** count reservations rolled back before running, it is not per todo,
and it is not a time window. Do not use it as a denominator for success or
coverage rates; use the bounded `cycleChats` window for the dashboard display
and the durable metrics store (below) for ratios.

### Durable cycle-metrics store

Comparing orchestrator models needs more history than the 20-slot `cycleChats`
window, and it needs the cycles that never reached `running`. A separate file,
`data/workspace-watcher-cycles.json`, keeps one record per `cycleId`:

```
{
  v: 1,
  collectionStartedAt,        // when the store was first written
  updatedAt,
  retention: { ms, maxRecords },
  errors: { count, lastAt, lastCode, lastMessage, lastOperation } | null,
  records: { "<cycleId>": record }
}
```

A record carries `mode` (`plan`/`implement`), `orchestratorChatId`,
`orchestratorRunId`, `todoIds`, the requested pair
(`requestedHarness`/`requestedModel`/`requestedSource`), the confirmed
`harness`, `startedAt`/`closedAt`, `phase`, `reachedRunning`,
`closeSource` (`report`/`reconcile`/`abort`), `closeReason`, `reportedOutcome`,
`closeOutcome` and `todoStatusAtClose`. **Unknown is `null`, never guessed**:
a legacy cycle without a stored model keeps `requestedModel: null`, and the
confirmed `model` stays `null` until usage telemetry provides it (a later
work). The record is created at reservation, so a start that ends in `starting`
is still counted; requests/run id are stamped as they resolve.

#### Cycle results and TODO-leaf outcomes

One Watcher cycle is one orchestrator attempt; a retry is a later cycle for the
same claimed TODO (the durable identity is `cycleId`, and the claim is a separate
field on the todo). A record therefore keeps the **claimed** and **reported** ids
apart:

- `claimedTodoIds` come from the Watcher claim (`todoIds` is kept as the same
  claimed set for backward compatibility),
- `reportedTodoIds` are only the report's ids that the workspace confirms exist,
- `unknownReportedTodoIds` are reported ids that do not resolve in the workspace
  — they are recorded but never counted as completed,
- `todoOutcomes` is a per-leaf snapshot (`attempted`/`completed`/`blocked`/
  `unknown`) taken from the TODO state at close, and `completedTodoIds` lists the
  verified completions. A missing TODO or an unreadable store is `unknown`, not
  a success.

`reportedOutcome` is the model's claim and `closeOutcome` is the verified result;
they stay separate fields on purpose. Plan-only cycles are a separate population
(`planOnly: true`): their verified success is a **saved plan** (`planSaved`), not
a `done` TODO, so their time/cost is never pooled with implementation cycles.
Blocked reasons are derived only from structured fields (`planOnly`, the close
decision reason, the Watcher stop reason, the per-leaf snapshot) and stored as
`blockedReasonCode`; the free-text report message is never parsed. A
multi-leaf cycle's cost stays at the cycle level and is not divided per leaf.

Idempotency is by `cycleId` (the map key): a duplicate close returns the first
record unchanged and never appends a second one. Retention is explicit in the
document: `retention.ms` (default 30 days, matching the usage ledger) drops
settled records by age and `retention.maxRecords` (2000) caps the file; live
records (no `closedAt`) are never dropped by the cap. A metrics write is
**telemetry**: a failure is recorded in `errors` and the event log but never
interrupts a start, a rollback or a close.

Usage correlation deliberately does **not** add a `cycleId` field to usage
events in this step. The record already carries `orchestratorChatId` and
`orchestratorRunId`, which are the natural join keys for the run-scoped usage
ledger; a later leaf can derive workspace scope from the cycle and correlate by
run key without a usage-event schema change. If that proves insufficient, adding
`cycleId` to new usage events stays an explicit follow-up, not a silent
inference.

## Modes

| Mode | Meaning | Writes | Starts agents |
|------|---------|--------|---------------|
| `off` | Default. Nothing happens. A missing row answers as `off`. | Never | No |
| `observe` | Snapshots and records one decision; pushes an "idle, there is work" notification once per episode. | Yes (decision/heartbeat) | No |
| `autopilot` | Everything `observe` does, plus it may reserve and start cycles (up to `maxParallel`). | Yes | Yes, under the guardrails |

`off` is a **true no-op**: the tick returns without writing, and the autopilot
pass only scans `autopilot` rows (`observe` is driven by the heartbeat). This is
the regression contract covered by `tests/workspace-watcher-e2e.test.js`.

Legacy `enabled: true|false` still maps to `observe|off`; autopilot must be set
explicitly.

## Lifecycle of a cycle

1. **Trigger** — a debounced per-workspace pass (todo/chats/delegation events) or
   the runtime worker heartbeat.
2. **Reconcile** — each dead entry in `activeCycles` (chat confirmed idle/missing
   and no live children) is closed independently; stale claims are released.
3. **Snapshot** — ready leaves, busy/unknown chats, delegation slots, waiting
   chats. The watcher's own cycle chat and its delegated children are excluded
   from occupancy, so it never waits on work it started.
4. **Decide** (`decideWorkspaceWatcherAction`, pure) — `observe_ready`, a
   startable `start_cycle` / `plan_gate`, or a wait.
5. **Reserve** — inside the cross-process lock: acquire the lease, append to
   `activeCycles` with `phase: 'starting'` (and mirror slot 0 to `activeCycle`),
   bump the UTC-day budget, and create the durable cycle-metrics record (so a
   start that never reaches `running` is still counted).
6. **Claim** — CAS `ready → doing` with `claimedByChatId`; a failure rolls the
   reserve back and releases the claim.
7. **Start** — resolve the orchestrator pair, stamp it on the metrics record and
   the live slot, then create the orchestrator chat and start its run with the
   cycle id as the request id. The lease is renewed while `starting`.
8. **Run** — the orchestrator is the parent of exactly one multi-harness loop:
   it uses `model_pick` + `delegation_start` for plan/implement/review/fix,
   marks the todo done only after an independent review PASS, and **never**
   commits, pushes, merges or starts the next cycle.
9. **Report** — the orchestrator ends with `watcher_report` (or
   `watcher_update` action `report`) carrying
   `success | blocked | failure`. The report is idempotent: replaying the same
   `report_id`/`reportId` is a no-op. A foreign chat cannot close the cycle.
10. **Close** — `cycleCount` and `failures` are updated once, the claim is
    released only if this chat still owns it, and the todo returns to `ready`
    (or `blocked` at the failure ceiling). The shared row lease is dropped only
    when no sibling slot is left: while another cycle is still live the lease
    stays (closing one `maxParallel > 1` slot must not hand the workspace to a
    second driver). The next tick may start the next todo.

## Guarantees

### Singleton lease (one watcher per workspace)

- All watcher writes run under one reentrant **cross-process file lock** (a
  lock database next to the watcher store).
- The lease is `{ ownerPid, token, expiresAt }`. A live lease held by a different
  token is **never stolen**; the same token renews; an expired lease is free.
- Default TTL is 30 s; the cycle start path renews it until the start deadline
  (120 s).
- Two server processes (or a crash-restart pair) therefore cannot both drive a
  workspace: the loser's tick aborts with `lease_held`. Covered by
  `tests/workspace-watcher-e2e.test.js` (spawned lease holder) and
  `tests/workspace-watcher.test.js` (cross-process CAS/lock tests).

### Parallel cycles and claims (no duplicates)

- `startWorkspaceWatcherCycle` refuses when `activeCycles.length >= maxParallel`
  (`cycle_active`); the reserve mutator re-checks the cap inside the lock.
- Closing one cycle keeps the row lease while any sibling cycle is still live.
- The todo claim is a CAS on the live `updatedAt`: a `doing`/`done`/changed todo
  is never overwritten, and a claim is only released by the chat that still owns
  it (a newer owner is never disturbed).
- Claim selection prefers a compatible assignee, then sibling order, then the
  oldest update; leaves at the failure ceiling / identical-findings streak are
  skipped.
- A start failure rolls the reserve back, releases the claim and arms the
  backoff; an *uncertain* start keeps the cycle in `phase: 'starting'` and
  records `stopReason: cycle_start_uncertain` instead of guessing.
- After a cycle closes, its orchestrator chat is archived and recorded in
  `cycleChats`. A late mailbox reply to that chat is marked delivered
  (`skipped_cycle_closed`) and does not start another run. The chat's own
  leftover busy tail does not count toward `maxParallel` unless it still holds
  a todo claim or an active delegation. A truly external busy chat still fills
  the slot, and unknown liveness (an adapter error on that chat, or any other
  chat) still waits. Archive itself is refused (`CHAT_ARCHIVE_BUSY`) while the
  orchestrator or a nested child still has a live run, so a busy cycle chat
  stays in the sidebar until the run is idle.

### Plan gate (never auto-approves)

- With `requirePlanApproval` (the default), the first time an unapproved todo is
  picked the watcher starts a **plan-only** cycle and records
  `planRequests[todoId]`. Later ticks wait (`wait_plan_approval`).
- The plan text is `plan.markdown` on the leaf or its nearest ancestor. When
  that field is empty, the nearest container description is the plan. A
  container already queued (`ready`, `doing`, or `done`) counts as accepted, so
  its leaves are implemented instead of reported as `plan_missing`.
- Approval is inherited. `plan.approvedAt` on the leaf or any ancestor,
  including the top parent, unlocks the whole subtree. A closer unapproved
  draft does not keep the leaf behind the plan gate, and it does not block
  children in the todo tree. Sequential siblings still wait for earlier ones.
- The orchestrator saves the draft with a real CAS (`save_plan`) and **never**
  sets `plan.approvedAt`. Only a human approves via the UI/API. Plan cycles
  therefore cannot loop; an empty plan cycle counts as a failure, clears the
  request and retries under the backoff/failure ceiling.

### No commit / push / merge, no nested cycles

- The cycle prompt encodes the hard rules: one cycle = this chat run only, never
  start another cycle, never commit/push/merge, complete a todo only after an
  independent review PASS.
- Delegations are one level deep (the server enforces it), so children of a
  cycle do not start further delegations.

### Guardrails

Pure and clock-injected:

- per-UTC-day cycle budget (`cycles.day` / `count`, resets at midnight UTC),
- cooldown since `lastCycleAt`,
- exponential backoff from the accumulated failures, capped by `backoffCapMs`,
- UTC quiet hours (HH:MM, wraps midnight),
- consecutive same-findings stop (`maxSameFindings`),
- `allowedHarnesses` allow-list plus **real** usage-limit awareness
  (`listHarnessUsageLimits`); a limited model is excluded, and an unlimited
  allow-list still blocks harnesses under an active limit.

### Restart reconcile

On boot and on every autopilot pass, `reconcileWorkspaceWatcherCycle` closes a
cycle whose orchestrator chat is confirmed idle/missing and whose child
delegations are terminal. The cycle identity is re-checked inside the write
lock, so a race cannot drop a newer cycle. Unknown chat liveness keeps the cycle
and blocks a new one rather than dropping work on ambiguity. A repeated
reconcile is a no-op (no double failure, no double `cycleCount`).

### Claims and blockers

Failure-ceiling blockers are stored as `blockedReason` plus a changelog entry on
an otherwise `ready` todo, not as a fifth status. A manual status update clears
them. Blocked leaves are not picked, so one stuck todo cannot crowd out fresh
work.

### Orphaned `doing` todos (recovery states)

`releaseStaleWorkspaceTodoClaims` — the same reconcile that runs on boot, on
every autopilot pass and before `claim_next` — classifies every `doing` row
(`lib/workspace-watcher-recovery.js`). The state is computed, never stored, and
is returned as `snapshot.doingStates` / `snapshot.recovery` by `watcher_status`
and `GET /api/workspace-watcher`:

| State | Meaning | Evidence (`evidence` / `reason`) |
| --- | --- | --- |
| `active` | a run or delegation slot holds the work | busy probe, occupied slot (`delegation_in_progress`, `run_stopping`), a cycle still `starting` |
| `dependency` | the row aggregates children; its status follows them | `children` |
| `user_action` | a human has to decide | `blockedReason`, last delegation reported `blocked`, executor chat idle but still open |
| `recoverable` | executor confirmed finished or gone, no occupied slot | confirmed idle claim owner, deleted chat, idle **archived** chat |
| `unknown` | liveness or identity cannot be confirmed | `state_missing`, `adapter_missing`, `adapter_error`, `run_mismatch`, `missing_identity` |

Only `recoverable` is released (`doing` → `ready`, claim cleared) and it then
starts through the normal cycle path. `unknown` never becomes `recoverable`
because of age, a transport error or an expired `claimLeaseUntil` — the lease is
written at claim time and never renewed, so it is not a liveness signal. A
`doing` row without a claim is released only by an unpaused, unstopped
autopilot; `off` and `observe` report it. The executor of an unclaimed row is
resolved from a delegation `leafId`, the todo `chatId`, its `orchestratorChatId`
or the nearest ancestor's; `linkedChatIds` never identifies an executor.

#### Lease, unknown escalation and policy

`claimLeaseUntil` is written once at claim time and **never renewed**; an expired
lease alone never releases work. Liveness comes only from executor probes and
cycle rules (`WORKSPACE_WATCHER_ROOM_GONE_GRACE_MS` applies only to the
room-gone reconcile path in `workspace-watcher-cycle.js`, not to
`state_missing` / `adapter_missing`).

`unknown` rows stay `unknown` until probes can classify them. In **`observe`**
and **`autopilot`**, after `policy.unknownEscalationObservations` consecutive
heartbeat observations (default **6**, one per delegation-runtime tick ≈ **5s** →
about **30s**), the operator gets a **deduplicated** push when the
`(state, reason, evidence)` signature changes; signatures live in
`watcher.unknownTodoEscalations`. The observe heartbeat only detects and
reports — it does not claim, release, or restart. **`off`** performs no
automatic escalation on heartbeat. **`paused`** or a non-empty **`stopReason`**
suppresses escalation notify; quiet hours, daily cycle budget and the plan gate
do **not** gate escalation reports (they only gate starting new cycles).
Automatic **release** of recoverable rows (including unclaimed leaves) remains
**autopilot-only**; there is no `allowUnclaimed` bypass.

`policy.recoverIdleOpenChat` (default **false**) keeps the deliberate default:
executor chat confirmed idle but still **open** stays `user_action`. When **true**,
that case classifies as `recoverable` and may release through the same fenced
path (still leaf-only, autopilot gates for unclaimed rows, CAS + revalidation).
The flag never promotes `unknown` to `recoverable`.

Automatic release and manual **Wznów** both call
`recoverWorkspaceWatcherTodo` (`POST /api/workspace-watcher/todos/:id/recover`,
MCP `watcher_recover_todo`). Responses distinguish `released`, `conflict`,
`already-active`, `unknown`, `user-action` and `blocked`. A successful manual
recover sets the todo to `ready` and **starts a new execution** on the next
claim. Recovery CAS failures do **not** increment `watcher.failures`; only
finished cycles with outcome `failure` do (same `maxConsecutiveFailures` ceiling
and backoff as before).

The release is fenced. Each claim stores `execution` on the todo (`attemptId`,
`key`, `todoRevision`, `source`, `chatId`, `cycleId`, `phase`, plus one
`previous` attempt); the run id lives on the cycle row joined by `cycleId`. The
decision is re-validated under the store lock against the todo revision, the
attempt id, the delegation slots and the probe. A claim replayed by the same
cycle returns the existing attempt, and a release from an older cycle cannot
free a newer attempt. A corrupt watcher store is unknown state: nothing is
released and the file is left untouched.

## Workspace Memory

Every orchestrator cycle starts with a clean context, so `Workspace Memory` is
the small durable fact store that carries knowledge across cycles. It lives in
`data/workspace-memory/<workspaceKey>.json` where `workspaceKey` is
`workspaceKeyFromCwd(workspaceFolder)` — the same sha256-of-realpath identity
todos use (no separate `workspaceId`).

Each entry has a `type` (`decision`, `pattern`, `finding`, `blocker`,
`context`), a short `key`, a `value`, and an optional `expiresAt` stamped from
`ttl_ms`. Omission of a TTL is not always permanence: a recognized transient
blocker key defaults to 24 h, `permanent: true` forces a permanent entry (and
conflicts with an explicit TTL), and every other entry without a TTL stays
permanent. Expired entries are hidden lazily on every read.

A write is an **upsert on `type` + normalized `key`**: re-adding the same key
updates that entry in place (new `value`, `source` and `expiresAt`; same `id`
and `createdAt`, fresh `updatedAt`) and drops older historical duplicates of the
same identity, while distinct blocker causes of one todo stay separate. The
store is bounded (500 entries; the least recently updated record leaves, using
`createdAt` as fallback and the id as a stable tie-break) and every write runs
under the shared cross-process file lock with a document CAS, so parallel cycles
cannot lose each other's facts.

`buildWorkspaceWatcherCyclePrompt` renders the facts as a `WORKSPACE MEMORY`
section capped at 8 entries and 3000 characters in total (header, separators and
the omitted-count footer included). Relevance wins over age: facts that
reference the cycle's todo, its ancestors or the plan target (`todoIds`, collected
at cycle start) come first, then the newest global harness/model blocker per
harness+model, then the remaining facts by type (blocker → decision → finding →
pattern → context) and recency. Duplicate topics collapse to the newest
`updatedAt` (falling back to `createdAt`), while distinct causes of the same todo
stay separate. Long values are cut at a sentence (or word) boundary and marked
with an ellipsis; entries beyond the budget are summarized with a pointer to the
list tool. The optional previous-cycles section gets at most 1000 characters and
the whole prompt is capped at 7000; a fixed contract that cannot fit that budget
is refused at start with `prompt_too_long` instead of being shortened. The prompt
also instructs the orchestrator to write the cycle's decisions, findings and
blockers back with `wmem_add` before it reports. A Scout scan reads the same store
with `wmem_list` before re-scanning a workspace.

MCP tools (`lib/mcp/builtin/memory-tools.js`):

- `wmem_add` — upsert one typed fact (`ttl_ms` / `permanent` optional)
- `wmem_list` — paginated live facts, most recently updated first (`types` filter, `cursor`)
- `wmem_delete` — remove one fact by id

Blocker keys follow one shared convention (`lib/workspace-memory-key.js`):
`blocker:todo:<uuid>:<cause>` or `blocker:harness:<harness>:<model-or-*>:<cause>`
(the model is percent-encoded). Transient causes are `quota`, `rate_limit`,
`slot_busy` and `model_unavailable`; they default to a 24 h TTL unless an
explicit `ttl_ms` or `permanent: true` is given. Any other cause (and any legacy
free-form key) stays permanent. Readers parse the convention for relevance and
deduplication but never rewrite older, free-form keys.

## Scout

Scout is a **separate periodic read-only LLM scan** that proposes work. It is
deliberately *not* a watcher cycle: it never enters `activeCycles`, never spends
the `cycles`/`maxCyclesPerDay` budget, and never claims a todo. It has its own
schedule and budget on the same row:

- `lastScoutAt` — last scan start (ISO)
- `scoutScans` — `{ day, count }` UTC-day budget, independent of `cycles`
- `pendingScoutFindings[]` — proposals with a `status`
  (`pending` / `accepted` / `rejected`)

Implementation: `lib/workspace-watcher-scout.js` (`buildScoutPrompt`,
`parseScoutFindings`, `collectScoutSignals`, `decideScoutRun`,
`runWorkspaceWatcherScoutPass`). The delegation-runtime heartbeat calls
`runWorkspaceWatcherScoutPass` after the autopilot pass, so the trigger is a
cron-like watcher-loop pass rather than an event per code change.

A scan:

1. passes `decideScoutRun`: policy `scoutEnabled`, mode `observe`/`autopilot`,
   not paused/stopped, outside quiet hours, `scoutIntervalHours` elapsed,
   `scoutMaxPerDay` not exhausted;
2. stamps `lastScoutAt`/`scoutScans` under the store lock (a failed start rolls
   the stamp back) and gathers read-only signals: a diff against the resolved
   profile base,
   `git log --oneline -20`, TODO/FIXME/HACK markers in changed files, optional
   test results and error logs, existing todos, prior review findings and
   Workspace Memory;
3. starts one host-enforced read-only `agent`-mode chat (`[Scout] <workspace>`) and asks it to submit
   findings through `scout_findings` (or a fenced JSON block the runner
   parses);
4. dedupes the proposals against existing todos, pending/resolved findings and
   Workspace Memory entries that mark an area as already explored, then stores
   them as `pendingScoutFindings` and appends a notice to the pinned chat.

### Git scope and diagnostics

Changes scope combines tracked paths from `git diff` with new untracked paths
from `git ls-files --others --exclude-standard`. Both pass through the same
include/exclude matcher and existing file cap. The tracked diff contains only
those matched paths and retains the existing signal-size cap. Untracked files
are identified in the prompt so the read-only agent can inspect them directly.

The default base remains `main`. Every explicit branch, tag or commit must
resolve to a commit; an invalid explicit base blocks the scan. In a repository
with `master` and no `main`, select `master` or explicitly choose `auto`.
Only `auto` permits fallback, in the fixed order `main`, `master`, `HEAD`.
Preview, prompts and scan history show the resolved name and commit. File
listing and diff use that same pinned commit, even if the branch moves later.

Git trusts only the repository containing the selected workspace via an exact,
per-command `safe.directory`. It never writes global/repository configuration
or uses `safe.directory=*`. Optional index locks, filesystem-monitor hooks,
lazy fetching, external diff helpers and text conversion are disabled for these
reads. Ownership errors, missing repositories/bases/executables, timeouts and
other command failures retain diagnostics; they never become an empty result.

Manual starts and scheduler starts both stop before launching a model when
scope collection fails or genuinely matches no files. Their reservations and
workspace/profile budgets are refunded. History records `failed` with a Git
diagnostic for a scope error, or `skipped` for an empty scope. Preview exposes a
scope error as a blocker and suppresses the misleading “no files” message.

Categories: `bug`, `improvement`, `refactor`, `security`, `opportunity`,
`documentation`. The `refactor` rubric carries extra heuristics (oversized
file/function split candidates, duplicated blocks, mixed responsibilities, deep
nesting) so a proposal is a small, behavior-preserving, independently reviewable
seam rather than a rewrite.
A finding is `{ id, title, category, rationale, plan_markdown, files[], status }`.
When `policy.scoutAutoCreate` is true, submitting a finding immediately creates
an `idea` todo (idempotent on the finding id) with its proposed plan as an
unapproved draft. Otherwise, `accept` creates the TODO. `approvedAt` stays empty
until a human approves the draft in the UI. A read-only scan runs in agent mode
under the host's read-only tool policy; the
`scout_findings` `list`/`submit` actions are the only mutating builtin
MCP calls allowed there (accept/reject stay Agent-only).

Settings → Workspace Watcher → Scout shows the schedule the heartbeat will use:
`computeScoutSchedule()` (`lib/workspace-watcher-scout.js`) reuses the same
`decideScoutRun` gate and exposes it as the additive `scout` field on
`GET /api/workspace-watcher` (`nextScanAt`, `lastScoutAt`, `usedToday` /
`maxPerDay` / `remainingToday`, `running` / `maxParallel`, `pendingFindings`,
and the live `blockedReason`). A spent daily budget pushes `nextScanAt` to the
next UTC midnight, while a live blocker (pause, quiet hours, parallel cap) is
reported separately instead of moving the schedule. The panel renders it as a
per-second countdown and a **Run scan now** button; that button calls
`runWorkspaceWatcherScoutNow()` through `POST /api/workspace-watcher/scout`
`{ action: 'run' }`, which bypasses the interval for the explicit run but still
respects mode, quiet hours and the per-day budget.

Settings → Workspace Watcher → Settings opens with the same "when / when next"
view for the watcher itself: `computeWatcherSchedule()`
(`lib/workspace-watcher-guardrails.js`) exposes the additive `schedule` field on
`GET /api/workspace-watcher` (`lastCycleAt`, `nextCycleAt`, `cyclesToday` /
`maxCyclesPerDay` / `remainingToday`, `running` / `maxParallel`, and the live
`blockedReason`). `nextCycleAt` is the latest of the applicable gates — cooldown
end, failure backoff, quiet-hours end and, when the daily budget is spent, the
next UTC midnight — so the countdown reflects the earliest instant a cycle may
start. Autopilot `off`/`observe`, a global pause and a loop `stopReason` have no
ETA (`nextCycleAt = 0`). The panel renders it as a per-second countdown plus a
one-line `next cycle` in the Status card; a reached parallel cap is reported as a
blocker without inventing an ETA.

### Scout profiles, migration and history

A workspace now holds a **versioned `scoutProfiles` collection** instead of the
old single implicit profile. The store schema was raised from v1 to
`WORKSPACE_WATCHERS_SCHEMA_VERSION = 2`
(`lib/persist/workspace-watchers-persist.js`); loading a v1 row lazily
normalizes it into v2 in place.

- **Migration** turns the previous configuration into exactly **one** general
  profile (id `SCOUT_GENERAL_PROFILE_ID`, name "Scout ogólny"), preserving the
  old prompt, categories, sources, schedule, limits and harnesses. A row that
  already carries a `scoutProfiles` key (even `[]`) is never synthesized again,
  so re-reading is idempotent and never duplicates the profile or its scans. New
  workspaces read a **virtual, disabled** general profile and write nothing until
  they are explicitly configured.
- A **new profile defaults to `schedule=manual` and `enabled=false`** (the UI
  toggle reads "Automated scans"). "Run now" still works on a non-archived
  profile with `enabled=false` as long as the global workspace gates allow it, so
  nothing auto-starts on its own.
- **Per-profile state lives on the same row**: a `scoutSchedules` map
  (`scoutId → { lastRunAt, nextRunAt, day, count }`, UTC-day counter), the
  `activeScoutScans` collection (one record per `scanId`; MVP keeps at most one
  unsettled scan per profile) and a bounded `scoutScanHistory` log (terminal
  details kept for the last 100 scans per profile and up to 1000 per workspace;
  active and `uncertain` records are never trimmed). The **shared** UTC-day budget
  (`scoutScans` + `scoutMaxPerDay`) and `pendingScoutFindings` stay at the
  workspace level, so a scan satisfies both the profile and the workspace limit.
- **Fair scheduler**: the heartbeat selects the due enabled profiles in
  oldest-`lastRunAt` order so a frequently-run profile cannot starve the others,
  up to `scoutMaxParallel`. The reservation and both counters are bumped
  atomically under the store lock; a failed start releases only its own
  reservation.
- **Dedup between profiles**: the same problem found by two profiles merges into
  one proposal carrying two `sources[]`. Attribution (`scoutId`, `scoutRevision`,
  `scanId`, `chatId`, `runId`, executor, time) is server-assigned from the active
  scan, never from the model; a foreign chat/token submit is rejected and scan B's
  attribution never leaks to scan A.
- **Read-only**: the profile prompt states that the read-only contract is
  *enforced by the host, not by this prompt*. The transport still starts the chat
  in `agent` mode for harness compatibility, but the host tool policy blocks file
  writes/edits, mutating shell, delegations, todo/configuration changes and every
  other mutating MCP call **before** they run; only authenticated `submit` to the
  scan's own record and read tools are allowed.

### Backward compatibility for REST / MCP / remote clients

Legacy clients keep working without knowing about profiles:

- `GET/POST /api/workspace-watcher/scout` keep their existing shape; the optional
  `scoutId` / `scout_id` is forwarded. `GET /scout` can filter findings by
  `scoutId` without changing the legacy response.
- The `activeScoutScan` singleton view is still mirrored for older servers that
  read only that field, but `getActiveScoutScans` stops honoring it the moment the
  `activeScoutScans` key exists (even when empty) — there is never a second
  writer.
- MCP `scout_findings` and `scout_profiles` (and their former long names
  `watcher_scout_findings` / `watcher_scout_profiles`) route to the same handler
  and are classified identically by every host gate (Plan, review, Scout).
- The remote client (`lib/remote-api-client.js`) keeps `workspaceWatcherScout`
  (legacy `GET`/`POST` plus submit token) and adds `workspaceWatcherScoutProfiles`
  for the new profile surface.

### Rollout, backup and restore (schema v1 → v2)

Client **read** compatibility across versions is supported; **concurrent store
writes by an old and a new server are not**. The migration is a one-way,
in-place, lazy normalization of a shared file, so it must run under a single
writer. There is **no safe downgrade** of a v2 store to a v1 writer and **no
mixed-version operation**: v1 cannot read `scoutProfiles`/`activeScoutScans`, and
the single `activeScoutScan` mirror cannot represent multiple concurrent scans.

1. **Stop writers.** Set the watcher mode to `off` (or pause) and/or stop the
   server so no heartbeat, autopilot pass or Scout pass can mutate the row, and
   so no new scan starts.
2. **Back up the data.** Copy the watcher store and its cross-process lock db
   plus the related `data/workspace-memory/<workspaceKey>.json` and the todos
   file. This copy is the **only** rollback path — record the timestamp.
3. **Start exactly one v2 server.** The first read normalizes v1→v2 in place (one
   general profile, `activeScoutScans`, schedules, history). **Verify the legacy
   flow end to end** before enabling anything new: `GET /api/workspace-watcher`
   shows the migrated general profile and its preserved state;
   `POST /api/workspace-watcher/scout { action: 'run' }` starts a scan on the
   migrated token, and a scan that was reserved **before** the migration can still
   submit afterward.
4. **Only then create/enable additional profiles.** Because a new profile is
   manual + disabled, enabling multi-profile operation is an explicit operator
   action, never an automatic side effect of the upgrade.

**Restore / rollback:** to return to v1, stop the v2 server and restore the
pre-migration copy from step 2. Do not attempt to "convert" a v2 store back to
v1, and never run a v1 and a v2 writer against the same data directory at the
same time.

### Scout troubleshooting

- **A profile will not start.** Check, in order: profile `enabled` / `archivedAt`
  (an archived profile never starts, automatic or manual); the global gates
  (mode `observe`/`autopilot`, not paused, no `stopReason`, outside quiet hours,
  workspace `scoutMaxPerDay` and `scoutMaxParallel` headroom); an unsettled
  active scan for that profile (MVP allows one per profile, reported as
  `profile_scan_active`); an empty executor/harness intersection
  (`executor_not_allowed`, or `read_only_unsupported_harness` when the chosen
  harness cannot enforce read-only — that harness is excluded with a reason rather
  than run unprotected); or a scope that matches no files (`skipped`, both the
  profile and workspace budgets refunded).
- **The daily counter is consumed but no findings landed.** A normal
  `started=false` (no orchestrator / chat creation refused) **keeps** the
  reservation stamp on purpose, so a missing model cannot make every heartbeat
  retry the same scan. Only `global_starts_disabled` and a throw with a confirmed
  non-acceptance **refund** it once. See the settlement table in
  [`configurable-scouts.md`](./configurable-scouts.md).
- **A slot stays occupied after a crash.** `reconcileScoutScans` runs on boot and
  on every heartbeat — including while starts are off or the row is paused, so a
  drain can finish. A crash before handoff refunds once; a launched or
  `uncertain` scan stays occupied until liveness is confirmed idle and its review
  ends. `readyForRestart` requires starts disabled plus no reservations,
  in-flight, `unknown`, live scans or reviews and a readable store — it is never
  inferred from `expiresAt` alone.

### Machine-chat archive sweep

Finished Scout and Watcher-cycle chats are hidden by a shared sweep that runs on
**boot** (`reconcileWorkspaceWatchersOnBoot`) and on the **heartbeat** — both the
autopilot pass (`runWorkspaceWatcherAutopilot`) and the Scout pass
(`runWorkspaceWatcherScoutPass`), after the per-row `expireStaleActiveScoutScan`
so an expired scan can never keep a stale chat around. Candidates are chats with
`pickPurpose === 'scout'`, their delegation children (followed through
`delegationParentChatId`) and the orchestrator chats recorded in a closed
`cycleChats` window; every one goes through the shared `canArchive` gate
(`lib/chat-archive-policy.js`), never a title match. The idle grace is 15 minutes
from `updatedAt`, and a pinned chat, a chat with a live/unknown run, a chat still
holding a delegation slot, or one inside the grace window is left visible
(fail-closed). A chat that merely carries the `[Scout]` title is never a
candidate. The sweep is best-effort: it never opens a cycle slot, never spends
the daily budget and never breaks a tick.

## Notifications

The watcher pushes through the existing notification channel (no new socket).
Actual behavior in code:

| Push | When | Dedupe |
|------|------|--------|
| `idle_with_work` | `observe` sees ready work and no active agent | Once per episode via `idleNotifiedAt`; cleared when the episode ends |
| `blocked` | A todo is parked at the failure ceiling or a findings loop | Once per todo transition (`markWorkspaceWatcherTodoBlocked`) |
| `stopped` | `stopReason` is set (loop guard, uncertain start) or changes | Once per distinct stop reason (`notified.stopped`) |
| `plan_approval` | A tick waits with `wait_plan_approval` | Once per todo (`notified.plan_approval`) |
| cycle failure | A reconciled cycle ends without progress, or the orchestrator refuses / a start fails | Emitted with the event; the decision log is the durable record |

`observe` never starts an agent, and no push is emitted from an `off` row.

## Policy reference

Defaults from `defaultWorkspaceWatcherPolicy()`:

| Field | Default | Meaning |
|-------|---------|---------|
| `maxParallel` | `1` | Maximum busy agents before a new cycle waits (1-10) |
| `maxCyclesPerDay` | `20` | UTC-day cycle budget |
| `maxConsecutiveFailures` | `3` | Failure ceiling before a todo is parked; `0` disables |
| `maxSameFindings` | `2` | Identical review findings in a row before a stop; `0` disables |
| `cooldownMs` | `30000` | Minimum gap between cycles |
| `backoffBaseMs` / `backoffCapMs` | `60000` / `6 h` | Exponential failure backoff |
| `requirePlanApproval` | `true` | Plan gate (never auto-approved) |
| `allowedHarnesses` | `[]` | Empty = no restriction |
| `pickRoles` | `plan, implement, review` | Roles the orchestrator may pick |
| `quietHours` | `{ start: '', end: '' }` | UTC window when the watcher waits |
| `orchestrator` | `{ harness: '', model: '' }` | Empty = resolve a cheap `implement`-role pick; a set harness/model is a hard override |
| `scoutEnabled` | `false` | Opt in to the separate periodic Scout scan |
| `scoutIntervalHours` | `6` | Minimum gap between Scout scans (own schedule) |
| `scoutAutoCreate` | `false` | Automatically creates an `idea` todo with an unapproved plan draft for each submitted finding |
| `scoutCategories` | all six | Categories Scout may propose (`bug`, `improvement`, `refactor`, `security`, `opportunity`, `documentation`) |
| `scoutMaxPerDay` | `4` | UTC-day scan budget (independent of `maxCyclesPerDay`); `0` disables |
| `scoutMaxPerScan` | `10` | Maximum proposals kept per scan |

## Control surfaces

REST (`lib/routes/workspace-watcher-routes.js`):

- `GET /api/workspace-watcher` — state + live snapshot (never creates a row);
  the HTTP view adds the derived `guardrails`, `scout` and `schedule` blocks
- `PATCH /api/workspace-watcher` — mode/policy/pause/stop patch
- `GET /api/workspace-watcher/decisions?limit=50` — recent decision log
- `GET /api/workspace-watcher/stats` — aggregated monitoring stats (throughput,
  success rate, avg cycle time, stop reasons, top harnesses by delegation count
  and verified pass rate) for the Settings dashboard; never creates a row
- `DELETE /api/workspace-watcher` — remove the row
- `POST /api/workspace-watcher/{pause,resume,clear-stop,tick,run-cycle,claim-next,reset-plan-requests,findings,report,save-plan}`
- `GET /api/workspace-watcher/scout` — Scout proposals (`status`/`category`/`max`,
  and the optional `scoutId` filter for per-profile findings)
- `POST /api/workspace-watcher/scout` — `action=run` (default) starts a scan;
  `list`/`accept`/`reject`/`submit` manage proposals; the legacy shape is kept and
  an optional `scoutId` is forwarded so old clients are unaffected
- Profile surface (same auth as the Watcher settings; agent scan keeps only the
  allowed `list`/`submit`):
  `GET/POST /api/workspace-watcher/scout/profiles`,
  `GET/PATCH /api/workspace-watcher/scout/profiles/:id` (PATCH requires the profile
  `revision` — CAS, stale returns 409 and changes nothing),
  `POST /api/workspace-watcher/scout/profiles/:id/{duplicate,archive,preview,run,restore-diff,restore}`,
  `POST /api/workspace-watcher/scout/profiles/{from-template,preview-draft}`,
  `GET /api/workspace-watcher/scout/templates` and
  `GET /api/workspace-watcher/scout/history` (newest-first, filtered by `scoutId`,
  never exposes `submitToken`)

MCP (`lib/mcp/builtin/watcher-tools.js`):

- `watcher_status` / `watcher_show` (read-only)
- `watcher_set` / `watcher_update` (actions: `configure`, `tick`,
  `run_cycle`, `claim_next`, `reset_plan_requests`, `record_findings`,
  `save_plan`, `report`)
- `watcher_report` (outcome `success|blocked|failure`, idempotent)
- `watcher_claim_next`
- `scout_findings` (actions: `list`, `accept`, `reject`, `submit`). The read-only
  scan starts in `agent` mode; `list`/`submit` are the only builtin MCP calls the
  host allows a Scout chat (`accept`/`reject` stay operator-only), and `submit`
  auto-fills `scan_id` + `submit_token` from the scan's own chat, never another
  chat's
- `scout_profiles` (actions: `list`, `get`, `create`, `update`, `duplicate`,
  `archive`, `preview`, `history`, `run`, `templates`, `from_template`,
  `restore_preview`, `restore`)

Workspace Memory is exposed through `wmem_add` /
`wmem_list` / `wmem_delete`
(`lib/mcp/builtin/memory-tools.js`).

Settings → Workspace Watcher and the Todo top bar drive the same control layer
(`lib/workspace-watcher-control.js`). The Scout section edits `scoutMaxPerDay`
(UTC-day scan budget; `0` disables scans) along with the interval and parallel cap.

Both surfaces are scoped to the **active workspace folder** read from the header
workspace picker (`app_front/features/watcher/watcherWorkspaceScope.js`): reads
carry `?workspaceFolder=` and writes put `workspaceFolder` in the JSON body.
Without it the API falls back to the server's global "current cwd", which can be
a different workspace than the one the operator is looking at — a chat can carry
its own workspace, and the settings panel stays mounted across workspace
switches. The settings form rebuilds (never a dashboard-only repaint) when the
active workspace changes, so a stale form can never Save its policy onto the
wrong workspace.

A **clone** is a single-folder view of a workspace file (`<file>#clone-<id>`), so
its watcher is the row for that one folder — not the parent's default folder. The
clone folder is what the header carries after selecting the clone group, so the
settings form and the Todo bar resolve the clone row on their own; switching
between the parent and its clone is a folder change and rebuilds the form.

## Monitoring dashboard

Settings → Workspace Watcher renders a monitoring dashboard
(`app_front/features/watcher/watcherDashboard.js` + `watcherTimeline.js`) from
the two reads above:

- **Live status** — mode/pause, every `activeCycles[]` slot (todo, phase, running
  duration, orchestrator-chat link), the active delegations (harness, status,
  assignment, duration) and the latest decision.
- **Timeline** — a Gantt-like track over the last hour / 24h / 7d. Each closed
  cycle from `cycleChats` becomes a bar (`success`/`failure`/`blocked` tone);
  live cycles grow to `now` as `running`. Overlapping cycles are greedily
  assigned distinct lanes so `maxParallel > 1` concurrency is visible. Clicking a
  bar opens its detail (todo, outcome, chat, duration).
- **Statistics** — success rate, average cycle time, cycles in the window,
  daily/weekly throughput (`cycleCount`-style buckets), the most common stop
  reasons, and the top harnesses by delegation count with the verified pass rate
  (`verifyResult.status`).
- **Decisions** — the decision log with a filter-by-kind dropdown; the same data
  powers the **Why?** button in the Todo tab top bar.
- **Alerts** — an active `stopReason` with a **Clear stop** action, the
  `backoffUntil` countdown with a **Clear backoff and failures** action that
  releases the failure backoff in one click, and the quiet-hours end (UTC), all
  repainted once per second client-side. The same reset is on the cycle-schedule
  card's blocker line (Settings tab) and in the **Actions** tab, so an operator
  does not have to hunt for it while the watcher is parked.

`cycleChats` entries were extended with `startedAt` (mirrored from the live slot
by `buildWorkspaceWatcherCycleClosePatch`) so a closed cycle has a real
duration; `at` remains the close instant. The same bounded entry now also
carries `mode`, the requested pair (`requestedHarness`/`requestedModel`/
`requestedSource`) and `closeSource`, so the existing API keeps the orchestrator
identity without a schema break. The list is still bounded by
`WORKSPACE_WATCHER_MAX_CYCLE_CHATS` (20), so the dashboard shows the most recent
20 cycles and a legacy entry without `startedAt` falls back to a point bar with
no duration instead of a fake zero.

The unbounded orchestrator-model history lives in the separate
`data/workspace-watcher-cycles.json` store (see **Durable cycle-metrics store**):
one record per `cycleId`, created at reservation and closed by
`report`/`reconcile`/`abort`. It is the source for the per-model comparison and
keeps starts that never reached `running`; `cycleChats` stays the bounded
timeline feed. `readWorkspaceWatcherCycleMetricsStatus` exposes the store range
(`collectionStartedAt`, oldest/newest start, counts) and the last telemetry
error for the API/Settings leaves.

Live updates reuse the existing chat-list WebSocket: the server emits
`chatsChanged` with reason `workspace-watcher`, `chatListLiveSync` forwards it,
and both the settings dashboard and the Todo watcher bar refetch on the
`cretli:workspace-watcher-changed` DOM event. Time-driven fields (countdowns,
running durations) tick locally without refetching.

## Debugging through the decision log

Every tick that changes the outcome appends one bounded line (~50) to
`row.decisions`; cycle closes append `cycle_completed` / `cycle_failed`, and a
missing orchestrator appends `orchestrator_blocked`. This is the primary
diagnostic and it answers "why is nothing running?".

Read it with:

- UI: Todo tab top bar → **Why?**
- REST: `GET /api/workspace-watcher/decisions?limit=50`
- MCP: `watcher_show` (recent decisions) or `watcher_status`

Each line has `at`, `kind`, `reason`, `readyTodoCount`, `activeAgentCount`,
`shouldNotify` and `nextTodoId`. A `wait_active` / `max_parallel` line also
stores `slotHolders`: the chat ids and `delegation:<id>` tokens that occupy the
slot. The Todo **Why?** column, the settings dashboard and the pinned-chat
decision line (`held by <id8>`, or `held by delegation:<id8>`) show them. A
full cycle slot still uses `slotChats` (`cycle_active`).

| `kind` | Meaning |
|--------|---------|
| `off` | Mode is off (no write) |
| `paused` | Global pause; state is preserved |
| `stopped` | `stopReason` set; clear it to resume |
| `snapshot_error` | A store could not be read; the watcher waits |
| `wait_active` | `maxParallel` reached (`slotHolders` names the chats / `delegation:<id>` tokens), or a chat has unknown liveness (adapter error, or a cold room a todo claim / delegation slot still traces) |
| `idle_no_work` | No ready work (`no_ready_work` or `no_eligible_work`) |
| `observe_ready` | Observe saw work; no cycle started |
| `start_cycle` | A normal cycle is allowed |
| `plan_gate` | A plan-only cycle is allowed |
| `wait_quiet_hours` | Inside the UTC quiet window |
| `wait_budget` | UTC-day budget exhausted |
| `wait_cooldown` | Within `cooldownMs` of the last cycle |
| `backoff` | Failure backoff active |
| `wait_same_findings` | Identical review findings loop |
| `wait_harness_usage` | Every eligible favorite is usage-limited |
| `wait_plan_approval` | Waiting for a human to approve the plan |
| `cycle_completed` / `cycle_failed` | A cycle closed (with its outcome) |
| `orchestrator_blocked` | No eligible orchestrator model was found |

Common syndromes:

- **`wait_active` with `unknownAgentCount > 0`** — "unknown" means a chat the
  snapshot cannot confirm is *done*, and only for a real reason: an adapter
  error (`adapter_error`, `probe_failed`, `run_mismatch`) or an absent room
  (`state_missing`/`adapter_missing`) **when a work trace points at that chat**
  (a todo it still claims, or a parent/child of a delegation slot that is still
  occupied — including an unconfirmed `runStoppingAt` stop). A cold chat with no
  room and no trace — an archived or historical chat, or every chat after a
  server restart — is treated as idle, not unknown, so it never blocks a cycle;
  a chat that no longer exists (`chat_missing`) is skipped outright. The
  recorded decision carries an `unknownChats` list (`chatId` + `reason`, up to
  three) that survives store normalization; the Todo "Why?" table and Settings
  decision log append those chats to the reason column instead of showing only
  `unknown_liveness`. This is a
  deliberate conservative block for genuinely ambiguous liveness; resolve the
  chat/run state instead of forcing a cycle.
- **`wait_harness_usage`** — check favorites and active usage limits; the
  allow-list is intersected with the real limits.
- **`stopped` / `loop_no_eligible_work`** — every ready todo is parked at the
  failure ceiling. Inspect `failures`, fix the blocker, then either
  `clear-stop` or retry the todo manually.
- **`stopped` / `loop_same_findings`** — the same review findings repeated.
  Address the finding before clearing the stop.
- **`cycle_start_uncertain`** — the adapter never confirmed the start; the cycle
  stays `starting` and is retried/reconciled rather than duplicated.
- **A cycle row that never closes** — check `activeCycles[].phase`; `starting`
  with a future deadline is still in flight, otherwise reconcile probes the chat.

Other useful views: `cycleCount`, `reports` (last 20), `cycleChats` (last 20,
each with its outcome) and `lease` (who currently owns the workspace).

## Worktree execution, Git context and integration

This section describes the end-to-end flow from a leaf's execution-mode choice
to the human integration decision, and the Git context indicator that makes the
right branch visible.

### Logical workspace vs execution folder

- `workspaceFolder` is the **logical project identity**. Todos, claims, memory,
  watcher policy, the plan gate and limits always live there.
- `executionFolder` is where a runner, the write lock, the material revision and
  test verification actually operate. For a chat it is stored on the chat record
  (`executionFolder`, falling back to `workspaceFolder`); for a leaf it is frozen
  in the worktree registry.
- Worktrees live **outside** the project tree. Nothing here commits, merges or
  pushes; integration is manual and the branch is preserved until a human
  decides.

### 1. Mode selection

- Watcher policy holds the default: `policy.executionMode` (`project` for
  backwards compatibility) plus the `policy.worktree` layout block (location,
  branch scheme, `prepareCommand` argv).
- The layout is edited in **Settings → Workspace Watcher → Settings → Execution
  folder (worktree)**: the default mode, an absolute root outside the repository,
  a single-segment namespace, the branch and directory prefixes, and the prepare
  argv (one argument per line — a shell string is refused). Saving is fail-closed:
  a `worktree` default or a partially filled layout refuses to save until the
  four path/naming fields are complete and safe. The same block can be written
  through the `watcher_set` MCP policy patch.
- Empty fields are **prefilled from a server suggestion** computed from the
  workspace (`GET /api/workspace-watcher?suggest=1`, `lib/execution-settings-suggest.js`):
  the root is `<parent-of-repo>/.cretli-worktrees` (always outside the repository),
  the namespace is the sanitized repository folder name, and `prepareCommand` is
  detected from the lockfile present (`pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json`, `composer.lock`, `go.sum`, `requirements.txt`, or a plain
  `npm install` for a `package.json` without one). A saved value always wins over
  the suggestion.
- A leaf may override the default with its own `executionMode`:
  `inherit` | `worktree` | `project`. The choice is visible in the TODO list and
  in the task card settings tab.
- `resolveWorkspaceWatcherExecutionMode` resolves leaf-over-policy. A plan-only
  cycle never creates a worktree: it keeps the logical workspace.
- A worktree that already exists is **frozen**: later policy or override changes
  do not move an in-flight or retried leaf to another directory.

### 2. Execution

`prepareWorkspaceWatcherExecution` turns a claimed leaf into an execution folder:

1. resolve the mode (leaf override, else policy default);
2. for `worktree`, create or re-verify the persistent worktree at its frozen
   base commit and register it in `data/worktree-registry.json`;
3. run the declared `prepareCommand` **inside** the worktree (argv only — a
   shell string is refused) and mark the record `active`;
4. for `project`, keep the logical workspace.

Fail-closed rules: a missing worktree layout, a dirty logical tree, a
foreign/orphaned worktree and a failed prepare all refuse the start. There is no
silent fallback to `project` and no automatic secret or `data/` copy. Restart and
retry reconcile the registry against Git instead of creating a second worktree.

### 2a. Manual starts (Todo panel)

A todo started by hand from the Todo panel (`POST /api/todos/:id/start-agent`)
uses a **root-keyed** worktree:

- the tree root is found by walking `parentId`; the root's `worktree`/`project`
  override (else the policy default) decides the mode, and the requested leaf's
  own `executionMode` is ignored for manual starts;
- the root worktree is created/reused once and frozen as `executionFolder` on
  every chat of the tree, so delegated implement/fix children inherit it and the
  per-folder write lock does not collide with another tree in the main folder;
- the Watcher keying is unchanged (it still keys by the claimed leaf). Mixing
  the two is refused with HTTP 409 when the same direct line already has a live
  record under a different id;
- a long prepare answers `202 {state:'preparing'}` and the UI polls
  `GET /api/todos/:id/start-agent/status`; a live frozen record or `project`
  mode stays synchronous.

Integration for a manually started tree is explicit on the root:
`POST /api/todos/:id/integration` with `action=prepare` builds the root-level
diff (all leaf siblings), records it with honest manual evidence and sets
`integration.state=ready` while `status` stays `doing`; `confirm`/`reject` then
behave exactly as in §4.

### 3. Review

Implement, review and fix share the **same** worktree for one leaf, so review
sees exactly the material the implementer produced. A review PASS closes the
execution cycle but does not make the change available to the next sequential
sibling:

- the execution folder is marked `execution_closed`;
- the integration diff (tracked and untracked files, including new files) is
  written as a patch outside the worktree;
- a per-cycle result record is stored in the worktree registry (base commit,
  head, branch, diff stat, changed files, review/test outcomes, patch hash);
- the TODO gets an `integration` pointer with `state = ready` while its `status`
  stays `doing`, so the scheduler cannot pick it up again.

### 4. Integration (manual)

A human confirms or rejects through `POST /api/todos/:id/integration`
(`action = prepare | confirm | reject`), exposed as the buttons on the task card
(`prepare` is offered for a manually started worktree root):

- **confirm** → `status = done`, `integration.state = integrated`; the sequential
  sibling becomes ready. The worktree is still not removed automatically.
- **reject** → `status = ready`, `integration.state = rejected` with a reason;
  the worktree and patch are preserved so a retry reuses the frozen work.

### 5. Git context indicator and panel

The existing Git panel (`app_front/gitPanel.js`, `/api/git/*`, `/api/github/*`)
is context-aware instead of relying only on the global `getCurrentCwd()`:

- `GET /api/git/info?chatId=…` (or `?todoId=…&workspaceFolder=…`) resolves the
  **authorized** execution folder from durable server records
  (`lib/git-context.js`): a chat's stored `executionFolder`, or a leaf's worktree
  registry entry; a cleaned/missing record falls back to the logical workspace.
  A client-supplied execution folder is never trusted.
- `file-diff`, `run` and the GitHub reads use the same resolved folder. A
  `file-diff` path is validated against that folder (same real-path rule as
  before), so a request cannot read or write outside the authorized repo/worktree.
- A compact chip in the header (chat context) and on a task card (worktree
  context) shows the branch and opens the panel; the panel then shows the
  context (main project vs task worktree), branch, base commit, change count,
  related task and integration state.
- The scope lives in `app_front/features/git/gitScope.js` with a monotonic
  revision. Every fetch captures the revision and the scope key and drops its
  answer when either changed, so a late response for a previous chat/workspace
  never overwrites the newer context.

### Scenario: two independent TODOs

With `policy.maxParallel = 2` (the default stays `1`), two ready leaves in the
same workspace run independently:

1. leaves A and B both resolve to `worktree` mode, each with its own frozen base;
2. the watcher creates/reuses two worktrees and marks both records `active` — the
   write lock serializes on the **execution folder**, so A and B do not block
   each other, while a third parent in the same folder still does;
3. the header chip follows the chat context, and each task card's Git chip opens
   the panel scoped to that leaf's worktree, so their branches and diffs are never
   confused;
4. A's review passes and marks A `integration.state = ready` without exposing the
   change to B; B continues in its own worktree;
5. a human confirms A (A → `done`) and rejects B (B → `ready`, worktree kept);
6. TODO, memory, policy and plan gates still live in the shared logical
   workspace, so both leaves see the same task tree and the same human approvals.

## Tests

Run the focused suites:

```
node --test tests/workspace-watcher.test.js
node --test tests/workspace-watcher-orchestrator.test.js
node tests/workspace-watcher-e2e.test.js
node --test tests/workspace-watcher-routes.test.js
node tests/workspace-watcher-pinned-chat.test.js
node tests/watcher-pinned-chat-ui.test.js
node --test tests/workspace-watcher-stats.test.js
node --test tests/workspace-watcher-dashboard-ui.test.js
node tests/workspace-watcher-settings-ui.test.js
node tests/workspace-watcher-archive-sweep.test.js
node --test tests/git-context.test.js
node --test tests/git-routes-scope.test.js
node --test tests/git-scope-ui.test.js
```

`tests/git-context.test.js` covers authorized scope resolution (chat, task,
worktree, fallbacks, conflicts) and path authorization.
`tests/git-routes-scope.test.js` asserts the routes run in the resolved folder
and reject a path outside it. `tests/git-scope-ui.test.js` covers the scope
revision/stale-answer guard, the context view helpers and the UI wiring
(header chip, panel chip, task chip).

Scout (configurable profiles — stages 1–6) runs with its own suites; note the
mixed runners (`node --test` for the `node:test` suites, plain `node` for the
custom tally suites):

```
node tests/workspace-watcher-scout.test.js
node tests/workspace-scout-profiles.test.js
node tests/workspace-scout-profiles-api.test.js
node tests/workspace-scout-scans.test.js
node tests/workspace-scout-schedule.test.js
node tests/workspace-scout-templates-scope.test.js
node --test tests/workspace-scout-git-scope.test.js
node --test tests/workspace-scout-scan-usage.test.js
node --test tests/workspace-scout-profiles-ui.test.js
node --test tests/workspace-scout-editor-ui.test.js
node --test tests/workspace-scout-history-ui.test.js
node --test tests/workspace-scout-inbox-ui.test.js
```

The full acceptance map for these suites against the spec criteria is in
[`configurable-scouts-acceptance.md`](./configurable-scouts-acceptance.md); the
profile feature spec is [`configurable-scouts.md`](./configurable-scouts.md).

The durable per-workspace transcript (`pinnedChatId`), its persisted
`variant: 'watcher'` notices and the pinned-mode command shell are documented in
[`workspace-watcher-pinned-chat.md`](./workspace-watcher-pinned-chat.md).

`tests/workspace-watcher-e2e.test.js` is the acceptance suite: three ready
todos run sequentially through the mock chat-run adapter, a failed cycle blocks
only its todo while fresh work continues, a restart mid-cycle reconciles once
without a duplicate cycle or claim, two processes are serialized by the lease,
and `off`/`observe` start no agent. `tests/helpers/workspace-watcher-lease-child.js`
is the second-process lease holder used by the cross-process case.
