# Security Policy

Cretli gives a browser (typically on your phone) a **full shell terminal** and an
**agent** running as your user on the host machine. Treat it like giving someone
physical access to your keyboard. Read this document before exposing it on a network.

## Supported versions

Only the latest release on the `master` branch is supported.

## Threat model

- The server runs a PTY (`node-pty`) as the user that started Node, plus an optional
  agent (OpenCode, OpenRouter, or Cursor SDK) with your workspace as the working
  directory. Anyone who can reach the HTTP/WebSocket ports can run arbitrary commands
  on your machine.
- By default the server binds to **127.0.0.1 (localhost only)**. LAN/Internet exposure
  is **opt-in** via `CRETLI_BIND=0.0.0.0` (or `npm run start:lan`).
- Binding beyond localhost **without a password** requires `CRETLI_SETUP_TOKEN` or the
  process exits. That blocks a LAN neighbor from claiming first-run setup.
- Authentication uses a single password (scrypt-hashed in `data/auth.json`) and a signed,
  `HttpOnly` session cookie. On first run, open `/login` to set the password.
- HTTPS uses a self-signed certificate (`npm run gen-cert`). It protects against passive
  eavesdropping on the LAN but is **not** a substitute for auth.

## Hardening checklist

1. **Set a password** on first run via `/login` (or the `/api/setup` endpoint).
2. Keep `CRETLI_BIND=127.0.0.1` unless you intentionally expose the server.
3. If you must expose on LAN, use HTTPS (`USE_HTTPS=1`), a strong password, and
   `CRETLI_SETUP_TOKEN` until the password exists.
4. Set `AGENT_CALLBACK_TOKEN` to a long random value when exposed — otherwise agent
   callback endpoints (`/api/set-todo-from-agent`, `/api/set-chat-title-from-agent`,
   `/api/set-chat-summary-from-agent`) are rejected on non-localhost binds.
5. Do **not** expose the server directly to the Internet. Use a VPN or SSH tunnel.
6. `data/` contains `auth.json` (password hash + session secret), `config.json` (may
   include API keys), `chats.json`, TLS certs and uploads — keep it private. Set
   `CRETLI_DATA_DIR` to relocate it, for example onto an encrypted volume.

## Known dependency advisories

`npm audit` reports advisories (moderate and high) in `undici`, pulled in through
`@connectrpc/connect-node` by the **optional** `@cursor/sdk` package. No upstream fix
is available yet. They only apply if you install the optional Cursor SDK; the
OpenCode and OpenRouter harnesses do not use that dependency chain. Installing
without it via `npm install --omit=optional` leaves the runtime dependency tree
free of known advisories.

## What is intentionally not implemented

- No multi-user accounts or RBAC — single shared password.
- No CSRF token (the UI uses `SameSite=Lax` cookies and same-origin requests).
- No rate limiting on the terminal/agent streams.
- No Content-Security-Policy header (the SPA shell uses inline scripts/styles).

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue.

- Open a private security advisory: GitHub → Security → Advisories → "New draft advisory"
  on [cretli/cretli](https://github.com/cretli/cretli/security/advisories/new), or
- Email the maintainer via the address listed on the GitHub profile.

Include a description, reproduction steps and, if possible, an impact assessment. You will
receive a response within 7 days. Please avoid public disclosure until a fix is released.
