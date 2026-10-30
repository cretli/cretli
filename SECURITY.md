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

[docs/browser-runtime.md](docs/browser-runtime.md) covers the host requirements for
Chromium itself — a Docker image that ships no browser binary, running as root and the
`CRETLI_BROWSER_ALLOW_NO_SANDBOX` opt-in, and Termux — plus what each `runtime.status`
means for an operator. It adds no guarantees and weakens nothing here: the Browser is
still not a network boundary.

- **Default-deny origins.** A workspace must explicitly allowlist each `http(s)://host`
  before Chromium can reach it. `allowLocalhost` opens loopback only and
  `allowPrivateNetwork` opens RFC1918/ULA literals only; neither implies the other.
  Agent navigation can ask a live chat to allow a missing public origin. An
  allow-once answer lasts only for that Browser session; always allow saves the
  origin under the session's workspace key. Silence leaves the prompt pending
  briefly and then expires it without granting access. Explicit refusal blocks
  navigation. This prompt cannot override the other URL policy denials below.
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
  request to a second origin and leak them. Exception: with the opt-in **native
  networking** of an external Chrome (`browserCdpNativeNetwork`), a policy-approved
  request to a public address is continued inside Chrome, which follows its server
  redirects without re-checking them (see `docs/browser-runtime.md`). The external Chrome
  is a per-session mode (`browserMode`), not a global switch: it needs the workspace's
  `allowExternalBrowser` consent for every external session, native networking applies to
  external sessions only (never to a built-in session or an `auto` fallback), and `auto`
  falls back to the built-in Chromium with an `external-fallback` warning without changing
  consent or policy.
- **DNS answers are pinned per session.** The first validated answer for a hostname is
  remembered. A later answer may rotate to another public address (CDN or round-robin
  DNS), but a move into a loopback, private, link-local or special range, or away from a
  host pinned to a local address, is refused as `dns-rebinding`. A public hostname that
  resolves to a local address is refused the same way, even when allowlisted. Exception:
  an allowlisted local-only name (a single label, or a reserved / non-delegated TLD such as
  `.loc`, `.test`, `.lan`, `.local`, `.internal`, `.home.arpa`) may resolve to loopback or
  the LAN, since no public DNS server can answer for it (e.g. `my-app.loc` in the hosts file).
- **Residual risk.** Chromium resolves hostnames in its own network stack, so Node's policy
  check and Chromium's connection are separate resolutions. Chromium is launched with a
  default-deny `--host-resolver-rules` map (`MAP * ~NOTFOUND` plus validated IPv4 pins) as
  defense in depth. On current Chromium the catch-all also blocks IP-literal connects, so
  the resolver deny is stricter than a hostname-only map would suggest; this is still not a
  hard IP-level guarantee. A configured upstream proxy is a separate channel:
  `context.route()` cannot inspect traffic inside CONNECT/HTTPS tunnels. The main
  route-invisible hole outside Cretli's separately guarded self hosts is a
  resolver-pinned allowlisted hostname whose page opens a
  WebSocket to a **different**, non-allowlisted port — the handshake never reaches
  `route`, while the equivalent HTTP fetch is blocked. WebRTC uses
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (no direct UDP candidates
  without a proxy; Cretli does not configure TURN/STUN), but a page can still use its own
  TURN relay over TCP. WebSocket panel navigations and the always-blocked address list
  cover other cases; do not treat the Browser as a network boundary.
- **Self-origin debug WebSockets.** `allowSelfOrigin` adds validated resolver pins
  or literal-address exceptions for Cretli's own hosts. Every WebSocket on those
  hosts is intercepted and checked against the current origin/port policy before
  connecting, so the resolver exception does not permit arbitrary WebSocket ports.
  This exception is host-wide at the Chromium resolver layer; WebRTC/TURN residuals
  still apply. A driver without WebSocket routing cannot open a self-origin debug
  session.
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
  A run with no signed-in UI attached (a Watcher/autopilot cycle, a delegation, or a chat
  after a restart before the UI reconnects) acts as a reserved **system owner**
  (`BROWSER_SYSTEM_OWNER_ID`, `lib/browser/agent-tools.js`), never as the last login
  session seen on the chat. The system owner is not a Cretli login session id, so
  `requireSession` makes its sessions unreachable from any user session and vice versa;
  `/api/browser/sessions` lists by the real login session id and therefore never shows a
  system session in the Browser panel. A system session is a fresh Chromium context: it
  starts with no cookies and never reads or copies a user's cookie jar, tokens or login
  session. A widget-only chat (no Cretli login session) stays fail-closed and never gets a
  system owner, so the fallback does not widen widget integrations.

## Chat media store

Browser screenshots may contain sensitive page content. They are kept in
`data/chat-media/<chatId>/` (`0700`/`0600`, 50 files per chat) until the chat is
deleted, and served only by `GET /api/chats/:chatId/media/:file` to the
authenticated owner session: widget tokens and MCP-integration tokens get 403.
The route validates ids and file names, rejects symlinks and paths outside the
chat directory, serves raster types only (no SVG) with `nosniff` and
`private, immutable` caching. Set `CRETLI_CHAT_MEDIA=0` to keep screenshots in
the temp directory instead.

## External MCP access (`/mcp`)

Cretli can expose its built-in MCP tools to external clients (Claude Code, Cursor, …)
over a Streamable HTTP endpoint at `/mcp`. Only the `builtin-cretli` server is exposed,
never your other MCP servers or their secrets.

- **Off by default.** Nothing is served until you enable it in Settings → MCP
  (`externalMcpEnabled`); until then `/mcp` answers 403.
- **Localhost only.** Non-loopback peers are refused unless you explicitly opt in to
  LAN access (`externalMcpAllowLan`). Use it only on a trusted network with HTTPS.
- **Origin rejection.** Any request carrying a browser `Origin` header is refused
  (DNS-rebinding and cross-site protection); real MCP clients do not send one.
- **Per-client tokens.** Each client gets its own bearer token, shown once and stored
  only as a hash, bound to one workspace folder and mode, with an expiry. Revoke a
  token in Settings → MCP (or `DELETE /api/mcp/external-clients/:id`); it stops working
  immediately. Only a logged-in session can create or revoke clients.
- **Modes.** `plan` denies write tools. **`agent` mode can run shell commands and write
  files** in the client's workspace — treat an agent token like a shell on this machine.
  `operator` adds plan approval and chat control on top of `agent`.
- **Rate limit.** Each client may make 60 tool calls per minute
  (`EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW`); beyond that `/mcp` returns HTTP 429 and the
  tool is not run.
- **Audit.** Every tool call is appended to `mcp-external-audit.jsonl` in the data dir
  (`CRETLI_DATA_DIR`): time, client id, tool name and outcome (`started`, `ok`, `error`,
  `rejected`). Tool arguments, results and tokens are never recorded.
- **Audit is fail-closed.** Auditing is two-phase: a `started` record is written
  before the tool runs. If that write fails (unwritable or full data dir), the call is
  refused with a JSON-RPC error and the tool is **not** executed, because an `agent`
  token can run shell commands and an unaudited action is not acceptable. The closing
  `ok`/`error` record is best effort (failures are logged), so a crash between the two
  records leaves a `started` entry without a result.

## Windows helper (`cretli-netd`)

The optional helper (`scripts/windows/`) runs as `SYSTEM` on a Windows host and
changes portproxy and firewall rules for exposed ports. Its only channel is the
named pipe `\\.\pipe\cretli-netd`: no TCP listener. The pipe DACL admits `SYSTEM`
and one configured user with the minimal mask `0x00120083`, denies `NETWORK`, and
the pipe is owned by `SYSTEM`; the client verifies the owner of the pipe handle
(`S-1-5-18` or `S-1-5-32-544`) before it sends a request and fails closed
(`server_untrusted`). Requests are a closed list of operations with a validated
port only; the target address is discovered by the helper, never supplied. Rules are
TCP, one port, Private and Domain profiles (never Public), `LocalSubnet`, and only
rules recorded in the helper state are ever changed or removed. Each firewall rule
needs a matching live rule spec and a per-rule identity token from the admin-only
state file before it can be changed or removed. Standard rules store the token in
`Description`; Hyper-V rules store it in their unique `Name`. An administrator or
`SYSTEM` attacker is out of scope. Threat model, install and the manual Windows
verification checklist: [docs/apps-and-ports.md](docs/apps-and-ports.md#windows-helper).

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

## OpenCode approval advisor (optional)

When enabled in Settings → Harness → OpenCode (broker mode `local_reads`), Cretli
may call an **external HTTPS** model you configure (`openai_chat` or `systemone`).
This applies only to **OpenCode permission cards**; other harnesses keep their own
policies (Codex headless, Claude `canUseTool`, and so on).

- **Defaults fail closed:** broker `off`, advisor disabled, `sendSensitiveCommand`
  false, daily quota may skip calls. Modes `off` and `shadow` perform **no**
  advisor network I/O.
- **Payload:** role-dependent. **Advisory** (`riskScope=advise_all`) sends by
  default only request id, controlled action name, local risk, and categories
  (no command, no resource names). The **`sendSensitiveCommand`** setting
  governs **advisory requests only**: when enabled, a bounded redacted command
  snippet and resource basenames are added only for lower-risk advisory requests;
  high/unknown risk and sensitive categories (secrets, network, privilege,
  destructive, expansion) stay minimal even when enabled (still capped and scrubbed
  when included).
  **Authority** flows (`low_only`, `advisor_assessed`) always use the documented
  redacted tuple via `buildAdvisorPermissionTuple` — command and basenames are
  included per normal normalization, **independent of `sendSensitiveCommand`**.
  No chat history, cwd, diffs, or API keys. **Redaction is best-effort**, not a
  guarantee; providers may retain what they receive.
- **Advisory scope (`advise_all`):** informational risk/recommendation on the
  card only; Cretli never sends `once`/`always`/`reject` on your behalf.
- **Authority scope:** at most one automatic `once` for the narrow low-risk /
  review-verify allowlist; `always` and `reject` are never sent by the advisor.
- **Endpoint safety:** HTTPS only, public addresses, DNS pinning — see
  `docs/APPROVAL-BROKER-PHASE-2.md`. Keys: `CRETLI_APPROVAL_ADVISOR_API_KEY`
  overrides stored settings; neither is returned on GET.

Treat the advisor like any third-party API: model drift, false positives, and
provider logging remain operator responsibilities.

## Known dependency advisories

`npm audit --omit=dev` is clean for the runtime dependencies Cretli ships with, apart
from the advisories below, which have no non-breaking fix yet:

- **`zod` (high, memory exhaustion on oversized collections)** reaches Cretli only through
  the **optional** harness SDKs `@cursor/sdk`, `@qwen-code/sdk` and `@tencent-ai/agent-sdk`.
  The proposed fix downgrades `@qwen-code/sdk` to a much older release, so it is not
  applied. The exposure exists only if you install one of those SDKs and feed it
  untrusted schemas; installing without optional packages
  (`npm install --omit=optional`) leaves the tree free of it.
- **`katex` / `mermaid` (low, prototype pollution trust bypass)** are used by the diagram
  renderer; the fix needs a major `mermaid` upgrade and is tracked for a later release.

Run `npm audit` after installing to see what your own install resolves to.

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
