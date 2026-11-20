# Agent operations reference

Detailed procedures that used to live in the always-applied rule
`.cursor/rules/cretli-system.mdc`. The rule keeps the short imperatives and
points here; read the matching section when the task needs it.

## Starting the server from a Cursor agent

When asked to start Cretli:

- Always start **outside the sandbox** (`required_permissions: ["all"]`). In the
  sandbox the process may start but the bind on port 3011 is invisible on
  localhost/LAN.
- Long-running process: `block_until_ms: 0` so the server keeps running after
  the agent step ends.
- Example: `npm start` in the project root with those options (HTTPS on
  `https://localhost:3011` by default).

If the page does not load, follow [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)
before touching webpack. Short version:

- Nothing on `127.0.0.1:3011` inside WSL → the process is dead (`SIGTERM` or
  exit 137). Start it again outside the sandbox. That is not a compile error.
- WSL `curl` to `127.0.0.1:3011` returns 200, but Windows `curl.exe` gets
  `ERR_CONNECTION_RESET` → `netsh interface portproxy` sends 3011 to the WSL
  eth address, and `npm start` only binds `127.0.0.1`. Either `npm run
  start:lan`, or `socat` on the WSL IP forwarding to `127.0.0.1:3011`.
- A cached shell plus “server is unavailable” is the same network break. The
  service worker painted the page; `/api/health` never connected.
- After a WSL restart, refresh the WSL IP (`wsl.exe hostname -I`), re-run
  `scripts/wsl-port-forward.ps1`, and restart the forwarder. Restart the Node
  process **inside WSL**.

## Frontend build

The front is usually rebuilt in the background by the VS Code/Cursor task
`Cretli: build front (watch)` (`npm run watch:front` — one exclusive CLI
webpack watcher per config; lock files live under `data/`).

- Do **not** ask the user to run a build.
- Do **not** run `npm run watch:front` / `npm run build:front:prod` after every
  `app_front/` change — assume the watcher updates `public/dist/`.
- `npm run build:front` is a **one-shot** dev build (`--no-watch`); use it when
  the watcher is down or the user wants a single compile.
- Manual watch restart only if the user asks or the watcher is clearly down.

Default dev mode is the **external CLI watcher** (`npm run watch:front`, VS Code
task `Cretli: build front (watch)`) writing `public/dist/app/`; the browser picks
it up through the PWA update banner (`/api/health` `frontAssetVersion`). There is
no in-process HMR: `npm start` must never load webpack into `server.js`.
`CURSOR_REMOTE_FRONT_HOT_FALLBACK=0` disables the dist watcher (on by default).

## Server restart vs brief disconnect

### Supervisor controls

Settings → Connection → Network includes the supervisor panel: current state,
supervisor and server PIDs, supervisor start time, last failures, safe mode and
recent redacted supervisor events and server output. Status and expanded logs
refresh every five seconds while the panel is visible.

**Disable supervision** leaves the server running and pauses health probes and
automatic restarts. **Enable supervision** resumes them. The policy survives a
supervisor restart; disabling supervision does not remove the autostart entry.
If the server exits while supervision is disabled, it must be started externally.

**Restart supervisor** reloads both supervisor and server code. It disconnects
clients and requires confirmation. It shares the updater's exclusion slot and
refuses while chats, tasks or delegations are active. For systemd services it
verifies `MainPID` and `Restart=always` before requesting a graceful supervisor
exit; systemd starts the replacement. A manually started supervisor uses a
detached helper that waits for both old processes to exit before starting a new
supervisor. Starting supervision for a standalone server uses the same helper
and restarts that server under supervision. Older supervisors must be restarted
before enable/disable controls become available.

These login-session-only endpoints are unavailable to widgets and MCP clients:
`GET /api/settings/supervisor`, `GET /api/settings/supervisor/logs`, and
`POST /api/settings/supervisor` with `{ "action": "enable|disable|restart", "confirm": true }`.
The restart button for the server alone does not reload the supervisor.

### Client recovery

`GET /api/settings` returns `serverInstanceToken` (UUID per process). The
frontend stores it in `localStorage` and compares on reconnect: token changed →
server restart; same token or no response → brief disconnect. Chat recovery:
`app_front/features/chat/chatServerRecovery.js`. Task-run recovery:
`app_front/tasks.js`.

SDK auto-recovery: `CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY=0` disables killing
stuck runs; `CURSOR_REMOTE_SDK_RUN_AUTO_RECOVERY_GRACE_MS` (default 60000) is
the idle grace.

## Known issue: `generating` appends new lines

If the chat `generating` animation appends lines instead of overwriting:

- PTY size must match xterm (`cols`/`rows` from the client, no fake min 80).
- On `resize` in `server.js`, do **not** clamp the new size to the previous
  `session.ptyCols/ptyRows` with `max(old, new)` — the PTY then cannot shrink.
- Recompute PTY size from current `clientSizes` after a client disconnect.
- Keep `safeFit(...)` on container resize in `app_front/chat.js` so xterm and
  PTY stay aligned.
