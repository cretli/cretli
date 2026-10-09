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
