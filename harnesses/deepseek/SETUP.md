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
3. Default model is `deepseek-flash` (V4.1 Flash; override with `DEEPSEEK_DEFAULT_MODEL` or the chat picker). Settings loads the live `GET https://api.deepseek.com/models` list when a key is set (`deepseek-flash` and `deepseek-v4-pro` today). Offline fallback is the same two ids. Retired `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` still work on the wire and are remapped to `deepseek-flash` in the enabled-model list. Qwen is not an official DeepSeek API model; DSH only uses `qwen` as a thinking format for custom pi-ai providers.
4. Plan mode prepends a read-only hint. DeepSeek Harness has no native plan permission mode.

Stop closes the `dsh` subprocess (the SDK protocol has no mid-turn cancel). The next prompt starts a new runtime. Cretli does **not** reuse `deepseekSessionId` across a rebuilt process — DSH treats that as an id collision and returns idle with an empty response.

## Troubleshooting

- **Package missing** — `npm install @deepseek-ai/dsh-sdk-client @deepseek-ai/dsh`.
- **CLI not found** — install `@deepseek-ai/dsh`, or set `DSH_BIN`.
- **Missing key** — Settings → Harness → DeepSeek, or `DEEPSEEK_API_KEY`.
- **Slow first prompt** — the first `dsh --profile sdk` spawn can take tens of seconds (`initializeTimeoutMs` is 30 s).
- **`read_image`** — V4.1 Flash (`deepseek-flash`) has native vision on the API. Stock DSH only declared images on `deepseek-v4-flash-vision-exp`, so Cretli overlays the `llm-deepseek` catalog with image input on Flash (and legacy Flash ids). Hidden on text-only `deepseek-v4-pro`. A new DeepSeek turn is needed after this overlay (the `dsh` subprocess reads the patch at spawn).
- **`web_fetch` to a LAN URL** — stock DSH only allows public unicast. Cretli replaces that fetch backend so RFC1918 / loopback work; link-local (`169.254.0.0/16`, `fe80::/10`) stays blocked.
- Session resume uses `deepseekSessionId` only while the same `dsh` process is alive. After stop, MCP rebuild, model change, or server restart the next prompt starts a fresh DSH session. A silent empty `completed` turn is reported as an error; a collision retries once without the old id.
- **`workflow` / `agent({ provider, model })`** — DSH reports the child as `subagent.started` / `subagent.finished`. `lastAssistantMessage` is `ContentBlock[]` (Cretli also accepts a string). The child answer and errors such as `no adapter registered` or an unsupported API model stay in a `subagent` tool block, not in the parent answer. When that field is empty, Cretli still uses the child's `session.event` finish/turn-end diagnostic. Known adapter/model errors become a `delegation_start` hint (`model_list(harness, enabled_only=true)`). DSH subagents themselves only accept official DeepSeek API models (`deepseek-flash`, `deepseek-v4-pro`). A `provider` such as `codex` is not a Cretli harness. Cross-harness work uses builtin `delegation_start` with a Settings-enabled model. A child session id does not replace or persist as `deepseekSessionId`, and a child turn/end does not decide the parent run status.

DeepSeek Harness is in **developer preview** and can ship breaking changes. Pin the optional package versions when upgrading.
