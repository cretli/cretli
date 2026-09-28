# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Model catalog favorites can be managed per harness in Settings, including
  model labels that distinguish otherwise identical display names. Added
  harness icon assets and shared skill discovery across `.agents/skills` and
  the existing Cursor skill directories.

### Changed

- Updated the Cursor and Codex SDK optional dependencies. SDK model registry
  rejections now remove the rejected model from favorites and reset the chat
  selection to Auto. Skill context is included in SDK prompts when a skill is
  selected by the user.

### Fixed

- Browser navigation no longer fails on an empty GET/HEAD body that Chromium
  exposes as JSON `null`. Added explicit workspace debug opt-ins for reaching
  Cretli's own origin and accepting invalid TLS certificates; both remain off
  by default.
- Duplicate SDK catalog labels now expose model IDs and variant parameters so
  distinct models remain identifiable in pickers.

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
