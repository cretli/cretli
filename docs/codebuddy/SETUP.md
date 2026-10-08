# CodeBuddy harness setup

The CodeBuddy chat harness uses the [CodeBuddy Agent SDK](https://www.codebuddy.ai/docs/cli/sdk) (`@tencent-ai/agent-sdk`) plus the `codebuddy` CLI. Cretli talks to the SDK through the shared `/ws-agent-sdk` protocol.

The SDK is an **optional** npm dependency. Other harnesses work without it.

## Requirements

1. **CLI** — install the CodeBuddy CLI so `codebuddy` is on `PATH`, or set `CODEBUDDY_CODE_PATH` / Settings `codebuddyBin` to the executable.
2. **npm package** — `npm install` tries to install optional `@tencent-ai/agent-sdk`. If you skipped optional deps: `npm install @tencent-ai/agent-sdk`.
3. **API key** — create a key at [codebuddy.ai/profile/keys](https://www.codebuddy.ai/profile/keys). Set `CODEBUDDY_API_KEY` or paste it in Settings → Harness → CodeBuddy.

China / iOA / dedicated editions: set `CODEBUDDY_INTERNET_ENVIRONMENT` on the server (`internal`, `ioa`, `cloudhosted`, or `selfhosted`). There is no Settings UI for this in v1.

## Create a chat

1. Confirm Settings → Harness shows CodeBuddy as ready (package + CLI + key).
2. New chat → harness **CodeBuddy**.
3. Plan mode uses the SDK `permissionMode: plan`. Agent mode uses `bypassPermissions` so the run does not wait for a `canUseTool` UI (not in v1).

Project files (`CODEBUDDY.md`, `.codebuddy/`) are loaded via `settingSources: ['project']`. User/local CodeBuddy config is not loaded.

Follow-up messages stay on one live CLI process (`unstable_v2_createSession`). Do not use `--resume` per prompt — the CLI replays the previous assistant text and ignores the new message.

Default model is Tencent Hy4 Preview (`hy4-preview-f`); override it with `CODEBUDDY_DEFAULT_MODEL` only if the value is a Tencent Hunyuan Hy model ID. The chat picker and Settings → Harness → CodeBuddy load the live account list (invalid-model CLI probe), filtered to explicit Hy model IDs. CodeBuddy routing aliases such as `primary-model` can resolve to third-party models, so they are excluded. Third-party models exposed by CodeBuddy are left to their dedicated harnesses. If the account probe fails, the picker falls back to Hy3 and Hy4 Preview.

## MCP tools

CodeBuddy chats get the managed Cretli bridge (`cretli_bridge`) through the CLI `--mcp-config` flag. Two CLI behaviours shape how Cretli passes it:

- Every server entry needs an explicit `type` (`stdio` or `http`). An entry without it fails with `no valid transport type` and the CLI then starts with no MCP servers.
- The CLI connects MCP servers when the first prompt arrives and builds that model request without waiting. Cretli registers a `UserPromptSubmit` hook and holds its answer until the bridge reports in (at most 5 seconds), so the first turn already has the tools. Only the first prompt of a CLI process is held.

## Troubleshooting

- **Package missing** — `npm install @tencent-ai/agent-sdk`.
- **CLI not found** — install the CodeBuddy CLI, or set `CODEBUDDY_CODE_PATH`.
- **Missing key** — Settings → Harness → CodeBuddy, or `CODEBUDDY_API_KEY`.
- **Wrong model / `service info not found`** — pick a model from Settings → Harness → CodeBuddy. Availability of Hy models is account-specific and the account probe does not always return a list, so an ID from the fallback catalog can still be rejected. The first rejection locks that model out of automatic picks (Watcher, `model_pick`) for 24 hours; unlock it from the harness health card or untick it in Settings → Harness → CodeBuddy.
- **No Cretli MCP tools in a chat** — the model only lists `Bash`, `Read`, `Edit` and similar. Check the server log for `no valid transport type`; the `system` init message of a turn lists connected servers under `mcp_servers`.
- Session resume uses `codebuddySessionId` stored on the chat after the first `system` init message.
