# Codex SDK setup

The Codex chat harness uses the official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (`@openai/codex-sdk`). The package spawns the bundled local `codex` CLI (`@openai/codex`) with `codex exec --experimental-json`. Cretli talks to it through the shared `/ws-agent-sdk` protocol.

The SDK and CLI are **optional** npm dependencies. Other harnesses work without them.

This path is the TypeScript exec SDK, not Codex App Server. Interactive Once/Always/Reject approvals are out of scope. `approvalPolicy` is `never`. Linux `workspace-write` / `read-only` sandboxes use bwrap and fail with `Can't mkdir <cwd>/.git` when the workspace folder is not a git repo (common for Cretli `.code-workspace` roots), so Cretli uses `sandboxMode: danger-full-access`. Plan mode still uses a prompt hint plus the existing plan-guard.

## Requirements

1. **npm package** — `npm install` tries to install optional `@openai/codex-sdk` (pulls `@openai/codex` and the platform binary, e.g. `@openai/codex-linux-x64`). If you skipped optional deps: `npm install @openai/codex-sdk`. You can instead put `codex` on `PATH` or set `CODEX_BIN` / Settings `codexBin`.
2. **Billing** — pick one in Settings → Harness → Codex:
   - **ChatGPT plan (Go / Plus / Pro)** — [Codex CLI sign-in](https://learn.chatgpt.com/docs/codex/cli) via device code. Usage counts against your ChatGPT / Codex plan, not Platform tokens. Enable device-code login in ChatGPT security settings, then **Sign in with ChatGPT**. Tokens are stored in `data/codex-home/auth.json` (isolated `CODEX_HOME`, never `~/.codex`).
   - **API key** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Set `CODEX_API_KEY` or paste it in Settings. Pay-as-you-go Platform billing. When this mode is selected, `CODEX_API_KEY` is passed to `codex exec`; ChatGPT mode **strips** that env so the CLI cannot silently bill API.
3. **CLI override (optional)** — Settings `codexBin` or env `CODEX_BIN` if `codex` is not resolved from the bundled package.

Runtime data lives in `data/codex-home/` (isolated `CODEX_HOME`, never `~/.codex`).

## Create a chat

1. Confirm Settings → Harness shows Codex as ready (package + CLI + ChatGPT session or API key).
2. New chat → harness **Codex**.
3. Default model is `gpt-5.6-sol` (override with `CODEX_DEFAULT_MODEL` or the chat picker). Also listed: `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6`, `gpt-5.4`.
4. Both Plan and Agent use `sandboxMode: danger-full-access` (see above). Plan still adds a prompt hint. `approvalPolicy` is `never` (headless exec).

Stop aborts the in-flight `codex exec` process (`AbortSignal`). The next prompt resumes `codexThreadId`.

## Troubleshooting

- **Package missing** — `npm install @openai/codex-sdk`.
- **CLI not found** — install `@openai/codex`, or set `CODEX_BIN`.
- **Termux / Android (`findCodexExecutable`)** — Node reports `platform: android`, so npm skips the linux optional package. The JS wrapper then throws. Match the installed Codex version, e.g. `npm install @openai/codex-linux-arm64@npm:@openai/codex@0.152.1-linux-arm64 --force`, then restart the server. If the musl binary still fails to execute, Codex CLI is not usable on that device.
- **Missing credentials** — Settings → Harness → Codex: sign in with ChatGPT, or set `CODEX_API_KEY`.
- **Device-code login fails** — enable device-code authorization in ChatGPT security settings, then retry Sign in with ChatGPT.
- **Termux `error sending request for url (…/deviceauth/usercode)`** — the musl Codex binary cannot see Android `/etc/resolv.conf` or CA certs. Install `pkg install proot ca-certificates`, restart Cretli. Cretli then wraps `codex` with proot and sets `SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE` to `$PREFIX/etc/tls/cert.pem`.
- Session resume uses `codexThreadId` stored on the chat after `thread.started`.
- Isolated `CODEX_HOME` uses `cli_auth_credentials_store = "file"` so ChatGPT tokens land in `data/codex-home/auth.json` (not the OS keyring).
- **`bwrap: Can't mkdir …/.git: Permission denied`** — Linux sandbox tried to protect a missing `.git` under a workspace folder that is not a git repo. Cretli uses `danger-full-access` so shell tools can run; restart the server if an old process is still on `workspace-write`.
