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
workspace_watcher_update action "report"  (tool: watcher_report)
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
planDeadline/startDeadlineAt, planOnly, reportedOutcome, reportedAt, reportId
}`. `activeCycle` mirrors slot 0 for older servers that still read the v1
field only.

`cycleId` is reserved **before** the adapter is asked to start and is reused as
the chat-run `requestId`, so a retry replays instead of duplicating.

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
   bump the UTC-day budget.
6. **Claim** — CAS `ready → doing` with `claimedByChatId`; a failure rolls the
   reserve back and releases the claim.
7. **Start** — create the orchestrator chat and start its run with the cycle id
   as the request id. The lease is renewed while `starting`.
8. **Run** — the orchestrator is the parent of exactly one multi-harness loop:
   it uses `model_pick` + `delegation_start` for plan/implement/review/fix,
   marks the todo done only after an independent review PASS, and **never**
   commits, pushes, merges or starts the next cycle.
9. **Report** — the orchestrator ends with `watcher_report` (or
   `workspace_watcher_update` action `report`) carrying
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

## Workspace Memory

Every orchestrator cycle starts with a clean context, so `Workspace Memory` is
the small durable fact store that carries knowledge across cycles. It lives in
`data/workspace-memory/<workspaceKey>.json` where `workspaceKey` is
`workspaceKeyFromCwd(workspaceFolder)` — the same sha256-of-realpath identity
todos use (no separate `workspaceId`).

Each entry has a `type` (`decision`, `pattern`, `finding`, `blocker`,
`context`), a short `key`, a `value`, and an optional `expiresAt` stamped from
`ttl_ms`. Entries without a TTL are permanent; expired entries are hidden lazily
on every read. The store is bounded (500 entries, oldest evicted) and every write
runs under the shared cross-process file lock with a document CAS, so parallel
cycles cannot lose each other's facts.

`buildWorkspaceWatcherCyclePrompt` renders the facts as a `WORKSPACE MEMORY`
section (ordered blocker → decision → finding → pattern → context, newest first)
capped at 3000 tokens; entries beyond the budget are dropped and summarized with
a pointer to the list tool. The prompt also instructs the orchestrator to write
the cycle's decisions, findings and blockers back with `workspace_memory_add`
before it reports. A Scout scan reads the same store with
`workspace_memory_list` before re-scanning a workspace.

MCP tools (`lib/mcp/builtin/memory-tools.js`):

- `workspace_memory_add` — append one typed fact (`ttl_ms` optional)
- `workspace_memory_list` — paginated live facts (`types` filter, `cursor`)
- `workspace_memory_delete` — remove one fact by id

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
   the stamp back) and gathers read-only signals: `git diff main`,
   `git log --oneline -20`, TODO/FIXME/HACK markers in changed files, optional
   test results and error logs, existing todos, prior review findings and
   Workspace Memory;
3. starts one `plan`-mode chat (`[Scout] <workspace>`) and asks it to submit
   findings through `watcher_scout_findings` (or a fenced JSON block the runner
   parses);
4. dedupes the proposals against existing todos, pending/resolved findings and
   Workspace Memory entries that mark an area as already explored, then stores
   them as `pendingScoutFindings` and appends a notice to the pinned chat.

Categories: `bug`, `improvement`, `refactor`, `security`, `opportunity`,
`documentation`. The `refactor` rubric carries extra heuristics (oversized
file/function split candidates, duplicated blocks, mixed responsibilities, deep
nesting) so a proposal is a small, behavior-preserving, independently reviewable
seam rather than a rewrite.
A finding is `{ id, title, category, rationale, plan_markdown, files[], status }`.
When `policy.scoutAutoCreate` is true, submitting a finding immediately creates
an `idea` todo (idempotent on the finding id) with its proposed plan as an
unapproved draft. Otherwise, `accept` creates the TODO. `approvedAt` stays empty
until a human approves the draft in the UI. A read-only scan runs in Plan mode; the
`watcher_scout_findings` `list`/`submit` actions are the only mutating builtin
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
| `maxParallel` | `1` | Maximum busy agents before a new cycle waits |
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

- `GET /api/workspace-watcher` — state + live snapshot (never creates a row)
- `PATCH /api/workspace-watcher` — mode/policy/pause/stop patch
- `GET /api/workspace-watcher/decisions?limit=50` — recent decision log
- `GET /api/workspace-watcher/stats` — aggregated monitoring stats (throughput,
  success rate, avg cycle time, stop reasons, top harnesses by delegation count
  and verified pass rate) for the Settings dashboard; never creates a row
- `DELETE /api/workspace-watcher` — remove the row
- `POST /api/workspace-watcher/{pause,resume,clear-stop,tick,run-cycle,claim-next,reset-plan-requests,findings,report,save-plan}`
- `GET /api/workspace-watcher/scout` — Scout proposals (`status`/`category`/`max`)
- `POST /api/workspace-watcher/scout` — `action=run` (default) starts a scan;
  `list`/`accept`/`reject`/`submit` manage proposals

MCP (`lib/mcp/builtin/watcher-tools.js`):

- `watcher_status` / `workspace_watcher_show` (read-only)
- `watcher_set` / `workspace_watcher_update` (actions: `configure`, `tick`,
  `run_cycle`, `claim_next`, `reset_plan_requests`, `record_findings`,
  `save_plan`, `report`)
- `watcher_report` (outcome `success|blocked|failure`, idempotent)
- `watcher_claim_next`
- `watcher_scout_findings` (actions: `list`, `accept`, `reject`, `submit`;
  `list`/`submit` allowed in Plan mode for the read-only scan)

Workspace Memory is exposed through `workspace_memory_add` /
`workspace_memory_list` / `workspace_memory_delete`
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
  `backoffUntil` countdown and the quiet-hours end (UTC), all repainted once per
  second client-side.

`cycleChats` entries were extended with `startedAt` (mirrored from the live slot
by `buildWorkspaceWatcherCycleClosePatch`) so a closed cycle has a real
duration; `at` remains the close instant. The list is still bounded by
`WORKSPACE_WATCHER_MAX_CYCLE_CHATS` (20), so the dashboard shows the most recent
20 cycles and a legacy entry without `startedAt` falls back to a point bar with
no duration instead of a fake zero.

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
- MCP: `workspace_watcher_show` (recent decisions) or `watcher_status`

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
```

The durable per-workspace transcript (`pinnedChatId`), its persisted
`variant: 'watcher'` notices and the pinned-mode command shell are documented in
[`workspace-watcher-pinned-chat.md`](./workspace-watcher-pinned-chat.md).

`tests/workspace-watcher-e2e.test.js` is the acceptance suite: three ready
todos run sequentially through the mock chat-run adapter, a failed cycle blocks
only its todo while fresh work continues, a restart mid-cycle reconciles once
without a duplicate cycle or claim, two processes are serialized by the lease,
and `off`/`observe` start no agent. `tests/helpers/workspace-watcher-lease-child.js`
is the second-process lease holder used by the cross-process case.
