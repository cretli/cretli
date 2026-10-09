# Troubleshooting — page does not load

Use this when the browser shows `ERR_CONNECTION_RESET`, `ERR_CONNECTION_CLOSED`,
or the Cretli shell with **Cretli server is unavailable** / **Cretli could not start**.

A webpack error is not this. Webpack still answers HTTP (a 500 or an overlay).
A reset means TCP or TLS never finished.

Check the two hops separately. A green check inside WSL does not mean Windows
can open the page.

## 1. Is the process listening inside WSL?

```bash
ss -ltnp | grep ':3011'
curl -sk --max-time 5 -o /dev/null -w '%{http_code}\n' https://127.0.0.1:3011/api/health
```

| Result | Meaning |
| --- | --- |
| Nothing on `127.0.0.1:3011` | The Node process is gone. Start it again (`npm start`). |
| `curl` prints `200` | The server is up. If the browser still fails, go to step 2. |

Log hints in the server output:

- `[cretli] SIGTERM` — clean shutdown. The port is free until something starts it again.
- Exit code **137** — `SIGKILL` (the process was killed from outside). Same fix: start again.
- `EADDRINUSE` — something else already holds 3011. Do not start a second copy.

From a Cursor agent, start **outside the sandbox** (`required_permissions: ["all"]`)
and leave the process running (`block_until_ms: 0`). Inside the sandbox the
process can look started while port 3011 is invisible.

## 2. Can Windows reach that port?

The IDE browser and `curl.exe` run on Windows, not inside WSL.

```bash
curl.exe -sk --max-time 8 -o /dev/null -w '%{http_code}\n' https://127.0.0.1:3011/api/health
```

`000` plus `Recv failure: Connection was reset` means Windows never talked to
the Node process.

On Windows, port **3011** is often taken by `iphlpsvc` (`svchost`) because of
`netsh interface portproxy`. That rule comes from `scripts/wsl-port-forward.ps1`.
It forwards Windows `0.0.0.0:3011` to the **WSL eth address**, port 3011.

`npm start` binds **only** `127.0.0.1`. The WSL eth address has no listener, so
portproxy connects and the handshake is reset. A throwaway port with no
portproxy rule can still work through the WSL localhost relay — that does not
prove 3011 is fine.

```powershell
netsh interface portproxy show all
```

If `3011` connects to the WSL IP, pick one of these:

**Bind on all interfaces** (LAN path, documented in `docs/INSTALL.md`):

```bash
npm run start:lan
```

Node then accepts the portproxy connection. A password must already exist, or
set `CRETLI_SETUP_TOKEN` first. `lanExposed` becomes true.

**Keep the loopback bind** (Node still sees only `127.0.0.1`, so `lanExposed`
stays false). Listen on the WSL IP and forward:

```bash
WSL_IP="$(hostname -I | awk '{print $1}')"
socat TCP-LISTEN:3011,bind="${WSL_IP}",reuseaddr,fork TCP:127.0.0.1:3011
```

After a WSL restart the eth address usually changes. Re-run
`scripts/wsl-port-forward.ps1` as Administrator and point `socat` at the new
address (`wsl.exe hostname -I`).

## 3. Shell on screen, API dead

`public/sw.js` can paint the cached app shell while the network is down.
Then:

- `GET /api/auth-status` fails → overlay **Cretli server is unavailable**
- boot never sets `window.__crAppBooted` → **Cretli could not start**

That is the same break as step 2, not a bad bundle. After the port works,
reload. **Clear cache and reload** only if the shell is stale and health
already returns `200`.

## 4. Find why the process stopped

Inspect `data/server-diagnostics-YYYY-MM-DD.jsonl` for memory and swap samples
before the outage. The authenticated `GET /api/diagnostics/server` endpoint
returns the current snapshot and recent records. An abrupt gap without a
`process-exit` event is consistent with a forced kill or host interruption,
but can also mean diagnostics could not be written or the daily file reached
its 4 MiB cap. Error events are rate-limited to one record per minute. Use the
process manager journal to distinguish those cases. See
[Server diagnostics and automatic restart](server-diagnostics.md) for setup.

## 5. Memory pressure: earlyoom killed the server

A machine-level safety net runs before the killer does: the read-only
`scripts/memory-orphan-monitor.js` (systemd timer or cron, ~1 minute) alarms on
low `MemAvailable`, swap pressure, orphaned OpenCode processes and other
thresholds, and the server surfaces those alarms in the notification centre.
Set it up from `systemd/cretli-memory-monitor.*.example`; see
[Server diagnostics](server-diagnostics.md#memory-and-orphan-monitor-machine-level-safety-net).

When the host runs [`earlyoom`](https://github.com/rfjakob/earlyoom), the server
can be the first victim. A Node process is often one of the largest RSS
consumers, and a `--prefer` regex such as the default `^(node|...)` gives it a
large score bonus, so the killer picks the server over short-lived children. The
result looks like step 4: the process dies without a `process-exit` event.

**Generic guidance (not machine-specific).** On a host that runs agent
harnesses and a frontend watcher, prefer the short-lived children over the
long-running server:

```text
--prefer ^(node|opencode|chrom|webpack|claude|codex|dsh|qwen|codebuddy|cretli-mcp)
```

`claude`, `codex`, `dsh` (DeepSeek), `qwen` and `codebuddy` are the harness CLI
names the server currently spawns; `chrom` covers Chromium. The server also owns
every long-lived child in `data/child-processes.json` and reclaims orphans on the
next start (see §6), so a hard kill of one of them is recoverable.

Keep the memory threshold at its normal value (`10%` for the default
two-threshold setup) and keep `--avoid` for the processes that must never be
killed. **Do not add `cretli` to `--avoid`** — the server renames its own
process early (`process.title = 'cretli'` in `server.js`), so `/proc/<pid>/comm`
is `cretli` and no longer matches `^(node|...)`. Renaming is the mechanism that
takes the server out of the preference match; `--avoid` is not needed.

**Conscious cost of this choice.** A preferred regex can kill an active agent
harness before the server. That is intended: a killed harness ends its run with
a visible error and the chat can be resumed by sending the prompt again, while a
killed server drops every connected session at once. If killing a harness run is
unacceptable, prefer only the disposable watchers (`webpack`) and leave harnesses
out — at the price of the server being a likelier victim under pressure.

The earlyoom flags live outside this repository. Apply them to the host service
(for example `earlyoom` flags in `/etc/default/earlyoom` on Debian/Ubuntu) and
restart that service. Cretli does not manage or restart it.

## 6. Shutdown order: OpenCode and owned children are stopped first

`SIGTERM`/`SIGINT` (and the production fatal paths, plus an HTTP server error
before `listen`) run the shutdown handler in two phases:

1. **Synchronous phase, never awaited.** Stop admitting work — new chat runs and
   delegations are refused (`beginServerShutdown`, `beginDelegationShutdown`) —
   then adopt the classified harness descendants and block/SIGTERM every owned
   process: OpenCode instances and booting children (`beginOpenCodeShutdown`) plus
   PTYs, MCP stdio, review-verify runners and harness CLI children from the child
   registry (`registerServerDescendants` + `beginChildProcessShutdown`). The
   detached restart helper is never signalled.
2. **Bounded phase.** Wait up to ~1.2 s for the OpenCode SIGTERMs and ~0.8 s for
   the child registry, escalate the survivors to SIGKILL, wait ~0.4 s each to
   confirm and persist the result (`finishOpenCodeShutdown`,
   `finishChildProcessShutdown`). Only then is the browser closed and the
   delegation runtime flushed.

If the handler never runs (`SIGKILL`, earlyoom's hard kill), the next start
reclaims the orphans: `data/opencode-ports.json` for OpenCode and
`data/child-processes.json` for everything else. Both sweeps only signal PIDs
recorded with a live owner check and a `/proc/<pid>/stat` start-time match, so a
recycled PID is never killed; the restart helper is skipped by cmdline.

**Conscious cost.** Signalling OpenCode first cuts chats and delegations that are
in flight. That is intended: under earlyoom or a restart those runs cannot finish
anyway, and the useful outcomes are freeing ~250 MB per instance immediately and
recording the runs as interrupted, not draining them. The deliberate exception is
developer quality of life in dev: a non-production `uncaughtException` /
`unhandledRejection` only logs and records, it does not run this cleanup, so one
rejected promise never kills live chats.

`scripts/task-restart-server.sh` kills the old server and waits 5 s before a hard
`kill -9`. That window is kept above the worst-case OpenCode escalation budget
(booting child: 1.2 s pending wait + 1.2 s SIGTERM grace + 0.4 s SIGKILL confirm)
plus the child-process phase (0.8 s SIGTERM grace + 0.4 s SIGKILL confirm = 1.2 s),
about 4.0 s in total, so both phases and their escalations always finish before the
hard kill. Lowering the `sleep` there without lowering the manager constants, or
the reverse, would silently orphan OpenCode and harness/PTY processes.

