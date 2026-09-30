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
3. Default model is `claude-sonnet-4-6` (override with `CLAUDE_DEFAULT_MODEL` or the chat picker). With an API key, Settings loads the live Anthropic `GET /v1/models` list. If that request fails, the picker uses the fallback: `claude-opus-4-8`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4`.
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
