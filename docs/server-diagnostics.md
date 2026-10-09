# Server diagnostics and automatic restart

Cretli writes a compact JSON Lines record to `data/server-diagnostics-YYYY-MM-DD.jsonl` once per minute. The files include process RSS and heap, host available memory and swap, the ten largest processes by RSS, load average, uptime, PID, Node version, and server instance token. Linux swap and process data come from `/proc`; on other platforms, swap is `null` and the process list is empty. Startup, listen, shutdown signals, uncaught exceptions, unhandled rejections, server errors, and process exit codes are recorded as events. Error messages are redacted and capped at 300 characters; repeated non-fatal errors are limited to one record per minute and later summarized. The `suppressedCount` includes events dropped by throttling or a failed/size-limited write. Fatal errors bypass throttling and may exceed the 4 MiB daily cap by one bounded record per process start so their cause is retained. Other entries past that limit are skipped and one warning is written to the server log. All files older than 14 days are removed at startup and on each UTC day rollover. If the diagnostics directory cannot be created, Cretli logs the issue and runs without persistent diagnostics.

The authenticated endpoint `GET /api/diagnostics/server` returns a current snapshot and up to 200 recent records. Set `?limit=1000` to request more. It requires a Cretli login session and rejects widget and MCP integration bearer tokens; the public `/api/health` response remains intentionally small. The response also carries `monitorAlerts`, the most recent memory/orphan monitor records (see below), and `opencode`, the live/pending OpenCode instance counts with the active opt-in cap (`{ live, pending, limit }`, `limit: 0` means unlimited — see [opencode/SETUP.md](./opencode/SETUP.md)).

## Memory and orphan monitor (machine-level safety net)

The in-process diagnostics recorder dies with the server, exactly when the host is under memory pressure. `scripts/memory-orphan-monitor.js` is a read-only safety net that runs **outside** the server, about once a minute, from a systemd timer or cron. It never signals or kills any process. Copy `systemd/cretli-memory-monitor.service.example` and `systemd/cretli-memory-monitor.timer.example`, point `WorkingDirectory`/`ExecStart` at your checkout, and run it as the same user as Cretli (it reads `data/opencode-ports.json` and the earlyoom journal).

Each run appends alarms to `data/memory-monitor-alerts-YYYY-MM-DD.jsonl` (mode 0600, 4 MiB daily cap, 14-day retention) and keeps `data/memory-monitor-state.json` with the per-alert episode state and the earlyoom journal cursor. Exit code is `1` while a threshold is exceeded, `0` otherwise; the example service maps both to success so an episode does not mark the unit failed.

The server reads the JSONL at startup and every minute (`lib/notifications/memory-monitor-producer.js`) and publishes each alarm into the in-app notification centre (category `system`). The store dedupes by fingerprint, so an alarm written while the server was dead becomes one visible notification after the next start and a replay creates nothing.

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

Example cron entry (writes the same JSONL; use `%` escaping and add the threshold variables you need):

```cron
* * * * * cd /path/to/cretli && /usr/bin/node scripts/memory-orphan-monitor.js >> /var/log/cretli-memory-monitor.log 2>&1
```

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

   In WSL, systemd must be enabled in the distribution first. Do not run a second instance while another Cretli process already owns port 3011.

`Restart=on-failure` restarts nonzero exits and signal kills. A successful `SIGTERM` shutdown exits cleanly and stays stopped; a delegation shutdown timeout exits nonzero and can be restarted if the signal came from outside `systemctl stop`. The example sets `NODE_ENV=production`, where Cretli exits after uncaught exceptions and unhandled rejections so systemd can restart it. In other modes those handlers record the error but keep the process alive. The unit runs as the logged-in user and inherits that user's `HOME`; keep credentials in Cretli's existing ignored `.env` file or runtime data, not in the unit file.
