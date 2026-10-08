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
- With HTTPS enabled, the session cookie uses `SameSite=None; Secure` so the SPA can call
  the API from a secure context (including some embed scenarios). With explicit HTTP
  (`USE_HTTPS=0`), cookies use `SameSite=Lax`.
- WebSocket upgrades check the browser `Origin` header. Same-host connections are allowed;
  the configured `CRETLI_PUBLIC_ORIGIN` (full `http(s)://host:port`) is treated as this
  Cretli UI behind a TLS-terminating proxy. Other origins must appear in
  `CRETLI_EXTRA_WS_ORIGINS`. Extra origins are not treated as the Cretli iframe.
  Widget chat (`/ws-agent-sdk` with the widget subprotocol) and page bridge
  (`/ws-page-bridge`) require a valid widget access token — declaring the widget subprotocol
  on terminal, task, or log paths is rejected. `X-Forwarded-Host` / `X-Forwarded-Proto`
  are not used for origin matching.
- Plan mode is not a sandbox. OpenCode, Cursor SDK, Qwen, CodeBuddy, OpenRouter, and
  DeepSeek deny mutating tools (permission deny, `canUseTool` deny, catalog filter, or
  run abort). Codex Plan is prompt-only: the model is asked not to mutate, but the turn
  is not aborted and the sandbox stays `danger-full-access`.
- HTTPS uses a self-signed certificate (`npm run gen-cert`). It protects against passive
  eavesdropping on the LAN but is **not** a substitute for auth.

## Browser module SSRF model

The server-side Browser (`/api/browser/*`, `/ws-browser`) drives headless Chromium on the
Cretli host, so it is an SSRF-sensitive feature. Its guarantees are:

The active boundary is reported by `/api/browser/status` as `runtime.networkBoundary`.
The default `mvp-defense-in-depth` mode is deliberately not an egress proxy and does
not claim complete DNS/SSRF isolation. `proxy` and `required` modes require the
operator to set `CRETLI_BROWSER_PROXY_SERVER`. Cretli ships an optional egress
proxy (`node scripts/egress-proxy.js`, see `docs/browser-egress-proxy.md`) that
reuses `url-policy.js`; any other proxy is unaudited. `required` refuses to
start a session when the configured proxy does not answer a bounded TCP
reachability probe (the result is reported as
`runtime.networkBoundary.proxyHealth`), while `proxy` only records a warning and
still starts.

- **Default-deny origins.** A workspace must explicitly allowlist each `http(s)://host`
  before Chromium can reach it. `allowLocalhost` opens loopback only and
  `allowPrivateNetwork` opens RFC1918/ULA literals only; neither implies the other.
- **Always-blocked targets.** Link-local addresses (`169.254.0.0/16`, `fe80::/10`), cloud
  metadata endpoints, multicast, documentation and other special ranges are rejected even
  when allowlisted. IPv4-mapped, NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) and Teredo
  (`2001::/32`) forms are decoded or blocked so an address cannot be smuggled through a
  transition prefix. URLs containing `user:pass@` are rejected.
- **Self-origin block (default-deny).** Cretli's configured `CRETLI_PUBLIC_ORIGIN`
  (and the direct loopback URL) are denied by default, even if allowlisted, so the
  browser cannot reach the Cretli control plane through a reverse proxy unless an
  operator opens it explicitly. The only switch is the `allowSelfOrigin` debug opt-in
  (Settings → App → Storage → "Allow Browser to open Cretli's own origin (debug)"); it is
  persisted per workspace and stays off unless someone turns it on deliberately. When
  it is on, the Browser signs itself in with the in-memory local-login token, and that
  token is attached per request only toward Cretli's own-origin hops — it never leaves
  toward a third-party origin or a foreign redirect.
- **Redirects are re-checked.** Playwright does not expose server redirects to route
  handlers, so every request is fetched with `maxRedirects: 0` and each redirect hop is
  re-evaluated by the URL policy (navigation *and* subresources). Service workers stay
  blocked so they cannot bypass the route policy. When a redirect crosses origins, the
  original request's credentials (`Cookie`, `Authorization`, and other sensitive headers)
  are stripped before the next hop is fetched, so an allowlisted page cannot bounce a
  request to a second origin and leak them.
- **Residual risk.** Chromium resolves hostnames in its own network stack, so Node's policy
  check and Chromium's connection are separate resolutions. Chromium is launched with a
  default-deny `--host-resolver-rules` map (`MAP * ~NOTFOUND` plus validated IPv4 pins) as
  defense in depth. On current Chromium the catch-all also blocks IP-literal connects, so
  the resolver deny is stricter than a hostname-only map would suggest; this is still not a
  hard IP-level guarantee. A configured upstream proxy is a separate channel:
  `context.route()` cannot inspect traffic inside CONNECT/HTTPS tunnels. The main
  route-invisible hole is a resolver-pinned allowlisted hostname whose page opens a
  WebSocket to a **different**, non-allowlisted port — the handshake never reaches
  `route`, while the equivalent HTTP fetch is blocked. WebRTC uses
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (no direct UDP candidates
  without a proxy; Cretli does not configure TURN/STUN), but a page can still use its own
  TURN relay over TCP. WebSocket panel navigations and the always-blocked address list
  cover other cases; do not treat the Browser as a network boundary.
- **Resource limits.** Screenshots are capped per tab (2 fps; the client `force` flag does
  not bypass the cap), input events are rate limited and serialized per tab, and the WS
  queue is bounded.
- **`browser_*` agent tools.** The server-side Chromium sessions are also exposed to SDK
  agents as a separate `browser_*` namespace (never mixed with the widget `page_*` tools).
  Every tab tool requires an explicit `browserSessionId` + `browserTabId`, and each call is
  scoped to the calling owner session, workspace and chat, so an empty id list can never
  widen the scope. Plan/ask modes and `review` delegations receive the read-only subset
  only (the executor re-checks the guard on every mutation), `browser_input` requires an
  explicit `confirm: true`, and Console/Network pulls expose bounded, redacted metadata via
  a `since` cursor without response bodies or HAR. CDP debugger mutations require
  `confirm: true` like `browser_input`; scope/watch/stack payloads are redacted and
  bounded. `browser_evaluate`, WebRTC streaming and persistent cookies/`storageState` are
  intentionally not part of this namespace.

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
- Mutating `/api/*` requests authenticated with the session cookie require a per-session
  `X-Cretli-Csrf` header (returned by `/api/auth-status` and login). Widget bearer tokens
  and public setup/login endpoints are exempt. Logout closes active cookie-authenticated
  WebSocket streams.
- No rate limiting on the terminal/agent streams.
- No Content-Security-Policy header (the SPA shell uses inline scripts/styles).

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue.

- Open a private security advisory: GitHub → Security → Advisories → "New draft advisory"
  on [cretli/cretli](https://github.com/cretli/cretli/security/advisories/new), or
- Email the maintainer via the address listed on the GitHub profile.

Include a description, reproduction steps and, if possible, an impact assessment. You will
receive a response within 7 days. Please avoid public disclosure until a fix is released.
