# DeepSeek Harness setup

The DeepSeek chat harness uses the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) TypeScript SDK (`@deepseek-ai/dsh-sdk-client`) plus the `dsh` runtime (`@deepseek-ai/dsh`). Cretli talks to the SDK through the shared `/ws-agent-sdk` protocol.

The SDK and runtime are **optional** npm dependencies. Other harnesses work without them.

## Requirements

1. **npm packages** — `npm install` tries to install optional `@deepseek-ai/dsh-sdk-client` and `@deepseek-ai/dsh` (pinned to `0.1.2-alpha.5`). `0.1.1-rc.2` still uses `launch.command` and has no `sdk` profile, so Cretli cannot boot it. If you skipped optional deps: `npm install @deepseek-ai/dsh-sdk-client@0.1.2-alpha.5 @deepseek-ai/dsh@0.1.2-alpha.5`. `@deepseek-ai/dsh` also ships the unused `dsh web` UI, so the first install is large; Cretli only needs the `dsh` binary (`--profile sdk`). You can instead put `dsh` on `PATH` or set `DSH_BIN` / Settings `deepseekBin`.
2. **API key** — create a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). Set `DEEPSEEK_API_KEY` or paste it in Settings → Harness → DeepSeek.
3. **CLI override (optional)** — Settings `deepseekBin` or env `DSH_BIN` if `dsh` is not resolved from the bundled package.

Runtime data lives in `data/dsh-home/` (isolated `DSH_HOME`, never `~/.dsh`).

## Create a chat

1. Confirm Settings → Harness shows DeepSeek as ready (packages + key).
2. New chat → harness **DeepSeek**.
3. Default model is `deepseek-v4-flash` (override with `DEEPSEEK_DEFAULT_MODEL` or the chat picker). Also listed: `deepseek-v4-pro` and `deepseek-v4-flash-vision-exp` (official `deepseek-official` catalog from `@deepseek-ai/dsh-llm-deepseek`). Qwen is not an official DeepSeek API model; DSH only uses `qwen` as a thinking format for custom pi-ai providers.
4. Plan mode prepends a read-only hint. DeepSeek Harness has no native plan permission mode.

Stop closes the `dsh` subprocess (the SDK protocol has no mid-turn cancel). The next prompt starts a new runtime and resumes `deepseekSessionId`.

## Troubleshooting

- **Package missing** — `npm install @deepseek-ai/dsh-sdk-client @deepseek-ai/dsh`.
- **CLI not found** — install `@deepseek-ai/dsh`, or set `DSH_BIN`.
- **Missing key** — Settings → Harness → DeepSeek, or `DEEPSEEK_API_KEY`.
- **Slow first prompt** — the first `dsh --profile sdk` spawn can take tens of seconds (`initializeTimeoutMs` is 30 s).
- Session resume uses `deepseekSessionId` stored on the chat after the first run.

DeepSeek Harness is in **developer preview** and can ship breaking changes. Pin the optional package versions when upgrading.
