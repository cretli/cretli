# Install Cretli (Linux, macOS, WSL, Termux)

Node.js **22.18+** is required, and the storage gate needs bundled SQLite >= 3.51.0 (seen on Node 22.23.2 and 24.14; a lower 22.x patch may bundle an older SQLite and then fail with `unsupported_runtime` once the check is wired in). Windows native PowerShell PTY is **not** supported;
on Windows use **WSL2**.

## Linux

```bash
git clone https://github.com/cretli/cretli.git
cd cretli
npm install
npm run build:front:prod
npm start
```

Open `https://localhost:3011`. If you need LAN from a phone:

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
npm run start:lan
# set CRETLI_LAN_HOST to this machine's LAN IP
```

Allow the port if needed: `sudo ufw allow 3011`.

### Phone / LAN access without a forwarder

`CRETLI_BIND` takes one address or a comma-separated list. To keep localhost and
add one LAN address, list both (the addresses below are documentation examples):

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"   # until a password exists
CRETLI_BIND=127.0.0.1,192.0.2.10 CRETLI_LAN_HOST=192.0.2.10 npm start
# then open https://192.0.2.10:3011 (or https://your-pc:3011) on the phone
```

Cretli listens on every listed address (HTTPS and WebSocket) and applies the LAN
guard (a password or `CRETLI_SETUP_TOKEN`) as soon as one address is not
localhost. A single address and `0.0.0.0` behave as before. No `socat` relay is
needed.

If a configured LAN address stops accepting connections (the server is up on
localhost, but phones see "server unavailable"), `/api/health` adds
`lanUnreachable` to `load.alarms` and lists the addresses in `load.lan`.
Settings → Workspace Watcher → Server load shows a "LAN access" row, and
`scripts/log-health-scan.mjs` prints a `lanUnreachable:` line. The probe is a TCP
connect to each configured non-loopback address; `0.0.0.0` has no single address
and is not probed.

## macOS

Same as Linux (Homebrew Node 22 is fine). `node-pty` needs Xcode CLT
(`xcode-select --install`) if npm has to compile it.

For LAN, grant the Node binary incoming connections in the firewall dialog, then
`npm run start:lan` with `CRETLI_SETUP_TOKEN` until a password exists.

## Windows (WSL2)

1. Clone and run inside WSL (Debian/Ubuntu).
2. Windows and WSL have separate networks — forward the port from Windows to WSL.
   In PowerShell **as Administrator**:

```powershell
cd \\wsl$\Debian\home\<you>\path\to\cretli\scripts
.\wsl-port-forward.ps1
```

After a WSL restart the WSL IP may change — re-run the script. Set `CRETLI_LAN_HOST`
to the **Windows** LAN IP so the in-app QR is correct.

`npm start` listens on `127.0.0.1` only. The portproxy rule above connects to
the WSL eth address, so a Windows browser gets `ERR_CONNECTION_RESET` until
you either `npm run start:lan` or forward that address to `127.0.0.1`.
Decision tree: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Termux (Android) — server on the phone

Termux is **not** glibc Linux: Node reports `android-arm64`, so native `sharp`
binaries are missing and `node-pty` must compile from source. The phone browser
can still reach a Termux process on `127.0.0.1`.

**Node version:** Cretli needs Node >= 22.18 (`engines.node`) because the server loads
`.ts` modules through native type stripping, with no build step. CI runs on Node 22.18+ and
cannot verify Termux, so check `node -v` yourself after `pkg install nodejs`; if the
packaged Node is older, install a newer one (for example `pkg install nodejs-lts` or a
`proot-distro` Linux guest) before `npm run start:termux`.

```bash
pkg update
pkg install git nodejs python make clang pkg-config openssl
# optional: pin LTS instead of current Node (Termux may ship Node 26)
# pkg install nodejs-lts
node -v   # must be >= 22.18 (see the note below)
git clone https://github.com/cretli/cretli.git
cd cretli
npm install
npm rebuild node-pty
npm run build:front:prod
npm run start:termux
```

On the **same phone**, open Chrome or Firefox at **https://127.0.0.1:3011**
(or `https://localhost:3011`). Accept the self-signed warning
(Advanced → Proceed). First run sets the access password at `/login`.
If the log falls back to HTTP, `pkg install openssl`, then start again.

`start:termux` serves the production build (no dev watcher — Watchpack cannot watch
`/` / `/data` on Android) and turns on a CPU wake-lock when
[Termux:API](https://wiki.termux.com/wiki/Termux:API) is installed
(`pkg install termux-api`). Release it later with `termux-wake-unlock`.
Without it, Android may freeze the process when Termux is in the background.

`@img/sharp-wasm32` is an optional dependency so image tools work without
libvips. If WASM still fails, PWA icon/screenshot generation is skipped and
the SPA build continues; screenshot upload in chat will return 503.

`node-pty` is required for the in-app terminal. If start throws
`Cannot find module 'node-pty'`, install the packages above and re-run
`npm rebuild node-pty`.

Chat on a phone is realistic with **OpenRouter** (API key in Settings).
OpenCode is heavy. Cursor SDK usually is not available on Termux.

The built-in Browser is **not supported on Termux**: server-side Chromium cannot run as
an Android host, so `/api/browser/status` reports `unsupported-platform` (not a missing
install) and the Browser panel stays off. Everything else works; use the phone's own
browser, or the widget `page_*` tools for page interaction. Details:
[browser-runtime.md](browser-runtime.md).

### Updating an existing Termux clone

Public `master` is rewritten as a single orphan commit. `git pull` cannot
reconcile that and will leave you on the old tree (`start:termux` missing,
native `sharp` crash). Reset to the public tip (`data/` stays — it is gitignored):

```bash
cd ~/projects/cretli   # or your clone path
git fetch origin
git reset --hard origin/master
npm install
npm rebuild node-pty
npm run build:front:prod
npm run start:termux
```

### LAN from another device to this phone

Same Wi-Fi, then bind all interfaces. Set a setup token **before** the first LAN start
if no password exists yet:

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
echo "Setup token: $CRETLI_SETUP_TOKEN"
LAN_IP="$(ip -4 addr show wlan0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1)"
echo "Phone LAN IP: $LAN_IP"
rm -f data/key.pem data/cert.pem
SSL_IP="$LAN_IP" node scripts/generate-ssl-cert.js
CRETLI_LAN_HOST="$LAN_IP" npm run start:termux:lan
```

On the other device open `https://<LAN_IP>:3011`. Android may still block
incoming Wi-Fi; if it does, stay on `npm run start:termux` and use the phone browser.

## HTTPS cert for a phone

```bash
npm run gen-cert
# or set SSL_IP to your LAN address, then: node scripts/generate-ssl-cert.js
```

Accept the self-signed warning in the phone browser.

If `USE_HTTPS=1` (default for `npm start`) and `data/key.pem` / `data/cert.pem` are missing
or invalid, the server **exits** with an error instead of falling back to HTTP. Generate
certs with `npm run gen-cert` or set `USE_HTTPS=0 npm start` for local HTTP only.
Custom `SSL_KEY_PATH` / `SSL_CERT_PATH` are not replaced by generated `data/` certs.

For trusted HTTPS on a local network, see [Trusted HTTPS with local DNS](trusted-https.md).

When Cretli sits behind a reverse proxy, set `CRETLI_PUBLIC_ORIGIN` to the public
browser origin of Cretli itself (full `https://host:port`). That origin is used to
recognize the Cretli iframe when Node still sees HTTP. Additional authenticated
browser Origins go in `CRETLI_EXTRA_WS_ORIGINS` (full `https://host:port` values);
those extras are **not** treated as the Cretli iframe. Forwarded host headers alone
do not grant WebSocket access. Widget access tokens, active installations, and chat
scope checks still apply.

`npm start` loads `.env` without executing it. Explicit process environment variables
override `.env`; remaining HTTPS defaults are `USE_HTTPS=1`. Values such as
`USE_HTTPS=0`, `CRETLI_DATA_DIR`, and custom `SSL_KEY_PATH` / `SSL_CERT_PATH` can
live only in `.env` and still apply to certificate generation and the server.

## Docker

`restart: unless-stopped` restarts exited containers but does not detect hangs; container hang detection is tracked separately in todo `175e216e-0a49-4579-ba7a-662351d58788`.

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
echo "Setup token: $CRETLI_SETUP_TOKEN"
docker compose up --build
```

The compose file publishes `127.0.0.1:3011` on the host. To reach it from another
device, put a reverse proxy or VPN in front — do not publish `0.0.0.0:3011` to the
internet.

Volume `./data` stores password, chats, and certs. Never commit it.

The shipped image has **no Chromium**, and Cretli runs there as root, so the built-in
Browser is off by default in Docker: `/api/browser/status` reports `browser-unavailable`
and, once a binary is added, a root `sandboxWarning`. To enable it, add a browser to the
image and choose between a non-root container and an explicit
`CRETLI_BROWSER_ALLOW_NO_SANDBOX=1`: [browser-runtime.md](browser-runtime.md).

## Chat without Cursor

Terminal works immediately. For chat, pick OpenCode or OpenRouter in Settings → Harness
(see the README “Chat backends” section). `@cursor/sdk` is optional.

## Agent process environment (opt-in hardening)

By default harness child processes inherit the full server environment. Set
`CRETLI_AGENT_ENV_ALLOWLIST=1` to give them an allowlisted environment instead (no
`GITHUB_TOKEN`, `CRETLI_*` or other providers' API keys). Details and the per-harness
variable table: [agent-env-allowlist.md](agent-env-allowlist.md).

## Optional autostart with supervision

From the checkout, preview the generated entry and commands first:

```bash
node scripts/cretli-autostart.mjs status
node scripts/cretli-autostart.mjs install
node scripts/cretli-autostart.mjs install --apply
node scripts/cretli-autostart.mjs uninstall --apply
```

Changes require `--apply`. Installation activates at the next boot or login;
add `--start` explicitly to start now. If the configured loopback port responds,
installation does not start anything, even with `--start`. Uninstall removes
only entries carrying the Cretli marker and never stops a running server or
supervisor. Foreign entries are refused. Reinstalling identical content does
not rewrite the file. No command uses `sudo`; generated entries contain paths,
not credentials. Run this as your regular user. Move the checkout or Node
installation only after uninstalling, then install again from the new location.
All entries use the absolute Node executable and a PATH containing its directory,
including for the server wrapper; no login shell or nvm initialization is needed.
The reusable adapter interface is `createAutostart` in `lib/autostart/index.js`.

### Linux with user systemd

The installer writes `~/.config/systemd/user/cretli.service` and enables it
without starting it. A working `systemctl --user` session is required. By default
it starts after login. `install --apply --linger` explicitly requests
`loginctl enable-linger` for the current user, allowing startup without login;
system policy can refuse this request. Linger is never enabled implicitly, and
uninstall does not change it because other user services may depend on it.
A pre-existing unmarked `cretli.service`, including a copy of the manual example,
must be moved aside by its owner before installation.

To stop supervision and the server, use `systemctl --user stop cretli.service`.
Uninstall disables autostart and removes the unit file, but active supervision
continues until logout (unless linger keeps the user manager running) or reboot.
Removing the unit file and running daemon-reload do not stop an active unit;
use the stop command above to end supervision now. An external SIGTERM to the
supervisor alone makes systemd restart it.
`CRETLI_DATA_DIR` is included only when set at installation; other server routing
settings are read by the supervisor from the checkout's `.env`.

### macOS LaunchAgent

The installer writes `~/Library/LaunchAgents/com.cretli.supervisor.plist` with
`KeepAlive` and `RunAtLoad`. It loads at the next login, or explicitly with
`install --apply --start`. Uninstall removes the plist but does not unload an
already loaded job: KeepAlive continues supervision until logout or reboot.
To stop it now, even after removing the plist, use
`launchctl bootout gui/$(id -u)/com.cretli.supervisor` (the CLI prints the exact
numeric user ID in this command). Uninstall never runs bootout or stops the server.
An external SIGTERM alone makes launchd restart the supervisor.

### WSL2

The installer resolves Windows `%APPDATA%` and writes `cretli.vbs` in the current
user's `Microsoft/Windows/Start Menu/Programs/Startup` folder. It invokes
`wsl.exe -d <distro> --cd <checkout> --exec` with the absolute Node executable,
PATH and supervisor command, without a console window or administrator rights.
Systemd is not required. Activation is at Windows login, or explicit `--start`.
WSL does not restart the supervisor itself if it crashes; SIGTERM to the
supervisor stops supervision and the server. The running supervisor keeps its
WSL distribution alive. Removing the Startup entry does not stop it: the running
supervisor continues until it receives SIGTERM or the session ends. Native Windows
without WSL is unsupported.

### Termux

Install Termux:Boot and open it once. The installer writes `~/.termux/boot/cretli`
and warns if the Boot package is missing or cannot be verified. The entry takes
a `termux-wake-lock` when available. Reboot (with Termux:Boot enabled), or use
explicit `--start`. Termux does not restart the supervisor itself if it crashes;
SIGTERM to the supervisor stops supervision and the server. If you no longer
need a wake lock, release it separately with `termux-wake-unlock`. Removing the
boot entry does not stop the running supervisor: it continues until it receives
SIGTERM or the session ends.

Real boot/login behavior must be checked on the target platform. Unsupported
platforms, including Linux without a working user systemd, return a clear status
without creating files. See [server diagnostics](server-diagnostics.md) for the
supervisor contract and shutdown behavior.
