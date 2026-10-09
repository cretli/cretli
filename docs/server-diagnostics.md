# Server diagnostics and automatic restart

Cretli writes a compact JSON Lines record to `data/server-diagnostics-YYYY-MM-DD.jsonl` once per minute. The files include process RSS and heap, host available memory and swap, the ten largest processes by RSS, load average, uptime, PID, Node version, and server instance token. Linux swap and process data come from `/proc`; on other platforms, swap is `null` and the process list is empty. Startup, listen, shutdown signals, uncaught exceptions, unhandled rejections, server errors, and process exit codes are recorded as events. Error messages are redacted and capped at 300 characters; repeated non-fatal errors are limited to one record per minute and later summarized. The `suppressedCount` includes events dropped by throttling or a failed/size-limited write. Fatal errors bypass throttling and may exceed the 4 MiB daily cap by one bounded record per process start so their cause is retained. Other entries past that limit are skipped and one warning is written to the server log. All files older than 14 days are removed at startup and on each UTC day rollover. If the diagnostics directory cannot be created, Cretli logs the issue and runs without persistent diagnostics.

The authenticated endpoint `GET /api/diagnostics/server` returns a current snapshot and up to 200 recent records. Set `?limit=1000` to request more. It requires a Cretli login session and rejects widget and MCP integration bearer tokens; the public `/api/health` response remains intentionally small.

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
