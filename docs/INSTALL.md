# Install Cretli (Linux, macOS, WSL)

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

## HTTPS cert for a phone

```bash
npm run gen-cert
# or: SSL_IP=192.168.1.10 node scripts/generate-ssl-cert.js
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
