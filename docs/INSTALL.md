# Install Cretli (Linux, macOS, WSL, Termux)

Node.js **22.13+** is required. Windows native PowerShell PTY is **not** supported;
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

## Termux (Android) — server on the phone

Termux is **not** glibc Linux: Node reports `android-arm64`, so native `sharp`
binaries are missing and `node-pty` must compile from source. The phone browser
can still reach a Termux process on `127.0.0.1`.

```bash
pkg update
pkg install git nodejs python make clang pkg-config openssl
# optional: pin LTS instead of current Node (Termux may ship Node 26)
# pkg install nodejs-lts
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

`start:termux` serves the production build (HMR off — Watchpack cannot watch
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

## Docker

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
echo "Setup token: $CRETLI_SETUP_TOKEN"
docker compose up --build
```

The compose file publishes `127.0.0.1:3011` on the host. To reach it from another
device, put a reverse proxy or VPN in front — do not publish `0.0.0.0:3011` to the
internet.

Volume `./data` stores password, chats, and certs. Never commit it.

## Chat without Cursor

Terminal works immediately. For chat, pick OpenCode or OpenRouter in Settings → Harness
(see the README “Chat backends” section). `@cursor/sdk` is optional.
