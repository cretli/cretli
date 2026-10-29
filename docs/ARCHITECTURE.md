# Architecture

Cretli is a Node.js (Express + WebSocket) server that exposes a **terminal** and
**agent chat** (OpenCode, OpenRouter, Mistral, DeepSeek Harness, Qwen Code, Claude Code, Codex SDK, or optional Cursor SDK) for your workspace
to a browser (typically on a phone). The frontend is a webpack SPA in `app_front/`
built to `public/dist/`.

Decision cards, their REST/WS contract, server risk policy, and human-channel threat model are documented in [decision-cards.md](decision-cards.md).

## Top-level layout

| Path | Role |
|------|------|
| `server.js` | Composition root: bind, HTTPS, middleware, listen. Workspace/widget code lives in `lib/` |
| `lib/` (plugin harnesses mistral, openrouter (chat only; the client is `lib/providers/openrouter/`), codebuddy, deepseek, qwen live in `harnesses/<id>/`) | Domain modules: top-level app services plus `sdk/`, `opencode/`, `providers/openrouter/` (OpenRouter client), `zai/`, `claude/`, `codex/`, `persist/`, `widget/`, `routes/`, `ws/`, `agent-harness/` |
| `app_front/` | SPA source (webpack → `public/dist/`) |
| `public/` | Static assets served by Express, including `login.html` |
| `data/` | Runtime data (gitignored): `auth.json`, `config.json`, `mcp.json`, `mcp-secrets.json`, `mcp-tx.json`, `chats.json`, `todos/`, `uploads/`, `dsh-home/`, `qwen-home/`, `claude-home/`, `codex-home/`, TLS certs |
| `scripts/` | SSL cert generation, WSL port-forward, manual test/capture helpers |
| `docs/` | Architecture, setup, and the [modernization backlog](MODERNIZATION_PLAN.md) |
| `tests/` | Unit/integration tests + Playwright E2E (`tests/e2e/`) |

## Key `lib/` modules

| Module | Responsibility |
|--------|----------------|
| `auth.js` | Password (scrypt) + signed session cookie; Express + WS auth; agent-callback token |
| `persist/settings.js` | `data/config.json` (lanHost, workspace registry, additionalCursorContextDirs, cursorApiKey, ...) |
| `sdk/cursor-share.ts` | Runtime mirror of bundled `.cursor/skills` + `.cursor/agents` into `data/cursor-share` |
| `sdk/shared-cursor-context.ts` | Extra `.cursor/` roots for SDK multi-cwd + alwaysApply prompt inject |
| `workspace.js` | Parse `.code-workspace` (import only), inspect folder/file paths |
| `persist/workspaces-store.js` | SQL workspaces store (`workspaces.sqlite`): registry, folders, aliases, route keys; config.json migration and rollback export |
| `persist/workspace-registry.js` | Workspace registry (`file` or folder-only `cretli:ws:`) |
| `workspace-folders.js` | Folder overlay merge/sync and optional JSONC write-back |
| `workspace-list.js` | Seed registry, add/remove paths, build `/api/workspaces` payload |
| `spa-routes.js` | Allowlisted History API view paths (`/chat`, `/settings/workspace`, …) |
| `workspace-route-context.js` | Resolve opaque `ws` / `folder` query ids to registry rows |
| `persist/workspace-route-keys.js` | Mint and persist workspace/folder route UUIDs in config |

SPA navigation contract (RouteState v1, storage, resource adapters):
[docs/spa-route-navigation.md](spa-route-navigation.md).
| `persist/chats-persist.js` | CRUD for `data/chats.json`; SDK chat metadata (`cursorSessionId`, `sdkAgentId`, `codexThreadId`, `qwenSessionId`, `claudeSessionId`, …) |
| `persist/mcp-persist.js` | `data/mcp.json` + `mcp-secrets.json` with a recoverable write journal (`mcp-tx.json`) |
| `mcp/` | MCP config, secrets, runtime, Plan policy, harness adapters, Settings API |
| `persist/todos-persist.js` | CRUD for `data/todos/` (per-workspace) |
| `todo-home.js`, `todo-home-http.js` | Resolves a workspace's single "todo home" folder (pinned folder, else first enabled folder) that keys its todo list and Watcher row for REST, MCP and agent callbacks; a home shared by two workspaces is refused (`todo_home_shared`, HTTP 409) |
| `todo-plan-sync.js` | After Plan-mode runs, write versioned `.cursor/plans/cretli-{chatId}.md` and the linked Todo (Cursor SDK + other harnesses) |
| `delegation-service.js` | Create/start/cancel/retry/ack jobs from a saved plan or a chat message; one active implement/fix per planner chat, two concurrent reviews by default (`CRETLI_DELEGATION_REVIEW_FANOUT=1` opts out); versioned attempts and an outbox for history/mailbox delivery |
| `delegation-runtime-worker.js` | Periodic outbox flush, starting/cancelling/dispatching timeouts, and mailbox drain. Timer errors stay in the worker (degraded + backoff) and do not exit the process. Ticks do not overlap; flush from boot/bridge/runtime is serialized. Does not reuse boot interrupt semantics on a live start |
| `delegation-mailbox.js` | Durable parent↔child mailbox; progress and final reports are distinct; idle recipients start a turn, busy/waiting chats queue until the run ends. Parent inbound prompts must not call `delegation_reply`; MCP `chat_id` is the calling chat; a second unscoped `final_report` is rejected |
| `persist/delegations-persist.js` | `data/delegations.json` with corrupt/I/O errors that do not look like an empty store. Atomic rename is last-writer-wins across processes; no inter-process merge |
| `agent-run-state.js` | Cheap per-chat busy/waiting/attention summary for the chat list |
| `delegation-executor.js` | Resolves executor models onto Settings-enabled (favorite) variants; rejects ids outside that list |
| `delegation-tree.js` | Root/depth fields and depth + `allow_child_delegations` grant gate (`CRETLI_DELEGATION_MAX_DEPTH`, default 1) |
| `delegation-tree-lock.js` | Tree identity (`rootDelegationId`), optional occupied-slot cap (`CRETLI_DELEGATION_TREE_SLOT_LIMIT`, default off) |
| `delegation-tree-view.js` | Read-only tree snapshots for MCP `delegation_tree`, `delegation_list scope=tree`, and `GET /api/chats/:id/delegation-tree` |
| `delegation-tree-cancel.js` | Subtree cancel ordering and `canChatCancelDelegationTree` authorization |
| `sdk/cursor-agent-sdk-ws.ts` | `/ws-agent-sdk` rooms: `Agent.create`/`resume`, `run.stream()`, server-side history tap, plan guard, grace shutdown |
| `sdk/sdk-room-bus.ts` | Optional Redis pub-sub + room owner registry for multi-instance SDK (`CRETLI_REDIS_URL`) |
| `sdk/sdk-room-registry.ts` | Redis `sessionKey → instanceId` lease for SDK room ownership |
| `sdk/sdk-remote-room-stub.ts` | Lightweight non-owner SDK room (live events only) |
| `sdk/sdk-sticky-session.ts` | Sticky load-balancer cookie (`cursor-remote-instance`) |
| `sdk/sdk-instance-id.ts` | Stable per-process instance id (`CRETLI_INSTANCE_ID`) |
| `persist/chat-history-revisions.js` | In-memory revision index for cross-device history pull sync |
| `sdk/sdk-ws-handshake.ts` | Pure hello + replay-batch helpers (shared by server and tests) |
| `sdk/sdk-run-auto-recovery.ts` | Stuck setup/stream detection, cancel + single retry |
| `status-parser.js` | Parse Cursor TUI state (generating/thinking/approval/...) from PTY output |
| `fork-title.js` | One-shot agent to derive chat titles/summaries |
| `sdk/cursor-api-key.ts` | Cursor API key resolution (env/config) |
| `openrouter/openrouter-api-key.js` | OpenRouter API key resolution (env/config) |
| `openrouter/openrouter-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: openrouter` — tool loop + SDK-compatible WS events |
| `mistral/mistral-api-key.js` | Mistral API key / base URL resolution (env/config) |
| `mistral/mistral-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: mistral` — `@mistralai/mistralai` chat + host tool loop, SDK-compatible WS events |
| `mistral/mistral-models.js` | Mistral model catalog (live `models.list()`, static fallback) |
| `opencode/opencode-server-manager.js` | Lazy `@opencode-ai/sdk` server per workspace folder (health, providers) |
| `opencode/opencode-zai-api-key.js` | Z.AI key for OpenCode (`zai-coding-plan` / `zai`); Zen stays in `opencode-api-key.js` |
| `opencode/opencode-spawn-path.js` | Resolve `opencode` CLI and drop unreadable PATH dirs before `opencode serve` spawn |
| `opencode/opencode-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: opencode` — OpenCode sessions + SSE events |
| `codebuddy/codebuddy-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: codebuddy` — `@tencent-ai/agent-sdk` `query()` + CLI |
| `deepseek/deepseek-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: deepseek` — `@deepseek-ai/dsh-sdk-client` + `dsh --profile sdk` |
| `qwen/qwen-agent-ws.js` | `/ws-agent-sdk` rooms for `agentTransport: qwen` — `@qwen-code/sdk` `query()` + bundled Qwen CLI |
| `claude/claude-agent-ws.ts` | `/ws-agent-sdk` rooms for `agentTransport: claude` — `@anthropic-ai/claude-agent-sdk` `query()` (native `plan` / `acceptEdits`, `canUseTool` read-only guard, Cretli MCP bridge) |
| `codex/codex-agent-ws.ts` | `/ws-agent-sdk` rooms for `agentTransport: codex` — `@openai/codex-sdk` + bundled Codex CLI |
| `agent-harness/` | OpenRouter client, shared `room-kernel.js`, OpenCode / CodeBuddy / DeepSeek / Qwen / Claude event normalizers, tool executor, harness registry |
| `voice/openai-api-key.js` | OpenAI API key resolution for the voice layer (env/config) |
| `voice/openai-rate-limit.js` | Opt-in per-IP throttle for the OpenAI voice endpoints |
| `voice/realtime-session-config.js` | Instructions, tool schemas and audio config pinned to every minted Realtime token |
| `usage/usage-contract.js` | Versioned token/measurement contract: harness matrix, disjoint buckets, provenance/scope/lifecycle/completeness, logical identity, 24 h final-usage grace |
| `usage/usage-event.js` | Canonical usage event (stamps every event with schema/normalization/contract versions and the contract fields) |
| `usage/usage-ledger.js` | Read-model over the usage journal: scope-aware summary, timeseries, run lifecycle |
| `usage/usage-insights.js` | One filter-consistent API/UI/CSV payload: disjoint sums, cost provenance, coverage, executed choices |
| `persist/usage-persist.js` | Append-only JSONL journal + rebuildable `ledger-index.json`, inter-process lock, snapshot baselines, corrections, retention |
| `model-role-profiles.js` | Role matchers/profiles, `selectModelPick`, eligibility, rotation, cold-start, observed blend |
| `model-pick-hard-gates.js` | Injectable hard gates: role/model id, flash/premium review, favorites, lockout/quota, excludes, MCP capability |
| `model-pick-service.js` | `pickModelForPurpose` / `pickAndPersistModelForPurpose`; composes explore + shadow segments |
| `model-pick-explore.js` | Bounded out-of-band exploration (dry-run default, credits, cooldown, CAS budget reserve) |
| `model-pick-shadow.js` | Observer-only explainable shadow ranking (never changes the selection) |
| `model-pick-shadow-facts.js` | Shadow measurement facts and cycle-cost normalization |
| `persist/model-pick-decisions-persist.js` | Durable `model-pick-decisions.json` store with an atomic per-document lock |
| `model-pick-decisions.js` | Pick proposal/link classification, fanout slots, shadow comparisons, execution counters |
| `delegation-cycle-outcomes.js` | Implement/fix→review cycles, acceptance evidence, cost-per-accepted and union wall time |

## Agent harnesses

Each chat stores `agentTransport`: `sdk` (default), `openrouter`, `mistral`, `zai`, `opencode`, `codebuddy`, `deepseek`, `qwen`, `claude`, or `codex`. Changing harness from the toolbar creates a **new** chat with the chosen harness (same workspace/folder) and then optionally archives, deletes, or keeps the previous one. You can also pass the previous transcript as a handoff prompt so the new agent continues the work. In widget mode the new chat is also pinned to the host page URL.

| Harness | Backend | Auth / config |
|---------|---------|---------------|
| `sdk` | `@cursor/sdk` via `cursor-agent-sdk-ws.ts` | `CURSOR_API_KEY` / Settings |
| `openrouter` | OpenRouter `/v1/chat/completions` + server-side tools | `OPENROUTER_API_KEY` / Settings |
| `mistral` | `@mistralai/mistralai` via `mistral-agent-ws.js` + host LLM tool loop (`lib/agent-harness`) | `MISTRAL_VIBE_API_KEY` / Vibe key in Settings (preferred); `MISTRAL_API_KEY` remains fallback; optional `MISTRAL_BASE_URL` |
| `zai` | Official `zai-sdk` Python package via `harnesses/zai/zai-agent-ws.js` + host LLM tool loop; install with `npm run setup:zai-sdk` | `ZAI_SDK_API_KEY` / Settings → Harness → Z.AI; provider uses `ZAI_SDK_PROVIDER` or its independent saved setting |
| `opencode` | `@opencode-ai/sdk` (`opencode serve` per workspace) + OpenCode tool loop | Zen (`OPENCODE_API_KEY`) **or** Z.AI (`ZAI_API_KEY` / Settings → OpenCode) |
| `codebuddy` | `@tencent-ai/agent-sdk` via `codebuddy-agent-ws.js` + `codebuddy` CLI | `CODEBUDDY_API_KEY` / Settings; optional `CODEBUDDY_CODE_PATH` |
| `deepseek` | `@deepseek-ai/dsh-sdk-client` via `deepseek-agent-ws.js` + `dsh --profile sdk` | `DEEPSEEK_API_KEY` / Settings; optional `DSH_BIN` |
| `qwen` | `@qwen-code/sdk` via `qwen-agent-ws.js` + bundled Qwen CLI | `QWEN_API_KEY` / Settings (Qwen Cloud); endpoint preset `payg` / `token-plan` / `coding-plan` / `custom`; optional `QWEN_BIN` |
| `claude` | `@anthropic-ai/claude-agent-sdk` via `claude-agent-ws.ts` | Claude Code plan (local `claude` login) **or** `ANTHROPIC_API_KEY` / Settings (`claudeApiKey`) |
| `codex` | `@openai/codex-sdk` via `codex-agent-ws.js` + bundled `codex` CLI | ChatGPT plan (device login) **or** `CODEX_API_KEY` / Settings; optional `CODEX_BIN` |

A parent agent that needs a **sub-chat on another harness** (for example Cursor SDK asking DeepSeek to review a plan) uses builtin MCP `delegation_start` with a Settings-enabled model from `model_list(harness, enabled_only=true)`. Cursor's built-in `Task` tool only lists Cursor-local models and is not the Cretli catalog. `model_list` rows include heuristic `cost_tier`, `quality_tier`, and `speed_tier` plus profile `roles`. `model_pick({ role, exclude_model?, exclude_harness? })` chooses one favorite on a harness that is **enabled**, **ready**, and **can_delegate**, ranking role axes (implement: cheaper first) after eligibility matchers. Review never picks `*flash*` model ids. After a usage-limit or dead-harness fail, exclude that model/harness and pick the next candidate. Empty Settings favorites for a harness are unset: no pick, and by default no `delegation_start` (`model_list(..., enabled_only=true)` is empty; catalog rows without that flag are not start-eligible). `CRETLI_DELEGATION_EMPTY_FAVORITES=all` restores the previous start-with-any-id behavior. Default `CRETLI_DELEGATION_REVIEW_FANOUT` is two concurrent **review** jobs on one parent (`=1` opts out); implement/fix stay exclusive — this is not the D10/M12 executor pool. Review requires a hard pre-exec or sandbox read-only guarantee; an adapter without one is excluded unless `CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`. Codex review is certified by starting the thread with `sandboxMode: read-only` when `assignment=review` (the sandbox also blocks the review-verify runner, so the parent verifies); `CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX=0` turns that sandbox off and makes Codex reviews uncertified again. The same switch is the workspace setting `codex_review_sandbox` (Settings -> Delegations -> Review); the Codex adapter and the certification gate read the same resolved delegation env, and `harness_list` / Settings show per-harness review certification. DeepSeek review is certified via a generated DSH cordis patch (`sandbox-policy: read-only`, `approval: never`) applied when `assignment=review`. Mutating jobs from two parents in the same workspace return `workspace_busy`. Optional `CRETLI_DELEGATION_GLOBAL_LIMIT` caps occupied slots process-wide. Nested delegation trees share an optional `CRETLI_DELEGATION_TREE_SLOT_LIMIT` (occupied slots per `rootDelegationId`, default 0 = off, refusal code `tree_slot_limit`); the write lock names the tree in its `workspace_busy` error for in-tree conflicts. The plan/implement/review/fix loop is the parent skill (`.agents/skills/cretli-multi-harness`) plus durable `delegation_workflow_*` state, not a server sequencer. Terminal statuses are `completed` / `failed` / `cancelled` / `interrupted`. Builtin MCP `delegation_wait` long-polls those jobs for the calling parent (`timeout_ms` default 20s, max 25s, below the 30s bridge HTTP timeout; `until` all|any; retry on `pending`). Wait until `slot_occupied` is false before the next start. A review run that ends without a `VERDICT` report (one-liner or compacted thinking dump) is `failed` with `adapter_incomplete`, not a successful `completed`; a review with a substantive report but no `VERDICT` line first gets one same-chat follow-up asking only for the VERDICT line (harnesses sdk/claude/opencode/codebuddy/codex; never derived from prose) and, if that still yields none, ends `failed` with `adapter_no_verdict` ("no answer", classified as infra: not a FAIL, not a PASS), unless the child is still in `waiting_for_input` (OpenCode question/permission or SDK Ask on implement/fix). OpenCode **review** jobs auto-allow non-mutating permissions server-side (mutating stays rejected). Parent MCP `delegation_wait` treats `waiting_for_input` as an occupied slot, not an infra retry. OpenCode first-event timeout defaults to 180s (`OPENCODE_FIRST_EVENT_TIMEOUT_MS`). Idle auto-recovery does not cancel while native tools are in flight. Finished jobs can be rated: MCP `delegation_rate` (parent only, terminal only, anti-bias against the parent's own base model, immutable per job+rater) and `POST /api/delegations/:id/rate` (user, same workspace/widget scope as ack/cancel). Ratings are metadata-only JSONL (`data/delegation-ratings.jsonl`, 2 MB rotation, no report text). Display and `model_pick` ranking both use the same weighted mean (user weight 2×, parent 1×); `model_pick` observed quality (`applyObservedOutcome`) blends `rating_avg_scored` / `rating_n_scored` (max share `0.25 * n/(n+5)`). Ratings are autonomous: the orchestrating parent rates every terminal job it reads (anti-bias blocks rating its own base model); the card shows the rating read-only and has no manual form. The parent also has an ack channel: MCP `delegation_ack` (terminal jobs only, parent chat only; `reason` is `reviewed` or `accepted`) and `POST /api/chats/:id/delegation-ack` with the same parent scope as `delegation-rate`.

**Delegation options UI.** Settings → Delegations has `.cr-tabs` subtabs **Center** (runtime health and repair), **Limits** (`max_depth`, `tree_slot_limit`, `parallel_implement_fanout`, run deadlines, cancelling timeout; `global_limit` / `queue_max` are `scope=server` and read-only), **Review** (fanout, `review_allow_uncertified`, code review phase and closures, then per review kind — plan / code — the reviewer policy: automatic or fixed pair (learned or two members picked from Settings favorites) and session continuation fresh / within one subtask / across the orchestration, with an effective summary, a migration notice and the fallback note; see `docs/delegation-workflow-per-leaf.md`) and **Models** (`empty_favorites`, link to Model × role stats). Every field shows its env default and a `source` badge (`workspace` / `env` / `default`); Save sends `PATCH /api/delegation-settings` with only the changed fields and "Use env default" sends `null`. The Usage and Workspace Watcher tabs only link to these subtabs (`data-delegation-subtab-link`) — there is no second write path. Code: `app_front/features/settings/delegationSettings.js`.


**Delegation depth and trees (default: one level).** `CRETLI_DELEGATION_MAX_DEPTH` defaults to **1** (hard cap 8): a delegation child chat cannot call `delegation_start` unless the parent passed `allow_child_delegations` (stored as `delegationGrant` on the child chat). The grant only narrows downward — a child may grant further only while it holds the grant itself. Without a grant, starts from depth ≥ 1 return **409** `nested_delegation_denied`; exceeding the configured max returns `depth_exceeded`. Optional `CRETLI_DELEGATION_TREE_SLOT_LIMIT` (default **0** = off) caps occupied slots **per tree** (`rootDelegationId`); when full, starts return **409** `tree_slot_limit`. Mutating implement/fix jobs still respect the workspace write lock (`workspace_busy`); blockers in the same tree use a tree-specific message. Shared tree budgets live on the **root chat** workflow row: `workflow_update` / `POST /api/chats/:id/delegation-workflow` accepts `tree_budget_tokens` / `tree_budget_usd` only from the root chat (`workflow_parent_required` for children). When measured usage from the ledger meets or exceeds a configured cap, further starts in that tree return **409** `tree_budget_exceeded`; absent measurement does not block (`measured: false`). Visibility: MCP `delegation_tree` (read-only; optional `chat_id` must equal the caller), `delegation_list` with `scope=tree`, Settings → Delegations tree panel (`GET /api/chats/:id/delegation-tree`). Cancel: MCP `delegation_cancel` with `tree:true` (or HTTP cancel with tree flag) walks descendants before ancestors; authorized for the job's `parentChatId` or the tree `rootChatId`. While an ancestor is `cancelling`, child starts are rejected with **409** `parent_cancelling`. Gates run on start, retry, and queue drain. Gates, error codes, flag defaults and known gaps are also summarised in [delegation-tree-controls.md](delegation-tree-controls.md).

**Orchestration takeover.**
`delegation-service` transfers the recorded controller without changing historical
`parentChatId` or `sourceChatId`. A durable, untrimmed
`delegation-takeovers.json` journal checkpoints `started → rows → workflows →
mailbox → todo → done`. Boot resumes incomplete transfers before ordinary
reconciliation. Lock order is store work, sorted parent locks, then sorted chat
locks; acquisition times out before the journal is written. Occupied slots and
running children remain occupied. Only queued replies redirect using revision
CAS, followed by a recipient check under its chat lock; dispatching replies
never start a second delivery. Use MCP `todo_takeover({todo_id, idempotency_key, reason?, force_unavailable?, scope?})`
from the new orchestrator chat, or `POST /api/chats/:id/orchestration-takeover`
with `{todoId, idempotencyKey, reason?, forceUnavailable?, scope?}`. The equivalent
`POST /api/todos/:id/orchestration-takeover` takes `{chatId, idempotencyKey, ...}`.
Both routes use the same service validation, locks and recovery protocol. The MCP
name is shorter than the conceptual `orchestration_takeover` because the encoded
builtin tool name must fit the provider's 64-character limit.


All ten harnesses share the same WebSocket path (`/ws-agent-sdk`), protocol (`sdkEvent`, replay batches), rich view, and history persist format. OpenRouter, Mistral, Z.AI, OpenCode, CodeBuddy, DeepSeek, Qwen, Claude, and Codex events are normalized to SDK-shaped payloads before broadcast. Archive, restore, delete, and sidebar nesting persist a `chatsChanged` frame to every attached agent socket so the live sidebar reloads without waiting for a page resume. If the chat row is gone (deleted on another device), the server sends `sdkError` with code `chat_not_found` and the client stops reconnecting instead of treating it as a recoverable `invalid_session`.

Plan refinement prepares its cooperation session with MCP `reviewer_session`
after saving the normalised plan and after every rewrite. The tool derives
workspace and coordinator from the calling chat and reuses the session for
that saved revision and cooperation mode. A new revision gets a new session;
closed sessions are never reopened by retries. Both reviewers use the returned
id as `plan_reviewer_session_id`. Stale revision checks remain enforced.

Skills use `.agents/skills/<name>/SKILL.md` as the cross-harness convention.
Project, Cretli-bundled, user (`~/.agents/skills`), and configured shared roots are
discovered at run time and listed in prompts for every harness. Existing
`.cursor/skills` and `~/.cursor/skills-cursor` locations remain supported, so a
skill can be added once without copying it into each workspace or harness home.
When the Cursor SDK starts, Cretli also refreshes a skills-only mirror at
`data/cursor-share`; `.cursor/agents` are mirrored too, while `.cursor/rules` are
never mirrored. Shared-root `alwaysApply` rules continue to apply to Cursor SDK
chats. Context queries may pass `workspaceFolder` or `cwd`; the widget workspace
takes precedence, with the current cwd as fallback.

Skill frontmatter is parsed as YAML (`lib/skills/frontmatter.js`, `js-yaml` with
its safe default schema; a malformed block falls back to a tolerant line
scanner), so single-line, quoted and block-scalar (`>`, `>-`, `|`, `|-`)
`description:` values all reach the catalog. Two blocks are produced from one
directory scan (`buildSkillPromptBlocks` in `lib/skills/skill-context.js`): the
stable **catalog** (name, purpose, path) and the **selected instructions** of
the skills the current request **explicitly selects** (structured IDs or an unquoted
`@name`, see `docs/context/skill-activation.md`). The catalog is deduped across turns with
the rules in the static decoration block; the selected instructions are a
volatile block that is re-sent whenever a skill is invoked, so re-invocation
works and naming a skill no longer invalidates the catalog hash. See
`docs/context-cost.md` §5.

The context-unification layer (`lib/context/`: shared registry, `assemble()` for
previews/manifests/delegation, explicit skill activation, AGENTS.md scopes,
instruction epochs and the soft budget) is described per stage in
`docs/context/`; the final status, the decision to keep comparison mode
(`CRETLI_CONTEXT_BUILDER=compare`) observational while the real send path stays
on the legacy builder, the per-harness live-test gaps and the rollback switches
are in `docs/context/migration-validation.md`.

A rule file may declare an opt-in scope in its frontmatter — nested
`cretli: { projects, taskKinds, fileTypes }` or flat `cretliScopeProjects`,
`cretliScopeTaskKinds`, `cretliScopeFileTypes` — so a shared root can target a
project, a kind of task or a file type. A rule without those keys stays global,
so configuring nothing changes nothing. When the current task kind or file
context is unknown the rule is kept: no restriction is dropped on a guess.
`explainSharedAlwaysApplyRules()` returns the selected rule ids and the reason
for each decision, without any rule body.

### The `sdk-*` prefix is protocol, not Cursor SDK

The name is historical and misleads newcomers. Everything under `lib/sdk/` except
`cursor-agent-sdk-ws.ts` and `cursor-api-key.ts` is the **shared protocol layer used by
all harnesses**: `sdk-mode.ts`, `sdk-ui-mode.ts`, `sdk-ws-handshake.ts`,
`sdk-plan-guard.ts`, `sdk-room-state.ts`, `sdk-room-bus.ts`, `sdk-room-registry.ts`,
`sdk-instance-id.ts`, `sdk-run-auto-recovery.ts`, `sdk-context-*.js`. Read `sdk-` there
as "agent chat protocol". Only `cursor-agent-sdk-ws.ts` actually talks to `@cursor/sdk`.

The same applies on the frontend: `sdkEvent`, `sdkRunFinished`, `sdkRoomState` and the
rich view are the common wire format, not a Cursor-only path. `chatsChanged` is also
common: the SPA reloads the chat list (`skipAutoSelect`) so MCP `chat_archive` updates
the sidebar immediately.

### Shared room kernel (harness chats)

OpenRouter, Mistral, DeepSeek, Qwen, Claude, CodeBuddy, Codex, and OpenCode rooms use
`lib/agent-harness/room-kernel.ts` for broadcast, event log, persist buffer,
replay cancel, heartbeat, and empty-room grace shutdown. Each harness still
owns transport-specific abort (Codex abort signal, OpenCode instance lease,
Qwen questions, CodeBuddy live session, Claude `canUseTool`). `cursor-agent-sdk-ws.ts` keeps its
own room map.

`harnesses/opencode/opencode-agent-ws.js`, `harnesses/openrouter/openrouter-agent-ws.js`, `harnesses/mistral/mistral-agent-ws.js`,
`harnesses/codebuddy/codebuddy-agent-ws.js`, `harnesses/deepseek/deepseek-agent-ws.js`, `harnesses/qwen/qwen-agent-ws.js`, `lib/claude/claude-agent-ws.ts`, and `lib/codex/codex-agent-ws.ts` still own prompt
runs and vendor clients. Behaviour parity between harnesses is maintained by
the E2E suite — check `tests/e2e/chat-live-harnesses.spec.js` when you change one of them.

SDK-specific diagnostics include strict model audit for fast variants (`::fast=true`): requested model, effective model, and explicit fallback metadata in `/api/chats/:id/diag`.

OpenCode chats persist optional `opencodeSessionId` in `data/chats.json` for session reuse after reconnect. CodeBuddy chats persist `codebuddySessionId` and pass it as `query()` `options.resume`. DeepSeek chats persist `deepseekSessionId` and pass it to `DeepSeekHarness.run({ sessionId })` only while the same `dsh` process is alive; a rebuilt runtime drops that id so DSH does not collide with the persisted session log and silently complete empty turns. Child DSH workflow sessions stay off that field and off the parent run outcome — their text lands in a `subagent` tool block. Isolated DSH home is `data/dsh-home/`. Setup: **`harnesses/deepseek/SETUP.md`**. Qwen chats persist `qwenSessionId` and pass it as `query()` `options.resume`. Isolated Qwen home is `data/qwen-home/`. Setup: **`harnesses/qwen/SETUP.md`**. Qwen `ask_user_question` is surfaced through the same chat question UI as OpenCode (`opencode_question` / `opencodeQuestionReply`) via `lib/approval/ask-user-question.ts`. Claude `AskUserQuestion` blocks inside `canUseTool` (`lib/claude/claude-agent-ws.ts`) until the card is answered, dismissed (deny `User declined to answer`), timed out (`CRETLI_CLAUDE_QUESTION_TIMEOUT_MS`, default 30 min) or the run is interrupted; the reply must be returned as `updatedInput.answers` keyed by **question text** (index keys are read by the CLI as "the user did not answer"). Claude chats persist `claudeSessionId` and pass it as `query()` `options.resume`. Isolated Claude home is `data/claude-home/` (via `CLAUDE_CONFIG_DIR`). Setup: **`docs/claude/SETUP.md`**. Codex chats persist `codexThreadId` and pass it to `codex.resumeThread()`. Isolated Codex home is `data/codex-home/`. Setup: **`docs/codex/SETUP.md`**.

**OpenCode-specific features** (parity with SDK where applicable):

- **Question skill** — `opencode_question` events; reply via `POST /api/session/{id}/question/{requestID}/reply` (`harnesses/opencode/opencode-question.js`). A Plan-mode question that asks to implement/approve the plan switches the chat to Agent before the reply is sent (`lib/sdk/plan-approval-reply.ts`).
- **Permission skill** — `opencode_permission` events; reply Once / Always / Reject in UI (`harnesses/opencode/opencode-permission.js`).
- **Plan / Ask guard** — mutating `tool_call` events are blocked in Plan and Ask
  for harnesses that deny tools (`canUseTool` / permission / catalog) or abort the run.
  Ask is a separate conversation mode (questions and analysis, no plan persistence
  or “yes” → Agent). Review assignments keep native Cursor edit/delete/shell blocked
  (no pre-exec hook for shell). Harnesses that can deny before exec may run
  `node scripts/review-verify.js` with a frozen catalog of audited tests inside an
  isolated data dir. Pre-exec harnesses also allow a single
  `node [--test] tests/<name>.test.js` run (workspace `tests/` only; the in-process
  host executor still denies it). Other node flags, reporters, npm, and mutations stay denied. A pre-exec deny does not abort the review job. Codex has no pre-exec
  hook: the trusted runner is allowed, other mutations abort the turn. Codex Plan
  is prompt-only (no turn abort); Codex Ask still denies mutations on the host.
  The read-only sandbox is used only for delegated reviews (workspace setting
  `codex_review_sandbox`, Settings -> Delegations) and Scout scans, not for
  interactive Plan/Ask, because Linux bwrap fails on non-git workspace roots. Emits `sdkPlanGuard` when a mutating
  tool is denied (`lib/sdk/sdk-plan-guard.ts`).
- **Room state** — `sdkRoomState` heartbeat (~15 s) with queue depth, pending questions/permissions, `lastEventAt` (`lib/sdk/sdk-room-state.ts`, `getOpenCodeRoomDiag`).
- **Run lifecycle parity** — OpenCode emits `runId` on `sdkPromptStarted` / `sdkRunFinished`; room outcome (`lastRunId`, `lastRunStatus`, errors) is tracked like SDK for reconnect consistency.
- **Progress + resilience** — OpenCode emits `sdkRunProgress` with transport marker and auto-recovers once after timeout/stream disruption by recycling subscription/session.
- **Diagnostics** — `GET /api/chats/:id/diag` includes OpenCode session id, queue, pending interactive skills.

User setup and troubleshooting: **`harnesses/opencode/SETUP.md`**. Developer index: **`harnesses/opencode/README.md`**.

### Approval broker (OpenCode)

`lib/approval/approval-broker.ts` is a local, deterministic overlay on the
OpenCode permission flow. Modes are `off` (default), `shadow` (audit a
recommendation, never reply) and opt-in `local_reads` (auto-reply `once` only
for safe read-only actions confined to the workspace); `always` is never sent
and the human card is always broadcast first.

`lib/approval/approval-advisor.ts` adds a default-off external advisor behind
`local_reads`. It consults one public HTTPS endpoint configured in
`approvalBroker.advisor`, using either an OpenAI-compatible `chat/completions`
protocol (`protocol: "openai_chat"`) or the System One protocol
(`protocol: "systemone"`, used by Jev and Laya). Only a redacted permission
tuple — request id, action, command basename, resource basenames, risk and
categories — is sent; there is no cwd, history, diff or secret. For System One
the advisor asks one `noul` question and only an answer at or above
`minProbability` (clamped to 0.5–0.99, default 0.9) becomes `allow`. The
endpoint must resolve to a public address (loopback/RFC1918/IMDS rejected) and
the validated IPs are pinned into the HTTPS connection to defeat DNS rebinding.

Every timeout, quota miss, HTTP/429, malformed answer, SSRF rejection or missing
key collapses to `ask_user`; there is no retry or failover and the advisor can
never emit `deny`. The audit at `data/approvals/approval-audit.jsonl` records
provider host, protocol, model, latency, usage/cost, both decisions and any
error, never the key.

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
Chat (Mistral)       → /ws-agent-sdk   → Mistral API (@mistralai/mistralai) + lib/agent-harness tool loop
Chat (OpenCode)      → /ws-agent-sdk   → @opencode-ai/sdk (session.prompt_async + event.subscribe)
Chat (CodeBuddy)     → /ws-agent-sdk   → @tencent-ai/agent-sdk (query + codebuddy CLI)
Chat (DeepSeek)      → /ws-agent-sdk   → @deepseek-ai/dsh-sdk-client (dsh --profile sdk JSON-RPC)
Chat (Qwen)          → /ws-agent-sdk   → @qwen-code/sdk (query + bundled Qwen CLI)
Chat (Claude)        → /ws-agent-sdk   → @anthropic-ai/claude-agent-sdk (query + bundled Claude Code CLI)
Chat (Codex)         → /ws-agent-sdk   → @openai/codex-sdk (startThread/resumeThread, runStreamed)
Terminal shell       → /ws             → node-pty
Tasks (.vscode)      → /ws-task        → node-pty
Agent run (legacy)   → /ws-agent       → node-pty (rejected for harness chats)
Server log viewer    → /ws-server-logs → in-memory log buffer
Front hot fallback   → /ws-front-build → dist watch events (default on; CRETLI_FRONT_HOT_FALLBACK=0 disables)
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
- **Steer** — While a local run is busy, the client may send WS `{ type: 'steer', text }`
  (or `{ type: 'send' }`, which tries `Run.steer` first). The server answers with
  `sdkSteerAck` (`complete_delivered` | `revert_to_followup`) or `sdkSteerError`
  (empty text, no run, cloud/detached handle, remote room). Delivered steer text is
  persisted as `localUser` history; revert paths enqueue a normal follow-up so text
  is never lost.
- **Background subagents** — Stream events update an outstanding counter; when
  `stream()` ends but subagents still run in the background, the room keeps
  following `wait()` / a reopened stream until results land or a bounded follow-up
  budget expires (`sdkBackgroundWork`, phase `running` | `idle` | `budget_exceeded`).
- **Custom system prompt** — Settings `sdkCustomSystemPrompt` (gate + default text) and
  optional per-chat `sdkSystemPrompt` override feed `AgentOptions.systemPrompt` on every
  local create/resume (`settingSources: ['project']` unchanged). Cloud agents reject the
  field; accounts without entitlement fail the first `send` with `--system-prompt` and
  the room drops the override for subsequent turns.
- Every SDK room emits `sdkRoomState` on connect and every ~15 s (busy, runId, last seq,
  queue depth, `steerSupported`, `backgroundOutstanding`) so clients can sync without full
  replay; HTTP history pull runs when seq lags.
- SDK event history is persisted server-side to `data/chat-history/<chatId>.json` during
  runs (debounced flush every ~2 s while busy) and after each run, so offline/reconnected
  clients can replay events generated during disconnect.
- Cross-device sync is **pull-based**: clients poll `GET /api/chats/history-revisions` every
  ~15 s (visible tab) and run HTTP history delta pull when `headSeq` advances. Background
  chats that already have a covering WebSocket skip HTTP unless `hasPendingDelegation`.
  Store ACK is not the view (`viewAppliedSeq`). Background pulls use
  `POST /api/chats/history-batch` with an explicit id list (never omit-ids = all chats)
  and the same batch/concurrency budget as WS reconnects (floor 1 on mobile). Optional
  web push nudges (`CRETLI_PUSH_HISTORY=1`) reuse existing VAPID subscriptions.
  The same subscriptions also receive a push when Cursor SDK finishes a run,
  when OpenCode or Qwen is waiting on a question or permission, and when a new
  chat is created (`chat-created`, one push per chat, skipping temporary fork chats).
  The same poll loads `GET /api/chats/agent-states` (no `ids` query — a full UUID
  list plus cookies can exceed Node's 16 KiB header limit and return 431). The
  response is a compact map of busy / waiting / attention only; a missing chat id
  is idle. When at least one `/ws-agent-sdk` socket is OPEN, the same map is
  pushed as coalesced `agentPresence` frames on the chat-list subscriber set
  (`lib/agent-presence-bus.js`, scoped per session vs widget chat id). The
  client skips the HTTP `agent-states` GET while that feed is fresh (~10 s) and
  `sdkRoomBus` is not `redis`. Codex / Qwen / DeepSeek / CodeBuddy / PTY still
  rely on delegations + HTTP; live tool names are SDK/OpenCode/OpenRouter only.
  `GET /api/chats/history-revisions` sends `ids` when the list fits the query
  budget; longer explicit lists use chunked GET and/or
  `POST /api/chats/history-revisions-batch` (empty body is 400 — never “every
  chat”). Omitting `ids` on GET still returns the widget/main allowlist, not
  the unscoped in-memory index. `hasPendingDelegation` on a revision forces the
  open parent chat to pull a new delegation card even when the WebSocket is up.
- Multi-instance deployments: set `CRETLI_REDIS_URL` (+ optional `redis` package).
  See **`docs/MULTI-INSTANCE.md`** for sticky routing, registry lease, and failover.
- Optional per-process id: `CRETLI_INSTANCE_ID` (also exposed in `/api/health`).
  to fan-out sequenced SDK room events across Node processes (`sdk-room-bus.ts`).
- Stuck run auto-recovery (default on): after idle budget + 60 s grace, setup/stream is
  cancelled and retried once (`lib/sdk/sdk-run-auto-recovery.ts`). Disable with
  `CRETLI_SDK_RUN_AUTO_RECOVERY=0`.
- Chat history revision index is seeded from `data/chat-history/*.json` on server startup
  so cross-device polling works immediately after restart.

## Context usage meter

The chat context ring, advisory and details modal measure **current prompt occupancy vs the context window**, not session billing. Billing totals (run/session sums, `billedTotalTokens`) and context occupancy are separate planes (`docs/usage-contract.md`); the meter never reads a run total as occupancy.

| Source | When it is used |
|--------|-----------------|
| Reported | Cursor SDK `usage` events, Claude `context_usage` and Codex latest-call snapshots. Occupancy is the **prompt size per the harness window semantics** (`promptTokensForWindow`): inclusive harnesses use `inputTokens` as is, disjoint ones use input + cache read + cache write. Cache is **never subtracted** (it occupies the window) and is shown as separate metadata. |
| Estimated (`chars / 4`) | OpenCode, OpenRouter, or SDK chats with no usage yet. Labelled "estimated", output/total stay empty (`—`). |
| Unknown | No measurement, a fresh session after compaction/reset, or a transport outside the usage matrix. |

Each snapshot (`buildChatContextSnapshot`) carries a `quality` view built by `app_front/features/chat/chatContextQuality.js` on top of the usage contract:

- **quality**: `reported` / `estimated` / `unknown`; **scope**: `current_prompt` / `transcript_estimate` / `unknown`; **granularity** from the harness contract (`request`, `message`, `turn`, `run`).
- **age** of the measurement and `stale` (live-transport TTL of `resolveOccupancyFreshness`, 10 min). Age is computed at render time from the *source* observation time (`usageMeta.sourceObservedAt`, falling back to `observedAt`), so it keeps growing without a new reading. A stale reading keeps its number but is marked and loses automatic eligibility.
- **limit type/source**: `context_window`; `limitSource` is `provider` (window reported by the harness), `catalog` (static/dynamic model table), `manual` (explicit override) or `unknown`. The server stamps it in `usageMeta.occupancy.limitSource`; the front falls back to `catalog` when no server source exists.
- **Server occupancy**: for harnesses other than Claude/Codex the front reads `usageMeta.occupancy` (`source`, `promptTokens`, `limitTokens`, `limitSource`) plus `observedAt`/`sourceObservedAt` and `contextEpoch` from the stamped `usage`/`context_usage` event (`applyServerContextOccupancy`). Only a `snapshot` source becomes the meter reading; a billing `usage` total (raw `usage.inputTokens`) never does.
- **No percentage** when the window is unknown or the harness's window semantics are unknown (`fillPercent: null`, the label says "window size unknown").
- **autoEligible** is true only for a fresh, reported, same-epoch, non-zero reading with a known window and known semantics. Auto-compression (`evaluateAutoContextCompressionGate`) additionally requires it; estimates, stale readings, run totals and unknown limits are advisory only. The advisory appends a quality note (estimate / stale / unknown limit).
- After compaction or reset the context epoch is bumped and the previous reading is dropped, so an old measurement cannot be read as current.

The details modal shows source, quality, scope, granularity, age, limit type/source (PL/EN `chat.contextQualityLimit{Provider,Catalog,Manual,Unknown}`) and whether automatic decisions are allowed (PL/EN keys `chat.contextQuality*`). Tests: `tests/chat-context-quality.test.js`, `tests/chat-context-meter.test.js`.

Model windows come from a static prefix table in `lib/sdk/sdk-context-advisory.ts` (including `grok-4.6` = 500k from the xAI API) plus runtime catalogs (`setDynamicModelContextWindows` from OpenCode `limit.input` and Cursor `models.list` when those fields exist).

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
- The built-in Browser sends an in-memory token (`x-cretli-local-login`) and can
  open a session with `POST /api/login` `{ "local": true }` without the password.
  The token is attached per request only when the target origin is one of
  Cretli's own origins; it is never sent to a third-party origin, a subresource
  or a foreign redirect hop. Other clients still need the password, including
  LAN traffic forwarded onto localhost. The token is not stored and is redacted
  in Browser network output.

## HTTP API (selection)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (public; includes `frontAssetVersion` and the bare `backendCodeStale` flag — no counts, no paths) |
| GET | `/api/diagnostics/server` | Server diagnostics ring + memory alerts + `codeFreshness: { state, changedCount, staleSinceAt }` (auth required; widget/MCP tokens are refused). `state` is `unknown` when the backend could not be measured, and then `changedCount` is `null`, never `0`. Also carries `write-stats` events (5-min per-file atomic-write counters; see [perf-write-report.md](perf-write-report.md)) |
| GET | `/api/auth-status` | Auth state (public) |
| POST | `/api/setup` | Set the password on first run |
| POST | `/api/login` / `/api/logout` | Session login/logout |
| GET | `/api/workspace` / `/api/workspaces` | Current workspace / registry (`?refresh=1` busts cache, `?scan=1` finds new files, `?sync=1` is the explicit "refresh from file": it adds folders of each imported `.code-workspace` that the stored workspace lacks) |
| POST | `/api/workspace/refresh-from-file` | Explicit refresh of one imported workspace from its source `.code-workspace` (additive; never automatic) |
| POST | `/api/workspace-file/folders` | Optional JSONC write-back of folders into a registered `.code-workspace` |
| GET/PATCH | `/api/settings` | Runtime settings (LAN host, workspace registry, cursorApiKey) |
| GET | `/api/harness-catalog/harnesses` | Cached harness ready/enabled flags (password session, not widget/MCP token) |
| GET | `/api/harness-catalog/models` | Cached/fallback models for one harness (`?harness=`). Cursor SDK also lists Settings-enabled variants when the live catalog is not fetched. Does not start vendors |
| GET | `/api/update/status` | App version + local/remote SHA (`?check=1` fetches GitHub). Auth required. |
| POST | `/api/update/apply` | Background `scripts/self-update.sh` (fetch + reset --hard + npm + rebuild). Auth required. |
| GET | `/api/codebuddy/status` | CodeBuddy package + CLI + API key readiness |
| GET | `/api/codebuddy/models` | CodeBuddy model catalog (live account probe, then international-site catalog) |
| GET | `/api/deepseek/status` | DeepSeek Harness package + CLI + API key readiness |
| GET | `/api/deepseek/models` | DeepSeek Harness model catalog (live `GET /models` when a key is set; fallback `deepseek-flash` / `deepseek-v4-pro`) |
| GET | `/api/mistral/status` | Mistral SDK package + API key readiness |
| GET | `/api/mistral/models` | Mistral model catalog (live `models.list()` when a key is set; otherwise static fallback) |
| GET | `/api/zai/status` | Official Z.AI SDK + independent Z.AI SDK key readiness |
| GET | `/api/zai/models` | Static GLM catalog for the official SDK harness |
| POST | `/api/harness/zai/install` | Installs `zai-sdk` into the managed Python virtual environment |
| GET | `/api/qwen/status` | Qwen Code SDK + Qwen Cloud API key readiness (CLI optional) |
| GET | `/api/qwen/models` | Qwen Cloud model catalog (live `{baseUrl}/models` when a key is set; otherwise plan fallback) |
| GET | `/api/claude/status` | Claude Agent SDK package + Anthropic API key readiness |
| GET | `/api/claude/models` | Anthropic model catalog (live `/v1/models` when a key is set; otherwise static fallback) |
| GET | `/api/codex/status` | Codex SDK package + CLI + ChatGPT session or API key readiness |
| POST | `/api/codex/login/start` | Start ChatGPT device-code login (`codex login --device-auth`) |
| GET | `/api/codex/login/status` | Device-login phase, URL, and one-time code (no tokens) |
| POST | `/api/codex/login/cancel` | Abort in-flight device login |
| POST | `/api/codex/logout` | Sign out ChatGPT plan (`codex logout` + remove `auth.json`) |
| GET | `/api/codex/models` | Codex model catalog (ChatGPT: `models_cache.json`; API key: documented fallback including GPT-6 Astra) |
| POST | `/api/chats/:id/delegations` | Start a plan- or message-sourced job (executor + idempotency key; plan revision or history seq; optional `allowChildDelegations` / `allow_child_delegations`) |
| GET | `/api/chats/:id/delegations` | List jobs for the chat as planner or executor |
| GET | `/api/chats/:id/delegation-tree` | Read-only delegation tree for the chat (ancestors + descendants, slot/budget counters; no report bodies) |
| GET | `/api/chats/:id/plan` | Latest persisted plan document (revision, hash, markdown) |
| GET | `/api/delegations/runtime` | Delegation worker/lifecycle health (auth; no prompt text; workspace/widget scoped counts) |
| GET | `/api/delegations` | Workspace job summaries (`attention`, `cursor`, `limit`) |
| GET | `/api/delegations/executors` | Harnesses that can start/cancel without an open browser (all enabled agent transports) |
| GET | `/api/delegations/:id` | Job status and report (`field=summary\|report\|plan\|attempts\|outbox` for paging) |
| POST | `/api/delegations/:id/retry-delivery` | Retry one failed/uncertain mailbox message. `mailboxId` (or `messageId`) is always required, including when 0 or 1 messages exist. Optional `attemptId`. Does not start a new attempt |
| POST | `/api/delegations/:id/cancel` | Request stop; stays `cancelling` (HTTP 202) until the executor run ends |
| POST | `/api/delegations/:id/retry` | Start a new attempt on the same executor chat |
| POST | `/api/delegations/:id/ack` | Clear waiting attention (open child) or mark a finished job reviewed |
| POST | `/api/chats/:id/delegation-rate` | Parent-channel rating (`rater=parent`; same chat scope as workflow — calling session must be the job parent) |
| POST | `/api/chats/:id/delegation-ack` | Parent-channel acknowledgement (`delegation_ack`; terminal jobs; `reason` `reviewed` or `accepted`; same scope as `delegation-rate`) |
| GET | `/api/delegations/stats` | Model×role outcomes, pick/cycle metrics, and `loop.leaves` (per-leaf loop read-model: rounds, models per role, verdicts, verify, `stopReason`, wall/cost) |
| GET | `/api/chats/:id/mailbox` | Inter-chat mailbox (queued and delivered) |
| POST | `/api/chats/:id/mailbox/reply` | Send a child message to the communication parent (`delegationParentChatId`), not the sidebar group |
| GET | `/api/chats/:id/delegation-workflow` | Durable parent-loop state for the chat (role, round, verdict, stop reason, deadline, `materialRevision`) |
| POST | `/api/chats/:id/delegation-workflow` | Update parent-loop state (`idempotencyKey` replay of any applied key / conflict; `materialRevision`; root-only `treeBudgetTokens` / `treeBudgetCostUsd`). Child chats are refused (`workflow_parent_required`) |
| GET | `/api/chats/agent-states` | Compact busy/waiting/attention map (`?ids=` optional; omit for all allowed chats; idle omitted) |
| GET | `/api/chats` / POST `/api/chats` | Chat list / create |
| GET | `/api/chats/page` | Additive bounded keyset page of the chat list (`limit` default 100, clamped to 1..500, `cursor`, `archived=include\|exclude\|only\|tree`, `workspaceFolder`, `workspaceFile`, `view=list` for the lightweight DTO, widget-only `pinnedTo`: separate `linkedChat` field searched within the widget controller scope incl. archived rows, independent of paging, omitted with `view=list`). Scope (widget installation + controller scope, workspace) is applied before the limit. A cursor from another store revision is **409** `STALE_CURSOR`, a malformed one **400**. Rows carry `onWorktree` like `GET /api/chats`; `harnessState` is resolved for persisted local transports (full rows only). Default `archived=tree` matches the live-only `GET /api/chats` (live rows plus archived ancestors of live rows, so the sidebar never shows orphaned children); `archived=exclude` is strict and drops those ancestors. `archivedCounts` is computed over the same scope (workspace/widget), whereas non-widget `GET /api/chats` counts globally. An invalid `archived` value is **400** `INVALID_ARGUMENT`. Details: [architecture-chat-catalog-contract.md](architecture-chat-catalog-contract.md). Response includes `sync` (`<epoch>.<seq>`). Contract: [architecture-list-sync-contract.md](architecture-list-sync-contract.md) |
| GET | `/api/chats/sync` | Delta since `since=<epoch>.<seq>`: `mode` `delta` (upserted DTOs + removed ids, <= 100 rows and <= 128 KiB), `noop`, or explicit `resync` (`no-since`, `epoch`, `gap`, `ahead`, `too-large`) after which the client walks `/api/chats/page?view=list`. Same scope policy as `/api/chats/page`; read-only |
| PATCH | `/api/chats/:id` | Update chat fields (`archived`, `title`, `model`, ...; CSRF header required) |
| DELETE | `/api/chats/:id` | Delete chat + history (runs disposable-room cleanup first) |
| GET | `/api/chats/history-revisions` | Lightweight `headSeq` revision index (`?ids=` optional; omit = all allowed chats, widget scoped; never the unscoped index) |
| POST | `/api/chats/history-revisions-batch` | Explicit revision index slice (`{ ids: [...] }`). Empty `ids` is 400 — never “every chat”. Widget scoped. |
| POST | `/api/chats/history-batch` | Explicit multi-chat history delta (`{ chats: [{ id, since, limit? }] }`). Empty `chats` is 400 — never “every chat”. Widget scoped. |
| GET | `/api/chats/:id/history` | Pull SDK history log (`?since=&limit=`) |
| POST | `/api/chats/:id/dispose-sdk-room` | Reset in-memory SDK room (stuck chat recovery) |
| GET | `/api/chats/:id/sdk-messages` | SDK message history (`Agent.messages.list`) |
| GET | `/api/files/entries` / `/api/files/read` | Workspace tree / file content (symlink-safe) |
| GET | `/api/fs/entries` | Absolute directory listing for path pickers (`?path=&includeHidden=1`) |
| POST | `/api/fs/mkdir` | Create one folder under an existing absolute path (`{ path, name }`) |
| POST | `/api/git/run` | Whitelisted git actions (status, fetch, pull, push, checkout). `switch`/`switch-new` are guarded: refused with `workspace_busy` while a chat run, delegation slot or watcher cycle is live in the repo's main working tree |
| GET | `/api/git/branches` | Local branches for the workspace quick switch (`for-each-ref`; `{ name, current, argSafe }[]`) |
| GET | `/api/worktrees/list` | Task worktrees of the workspace: the registry reconciled with `git worktree list` (row `state`, branch, base/head, ahead commits, uncommitted files, per-row `actions`). Paths come only from registry records |
| GET | `/api/worktrees/:todoId/diff` / `merge-preview` | Diff (stat + patch, from the record path) / merge preflight for the modal (target branch, blockers, diffstat, conflict forecast) |
| POST | `/api/worktrees/:todoId/merge` | Start the git-level merge chat (`harness`/`model`/`instructions`); refused with the blocker list (409) when the preflight fails |
| POST | `/api/worktrees/:todoId/reject` / `cleanup` | Reject the integration (worktree kept) / remove the worktree (+ optional fully merged branch); an unintegrated cleanup needs `discard` + `confirmBranch` |
| POST | `/api/upload-screenshot` | Image upload (sharp re-encode, 5 MB limit) |
| POST | `/api/voice/speak` | Text to speech via OpenAI or Azure (`provider`) → base64 mp3 |
| POST | `/api/voice/transcribe` | Audio (base64) to text via OpenAI |
| POST | `/api/voice/realtime-token` | Ephemeral OpenAI Realtime `client_secret` with a pinned session |
| POST | `/api/voice/gemini-live-token` | Same-origin Gemini Live relay ticket + pinned `setup` |
| POST | `/api/voice/gemini-probe` | Cheap Gemini key check (`models.list`, no Live session) |
| GET | `/api/usage/summary` | Month/day usage totals (`from` defaults to the 1st) |
| GET | `/api/usage/resume-advice` | Cheap-resume advice for one chat (`chat_id`); local read, no model request |
| POST | `/api/usage/events` | Client-reported raw tokens (OpenAI Realtime). Rejects `usd` |
| GET | `/api/mcp/servers` | MCP registry (no secret values) + revision |
| POST | `/api/mcp/servers` | Create MCP definition (`expectedRevision`) |
| PATCH | `/api/mcp/servers/:id` | Edit definition; omit a secret to keep it |
| DELETE | `/api/mcp/servers/:id` | Remove definition and secrets |
| POST | `/api/mcp/servers/:id/test` | Connect, list tools, dispose (does not call tools) |
| GET | `/api/mcp/servers/:id/tools` | Last known catalog |
| GET | `/api/mcp/status` | Config/connection status for workspace, harness, session |
| GET/POST | `/api/mcp/bridge/*` | Session integration-token bridge (not widget, not cookie UI) |
| GET/PATCH/DELETE | `/api/workspace-watcher` | Per-workspace watcher state (`mode`, `policy`, `stopReason`). GET never creates a row |
| GET/PUT/PATCH | `/api/execution-settings` | Per-workspace execution settings (default mode + worktree layout) shared by the Watcher and manual todo starts; returns `saved`, `effective`, `proposal` |
| POST | `/api/workspace-watcher/tick` | One deterministic tick; autopilot may also start a cycle |
| POST | `/api/workspace-watcher/run-cycle` | Reconcile + tick + guarded cycle start for this workspace |
| POST | `/api/workspace-watcher/claim-next` | Atomically claim the next ready todo for a chat |
| POST | `/api/workspace-watcher/reset-plan-requests` | Clear the anti-loop plan memory (all, or one `todoId`) |
| POST | `/api/workspace-watcher/findings` | Record a review findings hash for the same-findings guard |
| POST | `/api/workspace-watcher/save-plan` | Save draft todo plan with CAS; changed text requires human reapproval |

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
  plus mailbox reply/inbox, task/agent catalogs, harnesses/models, and the `browser_*` tools of the
  built-in Browser — `lib/mcp/builtin/browser-tools.js`, server process only). A `browser_*` call
  acts for the login session currently attached to the chat (or its fork parent); a run with no
  open UI, such as a Watcher/autopilot cycle or a delegation, uses the reserved system owner and a
  private Chromium context that is not shown in the Browser panel. Tools are scoped to the calling chat
  workspace, not the UI global folder. `chat_list` / `chat_show` / `chat_history` / `chat_event`
  default to that workspace; pass `scope=all` to reach another workspace by id.
  `chat_history` pages events by seq (optional tool payloads). `chat_event` reads a UTF-16
  slice of one event field. A UI copy-ref line `cretli-ref chat=<uuid> seq=<n>` is that
  event with `field="text"` (full UUID, exact seq, no neighbor). Standalone stdio requires
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

Every paid AI call (voice Live/TTS/STT, OpenRouter chat, Cursor SDK tokens, and every
agent harness) records into one server ledger (`lib/usage/` + gitignored
`data/usage/YYYY-MM-DD.jsonl` and its rebuildable `ledger-index.json` read-model). The
server sets USD from `lib/usage/usage-rates.js`; the browser never sends a price. Gemini
Live is counted on the WS relay. OpenAI Realtime is browser-direct, so the client POSTs
raw token counts only. Cursor SDK stores tokens with `usd: null`. The chat context ring
stays a separate meter. Settings → Usage shows the zone-aware windows, disjoint cache
buckets, data completeness and executed automatic choices.

The measurement contract is versioned and documented in
[usage-contract.md](usage-contract.md); the event schema, endpoints, privacy and
retention/alerts are in [usage-telemetry.md](usage-telemetry.md); the staged rollout and
rollback rules are in [usage-rollout.md](usage-rollout.md). Model-pick decisions and cycle
costs are documented in [model-pick-decisions.md](model-pick-decisions.md), and the
observed/shadow scoring facts in [model-scoring-facts.md](model-scoring-facts.md).


## Voice layer

Three independent features share one OpenAI key: reading answers aloud, dictation, and a
Realtime voice conversation. All of them are opt-in and off by default. Read-aloud can
additionally use Azure Speech, which is the only provider here with native `pl-PL` voices.

The key is resolved server-side only (`lib/voice/openai-api-key.ts`: `OPENAI_API_KEY`, then
`data/config.json` → `openaiApiKey`, same pattern as OpenRouter). The browser sees rendered
audio, plain text, or a short-lived token — never the key. `/api/settings` reports only
`openaiApiKeyEffective` and format flags.

Azure credentials follow the same rule in `lib/voice/azure-speech-key.ts`
(`AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`, then `azureSpeechKey` / `azureSpeechRegion` in
`data/config.json`). The region is part of the endpoint host, so both values are required
and env wins as a pair — a half-configured env must not borrow the region from the settings
file. `/api/settings` reports `azureSpeechEffective`, format flags and the region (not a
secret).

`lib/voice/openai-rate-limit.ts` adds an opt-in per-IP throttle
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
- Azure has no `speed` field — rate is set through SSML `prosody` in `lib/voice/azure-tts.ts`,
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
(`lib/voice/realtime-session-config.ts`): model (allow-listed mini or flagship),
instructions, tool schemas, server VAD, noise reduction, voice, and `max_output_tokens`
so the model cannot ramble. That cap is shared by text and audio tokens; it must be high
enough to finish a spoken sentence. The client cannot widen its own permissions — it only
picks a model and a voice from an allow-list.

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
`realtimeTools.js` against the running app, and answered with `function_call_output` plus
an explicit `response.create` — without it the model waits silently. `realtimeTools.js`
imports `chat.js` lazily, because the tools drive the running app that `chat.js` itself owns.

The tool set is defined once in `lib/voice/action-registry.ts` (`VOICE_ACTIONS`) and
projected for OpenAI (`buildRealtimeTools`), Gemini (`toGeminiFunctionDeclarations`) and the
help list (`voiceCommandCatalog.js`), so the schemas cannot drift. Core tools:
`send_prompt`, `stop_agent`, `read_last_answer`, `get_chat_status`, `list_chats`,
`switch_chat`, `create_chat`, `delete_chat`, `open_chat_sidebar`, `close_chat_sidebar`,
`set_chat_mode`, `run_task`, `list_tasks`, `list_workspaces`, `switch_workspace`,
`list_folders`, `switch_folder`, `close_chat`, `rename_chat`, `send_nav`, `list_models`,
`set_model`, `switch_harness`, `fork_chat`, `set_read_mode`, `get_cost`, `end_voice_mode`.
Five *family* tools carry an `action` enum with flat parameters to keep schema tokens low:

| Tool | Actions | Risk |
|---|---|---|
| `panel` | `open` (chat, todo, files, git, github, browser, tasks, terminal, logs, tests, instances), `status` | safe |
| `app_settings` | `theme`, `language`, `mic` | safe |
| `app_status` | `notifications`, `scout`, `health`, `context` | safe, read-only |
| `approval` | `describe_pending`, `answer` (`once` / `reject` only, bound to `request_id` + chat) | confirm |
| `work` | `todo_ready`, `todo_status`, `todo_start`, `watcher_status`, `watcher_pause`, `watcher_resume`, `delegation_status`, `delegation_cancel` | confirm for start/cancel |

Handlers are dependency-injected modules (`voiceAppTools.js`, `voiceApprovalTools.js`,
`voiceWorkTools.js`) bound in `realtimeTools.js` and unit-tested. Results are capped by
`capVoiceResult` and carry `untrusted: true` when they contain user or agent text.
Mutating actions (`todo_start`, `delegation_cancel`) use a two-step confirmation: step one
resolves one id and binds it to the workspace folder and active chat; step two needs
`confirm=true` and the same id within 60 s. Approval by voice answers only a `request_id`
that `describe_pending` showed; always/harness grants and plan approval are UI-only.

State sync (`voiceStateSync.js`): one compact state item (active chat, workspace, open
panel, pending approval, read mode) lives in the conversation, is re-sent only when its
text changes and is restored after a reconnect. Timing events (`voiceResponseTiming.js`)
append one `response.first_audio` and one `response.end` per response to the session log,
and the diagnose endpoint reports user→tool and user→audio p50/p95. Coverage, thresholds and
the measurement protocol: `docs/voice-control-coverage.md` (benchmark:
`scripts/voice-control-benchmark.mjs`).

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

- Entry: `app_front/App.js` → `index.bundle.js`. xterm.js for terminal/tasks; Lit
  web components (`app_front/components/`) for the SDK rich chat view.
- Design system: tokens in `app_front/css/tokens.scss` (`--cr-*`, including
  `--cr-control-height`), layout recipes in `app_front/css/cr-recipes.scss`
  (`.cr-page`, `.cr-field`, `.cr-card`, `.cr-row`, `.cr-page-footer`), and
  shared Lit controls in `app_front/components/ui/` (`cr-bar-*`, `cr-checkbox`,
  `cr-icon-button`, `cr-dialog`). Settings Workspace is the visual reference.
  Do not override control height on a scrolling container; keep save footers
  as siblings of the scroll body. Agent rule: `.cursor/rules/cretli-ui.mdc`.
- Frontend dev build: the default path is the **external CLI watcher**
  (`npm run watch:front` / VS Code task `Cretli: build front (watch)`) using
  `app_front/scripts/webpack-cli-watch.mjs` with an exclusive lock in `data/`; it
  writes `public/dist/app/` and never loads webpack into `server.js`. The browser
  picks the new bundle up through the PWA update banner
  (`app_front/features/pwa/pwaUpdatePrompt.js` polls `/api/health`
  `frontAssetVersion`). There is no in-process HMR.
  One-shot dev compile: `npm run build:front`. Production build:
  `npm run build:front:prod`. `lib/ws/front-build-ws.ts` still watches
  `public/dist/app` (`/ws-front-build`), but no client consumes it yet.
- Mobile: `visualViewport` keyboard offset, fixed send bar with safe-area insets, radial
  Kib gesture, special-char bar, screenshot/dictation support.
- Chat list metadata persistence (IndexedDB stage 5): isolation contract and SDK vs
  metadata lifecycle in [chat-metadata-idb-isolation.md](chat-metadata-idb-isolation.md);
  schema helpers in `app_front/features/chat/chatMetadataIdbSchema.js` and runtime
  access in `chatMetadataIdb.js`. Auth boundaries use `chatSessionBoundary.js`.

### Sidebar live chat status

A sidebar row status moves through four stages, and only the last one touches the DOM:

1. **Presence bus (server)** — `lib/agent-presence-bus.js` coalesces per-chat run
   state into one `agentPresence { epoch, seq, snapshot, states, cleared, watchers }`
   frame per flush (~80 ms). The compact state comes from `summarizeChatRunStates`
   (`lib/agent-run-state.js`): each id is `busy`, `waiting`, or `attention` from its
   active run and delegation rows, and idle ids are omitted. Every chat WebSocket is
   a subscriber, so one bus frame is delivered once per open socket; `seq` is shared
   across sockets and `epoch` identifies the server process.
2. **Presence store (client)** — `app_front/features/chat/agentPresenceStore.js`
   remembers the last state per chat id, including ids the chat list does not contain
   yet. `ingestAgentPresenceMessage` (`chatHistorySyncPoll.js`) drops `(epoch, seq)`
   duplicates, detects a gap, and applies a frame that arrives before the list is
   loaded; a full `GET /api/chats/agent-states` response shares the snapshot
   semantics. Every applied row stamps `_serverRunStateAt`, the watermark that
   rejects an older push-inbox record, and `hydrateChat` paints a remembered row onto
   a chat object built later (boot cache or `GET /api/chats`).
3. **Resolver** — `getSidebarChatStateMeta` (`app_front/chat.js`) turns
   `_serverRunState`, pending question/permission flags, local agent state and the
   connection state into one `{ tone, label }` via `resolveHarnessChatStateMeta`
   (`app_front/features/chat/chatStatusMeta.js`).
   `sidebarChatStatusStability.js` adds per-chat timers: entering "working" or
   "needs action" is immediate, leaving "working" has a 500 ms exit hysteresis, and a
   tool label is held for at least 500 ms so a burst of tools does not flicker.
4. **Point patch** — `scheduleChatListStateRefresh(dirtyIds)` (rAF-coalesced) hands
   the dirty ids to `updateSidebarChatStates`, which rewrites only those rows'
   chip/indicator through `applySidebarChatStatusEl`. A call with no ids, an empty
   array, or an array that carries no valid id is a **no-op**: it neither plans a frame
   nor marks the list dirty, and an empty dirty set ends `updateSidebarChatStates`
   before the walk, so it emits no patch at all. The full-list wildcard (`*`) survives
   only on the drawer-open path (`openSidebar` → `refreshStates` →
   `refreshSidebarChatStates` → `scheduleChatListStateRefreshAll`), where it wins over
   any ids queued in the same frame. Selecting a chat dirties just
   `[prevActiveChatId, nextId]`, because `chatExpectsLiveSocket` reads `activeChatId`
   and both rows would otherwise go stale once the full `*` is gone. The status tone is
   deliberately **not** part of `renderSignature`, so no presence or time-based status
   change can rebuild the list; a full render happens only for structure, layout, group
   composition, or watcher changes.

   **Auto-archive countdown:** when the idle-chat auto-archive setting is enabled, the
   same row patch (`sidebarChatRowVisualPatch.js`) also resolves a countdown from
   `updatedAt + idleMs` (`sidebarChatArchiveCountdown.js`) and, for a row whose state is
   plain `idle` inside the warning window, replaces the idle status chip with an animated
   clock and the remaining time. Pinned chats, chats with live work and archived chats
   are excluded; the estimate is refreshed by one shared 30 s timer
   (`sidebarArchiveCountdownClock.js`) that only runs while the setting is enabled.

**Lit migration (stage 6):** The sidebar will move to Lit components in **light DOM**
only (no Shadow DOM on rows). DOM/event/CSS contracts, mount boundaries, consumer
inventory, and stage 6.3–6.5 scope are documented in
[sidebar-lit-migration-contracts.md](sidebar-lit-migration-contracts.md).

`chatsChanged` frames take a separate, cheaper path
(`app_front/features/chat/chatListLiveSync.js`): a watcher frame only refreshes
watcher panels, a title frame patches the single row, and only
create/delete/nest/archive frames trigger a debounced `GET /api/chats`. The 15 s
`GET /api/chats/agent-states` poll (`chatHistorySyncPoll.js`) remains only as a
fallback for a missed or uncertain presence stream, and is skipped while a fresh WS
frame is trusted.

#### Status priority (`resolveHarnessChatStateMeta`, highest first)

| # | Signal | Result |
|---|--------|--------|
| 1 | Pending question / permission (`_opencodePendingQuestion`, `_sdkServerPendingQuestionCount`, …) | `awaiting` — "Needs action" |
| 2 | Server run state `waiting` (delegation `waiting_for_input`, or a run waiting for input) | `awaiting` — "Waiting for N agents" or "Needs action" |
| 3 | Server run state `attention` (finished delegation awaiting review) | `attention` — Completed / Failed / Interrupted |
| 4 | Server run state `busy` with an `activityKey` | `active` — tool label (Read / Grep / Write / Edit / …) |
| 5 | Server run state `busy` without a key | `active` — "Agent working" |
| 6 | Local queued prompts (`queuedCount > 0`, local agent active) | `active` — "Agent working · queue: N" |
| 7 | Local agent active (fallback) | `active` — "Agent working" |
| 8 | `connecting` / `reconnecting` | `connecting`, or `idle` during the sidebar 1.5 s grace window |
| 9 | idle / disconnected | `idle` — "Ready" (background sidebar row) or `disconnected` |

Work reported by the server always outranks a transient connection state, so a
WebSocket reconnect never masks an agent that is still running. The sidebar variant
(`surface: 'sidebar'`) additionally treats a deliberately socket-less background row
as idle instead of disconnected.

### Offline shell and boot guard

`public/sw.js` precaches the app shell, so a navigation succeeds even with the server
down. A painted shell plus **Cretli server is unavailable** is a dead API hop,
not a webpack failure — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Bundles carry a `?v=<asset version>` query, therefore every cache fallback matches
with `ignoreSearch: true` — a strict match would miss after a version bump and hand the
cached HTML a broken `<script>`, leaving a shell with no JavaScript. `putInCache` keeps one
copy per `/dist/` path so version bumps do not pile up duplicates.

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

Implementation: `lib/sdk/sdk-run-auto-recovery.ts`, integrated in `lib/sdk/cursor-agent-sdk-ws.ts`.

## TODO tree execution

Children run in sibling order by default. A parent can explicitly opt into
parallel execution. Readiness and manual agent starts honor every ancestor's
sequence and plan approval gate. Parent statuses are derived bottom-up from
children; a parent becomes done only after all descendants are done. Reopening
a leaf, adding a child or moving unfinished work under a completed parent
reopens the affected ancestors. Parent status changes also advance their CAS
tokens. Reads repair legacy inconsistent statuses without rewriting the file.

### Review lessons

The review loop records structured findings in a server ledger, distils recurring
ones into per-workspace lessons and injects active lessons into implement/fix
(and, opt-in, plan-review and audit-review) prompts. Overview, safety
invariants, env flags and MCP tools: [review-lessons.md](review-lessons.md).

### Todo review status

Each todo carries a server-written `review` snapshot (per subject `code`/`plan`:
state, reviewers, independence, verify, freshness, human acceptance), recomputed
from delegation records by `lib/todo-review-sync.js` and read through
`lib/todo-review-read.js`. Agents and REST/MCP patches cannot set it; the badge
in the Todo panel is read-only. Contract, limits and the one-off rollout script
(`scripts/backfill-todo-review.js`): [todo-review-contract.md](todo-review-contract.md).

**Experimental: automatic leaf close (`CRETLI_TODO_LEAF_AUTO_CLOSE`, default off).** When set to `1`, a leaf in `doing` moves to `done` after a fresh code-review PASS with satisfied verify (`review.code.state = passed`), unless it awaits integration or is worktree-backed (execution mode `worktree` or a live worktree record on the leaf or an ancestor), has an active implement/fix, or a slot is `cancel_unconfirmed`. The check and the write run under the todos write lock. An unreadable worktree registry refuses the close (`worktree_registry_unreadable`). Contract annex: `docs/todo-review-contract.md` §12.4; with the flag off nothing changes.

## Workspace Watcher

One deterministic guard per workspace (normalized folder key) that keeps an eye
on todos, chats and delegations and, when autopilot is enabled, starts the next
agent. It is the hybrid from the design note: a cheap server-side watcher (no
LLM) plus a short-lived LLM orchestrator started only when a cycle is needed.

- **Modes**: `off` (nothing), `observe` (snapshot + one "idle, there is work"
  push per episode), `autopilot` (starts cycles). Default **off**,
  `maxParallel` **1**. `off` is a true no-op: a missing row is a read-only `off`
  default and the tick never writes.
- **Snapshot** (`lib/workspace-watcher.js`): ready todo leaves, active chats
  (busy/waiting via `probeChatRunLiveness`) and delegations, including a
  terminal delegation whose unconfirmed stop (`runStoppingAt`) still holds a
  parent slot. The busy set is the union of live chats and delegation slots, so
  a delegation without a child chat still counts exactly once.
  It also reports doing and blocked todo ids, chats waiting for input, and
  the latest delegation errors in that workspace. The current cycles and their
  delegated chats are excluded from occupancy; unknown chat liveness blocks
  a new cycle until the adapter can confirm its state.
- **Triggers**: todo creation/status/plan approval, delegation transitions and
  chat presence changes schedule one debounced pass per normalized workspace
  (1.5 seconds). The runtime worker heartbeat is the fallback (5 seconds by
  default). Shutdown removes pending timers and unregisters the runner.
- **Decision** (`decideWorkspaceWatcherAction`): pure. `observe` returns
  `observe_ready`; `autopilot` applies `lib/workspace-watcher-guardrails.js`
  and returns `start_cycle`, a plan gate (`plan_gate`) or a wait
  (`wait_active`, `wait_cooldown`, `wait_budget`, `backoff`,
  `wait_quiet_hours`, `wait_same_findings`, `wait_plan_approval`).
- **Guardrails** (pure, clock-injected): per-UTC-day cycle budget
  (`cycles.day`/`count`, reset at midnight UTC), cooldown since `lastCycleAt`,
  exponential backoff from the accumulated failures capped by
  `backoffCapMs`, UTC quiet hours (HH:MM, wraps midnight), a consecutive
  same-findings stop, and the `allowedHarnesses` filter plus real usage-limit
  awareness (`listHarnessUsageLimits`).
- **Cycle** (`lib/workspace-watcher-cycle.js`): the durable identity
  (`cycleId` + reserved `chatId`, appended to `activeCycles`, slot 0 mirrored to
  `activeCycle` for v1 readers) is written **before** the
  adapter is asked to start, and the same `cycleId` is the chat-run
  `requestId`, so a restart replays instead of duplicating. The ready todo is
  claimed with a CAS (`ready` → `doing` + `claimedByChatId`, never overwriting
  `doing`/`done`). One cycle = one chat run, and a row drives up to
  `policy.maxParallel` of them (hard cap 10): a start is refused
  (`cycle_active`) only once `activeCycles.length >= maxParallel`, re-checked
  inside the write lock. A start failure rolls that slot back, releases the
  claim, bumps `failures[todoId]` and arms the backoff. Every slot is
  authorized by its own `chatId`; the row-level `orchestratorChatId` is only the
  idle "last known" owner. The orchestrator prompt follows
  the `cretli-multi-harness` skill: `model_pick` + `delegation_start`
  implement/review, a cheap implement-role model or an explicit
  `policy.orchestrator` override, and **no** commit/push/merge.
- **Todo claims**: all todo writers and watcher transactions share one
  reentrant cross-process file lock. Claims verify a ready leaf and its CAS
  revision inside that lock and record `claimedAt` / `claimLeaseUntil`
  (30-second default TTL, configurable via `claim_next` `ttl_ms`). A live or
  unknown chat, a reserved start, or an active child delegation keeps its
  claim even past the TTL. Confirmed abandoned work returns to ready; done
  clears claim metadata without reopening the task. A real status change
  advances the CAS token; link-only bookkeeping preserves it.
  Selection prefers a compatible assignee, sibling index, then the oldest
  update. Failure-ceiling blockers are stored as `blockedReason` plus a
  changelog entry, not a fifth status; a manual status update clears them.
- **Plan gate**: `requirePlanApproval` never auto-approves. The first time an
  unapproved todo is picked the watcher starts a plan-only cycle and records
  `planRequests[todoId]`. Every later tick waits for a human (`wait_plan_approval`)
  until the plan is approved or the operator clears the request, so plan cycles
  cannot loop. If a planning run ends without a draft, it counts as a failure,
  clears that request and retries under the backoff and failure ceiling.
- **Memory** (`lib/persist/workspace-memory-persist.js`): a durable per-workspace
  fact store at `data/workspace-memory/<workspaceKey>.json` (keyed by
  `workspaceKeyFromCwd`, the todo identity). Five types — `decision`, `pattern`,
  `finding`, `blocker`, `context` — with optional `ttl_ms` expiry hidden lazily
  on read, a 500-entry bound (least recently updated evicted) and CAS + shared
  file lock so parallel cycles lose no writes. A write upserts on `type` +
  normalized `key`, and recognized transient blocker keys default to a 24 h TTL
  unless `permanent: true`. The cycle prompt gets a capped (3000-character)
  `WORKSPACE MEMORY` section and the orchestrator is told to record only durable
  facts it cannot re-read from the todo; `wmem_add/list/delete` are the MCP
  surface (the read tool is what a Scout scan uses to skip already-explored
  areas).
- **Restart/reconcile**: on boot (`lib/delegation-runtime-boot.js`) and each
  heartbeat, every dead entry in `activeCycles` is cleared independently (its
  failure and backoff recorded), a live sibling keeps its slot, its todo claim
  and the single shared row lease, and stale todo claims whose owning chat is
  confirmed gone are released.
- **Runtime**: the delegation runtime worker drives the observe heartbeat and
  the async autopilot pass; both are best-effort and never rethrow into the
  worker.
- **Control**: REST routes (`lib/routes/workspace-watcher-routes.js`: `GET/PATCH
  /api/workspace-watcher`, `GET /api/workspace-watcher/decisions`, and the
  `pause` / `resume` / `clear-stop` action endpoints), the
  `watcher_show` / `watcher_update` MCP tools and Settings →
  Workspace Watcher, all through `lib/workspace-watcher-control.js`.
- **UI**: the Todo tab top bar and "Why?" decision log
  (`app_front/features/watcher/watcherPanel.js`), the per-workspace policy editor
  (`app_front/features/settings/workspaceWatcherSettings.js`), and the sidebar
  autopilot badge. Live updates reuse the existing chat-list WebSocket: watcher
  writes fan out a `chatsChanged` with `reason: 'workspace-watcher'` and the
  coalesced `agentPresence` frame carries a compact per-workspace watcher summary
  (`lib/workspace-watcher-live.js`, `lib/agent-presence-bus.js`), so no extra
  socket is opened. Todo rows show a "claimed by chat" / "queued" badge from the
  claim fields.

## Child process lifecycle

The server is a process parent for more than OpenCode. `lib/child-process-registry.js`
is the single ownership registry for every long-lived child it must not leak
(`data/child-processes.json`), mirroring the OpenCode ownership registry:

- **Runtime registration.** `trackChildProcess(ptyOrChild, { type, label })` records
  `{ pid, type, label, startedAt, owner server pid/start/token }` and releases the
  entry on exit. `installChildProcessSpawnTracking()` wraps `child_process.spawn`
  so harness CLI and long-lived tool-shell (`bash -lc`) children are written to the
  registry immediately; a debounced descendant scan runs right after each new entry.
  `startChildProcessDiscovery()` (every 20 s, plus once at boot) still adopts any
  classified **descendants** the SDK spawned without going through a tracked site.
- **Graceful shutdown.** Phase 1 `beginChildProcessShutdown()` synchronously
  SIGTERMs each registered process group once and is idempotent; phase 2
  `finishChildProcessShutdown()` waits, escalates survivors to SIGKILL, confirms
  exit and drops the registry entries. Both run inside
  `shutdownDelegationAndExit` between the OpenCode phases and the browser teardown.
- **`SIGKILL` / earlyoom.** Nothing runs in the dying process, so the next start
  calls `reconcileChildProcessRegistry()`, which kills only entries whose owner
  server is dead and whose recorded `/proc/<pid>/stat` start time still matches
  (a recycled PID is never signalled). The sweep is bounded by
  `CHILD_PROCESS_SWEEP_TOTAL_BUDGET_MS` so boot does not stall on many orphans.
- **Never touched.** Chromium is owned by `browserManager`, `opencode serve` by
  `opencode-server-manager`, and the deliberately detached restart helper
  (`scripts/restart-server-helper.js`) is excluded by `isRestartHelperCmdline`. The
  sweep only ever signals PIDs present in the registry file, never a process the
  user started independently.

**Why this mechanism.** `PR_SET_PDEATHSIG` needs a native addon or a per-child
wrapper (more memory per harness), and a cgroup/systemd supervisor needs host
configuration outside the repository. The ownership registry plus a synchronous
first-phase group kill and a startup sweep needs no new infrastructure, reuses
the proven OpenCode lifecycle and is the only option that also covers a
`SIGKILL`ed server once it is restarted; the harness CLI children whose PID the
SDK hides are adopted by periodic descendant discovery.

### Spawn inventory

`Survives?` is about the parent dying by `SIGKILL` (a graceful shutdown signals
the registry). “PTY” children are session leaders; closing the PTY master sends
`SIGHUP`, but a harness that ignores it or detaches grandchildren can leak.
On Linux, a plain `spawn` with piped stdio also survives (`stdin: 'ignore'`
leaks even on stdin EOF) — verified 2026-10-09 with a Node child reparented to a
subreaper. `node-pty` could not be exercised in that sandbox (`forkpty(3)`
denied), so PTY rows are reasoned, not observed.

| Spawn site | Type | Survives `SIGKILL`? | Mechanism |
|-----------|------|---------------------|-----------|
| `lib/ws/pty-ws-handler.ts` `pty.spawn` | terminal / agent PTY | SIGHUP normally; can survive if ignored | `trackChildProcess` registry, phase 1/2, startup sweep |
| `lib/ws/task-ws-handler.ts` `pty.spawn` (shell and exec) | task run | as above | registry |
| `lib/dev-build.js` `pty.spawn` | front-build watch | as above | registry |
| `lib/mcp/mcp-runtime.js` `StdioClientTransport` | MCP stdio bridge | usually stdin EOF, not guaranteed | `registerChildProcess` + `closeTransport`, phase 1/2, sweep |
| `lib/sdk/sdk-review-verify.ts` `spawn(process.execPath, [test])` | review-verify test runner | **yes** (`stdin: 'ignore'`) | `trackChildProcess`, phase 1/2, sweep |
| `lib/{claude,codex,deepseek,qwen,codebuddy}/…-agent-ws.js` + `lib/sdk/cursor-agent-sdk-ws.ts` SDK CLI children | harness CLI | library-dependent; pipe EOF usually, can linger | periodic descendant discovery, phase 1/2, sweep |
| `lib/chat-title-plan-runners.js`, `lib/fork-title.js`, `lib/codex/codex-device-login.ts`, `harnesses/codebuddy/codebuddy-models.js`, `lib/codex/codex-models-refresh.ts`, `lib/harness-versions.js` | one-shot harness helper CLI | short-lived | descendant discovery |
| `harnesses/opencode/opencode-server-manager.js` `spawn(..., { detached: true })` | `opencode serve` (+ its group) | yes | OpenCode ownership registry, `begin/finishOpenCodeShutdown`, OpenCode startup sweep |
| `lib/browser/session-manager.js` (Playwright) | Chromium | yes | `browserManager.closeAll` + `startupSweep` |
| `lib/agent-harness/tool-executor.ts` (`bash -lc`; `rg` stays transient) | tool shell | can outlive a prompt | spawn hook + `trackChildProcess`, phase 1/2, sweep |
| `lib/self-update.js` `spawn('bash', [script])` | self-update | yes, and must finish | intentionally not registered |
| `lib/routes/dev-actions-routes.js` `spawn(helper, { detached: true })` | restart helper | yes, by design | never registered; excluded by `isRestartHelperCmdline` |
| `spawnSync` / `execFileSync` helpers (`git-cli`, `secret-scan`, `workspace-scout-git`, `worktree/git-worktree`, `delegation-metrics`, `github-token`, `sdk-history-isolation-probe`, …) | one-shot synchronous | no (done before the call returns) | not needed |

`killChildProcessTree` reuses `killProcessTree`/`createProcessProbes`
from `lib/process-probes.js` (shared with the OpenCode port registry) and adds a recursive descendant
walk, so a child that shares the server's process group (MCP stdio, review-verify)
cannot leak its grandchildren. `scripts/task-restart-server.sh` keeps a 5 s
window above the combined escalation budget
(`OPENCODE_SHUTDOWN_TOTAL_MS + CHILD_PROCESS_SHUTDOWN_TOTAL_MS`).

## Target architecture program (proposed)

A cross-domain audit, a proposed ADR (status `proposed`, not accepted), the
vertical DAG with an ownership matrix against the storage and recovery programs, and a
pinned baseline live in `docs/`:
[architecture-system-map.md](architecture-system-map.md),
[architecture-target-adr.md](architecture-target-adr.md),
[architecture-vertical-dag.md](architecture-vertical-dag.md),
[architecture-baseline.md](architecture-baseline.md). They describe the current code
and do not change it; the storage and recovery contracts referenced from them stay
authoritative.

## Known limitations

- Single-password auth, no multi-user/RBAC.
- SDK rooms remain in-process; Redis pub-sub mirrors live WS broadcast and registry tracks
  the **owner** instance. Non-owner nodes serve read-only **remote stubs** until failover.
  Agent runs require sticky routing to the owner (or claim after lease TTL). See
  `docs/MULTI-INSTANCE.md`.
- No rate limiting on streams; no CSP header (SPA uses inline scripts/styles).
- `server.js` is the composition root (workspace, widget auth, and HTTP
  routes live in `lib/`). `app_front/chat.js` / `app.scss` are still larger than
  ideal.
  Splitting them is tracked in `docs/MODERNIZATION_PLAN.md` (phases 1–2).

### Delegation controller

`lib/delegation-control.js` exposes `delegationController(row)` (`controllerChatId`, falling back to the historical `parentChatId`) and `canChatControlDelegation`. Control decisions go through it; see `docs/delegation-tree-controls.md`.

### MCP `delegation_list` size (compact DTO v2)

`delegation_list` defaults to a compact row DTO (`dto_version: 2`) that omits
verify `outputTail`, `results` and `dataDir`; `detail: "full"` restores the
legacy v1 rows and `delegation_show` returns the full verify record and paginated
structured report strings. Measured in `tests/delegation-list-compact.test.js` on 30
synthetic review delegations with failed verify logs (12 failing tests each,
2 KB per-test tails): the entire MCP response is 54,537 bytes compact vs
913,632 bytes in the legacy shape (−94.0 %); the test asserts
≤ 64 KiB and ≥ 80 % reduction. This is a test criterion, not an API limit.
Details: [delegation-workflow-per-leaf.md](delegation-workflow-per-leaf.md).
