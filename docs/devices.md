# Devices

A server-side registry of test devices (phones and computers) that agents can
read through MCP and use for consent-gated measurement runs. There is no
Devices management panel; measurement consent cards appear in the chat.

## Registry

`data/devices.json` (`store.devices`) holds, per device: id, name, platform
(`android|macos|windows|ios`), connection kind (`adb-wifi|chrome-cdp`), host,
port, optional `cdpPort` (local forward, default 9222), adb serial, workspace
scope (empty = global), notes and hardware facts (GPU, CPU cores, DPR, model) refreshed from CDP
(`SystemInfo.getInfo` plus `Runtime.evaluate` of `devicePixelRatio` and
`hardwareConcurrency`) after a successful probe; a failed refresh keeps the
previous facts. The adb transport is always `host:port`; a stored serial that
differs from it is rejected, so adb never targets an unvalidated endpoint. Only whitelisted fields are
stored; the ADB pairing code is typed by a human and is never persisted.

## Connection assistant

`POST /api/devices/connect-help` and `GET /api/devices/:id/connect-help` return
`connect` and `cleanup` text blocks plus hints for macOS, Windows and Android.
Cretli never executes them. Hints cover the pairing window closing when you
switch apps, no mDNS through WSL, Windows `adb.exe` forwards being invisible in
WSL, Android lacking `/json/new`, and Chrome 136+ ignoring the debug port on the
default profile.

## Live status

`GET /api/devices/:id/status` and the `device_status` MCP tool return one of
`reachable`, `asleep`, `chrome-down`, `unreachable`, `adb-missing`, `timeout`.
`adb` runs through `execFile` with an argv array and a timeout. The binary is
the `devicesAdbPath` setting (or `CRETLI_ADB_PATH`), default `adb`.
`POST /api/devices/:id/launch-chrome` (REST only) starts Chrome via
`adb shell am start`.

## Network guard

Endpoints must be loopback or private (RFC1918 / ULA). Link-local, cloud
metadata, other special ranges and public addresses are refused. A hostname is
resolved once and the connection uses that address. Known limit: CGNAT
`100.64.0.0/10` (Tailscale-style addresses) is classified as special by
`lib/browser/url-policy.js` and is refused; widening it is a policy decision.

## MCP

`device_list` and `device_status` are read-only and return global devices plus
those scoped to the calling chat's workspace. `device_run` is mutating and blocked in plan/read-only mode;
`device_runs` is read-only.

## Measurement runs

Register a desktop Chrome instance with a separate profile and set
`separateProfile: true` through the create/update REST API. macOS and Windows
runs without it return `profile-not-separate`. This flag is self-declared;
Cretli cannot verify the profile. Browsers without
`Target.createBrowserContext` support fail closed with `context-unsupported`.
Many Android Chrome configurations do not support private CDP contexts and
therefore cannot run measurements through this feature.

`device_run { id, scriptPath, args? }` runs a workspace-relative `.mjs` or
`.cjs` entry file. `id: "all"` visits visible devices sequentially; a failed
device does not prevent later devices from running. The first SHA-256/device
pair needs a chat consent card; the MCP call waits at most 25 seconds and
returns `consent-pending` with card ids while waiting. Answer it and repeat
the same call to retrieve the result. Approval lasts for this server process
and this device/hash; changing entry content asks again. Denial returns
`consent-denied`, and silence for 120 seconds returns `consent-timeout`.

REST clients use `POST /api/devices/:id/runs?workspaceFolder=…` with
`{ scriptPath, args? }`. It returns 202 with an `awaiting-consent` run and
`consentId`, then resumes automatically after approval.
`GET /api/devices/run-consents` and authenticated
`POST /api/devices/run-consents/:consentId { decision: "once"|"deny" }`
operate on API cards only. Chat cards use authenticated
`GET /api/devices/chat-run-consents?chatId=…` and
`POST /api/devices/chat-run-consents/:consentId { chatId, decision }`;
the two scopes cannot answer each other's cards. Widget/integration callers
cannot answer consent through these routes.

The preflight is passive: it reads only version information and Android power
state. `device-asleep`, `device-chrome-down`, `device-unreachable`,
`device-adb-missing` and `device-timeout` refuse measurement and record no
metrics. The ordinary status endpoint still inspects an existing page to
refresh hardware facts. Runs collect CPU cores and DPR only from their own tab.

The entry receives `CRETLI_DEVICE_CDP_URL` (a one-use loopback WebSocket proxy),
`CRETLI_DEVICE_SYSTEM_INFO` (GPU, CPU cores, DPR, model, refresh timestamp),
`CRETLI_DEVICE_SCRIPT_DIR` and `CRETLI_DEVICE_SCRIPT` (display path).
It must print one JSON object on stdout:
`{"metrics":{"durationMs":123},"screenshots":["<base64 PNG>"]}`.
Screenshots are optional. Timeout is 60 seconds, combined stdout/stderr is
limited to 8 MiB, entry size to 1 MiB. Failures include `script-timeout`,
`output-limit`, `script-error`, `invalid-output`.

History persists in `device-runs.json` (`store.deviceRuns`) and owned
`device-run-screenshots/` files. Retention keeps at most 200 records and
200 MiB of screenshots, evicting oldest records together with their files.
`device_runs { deviceId?, before?, after? }` lists workspace history or
compares two run ids (same entry path, including changed hashes) with
per-metric before/after/delta values, across devices or before/after changes.
REST: `GET /api/devices/runs?workspaceFolder=…&deviceId=…`,
`GET /api/devices/runs/compare?workspaceFolder=…&before=…&after=…`,
and `GET /api/devices/runs/:runId/screenshots/:name?workspaceFolder=…`.

## Security: trust model

Measurement scripts are trusted host code, not a sandbox. They run unsandboxed
as the Cretli host user and can access that user's filesystem, processes and
network. Consent is explicit authorization of these host privileges, not
just browser access. Review scripts before approving. The proxy restricts
CDP access but does not stop trusted host code discovering endpoints itself.

Each run creates a fresh browser context and its own target, closes the target
and disposes the context on success, script failure or timeout. Only an explicit
CDP method allowlist is forwarded; all Target, Tracing, SystemInfo, cookie,
Storage and browser traffic except Browser.getVersion is denied to the script.
Responses are id-remapped and events are limited to the run session.
No owner-tab enumeration or attachment is available. Hardware is projected
before it enters env/history; raw SystemInfo (including commandLine) is discarded.

Page.navigate accepts only HTTP(S) and about:blank. This is hygiene, not a
navigation security boundary: Runtime.evaluate can navigate using location.
The script has full JavaScript privileges on its private page.

Paths must be relative to the workspace; traversal, absolute paths, symlink
escapes, non-regular files, other extensions and inline script text are refused.
The entry is read once and its exact SHA-256-approved bytes execute with
`node -` through stdin, an argv array and `shell:false`.
The working directory is the entry directory; cwd does not enable relative
imports. Relative imports are unsupported; use explicit absolute imports where
needed. Imported files are not hashed or covered by entry-content consent.
