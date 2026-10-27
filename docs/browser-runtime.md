# Browser runtime: Docker, limited egress, Termux

The Cretli Browser is **server-side headless Chromium** driven through Playwright
(`lib/browser/`), which the UI mirrors in the chat **Browser** panel and agents drive
with the `browser_*` tools. Because Chromium is a separate native binary with its own
sandbox requirements, it is the one Cretli feature whose availability depends on the
host you deploy on.

All availability questions have exactly one source of truth:
`lib/browser/runtime-detect.js` → `detectBrowserRuntime()`. Detection is **lazy and
non-fatal**: a missing package, a missing binary, a locked-down network configuration
or an unsupported host yields a controlled status instead of a crash. The server always
boots and every other feature keeps working; only the Browser is off.

## Required runtime dependencies

| Layer | Package / binary | Install path |
|-------|------------------|--------------|
| Node driver | `playwright-core` (a **required** dependency in `package.json`) | comes with `npm install` / `npm ci` |
| Browser binary | Chromium | **never** installed by `npm ci` |

`playwright-core` has no post-install browser download, so a green `npm ci` does **not**
mean the Browser works. `@playwright/test` is a devDependency for the Playwright e2e
suites only and is never on the server path.

After the driver loads, the binary is resolved in this order:

1. Playwright's own download — `playwright.chromium.executablePath()`.
2. `CRETLI_BROWSER_EXECUTABLE_PATH`, if set and the file exists (operator pin — wins
   over the automatic probes below).
3. System packages, first hit of `SYSTEM_CHROMIUM_CANDIDATES`:
   `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`,
   `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome`.

When step 2 or 3 succeeds, `detectBrowserRuntime()` returns `available` with
`reason: "Using a system Chromium binary (Playwright download is missing)."` and
`usingSystemChromium: true`. That object is stored as `driverStatus` at boot.
**`GET /api/browser/status` does not expose `usingSystemChromium`**, and while a live
driver is present `BrowserSessionManager.getRuntimeStatus()` sets `reason` to `'ok'`, so
HTTP consumers never see the fallback sentence. Over HTTP the practical hint is
`runtime.executablePath` pointing at a system candidate (for example `/usr/bin/chromium`)
rather than a Playwright cache path.

### Environment variables this document covers

| Variable | Values / default | Effect on availability |
|----------|------------------|------------------------|
| `CRETLI_BROWSER_EXECUTABLE_PATH` | (unset) | Absolute path to a Chromium/Chrome binary. Pinned over the automatic system probe. |
| `CRETLI_BROWSER_ALLOW_NO_SANDBOX` | (unset); `1` enables | Only switch that lets Cretli pass `--no-sandbox` to Chromium (see the **Docker** section). |
| `CRETLI_BROWSER_NETWORK_BOUNDARY` | `mvp-defense-in-depth` (default) \| `proxy` \| `required` | Which egress boundary must be satisfied before a session may start. |
| `CRETLI_BROWSER_PROXY_SERVER` | (unset) | The proxy Cretli hands to Playwright. Required by the `proxy` and `required` boundary modes. |
| `CRETLI_BROWSER_CDP_URL` | (unset) | Opt-in external Chrome/Chromium CDP endpoint. When unset, the existing headless launch path is unchanged. |
| `CRETLI_BROWSER_CDP_ALLOWLIST` | (unset) | Comma-separated hostnames allowed for CDP; each DNS answer must still be private, link-local, or loopback. |

Browser *capacity* and *respawn* knobs (`lib/browser/lifecycle.js`), the screencast flag
and the multi-instance switch live in their own documents — see
[docs/MULTI-INSTANCE.md](MULTI-INSTANCE.md) and
[docs/ARCHITECTURE.md](ARCHITECTURE.md) — and are deliberately not repeated here.

## Status vocabulary

`runtime.status` is a closed set (`BROWSER_RUNTIME_STATUS`):

| Status | Cause | What the operator does |
|--------|-------|------------------------|
| `available` | Driver and a Chromium binary resolved, boundary configured. May still carry `sandboxWarning` (see the **Docker** section). | Nothing. If `sandboxWarning` is set, decide explicitly between a non-root container and `CRETLI_BROWSER_ALLOW_NO_SANDBOX=1`. |
| `browser-unavailable` | Playwright package failed to import — `reason` starts with `Playwright runtime is not installed (`; or the boundary mode is unsatisfied — `reason` names the offending variable; or no Chromium binary exists at any probe path — see the missing-binary reasons in the **Installing Chromium** section. | Follow `reason`: install the missing binary (see the **Installing Chromium** section), or fix the boundary env (see the **Limited egress** section). |
| `unsupported-platform` | The host is Termux/Android, detected before any package or binary probe. Chromium is **deliberately not supported** as a Termux host — this is a platform decision, not a missing download. | Do not install Chromium and retry; it cannot change the verdict. Use the widget path instead (see the **Termux (Android)** section). |

## External Chrome over CDP

Set `CRETLI_BROWSER_CDP_URL` to use a real user-owned Chrome profile (for example
`http://127.0.0.1:9222`). Cretli probes `/json/version`, rejects credentials and
public DNS answers, then connects with `connectOverCDP`. A hostname must be
`localhost` or appear in `CRETLI_BROWSER_CDP_ALLOWLIST`; all of its DNS answers
must resolve only to private, link-local, or loopback addresses. The API reports
`runtime.mode: "external-cdp"` and `runtime.connected` (`unknown`, `true`, or
`false`). One Cretli session is allowed at a time. The external browser is connected
only after the current workspace explicitly enables
`allowExternalBrowser` in Browser policy (default `false`). With
`CRETLI_BROWSER_NETWORK_BOUNDARY=proxy` or `required`, CDP is unavailable because
the external Chrome cannot be forced through Cretli's proxy. Existing user tabs and
the external browser/context are never closed; only the Cretli-created tab is routed
and closed. HTTPS probes connect to the verified literal IP, so the certificate
must be valid for that IP (the HTTP `Host` header does not change TLS
verification); Cretli does not disable certificate validation. Owned pages also
receive WebSocket routing and a CDP service-worker bypass. External Chrome cannot
receive Cretli's launch-only resolver/WebRTC flags, so WebRTC/TURN remains a
documented residual risk; ordinary HTTP(S), redirects, subresources, iframes and
owned-page WebSockets remain subject to the URL policy.

### Configuring the endpoint from Settings

The same endpoint can be set in **Settings → App → Browser → External Chrome**
instead of `.env`. It is stored as `browserCdpUrl` / `browserCdpAllowlist` in
`data/config.json` (`lib/browser/cdp-config.js`). `PUT /api/browser/runtime-config`
probes the address with the same checks as above before saving, then re-runs
`detectBrowserRuntime()` and swaps the session manager's driver in place, so no
restart is needed. An empty address returns to the built-in headless Chromium. The
change is refused with `409 sessions-active` while a Browser session is open, and
with `409 env-locked` when `CRETLI_BROWSER_CDP_URL` is set in the environment, which
always wins.

### Native networking for public sites

By default every request of an owned page is replayed by Cretli through
`route.fetch()`, which Playwright executes from the Node process
(`APIRequestContext`), not from Chrome. That keeps redirects fully policy-checked,
but sites with bot protection see a Node TLS/HTTP fingerprint behind a Chrome
User-Agent and block the session (and can flag the whole public IP).

**Let Chrome load public pages itself** (`browserCdpNativeNetwork` in config.json,
external Chrome only, default off, applies live) changes that for requests the URL
policy allows and whose host resolves only to public addresses: they are continued
inside Chrome (`route.continue()`), so the site sees Chrome's own stack, cookies and
IP. Cretli's own origin and every loopback/private/link-local target keep the strict
replay path. Trade-off: Chrome follows server redirects of those requests itself, so
a redirect hop is not re-evaluated by the policy; Chrome's Private Network Access
still applies. The headless Chromium never uses this mode.

### WSL2 with Chrome on Windows

In the default NAT network mode WSL cannot reach Windows `localhost`, and Chrome's
debugging port listens on loopback only, often on IPv6 `[::1]`. Forward the port on
the Windows side of the WSL virtual interface (its address is the default gateway in
WSL, `ip route show default`), targeting IPv6:

```powershell
netsh interface portproxy add v4tov6 listenaddress=<wsl-gateway> listenport=9222 connectaddress=::1 connectport=9222
```

A `v4tov4` forward to `127.0.0.1` while Chrome listens on `[::1]` shows up as a
connection reset (curl exit 56). Never forward with `listenaddress=0.0.0.0`: that
exposes the debugging port, and the whole Chrome profile, to the local network. The
gateway address can change after a Windows or WSL restart. `networkingMode=mirrored`
in `.wslconfig` makes `http://127.0.0.1:9222` work directly, at the cost of changing
networking for all of WSL.

## Installing Chromium

Playwright-managed download (lands in Playwright's own browser cache, whose location is
controlled by `PLAYWRIGHT_BROWSERS_PATH`):

```bash
npx playwright install chromium
# system libraries on Debian/Ubuntu, needs root:
npx playwright install --with-deps chromium
```

The repo's own e2e scripts use `PLAYWRIGHT_BROWSERS_PATH=0` so the download lands inside
the checkout instead of the home cache — the same override applies to the server if you
keep the browsers there.

System package instead (no Playwright download, matches candidate list above):

```bash
# Debian/Ubuntu
apt-get install -y chromium
# or pin an off-standard path
export CRETLI_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium
```

Missing-binary reasons are verbatim actionable:
`Chromium is not installed at <path>. Run: npx playwright install chromium` when
Playwright knows a path but the file is gone, and
`Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.` when
nothing was found at all.

## Docker

The shipped image **does not provide the Browser**, and this is expected rather than a
defect. `Dockerfile` is `node:22-bookworm-slim` with `python3 make g++ ca-certificates`
and `npm ci`; it has no Chromium layer, no browser system libraries, and **no `USER`
directive**, so Cretli runs as root (uid 0). Two independent consequences:

1. **No binary** → `/api/browser/status` reports `browser-unavailable` with
   `Chromium is not installed at <path>. Run: npx playwright install chromium`
   (Playwright still returns an *expected* cache path even when the file is missing —
   the usual slim-image case). The message
   `Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.`
   applies only when `executablePath()` throws or returns nothing (see **Installing
   Chromium**).
2. **Root** → even after you add a binary, detection returns `available` **with**
   `sandboxWarning: Cretli runs as root: Chromium sandbox is unavailable. Set
   CRETLI_BROWSER_ALLOW_NO_SANDBOX=1 to explicitly accept --no-sandbox, or run as a
   non-root user.` Chromium's own sandbox cannot initialize under root without extra
   host privileges, so the real failure surfaces at launch, not at detection.

`--no-sandbox` is **never** appended silently. It appears only when the operator sets
`CRETLI_BROWSER_ALLOW_NO_SANDBOX=1`, and then the warning flips to
`Cretli runs as root: launching Chromium with --no-sandbox (weaker isolation) because
CRETLI_BROWSER_ALLOW_NO_SANDBOX=1.` Accepting it trades away the renderer sandbox that
limits what a hostile page can do to the container — a real weakening, so prefer the
first option below.

### Adding Chromium to the image

Option A — non-root with a system Chromium (keeps the sandbox):

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# ... copy the app, npm ci, build the front ...
USER node
```

Option B — Playwright-managed download (`npx playwright install --with-deps chromium`),
which also needs root at build time and still leaves the runtime as root unless you add
a `USER`.

`docker-compose.yml` in the repo publishes `127.0.0.1:3011:3011`, mounts `./data`, and
sets `CRETLI_BIND`, `CRETLI_SETUP_TOKEN`, `USE_HTTPS` — **nothing
browser-related**. Enable the feature per deployment:

```yaml
services:
  cretli:
    environment:
      CRETLI_BROWSER_EXECUTABLE_PATH: /usr/bin/chromium
      # only if you cannot run as a non-root user:
      # CRETLI_BROWSER_ALLOW_NO_SANDBOX: "1"
```

**Host-level requirements are operator-verified, not shipped by Cretli.** Chromium's
sandbox needs unprivileged user namespaces and allows the relevant syscalls; some
container hosts block these by default. Whether you must grant an extra capability or a
relaxed seccomp profile is specific to your host and kernel — Cretli makes no claim
about it here, and the only supported escape hatch is the explicit
`CRETLI_BROWSER_ALLOW_NO_SANDBOX=1` above. Verify the outcome with
`/api/browser/status` plus a real `browser_open` on your host.

## Limited egress (`proxy` / `required`)

`detectBrowserRuntime()` resolves the boundary **before** the driver is used, and an
unsatisfied boundary is a hard availability failure — Cretli does not silently fall back
to direct egress:

| Configuration | Result |
|-------------|--------|
| `CRETLI_BROWSER_NETWORK_BOUNDARY` unset, or `mvp-defense-in-depth` | Boundary `configured: true`, no proxy needed. Default mode; **not** an egress proxy. |
| `proxy` without `CRETLI_BROWSER_PROXY_SERVER` | `browser-unavailable`, `reason: "proxy requires CRETLI_BROWSER_PROXY_SERVER"`. |
| `required` without `CRETLI_BROWSER_PROXY_SERVER` | `browser-unavailable`, `reason: "required requires CRETLI_BROWSER_PROXY_SERVER"`. |
| `proxy` or `required` with a valid proxy URL | `available`; Chromium is launched with an explicit Playwright proxy and an empty bypass list. |
| `proxy` or `required` with a malformed `CRETLI_BROWSER_PROXY_SERVER` | `browser-unavailable`, `reason: "CRETLI_BROWSER_PROXY_SERVER must be a valid http(s), socks4, or socks5 URL"`. |
| Any other value in `CRETLI_BROWSER_NETWORK_BOUNDARY` | `browser-unavailable`, `reason: "Unsupported network boundary: <rejected value>"` — for example `Unsupported network boundary: strict`. The payload's `mode` falls back to the default name. |

In `required` mode Cretli also runs a bounded TCP reachability probe of the configured
proxy and reports it as `runtime.networkBoundary.proxyHealth`; `proxy` mode only records
a warning and still starts. The shipped egress proxy, its `CRETLI_EGRESS_*` environment
and exactly what it does and does not enforce are documented in
[docs/browser-egress-proxy.md](browser-egress-proxy.md) — that table is not duplicated
here on purpose.

Two environment facts that matter inside a container:

- Chromium is handed a **scrubbed** environment. `buildChromiumProcessEnv()` removes the
  parent-identity variables (`CODEX_SESSION_ID`, `CODEX_THREAD_ID`) and the proxy
  variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` in both cases). So a
  proxy exported to the container **does not** widen or supply the Browser's egress
  path — the only way Chromium gets a proxy is the explicit `CRETLI_BROWSER_PROXY_SERVER`
  above, which becomes a Playwright launch option.
- Every launch carries `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` on
  every platform, so with no proxy configured WebRTC gathers no direct UDP candidates.

## Termux (Android)

On Termux the Browser is **not supported by design**. `isTermuxHost()` matches any of:
`process.platform === 'android'`, a `PREFIX` containing `com.termux`, or a non-empty
`TERMUX_VERSION`. The check runs first in `detectBrowserRuntime()`, before Playwright is
even imported, so the answer is stable and cannot be fixed by installing packages:

```json
{
  "available": false,
  "status": "unsupported-platform",
  "reason": "Termux/Android as a Chromium host is not supported; use the widget fallback."
}
```

Use the phone's own browser for browsing and the widget integration for page
interaction: the widget `page_*` tools act on the page the user opened in a Cretli
widget, which is a different namespace from the server-side `browser_*` tools (see the
`browser_*` agent tools section of [../SECURITY.md](../SECURITY.md)). Everything else in
Cretli — terminal, chat harnesses, PWA — works on Termux; for the install itself see
[INSTALL.md](INSTALL.md) (`npm run start:termux`).

**Node version on Termux.** `engines.node` is `>=22.18` (native TypeScript type stripping: the
server loads `.ts` modules directly). The Termux `nodejs` package may lag behind that, and CI
cannot test Termux, so this constraint is not verified automatically. `npm run start:termux`
goes through `scripts/start-server-node22.sh`, which falls back to `npx node@22` when the
installed Node is older than 22.18; check `node -v` by hand if the server fails to import a `.ts` file.

## Checking availability

HTTP surface (both require an authenticated Cretli session; widget and foreign auth are
rejected):

- `GET /api/browser/status` → `{ ok, runtime, limits, namespace, wsPath }`, where
  `runtime` carries `available`, `status`, `reason`, `version`, `executablePath`,
  `sandboxWarning`, `networkBoundary` (`{ mode, proxyServer, configured, error }`, plus
  `proxyHealth` once a `required` probe has run) and `limits`. Fields such as
  `usingSystemChromium` exist only on the internal detection object — not on this JSON.
  When the driver is up, `runtime.reason` is `'ok'` even if detection used a system
  Chromium fallback; use `executablePath` (and boot logs) to distinguish sources.
- `GET /api/browser/health` → aggregated operator health: driver availability, Chromium
  process liveness, proxy state, respawn state and live session counts.

```bash
curl -sk https://127.0.0.1:3011/api/browser/status
```

Without a session, probe the same function directly from the checkout (this is the
fastest way to test a Docker or Termux change before deploying it):

```bash
node --input-type=module -e "
import { detectBrowserRuntime } from './lib/browser/runtime-detect.js';
const s = await detectBrowserRuntime();
console.log({ status: s.status, reason: s.reason, executablePath: s.executablePath, sandboxWarning: s.sandboxWarning });
"
```

In the UI, a chat's **Browser** panel is the end-to-end check: it drives `browser_open`,
which fails as `browser-unavailable` (HTTP 503) carrying the runtime `reason` as its
message when the feature is off. The same refusal path is pinned by
`tests/browser-session-manager.test.js` (*createSession reports browser-unavailable when
no driver is present*).

Existing tests that pin these statuses; they are the regression net for the behaviour
described above and are not duplicated here:

- `tests/browser-session-manager.test.js` — `createSession` reports `browser-unavailable`
  when no driver is present.
- `tests/browser-live.test.js`, `tests/browser-live-limits.test.js` — skip with a
  `browser-unavailable: …` message on hosts without a browser. Set
  `CRETLI_REQUIRE_BROWSER_LIVE=1` to turn each skip into a **failure**, which is how a CI
  or Docker image proves that Chromium is really there rather than quietly untested.
- `tests/browser-runtime-doc.test.js` — guards this document against drift: the status
  table, the covered env vars and the executable-path candidates must match the code, and
  each documented availability claim is re-executed against `detectBrowserRuntime()`.

## Security: this is not a complete SSRF boundary

Agent `browser_open` and `browser_navigate` ask for chat consent only when a public
origin is absent from the workspace allowlist (`origin-not-allowed`). The tool waits
up to 20 seconds (configurable with `CRETLI_BROWSER_CONSENT_WAIT_MS`, capped at 25
seconds), then returns `consent-pending`; the card remains for ten minutes. Retry
after the user answers: a retry joins the pending card or uses the session-scoped
once grant or saved workspace allowlist. Explicit refusal returns
`navigation-denied`; too many pending cards return `consent-limit`. Without a live
chat client, the tool immediately returns `navigation-blocked` with an allowlist
hint. A newly created tab is closed when its prompt is denied or expires.

Consent changes only the origin allowlist. It does not override local address,
port, DNS, self-origin, or redirect checks. Chromium's
`--host-resolver-rules` remains defense in depth, not a network boundary.

Restates the invariant in [../SECURITY.md](../SECURITY.md) ("Browser module SSRF model")
— do **not** read this document as claiming the Browser is a network boundary:

- The default `mvp-defense-in-depth` mode is deliberately not an egress proxy and does
  not claim complete DNS/SSRF isolation.
- Chromium resolves hostnames in its own network stack, separately from Node's policy
  check; `--host-resolver-rules` is defense in depth, not a hard IP-level guarantee.
- With `allowSelfOrigin`, validated Cretli hostnames get resolver pins and literal
  addresses get narrow resolver exceptions so its chat WebSockets can connect.
  WebSockets on every self host are intercepted separately and checked against
  the current URL policy, including the scheme, port and debug opt-in. Cookies
  stay in Chromium's connection. Other hosts retain their existing DNS rules.
- A configured upstream proxy is a separate channel: `context.route()` cannot inspect
  traffic inside CONNECT/HTTPS tunnels, and the shipped egress proxy does no HTTPS MITM.
- Outside the separately guarded self hosts, the main route-invisible hole is a resolver-pinned allowlisted hostname whose page
  opens a WebSocket to a different, non-allowlisted port. WebRTC TCP/TURN relays remain
  possible.
- `CRETLI_BROWSER_NETWORK_BOUNDARY=required` narrows egress through a proxy you operate;
  it does not make the boundary complete, and `browser-unavailable` on a misconfigured
  boundary is a **fail-closed availability** result, not a security guarantee for
  anything that runs outside the Browser module.

For the origin allowlist, blocked ranges, self-origin rules and redirect re-validation,
read [../SECURITY.md](../SECURITY.md). For the standalone proxy, read
[docs/browser-egress-proxy.md](browser-egress-proxy.md).

## Related documents

- [../SECURITY.md](../SECURITY.md) — threat model and the Browser module SSRF model.
- [browser-egress-proxy.md](browser-egress-proxy.md) — the optional egress proxy.
- [INSTALL.md](INSTALL.md) — Linux, macOS, WSL2, Termux, Docker, LAN/HTTPS.
- [ARCHITECTURE.md](ARCHITECTURE.md) — HTTP/WS API and harness routing.
- [harness-browser-context-matrix.md](harness-browser-context-matrix.md) — how the
  `browser_*` tools and skill guidance are injected per harness.
- [MULTI-INSTANCE.md](MULTI-INSTANCE.md) — running several Cretli instances.

### Experimental calm pace mode

Settings → Browser → External Chrome has a **Calm pace** switch (internally `calmPaceMode`) immediately
below native public-page networking. Save to apply it to current and future
sessions without restarting. It is independent of native networking and also
works with built-in Chromium. It defaults to off.

Agent tool responses include guidance to inspect page changes, work sequentially,
scroll in small increments and wait for visible elements. Agent inputs receive a
350 ms pause, cursor travel over 12 steps (25 ms each), 90 ms click hold, and
scroll chunks of varying size spaced 45–120 ms apart (at most 20 chunks),
preserving the exact total requested distance. Keyboard typing defaults to
80 ms per character; locator fill clears the field then types its replacement
sequentially at 80 ms per character. Manual panel input
is unaffected. This is a pacing experiment, not a guarantee against bot checks.
No stealth flags, fingerprint overrides or CAPTCHA automation are enabled.

Implementation references: [Playwright mouse API](https://playwright.dev/docs/api/class-mouse)
and [keyboard API](https://playwright.dev/docs/api/class-keyboard).

Calm pace guidance also instructs agents to retain the shopping session, avoid reload
loops, stop on rate limits and respect an available Retry-After value. Access
challenges are handed to the user in the same Browser panel. After an uncertain
cart or checkout action, agents must inspect state before repeating it. Paid
orders require explicit approval of the items, delivery and total. The backend also records HTTP 429 responses while calm pace mode is enabled and
blocks agent input (including queued input) and navigation across that Browser
session until Retry-After expires. Both integer seconds and HTTP dates are
supported; missing or invalid values default to 60 seconds. A later response
cannot shorten an existing pause. Read tools and manual input stay available;
requests initiated autonomously by the page are unaffected. Cooldowns are
in memory and end when the session closes. Checkout approval remains an agent
instruction, not a checkout enforcement layer.

References: [HTTP 429](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429),
[Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After)
and [Playwright authentication state](https://playwright.dev/docs/auth).

## Screenshot storage and chat thumbnails

`browser_screenshot` (MCP and the Cursor SDK tools) writes each frame to a
durable per-chat store at `<dataDir>/chat-media/<chatId>/` (directories `0700`,
files `0600`, at most 50 files per chat shared by all media kinds). The result
carries the on-disk `path` plus `mediaUrl` (`/api/chats/<chatId>/media/<file>`);
the MCP text also gets a `Preview: <mediaUrl>` line. The chat renders the image
as a thumbnail in the Activity tray and the tool details, and it survives
reloads, other devices and server restarts.

- `GET /api/chats/:chatId/media/:file` has the same scope as
  `GET /api/chats/:id/history`, but widget and MCP-integration callers get 403.
  Bad ids or file names are 400, unknown chats and missing files 404, symlinks
  and paths outside the chat directory 400. Only JPEG/PNG/WebP/GIF are served
  (never SVG), with `nosniff` and `Cache-Control: private, immutable`.
- Image blocks returned by other tools (Claude `tool_result`, Codex
  `mcp_tool_call` results, e.g. the Read tool) are externalized into the same
  store and replaced in history by an `[image: <mediaUrl> <mime> <bytes>B]`
  marker (PNG/JPEG/WebP/GIF by magic bytes, no SVG, max 5 MB; `[image omitted]`
  otherwise). OpenCode is out of scope. Because the limit of 50 files is shared,
  such images can push out older screenshots; their thumbnails then disappear
  through `onerror`.
- Deleting a chat removes its `chat-media` directory. Closing the Browser
  session or restarting the server does not.
- `CRETLI_CHAT_MEDIA=0` disables the store; screenshots then fall back to the
  private temp directory (last 12 per chat, no `mediaUrl`, no thumbnail).
- Operator MCP sessions (no real chat) always use the temp fallback.
