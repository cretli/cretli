# Browser egress proxy

Optional standalone HTTP proxy that enforces the same URL policy as the in-process
Browser module (`lib/browser/url-policy.js`) at TCP connect time. Use it when
`CRETLI_BROWSER_NETWORK_BOUNDARY` is `proxy` or `required`.

## Start

```bash
node scripts/egress-proxy.js
```

On success the process prints a machine-readable line:

```text
ready 127.0.0.1 3129
```

Point the Browser at it:

```bash
export CRETLI_BROWSER_PROXY_SERVER=http://127.0.0.1:3129
export CRETLI_BROWSER_NETWORK_BOUNDARY=required   # or proxy
```

Playwright sends `Proxy-Authorization` credentials; map tokens to workspace
policies via `CRETLI_EGRESS_POLICY_FILE` (see below).

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CRETLI_EGRESS_BIND` | `127.0.0.1` | Listen address |
| `CRETLI_EGRESS_PORT` | `3129` | Listen port |
| `CRETLI_EGRESS_DATA_DIR` | `data` | Workspace policy store (`browser-policy.json`) |
| `CRETLI_EGRESS_POLICY_FILE` | (empty) | JSON session token → policy map |
| `CRETLI_EGRESS_BLOCKED_PORTS` | (empty) | Comma-separated internal ports (Cretli, OpenCode, …) |
| `CRETLI_EGRESS_SELF_ORIGINS` | (empty) | Comma-separated Cretli origins to block |
| `CRETLI_EGRESS_PROBE_PATH` | `/_egress_ready` | Unauthenticated health GET |
| `CRETLI_EGRESS_CONNECT_TIMEOUT_MS` | `15000` | Upstream connect budget |
| `CRETLI_EGRESS_IDLE_TIMEOUT_MS` | `120000` | Client/upstream idle timeout |
| `CRETLI_EGRESS_MAX_HEADER_BYTES` | `65536` | Max request/response header block size (enforced before and after parsing) |
| `CRETLI_EGRESS_MAX_CONNECTIONS` | `256` | Global open-connection cap; excess connections get `503` (`X-Egress-Deny: connection-limit`) |
| `CRETLI_EGRESS_MAX_CONNECTIONS_PER_TOKEN` | `64` | Per-session-token cap (must not exceed the global cap); excess gets `503` |
| `CRETLI_EGRESS_HEADER_DEADLINE_MS` | `10000` | Total deadline for reading the request head (not reset by bytes); expiry gets `408` |
| `CRETLI_EGRESS_DNS_TIMEOUT_MS` | `5000` | DNS lookup timeout; expiry is denied as `dns-failed` (403) |
| `CRETLI_EGRESS_UPGRADE_DEADLINE_MS` | `15000` | Total deadline for the WebSocket upstream response head; expiry gets `502` |

Invalid configuration fails closed at startup.

## Policy file shape

```json
{
  "v": 1,
  "sessions": {
    "playwright-token": {
      "workspaceKey": "/abs/path/to/workspace",
      "policy": { "allowedOrigins": ["https://example.com"] }
    }
  }
}
```

Either inline `policy` or `workspaceKey` (loads from `CRETLI_EGRESS_DATA_DIR`) is
required per token. Unknown tokens are denied.

## What it enforces

- DNS resolution inside the proxy, with IP pinning on connect
- Allowlist, blocked ports, self-origin, metadata/link-local/private/loopback rules
- Plaintext HTTP (absolute-form `http://`), `CONNECT` for TLS (`https://` / `wss://`
  tunnels — validated as `https` origins), and absolute-form `ws://` upgrades
  (`wss://` must use `CONNECT`, not absolute-form GET)
- Redirect `Location` re-validation on each plaintext HTTP hop

## What it does not do

- No HTTPS MITM: inside a `CONNECT` tunnel the proxy cannot see HTTP redirects or
  filter TLS content. Route-level checks in `BrowserSessionManager` remain the
  boundary for those hops.
- No WebRTC relay auditing (see `SECURITY.md`).

## Security review 2026-11

### Summary

Read-only review of the Browser egress proxy (`lib/browser/egress-proxy/`,
`scripts/egress-proxy.js`) and of how the Browser launches Chromium against it.
No code was changed. The request-time SSRF and allowlist logic is sound: every
bypass class in the brief that could be exercised was denied or fails closed, and
the upstream socket always connects to the address that was validated. No P1
finding was verified. The weaknesses are in the **integration around the proxy**
and in **resource limits**:

- The shipped proxy cannot currently be used end to end by the built-in Browser,
  because nothing supplies it with a session token (F1).
- Chromium's implicit loopback proxy bypass and the disabled Local Network Access
  checks may leave loopback traffic outside the proxy (F2, unverified at runtime).
- The `required` health check is TCP-only and runs only at session start (F3).
- Several availability limits are missing (F6-F8).

Recommendation on WebRTC (8825efc1): **do not realize** until the preconditions in
"Recommendation" below are met.

### Method and scope

- Static read of `lib/browser/egress-proxy/{server,target,allowlist,config}.js`,
  `scripts/egress-proxy.js`, `lib/browser/url-policy.js` (the policy the proxy
  reuses), `lib/browser/network-boundary.js`, `lib/browser/proxy-health.js`,
  `lib/browser/runtime-detect.js` (launch flags), the `_ensureProxyHealth` /
  `_enforceProxyHealth` code in `lib/browser/session-manager.js`, `SECURITY.md`
  and this document.
- Dynamic checks (throwaway script outside the repo, injected DNS): CONNECT and
  absolute-URL authorities through `validateConnectAuthority` / `validatePolicyUrl`
  and `classifyIp` on IP-literal forms.
- Existing tests re-run: `node --test tests/browser-egress-proxy.test.js
  tests/browser-proxy-health.test.js tests/browser-network-boundary.test.js`
  -> 59 pass, 0 fail.
- Not done: no live Chromium, no WebRTC runtime test, no load test. Items that
  depend on Chromium behavior are marked **unverified**.
- Line numbers refer to this checkout. `server.js` = `lib/browser/egress-proxy/server.js`,
  `target.js` / `allowlist.js` / `config.js` = same directory,
  `url-policy.js` = `lib/browser/url-policy.js`.

### Findings

| Id | Sev | Title | Where | Impact | Recommended fix |
|----|-----|-------|-------|--------|-----------------|
| F1 | P2 | Browser has no way to authenticate to the egress proxy | `runtime-detect.js:277-279` (proxy launch option has no credentials); `server.js:336-340` (no/unknown token -> `403`, never `407` + `Proxy-Authenticate`); `allowlist.js:62-79`; no code outside `egress-proxy/` creates tokens or a policy file (grep for `Proxy-Authorization` in `lib/` hits `har.js`, `session-manager.js:553` (credential header redaction list) and, inside `egress-proxy/`, `allowlist.js` and `server.js`; none of these supplies credentials to Chromium) | With `proxy`/`required` plus the shipped proxy every request is denied (`unknown-session`). Fails closed, but operators may be pushed toward an unaudited proxy, and a per-session token (which WebRTC-through-proxy needs for per-workspace policy) does not exist. Whether Chromium would send credentials preemptively is **unverified**; it normally answers only a `407` challenge. | Generate a per-session token, write it to the policy file / resolver, pass `username`/`password` in Playwright `proxy`, and answer `407` with `Proxy-Authenticate: Basic`. Add an integration test with real Chromium. |
| F2 | P2 | Loopback may bypass the proxy (unverified) and Chromium LNA checks are off | `runtime-detect.js:279` (`bypass: ''`), `runtime-detect.js:200-205` (`--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests`) | Chromium implicitly bypasses proxies for `localhost`/`127.0.0.1`/`::1` unless the bypass list contains `<-loopback>`; an empty `bypass` does not remove that. If so, loopback traffic never reaches the egress proxy and is guarded only by `context.route()` and `--host-resolver-rules` (see `url-policy.js:9-25`). Chromium's own Private Network Access protection is explicitly disabled, so the proxy is not defence in depth for loopback/LAN. **Unverified** - needs a runtime test. | Test with real Chromium (page fetches `http://127.0.0.1:<port>` and a counter on the proxy). If confirmed, pass `bypass: '<-loopback>'`. Reconsider the `--disable-features` flags once the proxy is the gate. |
| F3 | P2 | `required` health check is TCP-only, start-of-session-only and cached | `proxy-health.js:101-117` (plain TCP connect, does not use the `/_egress_ready` endpoint at `server.js:331`); `session-manager.js:1846` (only `mode === 'builtin'`, only when a session is created); `session-manager.js:1076-1078` (30 s TTL); `session-manager.js:1052-1059` (`proxy` mode only warns) | Any listener on the port passes (wrong service, or the proxy with a broken policy file). A proxy that dies mid-session is not noticed until the next session; requests then fail in Chromium. Direct fallback was not found: `--proxy-server` stays set and no `DIRECT` fallback is configured in the code read (runtime behavior **unverified**). In `proxy` mode a dead proxy only produces a warning while the session starts and every request fails. External/CDP sessions are not a gap: `session-manager.js:1830-1835` rejects them with `browser-unavailable` (503) in both `proxy` and `required` modes before the consent check at `session-manager.js:1836`, so the health check only has to cover built-in sessions. | Probe `GET /_egress_ready` and require the `ok` body; re-probe on a timer and close sessions when it fails in `required`; add a regression test that external sessions stay rejected in `proxy`/`required`. |
| F4 | P2 | Later requests on a reused client connection are not validated and leak `Proxy-Authorization` | `server.js:147` (hop-by-hop `Connection` stripped, no `Connection: close` injected); `server.js:224-229` (`client.pipe(upstream)` for the rest of the socket); `server.js:480-484` (after the first response everything is piped without redirect checks) | A keep-alive client can send request 2 for another host on the same socket. It is delivered to the first, validated upstream, not to the new target; redirects on later responses are not checked. Not a bypass to a new IP (the browser follows redirects as new proxy requests), but per-request policy is not enforced and an allowlisted vhost/reverse proxy could be asked for other names. **Credential leak (verified in code):** header filtering (`server.js:121-153`, `Proxy-Authorization` dropped at `server.js:138`) runs only on the first request head; every later byte is piped unfiltered (`server.js:228`). A second request on the same connection that carries `Proxy-Authorization` (a client authenticated by a token may send it on every request; Chromium's exact behavior is unverified, see F1) reaches the upstream origin with the proxy session token intact. The same applies to a WebSocket connection after 101 only in the client-to-upstream direction, which carries frames, not HTTP headers. Not exercised by a test: `B2` covers one request only. | Force `Connection: close` upstream and close the client socket after one response (or re-parse, re-validate and re-filter every request head). |
| F5 | P3 | `Host` header is forwarded unchanged | `server.js:132-151` (only hop-by-hop headers are dropped) | A non-browser client holding a token can send a URL for `ok.example` and `Host: internal-vhost`, reaching other vhosts behind an allowlisted IP. Page JS cannot set `Host`. | Rewrite `Host` from the validated URL. |
| F6 | P3 | No connection limits | `server.js:703-707` (`openClients` is unbounded), `config.js` (no max-connections setting) | Each Chromium launch can open many sockets; a stuck proxy client set is bounded only by the OS. | Add global and per-token connection caps; reject with `503`. |
| F7 | P3 | Slowloris / unbounded waits | `server.js:35-39` (idle timer is reset by every byte; no total deadline for reading the request head, `server.js:266-307`); `server.js:732-738` (DNS lookup has no timeout and uses the 4-thread libuv pool); `server.js:554-563` (WebSocket upgrade response buffered without the header-size cap used at `server.js:441`); `server.js:581-583` and `server.js:435` (`client.write` without backpressure handling) | A client dripping one byte per interval holds a socket indefinitely; slow DNS can starve the thread pool shared with the proxy's other lookups; a hostile WS upstream can grow the response-header buffer without bound: there is no size cap and no total deadline on that path, and continuously arriving data keeps resetting the idle timer, so it never fires. | Add a head-read deadline (e.g. 10 s), a lookup timeout, the same header cap on the WS path, and use `pipe`/`pause` for streaming. |
| F8 | P3 | Header cap and body limits are soft | `server.js:272` (the cap is checked only while the terminator is absent, so a head larger than `maxHeaderBytes` that arrives in one read is accepted); request/response bodies are streamed with no size limit (`server.js:228`, `484`) | Slightly oversized heads; unbounded transfers (acceptable for a proxy, but there is no per-session byte budget). | Compare `parsed.consumed` with the cap after parsing; consider a per-session transfer budget if the proxy is exposed beyond loopback. |
| F9 | P3 | IP classification hardening gaps | `url-policy.js:353` (always-blocked set is matched on text, so `FD00:EC2:0:0:0:0:0:254` classifies as `private`, not blocked; WHATWG URL parsing canonicalizes URL-derived hosts, so this is not reachable through the proxy today); `url-policy.js:318-333` (only `0.0.0.0` is blocked, not `0.0.0.0/8`; `192.88.99.0/24` is public); `url-policy.js:369-376` (IPv4-translated `::ffff:0:a.b.c.d` classifies as public: `::ffff:0:7f00:1` -> `public`; `100::/64` is public) | Defence-in-depth only; none of these reached a local service in the proxy flow I tested. | Canonicalize via `expandIpv6` before the set lookup; block `0.0.0.0/8`, `192.88.99.0/24`, `::ffff:0:0:0/96`, `100::/64`. |
| F10 | P3 | Operational hardening | `config.js:90` (any `CRETLI_EGRESS_BIND` accepted without warning; the probe at `server.js:331` is unauthenticated by design); `allowlist.js:86-89` (policy file read and parsed synchronously on every request); no token expiry/rotation; deny bodies echo hostnames and resolved IPs (`url-policy.js:593,600`, `server.js:185-196`) and the `X-Egress-Deny` code | A non-loopback bind exposes token guessing to the LAN; synchronous reads add latency under load; deny details help a page on an allowlisted origin map internal DNS answers (it already controls that DNS). | Warn or refuse non-loopback bind without an explicit opt-in; cache the policy file by mtime; add token TTL; keep deny bodies terse. |

Follow-up todo (F1): "Browser egress proxy: per-session token wiring (Playwright proxy credentials, 407 challenge, policy file registration) + Chromium integration test"
Follow-up todo (F2): "Browser egress proxy: verify and close the Chromium loopback proxy bypass (`<-loopback>`) and re-evaluate disabled Local Network Access checks"
Follow-up todo (F4): "Browser egress proxy: close the client socket after one plaintext response (or filter/validate every request head), strip `Proxy-Authorization` on all requests, and add a two-request keep-alive regression test asserting the second request is neither delivered unvalidated nor carries `Proxy-Authorization` upstream"
Follow-up todo (F3): "Browser proxy health: probe `/_egress_ready`, re-probe during sessions in `required`"

P3 items (F5-F10) may be grouped into one hardening todo; none changes the verdict on the
current SSRF decisions.

### Checked against the brief

1. **Allowlist/denylist bypass**
   - *DNS rebinding / resolve-then-connect:* the proxy resolves once and connects
     to the validated literal (`target.js:136-138`, `server.js:388`, `517`, `658`),
     so there is no second resolution inside the proxy. All answers are checked
     (`url-policy.js:590-631`); a public name with any loopback/private answer is
     `dns-rebinding` (dynamic check: `rebind.com` -> `[93.184.216.34, 127.0.0.1]`
     denied). Chromium's own resolution is a separate matter (see F2 and
     `url-policy.js:9-25`). Tests: `tests/browser-egress-proxy.test.js:547`, `570`, `1263`.
   - *IP literals:* decimal (`2130706433`), hex (`0x7f.1`) and octal (`0177.0.0.1`)
     are normalized by the WHATWG parser before the policy sees them and are
     denied as `origin-not-allowed` unless allowlisted. IPv4-mapped IPv6
     (`::ffff:7f00:1`, `::ffff:a9fe:a9fe`) are decoded (`url-policy.js:369-376`);
     NAT64, 6to4 and Teredo are decoded or blocked (`url-policy.js:378-403`).
   - *Zone ids and trailing dot:* `%zone` is stripped (`url-policy.js:87-88`), so
     `fe80::1%25eth0` stays link-local-blocked; `ok.example.` in CONNECT is
     normalized to `ok.example`; in an absolute URL `http://ok.example./` stays
     distinct and is denied (fails closed). Case: `OK.EXAMPLE` matches.
   - *Userinfo:* denied (`url-policy.js:527-530`); `a@ok.example` in CONNECT ->
     `userinfo-not-allowed`.
   - *Authority parsing differential:* `ok.example#` with port 8080 is parsed by
     `server.js:365-371` as port 8080 but by `target.js:136` as the default 443;
     the connection uses the validated values (`validation.port`), so it goes to
     443 of the allowlisted host. Not a bypass.
   - *CONNECT to local ports:* validated as an `https://host:port` origin
     (`target.js:84`) and subject to blocked ports (`url-policy.js:560-565`);
     tests `B5`, `R2 blocked-port`.
   - *Redirects:* plaintext `301/302/303/307/308` `Location` hops are
     re-validated against the pinned address (`server.js:467-478`); inside CONNECT
     tunnels they are invisible (documented above).
   - *IDN:* the WHATWG parser punycodes hostnames before comparison; not tested
     separately.
2. **SSRF to local services:** `127.0.0.0/8`, `::1`, `0.0.0.0`, `169.254.0.0/16`
   (including `169.254.169.254`/`.170.2`), `100.64.0.0/10` (includes
   `100.100.100.200`), `168.63.129.16`, `fe80::/10`, `fc00::/7` (private) and
   RFC1918 are classified in `url-policy.js:318-333`, `404-408`. Link-local, CGNAT
   and metadata addresses are always blocked; loopback/private need an explicit
   allowlist or opt-in. Tests: `tests/browser-egress-proxy.test.js:218-256`, `489`.
   Residual gaps: F9.
3. **Header/cookie leakage:** `Proxy-Authorization` is removed from the **first** request head on the plaintext
   and WebSocket paths (`server.js:138`) and never reaches a CONNECT tunnel; test
   `B2` (`tests/browser-egress-proxy.test.js:727`) covers a single request. Later
   requests on a reused client connection are not filtered (F4). Hop-by-hop headers and headers
   named in `Connection` are dropped (`server.js:20-29`, `139-149`). The proxy adds
   no `X-Forwarded-*`/`Via` headers. It keeps no cookie state, so cookies are
   not mixed across origins by the proxy (cookie isolation is Chromium's).
   `Cookie`/`Authorization` are forwarded only to the validated origin. The proxy
   writes no log lines (no `console.*` in `lib/browser/egress-proxy/`), so tokens
   and URLs are not logged; `scripts/egress-proxy.js` logs only the config error
   message (`:14`), the ready line and the listen error (`:22`). Residual: F5, F10.
4. **Failure behavior (`proxy|required`):** `required` throws `browser-unavailable`
   (503) before launching Chromium when the probe fails
   (`session-manager.js:1052-1055`); `proxy` warns and continues
   (`session-manager.js:1056-1058`). Missing/invalid `CRETLI_BROWSER_PROXY_SERVER`
   makes the boundary `configured: false` (`network-boundary.js:28-39`). A launch
   always sets the proxy when configured (`runtime-detect.js:277-279`), and no
   direct-fallback path exists in the code read. Weaknesses: F3 (probe quality)
   and F1/F2. Tests: `tests/browser-proxy-health.test.js`, `tests/browser-network-boundary.test.js`.
5. **WebRTC:** see the next section.
6. **Resource abuse:** idle timeout 120 s, connect timeout 15 s and a 64 KiB header
   cap exist (`config.js:10-11`, `109-113`, `server.js:272`, `400`); everything
   else is F6-F8.

Also verified OK: unknown, empty or `ws:`-prefixed tokens are denied
(`allowlist.js:87-108`; the `__proto__` key resolves to an object without
`workspaceKey` and is denied); a malformed policy file yields no sessions
(fail closed, `allowlist.js:29-31`); invalid config exits non-zero
(`scripts/egress-proxy.js:11-16`); `wss://`/`https://` absolute-form are
refused in favor of CONNECT (`server.js:611-618`); `Transfer-Encoding: chunked` +
`Content-Length` conflicts are denied (`server.js:623-634`; only when the TE value contains `chunked`, other TE/CL combinations are not rejected); upstream errors after a
tunnel opened do not inject a second HTTP response (tests `F3`, `G2`).

### WebRTC (8825efc1): what it would open

- **Already in place:** `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  (`runtime-detect.js:198`). With an HTTP proxy this should leave no direct UDP:
  ICE candidates are gathered only through the proxy, and an HTTP proxy cannot
  carry UDP, so the connection can fall back to TCP via CONNECT only. This
  behavior is documented by Chromium but **was not verified at runtime here**.
- **What WebRTC adds if enabled:** STUN/TURN (UDP/TCP/TLS) to page-chosen servers;
  ICE host/srflx/relay candidates and local-IP exposure (mDNS-obfuscated host
  candidates by default, none with `disable_non_proxied_udp`); peer-to-peer UDP
  that bypasses `context.route()` and an HTTP proxy; data channels as a
  covert channel to any peer or TURN relay. TURN-over-TCP/TLS would go through
  CONNECT, so the proxy's allowlist would apply only if F1/F2 are resolved and the
  TURN host:port is an allowlisted https origin.
- **SOCKS5 caveat:** a `socks5://` proxy with UDP associate changes the picture:
  `disable_non_proxied_udp` then permits UDP through that proxy, and the egress
  proxy (HTTP CONNECT only) would not see it. The code accepts `socks4/5` in
  `network-boundary.js:34`; that must be excluded for any WebRTC-enabled mode.
- **Flags/policies needed:** keep `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  (or the enterprise policy `WebRtcIPHandlingPolicy=disable_non_proxied_udp`);
  consider `WebRtcUdpPortRange` to a closed range as a belt-and-braces check and
  a firewall rule dropping UDP from the Chromium process; add `bypass: '<-loopback>'` (F2);
  deny media device permissions; keep `--host-resolver-rules` deny rule.

### Recommendation

**Do not realize WebRTC (8825efc1) now.** Revisit only when all preconditions hold:

1. F1 and F2 are closed with a real-Chromium integration test showing that all
   non-loopback and loopback traffic is counted by the egress proxy.
2. Runtime verification that with the proxy and `disable_non_proxied_udp` the
   Chromium process sends no UDP (e.g. `ss`/packet capture while a page runs an
   `RTCPeerConnection` against public STUN) and exposes no local IP in candidates.
3. WebRTC is allowed only in `required` mode with an HTTP(S) proxy (no SOCKS5),
   behind a per-workspace opt-in, and TURN/STUN hosts must be allowlisted https origins.
4. F3 is closed (probe `/_egress_ready`, re-probe during sessions) and F6/F7
   limits exist, since WebRTC via TCP relays creates long-lived tunnels.
5. F4 is fixed and covered by a two-request keep-alive test, so the session token
   cannot reach an upstream origin.
6. SECURITY.md is updated with the final residual list (TURN-over-TLS content is
   opaque to the proxy; data channels remain a covert channel).

### Short summary

No P1. Four P2 findings (F1 missing proxy credentials, F2 possible loopback bypass
with LNA checks disabled, F3 weak health check, F4 unfiltered keep-alive requests
including `Proxy-Authorization` leakage) and six P3 hardening items (F5-F10). Core allowlist/SSRF/DNS-pinning behavior verified OK; existing 59
related tests pass. WebRTC: not recommended until the preconditions above are met.

## F6–F8 hardening status (implemented)

- F6: global and per-token connection caps (`503`, `connection-limit`).
  Sockets rejected at the global cap are not tracked in `openClients` and may
  hold a handle for up to the 2 s fallback destroy.
- F7: total request-head deadline (`408`), DNS lookup timeout (a timed-out
  `dns.lookup` still occupies a libuv thread until it returns; only the
  proxy-side wait is bounded), header cap and deadline on the WebSocket
  upgrade response path (`502`), and `pause`/`drain` backpressure on the
  WebSocket tunnel. Rejections use a flush-aware close (`end()` plus an
  unref'd 2 s fallback destroy).
- F8: `maxHeaderBytes` is also enforced after parsing (`431`). A per-session
  byte budget was intentionally not added.
