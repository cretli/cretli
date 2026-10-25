# Scout pass cost (`workspaceWatcherScoutPass`)

`runWorkspaceWatcherScoutPass` runs inline on the main thread about once a
minute (`timeJobAsync('workspaceWatcherScoutPass', …)` in
`lib/delegation-runtime-worker.js`). Even with an empty queue it reads the
watcher rows and, per row, runs scan reconciliation and expiry.

## Per-phase instrumentation

Each phase is timed with `process.hrtime` and aggregated in memory
(`lib/workspace-watcher-scout-phases.js`): count / total ms / max ms per
phase and shortened workspace id (8 hex chars, no paths). Phases:
`loadWorkspaceWatchers`, `reconcileScoutScans`, `expireStaleActiveScoutScan`,
`archiveIdleScoutChats`, `selectDueScoutProfiles`, `runWorkspaceWatcherScout`,
`sweepClosedWorkspaceWatcherCycles`. Each attempted scan also records
`scoutAgentCount` around the workspace snapshot and a zero-duration
`scoutOutcome_<reason>` counter (or `scoutOutcome_scanned` for a started scan).
Outcome counters show why a due profile did not start; divide timed rows by
`passes` to compare costs. An early workspace-level denial has no
`scoutAgentCount` row because it skips the snapshot.

- `getScoutPassPhaseStats()` / `resetScoutPassPhaseStats()` are exported from
  `lib/workspace-watcher-scout.js`.
- `lib/server-diagnostics.js` flushes them as a `scout-pass-phases` event at
  the `write-stats` cadence (every 5 minutes: snapshot, reset, record; top 30
  rows by total ms). `flushScoutPassPhases()` can be called directly.

### Reading it live

Read the `scout-pass-phases` events from the server diagnostics JSONL (the
diagnostics endpoint / `server-diagnostics-<day>.jsonl` in the data dir).
`details.scoutPassPhases.passes` is the pass count in the window; divide each
row's `totalMs` by `passes` for the per-pass cost, and sum rows per phase
across workspaces.

## Scope-error backoff

Operator window (9 passes, hot workspace): `runWorkspaceWatcherScout` 129
ms/pass, of which `scoutAgentCount` 74 ms (57%), and `scoutOutcome_scope_error`
in 9 of 9 passes (typically a configured base branch that does not exist).
`sweepClosedWorkspaceWatcherCycles` was 22 ms/pass, below the 30 ms gate, so
its chat reader is left unchanged.

After a `scope_error` the profile enters an in-memory exponential backoff
(5 min, doubling, capped at 60 min), keyed by workspace, profile and scope
signature. While active, `runWorkspaceWatcherScout` returns
`scope_error_backoff` before the agent-count snapshot (no `scoutAgentCount`
row, `scoutOutcome_scope_error_backoff` counter). Editing the scope or profile
revision, a manual run (`bypassInterval`), or a restart retries immediately; a
successful scope resolution clears the entry. The underlying misconfiguration
still needs fixing by the operator.

## Live diagnosis for the remaining cost

The last production window before the new count and outcome counters (2026-10-25,
10 passes) showed one due workspace with `runWorkspaceWatcherScout` at about
144 ms/pass. `sweepClosedWorkspaceWatcherCycles` was about 17 ms/pass, below
the 30 ms/pass gate for changing its chat reader. The due profile was mature,
but the old counters did not reveal why its scan was denied.

The next measurement requires at least two `scout-pass-phases` events and at
least 10 passes after the server runs the instrumented code. Record per-pass
`runWorkspaceWatcherScout`, `scoutAgentCount` and
`sweepClosedWorkspaceWatcherCycles` times, plus `scoutOutcome_*` counts by
short workspace id. The count share and outcomes determine whether to skip a
denied snapshot, investigate an occupied Scout slot, or profile other CPU
work. Repeat the same measurement after any selected change. No branch or
improvement is inferred from the earlier window alone.

### CPU profile recipe

```
node --cpu-prof --cpu-prof-dir=./prof server.js   # let a few passes run, then stop
```

Open the `.cpuprofile` in DevTools and search for `runWorkspaceWatcherScoutPass`.

## Fixture measurement

`node scripts/scout-pass-fixture.mjs [--passes 20] [--json]` builds a
throw-away data dir (never the real `data/`) with 8 watcher rows (6 off,
2 observe with Scout enabled), 1500 chats and 2000 todos, then runs 20 passes.

Median of 20 passes (this machine, empty queue):

| Phase | median ms |
| --- | --- |
| whole pass | 23.6 |
| runWorkspaceWatcherScout | 19.4 (~82%) |
| reconcileScoutScans | 1.4 |
| expireStaleActiveScoutScan | 1.4 |
| loadWorkspaceWatchers | 0.4 |
| archiveIdleScoutChats | 0.3 |
| sweepClosedWorkspaceWatcherCycles | 0.01 |

## Gate decision

The original fixture plan gated the fix on the dominant phase taking >= 30% of the pass **and**
>= 40 ms absolute. On the fixture the dominant phase
(`runWorkspaceWatcherScout`) is 82% but only 19.4 ms, and the whole pass is
23.6 ms, far from the 230-420 ms seen in production. The gate is **not met**,
so no skip optimisation was made: the real cost depends on real data size
(store sizes, git state of the scouted workspaces) that the fixture does not
reproduce. Next step for an operator: read the live `scout-pass-phases`
events (or a CPU profile) and open a follow-up for the phase that dominates
there.

## `/api/settings`

Not investigated beyond instrumentation: the phase data only shows how long the
pass blocks the loop; any request arriving during that window waits for it.
