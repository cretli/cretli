# Frontend integration smoke

`runIntegrationGates` runs the whole-app custom-element import check for every
frontend change (including deletions). After the other candidate gates pass,
`runFrontendSmoke` builds the candidate and runs the project's Playwright against
a fresh server. It never reuses a running development server. Runtime, auth,
home and browser artifacts are isolated in a temporary directory outside `data/`.

The smoke opens a chat without sending a prompt, requires the rendered mode bar
and sidebar, opens a real terminal and verifies a shell command round trip, switches
Todo tabs, opens Settings, and returns to Chat. Page errors, console errors and
missing-key warnings fail the test. Failure retains build/browser logs, console
diagnostics, a screenshot and a Playwright trace. A browser failure is
fail-closed: `runAutomaticIntegration` requires
`suspendAfterSmokeFailure` to durably pause the workspace before it may reject
the leaf. The callback receives the todo, result, artifact path and original
error so the workspace-watcher adapter can persist the pause, notify the
operator and create an evidence todo. Successful runs remove their temporary
files.

Run the complete build and browser gate from the repository root:

```sh
node --input-type=module -e 'import { runFrontendSmoke } from "./lib/integration/frontend-smoke.js"; await runFrontendSmoke({ candidate: process.cwd() });'
```

Playwright needs an installed Chromium. `CHAT_E2E_CHROMIUM_EXECUTABLE_PATH` may
select a system executable; `CRETLI_UI_SMOKE_PORT` may select an unused port.
Missing browsers and occupied ports fail the gate rather than skipping it.
To reuse a completed build during development:

```sh
CRETLI_UI_SMOKE_DIR=$(mktemp -d) node node_modules/playwright/cli.js test --config tests/ui-smoke/playwright.config.js
```

Focused regression checks:

```sh
node tests/custom-elements-imported.test.js
node tests/ui-smoke/custom-elements-gate.test.js
node tests/ui-smoke/frontend-smoke.test.js
```

## Workspace-watcher adapter boundary

The automatic Git integrator checks a disposable candidate before publishing
its commit, so a smoke failure leaves HEAD unchanged and there is no commit to
revert. The caller in `lib/workspace-watcher-integration.js` must provide
`suspendAfterSmokeFailure`: set the existing watcher `paused` state with a
smoke-specific stop reason, emit the existing watcher notification, and create
the evidence todo before returning `{ ok: true }`. The existing Watcher pause
view supplies the resume control. That adapter is intentionally outside this
leaf's `lib/integration/` scope; until it is wired, a browser failure reports
`smoke_failure_handler_missing` and does not reject or publish the leaf.
