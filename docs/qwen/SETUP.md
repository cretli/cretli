# Qwen Code harness setup

The Qwen chat harness uses the [Qwen Code SDK](https://www.npmjs.com/package/@qwen-code/sdk) (`@qwen-code/sdk`). The package bundles the Qwen CLI. Cretli talks to it through the shared `/ws-agent-sdk` protocol.

The SDK is an **optional** npm dependency. Other harnesses work without it.

This path uses a **Qwen Cloud** API key from [home.qwencloud.com](https://home.qwencloud.com) (API Keys). You do not need a separate DashScope / Alibaba Model Studio account. `dashscope-intl.aliyuncs.com` is only the API hostname behind a pay-as-you-go key from that console.

OAuth (`qwen-oauth`) is not used. The former free OAuth grant ended 2026-04-15. Coding Plan is a regular API key plus the coding endpoint.

## Requirements

1. **npm package** — `npm install` tries to install optional `@qwen-code/sdk` (`^0.1.8`; CLI is bundled). If you skipped optional deps: `npm install @qwen-code/sdk`. You can instead set `QWEN_BIN` / Settings `qwenBin` to a custom executable.
2. **API key** — create a key at [home.qwencloud.com](https://home.qwencloud.com) → API Keys. Set `QWEN_API_KEY` or paste it in Settings → Harness → Qwen. `DASHSCOPE_API_KEY` is a historical alias; you do not need it when `QWEN_API_KEY` is set.
3. **Endpoint preset** — the key and Base URL must match (otherwise 401). Settings → Harness → Qwen, or `QWEN_ENDPOINT`:
   - `payg` (default) — ordinary Qwen Cloud key (`sk-` / `sk-ws-`) → `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
   - `token-plan` — Token Plan key (`sk-sp-`) → `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
   - `coding-plan` — Coding Plan key (`sk-sp-`) → `https://coding-intl.dashscope.aliyuncs.com/v1`
   - `custom` — `QWEN_BASE_URL` / Settings `qwenBaseUrl`

Token Plan and Coding Plan share the `sk-sp-` prefix but are **not interchangeable** — pick the matching preset.

Runtime data lives in `data/qwen-home/` (isolated `HOME` for the CLI, never `~/.qwen`). The CLI receives `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `authType: 'openai'`.

## Create a chat

1. Confirm Settings → Harness shows Qwen as ready (package + key). A custom CLI path is optional.
2. New chat → harness **Qwen**.
3. Default model is `qwen3.8-max` (override with `QWEN_DEFAULT_MODEL` or the chat picker). Token Plan Individual ids: `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash` (plus `glm-5.2` / `deepseek-v4-pro`). Pay-as-you-go still lists DashScope names (`qwen-plus`, `qwen3-coder-plus`). Old picker values such as `qwen-plus` are remapped to `qwen3.7-plus` on Token Plan.
4. Plan mode uses SDK `permissionMode: plan`. Agent mode uses `yolo`. Mutating tools are still blocked by the existing plan guard.

Stop calls `AbortController.abort()` and `query.interrupt()`. The next prompt resumes `qwenSessionId` via `options.resume`.

## Questions in the chat UI

Qwen’s `ask_user_question` tool always needs a human answer, even in `yolo` mode. Cretli intercepts it with the SDK `canUseTool` callback and shows the same choice UI as OpenCode (option buttons + optional custom text). Reply or reject from the chat; the run stays in **Needs action** until then. The callback waits up to 10 minutes.

Denied or cancelled tool results (for example `[Operation Cancelled] Reason: Denied`) show as errors in the tool tray, not as a green check.

Quota and auth failures from Qwen Cloud (`429` weekly token-plan quota, `401`/`403`) are shown in the chat as a red error. The CLI often retries a weekly quota instead of ending the run; Cretli watches the session jsonl under `data/qwen-home/` and aborts the hung `query()` so the UI does not stay on a silent “busy” state.

## Troubleshooting

- **Package missing** — `npm install @qwen-code/sdk`.
- **Missing key** — Settings → Harness → Qwen, or `QWEN_API_KEY`.
- **404 Model not exist** — Token Plan does not accept DashScope names like `qwen-plus`. Use `qwen3.7-plus` / `qwen3.8-flash` (Cretli remaps the old picker ids).
- **429 quota exhausted** — the chat shows the provider message (including reset time). Token Plan weekly quota does not recover until that reset; retrying the same prompt will hang the CLI unless Cretli aborts it.
- Session resume uses `qwenSessionId` stored on the chat after the first successful `query()`.
- Isolated home is `data/qwen-home/`.
