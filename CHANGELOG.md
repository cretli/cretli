# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Opt-in cap on live OpenCode instances.** `CRETLI_OPENCODE_MAX_INSTANCES` or
  the `opencodeMaxInstances` setting caps simultaneously live `opencode serve`
  processes. Empty/`0`/invalid means no limit, so the default behaviour is
  unchanged. At the cap Cretli first closes the least-recently-used idle
  instance (`refCount === 0`); when every instance is busy the new chat is
  refused with the readable `opencode_instance_limit` code instead of killing
  active work, and the per-chat instance isolation is untouched. Delegation
  children can opt into a shorter idle window with
  `CRETLI_OPENCODE_DELEGATION_IDLE_MS`. `GET /api/diagnostics/server` reports
  `opencode: { live, pending, limit }`. Covered by
  `tests/opencode-instance-limit.test.js` and
  `tests/health-opencode-stats.test.js`.

- **Integrate a worktree from the Todo row menu.** The `⋮` menu of any node of a
  worktree tree now offers *Integrate with workspace*: it prepares the diff when
  needed and applies it to the logical working tree through the same guarded
  three-way merge the integration panel uses. Nothing is committed, pushed or
  merged at the Git level, a conflict is reported with the exact conflicting paths
  before any file is touched, and the task keeps its confirm/reject decision.
  `POST /api/todos/:id/integration` accepts `action=merge`, and every integration
  action now resolves the worktree owner from any node of the tree (Watcher keys
  the claimed leaf, manual starts key the root), so a tree closed as `done`
  without integration is no longer stranded. `GET /api/todos` reports a per-item
  `worktree` summary. Covered by `tests/todo-manual-worktree.test.js`.

- **Explicit worktree starts from dirty workspaces.** `block` remains the
  default; manual Todo starts can choose HEAD (with skipped paths shown) or a
  snapshot of tracked and untracked non-ignored changes. Snapshots use a
  temporary Git index, are pinned to a Cretli ref, and retain their base across
  retries. The integration panel can apply the reviewed patch with a guarded
  three-way merge that keeps the user's index unchanged. Cleanup removes the
  snapshot ref. Covered by `tests/worktree-manager.test.js` and
  `tests/workspace-watcher-integration.test.js`.

- **Machine-level memory and orphan safety net.** `scripts/memory-orphan-monitor.js`
  (run by a systemd timer or cron, about once a minute, outside the server so it
  survives a server kill) is read-only — it never signals a process. It alarms on
  low `MemAvailable` (critical/warning thresholds), swap pressure (used over half
  or a fast rise), orphaned `opencode serve` processes whose registry owner PID
  **and** `/proc` start time are dead (never `PPID == 1`, so WSL Relay
  re-parenting is handled), a high total OpenCode count, duplicate webpack
  watchers per project + config realpath, and new earlyoom kill events read with
  a journald cursor. Alarms go to `data/memory-monitor-alerts-YYYY-MM-DD.jsonl`;
  one alarm per episode is written and the server publishes them into the
  notification centre on start and every minute, so an alarm written while the
  server was down is visible after the next start. Thresholds are configurable
  through `CRETLI_MEMORY_MONITOR_*` variables; example units live next to
  `systemd/cretli.service.example`. Covered by `tests/memory-monitor.test.js`.

### Changed

- **In-process webpack HMR is opt-in.** `npm start` no longer mounts the
  `webpack-dev-middleware` compiler inside `server.js`; the default dev path is
  the external `npm run watch:front` CLI watcher plus the PWA update banner
  (which polls `/api/health` `frontAssetVersion`). Enable HMR only with
  `CRETLI_FRONT_HMR=1` (legacy `CURSOR_REMOTE_FRONT_HMR`, or `npm run start:hmr`).
  A 5-minute isolated measurement showed server RSS at ~164 MB with HMR off vs
  ~696 MB with HMR on. The dist watcher behind `/ws-front-build` is now on by
  default (`CRETLI_FRONT_HOT_FALLBACK=0` disables). `lib/front-hmr.js` and the two
  dev middlewares stay for a trial period before removal. Covered by
  `tests/front-hmr-mode.test.js` and `tests/front-hmr-default-off.test.js`.

- **Mistral harness** (`agentTransport: mistral`): chats through the Mistral API via the
  optional `@mistralai/mistralai` SDK with the shared host tool loop, Plan/Ask/Review
  tool gating, `GET /api/mistral/status` and `/api/mistral/models`, key and base URL
  from `MISTRAL_API_KEY` / `MISTRAL_BASE_URL` or Settings, default model
  `mistral-medium-latest`. Setup: `docs/mistral/SETUP.md`.

### Fixed

- **Mistral favorites are start-eligible for delegation.** `model_list("mistral",
  enabled_only=true)` returned nothing when the enabled models came from the
  live vendor catalog (ids absent from the static fallback) and no catalog
  snapshot existed, so `model_pick` and `delegation_start` could never choose
  Mistral. Enabled ids are now merged into the catalog, as for Claude. Covered
  by `tests/harness-catalog.test.js`.

- **Built-in tool loop no longer commits other repositories.** A Mistral chat asked
  to commit "all local changes" walked sibling checkouts by absolute path and
  committed and pushed them, because nothing tied the request to the chat
  workspace. The system prompt now names the workspace root and scopes
  commit/push requests to it, shared Cursor rules are framed as conventions
  whose projects are not part of the workspace, and the shell tool refuses git
  mutations aimed at a repository outside the workspace
  (`lib/agent-harness/foreign-repo-guard.js`; opt out with
  `CRETLI_ALLOW_FOREIGN_REPO_GIT=1`). Covered by `tests/tool-executor.test.js`.

- **No harness, MCP or PTY child is left behind after a server kill.** Beyond
  OpenCode, the server now owns every long-lived child in a single registry
  (`data/child-processes.json`): PTY sessions (terminal, task runs, agent runs,
  the front-build watch), MCP stdio bridges, review-verify test runners and the
  harness CLI children discovered under the server. Phase 1 of the shutdown
  handler SIGTERMs them synchronously and phase 2 escalates survivors to SIGKILL;
  after a `SIGKILL`/earlyoom the next start sweeps the registry and kills only
  orphans whose recorded owner is dead and whose `/proc/<pid>/stat` start time
  still matches, so a recycled PID is never touched. The deliberately detached
  restart helper is excluded by cmdline. Harness CLI and long-lived tool-shell
  children are registered at `spawn` time (not only on the 20 s discovery tick);
  phase 2 no longer sends a second SIGTERM after phase 1; orphan sweeps respect a
  total time budget. Verified in `tests/child-process-registry.test.js`; the spawn
  inventory lives in `docs/ARCHITECTURE.md` § Child process lifecycle.

- **OpenCode is stopped at the start of shutdown.** `kill <pid>` now SIGTERMs
  every owned `opencode serve` process group from the first, synchronous step of
  the `SIGTERM`/`SIGINT` handler (and from the production fatal paths), without
  waiting for the browser/delegation teardown that used to run first. A bounded
  second phase waits ~1.2 s, escalates survivors to SIGKILL and persists the
  result; a start still in flight closes the instance it spawned instead of
  publishing it after the map was drained. New chat runs and delegations are
  refused from the same first step. `scripts/task-restart-server.sh` now waits
  5 s before `kill -9`, above the worst-case escalation budget, so a dev restart
  no longer orphans OpenCode. Documented in `docs/TROUBLESHOOTING.md` §6.

- A worktree-mode start no longer dead-ends when the worktree layout was never
  configured. Both the manual Todo start and the autopilot cycle now **derive the
  layout from the workspace suggestion and persist it** before creating the
  worktree (`ensureWorktreeLayoutForStart`), so the per-workspace settings form
  is an optional override instead of a gate the operator has to find first. A
  workspace without a Git repository has no suggestion and keeps the existing
  fail-closed refusal. `prepareCommand` is still never invented. Covered by
  `tests/workspace-watcher-worktree.test.js`,
  `tests/todo-manual-worktree.test.js` and
  `tests/execution-settings-suggest.test.js`.

### Added

- **Worktree marker in the sidebar**: chats whose task tree currently owns a live
  worktree show a compact `Worktree` badge next to the `Todo` badge, so it is
  obvious which conversations run in an isolated directory. `GET /api/chats`
  reads the worktree registry once and annotates those rows (`onWorktree`), the
  runtime list reconcile and the cold-start boot cache preserve the flag, and the
  sidebar/repaint signatures react to it, so the badge clears as soon as the
  worktree is cleaned. Covered by `tests/chat-list-worktree-badge.test.js`.

- Workspace Watcher **worktree layout settings**: Settings → Workspace Watcher →
  Settings → *Execution folder (worktree)* now exposes the policy default
  (`executionMode`), the absolute worktree root, namespace, branch/directory
  prefixes and the prepare argv (one argument per line; a shell string is
  refused). The form mirrors the server fail-closed validation, so a `worktree`
  default or a partially filled layout cannot be saved until it is complete and
  safe. Empty fields are prefilled with a **server-computed suggestion** derived
  from the workspace itself (`GET /api/workspace-watcher?suggest=1`): an absolute
  root outside the Git repository (`<parent>/.cretli-worktrees`), a namespace
  from the repository folder name, the matching branch/directory prefixes and a
  prepare argv from the lockfile that is actually present (`pnpm-lock.yaml`,
  `yarn.lock`, `package-lock.json`, …); a stored value always wins over the
  suggestion. The server also **backfills a missing layout on save** when the
  patch turns worktree mode on, so enabling it is a one-click action instead of
  inventing paths (`prepareCommand` is never invented and stays as sent).
  Previously the layout was only writable through the `watcher_set`
  MCP policy patch, so choosing `worktree` on a todo failed with
  "Watcher policy has no worktree layout" with no in-product way to fix it.
  Covered by `tests/execution-settings-suggest.test.js` and
  `tests/workspace-watcher-settings-ui.test.js`; documented in
  `docs/workspace-watcher.md`.

- Manual TODO runs in **worktree** mode: starting a todo tree by hand from the
  Todo panel now creates/reuses ONE worktree keyed by the tree **root** and
  freezes it as `executionFolder` on every chat of the tree, so delegated
  implement/fix children inherit it and the per-folder write lock no longer
  collides with another tree in the main folder. The requested leaf's
  `executionMode` is ignored for manual starts (root override, else policy
  default); the Watcher keeps its leaf keying and mixing the two is refused with
  HTTP 409. A long prepare answers `202 {state:'preparing'}` and the UI polls
  `GET /api/todos/:id/start-agent/status`. Manual root integration adds an
  explicit `action=prepare` (honest `manual` evidence) beside `confirm`/`reject`.
  Covered by `tests/todo-manual-worktree.test.js`; documented in
  `docs/todo-worktree-contract.md` and `docs/workspace-watcher.md`.

- Browser for runs with no open chat UI: a Watcher/autopilot cycle, a
  delegation, or a chat after a restart now uses a reserved **system owner**
  (`BROWSER_SYSTEM_OWNER_ID`) with its own Chromium context instead of failing
  with `OUT_OF_SCOPE` or borrowing the last login session. The owner is live
  only — attached signed-in sockets register and release it on connect/close —
  so a UI-less run never inherits a user's cookies or session, and the system
  session stays invisible and unreachable from every login session. Documented
  in `SECURITY.md` and `docs/MULTI-INSTANCE.md`, covered by
  `tests/mcp-browser-tools.test.js`.

- TODO status icons match the sidebar: a cog spins only for live agent work,
  including descendants; input waits show a pause and idle tasks keep static icons.

- Shared **scoring/usage fact schema** (`lib/model-facts/`): a versioned fact
  record (`actual`/`estimate`/`plan_usage`/`benchmark`, `source`,
  `source_class`, `source_version`, `observed_at`/`fetched_at`, `confidence`),
  the `api_metered`/`subscription_quota`/`local`/`unknown` billing classes and an
  exact `(harness, model, variant) → provider endpoint + external model id`
  identity registry. Only an exact alias match is ranking-eligible; an unmatched
  or conflicting alias is dropped before precedence, the same model on two
  harnesses stays two pairs, and Settings favorites remain the candidate gate.
  Cost precedence is provider actual > ledger estimate > endpoint catalog
  (`api_metered` only) > heuristic; `plan_usage` is never converted to USD.
  Documented in `docs/model-scoring-facts.md`, contract test
  `tests/model-fact-schema.test.js`.

- Local **model+harness telemetry** (`lib/model-facts/telemetry.js`, stage 2 of
  the same plan): disjoint cache read/write token facts (no double counting with
  uncached input), a USD fact that carries only a value the ledger already
  produced and only for a matched `api_metered` pair (subscription/local/unknown
  get no USD, not USD 0; OpenRouter endpoint prices never charge a subscription),
  a `plan_usage` fact plus an explicit `limit_ref` back to the plan-limit /
  lockout reading, and a quality record that keeps infra/quota failures out of
  the quality denominator. The existing `n/(n+10)` shrink weight (with `n` the
  full task counter, infra/quota failures included, exactly `row.n` in
  `lib/model-role-profiles.js`), the infra prior and the implement stats for fix
  are preserved (parity-tested), and review quality stays out of ranking.
  Documented in `docs/model-scoring-facts.md`, contract test
  `tests/model-fact-telemetry.test.js`.

- OpenRouter **endpoint pricing cache** (`lib/openrouter/openrouter-pricing-cache.js`,
  stage 3 of the same plan): the existing `GET /api/v1/models` fetcher (still the
  only OpenRouter HTTP client) keeps the published per-model `pricing` object and
  persists the last good catalog under `data/`. A live 429/5xx/timeout, a network
  error or an empty list serves that last good copy with an explicit `stale: true`
  marker and a warning instead of an empty list, and a hanging refresh is bounded
  by the request timeout. After the in-memory TTL the stale copy is served
  immediately while revalidation runs in the background (stale-while-revalidate).
  `model_pick` reads prices locally and synchronously through
  `getOpenRouterEndpointPricing(exactModelId, { dataDir })` — no network, no await,
  exact case-sensitive OpenRouter id match, no substring/fuzzy join. Every value
  carries `source: openrouter-catalog`, `source_class: endpoint_catalog`,
  `kind: estimate`, `billing_class: api_metered`, `source_version`,
  `fetched_at`/`observed_at` and an attribution note stating these are endpoint
  prices, not a direct provider API price or a subscription charge. Artificial
  Analysis and SWE-rebench/Terminal-Bench/SWE-bench snapshots stay deferred.
  Covered by `tests/openrouter-pricing-cache.test.js`; documented in
  `docs/model-scoring-facts.md`.

- Explainable **shadow scoring** for `model_pick` (`lib/model-pick-shadow.js` +
  `lib/model-pick-shadow-gates.js`, stage 4 of the same plan): every pick now
  also produces `shadow_top`, a per-candidate `explanation` (identity
  `alias_status`/`provider`/`external_model_id`, price `kind`/`source`/
  `source_class`/`billing_class`/`fetched_at` and age, and each cost/time nudge)
  and an `agreement` record. The observer is **additive only**: it consumes the
  exact candidate set and the already-blended local observed statistics, makes
  zero network requests, and never changes `pick`/`picks`/`candidates`. An
  unmatched identity is neutral; an API price may move a cost score only for a
  fresh `api_metered` pair (subscription/local/unknown never do); review quality
  never uses the verdict pass rate. Comparisons persist to
  `data/model-pick-shadow-comparisons.json` with per-role agreement counters and
  stop flags (review agreement below 70% or a review pass-rate influence in the
  score). The rollout gate (Wilson lower bound of the pass-rate difference,
  infra-fail and USD/success thresholds, minimum 14 days / 200 calls / 20 decided
  cycles) is implemented and tested but **dormant**: `promotion` defaults to
  `false`, so the observed selection is unchanged. Covered by
  `tests/model-pick-shadow.test.js`; documented in `docs/model-scoring-facts.md`
  §11.

- Claude harness lists **Claude Haiku 5.5** (`claude-haiku-5-5`, with the usual
  effort variants). The model is overlaid on every catalog source, so it stays
  selectable while the bundled Claude Code CLI still resolves the `haiku` alias
  to an older release. Usage estimates include its lower Haiku 5.5 rates and the
  context meter reports 200k tokens for the Claude 5 generation.

- Workspace Watcher classifies every `doing` todo as `active`, `dependency`,
  `user_action`, `recoverable` or `unknown` with its evidence
  (`snapshot.doingStates` / `snapshot.recovery`). The existing claim reconcile
  now also releases an unclaimed `doing` leaf in autopilot when its executor
  chat is confirmed gone or idle and archived; unknown liveness, a missing
  execution identity or an expired claim lease never auto-recovers. Claims
  store a durable `execution` identity (attempt/fencing id, cycle id, todo
  revision), a replayed claim is idempotent, and a late release from an older
  attempt can no longer free a newer one. Unknown rows escalate to the operator
  in `observe` and `autopilot` after six heartbeat observations (~30s); `off`
  does not escalate on heartbeat; `paused`/`stopReason` suppress notify while
  quiet hours and cycle budget do not. Observe reports only; unclaimed release
  stays autopilot-only. Manual and autopilot recovery share
  `POST /api/workspace-watcher/todos/:id/recover` / MCP `watcher_recover_todo`.
  `policy.recoverIdleOpenChat` optionally treats idle open executor chats as
  recoverable; Todo **Why?** and the task editor show recovery state and evidence.

- Browser `required` network boundary now gates on a working proxy instead of a
  configured URL: before creating a session the server runs a bounded TCP
  reachability probe against `CRETLI_BROWSER_PROXY_SERVER` and refuses to start
  (`browser-unavailable`, naming the proxy and reason) when it does not answer.
  `proxy` only records a warning and still starts, `mvp-defense-in-depth` never
  probes, and the last result is exposed as
  `runtime.networkBoundary.proxyHealth` on `/api/browser/status`.

- Cursor SDK (`@cursor/sdk` ≥ 1.0.37): **steer** injects user text into a live
  local run (`Run.steer`, WS `steer` / `sdkSteerAck` / `sdkSteerError`); busy
  sends try steer first, then queue. **Background subagents** keep the room on
  the same run until follow-up work settles (`sdkBackgroundWork`). **MCP tool
  annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) on page, chat-host and browser custom tools. **Custom system
  prompt** (Settings + per-chat override, local agents only): `systemPrompt` on
  create/resume with project `settingSources`; unauthorized accounts get a
  one-time drop + retry without mutating saved settings. `confirm_steering` is
  folded into `revert_to_followup`.

- Notifications now include a separate **New chat created** event. A push (and
  the optional in-app signal) is emitted from the single chat-creation path, so
  a chat started by a user, a delegation, a todo/Scout run or the watcher
  notifies the other devices. It has its own toggle in
  Settings → App → Notifications → Events and follows the chat/subchat profiles;
  temporary internal fork chats (title/summary) stay silent.

- `browser_input` can now drive the common page controls, not just clicks and
  typing: new kinds `select` (`value` / `optionLabel` / `optionIndex`), `check`,
  `uncheck`, `hover`, `drag` (a separate `toSelector` / `toRole`+`toName` /
  `toText` / `toLabel` / `toPlaceholder` destination — a missing one is a 400,
  never a drop onto the source), `upload` (server-side paths that must stay
  inside the workspace root after realpath, so `..`, outside paths and symlink
  escapes are rejected) and a bounded `wait` (`selector`+`state`, `text`,
  `loadState` including network-idle, or `url`; no script evaluation). Every
  locator kind accepts `nth` (alias `index`, matching what `browser_elements`
  returns) to act on one specific match instead of always the first, `key`
  typing takes a clamped `delay`, `browser_navigate` takes an optional
  `waitUntil`, and the MCP `browser_input` `event` schema now lists every kind
  and field so schema-driven harnesses can discover them.

- Notifications now have separate chat and subchat profiles with independent
  in-app sound, volume, vibration patterns and push vibration, available in
  Settings → App → Notifications. Each profile can
  be previewed; existing shared preferences are preserved on upgrade. Custom
  sounds play in the open app, while background push uses the system sound.

- Automatic chat archiving is configurable in Settings → Chat & agents →
  General: an opt-in toggle plus an idle window as a number and unit
  (minutes / hours / days; default 30 days, range one minute to 365 days). The
  server sweeps idle chats every minute through the shared `canArchive` gate,
  so pinned chats, chats with a live run and chats with a running delegated
  child are never archived; a family is archived children-before-parent and can
  be restored from the sidebar.

- The sidebar chat row now shows an animated auto-archive countdown once an idle
  chat enters the last part of its archive window: a pulsing clock and the
  remaining time (`2d4h`, `45m`) replace the idle status chip, switch to the
  warning tone for the final stretch, and a tooltip names the deadline. The
  countdown is an estimate (the server re-checks pins and liveness at sweep
  time) and is hidden for pinned chats, chats with a live run and chats in the
  archive.

- Workspace Watcher failure backoff can be released in one click from where it
  blocks: the Monitoring alert and the cycle-schedule card's blocked line
  (Settings tab) now carry a "Clear backoff and failures" action, alongside the
  existing button in the Actions tab. It sends the same
  `{ failures: {}, backoffUntil: '' }` PATCH.

- Recovery registry (leaf R3) gains a durable, cross-process owner lease with
  generation fencing: `lib/recovery/recovery-owner-lease.js` provides
  `acquireRecoveryOwnerLease` (create / renew / takeover / `owner_held`),
  `renewRecoveryOwnerLease`, `getRecoveryOwnerLease`,
  `checkRecoveryOwnerFence` (rejects callbacks from before a takeover) and
  `releaseRecoveryOwnerLease` (a stale token cannot remove or steal the lease).
  The recovery SQLite store migrates to schema version 2 with the singleton
  `recovery_owner_lease` table. `serverInstanceToken` is explicitly not a lock
  or a fencing token. No runtime wiring and no recovery policy in this leaf.

- Recovery registry (leaf R5) gains a launch/finish lifecycle layer on the R2–R4
  primitives: `lib/recovery/recovery-lifecycle.js` provides `beginRunLaunch`
  (persists the run intent — and durably queues an approved prompt — *before* the
  caller may start an executor, blocking the launch with `launch_blocked` on any
  persistence failure), `recordExecutorAck` (an `accepted` state only from an
  executor `source`, via a CAS `starting → running`), `markAcceptanceUnconfirmed`
  (an explicit `unconfirmed` state that keeps the run `starting`), `finishRun`
  (a terminal state only with a terminal `proof`, else `terminal_proof_required`,
  with the server outranking the agent report), `canAutoRelaunch` (the gate that
  denies any automatic relaunch without an acceptance proof, whatever the adapter
  decision), plus `attachHistoryRef` and the pure `buildUsageIdentity` mapper that
  feeds `buildLogicalUsageIdentity` a `durable_sequence` identity. Acceptance,
  terminal proof and the history reference are stored on the run JSON via
  `transitionRun(..., patch)`, so there are no new tables and no store schema
  bump. No runtime wiring in this leaf.

- Chat message headers and status timestamps show "yesterday" for the previous
  local calendar day and a `DD-MM-YYYY` date for other days, alongside the time.

- Workspace Watcher shows a cycle schedule like Scout: `GET
  /api/workspace-watcher` now carries a derived `schedule` block
  (`lastCycleAt`, `nextCycleAt`, today's cycle budget, running slots and the
  live `blockedReason`), computed by `computeWatcherSchedule()` from the same
  gates the heartbeat applies (cooldown, failure backoff, quiet hours, daily
  budget). Settings → Workspace Watcher → Settings opens with a per-second
  countdown to the next cycle, the last cycle and the current blocker, and the
  Status card gains a matching "next cycle" line.

- Archiving a chat now opens a confirmation dialog first: it shows how many
  chats the cascade will archive together with the clicked chat's related
  subchats and offers a "Don't ask again" checkbox that suppresses later
  prompts (persisted per device). Programmatic archives (voice, harness switch,
  watcher/Scout) stay prompt-free; the settled-subchats group keeps its
  existing bulk confirmation.

- Archived chats now expose a trash action in the sidebar: it permanently
  deletes the chat through the existing delete flow (confirmation modal with
  the "don't ask again" preference) straight from the archive section, without
  restoring it first.

- Sidebar "Workspace" section header can expand to every workspace ("Show all
  workspaces", persisted per device): each workspace group gets its own watcher
  switch, so a watcher can be enabled for a workspace that never had one. With
  the toggle off the section lists only enabled watchers; disabled-but-pinned
  workspaces reappear in the "show all" view so their switch can turn them back
  on.

- Sidebar "Workspace" section toggles: a master switch in the section header
  drives the server-wide watcher start gate (`startsEnabled`, i.e. off for every
  workspace), and every pinned workspace gets its own switch that flips that
  workspace between `autopilot` and `off`. Disabled-but-pinned workspaces stay in
  the `agentPresence` payload (without a header badge) so the sidebar row and its
  switch survive and can turn the watcher back on.

- Built-in Browser for every harness: the `browser_*` tools (`browser_open`,
  `browser_sessions`, `browser_tabs`, `browser_screenshot`, `browser_dom`,
  `browser_elements`, `browser_console`, `browser_network`, `browser_navigate`,
  `browser_input`) are
  now part of the builtin Cretli MCP catalog, so Codex, Claude, Qwen, OpenCode,
  DeepSeek, CodeBuddy and OpenRouter chats preview a page in the Browser panel
  instead of launching their own Chromium. A call acts for the login session
  attached to the chat (a delegated child inherits it from its parent) and fails
  closed without one; plan, ask and review runs stay read-only. `browser_open`
  adopts the unbound session the user opened in the panel, and
  `browser_screenshot` returns a private temp file path. New `cretli-browser`
  skill and always-apply rule describe the workflow.

- Browser control is easier for agents: `browser_screenshot` captures in CSS
  pixels (`scale: 'css'`), so image pixels match the viewport coordinates
  `browser_input` clicks use instead of being scaled by DPR. A new
  `browser_elements` read lists visible interactive controls — including inside
  Lit/open shadow roots — with role/name/text and a usable selector, and
  `browser_input` gained `click`/`fill` targets by `selector` or
  `role`+`name` / `text` / `label` / `placeholder`. A `browser_input` resize now
  keeps the session's DPR and touch flags (Playwright cannot change them after
  the context is created). Screenshot files are written by one shared helper for
  both SDK and MCP harnesses.

- Settings → Workspace Watcher → Scout: a new `refactor` scan category for
  behavior-preserving code quality (split an oversized file or module, extract a
  duplicated block, simplify deep nesting). The Scout prompt carries dedicated
  heuristics so a proposal is a small, independently reviewable seam rather than
  a rewrite, and the category joins the closed allow-list, the UI checkboxes and
  the `watcher_scout_findings` tool.

- Settings → Workspace Watcher → Scout: daily scan budget (`scoutMaxPerDay`,
  UTC day, `0` disables). The field was policy-only before; the form now reads,
  validates, saves and resets it with the rest of the Scout section.

- Workspace Watcher monitoring dashboard (Settings → Workspace Watcher): a live
  section (mode/pause, each `activeCycles[]` slot with todo/phase/duration/chat
  link, active delegations by harness/status, latest decision), a Gantt-like
  multi-lane timeline (success/failure/blocked tones, 1h/24h/7d filters,
  click-to-detail, live bars for running cycles), throughput/reliability
  statistics (success rate, avg cycle time, daily/weekly throughput, common stop
  reasons, top harnesses by delegation count and verified pass rate), a
  filter-by-kind decision log, and an alerts block (active `stopReason` + clear,
  `backoffUntil` countdown, quiet-hours end). Backed by the new
  `GET /api/workspace-watcher/stats`; `cycleChats` entries now carry `startedAt`
  (mirrored by `buildWorkspaceWatcherCycleClosePatch`, still capped at 20) so the
  timeline shows real durations. Live updates reuse the existing chat-list
  WebSocket (`chatsChanged` reason `workspace-watcher`); EN/PL labels added.

- Workspace Watcher: one deterministic guard per workspace (server-side, no
  LLM) that snapshots ready todos, live chats and delegations, and can drive an
  autopilot. Modes `off` / `observe` / `autopilot` (default off, `maxParallel`
  1). Autopilot spawns one short-lived orchestrator chat per cycle which plans
  or delegates `implement`/`review` via the multi-harness flow and never
  commits, pushes or auto-approves a plan. Durable singleton lease + CAS todo
  claim, restart reconcile, per-UTC-day cycle budget, cooldown, exponential
  backoff, quiet hours, same-findings stop, allowed-harness filter with real
  usage-limit awareness, plan gate (plan-only then wait for a human), push
  dedupe. Exposed through `GET/PATCH/DELETE /api/workspace-watcher`,
  `GET /api/workspace-watcher/decisions`,
  `POST /api/workspace-watcher/{pause,resume,clear-stop,tick,run-cycle,claim-next,reset-plan-requests,findings}`,
  the `workspace_watcher_show` / `workspace_watcher_update` MCP tools and a new
  Settings → Workspace Watcher panel. The Todo tab gets a watcher top bar (mode,
  live status, pause, orchestrator chat link) with a "Why?" decision log, todo
  rows show claimed/queued badges, and the sidebar shows a per-workspace
  autopilot badge. Live updates reuse the existing chat-list WebSocket
  (`chatsChanged` reason `workspace-watcher` plus the `agentPresence` watcher
  summary) instead of a new socket. See `docs/ARCHITECTURE.md`.

- Workspace Watcher: pinned workspace chat. Each workspace gets one durable chat
  (`pinnedChatId`, materialized by idempotent `ensurePinnedChat` when autopilot
  is enabled or on demand, and recreated if deleted) that outlives individual
  cycles. The watcher appends deterministic notices (cycle start/stop, todo
  done, blocked/alert, decision) to it through the new persist API
  `appendChatNotice` — a persisted `meta`/`variant: 'watcher'` record, not a
  per-notification agent run. The sidebar renders a dedicated "Workspace"
  section with a robot icon per workspace (fed live by the existing
  `agentPresence` watcher summary); opening it shows a special notice style
  (timestamp + action icon + description). User commands map onto the existing
  watcher/todo REST APIs (option A: `/pause`, `/resume`, `/stop`, `/clear-stop`,
  `/tick`, `/cycle`, `/skip`, `/status`, `/help`) via
  `GET/POST /api/workspace-watcher/pinned-chat`. Design trade-offs:
  `docs/workspace-watcher-pinned-chat.md`.

- Workspace Watcher docs and acceptance coverage: `docs/workspace-watcher.md`
  documents the architecture, the `off`/`observe`/`autopilot` modes, the lease,
  CAS claim, plan gate and no-commit/push guarantees, and how to debug through
  the `decisionLog`. `tests/workspace-watcher-e2e.test.js` drives the real
  autopilot runtime against the mock chat-run adapter: three ready todos run
  sequentially, a failed cycle blocks only its todo while fresh work continues,
  a restart mid-cycle reconciles once without a duplicate cycle or claim, two
  processes are serialized by the singleton lease, and `off`/`observe` start no
  agent. The `cretli-multi-harness` skill and `CLAUDE.md` now spell out the
  watcher ↔ cycle-parent relationship (`watcher_report` at the end, no parent
  commit/push, children never start further delegations).

- Workspace Memory: a durable per-workspace fact store
  (`data/workspace-memory/<workspaceKey>.json`, keyed by the same
  `workspaceKeyFromCwd` hash todos use) for `decision`, `pattern`, `finding`,
  `blocker` and `context` entries with optional `ttl_ms` expiry. Expired facts
  are hidden lazily on read, writes are CAS-guarded under the shared
  cross-process file lock so parallel cycles lose nothing, and the store is
  bounded. The watcher cycle prompt now carries a capped (3000-token)
  `WORKSPACE MEMORY` section and instructs the orchestrator to record decisions
  before reporting. Exposed through the `workspace_memory_add` /
  `workspace_memory_list` / `workspace_memory_delete` MCP tools, so a Scout scan
  can read what earlier cycles already explored. Review-verify catalog id:
  `workspace-memory`.

- Workspace Scout: a separate periodic read-only LLM scan that proposes work
  instead of executing it. Scout is **not** a watcher cycle: it has its own
  `lastScoutAt` + `scoutScans` schedule/budget (`scoutIntervalHours`,
  `scoutMaxPerDay`, `scoutMaxPerScan`), never touches `activeCycles` or
  `maxCyclesPerDay`, and runs only while the watcher is `observe`/`autopilot`
  and not in quiet hours. It gathers read-only signals (`git diff main`,
  `git log --oneline -20`, changed-file TODO/FIXME/HACK markers, optional test
  results and error logs, existing todos, prior review findings and Workspace
  Memory), starts one `plan`-mode chat, and records findings
  (`{id,title,category,rationale,files[],status}`) in five categories
  (bug/improvement/security/opportunity/documentation). Proposals are deduped
  against existing todos, resolved findings and "already explored" memory.
  Scout never creates a todo; an explicit accept does, and only when
  `scoutAutoCreate` is true (as an `idea` todo with an unapproved plan draft).
  Policy fields
  `scoutEnabled`/`scoutIntervalHours`/`scoutAutoCreate`/`scoutCategories`/
  `scoutMaxPerDay`/`scoutMaxPerScan`; capabilities in
  `lib/workspace-watcher-scout.js` (`buildScoutPrompt`, `parseScoutFindings`);
  MCP tool `watcher_scout_findings` (list/accept/reject/submit, with `list` and
  `submit` allowed in Plan mode for the read-only scan) and
  `GET/POST /api/workspace-watcher/scout`. Fresh proposals also land in the
  pinned workspace chat. See `docs/workspace-watcher.md`.

- Configurable Workspace Scout profiles (MVP — `docs/configurable-scouts.md`
  steps 1–5). A workspace now stores a versioned `scoutProfiles` collection; the
  watcher store schema is raised from v1 to `WORKSPACE_WATCHERS_SCHEMA_VERSION = 2`
  and a v1 row is normalized in place on first read (single writer; see the
  rollout/backup/restore procedure in `docs/workspace-watcher.md`). The legacy
  single Scout migrates to exactly one general profile preserving the prompt,
  categories, sources, schedule, limits and harnesses plus the active-scan token,
  spent budget and proposals; re-reading is idempotent and never duplicates the
  profile or its scans, and an empty workspace reads a virtual, disabled general
  profile without writing. A new profile defaults to `schedule=manual` and
  `enabled=false`, so an upgrade starts no new profile and no TODO on its own.
  Per-profile state (`scoutSchedules` UTC-day counters and `lastRunAt`/`nextRunAt`,
  `activeScoutScans` with at most one unsettled scan per profile, and a bounded
  `scoutScanHistory` of the last 100 per profile / up to 1000 per workspace that
  never trims active or `uncertain` records) lives on the shared row; the workspace
  `scoutScans` budget and `pendingScoutFindings` are unchanged. The heartbeat
  selects due enabled profiles in oldest-`lastRunAt` order so a frequent profile
  cannot starve others, the profile and workspace limits both apply, the reservation
  and both counters are bumped atomically under the store lock, and a failed start
  releases only its own slot (a normal `started=false` keeps the day counter so the
  heartbeat cannot retry-loop a missing model). Adds a versioned template catalog
  (general / bug / security / refactor / documentation / performance) with
  restore-diff / restore, area and Git scope with source toggles, and an executor
  precedence where an explicit profile harness/model overrides the inherited
  orchestrator but is still gated by the allow-list, readiness and favorites (an
  empty intersection blocks the start with a reason). The read-only contract is
  enforced by the host tool policy regardless of the `agent` transport mode.
  Findings dedupe across profiles into one proposal carrying multiple `sources[]`
  with server-owned attribution; a foreign chat/token submit is rejected and the
  201st unique finding is rejected with `capacity_exceeded` without dropping the
  oldest pending. New REST surface under
  `/api/workspace-watcher/scout/{profiles,templates,history}` (profile CRUD,
  `duplicate`/`archive`/`preview`/`run`/`restore-diff`/`restore`,
  `from-template`/`preview-draft`) and the MCP `scout_profiles` tool, while the
  legacy `GET/POST /api/workspace-watcher/scout`, the `activeScoutScan` mirror view
  and the remote `workspaceWatcherScout` client stay backward compatible. Settings
  → Workspace Watcher → Scout gains the profile list and actions, the editor with
  templates and an effective-config/file preview, per-profile scan history and a
  shared proposals inbox (PL/EN). Acceptance map:
  `docs/configurable-scouts-acceptance.md`.

- Builtin MCP `delegation_ack` and `POST /api/chats/:id/delegation-ack` let the
  parent mark a finished report as read and clear the terminal `unverified` flag
  (`acknowledgedAt` / `acknowledgedReason`; `reason` `reviewed` or `accepted`).

- Per-leaf multi-harness loop read-model (`lib/delegation-loop-report.js`) is
  exposed on `GET /api/delegations/stats` as `loop.leaves`, on MCP
  `workflow_show` as `loop`, and as a "loop per leaf" table in Settings → Usage
  (delegation stats).

- The built-in Browser can sign itself in to Cretli's own origin without a
  password. A loopback request to `POST /api/login` with `{ "local": true }` is
  accepted only when it presents the in-memory `x-cretli-local-login` token
  (48 hex characters generated per process, never written to disk or returned by
  the API); `GET /api/auth-status` reports it as `localLogin` and the login page
  completes the sign-in on its own. The token is attached per request and only
  toward Cretli's own origins — never to an allowlisted third-party site or a
  foreign redirect hop — and it is redacted in Browser network output.

### Changed

- Workspace Watcher now accepts up to **10** parallel cycles per workspace
  (previously 5): both the `policy.maxParallel` / `scoutMaxParallel` ceiling and
  the store's `activeCycles` cap are raised to 10. The default stays 1, so
  nothing changes until a workspace opts in.

- Delegation rating calibration: tag `caught_bug`, contradictory tag/score pairs
  are rejected (`contradictory_rating`), and parent ratings no longer raise
  observed model quality in `model_pick` — ranking uses only user ratings
  (`rating_avg_scored` / `rating_n_scored`).

- Nine built-in MCP tools now carry short names so their bridge-encoded form
  fits the 64-character harness function-name cap: `workflow_update`,
  `workflow_show`, `watcher_update`, `watcher_show`, `wmem_add`, `wmem_list`,
  `wmem_delete`, `scout_findings`, `scout_profiles`. The former long names
  (`delegation_workflow_update`, `delegation_workflow_show`,
  `workspace_watcher_update`, `workspace_watcher_show`, `workspace_memory_add`,
  `workspace_memory_list`, `workspace_memory_delete`, `watcher_scout_findings`,
  `watcher_scout_profiles`) still reach the same handler and are classified
  exactly like the new name by every host gate (Plan, review, Scout), but they
  are no longer advertised in `tools/list`. Each renamed tool opens its
  description with the canonical name and the alias it replaced. Alias
  resolution inside those gates is limited to chains the built-in catalog owns,
  so an external server that reuses a built-in basename (`mcp__github__todo_list`,
  `mcp.acme.todo_list`) is no longer mistaken for a Cretli read tool; harnesses
  that rewrite the middle of a long name still resolve.

- Host-owned review verify is now enforced for reviewers that cannot run tests:
  a review child started on a harness whose effective `review_can_run_tests` is
  false (static prior or observed from real reports) is persisted with
  `verifyRequired`, `model_pick` surfaces `review_requires_verify`, and a PASS
  review without a passed `delegation_verify` no longer closes the cycle. The
  persisted `verifyResult` now carries the review `verdict` and `exitCode`, and
  `delegation_show` prints them.

- The review-verify catalog is generated from audited directories at call time
  instead of a frozen constant. A `tests/<id>.test.js` added during a flow is a
  valid id without a server restart; the curated catalog still wins id
  collisions, and the generated manifest is written under the OS temp dir, never
  the project `data/` tree.

- Accepting a Scout finding with `scoutAutoCreate` creates an `idea` todo whose
  plan draft is the finding rationale. `approvedAt` stays empty until a human
  approves it in the UI. A retried create does not overwrite that draft.

- TODO claims serialize across processes with other todo writes, reject
  non-ready or blocked work, expose lease expiry through API/MCP, and clear
  their metadata on completion. Selection respects assignments and sibling
  order; failure-ceiling blockers remain visible until a manual retry.

- Workspace Watcher snapshots include doing/blocked todos, waiting chats and
  recent delegation errors. Event nudges cover observe and autopilot, exclude
  the cycle's delegated chats from occupancy, and stop cleanly on shutdown.

- Workspace Watcher runs up to `policy.maxParallel` cycles per workspace (hard
  cap 5) instead of one `activeCycle`: live cycles live in `activeCycles[]`
  (slot 0 mirrored to `activeCycle` for v1 readers), a start is refused only at
  `activeCycles.length >= maxParallel`, each slot is authorized by its own
  `chatId` (`orchestratorChatId` only covers an idle row), closing a slot keeps
  the shared lease while a sibling is live, and reconcile drops only the dead
  slot. The sidebar autopilot badge and the Todo watcher bar show the live cycle
  count/list instead of only slot 0.

- TODO trees run sequentially by default. Parent status follows its subtasks
  at every depth: completion requires all descendants, and reopening a child
  reopens its ancestors. API and manual agent starts enforce sibling order;
  parallel execution remains an explicit choice.

- Harness statistics use compact mobile lockout alerts, grouped metric cards,
  readable window/status labels, durations in seconds/minutes and wrapped
  error details. Technical lockout codes are collapsed behind a details row.

- Harness overview shows active model lockouts with their reset time even when
  collapsed. The expandable health card now has a visible Statistics button;
  its lockout notice disappears when the reset time arrives or after unlock.

- Optional `@openai/codex-sdk` (and the bundled Codex CLI) bumped to **0.160.0**.
  GPT-6.1 Sol (`gpt-6.1-sol`) is in the API-key fallback catalog. ChatGPT plan
  chats still use the live account list from `models_cache.json`, which this
  CLI can refresh.

- The per-user Browser session cap `MAX_SESSIONS_PER_OWNER` is raised from 1 to
  **3** concurrent sessions. The `session-limit` error hint already names the
  per-user cap and points the caller at `browser_close`.

- Browser diagnostic redaction now also covers the `x-cretli-local-login`
  header, so the passwordless token cannot leak through Console or Network
  output, WebSocket frames or agent exports.

### Fixed

- A Cursor registry rejection that surfaces during a run (`agent.send()` or a
  streamed `status=ERROR`) now quarantines the rejected favorite and falls back
  to Auto, exactly like a rejection during agent create/resume. Before this, only
  the create/resume path handled `Invalid parameters for registry model`, so an
  advertised-but-invalid variant (for example a `grok-4.7` 500K context preset)
  stayed in Settings and failed every later turn. A strict `fast=true` request
  still refuses the silent switch, but the favorite is removed and the chat moves
  to Auto so the next turn is safe. The `context=` variant parameter is also read
  as the context window (`context=500k` → 500000 tokens) instead of falling back
  to the model-prefix default. Covered by
  `tests/sdk-registry-model-recovery.test.js`.

- An OpenCode run that Cretli or the user stops now ends as `cancelled`
  instead of `error`, so it no longer shows a red error or an error
  notification. A delegation child stopped after its `final_report` was
  accepted is not re-finished, and one stopped without a final report finishes
  `cancelled`, not `failed`. A plan-guard stop of an OpenCode run ends as
  `plan_guard_cancelled`.
- CodeBuddy chats now get the Cretli MCP tools. The CLI rejected the bridge
  entry because it had no explicit `type: "stdio"` and started with no MCP
  servers, so no CodeBuddy chat could call `delegation_start`, `todo_show` or
  `watcher_update`. The first prompt is also held (at most 5 seconds) until
  the bridge is connected, because the CLI builds the first model request
  without waiting for MCP servers.
- A model id the provider no longer serves (CodeBuddy `400 model [x] service
  info not found`) now locks that one model out of automatic picks for 24 hours,
  so the Workspace Watcher stops starting orchestrator cycles on it. The chat
  shows what happened and where to change the model instead of the raw 400.
- External stdio MCP servers are now closed when their chat room shuts down.
  Room teardown looked the connection up by an isolation key that omitted the
  workspace file, so one server process per chat session stayed alive until the
  Cretli server restarted.

- Archived chats are read-only: the composer keeps its draft and disables
  sending until the chat is restored. Server-side prompt starts, WebSocket sends
  and forced queue sends reject archived chats with `chat_archived`.

- Archived chats cannot create new child chats or start/retry delegations.
  Delegation starts return `parent_archived` until the parent is restored, and
  the chat store rejects late child creation and nesting under archived parents.

- Automatic watcher and Scout archiving revisits archived parents with children
  created later, including descendants under archived forks. Once the whole
  family is idle and eligible, its remaining chats move into the archive without
  rewriting existing archive timestamps.

- Scout and review chats that store only a workspace folder now appear in the
  matching sidebar clone, including its archive, instead of disappearing from
  both the parent and clone workspace lists.

- Opening an older chat saved in the shared `.code-workspace` directory now
  selects the workspace's configured project folder for watcher and Scout
  controls, preventing an `esystent.pl` chat from enabling a `projects` scout.
  Direct chat selection and the sidebar use the same folder lookup.

- A watcher for a shared `.code-workspace` parent directory no longer inherits
  the name of a project configured to use a different folder in the sidebar.

- Opening a workspace watcher now selects its exact folder before Todo loads.
  Rapid switches and late settings responses cannot restore a previous
  workspace; folder-only watcher chats prefer the workspace configured for
  that folder over another workspace that merely includes it. An open Todo
  panel reloads automatically when the workspace changes.

- The Todo watcher bar clears the previous workspace's controls on a switch
  and ignores delayed responses and failures from that workspace, preventing
  another project's active task from appearing under the current chat.

- Todo requests now carry the client workspace for reads, edits, deletes and
  agent starts. Switching workspaces clears the previous list and editor;
  delayed responses from another workspace cannot replace the current list.

- Codex review no longer dies when one shell command is denied. `codex exec`
  still cannot reject a single call, so that turn stops, then the same review
  continues from a follow-up prompt (twice at most) instead of closing the
  delegation. The chat no longer shows the generic "run was cancelled" notice
  for that stop. Ask mode still ends the turn.

- Opening a parent chat no longer leaves the previously active subchat
  highlighted in the sidebar. The active-row highlight lives outside the
  structural render signature and is repainted by a transient patch, but that
  patch was unreachable while the chat-list modal was closed and skipped when
  the mobile drawer was hidden — exactly the state a chat tap produces before
  the drawer closes. The status/refresh frame now runs the transient patch
  regardless of the modal, and opening the drawer repaints the active row as
  soon as it becomes visible.

- Finished-subchat groups can be collapsed again. A group was force-expanded
  whenever the active chat was a sibling of its folded children (i.e. shared the
  group's parent), so clicking the chevron flipped the stored flag but the row
  stayed open. The active chat and its ancestors are never folded in the first
  place, so the group now opens only while searching or after an explicit expand.
  The whole group row also toggles on click, so the count/summary columns of the
  wide sidebar layout no longer act as dead zones.

- Returning to a chat no longer dumps every child-chat link at the bottom of
  the stream. The metadata backfill appended each child whose creation record sat
  outside the mounted history window, so after a PWA resume the tail filled with
  "Child chat" rows. A backfilled child link now attaches only next to the
  delegation card that created it and is skipped otherwise; its own history
  record already paints inline when the window reaches it.

- A review Bash denial now says the block is this command only, and that an
  unknown `review-verify` catalog id is rejected. Reviewers were retrying the
  same id and treating the whole shell as dead.

- Live answer Markdown no longer collapses mid-stream: the chat view discarded
  every whitespace-only assistant delta (`!full.trim()`), so the newlines between
  headings, list items and code-fence lines vanished. Lines glued together and an
  unterminated fence swallowed the rest of the answer as raw text until a reload
  re-read the server-persisted (whitespace-preserving) history. Only a truly
  empty Codex lifecycle payload is skipped now, and `appendRunFinished` /
  `onStreamReset` flush a pending Markdown paint so the last delta is never left
  unrendered.

- Archiving a chat in the sidebar now moves the whole fork subtree (the parent and
  every child) into the Archive together, without ever flashing the children as
  top-level chats. Previously `closeChat` removed the parent row locally, so
  `flattenChatsTree` treated the orphaned children as new roots — they popped to
  level 0 in the live list and again in an open Archive section until a later
  server reload folded them back. `requestArchiveChat` and
  `requestArchiveSettledChats` now stamp `archivedAt` on the whole subtree in place
  (new pure helper `markForkSubtreeArchived` in `lib/chat-tree.js`) and keep every row
  so `partitionChatsByArchive` moves parent and children together, while `closeChat`
  runs as a runtime teardown (`keepRow`) rather than the branch-moving mechanism.
  `requestRestoreChat` uses the server's matching restore cascade and then one forced
  authoritative list reload, so it never splices the parent row out either.
  The archive button's busy state is computed once per render pass
  (`buildForkArchiveBlockedIds`, an O(chats) walk) instead of `isForkSubtreeBusy`
  per visible row, removing the sidebar and chat-modal stutter on large lists. A
  single "archive"/"restore" click issues at most one full `GET /api/chats`: the
  explicit-reload guard (`app_front/features/chat/chatListExplicitReload.js`, wired
  through `shouldSuppressChatsChanged`) suppresses the `archive`/`restore` live-sync
  frame this client caused itself without dropping independent changes.

- Settings → Harness → Cursor SDK → Models no longer hides the `grok-4.7`
  500K context variants. Cretli now mirrors every row from Cursor
  `models.list` instead of dropping a hardcoded model/variant pair, so the
  chat model list matches the API. If Cursor's registry still rejects a
  variant at run time, the SDK room's existing fallback to Auto and favorite
  quarantine handle it.

- Qwen tool tiles no longer turn red for successful calls that merely mention
  "missing": the `tool_search` miss heuristic now runs only for `tool_search`
  results, so `todo_show`, `run_shell_command`, `read_file` and other successful
  MCP/CLI calls report `completed`.

- `todo_show` now prints `truncated=true next_cursor=…` in the body/plan text and
  documents the cursor format, so harnesses that read only MCP `content` (e.g.
  Qwen) can page a long plan instead of guessing the opaque cursor and hitting
  `VALIDATION_ERROR: Invalid detail cursor`.

- CodeBuddy token telemetry reads assistant and streaming usage, deduplicates
  partial/full message snapshots, and uses result totals only as a fallback.

- Sidebar chat statuses update live again without rebuilding the list. Starting
  or finishing work now repaints only the affected row (the row keeps its DOM
  node and the spinning cog no longer restarts), and the working status is still
  there after a reload because the last presence snapshot is remembered per chat
  instead of being dropped while the list is loading. Duplicate presence frames
  from multiple open chats are dropped, a missed frame is repaired from a fresh
  snapshot, and the 15 s agent-states request stays only as a fallback. A burst of
  tools no longer makes the activity label flicker, a WebSocket reconnect no
  longer hides an agent that is still running, and a watcher-only update no longer
  reloads the whole chat list.

- Sidebar on mobile: the first tap after a swipe now always works. The synthetic
  click that belongs to a gesture is swallowed only for 350 ms, and a real
  `pointerdown` clears it, so a swipe that snaps back no longer makes the next tap
  (close button or backdrop) do nothing.

- Sidebar workspace header: a clone group (`cretli • Cretli - landing page`) no
  longer inherits the autopilot badge from a sibling folder of its source
  `.code-workspace`. `resolveWorkspaceWatcherBadge` now checks only a clone's own
  folder, so the badge matches the watcher the group actually belongs to.

- Sidebar chat rows: every status glyph (cog, check, alert, …) now occupies the
  same fixed-width, centred box as the archive/star action buttons. Previously
  the cog's natural glyph width made the cog → archive gap narrower than the
  archive → star gap; equal boxes plus the shared column gap make all three
  gaps identical while keeping the cog in the status icon column.

- Sidebar archive header: the archived-chat count (`908`) rendered at the row
  font size because `.sidebar-workspace-count` was nested under
  `.sidebar-workspace-header`, which the archive header is not. The rule moved to
  the top level, so the archive count now uses the same small count pill as the
  workspace header.

- Sidebar chat rows: the working-state cog now stays in the status icon column,
  aligned with the settled check/alert icons, and the activity label sits to its
  left. A running row reads `label ⚙ archive star` instead of the cog floating
  left of the text and breaking the right-hand icon column.

- Settings → Usage now counts DeepSeek Harness tokens. DSH reports token
  accounting only on the assembled `assistant/message` session event, which the
  event normalizer dropped (it exists to host usage after the streamed text);
  the normalizer now forwards that usage as a synthetic `usage` event, and
  `fromDeepSeekUsage` maps DSH's disjoint `TokenUsage` (`inputTokens` already
  excludes `cacheReadTokens`) onto the canonical bag. In-process DeepSeek
  subagent usage is attributed to the parent room too. Previously the DeepSeek
  column and its chart slice stayed at zero even though `run` events were
  recorded.

- Review no longer denies plain project tests (`node --test tests/<file>.test.js`
  or `node tests/<file>.test.js`, optional pipe to `head`/`tail`). The catalog
  runner stays the audited path. Other node flags, npm, and writes stay denied.
  A CodeBuddy review denial no longer drops the rest of that stream message.

- Archiving a chat is refused while that chat or any nested child still has a
  live run (`CHAT_ARCHIVE_BUSY`). The sidebar archive list keeps the same
  parent/child tree as the live list instead of a flat row of archived chats.

- Workspace Watcher no longer stays on `wait_active` / `max_parallel` after a
  cycle report just because the archived orchestrator is still busy. Late
  mailbox replies to a closed-cycle orchestrator are marked delivered
  (`skipped_cycle_closed`) and do not start another run. That chat's leftover
  occupancy does not count toward `maxParallel` unless it still holds a todo
  claim or an active delegation. A `max_parallel` decision now stores
  `slotHolders` (chat ids and `delegation:<id>` tokens) so Todo **Why?**, the
  decisions API and the pinned-chat line name who holds the slot.

- A parent is no longer woken twice for one child report. When the parent reads
  a terminal report with `delegation_show` (or pages a `final_report` body with
  `delegation_inbox`), that read now counts as delivery (`reportDeliveredAt` /
  `reportDeliveryId: read:…`). A queued mailbox `final_report` for the same
  delegation is finished as `delivered` (`skipped_already_delivered`) instead of
  starting a redundant parent run and replaying the same report ("ponowna
  dostawa"). A report the collector already placed in a parent prompt is skipped
  the same way.

- Builtin MCP tools load in any import order. The read-only guard messages moved
  to `lib/sdk/sdk-guard-messages.js`, so `delegation-service.js` no longer pulls
  `sdk-plan-guard.js` (MCP policy → tool catalog → delegation tools) back into
  itself; loading the delegation tools first used to throw
  `Cannot access 'DELEGATION_MCP_TOOLS' before initialization`.

- Continuing a parent TODO now instructs the chat to orchestrate every unfinished
  descendant, with implementation and independent verification subchats before
  moving to the next task. New parent chats start in Agent mode; `todo_show`
  exposes ordered, paginated children and plan approval state.

- OpenCode approval advisor: a filename such as `chat-title-service.js` is no
  longer classified as a privilege command, so a safe read can reach Jev. When
  Jev allows, Once is highlighted for the advisor timeout (default 5s) and the
  reply is sent only if the card is still pending.
- OpenCode approval advisor eligibility: the mutation-only `medium` class is no
  longer blanket-eligible. Only the host-owned `node scripts/review-verify.js`
  runner may be widened; every other mutation (`node`/`python` scripts, `mv`,
  `sed -i`, `git commit`, redirections, …) and any `low` tuple carrying
  `mutation` fails closed. The advisor prompts now describe this two-class
  allowlist, the policy version is `advisor-external-3`, and the reviewer/contract
  comments and Phase 2 doc match the code.
- Claude `AskUserQuestion`: configurable wait (`CRETLI_CLAUDE_QUESTION_TIMEOUT_MS`,
  default 30 min), session idle timer paused while a question is pending, pending
  questions replayed on WebSocket reconnect, and `questionResolved` / UI feedback
  when a reply arrives too late.

### Added

- Each harness now has a dedicated Statistics tab beside Keys and Models,
  showing its last 7 days of runs, errors, latency, plan limits and lockouts.
  Direct links to `/settings/harness-{id}-stats` open the matching panel.

- Settings → Usage now shows per-harness plan windows, measured remaining
  percentage, reset countdown, active model lockouts and a linear exhaustion
  forecast from successive readings of the same window. Missing, stale and
  reset readings never produce a forecast. Claude SDK fractions are normalized
  to percentages; model picking applies the plan penalty at 90% and keeps
  active lockouts excluded.

- Settings → Chat and agents → "Automatic chat titles": choose mode, provider and
  model of the server-side title generator. Providers with a one-shot HTTP
  chat-completion API are offered (OpenRouter, DeepSeek, Qwen, Codex, Claude),
  and Codex (ChatGPT plan) / Claude (subscription) also work without an API key via
  a one-shot local `codex exec --ephemeral` / Agent SDK call with tools denied (uses
  plan quota, writes no chat); `auto` picks the first available. CLI/SDK
  harnesses (Cursor SDK, OpenCode, CodeBuddy) are listed as unavailable with the
  reason. New `GET /api/settings/auto-title/providers` and
  `POST /api/settings/auto-title/test` (writes nothing, never returns a key);
  `PATCH /api/settings` rejects an unknown `autoTitle.provider` with 400. The
  server log now says why no generator ran (no key / wrong OpenRouter key format
  / harness disabled) instead of a generic "no API key".
- Agent-set chat titles: new MCP tool `chat_set_title` (calling chat only, backed by
  `POST /api/chats/:id/agent-title`) and Settings → Chat and agents → Titles →
  "Who sets the title" (server / agent / agent with server fallback). In agent
  modes every harness prompt carries a short instruction to name the chat after the
  first reply and again after a substantial change (Agent mode only, never for
  manual/locked or temporary chats, nor for a delegation chat until its delegation has
  finished); renames go through the same
  sanitizer, CAS and history as server titles, limited to one per 10 minutes and 12
  per day. `PATCH /api/settings` rejects an unknown `autoTitle.source` with 400.
- Chat title history and controls: `POST /api/chats/:id/regenerate-title` (explicit
  regenerate, overrides a manual title), `GET /api/chats/:id/title-history` and
  `POST /api/chats/:id/title-lock`. MCP `chat_show` returns `titleHistory`. Chat
  settings gain a "Title history" timeline (restore an old title, "lock title"
  switch), "Update chat name" now calls the server instead of prompting the agent in
  the conversation, and the chat list marks auto/manual titles. `chatsChanged`
  `reason: 'title'` refreshes an open settings modal without overwriting text being
  typed. Local harness plugins now get the first-turn auto title too.
- Todo panel: multi-select status filter on root tasks (idea / ready / doing /
  done), with subtree preserved and filter choice stored per workspace folder.
- Added the `cretli-release` release-review skill for Cretli chats and a
  project Cursor subagent with the same read-only workflow.
- Claude Code harness on the Claude Agent SDK (isolated optional install).
  It supports Anthropic API keys, the Claude Code plan login, and
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and detects the macOS
  Keychain login. Plan, Ask, and review block edits with a `PreToolUse` hook
  and `disallowedTools`, and load only project settings, so `permissions.allow`
  rules cannot bypass them. Subagent text stays out of the main reply. A stale
  resume session is cleared and the prompt retried once. Cancel interrupts
  before it aborts. Permission denials and API retries no longer fail the run,
  and SDK error codes map to readable messages. Cretli no longer refreshes plan
  tokens itself; Claude Code does.
- OpenCode can use Xiaomi MiMo V2.6 Pro and Flash through a configurable MiMo
  API key and regional Base URL.
- Model catalog favorites can be managed per harness in Settings, including
  model labels that distinguish otherwise identical display names. Added
  harness icon assets and shared skill discovery across `.agents/skills` and
  the existing Cursor skill directories.
- Delegation MCP results now surface `interrupt_code` in
  `delegation_show`/`delegation_wait`/`delegation_start`. A review that only
  starts through `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1` returns
  `review_uncertified=true` with a visible warning instead of silently looking
  certified.
- The OpenCode approval broker advisor can speak the System One protocol
  (Jev/Laya) as well as the existing OpenAI-compatible chat protocol. Settings
  gain `approvalBroker.advisor.protocol` and `minProbability` (the `noul`
  threshold, clamped to 0.5–0.99), and the advisor audit records the protocol.
- Delegation ratings: the parent rates a finished job with MCP
  `delegation_rate` (stars 1–5, allow-listed telemetry tags, optional note) and
  the user from the delegation card over `POST /api/delegations/:id/rate`
  (weight 2× in the mean). Ratings are immutable per (job, rater) — an
  identical replay succeeds, a changed payload conflicts — stored as metadata
  in the rotating `data/delegation-ratings.jsonl` (no report text), and blend
  into `model_pick` quality for every role including review (max 25% share, an
  exact no-op without ratings). Settings → Usage shows the star average and
  count per harness/model/role. The multi-harness skill requires a parent
  rating after FAIL → fix → PASS and when a report is rejected.
- Delegacje zbierają teraz metryki efektywności per run w polu `metrics` rekordu
  (wszystkie pola nullable — brak danych to nie błąd): tokeny `tokens_in` /
  `tokens_out` oraz `tokens_out_per_sec` (harness Cursor SDK, z `lastUsagePayload`),
  `tool_calls_n` (licznik zamkniętych tool calls w SDK) oraz `files_changed` /
  `lines_added` / `lines_removed` z snapshotu `git diff HEAD` przed startem i po
  zakończeniu (tylko implement/fix; git działa dla każdego harnessa). `model-pick-history`
  agreguje z tego `median_tokens_per_sec` (każda rola) oraz `median_tool_calls` /
  `median_files_changed` (implement) w bloku `observed`. `model_pick` wystawia te
  pola na `candidates[].observed` (tylko odczyt; ranking nadal blenduje `pass_rate`
  przez observed quality, nie mediany wydajności).

### Changed

- Claude chats keep one streaming Claude Agent SDK session per chat instead
  of starting a Claude Code process for every prompt. Model, permission mode,
  and MCP changes apply to the live session through the SDK control calls.
  The session restarts with resume only when the mode class, workspace, or
  auth changes. Cancel interrupts only the current turn. Idle sessions close
  after `CRETLI_CLAUDE_SESSION_IDLE_MS` (default 10 minutes), and
  `CRETLI_CLAUDE_STREAMING_SESSION=0` restores one process per prompt. Claude
  chats now set the `claude_code` system prompt preset. Before this change the
  SDK sent an empty system prompt.
- Claude chats receive the Cretli MCP bridge. Builtin tools, including
  `delegation_reply`, are loaded in the prompt instead of deferred tool search.
- Delegation runtime skips empty outbox flushes and drains mailboxes only for
  known chats with queued messages.
- Updated the Cursor and Codex SDK optional dependencies. SDK model registry
  rejections now remove the rejected model from favorites and reset the chat
  selection to Auto. Skill context is included in SDK prompts when a skill is
  selected by the user.
- Delegation boot recovery now shares `probeChatRunLiveness` with the runtime
  worker: unknown adapter state (missing adapter, null state, exception) keeps
  the occupied slot instead of interrupting, confirmed idle
  `running`/`waiting_for_input` gets the same 60s orphan grace as the worker,
  and the starting timeout fires only on confirmed idle. Interrupted jobs carry
  a durable `interruptCode` (`server_restart`, `starting_timeout`,
  `running_orphan`; legacy rows stay empty). Only `server_restart` may be
  continued, and only once per record; other codes and legacy interrupted rows
  are stop-only. The parent skill documents the report-state persistence and the
  narrowed `exclude_harness` rule.

### Fixed

- Delegation run metrics: SDK `tool_calls_n` is recorded only for
  `implement`/`fix` (plan/review stay null); `beginHarnessRun` clears
  `room._lastUsagePayload` so a retry on the same room does not inherit stale
  token totals; git diff metrics count a file when a run reverts pre-existing
  dirty work to HEAD even when line deltas are zero.
- Completed delegations no longer leave a stale `runStoppingAt` marker that
  blocks workspace `implement`/`fix` for other parents after the child run is
  gone (including across server restarts). Terminal rows past the stopping
  stale window release the slot and persist a cleared marker; `workspace_busy`
  responses name the blocker delegation id and parent chat.
- DeepSeek review delegations no longer die within a second with Cordis
  `cannot create effect on inactive context`. The read-only review overlay
  paired `read-only` with approval `never`, which no stock DSH permission
  preset matches, and its `sandbox-policy` override dropped the required
  `workspaceRoot` (loader patches replace the whole `config`). The overlay now
  declares a `cretli-review` preset as the default and restates
  `workspaceRoot`; the test boots the real `dsh` with the overlay instead of
  only matching YAML text.
- OpenCode approval broker: a room recreated without delegation metadata now
  rehydrates its delegation from the saved child chat (active job with a matching
  `childChatId` only) before subscribing to events. `off`-mode delegated reads
  stay inside the assigned workspace, and Cretli `data/` secrets such as
  `data/config.json` are never auto-approved in any mode. Secret detection also
  covers shell separators glued to the path (`data/config.json|head`), globs,
  braces, quotes and alternate spellings (`data/*.json`, `data/./config.json`,
  `'data/'config.json`, `HEAD:data/config.json`), searches that target the
  `data/` directory (`rg foo data/`, `cd data && …`) and environment dumps (`env|head`,
  `printenv`, `export`). Relative `..` tokens (`..`, `../other/x`,
  `lib/../../x`) are resolved against the workspace, and commands with shell
  expansion (`$VAR`, `$(…)`, backticks, `~`) always go to the user; `$` inside
  single quotes is literal and does not count. This is a token heuristic, not a
  shell parser: `cd` state across commands, a bare `data` search target without
  a slash (`grep -r key data`) and recursive searches of the whole workspace are
  not tracked. A permission that
  was already pending before the room was recreated is not replayed by the event
  stream and still needs a manual answer.
- Codex review no longer aborts the delegation on read-only `git remote`
  (`git remote`, `-v` / `--verbose`, `show`, `get-url`). `add`, `remove`,
  `rename`, `set-url`, and `prune` stay denied.
- Browser navigation no longer fails on an empty GET/HEAD body that Chromium
  exposes as JSON `null`. Added explicit workspace debug opt-ins for reaching
  Cretli's own origin and accepting invalid TLS certificates; both remain off
  by default.
- Duplicate SDK catalog labels now expose model IDs and variant parameters so
  distinct models remain identifiable in pickers.
- Replaced a private LAN address in the Browser settings example with a
  generic host name.
- Skills are now loaded into the prompt only when explicitly invoked with
  `@skill-name`, avoiding accidental activation when their names appear in text.
- SDK history replay starts every initial window, fetched page, and prepended
  older page on a user turn. A run keeps its leading Thinking block, so reloading
  or paging an older run rebuilds the same Activity trays as the live stream
  instead of splitting the first tool calls into a standalone tray.

- Added the default-off OpenCode approval advisor Phase 2: a single redacted,
  HTTPS/DNS-pinned OpenAI-compatible request for opt-in low-risk reads, with
  daily quota, fail-closed errors, request-id idempotency, secret-safe audit and
  no automatic write/edit/network approvals.

- Browser hardening: DNS pinning is documented as defense-in-depth rather than an
  IP-level guarantee; every navigation/subresource redirect hop is policy-checked;
  URL userinfo, IPv4-mapped/NAT64/6to4 metadata, and Cretli's own origin
  (including `CRETLI_PUBLIC_ORIGIN` behind a reverse proxy) are rejected; loopback
  (`allowLocalhost`) and RFC1918/ULA (`allowPrivateNetwork`) are separate opt-ins;
  Chromium no longer inherits `CODEX_SESSION_ID`/`CODEX_THREAD_ID`; REST input and
  `force` screenshots share the WS rate caps; the panel paginates with the real
  `nextSince` cursor and reads `canGoBack`/`canGoForward` from CDP history; and
  non-proxied WebRTC UDP is disabled at launch.

- Review fanout no longer marks jobs `failed` / `adapter_incomplete` while the
  child waits for approver input: OpenCode review auto-allows non-mutating
  permissions, implement/fix keep Ask with `waiting_for_input`, and
  `delegation_wait` keeps `slot_occupied` until the job is truly terminal.

- Chat catch-up no longer duplicates the last **Answer** bubble when the live
  card is already on screen and a later usage/run-finished block sits after it.
  The same historySeq / room seq reuses the existing card instead of inserting
  a second copy. Already stacked copies collapse on the next history apply.
  CreatePlan snapshots (`{"plan":""}` then the full Markdown) share one
  Implementation plan card by call id instead of leaving 3–5 running copies.

- Consecutive idle-wait cards stay one series: later ticks reuse the previous
  waiting block instead of stacking a new card after compact status/system
  lines or a dropped live pointer. Already stacked cards collapse into the
  newest one immediately (next tick, history replay, or isolated insert).
  Polish timeout notices with „Próg ostrzegawczy” parse as the same series.
  History stores `progress` on those notices so F5 restores one newest-first
  card. Review-verify catalog ids: `timeout-progress-series`, `notices`.

- Review children no longer die on MCP probes: opaque or mutating MCP is
  denied without aborting the SDK run, and `delegation_reply` stays allowed.
  `model_pick` for plan/review skips uncertified harnesses (Codex) so the
  parent does not get a favorite that `delegation_start` will refuse.

- Parent mailbox analysis cannot impersonate the child: `delegation_reply`
  `chat_id` must be the calling chat, inbound `[CHILD REPLY]` tells the parent
  not to call `delegation_reply`, and a second `final_report` without an
  attempt id is `already_terminal` once any final exists for that job.

- `delegation_reply` run/attempt mismatch (409) now names the executing
  `run_id`/`attempt_id` so children can retry after a stale `delegation_show`.
  MCP bridge `/api/mcp/bridge/call` forwards request abort when the client
  disconnects before the response is sent.

- Compact tool tiles no longer stay on a spinner after the answer finishes:
  start/result events share the same call id (including newline-concatenated
  Cursor ids), and leftover running tiles close when the run is idle even if
  history omitted FINISHED. The agent idle timer no longer treats local
  `_agentState` as live work, so `onHarnessIdle` can clear the tray.

- Review delegations no longer look successful when the child stops on a
  one-liner or compacted thinking dump: that finish is `failed` with
  `adapter_incomplete`. `model_pick` for `review` skips `*flash*` ids.
  OpenCode waits 180s for the first SSE event (still overridable). SDK and
  OpenCode idle watchdogs do not cancel a run while native tools are in
  flight.

- `model_list(..., enabled_only=true)` no longer lists the whole catalog when
  Settings favorites are empty (default deny). Those rows are not
  start-eligible; the empty-favorites `delegation_start` error says so.
  One-shot “named model” delegations skip `model_pick` and workflow in the
  multi-harness skill; `review_uncertified` is not an `implement` bypass.

### Changed

- DeepSeek **review** delegations are certified: DSH starts with a generated
  read-only sandbox patch and headless approval policy; adapter capabilities
  declare `sandboxReadOnly`. Review turns no longer abort the whole job on
  sandbox-denied writes (same as OpenCode/OpenRouter).

- Chat UI stays responsive with large sidebars: background WS sync no longer
  re-renders every disconnected chat, list status updates coalesce on rAF, and
  each workspace shows 40 live chats until you expand. `GET /api/chats` omits
  `summaries` unless `includeSummaries=1`. History-batch posts up to 16 chats
  and backs off empty pulls. Model catalogs and GitHub load after Settings /
  idle. SDK Markdown skips PTY heuristics, forced layout, and `innerText`
  copies; highlight.js is a lazy chunk. Heartbeat is 30s; command poll 15s.

- Chat boot no longer fetches harness model catalogs (CodeBuddy / OpenCode /
  SDK) until Settings → Harness. `GET /api/chats` skips archived rows unless
  the archive section is open. Collapsed workspace groups render the header
  only. markdown-it is a lazy chunk; history replay yields after 20 records.
  The ping loop scans open sockets every 5s. Boot coalesces overlapping
  chat-list GETs (`skipIfInFlight` on panel show). History-batch waits 1.5s
  for the sidebar snapshot, skips idle ids when the visible set is empty,
  and posts at most two batches per poll. Title sync is 120s and skips an
  in-flight list load. Disconnecting a background WS drops it from the ping
  set. markdown-it loads on first render, not on rich-view mount.

- Sidebar agent badges update from coalesced `agentPresence` on existing
  `/ws-agent-sdk` sockets (widget-scoped). HTTP `agent-states` is skipped only
  while that feed is fresh and Redis multi-instance is off. Live tool names
  are allowlisted basenames; Completed/Failed from the server beat a stale
  local “working” state.

- Chat history polls no longer overlap the 15s timer with gap-recheck, and
  `getChatHistory` reuses in-flight GETs. Diagnostic commands have one poll
  (paused while the document is hidden); the 30s heartbeat no longer pulls
  commands. Background HTTP history uses the WS reconnect batch/concurrency
  budget (never 0 on mobile), skips chats already covered by WebSocket unless
  a delegation is pending, and does not clear `_pendingRemoteHistory` while
  the view still lags the server. Multi-chat history pull is
  `POST /api/chats/history-batch` with an explicit id list (empty body is 400,
  widget scoped). `GET /api/chats/:id/history` stays compatible.

- Product decision (2026-09-20): delegations do not get a Dream-RSI layer.
  An `attempt` is a retry of the same job (fencing and idempotency), not a
  search branch with siblings. `VERDICT` is another model's opinion
  (`PASS`/`FAIL`/`BLOCKED`), not a fixed numeric replay evaluator, so
  offline policy dreaming on stored jobs would be guessing. The server
  keeps linear parent-loop state (role, round, stop) and does not
  sequence exploration, worktree implementation fanout, or simulator
  replay. Review fanout stays an optional width cap, not an executor
  pool or decision tree. Isolated worktrees plus a hard test score remain
  a possible later product, not a Dream-RSI plugin on today's store.

### Added

- Builtin MCP `delegation_wait`: bounded long-poll for parent jobs (`timeout_ms`
  default 20s, max 25s, below the 30s bridge HTTP timeout; `until` all|any).
  Returns `done`/`pending` plus per-id slot/outcome/verdict, not the report.
  Chat UI shows “Waiting for N agents” above existing delegation cards.

- Cursor SDK chats automatically receive bundled Cretli skills and agents through
  a skills-only runtime share, without loading the Cretli repository rules.
  The agents panel includes project skills; context queries accept a chat workspace.

- Two concurrent **review** jobs on one parent are the default
  (`CRETLI_DELEGATION_REVIEW_FANOUT`, cap 2). Set `=1` to keep a single
  review slot. Implement/fix stay exclusive. A third review returns
  `review_fanout_full` (MCP CONFLICT). This is not the D10/M12 executor
  pool. The execute-plan command in chat only blocks when a mutating job
  is already active; two review cards and “Waiting for N agents” stay
  visible together. Settings Delegation center keeps Stop per job.

- Builtin MCP `model_pick({ role, exclude_model, exclude_harness })` selects a
  Settings favorite for plan, implement, review, or fix on a harness that is
  enabled, ready, and delegatable. Empty favorites are unset for this pick (not
  the whole catalog). Ranking uses frozen heuristic `cost_tier` /
  `quality_tier` / `speed_tier` (local table + regex, not scraped benchmarks):
  implement prefers cheaper eligible favorites; plan/review prefer quality.
  Matcher lists are eligibility only. After a usage-limit or dead-harness fail,
  pass `exclude_model` / `exclude_harness` and start the next candidate (skill
  cap 3). `model_list` rows include those tiers and profile `roles`. Child
  chats cannot start another `delegation_start`. Skill/agent
  `.cursor/skills/cretli-multi-harness` and `.cursor/agents/cretli-multi-harness.md`
  describe the parent loop (no Cursor `Task`; parent does not commit or push).

- Delegation contract, review guarantees, and parent-loop durability
  ([docs/DELEGATION-AUDIT-2026-09-20.md](docs/DELEGATION-AUDIT-2026-09-20.md)):
  MCP list/show include `task_outcome`, `slot_occupied`, `run_stopping`, and
  parsed `VERDICT`; inbox `id` pages the body. Review capabilities split
  `preExecDeny` / `abortOnMutation` / `sandboxReadOnly` (event abort is not a
  write block). Uncertified review adapters are refused unless
  `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`. Health `ok` is readiness
  (stale or hung tick is not ready). Orphaned `running` is interrupted after a
  60s grace when the adapter is confirmed idle. Parent workflow state
  (`delegation_workflow_show` / `update`) stores rounds/findings/deadline
  without a server sequencer. Same-workspace mutating jobs from two parents
  return `workspace_busy`. Opt-in `CRETLI_DELEGATION_GLOBAL_LIMIT` caps occupied
  slots. Empty Settings favorites now deny `delegation_start` by default;
  `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores the previous start behavior.
  Review-verify catalog includes representative isolated delegation tests.
  Workflow updates store every applied `idempotencyKey`→fingerprint (replay of
  an earlier key is a no-op). `materialRevision` is a code/artifact id; a second
  identical FAIL stops only when findings and material revision are unchanged.
  MCP writes go through the in-process or remote API client (`GET`/`POST`
  `/api/chats/:id/delegation-workflow`); the in-process client also refuses
  child/foreign `chatId`. Adapter `getState` null/unknown no longer counts as
  confirmed idle; orphan grace starts at the first confirmed idle observation.
  Deadline cancel is non-blocking (deduped per delegation/attempt).
  `same_findings` compares a new FAIL with the last FAIL review's material and
  findings snapshot, so a separate material patch no longer deadlocks.
  `delegationService.cancel` fences `attemptId`/`runId` after adapter `await`
  so a stale cancel cannot finish or release a newer attempt.
  Multi-harness skill has `loop` and `fanout-review` modes, infra retry with a
  new idempotency key, and `TASK:` plus parent verification. MCP list/inbox
  text uses full UUIDs and `scope=all`. OpenCode first-event timeout
  sets `adapter_timeout`. `readDelegationMaterialRevision` snapshots git HEAD
  plus dirty status. Workflow stores `lastReviewer` for review rotation.

- Copy-ref on saved user and assistant chat blocks: one clipboard line
  `cretli-ref chat=<full-uuid> seq=<n>`. The receiving agent loads the current
  saved text with builtin MCP `chat_event({ chat, seq, field: "text" })` (page
  with `offset`/`length` until `next_offset` is none). Thinking, tool, queued,
  and in-flight blocks stay hidden. Copy content, Fork, and Pass are unchanged.
  No new HTTP endpoint, composer auto-expand, `content_hash`, or seq ranges.

- Mobile overlay: swipe the chat sidebar left to dismiss it, or swipe in from
  the left screen edge to open it. Desktop, pin, and Safari back-swipe are
  unchanged.
- Delegation Phase IIIb: retry-delivery always requires `mailboxId` (including
  0 or 1 retryable messages), coalesces parallel/replayed delivery and task
  retries, recovers a `final_report` crash after the durable attempt result,
  and adds an isolated HMR=0 Playwright pass of Settings → Delegations.
  Adapter coverage is per real `*-agent-ws` module; live paid models stay
  deferred. See [docs/DELEGATION-MODERNIZATION-PHASE-3B.md](docs/DELEGATION-MODERNIZATION-PHASE-3B.md).
- Delegation Phase III: finishDelegation persists a durable attempt result
  without auto-reviewed, and holds the parent slot until the child run is idle.
  Busy start/retry returns `job_in_progress`, `run_stopping`, `stale_running`,
  or `unknown` with `delegationId`/`attemptId`. MCP maps `still_active` and
  `parent_busy` as CONFLICT. Retry-delivery targets one mailbox message.
  Settings Delegation center confirms mutations, shows API errors, paginates
  past 40 jobs, and documents an HMR=0 webpack `--no-watch` one-shot. See
  [docs/DELEGATION-MODERNIZATION-PHASE-3.md](docs/DELEGATION-MODERNIZATION-PHASE-3.md).

- Delegation runtime health (`GET /api/delegations/runtime`) and a Settings
  Delegation center: worker vs process liveness, delayed ticks, degraded
  recovery, scoped summaries, retry-task vs retry-delivery.
- Single-writer lock for JSON delegation files, schema rejection for newer
  documents, controlled boot/shutdown, and a SQLite backend (`node:sqlite`)
  with backup/migrate/rollback. Default store stays JSON until an operator
  migrates. See [docs/DELEGATION-STORE.md](docs/DELEGATION-STORE.md).
- Isolated server E2E for delegations (separate port and data directory,
  real SIGTERM). Live paid-model adapter certification is not included.
- Delegation Phase IIb isolated E2E: SIGKILL during start/accept, busy-parent
  mailbox, two `waiting_for_input` cycles, run-count after recovery, and a
  Playwright pass against the live Settings Delegation center (filters,
  retry-task vs retry-delivery, keyboard, PL/EN, mobile, workspace scope,
  browser reconnect to that instance's WebSocket).

### Changed

- Sidebar chat rows archive on the archive icon instead of deleting. Archived
  rows restore with the matching icon. Permanent delete stays in the chat
  dropdown and the chat menu.

- Cursor SDK agents treat other harness models as available for a sub-chat
  through `harness_list` / `model_list` / `delegation_start`. Cursor `Task`
  still only lists Cursor-local models; that list is not the Cretli catalog.

### Fixed

- Cursor SDK review no longer aborts when Grok (and similar models) call
  builtin read MCP through the generic `mcp` wrapper. The guard classifies
  the inner `toolName` (`delegation_show`, `chat_history`, …). Opaque or
  mutating MCP still denies and still aborts the SDK review job.

- Chat list presence poll no longer sends every chat UUID in
  `GET /api/chats/agent-states?ids=…`. A long query plus cookies hit Node's
  16 KiB header limit (`431 Request Header Fields Too Large`). The poll omits
  `ids` and the response is a compact map (busy / waiting / attention only;
  missing id = idle). History-revision GETs still send `ids` when short; when
  omitted they return the widget/main allowlist, not the unscoped in-memory
  index.

- After PWA lock/unlock, the SDK mode bar shows “Syncing messages…” /
  “Synchronizacja wiadomości…” while history catch-up sleeps (mobile 2.5s)
  or waits for WS replay, instead of a stale generating/connecting label.
  The label clears when the cycle finishes, after 8s, or if IndexedDB/fetch
  hangs (tracker then allows the next resume). A hidden document after that
  sleep skips HTTP fetch. Composer, draft, scroll, recovery modal, and the
  service worker are unchanged.

- Review verification is a host-owned runner (`node scripts/review-verify.js`)
  with a frozen catalog, isolated data dir, and temp cwd. Cursor SDK review
  offers native `shell` for that runner and read-only explorers; edit/delete
  stay withheld and mutating commands abort the turn (no pre-exec hook).
  Arbitrary `tests/**/*.test.js`, `--test-reporter`, and mutations stay denied.
  Harnesses that can reject before exec do not abort the review job after a deny.
  DeepSeek review no longer dies on DSH `todo_write` (same list as Cursor
  `todo`); file `write`/`edit` still abort that job.

- OpenAI voice Live no longer cuts the assistant off mid-word: `max_output_tokens`
  is 600 (was 220, shared with audio tokens). Session logs record `response.done`
  status when a turn is still incomplete.

- Returning to the PWA no longer leaves an active chat missing replies that
  already exist on the server: HTTP catch-up runs after short background
  intervals, open sockets, and WS replay, store ACK is not treated as proof
  the view is current, and a missed `sdkHistoryChanged` or another client's
  history read no longer disables recovery. A later live mailbox/delegation
  card does not hide an earlier hole, catch-up is chronological, render
  failures do not advance watermarks, and polling does not mark an open
  WebSocket healthy after error or deferred sync. Stale pong detection now
  uses the first unacked ping. Catch-up now keeps a view-instance guard through
  fetch/apply, applies `localUser` prompts from other clients without duplicating
  optimistic echoes, notes historySeq for already-rendered live/replay events
  without jumping past holes, and starts contiguous coverage from the hydrated
  window rather than a lone live card. A failed HTTP catch-up during reconnect
  no longer advances room watermarks for unrendered WS replay, so a later
  retry still shows the missing reply exactly once. A live `applyEvent` throw
  keeps that room seq as a hole: a later seq 102 or `sdkRunFinished` does not
  mark seq 101 covered, and catch-up or WS retry still renders response 101
  exactly once, inserted before the later card (assistant, run-finished, or
  delegation) without a destructive full replay. Room event seq is compared
  only inside a proven `eventStreamId`; a new stream's seq 1 is not placed
  before an older session's seq 102, and a missing stream id does not invent
  a global room order. Isolated Chromium coverage exists for the
  transport→store→DOM path and a production resume path with mocked HTTP plus
  IndexedDB; a real Android/iOS PWA session was not run.

- Child `delegation_reply` with `final_report` no longer awaits cancel of its
  own SDK run. That deadlock left the MCP bridge spinning until the agent was
  cancelled. The report is persisted and returned first; leftover-run stop waits
  a short grace so the MCP tool result can land, skips cancel when the run is
  already idle, and rewrites that leftover `sdkRunFinished` to completed on
  every harness. Only the accepted `finalReportRunId` is rewritten, so a later
  user cancel in the same child stays a real cancel. The frontend also ignores
  `lastErrorCode=delegation_final_report`. Leftover cancel after an accepted
  `final_report` is silenced by the `runId` fence and covered by kernel rewrite
  plus hydrate recovery tests; the child-stop timer stays an ingest window, not
  an SLA. The Activity tray shows **Reported** / **Raport wysłany** (green),
  not CANCELLED: leftover `status` events are rewritten the same way, and a
  later cancel in that run cannot replace a reported/completed tray.

- Swiping the sidebar closed no longer snaps it back open when pointer capture
  is lost as the drawer slides under the finger.
- Starting a sidebar swipe no longer flashes the page under the drawer (CSS
  closed transform `translateX(-100%)` for a frame when transition was cut).
- Mobile overlay keeps the sidebar resize handle; swipe-to-close ignores
  `#sidebar-resizer` instead of disabling pointer events on it.

- MCP/CLI archive, restore, and delete now push `chatsChanged` on agent
  WebSockets so the sidebar reloads without a page refresh. Bulk archives
  coalesce to one `GET /api/chats`.

- SDK `status` FINISHED now stops Thinking spinners and marks every Activity
  tray of that run. The last tray could already show FINISHED while earlier
  trays stayed RUNNING and the Thinking block kept spinning after the chat
  was idle.

- Related-chat cards in a parent stream hid after the child was archived: the
  sidebar dropped them, but history replay still painted “Child chat” rows.

- A finished review child no longer keeps the read-only tool lock on later
  Agent turns in that chat. The host used to treat sticky
  `delegationAssignment=review` as Plan mode (`Plan mode blocked execution`)
  even after the job completed. The review guard now lasts only while the
  job is active, and the deny message names the review assignment.
- Delegations: distinct child replies and per-attempt final reports; retry no
  longer inherits review or suppresses the new report; oversize tasks fail
  before creating a job; start/retry cannot overwrite an early terminal
  status with `running`; cancel during a delayed start stops the late accept;
  outbox delivers an attempt snapshot and marks only that intent after a
  confirmed result; corrupt `delegations.json` is not silently replaced;
  HTTP ack/retry honor the requested workspace; a second `waiting_for_input`
  cycle is recorded.
- Delegation runtime worker catches timer failures (corrupt JSON included)
  without an unhandled rejection or process exit; it reports a degraded
  state, retries with backoff, and does not rewrite the damaged file.
  Outbox delivery patches one intent on the latest record so an append
  during `await` is not dropped; ticks do not overlap, and boot/bridge/runtime
  flush is serialized.
- Delegation store safety: remigrating a switched directory no longer wipes
  SQLite; JSON→SQLite copies resume from a checkpoint and hash full records;
  owner lock does not steal a live writer during the metadata gap; SQLite
  CAS reads, validates, and patches inside one transaction; shutdown honors
  its deadline and keeps the lock while a late store callback can still
  write; runtime health scopes mailbox counts and stays readable when the
  store is corrupt; a newer SQLite schema is refused before any mutation.

### Changed

- Review assignments apply a read-only tool profile on adapters
  (including DeepSeek) while that job is still active; the child still runs
  as Agent. After the job ends, follow-up turns in the same chat follow SDK
  mode. Dedicated read tools stay available during review; mutating tools
  and shell are denied without a shell command allowlist. Report prompts
  include blockers and artifacts; large reports are truncated in the parent
  context with a pointer to `delegation_show`.
- JSON persist remains the single-process store. A 200-item write/read
  measurement and overlapping same-process writes stay acceptable; two
  processes writing the same file can lose updates (last writer wins). No
  new engine or executor pool in this change.
- A periodic delegation runtime worker flushes the outbox with backoff,
  times out stuck starting/cancelling/dispatching jobs, and drains mailboxes.
  It does not treat a live in-process start as a boot interrupt.
- A delegated child job that ends as completed, failed, or interrupted now
  enqueues one parent mailbox reply (`Child reply`) when the executor did not
  send `delegation_reply`. Cancel and start/retry failures do not ping the
  parent. The report collector skips jobs whose reply is queued or delivered.

### Added
- Isolated Playwright fixture for the real delegation history card
  (`npm run test:e2e:delegation-card`): replay/reconnect, retry, cancel,
  errors, and uncertain delivery, with mock endpoints on a separate port
  and without touching the running app store.
- DeepSeek and Qwen Settings catalogs load live vendor `GET /models` lists when
  an API key is set (15-minute cache, fallback on timeout or error). DeepSeek
  default is `deepseek-flash` (V4.1 Flash); retired Flash ids remap in the
  enabled-model list so the chat picker matches the live catalog. The DSH
  `llm-deepseek` overlay declares image input on Flash so `read_image` works
  (stock DSH treated unlisted ids as text-only).

- Chat history shows a clickable parent/child link when a harness creates a
  child chat, forks a conversation, or nests a chat in the sidebar.
- Chat mode selector is one Plan / Agent / Ask dropdown (same pattern as
  Build plan). Ask is a distinct read-only mode: questions and analysis
  with allowed reads, without file edits, plan persistence, TODO sync, or
  treating “yes” as approval. Mutating tools, MCP writes, and delegation
  start are blocked before execution. Codex Ask also denies mutations;
  Codex Plan stays prompt-only. Cursor SDK still receives only
  `agent` | `plan` natively; Ask maps to agent plus disallowed tools.
- MCP integrations in Settings: stdio and Streamable HTTP servers, workspace and
  harness scope, secrets stored apart from `data/mcp.json`. Agents receive tools
  through a Cretli-managed bridge. Plan blocks writes before the handler runs,
  using the live session mode rather than the client request. Operator setup:
  [docs/mcp/SETUP.md](docs/mcp/SETUP.md).
- Builtin Cretli MCP tools for TODOs, saved chat plans, plan-execution
  delegations, and catalogs of tasks, agents, harnesses, and models. Reads stay
  allowed in Plan; creates/updates and delegation start/cancel/reply need Agent.
  `delegation_start` can target a saved plan or a chat-history message.
  `delegation_reply` and `delegation_inbox` share the same mailbox as the chat
  arrows. The catalog is shared by the in-process server and `npm run mcp`
  (`scripts/cretli-mcp.js`). Standalone stdio requires `CRETLI_MCP_WORKSPACE`
  and `CRETLI_MCP_MODE` (Plan blocks writes without a bridge token). Long
  plan/TODO/delegation details are
  paged with a revision-bound cursor (`todo_show` / `chat_plan_show` use
  `updatedAt` / plan revision; `delegation_show` hashes the field content with
  the delegation id).   `chat_history` pages conversation events by seq (optional
  tool args/results, `fork_parent_chat_id` on `chat_show`). `chat_event` reads a
  UTF-16 slice of one event field. Forward pages send
  `since`+`limit` (not `tail`). Each page has a character budget; paging
  cursors are in the text as well as structured data. Chat list/history
  default to the calling workspace; pass `scope=all` to read another workspace.
  Harness/model catalogs are served from
  `/api/harness-catalog/*` so an external stdio client uses the target instance.
  `model_list` rejects a missing, empty, or unknown harness instead of falling
  back to Cursor SDK.
- Cursor SDK conversation stores: ignore patterns are synced onto every
  attached workspace root **and inside store directories**; the agent is
  reloaded after create/resume so a session started before those files still
  sees them. OpenRouter also denies shell commands that name those paths.
  Live check: `npm run test:live-cursor-sdk` (separate completed Glob/Grep/Read
  attempts and distinct hello-file **contents**; production persist fork of
  Ask vs a newer Delegations transcript; ignore applied after a warmup turn
  then `reload` + resume. `@cursor/sdk` 1.0.30: Glob of a store dir completes
  empty; native Read of ignored jsonl/symlink drops `completed` — not a pass;
  native shell can still cat stores — not claimed as MCP-only).
- Chat message arrows: **Pass to child** opens the harness picker and starts a
  delegation from that history message; **Reply to parent** sends the message
  to the communication parent. Sidebar grouping (`forkParentChatId`) does not
  change the reply target. Busy or waiting recipients queue the mail until the
  current run ends; Plan is not switched to Agent. Finished child work stays
  unverified until **Mark as reviewed**. Message and text delegations report
  only through the mailbox; plan-execution jobs still inject a parent-turn
  report. Duplicate starts with another idempotency key while a job is active
  return `409` instead of replaying the other job.
- PWA push when an agent is waiting: OpenCode permission / question prompts
  and Qwen `ask_user_question` reuse the same VAPID subscriptions as
  agent-finished notifications. The existing Settings toggle covers both.
- `npm run chat` talks to a running server over the HTTP API (list, show,
  archive, rename, delete) without editing `data/` files directly.
- `npm test` scans git-tracked files for live-looking GitHub / API tokens and
  private-key headers (`npm run test:secrets`). CI still runs gitleaks.

### Fixed
- Delegated plan reviews no longer receive the executor prompt that says to
  implement the approved plan. Delegations now carry an explicit `assignment`
  (`review` or `implement`) through MCP, HTTP, persistence, and child prompt
  construction; review assignments use the read-capable Agent tool surface so
  repository inspection does not get cancelled by SDK Plan-mode enforcement.
- Cursor SDK mailbox delivery waits for the run id returned after session
  setup and prompt acceptance. Reading it before asynchronous setup finished
  incorrectly marked accepted parent/child messages as `uncertain`. The
  mailbox card labels that state as delivery unconfirmed and can retry
  `failed` or `uncertain` messages.
- Sidebar chat trees nest each child under its immediate parent. Drag-and-drop
  keeps that parent (`data-parent-id` / the latest drop result) instead of
  walking up to the first non-child, captures the dragged subtree at pointer
  down so stale nest levels cannot swallow later rows, and lists every
  descendant (indent clamps after depth 8). Mailbox replies and parent/child
  history links are pushed live to an open chat (same path as delegation
  cards) and survive history catch-up. The mailbox card shows the sender
  title and updates queued → delivered; `chat_history` now lists those events.
- DeepSeek DSH `workflow` / `agent()` subagents no longer dump `[subagent started]`
  or child errors such as `no adapter registered` into the parent answer. They
  render as `subagent` tool blocks. `lastAssistantMessage` is DSH `ContentBlock[]`
  (plus a string fallback), so a child answer is no longer `[object Object]`.
  Child `session.event` finish/turn-end stays on that block when the final
  message is empty; known adapter/model errors become a `delegation_start` +
  Settings-enabled-model hint. A child turn cannot change the parent run
  status or replace `deepseekSessionId`. `delegation_start` falls back to a
  Settings-enabled variant of the same model id (for example Codex `effort=high`
  → favorite `effort=medium`) and lists those favorites when the model is
  unknown. `model_list(..., enabled_only=true)` is that favorite list
  (`enabled_only` stays false unless asked).
- Finished SDK runs stop the spinner on every Thinking block of that turn, not
  only the last one. A new Thinking block after an answer left the previous
  one spinning in the live view.

- DeepSeek no longer marks a turn `completed` when a rebuilt `dsh` process
  reuses a persisted `sessionId`. That collision returns idle with an empty
  response, so the next prompt after stop, MCP rebuild, or restart looked
  hung. Cretli now drops the id with the process, retries a collision once
  on a fresh session, and surfaces other empty/error turns in the UI.
- DeepSeek chats no longer die on the first prompt with Cordis
  `cannot create effect on inactive context`. The runtime overlay used a DSH
  `!!js` node for the plugin `name`; the loader needs a string file URL, so
  Cretli now writes that overlay the same way as the MCP patch.
- Returning to a hidden PWA or tab refreshes the chat list, so chats created on
  another device, widget, or agent run appear without a manual reload.
- `model_list` for Cursor SDK includes Settings-enabled variants (for example
  Grok 4.6 effort rows) when the live Cursor catalog is not fetched, and
  `delegation_start` resolves a short id such as `grok-4.6` (with optional
  High/Medium) to an enabled variant instead of `MODEL_UNAVAILABLE`.
- Cursor SDK history-isolation evidence no longer treats a `hello.txt`
  filename echo, a still-running Glob/Grep, or a cancelled/timeout call as a
  pass. `ok` needs **completed** native attempts per path (create, resume, and
  a session started before ignore files), distinct hello-file **contents**, a
  production persist fork of the Ask chat that keeps that task, and nested
  **file-glob** ignore inside store directories (not `*` / `**`, which aborted
  nested Glob). `@cursor/sdk` 1.0.30: Glob of the transcript dir completes with
  an empty file list; native Read of ignored jsonl/symlink stays `running`
  with no result (vendor drop, not a pass); native shell can still cat
  stores — not claimed as MCP-only.
- MCP runtime mode is read from the live room (`room.sdkMode` / `chat.sdkMode`),
  not from the snapshot passed into `buildMcpRuntimeContext()`.
- Revoked MCP integration tokens stay invalid after the same session is
  registered again: each restore gets a new incarnation id.
- OpenCode listen ports skip a port already owned by another session instead of
  attaching to whoever is already listening. Concurrent instance starts pick
  and reserve ports on one queue, so two sessions cannot claim the same port.
- MCP tool calls are denied when the live session mode is unavailable; the
  snapshot `mode` is not reused after a getter goes empty.
- A corrupt `mcp-secrets.json` blocks configuration writes instead of being
  treated as an empty secret map.
- MCP tool policy is checked again after `connectExternal()` so a Plan switch
  or disable during connect cannot use the earlier consent.
- MCP Plan enforcement no longer trusts a client-supplied `mode` on the bridge:
  the live session decides, so Plan still blocks writes after a spoofed Agent
  call or a later switch back to Plan.
- MCP secrets and the registry commit together; a `409` no longer leaves a
  partial secret change. OpenCode chats in the same workspace no longer share
  one `cretli_bridge` token. Qwen and CodeBuddy use the managed bridge so they
  receive builtin Cretli tools and the same Plan policy as the other harnesses.
- Build plan in a new agent lists every enabled harness that can start a run
  on the server (OpenCode, OpenRouter, Cursor SDK, CodeBuddy, DeepSeek, Qwen,
  Codex), not only OpenCode.
- A finished SDK chat no longer keeps spinning: Thinking blocks and Activity
  trays from earlier in the run (a run renders one per assistant turn) were
  never finalized because only the last one was tracked per run. Every block of
  a run is now registered, so `runFinished` stops all spinners and marks all
  trays.
- Fork continuation no longer tells the agent to pick up “the previous agent”
  from the newest transcript file. The prompt names the source chat id, the
  copied seq bound, and to load missing context with MCP `chat_show` /
  `chat_history`.
- OpenRouter file tools (`read_file` / `grep` / `list_directory`) refuse
  conversation stores (`agent-transcripts`, `data/chat-history`,
  `data/runtime-home`, `sdk-agent-store`). Cursor glob/grep/read follow
  `.cursorignore` (not only `.gitignore`). Shell access to those paths is still
  harness-specific and not fully blocked.
- The marketing page no longer loads a private LAN widget embed script.
- MCP `chat_history` `from_seq` no longer sends `tail`, so stdio/HTTP clients
  read from the start of the log instead of the newest window. History text is
  capped per event and per page; OpenRouter keeps `next_from_seq` /
  `next_before_seq` in the tool text. `chat_show` and `chat_history` share one
  page selection. Truncated fields continue with `chat_event`. `length` must be a
  positive integer so a truncated read cannot stall. The 8000-character page
  budget includes continue hints, not a fixed chrome reserve. Cursors follow
  scanned seqs, so a page of unrendered events can still continue.

## [0.4.0] - 2026-09-05

### Fixed
- Switching harness from a nested sidebar chat now creates the new chat under
  the same parent instead of making a new folder and moving the current chat
  into it.
- OpenCode Plan no longer stays locked after the user confirms a plan in the
  question UI: Cretli switches to Agent and lifts write permissions before the
  answer is sent, so the same turn can implement instead of repeating the plan
  hint.
- OpenCode permission Once/Always no longer shows `PermissionNotFoundError` after
  the request was already auto-denied. Stale replies are treated as resolved, the
  card closes when the matching tool errors, session permission rules are re-synced
  on each prompt, and the SSE loop stops after room abort (it previously kept
  writing a second event stream).
- OpenCode no longer snaps back to Plan after you switch to Agent mid-run (retries
  and queued prompts used the mode from send time). `session.idle` while a
  question or permission is open no longer ends the turn. Plan bash is asked
  (not blanket-denied) so read-only shell can explore; mutating bash is still
  blocked.
- Plan mode denies mutating tools before execution for OpenCode, Cursor SDK, Qwen,
  CodeBuddy, OpenRouter, and DeepSeek (`canUseTool` / permission / catalog / run abort).
  Codex Plan stays prompt-only and does not abort the turn.
- A later, shorter complete Plan-mode answer now replaces the previous plan file
  instead of being ignored because it was shorter. Progress comments no longer
  append to the plan.
- Stop on a delegated job no longer reports cancelled while the executor may
  still be running; the card stays on Stopping until the run ends.
- Delegation report cards are written to history before they are marked
  delivered, and boot recovery retries a missing card.
- Parent-model report confirmation uses the ids placed in that prompt, not every
  pending report. OpenRouter confirms after the agent loop starts, not before.
- Retry of an old job is blocked while another job for the same planner chat is
  active.
- Production delegation API checks the enabled model catalog. The build-plan
  form shows the approved plan revision and limits harnesses to server-started
  executors. Waiting-for-input updates the parent card.
- WebSocket widget subprotocol no longer bypasses Origin checks on terminal, task, or log
  paths; widget chat and page bridge still require a valid widget access token (iframe chat
  uses the Cretli origin, external embeds must match the token origin).
- `USE_HTTPS=1` no longer falls back to HTTP when TLS key/cert files are missing or invalid;
  startup exits with a remediation message. Use `USE_HTTPS=0` for explicit HTTP.
- Mutating API calls authenticated with the session cookie require `X-Cretli-Csrf`; a 403
  with `csrfRequired: true` refreshes the token once. Logout and session invalidation close
  active cookie-authenticated WebSocket connections.
- Same-host WebSocket Origin checks compare scheme, host, and port. `CRETLI_PUBLIC_ORIGIN`
  identifies the Cretli iframe behind a TLS proxy without trusting `CRETLI_EXTRA_WS_ORIGINS`
  as first-party. `USE_HTTPS=0` in `.env` is honored by the launcher; default certs are
  generated only for HTTPS with the default `data/` paths.

### Added
- `npm test` scans git-tracked files for live-looking GitHub / API tokens and
  private-key headers (`npm run test:secrets`). CI still runs gitleaks.
- Sidebar chats can be **reordered** with a press-and-hold drag (same gesture as
  workspace groups). Hover another chat for ~0.5s (dashed, then solid outline) to
  nest it as a sub-chat; drag among roots to lift it back out. Custom order is
  stored in the browser; the parent link is saved on the chat. Switching harness
  and keeping the previous chat hangs that chat under the new one.
- Chat list polls lightweight agent presence (`GET /api/chats/agent-states`) so an
  executor still shows working or needs-action without an open WebSocket. Finished
  jobs keep an attention badge until **Mark as reviewed** (`POST /api/delegations/:id/ack`);
  opening the executor only clears waiting-for-input. OpenRouter rooms hydrate
  conversation history after dispose so a later continue keeps context. Deleting a
  chat with an active job cancels that job first.
- Disconnected chats in the sidebar use the same muted action-icon size as
  trash/star, with a broken-chain glyph. Connecting uses a yellow blinking
  spinner instead of the “Connecting…” label. An active agent uses a spinning
  cog instead of “Agent working”. Needs-action uses a yellow alert icon.
  Status polls do not restart the spinner animation.

### Changed
- Production webpack uses `hidden-source-map` so map files are not referenced from the
  published bundles. Status-parser unit fixtures live in
  `public/fixtures/status-parser-unit.json` instead of the production parser module.
- `server.js` is a composition root: workspace selection, widget auth HTML,
  client debug log, webpack HMR, and HTTP route registration live in `lib/`.
- Codex and OpenCode chat rooms also use `lib/agent-harness/room-kernel.js`
  (Codex aborts the in-flight exec turn; OpenCode releases the instance lease
  and SSE subscription). Cursor SDK rooms remain separate.
- Chat model pickers (mode bar and new chat) only list **checked** catalog
  values. Sibling variants and stale ids no longer appear as choices.
- Voice `set_model` is instructed to run immediately when the user names a
  model. `list_models` now returns a short page (optional `query`) instead of
  the full SDK catalog, which was delaying the next Live function call.
- **Analyze current agent** is a sub-chat with empty history, not a conversation
  fork: it only gets the parent chat id and a live status snapshot (no copied
  transcript). The parent stays the subject to diagnose.
- Fork chat no longer auto-sends “continue previous work”. The new chat stays a
  quiet fork; the continue/handoff text is left in the send field and is only
  sent when you submit it (or replace it with your own message). Analyze-agent
  and **Fork chat + this message** still send immediately.

### Fixed
- Delegation and mailbox cards in chat no longer paint the whole report green
  or clip long executor text on both sides (especially on a phone).
- Plan mode allows Codex `web_search` and no longer treats `rg 'a|b|delete'` as a
  mutating pipeline (quoted `|` is not a shell pipe). Incomplete shell starts and
  `$(` / `|` inside `rg` patterns no longer abort the turn; Codex `parsed_cmd` is
  ignored when the real exec argv is present.
- Codex Plan mode no longer aborts the exec turn. Host-side plan-guard heuristics
  were cancelling read-only `rg`/`cat`/`web_search` batches; Plan is prompt-only
  (`danger-full-access` cannot use a read-only sandbox on non-git workspace roots).
- OpenCode plan-mode permission reject no longer leaves an unhandled rejection when the
  instance cannot be created.
- PTY broadcast skips slow clients when the WebSocket buffer exceeds 512 KB.
- WebSocket connections get a 30 s ping keepalive and reject cross-site Origins unless
  they are same-host or listed explicitly in `CRETLI_EXTRA_WS_ORIGINS` (full origin URLs).
  Widget chat and page bridge require a valid widget token; the widget subprotocol alone
  does not grant access to terminal or log streams.
- Corrupt `widget-installations.json` is backed up and replaced instead of crashing every
  request.
- Agent callback tokens are compared with `timingSafeEqual`.
- Task-run resize listeners and debug intervals are cleaned up; Codex replay timers are
  cancelled on disconnect.

### Added
- Plan execution can be **delegated** to another harness/model: prepare the plan
  in Plan mode, then **Build plan → New agent** or `/wykonaj` (`/execute`). Cretli
  copies the approved plan, starts the executor without a browser tab, shows a
  status card in the planner chat, and injects the report into the planner's
  next turn. One active job per planner chat. Stop stays `cancelling` until the
  run actually ends; reports are confirmed only for ids included in that prompt;
  retry respects the parent busy lock.
- `docs/MODERNIZATION_PLAN.md` — phased bugfix and architecture backlog.
- Settings → Harness overview rows can be **reordered** (drag handle). The
  order is stored in settings and used in new chat, the mode bar, and voice.
- Connection dialog has **Reload page** for PWA installs that have no browser
  refresh control.
- Settings → Harness overview shows **enabled/total** models on the right of
  each backend row (checked catalog entries used in new chat and voice).
- Settings → Harness can turn each backend **on/off**. A disabled harness is
  hidden from new chat, the mode bar, and voice (`switch_harness` /
  `list_models`). Existing chats keep working. Voice and pickers only offer
  **checked** models of an enabled harness.
- Voice Live sessions now keep tool timings (`durationMs`, `resultBytes`) and
  OpenAI/Gemini wire events. `GET /api/voice/sessions/:id?diagnose=1` returns
  gap analysis; `GET /api/voice/requests` lists token-mint HTTP timings under
  `data/voice-sessions/http-requests.ndjson`.
- Sidebar workspace groups can be reordered with a press-and-hold drag (mouse
  and touch). The custom order is stored in the browser and survives a reload;
  pinning the active workspace still keeps it at the top.
- PWA update toast (**A new version is available**) can be dismissed with **×**;
  it stays hidden until the next full page reload if the version mismatch remains.
- Desktop sidebar can be **pinned** next to the close button: the drawer stays
  in the left column (header, tabs, and panels start beside it) instead of
  overlaying the chat. Open + pin are stored in the browser and restored on
  refresh; mobile overlay still uses overlay and can close on PWA resume.
- Codex picker now lists **GPT-6 Astra** (`gpt-6-astra`) plus Spark, GPT-5.5,
  and GPT-5.4 Mini in the API-key fallback catalog. ChatGPT plan chats use the
  live account list from `models_cache.json` so models the plan has not rolled
  out yet (often Astra) are not offered.
- Optional `@openai/codex-sdk` (and bundled CLI) bumped to **0.153.4**, which
  includes Astra in the CLI model catalog.
- Plan mode **Build plan** is a compact dropdown: this chat, or a **new agent**
  (new-chat modal for harness + model). The source chat stays in Plan; the new
  chat starts in Agent with a prompt pointing at the approved plan file.

### Fixed
- Voice Live on phones: agent replies now play through a hidden `<audio>` element
  (Chrome was silent on Web Audio / the earpiece). Connect no longer waits on
  `audio.play()` before the WebRTC handshake (that hung on “Connecting…”).
  The bar under the mic is input level, not volume — **Test sound** plays a beep
  on the same output.
- OpenCode no longer leaks a running turn into a newly opened empty chat. One
  server instance broadcasts every workspace session; rooms without their own
  OpenCode session id were accepting those events and writing them to history.
- Plan mode on OpenCode, Codex, DeepSeek, Qwen, CodeBuddy, and OpenRouter now
  persists the plan to `.cursor/plans/cretli-{chatId}.md` and the linked Todo
  after the run (same host-side path as Cursor SDK). Build-plan no longer looks
  for a file the model was not allowed to write.
- Codex ChatGPT 400s (e.g. Astra not on the plan) now show the API message
  instead of `Codex Exec exited with code 1: Reading prompt from stdin...`.
- Codex Plan mode no longer aborts on `/bin/bash -lc` wrappers around read-only
  shell (`pwd`, `rg --files`, `ls`). Codex always wraps exec that way; the plan
  guard now unwraps the inner script and still blocks writes, `edit`, and
  mutating commands.
- Sidebar **Delete chat** now honors **Delete and don't ask again**. The
  preference still cannot skip confirmation while the agent is working; that
  dialog warns that deleting stops the run. Server-side room dispose on chat
  delete already interrupts the process.
- Widget: **New agent** / **+** on a URL-pinned page creates a new chat and keeps
  the send bar visible, instead of reusing the pinned chat or ending on an empty
  Agent pane.
- DeepSeek Harness no longer offers `read_image` on text-only models (Flash/Pro), and `web_fetch` can open local/LAN HTTP(S) URLs instead of failing on private IPs.
- Tasks panel loads `.vscode/tasks.json` from **every** workspace folder (Cursor
  multi-root), instead of stopping at the first file found. Duplicate labels
  are prefixed with the folder name. The list follows the open chat's workspace
  (`GET /api/tasks?workspaceFile=…`) and is refreshed when the Tasks tab opens.
- Importing a `.code-workspace` file now copies its folders into the Cretli overlay
  (relative, absolute, `~`, Windows/`file://` paths). Previously the registry row
  was added with an empty folder list. Workspaces already imported with no overlay
  are filled on the next workspace list load.

## [0.3.0] - 2026-09-04

### Added
- Settings → Workspace folder list can be reordered (up/down). The first folder
  is the workspace root used for Cursor rules, skills, and agents.
- Sidebar drawer is wider on mobile (`min(90vw, 360px)`) and can be dragged to
  resize; the width is remembered per browser.
- Server-side folder/file **picker** (`GET /api/fs/entries`, `POST /api/fs/mkdir`)
  with a reusable `cr-fs-picker` Lit element and a "Browse" button next to path
  fields (Settings → Workspace, first-run workspace step, additional Cursor
  context dirs). The picker can create a new folder in the current directory.
- Workspace actions: **Convert to a Cretli workspace** (a `.code-workspace` entry
  becomes a self-config `cretli:ws:` workspace — folders stay, syncing stops) and
  **Export to `.code-workspace`…** (writes a self-config workspace's enabled folders
  into a new file). `GET /api/workspaces` reports `fileExists` per file workspace.
- Todo cards show which harness and chat created the task, with a link back to that chat.
- Todo plan section renders Markdown with the same preview as Files.
- **Fork chat** in More actions opens the new-chat modal to pick harness and model; the source chat stays open.
- Voice Live tools: switch/list workspaces and folders, list tasks with fuzzy `run_task`,
  archive (`close_chat`) and rename a chat, and `delete_chat` now requires `confirm=true`.
  The panel shows when the coding agent is working after `send_prompt`. Voice can also
  send terminal keys (`send_nav`, including permission Once/Reject), list/set the chat
  model, and switch harness (`switch_harness` requires `confirm=true`; default archives
  the old chat and hands off the transcript). Voice can fork a chat, set chat TTS
  read-aloud (`off`/`final`/`stream`), read the Live session cost, and end voice mode
  by saying so (`end_voice_mode` — not `stop_agent`).
- Voice Live panel has a **Commands** toggle with example spoken phrases
  (chat, workspace, agent, session), kept in sync with the server-pinned tools.
- Release process documented in [docs/RELEASING.md](docs/RELEASING.md) (SemVer,
  Unreleased freeze, and `v*` GitHub tags).

### Fixed
- Codex Plan mode no longer aborts on read-only shell (`ls`, `rg`, `cat`,
  `git status`). It still blocks writes, `edit`, and mutating commands.
- OpenCode session errors (e.g. missing payment method) now show once as an
  error block, instead of a fake Answer plus Error plus a duplicate notice.
- Chat no longer duplicates the last **Answer** bubble after a WS hello/reconnect
  mid-reply. The live assistant block is reused the same way as Thinking.
- PWA again shows **A new version is available** after a webpack rebuild (or a
  waiting service worker). Standalone mode cannot pull-to-refresh, so the banner
  is the reload path; `/__webpack_hmr` is no longer intercepted by the worker.
- Deleting a chat on one device no longer loops `sdkError` / “SDK chat not
  found” on another device that still had it open. The other client stops
  reconnecting and closes the chat locally.
- Mobile/PWA send bar stays in the chat layout (`position: sticky`) instead of
  `position: fixed` inside an `overflow: hidden` panel.
- Saving Chat settings from a non-Chat tab no longer hides the send bar.
  WebKit reported the hidden "Show send field" checkbox as unchecked and wrote
  that to localStorage (`cretli-chat-show-send-field=false`). Existing clients
  ignore that legacy value; hiding the bar now requires an explicit new flag.
- Forked / harness-switch chats no longer paste the inherited transcript
  a second time as one giant user message. The new agent still gets the
  full context; the UI shows a short continuation line.
- Folder picker in Settings → Workspace no longer stays on "Loading…" (Lit
  did not re-render after `/api/fs/entries`). `~` opens the login home, not
  the worktree sandbox `data/runtime-home`; a missing typed path walks up to
  the nearest existing folder.
- Sidebar chat delete shows the same confirmation dialog as the chat menu (the
  modal lived inside `#chat-panel`, so it stayed hidden when another tab was
  active or the drawer covered it).
- Todo status changes persist (`detail.status`); `ready` is labeled as ready to start, not done.
- Agent finish-summary `{"title":…}` JSON is stripped from Todo history.
- Starting an agent from Todo no longer forces Cursor SDK when the task came from OpenCode or OpenRouter.
- The attachment menu no longer shows the "Pick page element" entry in the
  standalone app (page-element picking only works inside the embedded widget),
  instead of rendering it disabled with a "(widget only)" suffix.

### Changed
- **Analyze current agent** opens the same new-chat modal as Fork (folder,
  harness, model) instead of a browser prompt, so the diagnosis can run on a
  different harness. The new agent gets an analysis prompt, not a task handoff.
- Settings → **App** uses sub-tabs like Harness: Appearance, Terminal, Voice,
  and Storage. `/settings/browser` still opens Storage.
- Single env template [`.env.example`](.env.example); SDK key template is
  [`.cretli-sdk.env.example`](.cretli-sdk.env.example).
- npm workspaces: one `npm install` covers `app_front/` (`cretli-front`).
- Backend modules grouped into `lib/sdk/`, `lib/opencode/`, `lib/openrouter/`, `lib/persist/`, `lib/widget/`.
- `.cursor/rules/cretli-system.mdc` is a short English alwaysApply rule;
  full architecture stays in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Agent rules renamed to `cretli-*.mdc`; `npm test` runs every `tests/*.test.js`.
- API/WS errors that were hardcoded in Polish go through [lib/messages.js](lib/messages.js).

### Removed
- Internal launch checklist (`docs/LAUNCH.md`).

## [0.2.0] - 2026-08-26

### Added
- Public product name **Cretli**; OpenCode, OpenRouter, and Cursor SDK documented as
  equal chat backends.
- `NOTICE` and trademark disclaimer (not affiliated with Anysphere/Cursor).
- LAN first-run guard: bind beyond localhost without a password requires
  `CRETLI_SETUP_TOKEN` (server refuses to start otherwise).
- Settings harness wizard showing which backends are installed and configured.
- Login setup-token field when LAN setup is required.
- Dockerfile, `docker-compose.yml`, [docs/INSTALL.md](docs/INSTALL.md),
  and [website/index.html](website/index.html).
- CI job that uninstalls `@cursor/sdk` and runs `test:without-cursor-sdk`.
- Issue forms with a harness dropdown; good-first-issue template.

### Changed
- Default bind is **127.0.0.1** in code (matches README/SECURITY). Use
  `npm run start:lan` / `CRETLI_BIND=0.0.0.0` for LAN.
- `@cursor/sdk` moved to `optionalDependencies`.
- Package name `cretli`, repository URLs `github.com/cretli/cretli`, version `0.2.0`.
- Runtime fallbacks no longer use maintainer home paths; examples use TEST-NET
  (`192.0.2.10`).
- Public docs are English; widget panel strings are i18n.

### Removed
- Internal Polish planning notes from `docs/` (Obsidian mirrors, SDK phase TODOs).
- Maintainer-only push command details (SSH key paths).

## [0.1.0] - 2026-07-02

### Added
- First public release as open source (MIT).
- Password authentication (scrypt-hashed, signed `HttpOnly` session cookie) with a
  `/login` setup/login page; default bind to `127.0.0.1`.
- [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [.env.example](.env.example),
  GitHub issue/PR templates and CI workflow.
- `docs/ARCHITECTURE.md` (English) describing HTTP/WS, shared sessions and HMR.
- Umbrella `npm test` script.

### Changed
- Server binds to `127.0.0.1` by default; LAN exposure is opt-in via
  `CURSOR_REMOTE_BIND=0.0.0.0`.
- Agent callback endpoints (`/api/set-*-from-agent`) require `AGENT_CALLBACK_TOKEN` when
  the server is exposed on a non-localhost bind.
- File endpoints (`/api/files/entries`, `/api/files/read`) resolve symlinks via
  `realpathSync` to prevent path traversal.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS
  on HTTPS) and global `uncaughtException`/`unhandledRejection` handlers.
- README rewritten in English.

### Removed
- Internal-only documentation (`DOCS/`), G-Mode agents/rules/scratchpad, private dev
  plans, and one-shot migration scripts.
- Build artifacts (`public/dist/`) from git tracking (now gitignored).

[Unreleased]: https://github.com/cretli/cretli/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/cretli/cretli/releases/tag/v0.4.0
[0.3.0]: https://github.com/cretli/cretli/releases/tag/v0.3.0
[0.2.0]: https://github.com/cretli/cretli/releases/tag/v0.2.0
[0.1.0]: https://github.com/cretli/cretli/releases/tag/v0.1.0
