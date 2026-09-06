# Architecture

Cretli is a Node.js (Express + WebSocket) server that exposes a **terminal** and
**agent chat** (OpenCode, OpenRouter, DeepSeek Harness, Qwen Code, Codex SDK, or optional Cursor SDK) for your workspace
to a browser (typically on a phone). The frontend is a webpack SPA in `app_front/`
built to `public/dist/`.

## Top-level layout

| Path | Role |
|------|------|
| `server.js` | Composition root: bind, HTTPS, middleware, listen. Workspace/widget/HMR live in `lib/` |
| `lib/` | Domain modules: top-level app services plus `sdk/`, `opencode/`, `openrouter/`, `codebuddy/`, `deepseek/`, `qwen/`, `codex/`, `persist/`, `widget/`, `routes/`, `ws/`, `agent-harness/` |
| `app_front/` | SPA source (webpack → `public/dist/`) |
| `public/` | Static assets served by Express, including `login.html` |
| `data/` | Runtime data (gitignored): `auth.json`, `config.json`, `mcp.json`, `mcp-secrets.json`, `mcp-tx.json`, `chats.json`, `todos/`, `uploads/`, `dsh-home/`, `qwen-home/`, `codex-home/`, TLS certs |
| `scripts/` | SSL cert generation, WSL port-forward, manual test/capture helpers |
| `docs/` | Architecture, setup, and the [modernization backlog](MODERNIZATION_PLAN.md) |
| `tests/` | Unit/integration tests + Playwright E2E (`tests/e2e/`) |

## Key `lib/` modules

| Module | Responsibility |
|--------|----------------|
| `auth.js` | Password (scrypt) + signed session cookie; Express + WS auth; agent-callback token |
| `persist/settings.js` | `data/config.json` (lanHost, workspace registry, additionalCursorContextDirs, cursorApiKey, ...) |
| `sdk/shared-cursor-context.js` | Extra `.cursor/` roots for SDK multi-cwd + alwaysApply prompt inject |
| `workspace.js` | Parse `.code-workspace`, inspect folder/file paths |
| `persist/workspace-registry.js` | Workspace registry (`file` or folder-only `cretli:ws:`) |
| `workspace-folders.js` | Folder overlay merge/sync and optional JSONC write-back |
| `workspace-list.js` | Seed registry, add/remove paths, build `/api/workspaces` payload |
| `spa-routes.js` | Allowlisted History API view paths (`/chat`, `/settings/workspace`, …) |
| `persist/chats-persist.js` | CRUD for `data/chats.json`; SDK chat metadata (`cursorSessionId`, `sdkAgentId`, `codexThreadId`, `qwenSessionId`, …) |
| `persist/mcp-persist.js` | `data/mcp.json` + `mcp-secrets.json` with a recoverable write journal (`mcp-tx.json`) |
| `mcp/` | MCP config, secrets, runtime, Plan policy, harness adapters, Settings API |
| `persist/todos-persist.js` | CRUD for `data/todos/` (per-workspace) |
| `todo-plan-sync.js` | After Plan-mode runs, write versioned `.cursor/plans/cretli-{chatId}.md` and the linked Todo (Cursor SDK + other harnesses) |
| `delegation-service.js` | Create/start/cancel/retry/ack jobs from a saved plan or a chat message; one active job per planner chat |
| `delegation-mailbox.js` | Durable parent↔child mailbox; idle recipients start a turn, busy/waiting chats queue until the run ends |
| `agent-run-state.js` | Cheap per-chat busy/waiting/attention summary for the chat list |
| `delegation-executor.js` | Rejects executor models that are not in the enabled catalog |
| `sdk/cursor-agent-sdk-ws.js` | `/ws-agent-sdk` rooms: `Agent.create`/`resume`, `run.stream()`, server-side history tap, plan guard, grace shutdown |
| `sdk/sdk-room-bus.js` | Optional Redis pub-sub + room owner registry for multi-instance SDK (`CRETLI_REDIS_URL`) |
| `sdk/sdk-room-registry.js` | Redis `sessionKey → instanceId` lease for SDK room ownership |
| `sdk/sdk-remote-room-stub.js` | Lightweight non-owner SDK room (live events only) |
| `sdk/sdk-sticky-session.js` | Sticky load-balancer cookie (`cursor-remote-instance`) |
| `sdk/sdk-instance-id.js` | Stable per-process instance id (`CRETLI_INSTANCE_ID`) |
| `persist/chat-history-revisions.js` | In-memory revision index for cross-device history pull sync |
| `sdk/sdk-ws-handshake.js` | Pure hello + replay-batch helpers (shared by server and tests) |
| `sdk/sdk-run-auto-recovery.js` | Stuck setup/stream detection, cancel + single retry |
| `status-parser.js` | Parse Cursor TUI state (generating/thinking/approval/...) from PTY output |
| `fork-title.js` | One-shot agent to derive chat titles/summaries |
| `sdk/cursor-api-key.js` | Cursor API key resolution (env/config) |
| `openrouter/openrouter-api-key.js` | OpenRouter API key resolution (env/config) |
| `openrouter/openrouter-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: openrouter` — tool loop + SDK-compatible WS events |
| `opencode/opencode-server-manager.js` | Lazy `@opencode-ai/sdk` server per workspace folder (health, providers) |
| `opencode/opencode-zai-api-key.js` | Z.AI key for OpenCode (`zai-coding-plan` / `zai`); Zen stays in `opencode-api-key.js` |
| `opencode/opencode-spawn-path.js` | Resolve `opencode` CLI and drop unreadable PATH dirs before `opencode serve` spawn |
| `opencode/opencode-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: opencode` — OpenCode sessions + SSE events |
| `codebuddy/codebuddy-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: codebuddy` — `@tencent-ai/agent-sdk` `query()` + CLI |
| `deepseek/deepseek-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: deepseek` — `@deepseek-ai/dsh-sdk-client` + `dsh --profile sdk` |
| `qwen/qwen-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: qwen` — `@qwen-code/sdk` `query()` + bundled Qwen CLI |
| `codex/codex-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: codex` — `@openai/codex-sdk` + bundled Codex CLI |
| `agent-harness/` | OpenRouter client, shared `room-kernel.js`, OpenCode / CodeBuddy / DeepSeek / Qwen event normalizers, tool executor, harness registry |
| `voice/openai-api-key.js` | OpenAI API key resolution for the voice layer (env/config) |
| `voice/openai-rate-limit.js` | Opt-in per-IP throttle for the OpenAI voice endpoints |
| `voice/realtime-session-config.js` | Instructions, tool schemas and audio config pinned to every minted Realtime token |

## Agent harnesses

Each chat stores `agentTransport`: `sdk` (default), `openrouter`, `opencode`, `codebuddy`, `deepseek`, `qwen`, or `codex`. Changing harness from the toolbar creates a **new** chat with the chosen harness (same workspace/folder) and then optionally archives, deletes, or keeps the previous one. You can also pass the previous transcript as a handoff prompt so the new agent continues the work. In widget mode the new chat is also pinned to the host page URL.

| Harness | Backend | Auth / config |
|---------|---------|---------------|
| `sdk` | `@cursor/sdk` via `cursor-agent-sdk-ws.js` | `CURSOR_API_KEY` / Settings |
| `openrouter` | OpenRouter `/v1/chat/completions` + server-side tools | `OPENROUTER_API_KEY` / Settings |
| `opencode` | `@opencode-ai/sdk` (`opencode serve` per workspace) + OpenCode tool loop | Zen (`OPENCODE_API_KEY`) **or** Z.AI (`ZAI_API_KEY` / Settings → OpenCode) |
| `codebuddy` | `@tencent-ai/agent-sdk` via `codebuddy-agent-ws.js` + `codebuddy` CLI | `CODEBUDDY_API_KEY` / Settings; optional `CODEBUDDY_CODE_PATH` |
| `deepseek` | `@deepseek-ai/dsh-sdk-client` via `deepseek-agent-ws.js` + `dsh --profile sdk` | `DEEPSEEK_API_KEY` / Settings; optional `DSH_BIN` |
| `qwen` | `@qwen-code/sdk` via `qwen-agent-ws.js` + bundled Qwen CLI | `QWEN_API_KEY` / Settings (Qwen Cloud); endpoint preset `payg` / `token-plan` / `coding-plan` / `custom`; optional `QWEN_BIN` |
| `codex` | `@openai/codex-sdk` via `codex-agent-ws.js` + bundled `codex` CLI | ChatGPT plan (device login) **or** `CODEX_API_KEY` / Settings; optional `CODEX_BIN` |

All seven harnesses share the same WebSocket path (`/ws-agent-sdk`), protocol (`sdkEvent`, replay batches), rich view, and history persist format. OpenRouter, OpenCode, CodeBuddy, DeepSeek, Qwen, and Codex events are normalized to SDK-shaped payloads before broadcast. If the chat row is gone (deleted on another device), the server sends `sdkError` with code `chat_not_found` and the client stops reconnecting instead of treating it as a recoverable `invalid_session`.

### The `sdk-*` prefix is protocol, not Cursor SDK

The name is historical and misleads newcomers. Everything under `lib/sdk/` except
`cursor-agent-sdk-ws.js` and `cursor-api-key.js` is the **shared protocol layer used by
all harnesses**: `sdk-mode.js`, `sdk-ui-mode.js`, `sdk-ws-handshake.js`,
`sdk-plan-guard.js`, `sdk-room-state.js`, `sdk-room-bus.js`, `sdk-room-registry.js`,
`sdk-instance-id.js`, `sdk-run-auto-recovery.js`, `sdk-context-*.js`. Read `sdk-` there
as "agent chat protocol". Only `cursor-agent-sdk-ws.js` actually talks to `@cursor/sdk`.

The same applies on the frontend: `sdkEvent`, `sdkRunFinished`, `sdkRoomState` and the
rich view are the common wire format, not a Cursor-only path.

### Shared room kernel (harness chats)

OpenRouter, DeepSeek, Qwen, CodeBuddy, Codex, and OpenCode rooms use
`lib/agent-harness/room-kernel.js` for broadcast, event log, persist buffer,
replay cancel, heartbeat, and empty-room grace shutdown. Each harness still
owns transport-specific abort (Codex abort signal, OpenCode instance lease,
Qwen questions, CodeBuddy live session). `cursor-agent-sdk-ws.js` keeps its
own room map.

`lib/opencode/opencode-agent-ws.js`, `lib/openrouter/openrouter-agent-ws.js`,
`lib/codebuddy/codebuddy-agent-ws.js`, `lib/deepseek/deepseek-agent-ws.js`, `lib/qwen/qwen-agent-ws.js`, and `lib/codex/codex-agent-ws.js` still own prompt
runs and vendor clients. Behaviour parity between harnesses is maintained by
the E2E suite — check `tests/e2e/chat-live-harnesses.spec.js` when you change one of them.

SDK-specific diagnostics include strict model audit for fast variants (`::fast=true`): requested model, effective model, and explicit fallback metadata in `/api/chats/:id/diag`.

OpenCode chats persist optional `opencodeSessionId` in `data/chats.json` for session reuse after reconnect. CodeBuddy chats persist `codebuddySessionId` and pass it as `query()` `options.resume`. DeepSeek chats persist `deepseekSessionId` and pass it to `DeepSeekHarness.run({ sessionId })`. Isolated DSH home is `data/dsh-home/`. Setup: **`docs/deepseek/SETUP.md`**. Qwen chats persist `qwenSessionId` and pass it as `query()` `options.resume`. Isolated Qwen home is `data/qwen-home/`. Setup: **`docs/qwen/SETUP.md`**. Qwen `ask_user_question` is surfaced through the same chat question UI as OpenCode (`opencode_question` / `opencodeQuestionReply`) via `lib/qwen/qwen-question.js`. Codex chats persist `codexThreadId` and pass it to `codex.resumeThread()`. Isolated Codex home is `data/codex-home/`. Setup: **`docs/codex/SETUP.md`**.

**OpenCode-specific features** (parity with SDK where applicable):

- **Question skill** — `opencode_question` events; reply via `POST /api/session/{id}/question/{requestID}/reply` (`lib/opencode/opencode-question.js`). A Plan-mode question that asks to implement/approve the plan switches the chat to Agent before the reply is sent (`lib/sdk/plan-approval-reply.js`).
- **Permission skill** — `opencode_permission` events; reply Once / Always / Reject in UI (`lib/opencode/opencode-permission.js`).
- **Plan / Ask guard** — mutating `tool_call` events are blocked in Plan and Ask
  for harnesses that deny tools (`canUseTool` / permission / catalog) or abort the run.
  Ask is a separate conversation mode (questions and analysis, no plan persistence
  or “yes” → Agent). Codex Plan is prompt-only (no turn abort); Codex Ask still
  denies mutations on the host. Read-only sandbox is not used because
  Linux bwrap fails on non-git workspace roots. Emits `sdkPlanGuard` when a mutating
  tool is denied (`lib/sdk/sdk-plan-guard.js`).
- **Room state** — `sdkRoomState` heartbeat (~15 s) with queue depth, pending questions/permissions, `lastEventAt` (`lib/sdk/sdk-room-state.js`, `getOpenCodeRoomDiag`).
- **Run lifecycle parity** — OpenCode emits `runId` on `sdkPromptStarted` / `sdkRunFinished`; room outcome (`lastRunId`, `lastRunStatus`, errors) is tracked like SDK for reconnect consistency.
- **Progress + resilience** — OpenCode emits `sdkRunProgress` with transport marker and auto-recovers once after timeout/stream disruption by recycling subscription/session.
- **Diagnostics** — `GET /api/chats/:id/diag` includes OpenCode session id, queue, pending interactive skills.

User setup and troubleshooting: **`docs/opencode/SETUP.md`**. Developer index: **`docs/opencode/README.md`**.

OpenRouter tools (MVP): `read_file`, `list_directory`, `grep`, `write_file`, `search_replace`, `run_terminal_command`, `git_status`, `git_diff`, `git_run`. Plan and Ask both block mutating tools; Ask does not write a plan or TODO.

## Functional chat E2E (Playwright)

Chat functional coverage is split into two execution profiles:

- `npm run test:e2e:mock` — stable UI sanity, no external provider keys required.
- `npm run test:e2e:live` — live provider scenarios for `sdk`, `opencode`, `openrouter`:
  - send prompt, wait for provider response token,
  - assert chat state transitions (`Agent working` -> `Ready` / `Needs action`),
  - reconnect by page reload with replay/no duplicate check.

Playwright setup details:

- Config: `playwright.config.js`.
- Specs: `tests/e2e/chat-mock.spec.js`, `tests/e2e/chat-live-harnesses.spec.js`, `tests/e2e/chat-live-reconnect.spec.js`, `tests/e2e/opencode-alpha-free-live.spec.js`, `tests/e2e/sdk-composer-fast-live.spec.js`.
- Dedicated SDK strict flow: `@sdk-composer-fast` enforces `composer-2.5::fast=true` for both `chat.model` and `room.modelId`; fallback to non-fast model fails the scenario.
- Additional SDK edge scenarios:
  - cancel flow (`Stop`) with post-run diag assertions,
  - multi-client reconnect consistency,
  - optional timeout/recovery profile (`@sdk-recovery`) using reduced idle-budget envs.
- Failure observability: Playwright trace/screenshot (optional video) + `status-tail` and `diag` JSON attachments per failing live test.

## Transports

```
Chat (SDK)           → /ws-agent-sdk   → @cursor/sdk (Agent.create/resume, run.stream)
Chat (OpenRouter)    → /ws-agent-sdk   → OpenRouter API + lib/agent-harness tool loop
Chat (OpenCode)      → /ws-agent-sdk   → @opencode-ai/sdk (session.prompt_async + event.subscribe)
Chat (CodeBuddy)     → /ws-agent-sdk   → @tencent-ai/agent-sdk (query + codebuddy CLI)
Chat (DeepSeek)      → /ws-agent-sdk   → @deepseek-ai/dsh-sdk-client (dsh --profile sdk JSON-RPC)
Chat (Qwen)          → /ws-agent-sdk   → @qwen-code/sdk (query + bundled Qwen CLI)
Chat (Codex)         → /ws-agent-sdk   → @openai/codex-sdk (startThread/resumeThread, runStreamed)
Terminal shell       → /ws             → node-pty
Tasks (.vscode)      → /ws-task        → node-pty
Scheduled agents     → /ws-agent-run   → node-pty (Cursor CLI)
Agent run (legacy)   → /ws-agent       → node-pty (rejected for harness chats)
Server log viewer    → /ws-server-logs → in-memory log buffer
Front hot fallback   → /ws-front-build → watch events (CRETLI_FRONT_HOT_FALLBACK=1)
```

## Shared sessions

- One PTY per session. Output is broadcast to every connected client; input from any
  client is written to the PTY. A ~64 KB buffer lets a joining client catch up.
- PTY size = max(cols/rows) across connected clients, recomputed on join/leave. Agent
  resize is debounced (~120 ms) to reduce full TUI redraws.
- SDK rooms keep an event log (up to 1200 events) for mid-run reconnect and a 90 s grace
  period with no clients before disposal.
- On reconnect, the server sends replay in paced `replayBatch` frames (25 events / 50 ms)
  instead of one frame per stored event.
- SDK broadcast applies WS backpressure: non-critical frames (e.g. `sdkRunProgress`) may be
  skipped for slow clients; critical stream events wait for send-buffer drain (512 KB threshold).
- Every SDK room emits `sdkRoomState` on connect and every ~15 s (busy, runId, last seq,
  queue depth) so clients can sync without full replay; HTTP history pull runs when seq lags.
- SDK event history is persisted server-side to `data/chat-history/<chatId>.json` during
  runs (debounced flush every ~2 s while busy) and after each run, so offline/reconnected
  clients can replay events generated during disconnect.
- Cross-device sync is **pull-based**: clients poll `GET /api/chats/history-revisions` every
  ~15 s (visible tab) and run HTTP history delta pull when `headSeq` advances. Optional
  web push nudges (`CRETLI_PUSH_HISTORY=1`) reuse existing VAPID subscriptions.
  The same subscriptions also receive a push when Cursor SDK finishes a run,
  and when OpenCode or Qwen is waiting on a question or permission.
  The same poll loads `GET /api/chats/agent-states` so executor chats without a client
  still show working / needs-action. `hasPendingDelegation` on a revision forces the
  open parent chat to pull a new delegation card even when the WebSocket is up.
- Multi-instance deployments: set `CRETLI_REDIS_URL` (+ optional `redis` package).
  See **`docs/MULTI-INSTANCE.md`** for sticky routing, registry lease, and failover.
- Optional per-process id: `CRETLI_INSTANCE_ID` (also exposed in `/api/health`).
  to fan-out sequenced SDK room events across Node processes (`sdk-room-bus.js`).
- Stuck run auto-recovery (default on): after idle budget + 60 s grace, setup/stream is
  cancelled and retried once (`lib/sdk/sdk-run-auto-recovery.js`). Disable with
  `CRETLI_SDK_RUN_AUTO_RECOVERY=0`.
- Chat history revision index is seeded from `data/chat-history/*.json` on server startup
  so cross-device polling works immediately after restart.

## Context usage meter

The chat context ring and details modal measure **input tokens vs the model window**, not session billing.

| Source | When it is used |
|--------|-----------------|
| Exact (`usage` events) | Cursor SDK streams `{ type: 'usage', usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens } }`. Fill % uses effective input (`input - cacheRead` when cache reads are reported). |
| Estimated (`chars / 4`) | OpenCode, OpenRouter, or SDK chats with no usage yet. Output/total stay empty (`—`). |

Model windows come from a static prefix table in `lib/sdk/sdk-context-advisory.js` (including `grok-4.6` = 500k from the xAI API) plus runtime catalogs (`setDynamicModelContextWindows` from OpenCode `limit.input` and Cursor `models.list` when those fields exist).

`GET /api/chats/:id/diag` exposes `contextStats.history`, `localStore`, and `pressure` (fill %, peak, warning codes). OpenCode/OpenRouter rooms do not currently emit `usage` events; their meters stay estimated until that parity is added.

## Authentication

- `lib/auth.js` stores a scrypt-hashed password and a session secret in `data/auth.json`.
- Session ids are persisted in `data/sessions.json` with TTL, so server restarts do not
  force a new login (unless session expired or password changed).
- `requireAuth` middleware gates `/api/*` (with explicit public exceptions: `/api/login`,
  `/api/logout`, `/api/setup`, `/api/auth-status`, `/api/health`, and the agent callback
  endpoints which authenticate via `AGENT_CALLBACK_TOKEN`).
- The SPA shell (`/`, `/index.html`, `/embed.html`, `/chat`, `/settings/workspace`,
  and other allowlisted view paths from `lib/spa-routes.js`) redirects to `/login`
  when not authenticated. Static bundle assets remain public.
- View state uses History API paths (`/tasks`, `/settings/workspace`). `?panel=` /
  `?tab=` remain aliases for PWA shortcuts and push deep links.
- WebSocket connections check the session cookie at handshake and close with `4401` if
  unauthenticated; the frontend redirects to `/login` on that code.

## HTTP API (selection)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (public; includes `frontAssetVersion`) |
| GET | `/api/auth-status` | Auth state (public) |
| POST | `/api/setup` | Set the password on first run |
| POST | `/api/login` / `/api/logout` | Session login/logout |
| GET | `/api/workspace` / `/api/workspaces` | Current workspace / registry (`?refresh=1` busts cache, `?scan=1` finds new files, `?sync=1` pulls folders from `.code-workspace` into the overlay) |
| POST | `/api/workspace-file/folders` | Optional JSONC write-back of folders into a registered `.code-workspace` |
| GET/PATCH | `/api/settings` | Runtime settings (LAN host, workspace registry, front HMR, cursorApiKey) |
| GET | `/api/harness-catalog/harnesses` | Cached harness ready/enabled flags (password session, not widget/MCP token) |
| GET | `/api/harness-catalog/models` | Cached/fallback models for one harness (`?harness=`). Cursor SDK also lists Settings-enabled variants when the live catalog is not fetched. Does not start vendors |
| GET | `/api/update/status` | App version + local/remote SHA (`?check=1` fetches GitHub). Auth required. |
| POST | `/api/update/apply` | Background `scripts/self-update.sh` (fetch + reset --hard + npm + rebuild). Auth required. |
| GET | `/api/codebuddy/status` | CodeBuddy package + CLI + API key readiness |
| GET | `/api/codebuddy/models` | CodeBuddy model catalog (live account probe, then international-site catalog) |
| GET | `/api/deepseek/status` | DeepSeek Harness package + CLI + API key readiness |
| GET | `/api/deepseek/models` | DeepSeek Harness model catalog (V4 Flash / V4 Pro / V4 Flash Vision Exp) |
| GET | `/api/qwen/status` | Qwen Code SDK + Qwen Cloud API key readiness (CLI optional) |
| GET | `/api/qwen/models` | Qwen Cloud model catalog (3.8 Max / Plus / Coder) |
| GET | `/api/codex/status` | Codex SDK package + CLI + ChatGPT session or API key readiness |
| POST | `/api/codex/login/start` | Start ChatGPT device-code login (`codex login --device-auth`) |
| GET | `/api/codex/login/status` | Device-login phase, URL, and one-time code (no tokens) |
| POST | `/api/codex/login/cancel` | Abort in-flight device login |
| POST | `/api/codex/logout` | Sign out ChatGPT plan (`codex logout` + remove `auth.json`) |
| GET | `/api/codex/models` | Codex model catalog (ChatGPT: `models_cache.json`; API key: documented fallback including GPT-6 Astra) |
| POST | `/api/chats/:id/delegations` | Start a plan- or message-sourced job (executor + idempotency key; plan revision or history seq) |
| GET | `/api/chats/:id/delegations` | List jobs for the chat as planner or executor |
| GET | `/api/chats/:id/plan` | Latest persisted plan document (revision, hash, markdown) |
| GET | `/api/delegations/executors` | Harnesses that can start/cancel without an open browser (all enabled agent transports) |
| GET | `/api/delegations/:id` | Job status and report |
| POST | `/api/delegations/:id/cancel` | Request stop; stays `cancelling` (HTTP 202) until the executor run ends |
| POST | `/api/delegations/:id/retry` | Start a new attempt on the same executor chat |
| POST | `/api/delegations/:id/ack` | Clear waiting attention (open child) or mark a finished job reviewed |
| GET | `/api/chats/:id/mailbox` | Inter-chat mailbox (queued and delivered) |
| POST | `/api/chats/:id/mailbox/reply` | Send a child message to the communication parent (`delegationParentChatId`), not the sidebar group |
| GET | `/api/chats/agent-states` | Lightweight busy/waiting/attention map for listed chats |
| GET | `/api/chats` / POST `/api/chats` | Chat list / create |
| PATCH | `/api/chats/:id` | Update chat fields (`archived`, `title`, `model`, ...; CSRF header required) |
| DELETE | `/api/chats/:id` | Delete chat + history (runs disposable-room cleanup first) |
| GET | `/api/chats/history-revisions` | Lightweight `headSeq` revision index for cross-device pull sync |
| GET | `/api/chats/:id/history` | Pull SDK history log (`?since=&limit=`) |
| POST | `/api/chats/:id/dispose-sdk-room` | Reset in-memory SDK room (stuck chat recovery) |
| GET | `/api/chats/:id/sdk-messages` | SDK message history (`Agent.messages.list`) |
| GET | `/api/files/entries` / `/api/files/read` | Workspace tree / file content (symlink-safe) |
| GET | `/api/fs/entries` | Absolute directory listing for path pickers (`?path=&includeHidden=1`) |
| POST | `/api/fs/mkdir` | Create one folder under an existing absolute path (`{ path, name }`) |
| POST | `/api/git/run` | Whitelisted git actions (status, fetch, pull, push, checkout) |
| POST | `/api/upload-screenshot` | Image upload (sharp re-encode, 5 MB limit) |
| POST | `/api/voice/speak` | Text to speech via OpenAI or Azure (`provider`) → base64 mp3 |
| POST | `/api/voice/transcribe` | Audio (base64) to text via OpenAI |
| POST | `/api/voice/realtime-token` | Ephemeral OpenAI Realtime `client_secret` with a pinned session |
| POST | `/api/voice/gemini-live-token` | Same-origin Gemini Live relay ticket + pinned `setup` |
| POST | `/api/voice/gemini-probe` | Cheap Gemini key check (`models.list`, no Live session) |
| GET | `/api/usage/summary` | Month/day usage totals (`from` defaults to the 1st) |
| POST | `/api/usage/events` | Client-reported raw tokens (OpenAI Realtime). Rejects `usd` |
| GET | `/api/mcp/servers` | MCP registry (no secret values) + revision |
| POST | `/api/mcp/servers` | Create MCP definition (`expectedRevision`) |
| PATCH | `/api/mcp/servers/:id` | Edit definition; omit a secret to keep it |
| DELETE | `/api/mcp/servers/:id` | Remove definition and secrets |
| POST | `/api/mcp/servers/:id/test` | Connect, list tools, dispose (does not call tools) |
| GET | `/api/mcp/servers/:id/tools` | Last known catalog |
| GET | `/api/mcp/status` | Config/connection status for workspace, harness, session |
| GET/POST | `/api/mcp/bridge/*` | Session integration-token bridge (not widget, not cookie UI) |

## Chat management tooling (CLI + MCP)

Out-of-process tools manage chats through the HTTP API above — never by editing
gitignored `data/` files (the server keeps state in memory and would overwrite
external edits). Shared client: `lib/remote-api-client.js` (login → session
cookie + CSRF header, auto re-login once on 401, `findChatByRef` resolves an id
prefix or unique title substring).

- **CLI** — `npm run chat -- <command>` (`scripts/chat-cli.js`): `workspaces`,
  `list [--all|--archived] [--workspace <substr>]`, `show <ref> [--tail <n>]`,
  `archive|restore <ref...>`, `rename <ref> <title>`, `delete <ref...>
  --confirm`.
- **MCP** — `node scripts/cretli-mcp.js` (stdio, newline-delimited JSON-RPC):
  shared catalog in `lib/mcp/builtin/` (chats, TODOs, saved plans, delegations
  plus mailbox reply/inbox, task/agent catalogs, harnesses/models). Tools are scoped to the calling chat
  workspace, not the UI global folder. `chat_list` / `chat_show` / `chat_history` / `chat_event`
  default to that workspace; pass `scope=all` to reach another workspace by id.
  `chat_history` pages events by seq (optional tool payloads). `chat_event` reads a UTF-16
  slice of one event field. Standalone stdio requires
  `CRETLI_MCP_WORKSPACE` and honors `CRETLI_MCP_MODE` (`plan` and `ask` block writes;
  `agent` allows them). Catalog and domain reads go through the target Cretli
  HTTP API, not the stdio process `data/` directory. Long plan/TODO/delegation
  bodies are paged with a revision-bound `cursor`. Delete requires `confirm=true`; prefer archive.
  Conversation files under `data/chat-history/`, `data/runtime-home/` (including
  Cursor `agent-transcripts`), and `data/sdk-agent-store/` are ignored by Cursor
  file tools (`.cursorignore` on every attached SDK workspace root, plus
  `Agent.reload` after create/resume) and blocked in the OpenRouter tool
  executor (including shell tokens). Native vendor shells on other harnesses
  can still open those paths — do not treat ignore files as a complete
  isolation boundary. Live Cursor SDK check: `npm run test:live-cursor-sdk`
  (completed file-tool attempts, hello contents, a new-session fork, and
  ignore-after-create).
  Register it in an MCP host (e.g. `opencode.json` → `mcp.cretli`) with
  `node scripts/cretli-mcp.js`. Harness sessions use `--bridge` plus a
  short-lived `CRETLI_MCP_TOKEN` (not the login password, not a widget token).
  The token does not freeze Plan/Agent: the bridge resolves mode from the live
  Cretli session on every call. Writes go through `lib/mcp/mcp-runtime.js` after
  an exact `serverId + toolName` policy check. OpenCode chat sessions that need
  a distinct Plan/Agent context get their own OpenCode runtime (MCP is
  instance-wide in the vendor SDK). User-facing setup: [docs/mcp/SETUP.md](mcp/SETUP.md).
  Registry + secrets: `data/mcp.json` and `data/mcp-secrets.json` with journal
  `data/mcp-tx.json` (`lib/persist/mcp-persist.js`), not `data/config.json`.

Configuration for both: `CRETLI_URL` (default `https://127.0.0.1:3011`),
`CRETLI_CLI_PASSWORD` / `CRETLI_PASSWORD`, `CRETLI_INSECURE_TLS=0` to enforce
TLS verification (loopback is relaxed by default — self-signed cert).

## Usage ledger

Every paid AI call (voice Live/TTS/STT, OpenRouter chat, Cursor SDK tokens) records into
one server ledger (`lib/usage/` + gitignored `data/usage/YYYY-MM-DD.jsonl`). The server
sets USD from `lib/usage/usage-rates.js`; the browser never sends a price. Gemini Live is
counted on the WS relay. OpenAI Realtime is browser-direct, so the client POSTs raw token
counts only. Cursor SDK stores tokens with `usd: null`. OpenCode has no money in v1. The
chat context ring stays a separate meter. Settings → Usage shows today and this month.

## Voice layer

Three independent features share one OpenAI key: reading answers aloud, dictation, and a
Realtime voice conversation. All of them are opt-in and off by default. Read-aloud can
additionally use Azure Speech, which is the only provider here with native `pl-PL` voices.

The key is resolved server-side only (`lib/voice/openai-api-key.js`: `OPENAI_API_KEY`, then
`data/config.json` → `openaiApiKey`, same pattern as OpenRouter). The browser sees rendered
audio, plain text, or a short-lived token — never the key. `/api/settings` reports only
`openaiApiKeyEffective` and format flags.

Azure credentials follow the same rule in `lib/voice/azure-speech-key.js`
(`AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`, then `azureSpeechKey` / `azureSpeechRegion` in
`data/config.json`). The region is part of the endpoint host, so both values are required
and env wins as a pair — a half-configured env must not borrow the region from the settings
file. `/api/settings` reports `azureSpeechEffective`, format flags and the region (not a
secret).

`lib/voice/openai-rate-limit.js` adds an opt-in per-IP throttle
(`CRETLI_RATELIMIT_OPENAI_PER_MIN`) on the voice endpoints. A LAN-visible Cretli brokers
the server's key to whoever can reach it, so set the throttle there — and provider-side
spend limits as well, since this is an app-level guard, not a billing cap.

### Read-aloud (TTS)

`app_front/features/voice/`:

- `speakableText.js` turns Markdown into prose: code fences, tables, links, URLs, file
  paths, and the trailing title JSON are dropped rather than spelled out. Read verbatim, an
  agent answer is unusable. It also splits text on sentence boundaries, because Chrome
  truncates long utterances and streaming needs whole sentences.
- `ttsEngine.js` — `browser` (`speechSynthesis`, free and offline), or `openai` / `azure`
  brokered by `/api/voice/speak`. Both remote engines share one factory: they differ only in
  the `provider` they ask for. Pick `azure` for Polish — the OpenAI voices are trained on
  English and read `pl` with an accent, while Azure has native narrators
  (`pl-PL-AgnieszkaNeural`, `-MarekNeural`, `-ZofiaNeural`). A remote engine falls back to
  the browser one when its key is missing, and is taken out of service for the page load
  after a failure it cannot retry past (no credits, dead key, quota). Playback is guarded by
  a watchdog: without an output device `play()` can resolve while `ended` never fires, which
  would stall the queue for good. iOS only allows speech started from a user gesture, so
  enabling the feature primes the synthesiser from that click.
- Azure has no `speed` field — rate is set through SSML `prosody` in `lib/voice/azure-tts.js`,
  which also escapes the text and derives `xml:lang` from the voice name.
- `speechQueue.js` — one utterance at a time; `cancel()` bumps a generation counter so a
  promise resolving after a cancel cannot resume a stopped queue.
- `chatSpeaker.js` — a single speaker for the whole app, fed only by the active chat, so
  switching chats never produces two voices. Modes: off, `final` (after the run) and
  `stream` (sentence by sentence). Also keeps the last answer for `read_last_answer`.

Hooks: `onAssistantText` / `onAnswerEnd` in `app_front/lib/sdk-rich-view.js`, wired in
`chat.js`; per-block speaker button on `cr-sdk-block`; controls in the send bar options row
(`voiceReadControls.js`), including a Test button that reads a sample with the current engine
and voice — otherwise a wrong setting is indistinguishable from a dead provider until the
next answer. Preferences are per device in `localStorage` (`cretli-voice-*`).

### Dictation

Web Speech (`window.SpeechRecognition`) stays the primary path. Where it is missing (Safari,
Firefox), `recorder.js` records with `MediaRecorder` and posts the audio to
`/api/voice/transcribe`. `sendBarMedia.js` picks the path; `startDictation` /
`stopDictation` keep their signatures. Recordings are capped at 4 MB, because base64 inflates
by ~4/3 and `express.json` accepts 8 MB.

### Voice mode (Realtime)

The panel offers three conversation backends. Default is `gpt-realtime-2.1-mini` — the
flagship (`gpt-realtime-2.1`) bills audio at about 3× the mini rate, which is why a short
chat can cost tens of cents. Gemini Live is the cheapest of the three (audio about $3/$12
per million tokens) and needs its own key (`GEMINI_API_KEY` / `geminiApiKey`).

`/api/voice/realtime-token` mints a `client_secret` with the session pinned server-side
(`lib/voice/realtime-session-config.js`): model (allow-listed mini or flagship),
instructions, tool schemas, semantic VAD, noise reduction, voice, and `max_output_tokens`
so the model cannot ramble. The client cannot widen its own permissions — it only picks a
model and a voice from an allow-list.

`realtimeSession.js` then talks to OpenAI directly: `getUserMedia` → `RTCPeerConnection` →
SDP offer to `/v1/realtime/calls` with the ephemeral token, events on the `oai-events` data
channel, model audio into a hidden `<audio>`. After each `response.done` older conversation
items are deleted (audio history is re-billed as input on later turns). A 90 s silence
timer closes the session so a forgotten tab stops billing. Start attempts are guarded by an
epoch counter: a superseded or aborted start tears its own microphone and peer connection
down, otherwise the tab keeps recording after a failed connect.

`/api/voice/gemini-live-token` issues a short-lived same-origin ticket and the pinned
`setup` (same tools and instructions). `geminiLiveSession.js` opens `/ws-gemini-live`;
the server relays PCM to Google so AQ auth keys never leave the process. Tool calls use
the same `realtimeTools.js` executor. Settings → **Test key** calls
`POST /api/voice/gemini-probe` (`models.list`) so a stored or just-pasted key can be
checked without opening a Live session.

Tool calls arrive on the data channel, are deduplicated by `call_id`, executed by
`realtimeTools.js` against the running app (`send_prompt`, `stop_agent`,
`read_last_answer`, `get_chat_status`, `list_chats`, `switch_chat`, `create_chat`, `delete_chat`,
`open_chat_sidebar`, `close_chat_sidebar`, `set_chat_mode`, `run_task`, `list_tasks`,
`list_workspaces`, `switch_workspace`, `list_folders`, `switch_folder`, `close_chat`,
`rename_chat`, `send_nav`, `list_models`, `set_model`, `switch_harness`, `fork_chat`,
`set_read_mode`, `get_cost`, `end_voice_mode`), and
answered with `function_call_output` plus an explicit `response.create` — without it the
model waits silently. `realtimeTools.js` imports `chat.js` lazily, because the tools drive
the running app that `chat.js` itself owns.

`enabledHarnesses` in `data/config.json` (Settings → Harness checkboxes) hides
a backend from new chat, the mode bar, and voice tools. Omitting the key keeps
every harness on. `harnessOrder` is the display order of those backends (drag
on the overview list). Chat/voice model pickers still use the per-harness checked
model lists (`chatEnabledModels` and `*ChatEnabledModels`).

Session debug logs live in `data/voice-sessions/{sessionId}.json` (copy the id
from the voice panel). `GET /api/voice/sessions/:id?diagnose=1` summarises gaps
between user speech and `tool.start` versus local `durationMs`. Token mint
timings are appended to `data/voice-sessions/http-requests.ndjson` and listed
at `GET /api/voice/requests`. `list_models` returns a capped page (optional
`query`); a named model should go straight to `set_model`.

`voiceCost.js` accumulates usage into a running estimate (OpenAI `response.done` or Gemini
`usageMetadata`), warns once ($2 by default) and hard-caps the session ($5). Rates are
keyed by the longest matching model prefix so mini is not billed as the flagship.
UI: `cr-voice-panel` (a `cr-dialog`), loaded on demand so WebRTC and the tool layer stay out
of the main bundle. A **Commands** toggle lists example spoken phrases from
`voiceCommandCatalog.js` (ids must match `REALTIME_TOOLS`; copy is i18n). The panel is
opened from the header button next to the connection indicator
(`voiceModeButton.js`), because voice mode steers the whole app rather than one chat; the
button is disabled without a server OpenAI key (`openAiKeyStatus.js`). Closing the dialog
(backdrop, Escape) ends the session — an open session left in the background would keep
billing. While talking, **Hide panel** puts the window away and keeps the session running,
so the app stays usable during the conversation; `voiceSessionState.js` publishes the
session status to the header button, which then pulses green and reopens the same panel, so
a hidden session is never invisible.

## Frontend

- Entry: `app_front/App.js` → `index.bundle.js`. xterm.js for terminal/tasks/agents; Lit
  web components (`app_front/components/`) for the SDK rich chat view.
- Design system: tokens in `app_front/css/tokens.scss` (`--cr-*`, including
  `--cr-control-height`), layout recipes in `app_front/css/cr-recipes.scss`
  (`.cr-page`, `.cr-field`, `.cr-card`, `.cr-row`, `.cr-page-footer`), and
  shared Lit controls in `app_front/components/ui/` (`cr-bar-*`, `cr-checkbox`,
  `cr-icon-button`, `cr-dialog`). Settings Workspace is the visual reference.
  Do not override control height on a scrolling container; keep save footers
  as siblings of the scroll body. Agent rule: `.cursor/rules/cretli-ui.mdc`.
- HMR in dev via `webpack-dev-middleware` + `webpack-hot-middleware` on the same Express
  server (`/__webpack_hmr`). Production build: `npm run build:front:prod`.
- Mobile: `visualViewport` keyboard offset, fixed send bar with safe-area insets, radial
  Kib gesture, special-char bar, screenshot/dictation support.

### Offline shell and boot guard

`public/sw.js` precaches the app shell, so a navigation succeeds even with the server
down. Bundles carry a `?v=<asset version>` query, therefore every cache fallback matches
with `ignoreSearch: true` — a strict match would miss after a version bump and hand the
cached HTML a broken `<script>`, leaving a shell with no JavaScript. `putInCache` keeps one
copy per `/dist/` path so version bumps do not pile up duplicates. `/__webpack_hmr` and
`*.hot-update.*` bypass the worker so a PWA does not swallow webpack rebuilds.

Standalone PWAs cannot pull-to-refresh (`overflow: hidden` on `body`). `initPwaUpdatePrompt`
shows a reload banner when a new service worker is waiting **or** when the running page
sees a newer front build: `GET /api/health` `frontAssetVersion` (mtime of the built SPA
bundles), with a `HEAD /dist/app/index.bundle.js` fallback. It also calls
`registration.update()` on resume so a waiting worker is not stuck until the next navigation.

`public/index.html` carries an inline guard for the case where the bundle still does not
run (styles and markup are inline because `index.css` may be missing too):

- `:not(:defined) { display: none }` — un-upgraded `cr-*` elements would otherwise leak
  their light DOM as loose text at the bottom of the page.
- `#boot-failure` — a full-screen message with **Reload** and **Clear cache and reload**.
  It appears immediately when `window.__crAppBootStartedAtMs` is missing after the
  blocking scripts, or after 15 s when `window.__crAppBooted` (set at the end of `boot()`
  in `App.js`) never arrives. The first case polls `/api/health` and reloads on its own
  once the server answers; the stalled case only reports server reachability. Embed/widget
  shells (`?embed=1`, `/embed/<id>`) skip the stall timer because their boot legitimately
  waits for the host page. Text is static English — i18n lives in the bundle that failed.

### Status parser panel (developer tool)

The hidden **Status parser** tab (`app_front/statusTests.js`, panel id `tests`) runs the
`lib/status-parser.js` fixtures and the flow scenarios from
`public/fixtures/status-flow-scenarios.json` in the browser — the same data as
`tests/status-parser.test.js` and `tests/status-parser-flow.test.js` — plus a playground
that parses a real tail from the active chat. It is useful when the UI disagrees with the
CLI suite, typically on a phone where you cannot copy the buffer into a terminal.

It is off by default and shares the status debug flag: `?debug-status` in the URL or
`localStorage['cretli-debug-status'] = '1'`. Workflow for parser bugs:
`.cursor/rules/status-tests-workflow.mdc`.

## SDK stuck run auto-recovery

When a run exceeds the configured idle budget **plus** a grace period, the server cancels
the stuck setup or stream and retries the prompt once.

| Setting | Default | Description |
|---------|---------|-------------|
| `sdkRunIdleTimeoutSeconds` (config) | 300 | Idle budget for setup progress and stream polling |
| `CRETLI_SDK_RUN_IDLE_TIMEOUT_MS` | falls back to config | Overrides idle budget (ms) |
| `CRETLI_SDK_RUN_AUTO_RECOVERY` | enabled (`1`) | Set `0` / `false` to disable auto-cancel |
| `CRETLI_SDK_RUN_AUTO_RECOVERY_GRACE_MS` | 60000 | Extra wait after budget before recovery |

**Flow:**

1. Setup phases report `setup_past_budget` via `sdkRunProgress` when over budget.
2. After `budget + grace`, setup abort fires (`room._stuckRecoveryTriggered`).
3. During stream, `awaiting_past_budget` is reported; after grace, `run.cancel()` runs.
4. One automatic retry re-queues the prompt (`sdkBusy` notice); on second failure →
   `sdkError` with code `run_stuck_auto_recovery`.

Implementation: `lib/sdk/sdk-run-auto-recovery.js`, integrated in `lib/sdk/cursor-agent-sdk-ws.js`.

## Known limitations

- Single-password auth, no multi-user/RBAC.
- SDK rooms remain in-process; Redis pub-sub mirrors live WS broadcast and registry tracks
  the **owner** instance. Non-owner nodes serve read-only **remote stubs** until failover.
  Agent runs require sticky routing to the owner (or claim after lease TTL). See
  `docs/MULTI-INSTANCE.md`.
- No rate limiting on streams; no CSP header (SPA uses inline scripts/styles).
- `server.js` is the composition root (workspace, widget auth, HMR, and HTTP
  routes live in `lib/`). `app_front/chat.js` / `app.scss` are still larger than
  ideal.
  Splitting them is tracked in `docs/MODERNIZATION_PLAN.md` (phases 1–2).
