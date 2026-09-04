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

Default model is the CodeBuddy alias `default-model` (override with `CODEBUDDY_DEFAULT_MODEL`). The chat picker and Settings → Harness → CodeBuddy load models from the live CodeBuddy account (invalid-model CLI probe), then the international-site catalog. The bundled CLI `product.json` is not used as the picker — it often lists older GPT/Gemini ids that this account cannot run.

## Troubleshooting

- **Package missing** — `npm install @tencent-ai/agent-sdk`.
- **CLI not found** — install the CodeBuddy CLI, or set `CODEBUDDY_CODE_PATH`.
- **Missing key** — Settings → Harness → CodeBuddy, or `CODEBUDDY_API_KEY`.
- **Wrong model / `service info not found`** — pick a model from Settings → Harness → CodeBuddy. The list is account-specific (`default-model`, `glm-5.2`, `gpt-5.6-sol`, …).
- Session resume uses `codebuddySessionId` stored on the chat after the first `system` init message.
