# Server diagnostics and automatic restart

Cretli writes a compact JSON Lines record to `data/server-diagnostics-YYYY-MM-DD.jsonl` once per minute. The files include process RSS and heap, host available memory and swap, the ten largest processes by RSS, load average, uptime, PID, Node version, and server instance token. Linux swap and process data come from `/proc`; on other platforms, swap is `null` and the process list is empty. Startup, listen, shutdown signals, uncaught exceptions, unhandled rejections, server errors, and process exit codes are recorded as events. Error messages are redacted and capped at 300 characters; repeated non-fatal errors are limited to one record per minute and later summarized. The `suppressedCount` includes events dropped by throttling or a failed/size-limited write. Fatal errors bypass throttling and may exceed the 4 MiB daily cap by one bounded record per process start so their cause is retained. Other entries past that limit are skipped and one warning is written to the server log. All files older than 14 days are removed at startup and on each UTC day rollover. If the diagnostics directory cannot be created, Cretli logs the issue and runs without persistent diagnostics.

The authenticated endpoint `GET /api/diagnostics/server` returns a current snapshot and up to 200 recent records. Set `?limit=1000` to request more. It requires a Cretli login session and rejects widget and MCP integration bearer tokens; the public `/api/health` response remains intentionally small. The response also carries `monitorAlerts`, the most recent memory/orphan monitor records, `oomMarkers`, the durable OOM/termination markers written by the external monitor (see [OOM diagnostics](#oom-diagnostics)), and `opencode`, the live/pending OpenCode instance counts with the active opt-in cap (`{ live, pending, limit }`, `limit: 0` means unlimited — see [opencode/SETUP.md](../harnesses/opencode/SETUP.md)).

## Memory and orphan monitor (machine-level safety net)

The in-process diagnostics recorder dies with the server, exactly when the host is under memory pressure. `scripts/memory-orphan-monitor.js` is a read-only safety net that runs **outside** the server, about once a minute, from a systemd timer or cron. It never signals or kills any process. Copy `systemd/cretli-memory-monitor.service.example` and `systemd/cretli-memory-monitor.timer.example`, point `WorkingDirectory`/`ExecStart` at your checkout, and run it as the same user and in the same systemd service scope as Cretli (it reads `opencode-ports.json` from the shared data directory and the earlyoom journal). Do not install one unit as a user service and the other as a system service: `%S/cretli` resolves to different locations in those scopes. If mixed scopes are unavoidable, replace `%S/cretli` in both units with the same explicit absolute path and grant both service users the required access.

Each run appends alarms to `data/memory-monitor-alerts-YYYY-MM-DD.jsonl` (mode 0600, 4 MiB daily cap, 14-day retention), appends a memory ledger sample to `data/memory-ledger.jsonl`, records external-evidence termination markers in `data/oom-markers.jsonl` (see [OOM diagnostics](#oom-diagnostics)), and keeps `data/memory-monitor-state.json` with the per-alert episode state, the earlyoom journal cursor and the last observed server/executor identities. Exit code is `1` while a threshold is exceeded, `0` otherwise; the example service maps both to success so an episode does not mark the unit failed.

The server reads the JSONL at startup and every minute (`lib/notifications/memory-monitor-producer.ts`) and publishes each alarm into the in-app notification centre (category `system`). The store dedupes by fingerprint, so an alarm written while the server was dead becomes one visible notification after the next start and a replay creates nothing.

Conditions, each independent and configurable through environment variables (defaults are for a 24 GiB RAM + 8 GiB swap host, not universal):

| Condition | Default | Variable |
|-----------|---------|----------|
| `MemAvailable` below the critical threshold | 4096 MiB | `CRETLI_MEMORY_MONITOR_MEM_CRITICAL_MB` |
| `MemAvailable` below the warning threshold | 6144 MiB | `CRETLI_MEMORY_MONITOR_MEM_WARN_MB` |
| Swap used above the ratio, or a fast rise (bytes within the window) | 0.5 / 1024 MiB / 10 min | `CRETLI_MEMORY_MONITOR_SWAP_USED_RATIO`, `CRETLI_MEMORY_MONITOR_SWAP_GROWTH_MB`, `CRETLI_MEMORY_MONITOR_SWAP_GROWTH_WINDOW_MS` |
| Orphaned `opencode serve` (registry entry whose owner server PID + start time is dead) | — | — |
| Total `opencode serve` processes above the high bound | 10 | `CRETLI_MEMORY_MONITOR_MAX_OPENCODE` |
| More than one webpack watcher per resolved project + config realpath | — | — |
| New earlyoom `sending SIGTERM`, `sending SIGKILL`, `escalating to SIGKILL` journal events | — | `CRETLI_MEMORY_MONITOR_JOURNAL_UNIT` (default `earlyoom`) |
| Repeat window for one alert episode | 30 min | `CRETLI_MEMORY_MONITOR_ALERT_REPEAT_MS` |
| Processes listed with each alarm | 10 | `CRETLI_MEMORY_MONITOR_TOP_PROCESSES` |

`opencode serve` processes outside the registry are reported as foreign (in the CLI output and the diagnostics snapshot) and do not raise the orphan alarm. One instance per chat is normal, so the monitor has no low count threshold. The orphan test is the registry owner's PID **and** `/proc` start time, never `PPID == 1`: on WSL an orphan is re-parented to Relay/init with an unrelated PID. When `journalctl` (or the journal) is unavailable, the earlyoom condition is skipped with a warning, not an error.

Example cron entry (an alternative to the systemd timer; use `%` escaping and add the threshold variables you need). It must use the **same data directory as the server**. With the persistent state directory from the example units:

```cron
* * * * * cd /path/to/cretli && CRETLI_DATA_DIR="$HOME/.local/state/cretli" /usr/bin/node scripts/memory-orphan-monitor.js >> /var/log/cretli-memory-monitor.log 2>&1
```

Replace `$HOME/.local/state/cretli` with the absolute path that `%S/cretli` resolves to for your units (`/var/lib/cretli` for system units), or pass the same path as `--data-dir`. If you deliberately run Cretli **without** `CRETLI_DATA_DIR` (the checkout-local mode), omit it here too so cron and the server both use `data/` in the checkout; never mix the persistent state directory and the checkout directory. A cron-only install cannot see alarms written to a directory the server does not read.

## Capture crashes and restart automatically with systemd

The in-process log cannot record `SIGKILL`, kernel OOM kills, or host shutdown because the process cannot run code after those events. A process manager records the exit result and can restart Cretli. `systemd/cretli.service.example` is a starting point for a user service:

1. Copy it to `~/.config/systemd/user/cretli.service`.
2. Set `WorkingDirectory` to the Cretli checkout and `ExecStart` to the `npm` executable available to that user. If Node is installed through a version manager, set `PATH` to include both that manager's Node and npm directories; systemd user units do not inherit the interactive shell PATH. The example's `/usr/local/bin:/usr/bin:/bin` is for system installations and must be adjusted for version managers.
3. Production mode serves the checked-out `public/dist/` assets and does not run the development frontend middleware. Build them from the checkout before starting the service (`npm run build:front:prod`).
4. If the service must start at boot without an active login session, enable lingering for the account (this may require an administrator), then run:

   ```sh
   loginctl enable-linger "$USER"
   systemctl --user daemon-reload
   systemctl --user enable --now cretli.service
   systemctl --user status cretli.service
   journalctl --user -u cretli.service --since today
   ```

   With an existing checkout, do the [data migration](#persistent-state-and-data-migration) **before** that first `enable --now`; enabling first starts Cretli against an empty state directory. In WSL, systemd must be enabled in the distribution first. Do not run a second instance while another Cretli process already owns port 3011.

See [Process supervision](#process-supervision) below for what the example's restart, stop, start-limit and state-directory options do. The example sets `NODE_ENV=production`, where Cretli exits after uncaught exceptions and unhandled rejections so systemd can restart it. In other modes those handlers record the error but keep the process alive. The unit runs as the logged-in user and inherits that user's `HOME`; keep credentials in Cretli's existing ignored `.env` file or runtime data, not in the unit file.

## Process supervision

`systemd/cretli.service.example` separates two problems that are easy to conflate:

| Failure | Detected by | Recovered by |
| --- | --- | --- |
| Process exited, crashed, or was killed (`SIGKILL`, OOM kill) | systemd (it owns the child) | `Restart=always` after `RestartSec=10` |
| Process **alive but hung** (event loop stuck, not answering HTTP) | nothing in the unit | an external probe plus an explicit restart |

`Restart=always` alone does **not** detect a hang: a live process never exits, so systemd sees a healthy unit. Cretli does not implement `sd_notify`, so `Type=notify` and `WatchdogSec=` would never receive a keep-alive and are deliberately not used.

**Readiness and health.** `Type=simple` marks the unit active when the process is forked, before the port is bound. The only probe endpoint is the unauthenticated `GET /api/health` (JSON `{"ok":true,"serverInstanceToken":...,"startedAt":...}`), answered only after `server.listen`; there is no separate `/api/ready`. It is a liveness/readiness signal for the HTTP event loop, not a deep check of harnesses. Use `curl -fsk --max-time 5 https://127.0.0.1:3011/api/health` (`http://` when `USE_HTTPS=0`; `-k` because the default certificate is self-signed). To detect hangs, run that probe from a timer or monitor under the same user, require several consecutive failures, and then `systemctl --user try-restart cretli.service`. Do **not** let automatic probe code run `start` or a plain `restart`: those start a unit that the operator intentionally stopped and sidestep that deliberate stop, and repeated attempts consume the start-limit budget. `try-restart` only acts on a unit that is currently active, so an intentionally stopped unit stays stopped. If the probe finds the unit inactive or `failed` (for example `start-limit-hit`), it must only alert a human; after investigating the cause, run `systemctl --user reset-failed cretli.service` and start the unit deliberately. If `try-restart` itself fails (including a start refused because the limit is exhausted), the probe must alert and never fall back to `start` or `reset-failed`. Restarts triggered this way count toward the same start limit.

**Intentional stop.** `systemctl --user stop cretli.service` sends `SIGTERM`; Cretli runs its graceful shutdown (child processes, OpenCode, browser sessions, chat-state flush at 3 s, delegation drain at 8 s) and exits. systemd does not restart a unit stopped through `systemctl`, even with `Restart=always`. A `SIGTERM` or exit sent from outside systemctl is not a stop and is restarted. `TimeoutStopSec=45` exceeds the sum of those bounded waits; after it, systemd sends `SIGKILL` to the whole control group. In production (`NODE_ENV=production`) the in-process dev restart is disabled, so systemd is the only restarter.

**Restart storm protection.** `StartLimitBurst=5` within `StartLimitIntervalSec=600`, plus `RestartSec=10`, caps a crash loop at 5 starts per 10 minutes; then the unit is `failed` (start-limit-hit) instead of looping. Inspect with `systemctl --user status cretli.service`, fix the cause, then `systemctl --user reset-failed cretli.service` and start again.

### Persistent state and data migration

**Persistent state.** `StateDirectory=cretli` makes systemd create and own a directory that survives restarts and reboots, and `CRETLI_DATA_DIR=%S/cretli` points Cretli's data directory (`lib/runtime-paths.js`) at it; without it data goes to `data/` inside the checkout. The server and memory-monitor examples deliberately contain the exact same two settings. Install both in the same service scope and run them as the same user so `%S/cretli` resolves to one directory (`$XDG_STATE_HOME/cretli`, normally `~/.local/state/cretli`, for user units; `/var/lib/cretli` for system units). Alternatively, configure the same explicit absolute `CRETLI_DATA_DIR` in both units and arrange ownership deliberately. Keep API keys in the ignored `.env` file; the units contain no secrets.

Do the migration **before the first `systemctl --user enable --now` of either unit** (step 4 above). Stay stopped for the whole copy: stop the server, the monitor timer, and any monitor run already in progress. For a user-service installation, use generic paths such as:

```sh
# Fail fast: abort the whole migration on the first failing command so a
# broken stop or copy can never lead to `enable --now` starting the service
# against the wrong or partially copied state directory.
set -euo pipefail
# Stay stopped for the whole copy. Stop every unit that is currently enabled or
# active, and refuse to continue if any stop fails. Units that are not yet
# installed (fresh migration) are skipped, but an enabled/active unit whose stop
# fails aborts the migration instead of letting `enable --now` start it again.
for unit in cretli-memory-monitor.timer cretli-memory-monitor.service cretli.service; do
  if systemctl --user is-enabled "$unit" >/dev/null 2>&1 || systemctl --user is-active "$unit" >/dev/null 2>&1; then
    systemctl --user stop "$unit" || { echo "migration aborted: failed to stop $unit" >&2; exit 1; }
  fi
done
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/cretli"
# The destination must be nonexistent or empty: a partially populated state
# directory would mix old and new data, so refuse rather than overwrite.
if [ -e "$state_dir" ] && [ -n "$(ls -A -- "$state_dir")" ]; then
  echo "refusing to migrate: $state_dir already exists and is not empty" >&2
  exit 1
fi
install -d -m 0700 "$state_dir"
# Copy the checkout data BEFORE enabling or starting either unit. Abort if the
# copy fails so the service is never started against a missing/partial state.
cp -a /path/to/cretli/data/. "$state_dir"/ || { echo "migration aborted: failed to copy checkout data" >&2; exit 1; }
systemctl --user daemon-reload
systemctl --user enable --now cretli.service cretli-memory-monitor.timer
```

Inspect the destination before removing the old checkout data; keeping it temporarily provides a rollback copy. For system units, perform the same stopped copy to `/var/lib/cretli`, preserve or set ownership for the unit's configured `User=`, and use `systemctl` without `--user`. Do not run the old checkout-backed process concurrently with the migrated service.

**Rollback.** To return to the checkout-local data directory, stop and disable both units, remove `StateDirectory=cretli` and `Environment=CRETLI_DATA_DIR=%S/cretli` from **both** copied unit files (or restore the copies saved before editing), run `systemctl --user daemon-reload`, and start the old setup again. If the migrated units already wrote chats/settings into `$state_dir`, copy those files back into `/path/to/cretli/data` while both units are stopped, and revert the monitor settings together with the server settings so the monitor does not keep writing to the state directory. The untouched checkout copy kept during migration is the safest restore point.

Validate manually before enabling:

```sh
systemd-analyze --user verify ~/.config/systemd/user/cretli.service ~/.config/systemd/user/cretli-memory-monitor.service ~/.config/systemd/user/cretli-memory-monitor.timer
systemctl --user show cretli.service -p Restart -p RestartUSec -p StartLimitBurst -p StartLimitIntervalUSec -p TimeoutStopUSec
npm run test:systemd-example
```

## OOM diagnostics

A process killed by `SIGKILL` (kernel OOM killer, earlyoom, systemd-oomd) cannot
record its own cause. The OOM marker is therefore written by a **later external
observer** — the machine-level `scripts/memory-orphan-monitor.js` run, or the
next server boot when it reads older markers — from external evidence only. A
killed process is never expected to write a marker, and absence of evidence is
reported as `unknown`, not as "no OOM".

### Runtime wiring

- **Server boot** (`server.js`) writes `data/server-runtime.json` before serving
  traffic: the server pid, its `/proc` start time (jiffies) and the instance
  token. PID **and** start time are the identity, so a recycled PID is never
  mistaken for the recorded server. Boot also reads recent markers, records an
  `oom-diagnostics-boot` event in the diagnostics recorder, and exposes the
  newest `oomMarkers` through `GET /api/diagnostics/server`. That response
  carries at most the newest 100 marker rows read from the main
  `data/oom-markers.jsonl` (`?limit=` selects how many, capped at 100); the
  `.1` rotation produced by the 2 MiB cap is never served.
- **Graceful shutdown** writes `data/server-shutdown.json` with the same pid +
  start time. This is the only "clean shutdown" evidence; `SIGKILL` can never
  write it. A marker from an older instance does not cover a later death.
- **External monitor** (`scripts/memory-orphan-monitor.js`, run by the systemd
  timer or cron described above; it never signals or kills anything):
  1. reads `data/server-runtime.json` and `data/child-processes.json`, compares
     each recorded pid + start time with live `/proc` state;
  2. reads kernel and unit journal evidence (`journalctl -k`, plus
     `cretli.service` and `systemd-oomd` units) and, when available, a cgroup v2
     `memory.events` `oom_kill` delta;
  3. classifies every unexpected server/executor termination and appends a
     durable marker;
  4. appends one memory ledger sample.
  A stale child-registry entry (the process is gone but the entry remains) means
  the child did not exit cleanly. A child that vanished is marked only when the
  journal names its pid, or when the cgroup OOM counter rose together with
  unit-level evidence; normal task completion stays silent. Results are deduped
  across runs through `data/memory-monitor-state.json`.
- **Executor launch gate** (`lib/executor-launch-gate.js`) is activated at
  server boot and checked *before* a process exists at every managed launch
  boundary: agent PTY sessions (the interactive agent terminal, agent run, the
  background agent scheduler), task-run PTYs (`.vscode/tasks.json` runs), the
  development frontend build, one-shot title agents, `opencode serve`, and
  harness/tool children (harness CLI, tool shell, review-verify, MCP bridge).
  The operator terminal PTY is deliberately exempt (see below).
  A refused launch throws `ExecutorLaunchDeniedError` and never reaches the
  spawn; the PTY handlers surface the message to the client and the server
  records an `executor-launch-denied` diagnostics event. `unknown` memory state
  (no `/proc/meminfo`, non-Linux, probe failure) is always allowed.

### Data files

| File | Writer | Purpose |
|------|--------|---------|
| `data/oom-markers.jsonl` | external monitor | Durable `{target, pid, cause, source, confidence, basis, evidence, recordedAt, writer: "external-observer", observer: "memory-monitor"}` records; 2 MiB cap, then one `.1` rotation. |
| `data/memory-ledger.jsonl` | external monitor | One sample per run: `at`, `hostTotalBytes`, `hostAvailableBytes`, `serverPid`, `serverRssBytes`, `executorsRssBytes`, `executorCount`, `unreadable`, and per-executor `{pid, type, label, rssBytes}` rows. `null` RSS means the process was gone or unreadable, never zero. |
| `data/server-runtime.json` | server boot | Durable pid + start-time identity used by the monitor, plus `previous` (the identity this boot superseded) so a fast restart before the next monitor run does not erase the evidence. A bounded `history` (8) keeps older superseded identities, so crash A / boot B / boot C is still attributed to A. |
| `data/server-shutdown.json` | graceful shutdown | Clean-shutdown proof scoped to one pid + start time, with a bounded history of earlier graceful identities. Written only for SIGTERM/SIGINT; fatal and `server-error` exits (forced non-zero code) leave no marker, so they stay reported as unexpected. |
| `data/child-processes.json` | server | Owned executor registry (already used by the shutdown sweep). Managed OpenCode servers live in their own ownership registry; the monitor merges both by pid (counted once). |
| `data/child-exit-events.json` | server | Bounded (100) log of executors that exited with SIGKILL (or shell code 137) that the server did not ask to stop. The registry entry is removed on exit, so this is how a kill between two monitor samples stays observable; reported as `sigkill`/`probable` by itself. Journal evidence naming the pid **and** falling inside that executor's recorded lifetime upgrades it to `oom-kill`/`confirmed`; unit-level OOM evidence upgrades it to `oom-kill`/`probable`. A pid match outside that lifetime, or with an unknown line or start time, remains `sigkill`/`probable`. |

Classification confidence:

- `confirmed` — a source names the exact pid **and** the evidence line is placed
  inside the recorded lifetime of that process instance (kernel `Out of memory:
  Killed process <pid>`, earlyoom line, etc.). A pid match whose line time or
  process start time is unknown stays `probable`.
- `probable` — unit-level `oom-kill`/cgroup evidence without a pid; a bare
  `Main process exited, code=killed, status=9/KILL` is reported as `sigkill`,
  never as OOM; an exact pid match that cannot be time-correlated.
- `unknown` — no evidence available (journal/cgroup inaccessible, rotated past
  the bounded window, non-Linux).

### Configuration

All variables are optional. The guard defaults to **on**; set
`CRETLI_EXECUTOR_MEMORY_GUARD=0` (or `false`/`off`/`no`) to disable the
pre-flight without disabling the monitor or marker recording.

| Variable | Default | Meaning |
|----------|---------|---------|
| `CRETLI_EXECUTOR_MEMORY_GUARD` | on | Activates the executor pre-flight gate in the server. |
| `CRETLI_MEMORY_GUARD_WARN_RATIO` | `0.15` | `MemAvailable / MemTotal` below this is a warning (launch still allowed if headroom is enough). |
| `CRETLI_MEMORY_GUARD_CRITICAL_RATIO` | `0.07` | Below this a launch is refused. |
| `CRETLI_MEMORY_GUARD_RESERVE_MB` | `512` | Required headroom above the critical line; a launch is refused when available minus the critical line is smaller. The reserve is capped at 5% of the memory total, so a 4 GiB host in the `ok` band is not refused; total and available are clamped to the cgroup `memory.max` / `memory.current` of the server. The boot summary announces an OOM marker once and only while it is younger than 24 hours. |
| `CRETLI_MEMORY_MONITOR_SERVER_UNIT` | `cretli.service` | Unit whose journal entries provide server/executor evidence. |
| `CRETLI_MEMORY_MONITOR_OOMD_UNIT` | `systemd-oomd` | systemd-oomd unit read for kill evidence. |

The existing monitor variables (`CRETLI_MEMORY_MONITOR_MEM_*`,
`CRETLI_MEMORY_MONITOR_ALERT_REPEAT_MS`, `CRETLI_MEMORY_MONITOR_TOP_PROCESSES`,
…) are described in the table above. The monitor must use the **same
`CRETLI_DATA_DIR`** as the server; otherwise it reads and writes a different
installation's identity, registry, markers and ledger.

### Operational behavior and limitations

- Journal access follows the monitor user's permissions. A missing `journalctl`,
  an unreadable journal or a rotated cursor produces a warning and a `unknown`
  or `probable` result; it never fails the run or invents a cause.
- cgroup evidence requires cgroup v2 (`/sys/fs/cgroup/<path>/memory.events`) and
  is best-effort: the unit cgroup may already be gone when a killed process is
  observed, in which case the journal alone decides.
- Non-Linux platforms have no `/proc`; memory is unknown (non-blocking), and
  process RSS/identity checks are skipped.
- The monitor only observes: an OOM marker never kills, restarts or throttles
  anything. The executor gate only refuses *new* launches; it never stops a
  running process.
- Thresholds are host-specific. The defaults target a 24 GiB host; tune the
  ratios/reserve for smaller machines so a normal workload is not refused.
- The marker/ledger files are diagnostic evidence, not a guarantee that an OOM
  was detected: `unknown` means "no external evidence", not "no OOM occurred".

### Evidence correlation, retry and known limitations

- Evidence sources merged for classification: the kernel/unit journal read
  (system `-u` **and** `--user-unit`, so a `systemctl --user` install is
  covered; a missing user journal is silent) plus the earlyoom kill lines the
  monitor already reads.
- **Line time vs instance lifetime.** Journal reads use `-o short-iso`, so every
  evidence line carries its event time (`at`, epoch ms). The target identity is
  the pid **plus** its `/proc` start time, converted to wall clock through
  `/proc/stat` `btime`. The comparison uses the *interval* the timestamp names,
  not a point: a whole-second `short-iso` stamp (`13:00:00`) is accurate to
  ±1 s and covers `[13:00:00.000, 13:00:00.999]`, so a process started at
  `13:00:00.500` is still covered by a `13:00:00` line (fractional stamps keep
  their real precision, 1 ms for `.123`). A line whose interval ends before the
  recorded start belongs to a previous owner of the recycled pid and is
  discarded — it can neither produce `oom-kill` nor appear in the marker
  `basis`/`evidence`. When either the line timestamp or the target start time is
  unknown, the correlation cannot be verified, so a pid match is reported as
  `probable`, never `confirmed`: a coincident pid alone is not proof. This
  applies equally to the kernel journal, the server unit stream, and the earlyoom
  journal (whose timestamp is prepended when the producer kept it separately).
- **Time-correlation limits.** The correlation is one-sided and is not a full
  identity proof:
  - Precision tolerance is ±1 s; a whole-second line can start up to 999 ms
    before the recorded process start, so two deaths in the same second cannot
    be told apart.
  - When the observer knows the instance end (`exitedAt`/`endedAt` from an exit
    event or shutdown record), evidence after that bound is rejected. The last
    observation while the process was alive is only a lower-bound liveness
    sample, never an end time. If no real end is recorded, any line at or after
    the start remains only a best-effort correlation and PID reuse cannot be
    excluded.
  - The identity is pid + start ticks only and carries no boot id; after a host
    reboot the recorded ticks no longer convert to a meaningful wall clock, so
    correlation against the new boot's journal is meaningless.
  - `sigkill-exit` evidence and the cgroup `oom_kill` delta are not
    time-correlated: they are attributed by pid/unit presence, not by a journal
    timestamp inside the recorded lifetime.
- Pidless evidence (systemd-oomd, a unit `oom-kill` result) is only attributed to
  a target when it names the server's unit (`CRETLI_MEMORY_MONITOR_SERVER_UNIT`)
  or the server's cgroup path (or an ancestor of it). An oomd kill of an unrelated
  cgroup proves nothing and leaves the cause `unknown`.
- A marker is acknowledged (deduped) only after it was durably written. A failed
  write is kept in `termination.pending` of the monitor state and retried on the
  next run. A target first reported `unknown` stays re-examinable for one hour;
  evidence that arrives later appends an enriching marker
  (`enrichesEarlierUnknown: true`) instead of being ignored. The re-examination
  window holds a whole durable batch (130 markers), so one run's SIGKILL batch
  cannot evict its own earliest entries before the later OOM evidence arrives;
  the window stays bounded.
- A weak `sigkill` marker is re-examined the same way (one-hour window). If OOM
  evidence for the same target arrives in a later run, an enriching
  `oom-kill` marker is appended after the `sigkill` row; an unchanged weak cause is
  not re-emitted. Cause rank decides dominance (`oom-kill` > `sigkill` >
  `unknown`), then confidence, so a later weaker record never replaces a stronger
  one. JSONL appends start on a fresh line after a torn tail, so one damaged
  fragment cannot swallow the next marker or ledger sample.
- The marker retry outbox is bounded to one complete durable exit-event window,
  the bounded server identity history, and one normal detection batch. A
  separate classified backlog retains up to 260 complete marker records while
  the 130-record retry batch drains. Already-read evidence and its source,
  confidence, basis, and text are stored in each staged record, so draining does
  not depend on reading the journal again. When the 260-record staging bound is
  reached, the monitor reports the unclassified count and pins the source
  checkpoints (termination journal cursor and time window, earlyoom cursor,
  cgroup counter, and prior executor identities); no source is acknowledged
  until its remaining classification fits durable state. A one-shot cgroup
  `oom_kill` increase and classified SIGKILL exits bypass the ordinary
  20-target evidence-free batch limit, within the bounded staging capacity.
  State files from before the classified backlog existed load with an empty
  backlog. Marker appends are idempotent across a crash between marker and state
  writes; an existing stronger classification is never replaced by a weaker
  retry.
- Journal reads are bounded (`-n 300` per query, 10-minute lookback without a
  cursor). When a query returns the full tail a warning says older lines in the
  window may be missing. The next cursor is the newest of the per-query cursors.
- The operator terminal PTY is deliberately **not** gated: under critical memory
  it is the manual remediation path. Agent PTYs and every classified
  harness/tool/`opencode serve` child are gated. The `child_process.spawn` hook
  also re-syncs the builtin ESM exports, so `import { spawn }` consumers (Codex
  SDK, title runners) reach the gate.
- Limitations (follow-up a009f9a1): `spawnSync`/`execFileSync` launches (git,
  version probes, title one-shots via `spawnSync`) are short-lived and not gated;
  ledger executor RSS is the RSS of the registered process only and excludes its
  descendants; the exit-event path cannot tell an external `kill -9` from an OOM
  kill without journal evidence (it reports `sigkill`/`probable`).
