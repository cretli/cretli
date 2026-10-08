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
| `CRETLI_EGRESS_MAX_HEADER_BYTES` | `65536` | Max request/response header block size |

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
