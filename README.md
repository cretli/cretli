# Cretli

Official website: [cretli.com](https://cretli.com)

[![CI](https://github.com/cretli/cretli/actions/workflows/ci.yml/badge.svg)](https://github.com/cretli/cretli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org)

Self-hosted PWA: a **terminal** and **agent chat** in the browser (phone or desktop),
talking to your own PC over HTTPS. Pick a chat backend — **OpenCode**, **OpenRouter**,
or **Cursor SDK**. Multiple devices can share the same session live.

> **Status:** early/experimental (`v0.2.0`). The server exposes a full shell — read
> [SECURITY.md](SECURITY.md) before putting it on a network.
>
> Cretli is **not affiliated with** Anysphere or Cursor. “Cursor” is a trademark of
> its respective owners. See [NOTICE](NOTICE).

![Cretli desktop](public/screenshots/desktop.png)

## How it works

- The server reads a `.code-workspace` file and knows its folders.
- **Terminal** — a PTY (`node-pty`) running your shell in the workspace CWD, rendered
  with xterm.js. One PTY per session; output is broadcast to every connected client.
- **Chat** — an agent in the same workspace, rendered as a rich HTML view (tool calls,
  markdown, plan/agent mode). Choose one harness per chat:
  - **OpenCode** — local `opencode serve` + Zen (or your OpenCode auth)
  - **OpenRouter** — OpenRouter API + server-side workspace tools
  - **Cursor SDK** — optional `@cursor/sdk` (Cursor API key + Cursor ToS)
- **Tasks / Files / Git / Todo** — VS Code tasks, workspace tree, git actions, lightweight todos.
- Same live view on every device: the in-app link/QR points at the LAN URL.

## Requirements

- Node.js 22.13+ (see `engines` in `package.json`)
- Chat needs **one** backend (see [Chat backends](#chat-backends) below). Terminal and
  files work with no API keys.

## Quick start

```bash
git clone https://github.com/cretli/cretli.git
cd cretli
npm install
npm run build:front:prod   # build the SPA into public/dist
npm start                  # binds 127.0.0.1, HTTPS
```

Open **https://localhost:3011**. On first run you will be redirected to **`/login`** to
set the access password.

Without HTTPS: `USE_HTTPS=0 npm start` → `http://localhost:3011`.

Docker (host port published to localhost only):

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
docker compose up --build
# then open https://localhost:3011 and paste CRETLI_SETUP_TOKEN on first-run setup
```

See [docs/INSTALL.md](docs/INSTALL.md) for Linux, macOS, WSL2, and LAN/HTTPS.

## Chat backends

Configure at least one path. Settings → Harness shows which backends are ready.

### A. OpenCode

1. Install the [OpenCode CLI](https://opencode.ai/) (or rely on the optional `opencode-ai` npm package).
2. Set `OPENCODE_API_KEY` (Zen) or run `opencode auth login` on the host — also available in Settings.
3. Create a chat with harness **OpenCode**. First run may take 1–2 minutes while `opencode serve` starts.

Details: [docs/opencode/SETUP.md](docs/opencode/SETUP.md).

### B. OpenRouter

1. Set `OPENROUTER_API_KEY` (or paste it in Settings → Harness).
2. Create a chat with harness **OpenRouter**.

### C. Cursor SDK (optional)

1. `npm install` already tries to install optional `@cursor/sdk`. If you skipped optional
   deps: `npm install @cursor/sdk`.
2. Set `CURSOR_API_KEY` (or Settings). Cursor CLI is needed for scheduled `.cursor/agents` runs.
3. Create a chat with harness **Cursor SDK**.

Using Cursor API/CLI is subject to [Cursor Terms of Service](https://cursor.com). MIT here
covers only Cretli source code.

## Authentication & network exposure

- Default bind is **127.0.0.1** (localhost only). LAN is opt-in:
  `npm run start:lan` or `CRETLI_BIND=0.0.0.0`.
- Binding beyond localhost **without a password** requires `CRETLI_SETUP_TOKEN` or the
  process refuses to start (no first-run race on LAN).
- **Do not expose this directly to the Internet.** Use a VPN or SSH tunnel.

## Install as an app (PWA)

The app ships a web manifest and a service worker. Add to Home Screen on a phone
(or install in desktop Chromium). Live data (terminal/chat) always goes to the running server.

## HTTPS (microphone from a phone)

```bash
npm run gen-cert
# or: SSL_IP=192.168.1.10 node scripts/generate-ssl-cert.js
npm start
```

On the phone open `https://<lan-ip>:3011` and accept the self-signed cert warning.

## Configuration

All variables are optional. Copy [.env.example](.env.example) to `.env` — `npm start`
loads it automatically (Node's native `--env-file`). Highlights:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3011` | HTTP/WS port |
| `CRETLI_BIND` | `127.0.0.1` | Bind host (`0.0.0.0` for LAN) |
| `CRETLI_SETUP_TOKEN` | — | Required for first-run setup when bound beyond localhost |
| `USE_HTTPS` | `1` (via `npm start`) | HTTPS with `data/key.pem`+`cert.pem` |
| `WORKSPACE_FILE` | `cretli.code-workspace` if present | Path to a `.code-workspace` file (otherwise pick a folder in the app) |
| `CRETLI_DATA_DIR` | `data` | Where chats, settings, auth and certs are stored |
| `CRETLI_LAN_HOST` | auto | Host used in the in-app link/QR |
| `OPENCODE_API_KEY` | — | OpenCode Zen key |
| `OPENROUTER_API_KEY` | — | OpenRouter chat |
| `CURSOR_API_KEY` | — | Cursor SDK chat |
| `AGENT_CALLBACK_TOKEN` | — | Required for agent callbacks when exposed on LAN |

Legacy `CURSOR_REMOTE_*` aliases still work. Documented names are `CRETLI_*`.

Runtime data lives in `data/` (gitignored).

## Comparison

| | Cretli | OpenCode TUI | code-server | Open WebUI |
|--|--------|--------------|-------------|------------|
| Phone PWA + shared live session | yes | no | IDE in browser | chatbot UI |
| Full PTY terminal | yes | TUI only | yes | no |
| Pluggable agent backends | OpenCode / OpenRouter / Cursor | OpenCode | extensions | models |
| Self-hosted on your PC | yes | yes | yes | yes |

## Architecture (brief)

- **HTTP** — `public/`, REST API (workspace, chats, settings, files, git, todos).
- **WebSocket** — `/ws` (terminal), `/ws-agent-sdk` (chat rooms for all harnesses).
- **Backend** — Node.js, Express, `node-pty`, `ws`, optional `@cursor/sdk`.
- **Frontend** — SPA in `app_front/` (webpack → `public/dist/`).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md)

## Contributing

PRs and issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Run `npm test` before opening a PR.
Suggested starter tasks are listed in CONTRIBUTING.

## License

[MIT](LICENSE) — see [NOTICE](NOTICE) for third-party terms (`@cursor/sdk` is proprietary
and optional).
