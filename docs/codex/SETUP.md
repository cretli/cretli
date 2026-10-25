# Codex SDK setup

The Codex chat harness uses the official [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (`@openai/codex-sdk`). The package spawns the bundled local `codex` CLI (`@openai/codex`) with `codex exec --experimental-json`. Cretli talks to it through the shared `/ws-agent-sdk` protocol.

The SDK and CLI are **optional** npm dependencies. Other harnesses work without them.

This path is the TypeScript exec SDK, not Codex App Server. Interactive Once/Always/Reject approvals are out of scope. `approvalPolicy` is `never`. Linux `workspace-write` / `read-only` sandboxes use bwrap and fail with `Can't mkdir <cwd>/.git` when the workspace folder is not a git repo (common for Cretli `.code-workspace` roots), so Cretli uses `sandboxMode: danger-full-access`. Plan mode is prompt-only: the model is told not to mutate, but Cretli does not abort the Codex turn. Codex exec is almost all shell (`/bin/bash -lc '…'` plus `rg`/`cat`/`web_search`); a host-side mutation heuristic kept cancelling read-only exploration.

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
3. Default model is `gpt-5.6-sol` when using an API key (override with `CODEX_DEFAULT_MODEL` or the chat picker). On a **ChatGPT plan** the picker uses the account catalog Codex writes to `data/codex-home/models_cache.json` — models that are not in that list (often `gpt-6-astra` / Sol during rollout) will 400. Fallback list for API-key mode: `gpt-6-astra`, `gpt-5.6-sol` / `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
4. Both Plan and Agent use `sandboxMode: danger-full-access` (see above). Plan adds a prompt hint only — the stream is not aborted. Do not treat Codex Plan as a hard write block. `approvalPolicy` is `never` (headless exec).

Stop aborts the in-flight `codex exec` process (`AbortSignal`). The next prompt resumes `codexThreadId`.

## Troubleshooting

- **Package missing** — `npm install @openai/codex-sdk`.
- **CLI not found** — install `@openai/codex`, or set `CODEX_BIN`.
- **Termux / Android (`findCodexExecutable`)** — Node reports `platform: android`, so npm skips the linux optional package. The JS wrapper then throws. Match the installed Codex version, e.g. `npm install @openai/codex-linux-arm64@npm:@openai/codex@0.160.0-linux-arm64 --force`, then restart the server. If the musl binary still fails to execute, Codex CLI is not usable on that device.
- **Missing credentials** — Settings → Harness → Codex: sign in with ChatGPT, or set `CODEX_API_KEY`.
- **Device-code login fails** — enable device-code authorization in ChatGPT security settings, then retry Sign in with ChatGPT.
- **Termux `error sending request for url (…/deviceauth/usercode)`** — the musl Codex binary cannot see Android `/etc/resolv.conf` or CA certs. Install `pkg install proot ca-certificates`, restart Cretli. Cretli then wraps `codex` with proot and sets `SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE` to `$PREFIX/etc/tls/cert.pem`.
- Session resume uses `codexThreadId` stored on the chat after `thread.started`.
- Isolated `CODEX_HOME` uses `cli_auth_credentials_store = "file"` so ChatGPT tokens land in `data/codex-home/auth.json` (not the OS keyring).
- **`bwrap: Can't mkdir …/.git: Permission denied`** — Linux sandbox tried to protect a missing `.git` under a workspace folder that is not a git repo. Cretli uses `danger-full-access` so shell tools can run; restart the server if an old process is still on `workspace-write`.

## Experimental app-server transport

Set `CRETLI_CODEX_APP_SERVER=1` before starting Cretli to opt Codex rooms into
`codex app-server --stdio`. Unset it to keep the default SDK `runStreamed`
transport. Restart Cretli after changing the flag. The experimental transport
supports mid-turn messages through `turn/steer`; an RPC rejection queues the
message as a follow-up. Cancelling uses `turn/interrupt` and queues acknowledged
messages whose matching user item has not appeared yet. Matching uses exact text
and turn id, consuming repeated texts in order. If an upstream item changes text
or arrives after cancellation, the guarantee is no loss with a possible duplicate.

Parity checklist (experimental, flag remains off by default):

| Item | Evidence / remaining work |
| --- | --- |
| Approval / sandbox | Fake RPC test checks `never` and `read-only`. Live (`tests/codex-app-server-live.test.js`, codex-cli 0.160): a file write is rejected under `read-only` (plan, review, Scout) and succeeds under `danger-full-access` (agent). Interactive server requests are rejected. |
| Resume | Fake RPC verifies existing thread id is passed to `thread/resume`. Live: a second turn on the same `codexThreadId` recalled a secret word from the first turn. |
| Cancel / steer | Fake RPC covers `turn/interrupt`, one seen and one unseen steer, and repeated cancellation. Live: a `turn/steer` sent during a busy turn lands in that turn (reply follows the steered instruction, no re-queue); cancel re-queues an unseen steer at most once. |
| Usage / compaction | Native `thread/tokenUsage/updated` totals are folded into the turn growth and emitted as the SDK `turn.completed` usage, so the same `usage` event and ledger record are produced (fake app-server test compares both records). Native `thread/compacted` / `contextCompaction` signals emit the same `context_usage { reset }` event as the rollout watcher (deduplicated within 10 s). The isolated-home rollout watcher still supplies per-call context readings. Live proof of a real turn is pending (opt-in). |
| MCP config | Fake RPC checks config forwarding; managed bridge preflight is reused. Fake app-server tests drive a turn through the production runner (`runCodexAppServerTurn`) and the agent-ws event handler: `mcp_servers` reach `thread/start`, and an `mcpToolCall` item yields the same broadcast `tool_call` events as the SDK `mcp_tool_call` item, for results and for errors (`status: error`). Live tools, bridge marks and MCP errors on a real turn remain pending (opt-in). |

Live checks are opt-in: `CRETLI_CODEX_LIVE=1 CRETLI_CODEX_LIVE_HOME=<dir with auth.json> node --test tests/codex-app-server-live.test.js`
(skipped without the flag, the codex CLI or auth; they spend model tokens).

**Live proof (acceptance criterion 3) is pending.** It needs an authenticated Codex CLI and cannot run in CI. To complete it by hand:
start Cretli with `CRETLI_CODEX_APP_SERVER=1`, open a Codex chat, send one prompt that calls a Cretli MCP tool
(for example "list my todos"), then confirm the tool call appears in the chat and that Settings → Usage (or the usage
ledger) shows one row for that run with non-zero input/output tokens matching the Codex CLI's own totals.

Gaps 3 (usage/compaction) and 4 (managed MCP) are covered by fake app-server tests; a live turn with a Cretli MCP
tool and counted usage is still pending. `CRETLI_CODEX_APP_SERVER` stays disabled by default; there is no default
switch in this change.
