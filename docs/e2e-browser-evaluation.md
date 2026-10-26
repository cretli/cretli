# E2E and UI preview: one browser? Evaluation

Status: evaluation only, no behaviour change. Findings verified against the code
on 2026-10-25.

## Question

Agents sometimes report "no Playwright browser downloaded in this environment"
and fall back to `/usr/bin/chromium` for e2e specs, while the built-in Browser
(`browser_*` MCP tools) works. Should the two paths be unified by (1) keeping
the split and standardising Chromium detection, (2) extending the built-in
Browser with a CDP endpoint for the test runner, or (3) adding Playwright as a
dependency with a shared browser download?

## 1. What each path does today

### Built-in Browser (`lib/browser/`, MCP `browser_*`)

- Server-side headless Chromium driven by **`playwright-core`**, which is
  already a **runtime** dependency (`^1.63.0`). `@playwright/test` is a
  devDependency and never on the server path (`docs/browser-runtime.md`).
- Binary resolution (`lib/browser/runtime-detect.js`, `detectBrowserRuntime`):
  `playwright.chromium.executablePath()` if the file exists, else
  `CRETLI_BROWSER_EXECUTABLE_PATH`, else the first of
  `SYSTEM_CHROMIUM_CANDIDATES` (`/usr/bin/chromium`, `chromium-browser`,
  `google-chrome`, `google-chrome-stable`, `/opt/google/chrome/chrome`).
  A system fallback is reported as `usingSystemChromium`.
- Launch: `chromium.launch({ headless: true, args, env, proxy? })` with
  `CHROMIUM_BASE_ARGS` (WebRTC UDP lock-down), a scrubbed environment
  (`buildChromiumProcessEnv`), optional egress proxy, and `--no-sandbox` only
  with `CRETLI_BROWSER_ALLOW_NO_SANDBOX=1`.
- Each workspace session gets an isolated `browser.newContext()` with
  `serviceWorkers: 'block'`, no persisted state without consent, and every
  request passes the SSRF/URL policy (`url-policy.js`; Cretli's own origin
  only with `allowSelfOrigin`).
- Agents and the user's Browser panel interact through MCP tools, the
  `/ws-browser` WebSocket (screencast) and HTTP routes, authenticated by the
  Cretli session.

### Playwright e2e (`playwright.config.js`, `playwright.*.config.js`, `tests/ui-smoke`)

- Use `@playwright/test`'s own `chromium.launch` per worker; each config boots
  its own isolated Cretli server (`webServer`) on its own port and data dir.
- Executable selection is **duplicated and inconsistent**:
  - `playwright.config.js`: `CHAT_E2E_CHROMIUM_EXECUTABLE_PATH` or undefined
    (Playwright's own download; no system fallback).
  - `playwright.chat-history-sync.config.js`: env (if it exists), else the
    system candidates; never Playwright's download.
  - `tests/ui-smoke/playwright.config.js`: env, else Playwright's download if
    present, else system candidates (the most complete variant).
- npm scripts use `PLAYWRIGHT_BROWSERS_PATH=0` (download inside
  `node_modules`), CI installs via `npx playwright-core install --with-deps
  chromium` into the default cache (`.github/workflows/ci.yml`,
  `sdk-live-gate.yml` runs `test:e2e:browsers`).
- Root cause of the reported failure: downloads live per user
  (`~/.cache/ms-playwright` or `node_modules/playwright-core/.local-browsers`),
  so a session running as another user (for example `root`) does not see them,
  and configs without a system fallback fail with "Executable doesn't exist".

### Running the mock e2e locally

The mock specs (`tests/e2e/chat-mock.spec.js`, `new-chat-availability.spec.js`)
boot their own server from `playwright.config.js`. To run them without touching a
dev server or your real data, point every directory at a throwaway location:

```bash
CHAT_E2E_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
CHAT_E2E_PORT=3871 \
CHAT_E2E_DATA_DIR=/path/to/repo/.tmp/e2e-data-a \
CHAT_E2E_AUTH_DIR=/path/to/repo/.tmp/e2e-auth-a \
CHAT_E2E_HOME_DIR=/path/to/repo/.tmp/e2e-home-a \
  npx playwright test tests/e2e/chat-mock.spec.js --reporter=line
```

- `CHAT_E2E_PORT`: port of the e2e server (default `3311`); pick a free one.
- `CHAT_E2E_DATA_DIR`: server data dir (default `.tmp/e2e-data`); keep it away
  from the real `data/` directory.
- `CHAT_E2E_AUTH_DIR`: auth/test-data dir (default `.tmp/e2e-auth`).
- `CHAT_E2E_HOME_DIR`: `HOME` for the server process (default `.tmp/e2e-home`);
  create it first (`mkdir -p`).
- `CHAT_E2E_CHROMIUM_EXECUTABLE_PATH`: system Chromium to launch when the
  Playwright download is not visible to your user.

Gotchas:

- **`reuseExistingServer` trap.** Outside CI the config sets
  `reuseExistingServer: true`: if anything already listens on
  `CHAT_E2E_PORT`, Playwright silently tests *that* server, with its data and
  settings, instead of a clean one. Always use a free port.
- A fresh data dir has no workspace, no API keys and every harness is "not
  ready". The mock specs call `ensureMockNewChatEnvironment` (in
  `tests/e2e/chat-e2e-helpers.js`), which stubs the Z.AI and OpenCode status and
  model endpoints and seeds a workspace, a placeholder OpenCode key and the
  dismissed first-run flag. New specs that open the new-chat modal need it too.
- The front must be built (`npm run build:front`) in the checkout you test; a
  missing `public/dist/app` renders a blank page.
- Shell variables such as `CRETLI_BIND=0.0.0.0` leak into the spawned server and
  make it refuse to start without a password; unset `CRETLI_*` before running.

## 2. External Chrome over CDP

The default Browser remains headless, but `CRETLI_BROWSER_CDP_URL` enables an
external user-owned Chrome profile. The runtime probes an HTTP(S) endpoint through
`/json/version`, rejects credentials, requires loopback/private/link-local DNS
answers (or an explicitly allowlisted hostname with the same restriction), and
connects to the verified literal IP. `ws://`/`wss://` is accepted only as the
websocket returned by `/json/version`; the input endpoint must be HTTP(S), so
the probe cannot silently lose HTTPS semantics.
Attaching to the profile requires `allowExternalBrowser` in the current workspace's
Browser policy (default off). CDP is unavailable with the `proxy` or `required`
network boundary because the external browser cannot be forced through Cretli's proxy.

External sessions reuse the first context but never adopt or route unrelated
user tabs. Only pages created by Cretli receive page-level SSRF and local-login
routing, CDP service-worker bypass and WebSocket policy; popups from those pages
are closed, while the external browser/context is never closed. HTTPS probes use
the verified IP for TLS, so its certificate must cover that IP; validation is not
disabled. Launch-only resolver/WebRTC flags cannot be injected into external
Chrome, leaving WebRTC/TURN as a documented residual risk. The API exposes
`runtime.mode: "external-cdp"` and `runtime.connected`; `/ws-browser` remains a
Cretli protocol, not a CDP proxy.

## 3. Options compared

| | 1. Keep split + one resolver | 2. Expose CDP from the built-in Browser | 3. Add Playwright dep + shared browsers path |
|---|---|---|---|
| What | One shared `resolveChromiumExecutable()` (env, pinned Playwright, system) used by every config | Opt-in external Chrome endpoint validated by Cretli, then `connectOverCDP` | Ship browsers in a user-independent `PLAYWRIGHT_BROWSERS_PATH` |
| Effort | Small (about 0.5 day): extract helper (e.g. `lib/` or `scripts/`), import from 6 configs, add a unit test | Large (about 2-4 weeks): endpoint lifecycle, auth, per-test context isolation, fixtures, tests, docs | Small-medium (about 1 day) for path + install script and docs |
| Cost | No new code paths at runtime, no download | Ongoing maintenance of a second Browser mode; CDP semantics differ from launching (no per-test launch options, tracing/video limits, `connectOverCDP` fidelity is lower than `launch`) | `playwright-core` is already a dependency, so there is **no new package**; cost is a few hundred MB of disk and keeping browser revisions matched with two Playwright versions (core `1.63.0` vs test `1.62.1` already differ, see CI comment) |
| Risk | Low; still two Chromium builds possible (system vs pinned) so rare UI differences | High; e2e would depend on the product Browser state, crash recovery, policy/egress limits and relaunch logic, making tests flaky and coupling product and test lifecycles | Low-medium; revision mismatch (the 1.62.1 vs 1.63.0 problem), shared dir permissions |
| Security | No change | High but bounded by endpoint DNS/IP validation, page-level SSRF routing, local-login scoping, one-session exclusivity and no unrelated-tab adoption. The user must still protect the Chrome debugging endpoint. | Neutral; a shared writable browsers dir should be read-only for non-owners (supply-chain integrity) |
| CI impact | None (CI already installs Chromium) | CI would need to start the Browser mode inside the test server and wait for it; larger change to every workflow | None if CI keeps its default cache install; only local/multi-user hosts change |
| Fixes the reported symptom | Yes, if the resolver also covers the user-independent path | Yes, but disproportionately | Yes, for hosts that run the install once |

Notes:

- The "no new dependency" rule from the todo is largely moot for option 3:
  Playwright (core and test) is already in `package.json`. What would be new is
  an operational convention (shared download location), not a package.
- Option 2 is intentionally not the default e2e path: the external profile is
  user-owned and shared, while e2e still needs isolated contexts and fixtures.

## 4. Recommendation

**Choose option 1 for the default isolated e2e path. External CDP is an opt-in
product runtime feature for a user-owned Chrome profile, not a replacement for
isolated e2e browser startup.**

1. Extract a single `resolveChromiumExecutable()` and use it from
   `playwright.config.js`, `tests/ui-smoke/playwright.config.js`,
   `playwright.chat-history-sync.config.js` and the delegation configs.
   Explicit order: `CHAT_E2E_CHROMIUM_EXECUTABLE_PATH` (if it exists), then
   `CRETLI_BROWSER_EXECUTABLE_PATH`, then Playwright's own download for the
   installed Playwright version, then the system candidates (reuse
   `SYSTEM_CHROMIUM_CANDIDATES` from `lib/browser/runtime-detect.js` so the
   Browser and e2e agree). Add a unit test and keep behaviour for a set env
   variable unchanged.
2. For hosts used by several users, document (in `docs/browser-runtime.md`) a
   one-time `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx playwright-core
   install chromium` with a read-only shared directory; this needs no new
   dependency and no code change.
3. Keep the built-in Browser for preview and agent debugging, and Playwright
   for e2e. They share a driver library, and after step 1 they share
   executable discovery, which is the real overlap.

Follow-up todo (needs the user's go-ahead, since it touches configs outside
this evaluation): "Share `resolveChromiumExecutable` across Playwright
configs". Estimated at half a day including a test.

Agent and operator guidance (`.agents/skills/cretli-browser/SKILL.md`,
OPERATOR-PLAYBOOK) is unchanged by this conclusion: agents keep using
`browser_*` for previews and the project's Playwright configs for e2e, so
neither file was edited.
