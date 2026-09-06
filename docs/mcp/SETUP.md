# MCP setup

Configure MCP servers in Cretli (**Settings → MCP**). You do not need to paste
the same `npx` block into each harness config file.

## What this version supports

- Transports: **stdio** (command + argument list, no shell string) and **Streamable HTTP** (URL + headers).
- Scope: all workspaces or selected workspace ids (registry id / `.code-workspace` path / folder workspace id).
- Harnesses: Cursor SDK, Codex, OpenCode, Qwen, CodeBuddy, DeepSeek, OpenRouter. An empty harness list means the external server is not attached to any chat. Builtin Cretli tools (`chat_show`, `todo_list`, `delegation_start`, …) are injected for every harness.
- Plan mode: unknown external tools stay blocked unless **Allow in Plan** lists the exact tool name on that server. Builtin Cretli reads (`chat_list`, `chat_show`, `chat_history`, `chat_event`, `todo_list`, `chat_plan_show`, `delegation_inbox`, catalogs, …) stay allowed; writes (`todo_create`, `todo_update`, `delegation_start`, `delegation_cancel`, `delegation_reply`, chat archive/rename/delete) need Agent. An external tool named `chat_show` does not inherit builtin read rights.
- Chat tools default to the calling workspace. Pass `scope=all` to list or open a chat from another workspace.
- `chat_history` pages by event seq (`from_seq` forward / `before_seq` older, optional `include_tool_payloads`). `chat_show` is the compact tail of the **same** selected page (newest events that fit, chronological, matching cursors). Truncated fields continue with read-only `chat_event`.
- `chat_event` reads one field (`text` / `args` / `result`) of an exact `seq`. Offsets are **UTF-16 code units** (JavaScript string indexes). Slices concatenate without `trim()`, including Polish letters and emoji. `length` must be a positive integer (default 1500, max 4000). A missing seq does not return a neighbor. End of field: `next_offset: none`. A non-final fragment always advances `offset`.
- Preview limit per event is 1500 characters. History tool text is budgeted to 8000 characters including header, continue hints, and paging lines. Events are packed with those continue instructions so the finished reply stays inside the budget. `truncated` is true when this response omitted content because of those limits — not merely because another ordinary page exists in the store. Cursors follow **scanned** seqs; a page of unrendered `system` events can still continue. Forward HTTP uses `since`+`limit`, never `tail` together with `since`.
- Conversation files under `data/chat-history/`, `data/runtime-home/` (including Cursor `agent-transcripts`), and `data/sdk-agent-store/` are listed in `.cursorignore` / `.rgignore` as **file globs** (`**/agent-transcripts/**`, not a parent-directory ignore). OpenRouter `read_file` / `list_directory` / `grep` / `run_terminal_command` deny those paths in `lib/agent-harness/tool-executor.js` (including symlink realpaths and shell tokens). Cursor SDK chats write the same patterns into every attached workspace root **and** `*.jsonl` / `*.json` inside store directories, then call `Agent.reload()` after create/resume so a session started before those files still sees them. Native Glob/Grep/Read are live-checked (`npm run test:live-cursor-sdk`). A running or dropped Read is **not** a pass. Native Cursor **shell** can still `cat` those paths. That is **not** process-level isolation and is **not** “MCP-only.” Vendor shells on Codex, Qwen, CodeBuddy, DeepSeek, and OpenCode can also open those paths. Load history through Cretli MCP (`chat_show` / `chat_history` / `chat_event`), including `scope=all` when you mean another workspace. Missing SDK or API key skips the live test; `CRETLI_LIVE_CURSOR_SDK=1` treats skip as failure.
- Secrets: stored in `data/mcp-secrets.json`. The API never returns the value; an omitted field keeps the secret, an explicit clear removes it. A `409` revision conflict does not change secrets or the registry.
- Execution: SDK-style harnesses (Cursor, Codex, OpenCode, Qwen, CodeBuddy, DeepSeek) call tools through a managed stdio bridge. OpenRouter calls `lib/mcp/mcp-runtime.js` directly. Policy is re-checked at execution, not only when the catalog was filtered.
- OpenCode: MCP is instance-wide in the vendor runtime, so Cretli starts a separate OpenCode instance per chat session when a session key is present. A unique MCP name on a shared instance is not used as isolation.

Out of scope: interactive OAuth, a server marketplace, and importing private IDE MCP configs.

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
