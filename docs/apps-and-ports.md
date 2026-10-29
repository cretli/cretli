# Apps and ports

## Diagnostics

`GET /api/net-env` returns a read-only snapshot of the Cretli host's network
configuration. A Cretli login session is required (401 without authentication).
No administrator privileges are needed for collection. No configuration, firewall
rule, forwarding rule or running application is changed. Suggestions are text
for an operator to review and execute manually.

The server caches the report for 15 seconds. `?refresh=1` bypasses that cache;
concurrent collection requests share the in-flight snapshot. Responses use
`Cache-Control: no-store` because they contain host addresses and process names.
Each external command has a 1500 ms timeout, including Windows interop commands.
A failed or timed-out probe produces a partial report with a reason instead of
failing the request. Sequential probe stages can each consume their timeout.

### Response schema (version 1)

The response is the report object itself:

| Field | Type / meaning |
| --- | --- |
| `schemaVersion` | Integer, currently `1` |
| `collectedAt` | ISO 8601 UTC timestamp |
| `platform` | `linux`, `wsl2`, `windows`, `macos`, or `unknown` |
| `partial` | Boolean; true if any probe failed or is unsupported |
| `reasons` | Array of `{ source, code, description }` strings; e.g. `interop` / `ENOENT` or `ETIMEDOUT` |
| `availability` | Boolean fields: `listeners`, `portproxy`, `wslAddresses`, `wslConfig`, `interop`. False also means not applicable on this platform. |
| `networkingMode` | `nat`, `mirrored`, `virtioproxy`, `none`, or null when unknown / not WSL |
| `wslAddresses` | Array of current IP address strings from `hostname -I` |
| `wslConfig` | Null if absent/unreadable/not applicable; otherwise object with optional `networkingMode` (string), `localhostForwarding` and `firewall` (boolean or null for invalid values) |
| `listeners` | Array of `{ address: string, port: number, pid: number or null, command: string or null }` |
| `portproxy` | Array of `{ listenAddress: string, listenPort: number, connectAddress: string, connectPort: number }` |
| `cretli` | `{ lanHost: string or null, bind: string, lanExposed: boolean }`, using the existing LAN host, bind and auth configuration helpers |
| `helper` | WSL2 only: status of the Windows helper, `{ state, installed, version, mode, rules }`. `state` is `ready` or the failure code that makes Cretli fall back to `manual` (`helper_missing`, `helper_busy`, `server_untrusted`, `no_user_session`, `timeout`, ...). Cached for 30 s. |
| `issues` | Array of `{ code, level, description, command, needsAdmin, needsWslRestart }`; level is `info`, `warning`, or `error`; command is a suggested command/template or null; flags are booleans |

Linux listeners come from `ss -ltnpH`. If ownership is omitted, a best-effort
read of `/proc/net/tcp` and accessible `/proc/<pid>/fd` entries resolves socket
owners. Permissions and process exits can leave `pid` and `command` null. Process command lines and arguments
are not collected.

WSL2 is identified from the Linux kernel release. Its live networking mode comes
from `wslinfo --networking-mode`; `.wslconfig` is reported separately because a
saved setting may not yet be active. The Windows profile path is read using
`cmd.exe /d /c echo %USERPROFILE%`, converted using `wslpath`, then the optional
`.wslconfig` is read. `powershell.exe` checks interop availability;
`netsh.exe interface portproxy show all` supplies forwarding rules. Missing
interop leaves Linux diagnostics available, with an explicit partial reason.
Native Linux never invokes Windows tools. Windows and macOS hosts are identified,
but listener collection on those hosts is currently unsupported and reported as
partial; they are not mistaken for empty, healthy Linux snapshots.

### Findings and suggestions

- `dead-proxy`: a current local destination has no matching listener. Remove the
  obsolete forwarding rule or start the intended application.
- `stale-wsl-address`: a NAT forwarding destination differs from all current WSL
  addresses. This is a suspected stale rule; it may intentionally target another
  host. Review before removing it.
- `missing-proxy`: an IPv4 wildcard listener in NAT mode has no rule targeting its
  current WSL address. Review a forwarding rule bound to a specific Windows LAN
  address. This is a configuration heuristic, not an end-to-end reachability
  test; external routers, firewalls and other forwarding mechanisms are unknown.
- `loopback-only`: informational finding for `127.0.0.1` / `::1` listeners.
- `unsafe-debug-proxy`: a wildcard Windows forwarding rule exposes a known debug
  source or destination port (9222, 9229, 9230, 5858 or 6006). The suggestion removes that rule. Debug
  ports must remain restricted to loopback; no wildcard forwarding is suggested.
- `recommend-mirrored`: in NAT mode, consider `networkingMode=mirrored` in the
  `[wsl2]` section of `.wslconfig` on supported Windows/WSL versions. The suggested
  Hyper-V commands keep default inbound traffic blocked and add a TCP exception
  for Cretli's default port 3011; adjust that port to your configuration. These
  commands need an administrator PowerShell. `wsl --shutdown` applies the WSL
  setting but stops all distributions and can interrupt Docker workloads.

Unavailable probes suppress findings that need their evidence. Mirrored mode
does not produce NAT missing-rule or migration suggestions. Firewall reachability
is not tested, and the report does not claim that a port is reachable from LAN.
For example, fixture addresses `192.0.2.2` (WSL) and `198.51.100.2` (Windows LAN)
are documentation addresses, not values to use on a real host.

## Apps

A workspace can describe its long-running applications in `.cretli/apps.json`
inside the workspace folder. An app is an existing task run plus port metadata;
Cretli does not add a second process manager. It starts and stops only the runs
it started itself for that app.

### File schema

```json
{
  "version": 1,
  "apps": [
    {
      "id": "my-app",
      "name": "My app",
      "start": { "taskLabel": "Serve my-app" },
      "ports": [
        { "port": 5173, "bind": "127.0.0.1", "role": "http", "healthPath": "/" },
        { "port": 8080, "bind": "127.0.0.1", "role": "api", "healthPath": "/healthz" }
      ],
      "exposure": "local",
      "autoStart": true,
      "notes": "Example only; replace the ports with your own."
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | 1-64 characters (letters, digits, `.`, `_`, `-`), unique in the file |
| `name` | Display name |
| `start` | Exactly one form: `{ "taskLabel": "<label from .vscode/tasks.json>" }` or `{ "command", "args"?, "cwd"?, "env"? }`. `cwd` must be relative and stay inside the workspace folder (absolute paths, `..` escapes and symlinks leaving it are rejected). Without `args`, `command` runs through the shell |
| `ports[]` | `{ port (1-65535, unique across all apps), bind (default 127.0.0.1; an IP address, `localhost` or `*`), role: http|api|db|other (default other), healthPath? }`. `healthPath` must start with a single `/` (no whitespace, backslash or `#`). Health probes only connect to loopback (wildcards probe 127.0.0.1 / ::1) or to an address of a local network interface; anything else is skipped |
| `exposure` | `local` (default) or `lan`; the monitor warns when the real bind address contradicts it |
| `autoStart` | Optional. Marks an app that is expected to keep running: an unexpected exit raises a notification. Cretli does not start it on boot |
| `notes` | Optional free text |

A missing file is an empty registry. A file that is not valid JSON or does not
match the schema never affects the server: the API answers `400` with
`error: "apps-file-invalid"` and an `errors` array of readable messages.

### Runtime state

`data/apps-state.json` (registered as `store.apps-state`) keeps per app the
`appId -> runId` mapping of the active task run, its PID, the last status and an
error history (last 20 entries). The definition file is never written by the
monitor.

### API

All routes require a Cretli login session.

| Route | Purpose |
| --- | --- |
| `GET /api/apps` | Validated definitions of the current workspace |
| `PUT /api/apps` | Replace all definitions (`{ "apps": [...] }`); validated before writing |
| `POST /api/apps` | Append one definition (`{ "app": {...} }`), e.g. accepting a suggestion or orphan. Writes the definition only |
| `GET /api/apps/status` | Cached monitor report; `?refresh=1` takes a fresh listener snapshot |
| `GET /api/apps/suggestions` | Read-only proposals (see below) |
| `POST /api/apps/:id/start` | Start as a task run; `409 port-in-use` (with `conflicts`) when a declared port is held by another process; `409 app-already-running` |
| `POST /api/apps/:id/stop` | Stop only the run stored for this app; `409 app-not-running` and nothing stopped when there is none |
| `POST /api/apps/:id/restart` | Stop (if running), wait for exit, start again |

Starts create a normal task run, so the run appears in `GET /api/task-runs` and
can be opened over `/ws-task`. A task run started any other way is never stopped
by `POST /api/apps/:id/stop`, whichever app id is used. The existing
`DELETE /api/task-runs/:runId` route is unchanged.

### Monitoring

A periodic job (`apps_monitor`, on the shared periodic job runner) takes one
`ss -ltnpH` snapshot per tick, reusing the stage-1 parser, and evaluates every
workspace that has state plus the current one. The interval is
`CRETLI_APPS_MONITOR_INTERVAL_MS` (default 5000, minimum 1000), read at boot.
For each declared port the status reports whether it is listening, the owning
PID and command, whether that PID belongs to the app's own task run (process
tree walk through `/proc`; otherwise `ownedBy: "foreign"`), and for ports with
`healthPath` an HTTP probe (`code`, `latencyMs`, 2 s timeout). State changes are
pushed as `{ "type": "appsChanged" }` frames on the global chat-list WebSocket.
When an app with `autoStart` loses its run unexpectedly, a notification is
published (category `system`, severity `error`).

### Orphans and suggestions

`orphans` in the status report are listening ports not declared by any app:
`port`, `bind`, `pid`, `command` and a `killHint` string such as `kill 1234`.
They are read-only. Cretli has no API or tool that signals a foreign process;
the hint is text for you to copy. "Add as app" is `POST /api/apps` with a
definition you review.

`GET /api/apps/suggestions` proposes definitions from tasks in
`.vscode/tasks.json`, `package.json` scripts (`dev`, `start`, `serve`, `preview`,
`watch`) and the host side of `ports:` in `docker-compose*.yml` /
`compose*.yaml`. Nothing is written until you add one.

## Exposure

The exposure layer opens a port to the local network (LAN) and keeps a record of
everything it opened. It lives in `lib/port-exposure/` and is exposed through
`GET /api/port-exposures`, `POST /api/port-exposures` (`{ port, reason?, ttlMs?,
owner? }`) and `DELETE /api/port-exposures/:port`. All routes require a Cretli
login session; widget and MCP integration tokens are refused. The same service
layer will back the future MCP tools, so every rule below is enforced on the
server regardless of the caller.

### Backends

The backend is chosen automatically from the `GET /api/net-env` report and can
be overridden with `portExposure.backend` in `data/config.json`.

| Backend | When | What it does |
| --- | --- | --- |
| `wsl-nat` | WSL2, NAT networking | `portproxy v4tov4 0.0.0.0:P -> <WSL IP>:P` plus a firewall rule |
| `wsl-mirrored` | WSL2, mirrored networking | A per-port Hyper-V firewall rule only |
| `linux` | Native Linux | Nothing by default; a command is suggested when ufw or firewalld is active |
| `manual` | Anything else | Returns the ready command |

Changes on Windows are made by an executor: the Windows helper described in
[Windows helper](#windows-helper). Without it (or when it fails) the WSL backends behave like `manual`: the response carries the
commands and the entry stays `pending_manual` until diagnostics (the portproxy
list in the net-env report) confirm the rule, then it becomes `active`.

Every firewall rule is TCP, that one port, `-Profile Private,Domain` (never
Public) and `-RemoteAddress LocalSubnet`. For mirrored mode the response also
lists the `DefaultInboundAction Allow` switch under `alternatives`, flagged
`broader: true`, because it opens every port to WSL.

### Ledger

Entries live in `data/port-exposures.json` (`store.port-exposures`):
`{ port, backend, owner, createdBy, reason, createdAt, expiresAt, state }` with
`owner` one of `user`, `chat:<id>`, `app:<id>`. States: `pending_manual`,
`active`, `drift`, `close_pending`, `closed`. Closed entries are kept (last 100) with `closedAt`,
`closedBy` and `closeReason`, so every close names its actor (`user`,
`chat:<id>`, `system:ttl`, `system:app-stop:<id>`).

`close` and `reconcile` only ever act on rules confirmed by a ledger entry.
Closing a port that is not in the ledger returns `404 not-in-ledger`.

When Cretli cannot remove the rule itself (`manual`, or a WSL backend without the
helper), `DELETE` returns `closeState: "pending_manual"` with the removal commands
and the entry becomes `close_pending`: it stays in the ledger, still subject to
reconcile, and the requesting actor is kept. Reconcile marks it `closed` (recording
that actor) once diagnostics show the portproxy rule is gone. Calling `DELETE`
again refreshes the commands. Backends whose rules diagnostics cannot observe
(`wsl-mirrored`, `linux`) stay `close_pending` until an executor removes the rule.

### Closing and authorization

- The logged-in operator may close any ledger entry.
- An agent context may close only `owner = chat:<its own id>` (`403 close-forbidden` otherwise).
- An entry closes when its TTL elapses and when its owning app (`app:<id>`) stops or exits.

### Reconcile

Run at boot and every 30 seconds (`CRETLI_PORT_EXPOSURE_RECONCILE_INTERVAL_MS`,
minimum 5000). After a WSL IP change the portproxy rules of ledger entries are
rewritten; a missing rule is recreated, or the entry becomes `drift` when no
executor is available. Rules that are not in the ledger (manual, from
`scripts/wsl-port-forward.ps1`) are listed under `foreign` with a suggestion.
A foreign `0.0.0.0` rule on a denylisted port also carries
`warning: "foreign-denylisted-port"` and the removal command. Cretli never
removes it.

### Hard blocks

| Code | HTTP | Meaning |
| --- | --- | --- |
| `port-invalid` | 400 | Not an integer in 1-65535 |
| `port-denylisted` | 403 | Port is on the denylist (default 9222, 9229, 9230, 5858, 5037, 2375, 2376) |
| `port-out-of-range` | 403 | Outside the allowed range (default 3000-9999) |
| `port-loopback-only` | 409 | The app listens only on 127.0.0.1; change its bind address |

### Policy

The optional `portExposure` block in `data/config.json`:

```json
{ "portExposure": { "range": { "min": 3000, "max": 9999 }, "denylist": [4500],
  "defaultTtlMs": 28800000, "maxTtlMs": 604800000, "agentMode": "ask", "backend": "auto" } }
```

`denylist` extends the built-in list; the defaults cannot be removed. A
requested TTL above `maxTtlMs` is clamped. `agentMode`: `ask` (default; agents
get `403 agent-approval-required` and an operator decides), `allow_in_range`
(agents may expose in-range ports they own), `never`.

### Manual fallback script

`scripts/wsl-port-forward.ps1` (and the `.bat` wrapper) remains a manual
fallback. Its firewall rule is limited to `profile=private,domain
remoteip=localsubnet`, and it refuses the denylisted debug ports.

## Windows helper

`cretli-netd` is an optional elevated helper that lets the `wsl-nat` and
`wsl-mirrored` backends change Windows rules without a manual PowerShell
session, and repairs them when the WSL address changes. Any helper failure
(timeout, not installed, `helper_busy`, `server_untrusted`, `no_user_session`, a
validation error) makes the backend fall back to `manual`: the response carries
the commands and the entry stays `pending_manual`. Its status is reported as
`helper` in `GET /api/net-env`.

Sources are in `scripts/windows/`: `cretli-netd.ps1` (server),
`cretli-netctl.ps1` (client), `install-cretli-netd.ps1` and the shared
`cretli-netd-common.ps1`. `lib/port-exposure/netd-client.js` is the adapter and
`netd-protocol.js` mirrors the pure rules for tests.

### Processes and channel

- **Server:** a Scheduled Task running as `SYSTEM`, started at boot and at logon of
  the configured user, restarted 3 times at 1 minute intervals.
- **Client:** a short unprivileged process Cretli starts through WSL interop:
  `powershell.exe -NoProfile -NonInteractive -File C:\ProgramData\Cretli\netd\cretli-netctl.ps1 -Op <op> [-Port <n>]`
  (override the path with `CRETLI_NETD_CLIENT_PATH`). It validates its arguments,
  builds the JSON itself and prints one JSON line.
- **No network.** The only channel is the named pipe `\\.\pipe\cretli-netd`
  (remote clients rejected). In NAT mode WSL cannot reach the Windows loopback,
  and a listener on the vEthernet adapter would open the network.

### Protocol

One request per connection: a UTF-8 JSON line of at most 4 KiB, answered by one
line, then disconnect. Request `{ v: 1, id, op, port? }` with `op` one of `status`,
`list`, `expose`, `close`, `reconcile`; `port` only for `expose` and `close`. Any
other field (including an address) is an error. Response `{ v: 1, id, ok, code?, data? }`.
The pipe is a byte stream (`PIPE_TYPE_BYTE | PIPE_READMODE_BYTE`), single instance;
the client never changes the handle state. A busy pipe makes the client wait
(`WaitNamedPipe`) inside its 5 s connect budget, then answer `helper_busy`.
Timeouts: server read 5 s, client connect 5 s and response 30 s, Cretli 45 s.

Error codes: `too_large`, `bad_json`, `unknown_field`, `bad_request`, `bad_version`,
`unknown_op`, `bad_port`, `port_denylisted`, `port_out_of_range`, `client_untrusted`,
`not_in_state`, `port_in_use_foreign`, `no_user_session`, `wsl_unavailable`, `rate_limited`, `read_timeout`,
`internal`; client-side: `helper_unavailable`, `helper_busy`, `server_untrusted`,
`response_timeout`.

### Install

Run `install-cretli-netd.ps1` from an elevated PowerShell. It copies the scripts and
`config.json` (port range, denylist, user SID, WSL distribution, networking mode) to
`%ProgramData%\Cretli\netd`, writable only by Administrators and SYSTEM, and registers
the task. The trusted user is the owner of `explorer.exe` (the signed-in desktop
user, not the account that elevated); the installer shows it and asks for
confirmation. `-User DOMAIN\name` overrides it (also confirmed), `-Distro` selects the
distribution, `-Reinstall` replaces an existing install (the state is kept),
`-Uninstall` removes the task, the directory and **only the objects recorded in
`state.json`, and only while they still match the record** (see Operations); other
"Cretli" rules, such as the `Cretli <port>` ones from `scripts/wsl-port-forward.ps1`,
stay and are listed.
Changing the trusted user needs `-Reinstall`; there is no shared secret in `data/`.

### Operations

- A closed list of operations. `netsh` and firewall cmdlet arguments are built only
  from the validated integer port. The range and the denylist are enforced here too,
  independent of the Cretli server; the built-in denylist cannot be configured away.
- The target address comes from `wsl.exe -d <distro> hostname -I` run in the user's
  session (`CreateProcessAsUser`), never from a client. With nobody signed in the
  rules stay in place, and `expose` and `reconcile` answer `no_user_session`. Reconcile
  runs at logon (checked every 5 s until a session exists), then every 60 s.
- **Ownership is proven by the ledger.** For each exposed port `state.json` records
  the portproxy endpoint (`0.0.0.0`, connect address and port) and the exact
  firewall rule `Name` (unique per rule, `Cretli-netd-<port>-<id>`; the Hyper-V rule
  name in mirrored mode). `expose` first checks the port: a portproxy on
  `0.0.0.0:<port>` that the ledger does not record with the same values, or a firewall
  rule with the display name `Cretli netd <port>` whose `Name` the ledger does not
  record, is foreign and `expose` answers `port_in_use_foreign` without changing
  anything. `close`, `reconcile` and `-Uninstall` remove or rewrite only recorded
  objects, and a portproxy only while its current values still equal the record;
  otherwise it is left in place (`close` reports it in `data.kept`, reconcile skips
  it and audits `port_in_use_foreign`).
  A recorded firewall rule (Hyper-V rule included) is removed or replaced only while its
  live spec matches the complete rule spec in `scripts/windows/cretli-netd-rule-spec.json`
  and its identity token matches `state.json`. Standard rules carry the token in
  `Description`; Hyper-V rules carry it in their unique `Name`, because the Hyper-V
  rule object has no `Description` property. The standard rule spec includes
  interface, edge traversal, application, service and policy-store conditions; a rule
  under the same name with a different spec is foreign: `expose` answers
  `port_in_use_foreign`, `close` and `-Uninstall` leave it (`data.kept` / listed), and
  reconcile skips it.
- Firewall rules: TCP, the port, `-Profile Private,Domain` (never Public),
  `-RemoteAddress LocalSubnet`; the same for the Hyper-V rule in mirrored mode.
- Audit: `%ProgramData%\Cretli\netd\audit.log`, rotated at 256 KiB, plus a rate
  limit of 60 requests per minute.

### Threat model

The helper is an elevated process that accepts instructions, so the pipe is the
attack surface.

- **Who may talk to the server.** The pipe DACL gives SYSTEM full control, the
  configured user exactly `0x00120083` (`FILE_READ_DATA | FILE_WRITE_DATA |
  FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE`; no `FILE_APPEND_DATA`, which is
  `FILE_CREATE_PIPE_INSTANCE`, no `WRITE_DAC`, no `WRITE_OWNER`, no generic bits), and
  denies `NETWORK`. Everyone and Users get nothing. The owner is set to SYSTEM
  explicitly. `FILE_FLAG_FIRST_PIPE_INSTANCE`, `nMaxInstances = 1` and
  `PIPE_REJECT_REMOTE_CLIENTS` mean nobody can add a competing instance while the
  helper runs. The server also checks the client process token against the
  configured SID (`client_untrusted`). Another local account is stopped by the DACL.
- **Who the client talks to.** Before sending anything the client reads the owner of
  the pipe object from the same handle it will write to (`GetSecurityInfo`), which
  must be `S-1-5-18` or `S-1-5-32-544`; an ordinary user cannot create an object
  with such an owner. That is the trust boundary. The server image
  (`...\System32\WindowsPowerShell\v1.0\powershell.exe`) is checked as an extra
  hint only: it cannot tell this helper from another PowerShell running as SYSTEM.
  Any failed call or mismatch is `server_untrusted` and nothing is sent. The client
  opens the pipe with identification-level impersonation only.
- **Residual risk.** Anyone who is already an administrator or SYSTEM can impersonate
  the helper or edit its files; that is outside the model. A process running as the
  trusted user can ask the helper to expose a port in the configured range that is not
  denylisted, nothing more: no commands, addresses or ports outside the policy.
  If the trusted user changes, reinstall.
- **Blast radius of a request.** One TCP port, Private and Domain profiles, local
  subnet only, forwarded to the WSL address the helper discovered itself.

### Manual verification on Windows

CI cannot run the pipe, `netsh` or the Scheduled Task, so closing this stage needs a
manual run on a Windows machine with WSL2 and a record of the result.

1. **Install and confirm.** Run `install-cretli-netd.ps1` elevated; check that it names the signed-in user and waits for `yes`.
2. **ACLs.** `Get-Acl "$env:ProgramData\Cretli\netd" | Format-List` shows write only for Administrators and SYSTEM. For the pipe use `accesschk.exe -lq \\.\pipe\cretli-netd` (Sysinternals) or `[System.IO.Directory]::GetFiles('\\.\pipe\')` plus `Get-Acl \\.\pipe\cretli-netd`: the owner is `NT AUTHORITY\SYSTEM`, the user has the read/write mask above, NETWORK is denied.
3. **Status, expose, phone.** As an ordinary user run `powershell.exe -NoProfile -File "$env:ProgramData\Cretli\netd\cretli-netctl.ps1" -Op status` (one JSON line, `ok: true`). Expose an in-range port from the Network panel and open `http://<pc-lan-ip>:<port>` from a phone on the same Wi-Fi.
   After exposure, run `Get-NetFirewallRule -Name 'Cretli netd <port>' | Format-List PolicyStoreSource,PolicyStoreSourceType,EdgeTraversalPolicy` (use the recorded rule name if it differs from the display name). Confirm `PolicyStoreSource` is `PersistentStore`, `PolicyStoreSourceType` is `Local`, and close/reconcile recognise the rule as owned.
4. **WSL restart.** `wsl --shutdown`, start WSL and the app again; within about a minute the rule follows the new WSL address and the phone connects again.
5. **Another account.** Run the client from a different local account: `client_untrusted`.
6. **Helper stopped.** `Stop-ScheduledTask 'Cretli netd'`, then, as the ordinary user, create a pipe named `cretli-netd` yourself (for example with `New-Object System.IO.Pipes.NamedPipeServerStream('cretli-netd')`) and run the client: `server_untrusted`, and the pipe received no request.
7. **Second instance.** With the helper running, creating `\\.\pipe\cretli-netd` again fails with access denied.
8. **Logout.** Sign out: the rules stay. Trigger `-Op expose -Port <port>` through a remote session or the task: `no_user_session`.
9. **Uninstall and foreign objects.** Create a foreign rule (`New-NetFirewallRule -DisplayName "Cretli 3011" ...`) and a foreign proxy (`netsh interface portproxy add v4tov4 listenport=4100 listenaddress=0.0.0.0 connectport=4100 connectaddress=127.0.0.1`). Expose port 4100 from Cretli: `port_in_use_foreign`, the proxy is untouched. Then run `install-cretli-netd.ps1 -Uninstall`: the helper's own rules are gone, the foreign rule is listed and still present, and so is the foreign proxy. Also check that `wsl.exe hostname -I` resolves (expose does not return `wsl_unavailable`) with a signed-in user.

Record the Windows build, the WSL version and the result of each step in the review.
