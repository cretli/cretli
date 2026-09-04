# Scripts

Helper scripts for running, configuring, and testing Cretli.

## User-facing

| Script | Purpose |
|--------|---------|
| `generate-ssl-cert.js` | Generate a self-signed TLS cert (`data/key.pem`, `data/cert.pem`) for HTTPS. Set `SSL_IP=<lan-ip>` to embed your LAN IP. |
| `wsl-port-forward.ps1` | Windows PowerShell (as Admin): forward the server port from Windows to WSL2 so a phone on the LAN can reach it. `-Port <n>` to customize. |
| `wsl-port-forward.bat` | Windows batch wrapper for the same port-forward. |
| `start-server-sdk.sh` | Convenience launcher for the server with SDK defaults. |
| `start-termux.sh` | Termux phone-as-server launcher (`npm run start:termux`). Wake-lock + HTTPS. |
| `self-update.sh` | Settings → Account updater: fetch + `reset --hard` + npm + `node-pty` rebuild + prod front. |

## Developer / testing

| Script | Purpose |
|--------|---------|
| `test-fork-title.js` | Manual test for chat title derivation (one-shot agent). |
| `test-generate-chat-title.js` | Manual test for `/api/generate-chat-title`. |
| `test-upload-screenshot.js` | Manual test for screenshot upload + sharp re-encode. |
| `opencode-harness-e2e.mjs` | Live OpenCode harness smoke (provider response, no user echo). |
| `run-unit-tests.mjs` | Umbrella runner for every `tests/*.test.js` (`npm test`). |
| `capture-status-flow-from-chat.js` | Capture status-flow fixtures from a live chat. |
| `restart-server-helper.js` | Helper used by `/api/dev-actions` to restart the server. |
| `task-restart-server.sh` | Helper used by the VS Code task to restart the server. |

Run the automated suite with `npm test` (see root [README](../README.md)).
The umbrella script is `scripts/run-unit-tests.mjs` — it runs every `tests/*.test.js`.

## Playwright E2E chat tests

Functional chat tests are now split into two profiles:

- `npm run test:e2e:mock` — stable UI sanity (no external provider keys required).
- `npm run test:e2e:live` — full live scenarios for `sdk`, `opencode`, `openrouter` (`send prompt -> wait response -> assert state` + reconnect checks; requires configured provider keys).

Useful commands:

- `npm run test:e2e:browsers` — installs Chromium for Playwright.
- `npm run test:e2e:live:opencode` — runs the dedicated OpenCode harness smoke script.
- `npm run test:e2e:live:opencode:alpha-free` — runs the full UI flow on `opencode/x-preview-f-free` (response + interactive question + permission attempt).
- `npm run test:e2e:live:sdk:composer-25-fast` — runs dedicated SDK live flow on `composer-2.5::fast=true` (strict: fallback to non-fast model fails the test).
- `npm run test:e2e:live:sdk:recovery` — runs SDK timeout/recovery scenario with aggressive idle budget (`sleep` tool call + `run_stuck_auto_recovery` diag assertion).
- `npm run test:e2e:sdk-contract` — runs lightweight contract checks for SDK diag/run-status helper normalization.

Optional environment variables:

- `CHAT_E2E_PASSWORD` — login/setup password used by E2E tests (default: `chat-e2e-pass-123`).
- `CHAT_E2E_PORT` / `CHAT_E2E_BASE_URL` — override Playwright test server URL.
- `CHAT_E2E_LIVE_TIMEOUT_MS` — live response timeout (default: 180000).
- `CHAT_E2E_MOBILE=1` — run with mobile viewport (390x844).
- `CHAT_E2E_CHROMIUM_EXECUTABLE_PATH` — custom Chromium path when `playwright install` is unavailable on your distro.
- `CHAT_E2E_OPENCODE_MODEL` — OpenCode model used in dedicated live scenario (default: `opencode/x-preview-f-free`).
- `CHAT_E2E_SDK_FAST_MODEL` — SDK model used in dedicated composer-fast scenario (default: `composer-2.5::fast=true`).
- `CHAT_E2E_SDK_RECOVERY=1` — enables SDK recovery-tagged Playwright tests.
- `CHAT_E2E_VIDEO=1` — enable Playwright video on failure (requires bundled ffmpeg).
- `CHAT_E2E_HOME_DIR` — isolated HOME for E2E server process (default: `.tmp/e2e-home`).
- `CHAT_E2E_WORKSPACE_FOLDER` — workspace folder forced in chat creation for live scenario (default: `process.cwd()`).
- `CRETLI_SDK_RUN_IDLE_TIMEOUT_MS` / `CRETLI_SDK_RUN_AUTO_RECOVERY_GRACE_MS` — tune SDK auto-recovery thresholds (used by recovery live test profile).

### Local reproduction checklist

1. Install dependencies: `npm install`.
2. Install browser (if supported): `npm run test:e2e:browsers`.
3. Run stable profile: `npm run test:e2e:mock`.
4. Run live profile (with provider keys configured): `npm run test:e2e:live`.

### How to read failures

- Playwright artifacts are saved in `test-results/playwright/` (trace + screenshot, plus video when `CHAT_E2E_VIDEO=1`).
- Open the trace with: `npx playwright show-trace <path-to-trace.zip>`.
- Live harness failures also attach `status-tail-<chatId>.json` and `diag-<chatId>.json` with backend diagnostics.

### SDK production-ready checklist

- Strict fast model is enforced: `composer-2.5::fast=true` does not silently fallback in strict flow.
- `diag` exposes requested/effective model and fallback audit data.
- Live SDK suite covers response, cancel path, reconnect parity, and optional timeout recovery.
- Mock sanity + contract tests (`test:e2e:sdk-contract`) pass before release.
- CI gate is available via `.github/workflows/sdk-live-gate.yml` (nightly + manual dispatch). It runs only when `CURSOR_API_KEY` secret is configured.
