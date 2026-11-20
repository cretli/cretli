# Claude Code harness setup

The Claude chat harness uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) (`@anthropic-ai/claude-agent-sdk`). The package bundles the Claude Code CLI, so no separate binary install is required. Cretli talks to it through the shared `/ws-agent-sdk` protocol.

The SDK is an **optional** npm dependency. Other harnesses work without it.

The Claude Code plan can be used locally through the Agent SDK when this process is explicitly configured for it. Plan login is separate from Anthropic API credits. API-key mode continues to use an **API key** from [console.anthropic.com](https://console.anthropic.com/settings/keys).

## Requirements

1. **npm package** — `npm install` runs `scripts/install-optional-claude-sdk.js`, which installs `@anthropic-ai/claude-agent-sdk` under `optional-packages/claude-agent-sdk`. To retry only that package: `node scripts/install-optional-claude-sdk.js`.
2. **Plan login or API key** — in Settings → Harness → Claude, choose **Claude Code plan** and use **Sign in to Claude Code**, then paste the one-time code. The session is stored in the app's `data/claude-home/`. For API billing, choose **Anthropic API key** and provide `ANTHROPIC_API_KEY` or the key in Settings → Harness → Claude. `CRETLI_CLAUDE_AUTH_MODE` can explicitly override the local setting.

Subscription mode is an explicit local setting and uses a separate `data/claude-home/` credential directory. API-key mode uses an isolated `data/claude-api-home/` and sets `ANTHROPIC_API_KEY`. Keep the login on the local server where it is intended to be used.

## Create a chat

1. Confirm Settings → Harness shows Claude as ready (package + plan login, or an API key).
2. New chat → harness **Claude**.
3. Default model is `sonnet` (override with `CLAUDE_DEFAULT_MODEL` or the chat picker). The picker prefers `query.supportedModels()` from a live session, then the Anthropic `GET /v1/models` list when an API key is configured, and otherwise falls back to the Claude Code aliases `default`, `opus`, `sonnet`, `haiku`. Every source is overlaid with the newest numbered ids the bundled CLI may not advertise yet, currently `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, so a just-released model is selectable right away.
4. Permission modes:
   - **Agent** uses the SDK `permissionMode: acceptEdits`. `bypassPermissions` is never used.
   - **Plan** uses the native `plan` mode.
   - **Ask** and read-only **review** use `default` and the `canUseTool` callback denies mutating tools before execution.

Stop calls `AbortController.abort()` and `query.interrupt()`. The next prompt resumes `claudeSessionId` via `options.resume`.

## Review jobs

`canUseTool` runs before a mutating tool executes, so Claude is a **pre-exec deny** harness for `assignment=review`. Review runs do not abort the whole job on a denied mutation; the reviewer can keep reading and reporting.

## Notes and limits

- MCP uses the same managed Cretli bridge as Qwen. `toClaudeMcpServers` maps servers to Claude `McpServerConfig` (`stdio` / `http`). The bridge is `alwaysLoad`, so builtin tools such as `delegation_reply` are in the prompt instead of hidden behind deferred tool search. `strictMcpConfig` keeps the session on Cretli's server list.
- Bedrock, Vertex, computer use, and subagents are out of scope.
- The Claude Agent SDK is installed under `optional-packages/claude-agent-sdk`, not as a root optional dependency. SDK 0.3.x bundles Claude Code CLI 2.1.280 or newer (required by current model ids) and peers `zod` 4, which conflicts with other harness SDKs on `zod` 3. `npm install` runs `scripts/install-optional-claude-sdk.js` to install that isolated tree. A failed optional install leaves the other harnesses usable.

## Troubleshooting

- **Package missing** — Settings shows “Optional package @anthropic-ai/claude-agent-sdk is not installed”. From the repo root run `node scripts/install-optional-claude-sdk.js`.
- **Plan not signed in** — choose **Claude Code plan** in Settings → Harness → Claude and complete sign-in. `Credit balance is too low` means the run used an API key; switch billing to the local plan login.
- **Missing API key** — only when billing is set to API key. Settings → Harness → Claude, or `ANTHROPIC_API_KEY`.
- **Authentication failed** — the chat shows the provider message. Check the plan login or the API key in Settings → Harness → Claude.
- Session resume uses `claudeSessionId` stored on the chat after the first successful `query()`.
- API-key billing stores its config in `data/claude-home/`.

### Background tasks

Room snapshots include `claudeBackgroundTaskCount` (non-ambient live tasks).
The chat status shows “Background tasks: N” between turns, including after a
page refresh. The background-task notice is rendered in the rich view and kept
in the room replay log with the completed run id. Task-list signals log only
the count and busy flag on the server, never descriptions or shell commands.

A live task keeps its session and client-less room alive until the CLI removes
it from `background_tasks_changed` or the process ends. Quiet shell tasks do
not need `task_progress` to survive 30 minutes. Explicit cancellation, session
reset and server shutdown can still stop work. A stale live task can retain a
process; reset its session when it is no longer needed.

`CRETLI_CLAUDE_BACKGROUND_HOLD_MS` no longer limits live tasks. For compatibility
it caps the short post-task settle grace (15 seconds by default), allowing the
CLI to start its result turn before idle cleanup resumes. This state survives
browser refreshes, not a server restart.

Live verification requires the optional Claude SDK and an authenticated CLI.
Run a harmless background shell delay in an isolated temporary workspace,
observe `background_tasks_changed` and any `task_progress`, refresh the chat
between turns, and confirm the count clears and the answer opens a follow-up
run. Do not infer shell progress support from synthetic SDK fixtures.

## Transcript retention

Cretli sets `cleanupPeriodDays` to **365 days** in its own `claude-home` and
`claude-api-home` directories. Settings → Usage lets you choose an integer from
30 to 3650 days. This is separate from usage journal retention and does not
restore already deleted transcripts. Project and local Claude settings take
precedence over these user-level settings.

External `CLAUDE_CONFIG_DIR`, `CRETLI_CLAUDE_CONFIG_DIR` and `~/.claude` directories
are never rewritten, unless their canonical path points to a Cretli-owned home.
The panel reports managed, user, external, invalid and unwritable settings and
cached `projects` sizes (updated hourly; initially unavailable).

Cretli preserves unrelated settings and existing user retention values. It tracks
values it has written per directory in `claude-retention-state.json`. A user
value equal to a previously managed value is indistinguishable and is treated
as managed. Invalid JSON and unwritable settings are left untouched and logged.
The ownership state is saved before settings, so a failed settings rename can be
retried safely. Concurrent edits observed before rename are remerged once;
repeated edits defer the write. A CLI edit between the final reread and rename
remains a small race because the CLI shares no lock with Cretli.

Read-only runs keep `settingSources: ['project']`; Cretli does not inject inline
SDK settings or enable user permission rules. In the pinned SDK **0.3.300** /
CLI **2.1.300**, the retention gate skips deletion when user settings are excluded
and no enabled source sets `cleanupPeriodDays`. An explicit project or managed
retention value can still enable the sweep and takes precedence. This behavior
is also documented in Claude Code's
[retention sweep event](https://code.claude.com/docs/en/monitoring-usage#retention-sweep-event)
(`user_source_disabled`). The housekeeping scheduler can create or update
`.last-cleanup` even when deletion is skipped; that marker alone is not evidence
of transcript deletion.

`tests/claude-retention-cli.test.js` exercises the actual CLI with a local mock
API and disposable config directories for both home names. Agent mode keeps a
60-day transcript and deletes a 400-day transcript at the configured 365 days.
Plan, ask and review runs keep both files, log the retention skip and preserve
user settings, with both absent and old throttle markers. Run it after SDK
upgrades (the regular suite skips it when no executable is supplied):

```sh
CRETLI_TEST_CLAUDE_EXECUTABLE=/path/to/claude node --test tests/claude-retention-cli.test.js
```

The mock uses no subscription credentials or real API key; authenticated
subscription/provider end-to-end runs are a separate check. Native transcripts
stay uncompressed for resume compatibility.
Storage can grow substantially: at 170 MB/day, 365 days is roughly 62 GB. No disk
alert or automatic compression is included. Codex session retention is unchanged.
