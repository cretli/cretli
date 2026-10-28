# Unified scheduler: verdict per standalone timer

Status: decision document (read-only analysis, no code changed).
Scope: every remaining `setInterval` / `setTimeout`-based background timer in
`lib/` and `server.js` as of 2026-10-22, judged against the shared periodic job
runner (`lib/periodic-job-runner.js`).

Rule applied: **migrate only when the migration removes duplication.** "Leave as
is" and "expose read-only status" are first-class outcomes.

## 1. What the runner gives us (and what it does not)

`createPeriodicJobRunner()` (`lib/periodic-job-runner.js:38`) owns a registry of
jobs `{ id, label, intervalMs, settingKey, runOnStart?, isEnabled(), run({now}) }`.
Per job it provides:

- one unref'd `setInterval` plus an optional boot `setTimeout(0)` (`runOnStart`
  defaults to true) — `arm()` at `:74`;
- a non-overlap guard (`state.running`, counted in `skipped`) — `:57`;
- error capture (`lastError`, truncated to 200 chars) — `:66`;
- a status row (`getJobsStatus()` at `:120`), already served to the UI through
  `GET /api/wakeups/status` (`lib/routes/wakeups-routes.js:95`, rendered in
  `app_front/features/wakeups/wakeupsView.js`);
- `runNow(id)` and `stop()`.

Pause semantics: the runner has **no built-in restore pause**. It re-evaluates
`job.isEnabled()` on every tick and before every status read (`:55`,
`readEnabled` swallows throws as `false`). A restore pause is therefore expressed
as `isEnabled: () => !restoreGate.shouldSkipAutomaticWork()`. `restoreGate` is
`createRestoreGate(controlDir)` (`lib/backup/offline/restore-gate.js:11`);
`shouldSkipAutomaticWork()` reads the control dir on each call and logs the pause
once.

Existing users and the registration pattern:

- `chatAutoArchiveJob` (`lib/chat-auto-archive-worker.js`) — a frozen job object
  exported by the worker module, registered in `startPeriodicJobsSafely()`
  (`lib/delegation-runtime-boot.js:77-83`), which lazily creates the singleton
  runner and calls `start()`.
- `startPeriodicJobsSafely()` is called on the healthy path
  (`lib/delegation-runtime-boot.js:435`) and the degraded path (`:462`), so jobs
  keep running while the delegation runtime is degraded.
- **Important gap:** `bootDelegationRuntime()` returns early when
  `shouldSkipAutomaticWork()` is true (`:329-332`), *before* the runner is
  created. After a paused boot there is no runner at all, so a job registered
  there would never start — and would not resume if the pause is lifted without a
  restart. This matters for every "migrate" below that must resume after a pause
  (see leaf **U1**).
- `runner.stop()` is called on shutdown (`lib/delegation-runtime-boot.js:553`).

## 2. Verdict table

Line numbers were verified with `rg` against this checkout.

Decision key: **migrate** = register as a runner job; **status** = keep timer,
add read-only status; **leave** = no change.

### 2.1 The four originally scoped timers

| Timer | File:line | Interval / trigger | Decision | Rationale | Risk | Leaf |
|---|---|---|---|---|---|---|
| Scout | `lib/workspace-watcher-scout.js:1733` (`decideScoutRun`), callers `:1909`, `:2110`, `:3841` | **No timer.** Per-profile schedule (`schedule.mode`, `intervalHours`, `lastScoutAt`) is evaluated inside Watcher autopilot passes; `resolveScoutScheduleState` `:1807`, operator view `:1949` | **leave** | It is not a timer: it is a pure due-check driven by the Watcher pass. A periodic job would only add a second clock beside the one that already evaluates `lastScoutAt`/budget/occupancy atomically with the watcher row. The operator "next scan" view already exists (`:1949`), so no extra status is needed. | None (no change) | none |
| Memory monitor | `server.js:896` (`setInterval(refreshMemoryMonitorAlerts, 60_000)`; initial call `:895`) | 60 s, immediate first run, fire-and-forget `publishMemoryMonitorAlerts` | **migrate** | Hand-rolled interval + unref + `.catch` logging + first-run call; no overlap guard today (a slow publish can overlap). Runner provides all of it plus a status row. | Low. Notification store dedupes by fingerprint, so a double run is harmless. | U2 |
| Agents scheduler | Removed with the legacy Agents tab | No timer or schedule file reads remain | **removed** | Use chat skills, delegations, Watcher, Scout or `check_schedule` | n/a | none |
| Watcher debounce | `lib/workspace-watcher-event-schedule.js:68` (`setTimeout`, `Map<string, timer>`) | Event-driven; 1500 ms default, max 60 s, reset per `(dataDir, workspace)` key | **leave** | Not periodic: it is a trailing-edge debounce armed by todo/delegation/presence events. The runner has no debounce primitive, and a periodic poll would add latency and wake the autopilot with nothing to do. Nothing is duplicated. | None (no change) | none |

### 2.2 Additional timers

| Timer | File:line | Interval / trigger | Decision | Rationale | Risk | Leaf |
|---|---|---|---|---|---|---|
| Harness update check | `lib/harness-updates-worker.js:44` (boot `setTimeout 0`), `:49` (`setInterval`) | 60 s (`HARNESS_UPDATE_CHECK_INTERVAL_MS` `:8`), runs once at boot, `inFlightSweep` guard | **migrate** | Same shape as the auto-archive job: boot kick + interval + in-flight guard + unref. Already started from `startPeriodicJobsSafely`'s neighbours (`lib/delegation-runtime-boot.js:436`, `:463`). | Low. Must keep running while degraded (as today). Today it is *not* started on a paused boot; gate with `isEnabled` to keep that. | U2 |
| Wake-up scheduler | `lib/wakeup-scheduler.js:282` | 60 s (`WAKEUP_TICK_MS` `:24`), configurable and restartable, `generation` + `tickInFlight` guards | **leave** | The runner header states wake-up rows are single-fire episodes and the runner deliberately has no dependency on this scheduler. It already has its own status (`getStatus`) and a generation-guarded restart with a changing interval, which the runner cannot express. | Merging would couple the degraded-tolerant runner to the episode scheduler. | none |
| Keep-alive tick | `lib/usage/keep-alive-service.ts:232` (`ensureKeepAliveTimer`) | 15 s (`KEEP_ALIVE_TICK_MS` `:36`), armed lazily only when an AUTO plan exists | **leave** | Lazy arm-on-demand and idempotent re-arm are the point; a runner job would tick forever for nobody. It is a TypeScript module with its own status API (`handleKeepAliveRequest`). Dedupe gain is a few lines. | n/a | none |
| Harness recovery notices | `lib/notifications/harness-recovery-producer.ts:81` (call site `server.js:894`) | 30 s, immediate first run, `running` guard | **migrate** | Textbook duplicate of runner semantics (the doc comment even says "without overlapping"). The returned stop callback is unused at the only call site. | Low. | U2 |
| Recovery scheduler | `lib/recovery/recovery-scheduler.js:199` (wired at `lib/delegation-runtime-boot.js:444`) | 15 s (`RECOVERY_SCHEDULER_DEFAULTS.intervalMs` `:32`), `ticking` guard, deferral bookkeeping | **leave** | Started only after watcher reconcile succeeded (`watcherReconciled`, `:439`) and deliberately *not* in the degraded path. Periodic jobs run while degraded, so semantics differ. `start()` is ~10 lines; the real logic is `tick()` and deferrals. Orchestration-critical, so no churn for little duplication. | Moving it would change degraded-boot behaviour. | none |
| Server log cap | `lib/log-rotate.js:199` (`startLogCapTimer`; call `server.js:215`) | 60 s (`CRETLI_LOG_CAP_CHECK_MS`) | **leave** | Starts before the server listens and before any runtime boot, and must work with no data dir or runtime. Depending on the delegation runner would invert the startup order for ~5 lines saved. | n/a | none |
| Delegation runtime tick | `lib/delegation-runtime-worker.js:695` | 5 s (`DELEGATION_RUNTIME_TICK_MS`, `lib/delegation-status.js:112`), `workerGeneration`, hung-tick detection (`DELEGATION_TICK_HUNG_MS`) | **leave** | Core orchestration loop with its own health model (generation fencing, hung detection). Not a subject-less background job; the runner's fixed-interval/skip model would lose that. | High if moved. | none |
| Watcher cycle lease renewal | `lib/workspace-watcher-cycle.js:435` (`startWorkspaceWatcherStartingLeaseRenewal`) | Per cycle, `clamp(ttl/3, 5 s, 30 s)` | **leave** | Lifetime is bound to one cycle and its lease token; it is created and torn down dynamically, not a registered job. | n/a | none |
| Online backup scheduler | `lib/backup/online/backup-scheduler.js:284` | 60 s, injectable `setTimer`, job lease, `nextAttemptAt`/deferral status | **leave** | Already a self-contained scheduler with rich status (`lastSuccess`, `lastFailure`, `lastDeferral`) and an explicit restore-pause path (`server.js:905-906`). Opt-in feature; a runner row would duplicate its own status. | n/a | none |
| Usage maintenance | `lib/usage/usage-maintenance.ts:101` (`schedule`), `:108` (`startLoop` `setInterval`); started `server.js:898-901` | Retention every 6 h (`USAGE_RETENTION_INTERVAL_MS` `:21`); usage alerts and balance-forecast alerts every 5 min (`USAGE_ALERT_INTERVAL_MS` `:23`); each runs at boot | **migrate** | `startLoop` is a hand-rolled copy of runner `arm()` (boot kick + interval + unref + timer list), used three times; the returned stop function clears all of them. Replacing it with three jobs removes the duplicate and adds status for each. | Low-medium: TypeScript module, lazy `import()` at `server.js:899`; retention is synchronous (`runUsageRetentionMaintenance`). | U4 |
| Storage maintenance sampler | `lib/storage/maintenance-coordinator.js:309` | 10 ms event-loop-lag sampler during a maintenance barrier | **leave** | A measurement probe inside one barrier operation, cleared in `finally`. Not a background job. | n/a | none |
| WS keepalive | `lib/ws/ws-keepalive.ts:31` (`attachWsKeepalive`; wired `lib/ws/ws-router.ts:124`) | 30 s per socket (`WS_KEEPALIVE_INTERVAL_MS` `:2`) | **leave** | One timer per connection, owned by the socket's lifecycle. A registry of N dynamic jobs would be pure overhead. | n/a | none |

### 2.3 Found while grepping, not assessed

Not in the todo's list, so not decided here: `lib/mcp/mcp-runtime.js:131`
(`idleSweepTimer`), `startChildProcessDiscovery()` (`server.js`, near
`installChildProcessSpawnTracking()`), `lib/storage/worker-host.js` timers
(expiry/watchdog/restart), `lib/ws/pty-ws-handler.ts:276` (resize debounce).
They look like per-resource or debounce timers; re-check if the follow-up wants a
complete inventory.

## 3. Details for each "migrate"

All jobs are registered the same way as `chatAutoArchiveJob`: a frozen job object
exported from the module that owns the logic, added to the registration list in
`startPeriodicJobsSafely()`. **No edit to `lib/periodic-job-runner.js` is needed
by any leaf** (this also keeps the fa0f9bff coordination trivial, section 4).

### U1 — runner bootstrap independent of the paused boot (prerequisite)

- Today: runner singleton is created inside `startPeriodicJobsSafely()`, after the
  early return at `lib/delegation-runtime-boot.js:329`.
- Change: extract `ensurePeriodicJobRunner()` (creates the singleton and registers
  the built-in jobs, idempotent) so it can be called from `server.js` too, and
  have `bootDelegationRuntime` keep its own pause behaviour for runtime-bound
  jobs (auto-archive, harness updates) via `isEnabled`.
- Duplication removed: none by itself; it removes the structural reason the
  maintenance jobs need their own timers.
- restoreGate/pause: the restore-gated jobs use
  `isEnabled: () => !shouldSkipAutomaticWork()`, so they idle during a pause and
  resume on the next tick after it is lifted — equal to the current
  `server.js:908` behaviour.
- Tests: unit test that the runner exists after a paused `bootDelegationRuntime`;
  a job whose gate flips from paused to unpaused runs on the next tick (use the
  runner's injectable `setIntervalFn`); healthy and degraded boot still start the
  same jobs; `runner.stop()` on shutdown stops all.

### U2 — memory monitor, harness recovery notices, harness update check

- Removes: three hand-rolled `setInterval`/`setTimeout` + unref + catch blocks
  (`server.js:895-897`, `harness-recovery-producer.js:68-83`,
  `harness-updates-worker.js:39-58`), and the duplicated in-flight guards.
- Jobs: `memory_monitor_alerts` (60 s), `harness_recovery_notices` (30 s),
  `harness_update_check` (60 s); all `runOnStart: true`, matching today's
  immediate first run. `run` returns a small count object (published/archived),
  never message text.
- restoreGate/pause: memory monitor and recovery notices are **not** gated today
  (they publish during a pause) and stay ungated. The update check is not started
  on a paused boot today, so its job gets the `shouldSkipAutomaticWork` gate to
  keep that.
- Keep the exported `start*/stop*` functions or update their callers/tests
  together; do not leave two clocks running.
- Tests: each job's `run` is exercised with injected deps; job registered with the
  expected id/interval/`runOnStart`; second tick while the first is running
  increments `skipped`; a thrown `run` lands in `lastError` and does not stop the
  interval; `GET /api/wakeups/status` includes the new rows.

### U3 — agents scheduler (removed)

The legacy Agents runner and its timer have been removed. No migration to the periodic job runner is needed.

### U4 — usage maintenance (three jobs)

- Removes: `startLoop`/`schedule` helpers and the `timers` array
  (`usage-maintenance.ts:99-112`), which re-implement `arm()`.
- Jobs: `usage_retention` (6 h), `usage_alerts` (5 min),
  `balance_forecast_alerts` (5 min), all `runOnStart: true`. Registered without
  the lazy `import()` race: the job `run` function dynamically imports or the
  module is imported at registration; failure must stay non-fatal (today a failed
  import only logs a warning, `server.js:902`).
- restoreGate/pause: not gated today; keep ungated.
- Tests: intervals and `runOnStart` as above; a throwing alert run does not stop
  the other two jobs; typecheck for the TS module stays clean (the runner is JS).

## 4. Coordination with fa0f9bff (Stability, S6)

Checked read-only with `todo_show` on `fa0f9bff` (plan and children) and on its
child `74263fe0` (S6, scheduler); `git log -- lib/periodic-job-runner.js` shows
the runner was last changed by commit `5fa73347` only.

- The approved plan and S6's full body do not mention
  `lib/periodic-job-runner.js`, `startPeriodicJobsSafely` or the timers above.
  S6 targets Watcher/delegation admission (priority classes, fair share, failure
  ceiling, `Why?` reasons), i.e. the *decision* logic in `lib/workspace-watcher*.js`
  and delegation start, not the timers.
- **Limit of this check:** the child bodies S2/S3/S4/S5/S7/S8 and Q1-Q6 only
  expose truncated previews through `todo_list`/`todo_show`; I did not read them
  in full, and I cannot prove from previews that none of them edits the runner.

Verdict: **no direct collision found; two indirect overlap risks.**

1. S2 (event bus, push instead of polling) may delete or replace polling timers
   such as the memory monitor, harness recovery notices or watcher polling.
   Avoidance: before starting U2, re-run `todo_show` on S2 and skip any timer
   that S2 already owns or removes; do not migrate a timer that is about to be
   deleted.
2. S3/S4/S7 may touch `server.js` listen block or
   `lib/delegation-runtime-boot.js` (child reaper, worker pool, moving the
   delegation runtime off the HTTP thread — the last one could relocate the
   `delegation-runtime-worker.js:695` tick, which this document leaves alone).
   Avoidance: all leaves here only add job registrations and replace small
   blocks; never edit `lib/periodic-job-runner.js`; keep each diff to the
   registration list and the timer block it replaces; re-run `todo_list` for
   `fa0f9bff` right before each implementation leaf and rebase; run U1..U4
   sequentially (they share `lib/delegation-runtime-boot.js`/`server.js`).

Neither tree should edit the other; this analysis made no changes to the
`fa0f9bff` tree.

## 5. Public contract

- No HTTP route, setting key, config key, WebSocket message or stored-data
  format changes. Log lines are preserved.
- **Additive visible change:** `GET /api/wakeups/status` already returns the
  runner's `jobs` array (`lib/routes/wakeups-routes.js:95`); the migrations add
  rows (`memory_monitor_alerts`, `harness_recovery_notices`,
  `harness_update_check`, `usage_retention`, `usage_alerts`,
  `balance_forecast_alerts`) and the Wake-ups view (`wakeupsView.js:187`) will
  list them. Each job's `settingKey` is empty (`''`) unless a real setting
  exists. This is additive and does not require a user decision, but the
  implementation leaf should confirm the view renders unknown rows generically
  and that the extra rows are acceptable to the maintainer.
- No user decision is required for the verdicts above. If the maintainer wants
  the memory monitor gated during
  an offline-restore pause, that would be a behaviour change and a separate
  user decision.

## 6. Proposed implementation order

1. **U1** runner bootstrap independent of paused boot (prerequisite for U3).
2. **U2** memory monitor + harness recovery + harness update check (check S2
   first).
3. **U3** removed; no implementation needed.
4. **U4** usage maintenance.

Everything marked "leave" needs no leaf. Estimated net effect: seven hand-rolled
timer blocks replaced by registrations, with overlap guard and status for each.
