# MCP setup

Workspace Docs provides four read-only builtins: `doc_list`, `doc_read`,
`doc_search`, `doc_backlinks`. They use the calling session's workspace;
workspace selectors are not tool arguments. External roots require human consent
and `agentRead`. `doc_read` includes managed links and mentions;
`doc_backlinks` accepts a note `path` or a `target` (`todo|initiative|decision:uuid`)
for reverse lookup, retaining dangling links. Direct link mutations are human-only REST.

Agent tools `doc_propose_write`, `doc_propose_append` and `doc_propose_link` create
human-only decision cards; they never write notes or managed links. Review the
diff in Docs and explicitly apply or reject it. Workspace/chat come from MCP
session claims; external consent and `agentRead` remain required. Payloads are
limited to 128 KiB including metadata. Changes to the base note or link revision
invalidate approval. Proposals cannot be auto-approved or created through
`decision_request`. See [Docs proposals](../docs-module.md#agent-proposals-and-human-approval).
Third-party MCP tools that write the same directory are independent of this
gate; restrict their per-tool permissions if you require all writes to be reviewed.

Configure MCP servers in Cretli (**Settings → MCP**). You do not need to paste
the same `npx` block into each harness config file.

The managed bridge always loads Cretli's builtin tools independently of external
integrations. External catalogs load concurrently with a two-second initial
budget; offline servers appear as errors in Settings and cannot remove tools
such as `chrome_tools` or `chrome_call`. Slow integrations continue connecting
in the background. The stdio bridge checks for late tools for up to 30 seconds
and sends `notifications/tools/list_changed` when its catalog changes. A failed
core catalog or authorization check remains an explicit JSON-RPC error.

## What this version supports

- Transports: **stdio** (command + argument list, no shell string) and **Streamable HTTP** (URL + headers).
- Scope: all workspaces or selected workspace ids (registry id / `.code-workspace` path / folder workspace id).
- Harnesses: Cursor SDK, Codex, OpenCode, Qwen, CodeBuddy, DeepSeek, OpenRouter. An empty harness list means the external server is not attached to any chat. Builtin Cretli tools (`chat_show`, `todo_list`, `delegation_start`, …) are injected for every harness. A sub-chat on another harness uses `harness_list` + `model_list(enabled_only=true)` + `delegation_start`; Cursor `Task` is not that catalog.
- Plan mode: unknown external tools stay blocked unless **Allow in Plan** lists the exact tool name on that server. Builtin Cretli reads (`chat_list`, `chat_show`, `chat_history`, `chat_event`, `todo_list`, `chat_plan_show`, `delegation_inbox`, catalogs, …) stay allowed; writes (`todo_create`, `todo_update`, `delegation_start`, `delegation_cancel`, `delegation_reply`, chat archive/rename/delete) need Agent. Three writes are open by name in every mode, including Scout, because each only adds one record: `cretli_feedback` (a report), `decision_request` (a decision card) and `voice_reply` (a short spoken summary appended to the calling chat's own history; the browser reads it aloud in the `agent` read mode, see `docs/ARCHITECTURE.md` Voice layer). An external tool named `chat_show` does not inherit builtin read rights.
- Browser: `browser_*` drives the built-in Browser panel (server-side Chromium) for the calling chat. The call acts for the login session that has the chat open (a delegated child uses its parent's); a run with no UI attached — Watcher/autopilot, a delegation, or a chat after a restart — uses a reserved system owner with its own Chromium context that is not shown in the panel. An external client in `operator` mode has no chat and uses the same system owner (one shared system session per workspace, audited like every other `/mcp` tool call; not shown in the user's Browser panel, no user cookies); `plan`/`agent` external clients stay denied (`OUT_OF_SCOPE`). A widget-only chat without a Cretli login session stays denied, and standalone stdio has no Browser runtime at all. `browser_sessions` / `browser_tabs` / `browser_screenshot` / `browser_dom` / `browser_elements` / `browser_console` / `browser_network` are reads; `browser_open` / `browser_navigate` / `browser_input` need Agent mode and are denied to review children. `browser_screenshot` returns a temp file path (image in CSS pixels, so it lines up with click coordinates), and `browser_elements` lists visible controls including inside Lit shadow roots (each row has an `index`); `browser_input` acts on them by `selector`, `role`(+`name`), `text`, `label` or `placeholder`, with `nth`/`index` selecting one match, and its kinds are `pointer|scroll|key|click|fill|resize|select|check|uncheck|hover|drag|upload|wait` (`upload` reads server-side paths only inside the workspace root; `wait` is bounded and never evaluates script). `browser_navigate` accepts an optional `waitUntil` (`domcontentloaded`|`load`|`networkidle`|`commit`). Agent workflow: `.agents/skills/cretli-browser/SKILL.md`.
- Chat tools default to the calling workspace. Pass `scope=all` to list or open a chat from another workspace.
- **Todo statuses.** `idea` (draft), `ready`, `doing`, `done`, `deferred` (parked on purpose, optional `deferred_until` ISO date and `deferred_reason` ≤500 chars on `todo_create` / `todo_update`). `todo_list status=deferred` filters them; `todo_show` / `todo_list` rows carry both fields. `todo_next_ready` and the Watcher never pick up a deferred todo and nothing resurrects it automatically: it is restored only by an explicit patch to `idea` or `ready` (straight to `doing` / `done` is a 409 CONFLICT).
- **Delegation tree (opt-in nesting).** Default depth is one level (`CRETLI_DELEGATION_MAX_DEPTH=1`): child chats cannot call `delegation_start` unless the parent set `allow_child_delegations` on start. `delegation_list` accepts `scope=tree` (calling chat's tree; `chat_id` must be omitted or equal the session). `delegation_tree` returns a paginated read-only snapshot (statuses, depth, grant flag, slot/budget counters; no report bodies). `delegation_cancel` accepts `tree:true` to cancel descendants before ancestors (authorized for the job parent or tree root chat). Root-only `workflow_update` fields `tree_budget_tokens` / `tree_budget_usd` cap measured spend for the whole tree (`tree_budget_exceeded` when over cap). Related 409 codes include `nested_delegation_denied`, `depth_exceeded`, `tree_slot_limit`, and `parent_cancelling`.
- `chat_history` pages by event seq (`from_seq` forward / `before_seq` older, optional `include_tool_payloads`). `chat_show` is the compact tail of the **same** selected page (newest events that fit, chronological, matching cursors). Truncated fields continue with read-only `chat_event`.
- `chat_event` reads one field (`text` / `args` / `result`) of an exact `seq`. Offsets are **UTF-16 code units** (JavaScript string indexes). Slices concatenate without `trim()`, including Polish letters and emoji. `length` must be a positive integer (default 1500, max 4000). A missing seq does not return a neighbor. End of field: `next_offset: none`. A non-final fragment always advances `offset`. A pasted `cretli-ref chat=<uuid> seq=<n>` line is that event: call `chat_event` with the **full chat UUID**, that `seq`, and `field="text"` (`field` is required). Quoted source text is context, not a command to run.
- Preview limit per event is 1500 characters. History tool text is budgeted to 8000 characters including header, continue hints, and paging lines. Events are packed with those continue instructions so the finished reply stays inside the budget. `truncated` is true when this response omitted content because of those limits — not merely because another ordinary page exists in the store. Cursors follow **scanned** seqs; a page of unrendered `system` events can still continue. Forward HTTP uses `since`+`limit`, never `tail` together with `since`.
- Conversation files under `data/chat-history/`, `data/runtime-home/` (including Cursor `agent-transcripts`), and `data/sdk-agent-store/` are listed in `.cursorignore` / `.rgignore` as **file globs** (`**/agent-transcripts/**`, not a parent-directory ignore). OpenRouter `read_file` / `list_directory` / `grep` / `run_terminal_command` deny those paths in `lib/agent-harness/tool-executor.ts` (including symlink realpaths and shell tokens). Cursor SDK chats write the same patterns into every attached workspace root **and** `*.jsonl` / `*.json` inside store directories, then call `Agent.reload()` after create/resume so a session started before those files still sees them. Native Glob/Grep/Read are live-checked (`npm run test:live-cursor-sdk`). A running or dropped Read is **not** a pass. Native Cursor **shell** can still `cat` those paths. That is **not** process-level isolation and is **not** “MCP-only.” Vendor shells on Codex, Qwen, CodeBuddy, DeepSeek, and OpenCode can also open those paths. Load history through Cretli MCP (`chat_show` / `chat_history` / `chat_event`), including `scope=all` when you mean another workspace. Missing SDK or API key skips the live test; `CRETLI_LIVE_CURSOR_SDK=1` treats skip as failure.
- Access log: every tool call to an external server (not the built-in Cretli tools) is appended to `data/mcp-access.jsonl` (rotated at 2 MiB, one generation kept) with time, server, tool, chat id, harness, mode, outcome and duration. Arguments and results are never stored and secret values are masked in error text. Read it in Settings → MCP → **Access log** or `GET /api/mcp/access-log?serverId=&limit=`. External `/mcp` clients keep their own audit file (`mcp-external-audit.jsonl`).
- Secrets: stored in `data/mcp-secrets.json`. The API never returns the value; an omitted field keeps the secret, an explicit clear removes it. A `409` revision conflict does not change secrets or the registry.
- Execution: SDK-style harnesses (Cursor, Codex, OpenCode, Qwen, CodeBuddy, DeepSeek) call tools through a managed stdio bridge. OpenRouter calls `lib/mcp/mcp-runtime.js` directly. Policy is re-checked at execution, not only when the catalog was filtered.
- Tool list refresh: an open chat keeps the tool list it fetched until it is re-listed, so a server that gained tools or fields (for example after a deploy of the app behind it) looks unchanged and its new arguments fail validation. **Settings → MCP → Refresh tools**, `POST /api/mcp/servers/:id/refresh` (same auth as `/test`; returns `{ ok, tools, changed }`) and the builtin `mcp_refresh` tool (`server` = id or name; omitted = every enabled external server in the chat's scope; Agent mode, no approval, no secrets) drop the cached lists of that server for all chats and close its pooled connections; config, revision and secrets stay untouched. `mcp_test` / Test connection is diagnostic and never does this. Delivery: after `mcp_refresh` the managed bridge re-lists and sends `notifications/tools/list_changed` when the list differs; a harness that honours it re-reads `tools/list` at once, any other sees the new schema on its next `tools/list` (usually the next turn) or in a new chat. The tool result carries a `hint` saying so, and Cretli cannot force a client that caches its tool list for the whole session. A refresh triggered from Settings does not push a notification to running bridges; they pick up the fresh list at their next `tools/list`.
- OpenCode: MCP is instance-wide in the vendor runtime, so Cretli starts a separate OpenCode instance per chat session when a session key is present. A unique MCP name on a shared instance is not used as isolation.

- **OAuth login.** Two flavours, both through the **Log in** button on the server card (Settings → MCP):
  - *HTTP servers that speak MCP OAuth* (discovery, dynamic client registration, PKCE) log in without any configuration; the SDK stores and refreshes the tokens in the secret store.
  - *stdio servers that read a refresh token from an environment variable* (Gmail, Sheets, Ads, Analytics, Search Console, or any OAuth 2.0 provider) use an `oauth` block on the server: pick a preset in the form, or write it in `data/mcp.json`: `{ "preset": "google-gmail", "loginHint": "name@example.com" }`, or fully custom `{ authorizationUrl, tokenUrl, scopes, clientIdKey, clientSecretKey, refreshTokenKey, pkce, extraAuthParams }` (https only; loopback http for development). The client ID and secret are ordinary secrets (the form has fields for them); the refresh token is written into the secret named by `refreshTokenKey` and is passed to the process under that name, so the server needs no change. The redirect goes to `/api/mcp/oauth/callback` when Cretli is opened over https or on loopback. Otherwise (a plain-http LAN address, which Google rejects) or when you press **Log in (paste URL)**, the login uses a loopback redirect (`http://localhost:49321/oauth2callback`, valid for Google *Desktop* clients): the window ends on a page that does not load, you paste its address into the card and Cretli finishes the exchange (`POST /api/mcp/servers/:id/oauth/complete`). Nothing is stored when the login is unusable: a different account than `loginHint`, no refresh token (Google issues one only on consent; revoke the app at myaccount.google.com/permissions and retry), or not every scope granted. The authorized account (from the ID token) is shown on the card. Log out forgets the refresh token (it does not revoke it at the provider).
  - Google: an OAuth client of type *Desktop app* accepts the loopback redirect of the manual flow (it works from any device); the automatic callback needs a *Web application* client with the Cretli callback URL (`https://<your-cretli>/api/mcp/oauth/callback`) listed as an authorized redirect URI. While the consent screen is in *Testing*, the account must be a test user and the refresh token expires after 7 days; publish the app (or use a Workspace-internal app) for a lasting token.

Out of scope: a server marketplace and importing private IDE MCP configs.

## HTTPS certificate for external clients

When installing an external client's configuration from Settings, choose the local
stdio bridge to use **Trust the Cretli HTTPS certificate** (checked by default for
HTTPS). The installer adds `CRETLI_MCP_CA_FILE` to the bridge's environment in
Claude Code, Cursor, or Codex configuration. It references `SSL_CERT_PATH` when
configured, otherwise Cretli's `data/cert.pem`, and refuses a missing or invalid
certificate before writing the configuration. TLS verification remains enabled.

The path refers to a local file on the Cretli server. As with the bridge script,
it must be accessible to the MCP client; installations on another machine need
a copy of the public certificate and an updated path. Direct HTTP transport does
not use the bridge's `CRETLI_MCP_CA_FILE` variable.

## Workspace registry tools

Builtin tools that let an agent register a project in the workspace picker
without calling the REST API (the registry lives in the SQL workspaces store,
`data/workspaces.sqlite`):

- `wsreg_list` (read): registry rows with id, kind (`folders` = Cretli folder
  workspace, `file` = `.code-workspace`), label, route key, enabled folders and
  the active flag.
- `wsreg_add` (Agent): `path` must be absolute (no `~`, no relative paths), e.g.
  `{ "path": "/home/me/my-app", "label": "My app" }`. A directory becomes a
  folder workspace even when it contains a `.code-workspace` file, unless
  `prefer_folder: false`. A `.code-workspace` file is **imported once**: its
  folders are copied into a new Cretli workspace and the file is never read again
  (`imported_from` keeps its path as metadata). Re-adding a registered path or an
  already imported file returns the existing row with `created: false`;
  `allow_duplicate: true` imports the file again as a separate workspace. The
  active workspace is never switched.
- `wsreg_remove` (Agent): `{ "id": "<id from wsreg_list>", "confirm": true }`
  (any id the workspace was known by, including its UUID or a former
  `.code-workspace` path, resolves)
  removes the registry row, its sidebar overlay and route keys; no file or folder
  is deleted. The active workspace is refused unless `force_active: true`, which
  makes the next row active.

The writes are denied in Plan/Ask mode and in Scout scans like every other
mutating builtin tool.

## Files

| Path | Role |
|------|------|
| `data/mcp.json` | Registry (`schemaVersion`, `revision`, `servers`) |
| `data/mcp-secrets.json` | Secret values (mode 600 when the filesystem allows) |
| `data/mcp-tx.json` | Short-lived write journal; completed or rolled forward after a crash |
| `scripts/cretli-mcp.js` | Builtin Cretli MCP (password login or `CRETLI_MCP_TOKEN` bridge) |

A damaged `mcp.json` is reported as an error. Cretli does not replace it with an empty registry.

## Manual builtin server (optional)

For a host you run yourself (not a Cretli chat):

```json
{
  "mcp": {
    "cretli": {
      "type": "local",
      "command": ["node", "/path/to/cretli/scripts/cretli-mcp.js"],
      "environment": {
        "CRETLI_URL": "https://127.0.0.1:3011",
        "CRETLI_CLI_PASSWORD": "your-password",
        "CRETLI_MCP_WORKSPACE": "/path/to/your-project",
        "CRETLI_MCP_MODE": "plan"
      }
    }
  }
}
```

Chat sessions started from Cretli get a managed bridge with `CRETLI_MCP_TOKEN` instead of the login password. Standalone stdio must set `CRETLI_MCP_WORKSPACE` (it does not fall back to the UI global folder). Set `CRETLI_MCP_MODE=agent` for writes (`todo_create`, delegations, chat archive/delete); `plan` or an unset mode blocks those mutations on the stdio process itself. Catalogs (`model_list`, harnesses, tasks) are loaded from the target Cretli server. `model_list` requires a known harness id (`sdk`, `opencode`, …); a typo does not fall back to Cursor. Long `todo_show` / `chat_plan_show` / `delegation_show` bodies return `truncated` plus `next_cursor` bound to the current revision (delegation report/plan cursors hash field content). The token is bound to the session; Plan vs Agent is read from the live room on each call, so a token minted in Agent does not keep write access after you switch back to Plan. Tokens expire and are rejected after the session room is disposed or the process restarts until the harness remints.

## Local test server

`scripts/mcp-test-server.js` is a tiny stdio MCP (`ping_read`, `write_note`). In **Settings → MCP** add:

- Command: `node`
- Arguments: the absolute path to `scripts/mcp-test-server.js` in this repo
- Allow in Plan: `ping_read`

`write_note` stays blocked in Plan. **Test connection** should list both tools. New chats pick the server up on the next prompt.

## File isolation vs native Cursor SDK

OpenRouter `read_file` / `list_directory` / `grep` / `run_terminal_command` are covered by unit tests (relative, absolute, symlink, extra workspace, and shell tokens). `rg --ignore-file .cursorignore` is not the Cursor SDK.

Native Cursor Glob / Grep / Read / shell / `Agent.resume` is an explicit live test:

```bash
npm run test:live-cursor-sdk
```

It uses isolated temp workspaces (not your `data/` chats), plants `FOREIGN_DELEGATION_MARKER` in transcript stores, and requires **completed** native `tool_call` events plus a successful Read of the hello file **contents** (a basename, a denied Read, a still-running call, or a missing marker is not a pass). File-tool attempts are separate Glob/Grep/Read turns. The Ask fork goes through the production persist path in a child process whose data dir is set **before** persist loads (two chats, newer foreign transcript, full and partial copy). A third session does real work **before** ignore files exist, then ignore + `reload` + `Agent.resume`. Missing `@cursor/sdk` or `CURSOR_API_KEY` prints `SKIPPED` and exits 0 unless `CRETLI_LIVE_CURSOR_SDK=1` is set (then skip is exit 2). Unfinished required Reads keep the live test at exit 1.

Verified on `@cursor/sdk` **1.0.30** (create + real `Agent.resume` + late-ignore after a hello warmup):

| Attempt | Result |
|---|---|
| Glob workspace root | completed; `hello.txt` listed; transcript jsonl **not** listed |
| Glob explicit transcript directory | completed; `files: []` |
| Grep of `FOREIGN_DELEGATION_MARKER` | completed; 0 matches |
| Glob second workspace | completed; `hello.txt` only |
| Read `hello.txt` in both roots | completed; distinct contents `ask-dropdown-hello-a-ok` / `ask-dropdown-hello-b-ok` |
| Read absolute transcript / symlink / extra-workspace jsonl | tool **invoked**, run **finished**, **no** `completed` result, **no** marker leak |
| Native shell `cat` of the transcript path | **leaks** the marker |
| Production Ask fork | parent kept; child `forkParentChatId` matches; partial copy stops before the later Ask turn; SDK reply stayed on the Ask send-bar task |

`local.sandboxOptions.enabled` is not used: this environment rejects it (`sandboxing is not supported`). Ignore files are not a process sandbox. Cursor SDK **drops** the `completed` event for native Read of an ignored jsonl (and a symlink whose realpath is in a store). That is a vendor limitation, not a Cretli executor denial and not a pass. Do not treat “no marker” as isolation-complete.

### Harness matrix (honest)

| Harness | File read / search | Shell | Resume | Mechanism |
|---|---|---|---|---|
| Cursor SDK | Live Glob/Grep hide stores; ignored native Read starts then drops `completed` (not a pass) | Native shell can still `cat` store paths | `Agent.resume` with the same local options, then reload | File-glob ignore on every root + inside store dirs, 1s scan TTL, reload |
| OpenRouter | Denied in `executeTool` | Denied when the command names a store path (token heuristic, not a jail) | Stateless tools; re-check every call | `history-store-guard.js` |
| Codex | Vendor native tools | Vendor shell can open store paths | Vendor thread resume | Ignore files only if Codex honors them; **not live-verified** |
| Qwen | Vendor native tools | Vendor shell can open store paths | Vendor session | Same; **not live-verified** |
| CodeBuddy | Vendor native tools | Vendor shell can open store paths | Vendor session | Same; **not live-verified** |
| DeepSeek | Vendor native tools | Vendor shell can open store paths | Vendor session | Same; **not live-verified** |
| OpenCode | Vendor native tools | Vendor bash can open store paths | Per-chat OpenCode instance | Same; **not live-verified** |

Do **not** read this table as “history is MCP-only.” MCP remains the supported way to load chats (`chat_show` / `chat_history` / `chat_event`, `scope=all` when intended). File-tool blocks and ignore files reduce accidental Glob/Read of transcripts. A shell on Cursor SDK and on vendor harnesses can still see `data/` when that directory is on the same filesystem.

## Diagnostics

**Test connection** in Settings lists tools and then closes a throwaway process. That does not mean an already open chat is connected. Status separates saved configuration, applied revision (after the harness accepted the config), and connection state. The next prompt applies the current revision; an in-flight reply is not interrupted.

### Fallback: call `/mcp` directly when the client lost the connection

A client sometimes starts without the Cretli tools (`ECONNREFUSED`, a port forward or the server was down at start) and cannot reconnect in that session, for example a server from `.mcp.json` in the Claude desktop app, where `/mcp` → Reconnect is not available. The endpoint is plain JSON-RPC over HTTP and, for external clients, stateless (no `Mcp-Session-Id`), so an agent with a shell can call the tools itself until the client is restarted:

1. Check the server: a request without a token must answer `401` (server up, auth required).
2. Take the URL and token from the client's own config (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`) or `CRETLI_MCP_TOKEN`; never paste the token into chat, todos or `cretli_feedback`.
3. Call `tools/list` or `tools/call`. Tool names have no client prefix (`todo_list`, not `mcp__cretli__todo_list`).

```bash
# Linux, macOS, WSL, Git Bash
curl -s -H "Authorization: Bearer $CRETLI_MCP_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  --cacert data/cert.pem -X POST https://HOST:PORT/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"todo_list","arguments":{}}}'
```

```powershell
# Windows PowerShell 7+
$h = @{ Authorization = "Bearer $env:CRETLI_MCP_TOKEN"; Accept = "application/json, text/event-stream" }
$b = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"todo_list","arguments":{}}}'
Invoke-RestMethod -Method Post -Uri https://HOST:PORT/mcp -Headers $h -ContentType application/json -Body $b -SkipCertificateCheck
```

`--cacert` points at the server's certificate (see the HTTPS section above); `-k` / `-SkipCertificateCheck` only for a local test. The same rate limit and token mode apply as for a connected client. This is a stopgap: restart the client session afterwards so the tools appear normally.

## External clients: operator mode

An external client token (Settings → MCP → external clients, endpoint `/mcp`) has one of three modes: `plan` (read-only tools), `agent` (the whole builtin catalog) or `operator`. `operator` is `agent` plus tools that act for the user who created the token, for example Claude Code supervising a long Todo run overnight:

- `operator_delegation_show { delegation_id | todo_id, cursor? }` — read only: role, executor, `raw_verdict` (what the reviewer wrote) next to `server_verdict` (the reviewer row recorded in `todo.review`), the report (paged via `next_cursor`) and parsed findings. Delegations of other workspaces are refused (`NOT_FOUND`). No writes.
- `operator_chat_status` / `operator_chat_wait` — run state of a chat in the client's workspace (`busy`, `waiting_for_input`, `run_id`); `wait` blocks up to 55 s until the chat is idle.
- `unclassified_errors` — read-only list of unclassified provider error signatures (redacted message, counts, ack state) with `last_context { chat_id, same_workspace }`; args `limit` (default 20, max 100), `since`, `include_acked`. Acknowledging is not available here.
- `operator_chat_send` — sends a user message and starts the chat's run, like typing in the UI. While the chat runs the message is queued in its mailbox (`status: queued`, `message_id`) and delivered at its next `delegation_wait` or when the run ends; `deliver: "start"` refuses with `recipient_busy` instead; a repeated `idempotency_key` never sends twice.
- `operator_chat_stop` — User Stop of the current run (no auto-resume).
- `operator_watcher_status` / `operator_watcher_reset` — compact Workspace Watcher state; reset (`confirm: true`) clears failure counts and the backoff timer only; per-todo blocked backoff is left untouched unless `all_blocked: true` (clear every entry) or `todo_ids` (clear only those) is passed — the two flags are mutually exclusive; the result has `before`/`after` `blocked_backoff`.
- `operator_watcher_pause` — pause (`paused: true`) or resume the Watcher (`confirm: true`); running cycles continue, no new cycle starts while paused.
- `operator_watcher_clear_stop` — clear the Watcher `stopReason` like "Clear stop" in Settings (`confirm: true`); a loop-guard stop also resets failures, backoff and parked todos.
- `operator_watcher_limits` — read (no `limits`) or change the Watcher throughput limits (`limits`: maxParallel 1-5, maxParallelWorktree/Project 0-5, maxCyclesPerDay, maxConsecutiveFailures, maxSameFindings, cooldownMs, backoffBaseMs, backoffCapMs; `confirm: true`, operator lease). Policy fields beyond the numbers go through `operator_watcher_policy`; mode and stop reason stay Settings-only.
- `operator_watcher_policy` — read (no `patch`) or patch whitelisted Watcher policy fields (`patch`, `confirm: true`, operator lease; sensitive fields need `reason`; result shows before/after).
- `operator_server_status` — read-only readiness probe (pid, uptime).
- `operator_todo_reserve` / `operator_todo_release` — hold a todo out of Watcher selection (default 4 h, max 24 h).
- `operator_scout_enable` — enable or disable all Workspace Watcher scouts for this workspace (`enabled`, `confirm: true`); profile and finding mutations are lease-protected.
- `operator_guide` — the full operator playbook (`docs/mcp/OPERATOR-PLAYBOOK.md`): monitoring loop, restarts and resuming, integrating worktree leaves, known traps, building todo trees. Every external client also gets short `instructions` in the MCP `initialize` result (common rules; operator clients additionally the operator loop and a pointer to `operator_guide`).
- `operator_watcher_release_unknown` — releases a `doing` todo whose executor liveness is unknown (e.g. a cycle killed by a restart) back to ready through the guarded release path, like "Release to ready" on the Todo card (`expected_updated_at`, `confirm: true`).
- `operator_settings_get` — list safe Settings sections or read one allowlisted section. Sensitive fields are redacted; secrets, auth, human gates and browser/network security settings are excluded. This tool is read-only.
- `operator_settings_set` — patch a REST-backed safe Settings section (`general`, `autoTitle`, `chatAutoArchive`, `debug` or `sdk`). Uses the same validation and save path as `PATCH /api/settings`; requires an operator lease, `confirm: true` and a non-empty `reason`. Fields outside the section or on the sensitive denylist are rejected. Writes are journaled with redacted before/after values.
- `operator_plan_approve` — approves a Todo plan like the Approve button: CAS on `expected_updated_at`, refused without a plan or while the plan review round is `pending`, and recorded in the todo changelog with the client name and persisted as `plan.approvedBy` (`{ kind: 'mcp-operator', clientId, clientName }`, also shown as `plan_approved_by` in `todo_show`); UI approvals leave it unset and agents cannot write it.
- `operator_scope_accept` — accepts the scope proposal a `needs_rescope` report left on a leaf (`watcher_report` `scope_request` `{ files, reason }`, stored as the `## Scope request` body section): the files are appended to `## Leaf scope`, the proposal is removed, the leaf's blocked backoff, blocked-reason streak and failure counter are cleared and a parked (`idea`) leaf becomes `ready`, so the next Watcher cycle resumes from the existing worktree diff (fix round). Optional `files` accepts a subset (the rest stays proposed) and `expected_updated_at` is a CAS token; recorded in the todo changelog with the client name. Refused with `NOT_FOUND` when no proposal is open. REST equivalent: `POST /api/todos/:id/scope-request/accept`.
- `operator_plan_review_start` — starts the plan review loop for a todo with a draft plan, like "Plan review" in the Todo panel: a fresh read-only coordinator chat gets the server-built refine prompt and starts the reviewers itself. External clients use it (or `todo_start`, or a ready leaf for the Watcher) instead of `reviewer_session` / `delegation_start`, which need a calling chat. An omitted `model` or `auto` selects the harness default (the Cursor default for `sdk`); the result reports the stored `model`, with an empty value denoting a non-SDK harness default. Preflight: before any chat is created the server counts the independent reviewers that qualify (the `model_pick` review path, `diverse`, i.e. one per enabled, ready, delegatable harness; the coordinator's own base model is the only coordinator-derived exclusion, its harness is not). With fewer than two the response is `{ todo_id, accepted: false, code: "insufficient_independent_reviewers", available, required, reviewers, blocked_reason }`, no coordinator is started, the todo's `blocked_reason` (`todo_show`) is set to `insufficient_independent_reviewers` and one Watcher `blocked` notification is pushed. `todo.review` is not touched (it stays server-written). The block is cleared by a successful start or the next todo `status` change; a refusal is not memoized under the `idempotency_key`.
- `operator_integrate_tree` — integrates a finished todo subtree with one agent chat, like "Integrate subtree with agent" in the Todo panel: the server queues the eligible leaves under `todo_id` in tree order (smart merge for live worktree results, verify for finished todos without one), takes the workspace integration lock, creates the `[Integrate]` chat and starts it. Nothing is pushed; the agent confirms each entry through the usual guarded path. A retry with the same `idempotency_key` returns the first result.
- `operator_integrate_status` — read-only state of the workspace's bulk integration batches (per-entry `mode`/`state`) and the current integration lock; `batch_id` narrows it to one batch.
- `operator_model_overrides` — `operation: list|create|revoke` for audited `prefer`, `exclude` and `explicit-orchestrator` records. Create takes `action`, `harness` and/or `model`, optional `role`, `scope: workspace|global`, nonempty `reason`, and `expires_at` (one minute to 30 days). Create/revoke require `if_match` from list and return the new ETag; workspace scope uses the token's workspace.
- `operator_model_profiles` — `operation: get|patch` for rotation `{band, mode}` and per-role `weights`. Patch requires `if_match` from get and uses the same validation as Settings. Hard gates cannot be patched here.
- `operator_favorites` — `operation: list|set` for Settings favorite model IDs per harness and optional `role: plan|implement|review|fix`. Set takes `harness`, `models` and `if_match` from list. A role list replaces the harness default for that role; omit `role` to edit the legacy harness-wide default. An explicit empty role list disables that role's favorites. Role lists are stored with Settings; catalog discovery and model resolution see their union, while `model_pick`, `model_list {role, enabled_only: true}`, Watcher selection and named delegation starts enforce the effective role list.
- `operator_model_stats` — read-only candidate diagnosis for `role: plan|implement|review|fix`: scores, tie-band membership, filter reasons, penalties, and 5h/7d plan-window pace when readings exist. It does not persist a pick.

**Rate limit:** each external client may make 60 tool calls per minute (sliding window); over it the request is refused. A busy operator client can raise it with `CRETLI_EXTERNAL_MCP_RATE_LIMIT=<calls per minute>` in the server environment (positive integer; restart to apply).

Operator tools are answered by `/mcp` itself (`lib/mcp/mcp-external-operator-tools.js`) and are not part of the builtin catalog, so chats, delegations, orchestrators and the Watcher inside Cretli never see them: for every agent Cretli runs, a plan is still approved only by a human.

## External clients: install into a folder

Settings → MCP → External clients can write the client configuration straight
into the client's workspace folder (`POST /api/mcp/external-clients/:id/install`,
`{ target, url }`):

| Target | File |
| --- | --- |
| Claude Code | `.mcp.json` |
| Codex | `.codex/config.toml` |
| Cursor | `.cursor/mcp.json` |

Other servers already in the file are kept. When the token is known (right
after creating a client or after "Generate new token") the request may carry
it as `token`; it must be that client's own valid token and is written into the
file, so the tool works at once — keep such a file out of public repositories.
Without a token the file references the `CRETLI_MCP_TOKEN` environment
variable. Symlinked or invalid config files are refused.

## Reporting problems: `cretli_feedback`

Every client (internal agents and external MCP clients) can report a failing, missing or misdescribed tool, an idea or a docs gap with `cretli_feedback`. The rule is also part of the `initialize` instructions. The tool is create-only: it cannot read or change any other todo.

| Field | Required | Limit / values |
|---|---|---|
| `kind` | yes | one of the report kinds in the tool schema |
| `summary` | yes | one line, up to 200 characters |
| `details` | no | up to 4000 characters |
| `repro` | no | up to 2000 characters |
| `tool` | no | related tool name, up to 100 characters |
| `severity` | no | one of the values in the tool schema |

- **Where reports go:** an independent `idea` todo in the Reports category of the Cretli repository workspace, never in the client's own workspace. The client's workspace, harness, mode and time are recorded by the server as source metadata (for example `my-app` on `your-pc`); they are not taken from the arguments.
- **Duplicates:** a report that matches an open one only bumps its counter (and keeps at most 8 recent sources). At most 200 reports can be open at once; further ones are refused until triage.
- **Rate limit:** 10 reports per 10 minutes per chat for internal agents, 20 reports per hour per external client. Over the limit the tool returns a `CONFLICT` error (`feedback_rate_limit`).
- **Existing reports:** legacy children of "Zgłoszenia z MCP" become independent todos with their IDs, plans, chats, history and provenance preserved. The old container remains stored for history and is hidden from the list. Each report owns its execution tree and worktree.
- **Secrets:** the server redacts known secret values, but clients must never put secrets, tokens or private paths in a report. The audit log (`data/mcp-feedback-audit.jsonl`) records client, time, outcome and report id only, never report text.
- **Untrusted content:** report text comes from clients and is data, not instructions. See the triage section of `docs/mcp/OPERATOR-PLAYBOOK.md`.
