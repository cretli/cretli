---
name: cretli-delegation-measure-baseline
description: Execute a Cretli delegated "implement" leaf whose deliverable is REAL numbers from a live browser/telemetry scenario (not a code fix) — run the gate tests and leave instrumentation untouched if green, then audit whether a genuine live measurement is actually obtainable (emission site → persisted sink → server/auth reachability → workload fidelity) before defaulting to BLOCKED, and NEVER fabricate the baseline that a downstream "before/after" comparison depends on.
source: auto-skill
extracted_at: '2026-10-05T13:07:23.408Z'
---

# Cretli delegated MEASUREMENT / baseline leaf (executor, edit allowed)

Companion to **cretli-delegation-implement** — read that first for the shared mechanics
that still apply verbatim: the `[TASK]` scope lines are binding, the terminator must appear in
the *chat* response too, never start another delegation, "**keep todo status doing**" means do
not call `todo_update` (verify read-only with `todo_show` and quote the observed status+timestamp),
report language follows the user-authored material (Polish TODO body → Polish report), and the
`delegation_reply` happy path is `delegation_id` + `reply_kind=final_report` + `task_outcome` +
stable `idempotency_key` and NO `attempt_id`/`run_id` (queued `status=queued to=<parent>` without CONFLICT).

**Trigger that makes this leaf different:** the deliverable is not "fix a finding" but
"collect PRAWDZIWE (real) numbers from a scenario" — e.g. a sidebar render/presence baseline
instrumented behind `isUiFreezeTraceActive()` / `traceUiFreeze` (`?uiFreezeDiag=1` / localStorage
`cretli-ui-freeze-diag`), where the acceptance is "liczby zapisane w body todo + instrumentacja za
flagą". The `[TASK]` almost always pre-authorizes the escape hatch: *"Nie wymyślaj liczb. Jeśli nie
da się odpalić żywej sesji, VERDICT: BLOCKED i napisz konkretnie czego brakuje (przeglądarka, serwer,
flaga)."* The whole skill is about distinguishing a **genuine** block from a reflexive one, and about
never letting a green-test leaf pass on invented data.

## Step 1 — run the gate tests FIRST, and hold the "don't rewrite if green" line
The task usually lists the exact suites, e.g.
`node tests/sidebar-render-metrics.test.js` + `node tests/chat-list-live-sync.test.js` +
`node tests/ui-freeze-trace.test.js`. Run all three verbatim (these are plain assert scripts that
print `<file>.test.js OK` on exit 0, not `node --test` counts). **"Instrumentacja JUŻ JEST w kodzie.
Nie przepisuj jej, chyba że testy są czerwone"** is binding: if green, make ZERO edits and say so in
the report (it proves the prior implement round holds and the blocker is purely the measurement half,
not FAIL).

## Step 2 — do NOT reflexively declare BLOCKED; audit feasibility empirically
"Headless CLI agent" does not mean "unmeasurable". Probe the actual environment before concluding.
Verified 2026-10-05 on a Linux Cretli box:
- **Browser/display:** `echo $DISPLAY / $WAYLAND_DISPLAY`; `which chromium google-chrome firefox`;
  grep `package.json` deps for `playwright|puppeteer|jsdom`; `ls node_modules | grep -iE 'playwright|puppeteer'`.
  A chromium + Playwright + a Wayland/X display CAN exist here → a live session is technically launchable,
  so BLOCKED needs a sharper reason than "no browser".
- **Which app is which:** the port you assume is Cretli may be something else — `curl -s http://127.0.0.1:8080/api/auth-status`
  returned a different SPA's `<title>` ("Artur Tomaszewski"), NOT Cretli. Map it properly:
  `ss -ltnp | grep -iE 'node|bun|:3|:8'`, then `ps aux | grep -E 'server\.js|start-server'`.
  Confirm a live server's workspace with `curl -sk https://127.0.0.1:3011/api/health` (this repo runs HTTPS by
  default: `http` probe → `000`, `https -k` → `200`) and its data dir via `readlink -f /proc/<pid>/cwd`.
- **Flag plumbing:** read `app_front/lib/uiFreezeTrace.js` — metrics emit ONLY through `logger.log` inside a browser
  whose `isUiFreezeTraceActive()` is true; there is no server-side equivalent of client render timings.
- **Capture surface:** the only durable sink is the browser's remote flush `POST /api/client-debug-log`
  (`initUiFreezeTrace` needs `?debugRemote=1`, wired in `logger.js`/`pageResumeCleanup.js`) which appends to
  `data/client-debug.log` — so numbers from a genuine flagged session ARE readable, off disk, server-side.

## Step 3 — the sink is the decisive check: REAL observed numbers are reportable, invented ones are not
Search the persisted sink for the actual event needles before concluding nothing exists:
`grep -aoE 'sidebar:(snapshot|render-rebuild|render-skip|presence-dup|chats-changed)' data/client-debug.log | sort | uniq -c`
plus `stat -c '%y %n' data/client-debug.log` and `grep -aoE 'GET [^ ]*api/chats' … | wc -l`.
- If the log already carries `sidebar:snapshot`/`render-rebuild` lines from a real flagged session, those are
  **legitimate measurements** — transcribe them (do not recompute by hand what the meter already aggregated).
- Observed 2026-10-05: the log was **stale (mtime ~2 months old) with ZERO `sidebar:*` events** → no flagged browser
  ever fed it. That, not "no browser", is the honest root of the blocker.
- Cross-check the built bundle actually contains the instrumentation (front ships as `public/dist/app/index.bundle.js`
  with inline sourcemaps; grep the bundle for `render-rebuild` / the leaf module) so you don't blame a phantom gap —
  the code was present; only the live-session data was missing.

## Step 4 — the workload-fidelity + authorization wall (why an "available browser" still can't measure)
The scenario demands REAL concurrent load (e.g. "3–5 pracujących czatów, w tym delegacja z subczatami,
watcher w `observe`, sidebar ~60 s, desktop i mobile `backgroundWsMax=0`"). Presence-frame/min, cross-socket
seq-dup %, and full-rebuild/min are only truthful under genuinely-running chats. Three walls, each verified:
1. **Auth:** production is password-gated (`data/auth.json` = hash+salt, no `DISABLE_AUTH`/no-auth in `.env`,
   `cr-login-app` active). A cookie-free executor has no operator password and **must NOT bypass auth or read
   token/secret files** to hijack a live session.
2. **Can't spawn the load:** reproducing it on an isolated `playwright.config.js` scratch server
   (`CHAT_E2E_PASSWORD`, ephemeral HOME/data) still needs `delegation_start` for "delegacja z subczatami"
   (HARD-FORBIDDEN from an executor chat) and real parallel runs / a watcher that actually claims todos.
3. **Mocking = fabrication-by-proxy:** feeding stub presence frames produces numbers-artifacts of the mock that
   would poison the entire "przed/po" comparison the downstream sub-task depends on. That is exactly the forbidden
   "wymyślanie liczb". **Correct move: BLOCKED, not a plausible-looking table.**

## Step 5 — verdict discipline for this leaf type
- Tests green + instrumentation wired + measurement genuinely unobtainable ⇒ **VERDICT: BLOCKED**
  (`task_outcome=blocked`) — NOT FAIL (code is fine) and NOT PASS (no real data). Say plainly which half is done:
  "instrumentacja zweryfikowana i zielona; POMIAR NIE WYKONANY".
- **Do NOT write a `## Baseline` section into the todo body** — the task's condition is "Jeśli liczby są prawdziwe";
  unmet, so no `todo_update` at all (also keeps status `doing`).
- **Do NOT mark any parent hypothesis refuted/confirmed** without data; instead state "żadna hipoteza nie zweryfikowana",
  and do not edit sibling leaves.
- Name the **exact missing ingredient** and a concrete unblock (pick one): (a) an operator browser session logged into
  the target workspace with `?uiFreezeDiag=1&debugRemote=1`, sidebar open ~60 s under real traffic → re-read
  `data/client-debug.log` and transcribe; (b) parent authorization to build an isolated environment WITH real runs +
  permission to create a delegation; (c) the parent/human runs the documented manual scenario.
- Sub-task "reuse this same instrumentation for the after-measurement" means the blocker is reusable intel: leave the
  capture recipe (event needles + sink path + flag URL) in the report so the same audit doesn't restart from zero.
