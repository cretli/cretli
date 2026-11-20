# Codex setup

The Codex chat harness runs the local `codex app-server --stdio` CLI by default.
It uses the shared `/ws-agent-sdk` protocol for chat output, queue controls and
mid-turn steering. Set `CRETLI_CODEX_APP_SERVER=0` to use the official
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (`@openai/codex-sdk`)
with `codex exec` instead. The SDK fallback has no mid-turn steering.

The CLI and SDK are optional npm dependencies. Other harnesses work without them.
Both transports use `approvalPolicy: never`; interactive execution approvals
are disabled. Agent mode uses `danger-full-access`. Plan mode, Scout scans and
review delegations use the read-only sandbox (reviews can explicitly disable it
with `CRETLI_DELEGATION_CODEX_REVIEW_SANDBOX=0`).

## Requirements

1. **npm package** — `npm install` tries to install optional `@openai/codex-sdk` (pulls `@openai/codex` and the platform binary, e.g. `@openai/codex-linux-x64`). If you skipped optional deps: `npm install @openai/codex-sdk`. You can instead put `codex` on `PATH` or set `CODEX_BIN` / Settings `codexBin`.
2. **Billing** — pick one in Settings → Harness → Codex:
   - **ChatGPT plan (Go / Plus / Pro)** — [Codex CLI sign-in](https://learn.chatgpt.com/docs/codex/cli) via device code. Usage counts against your ChatGPT / Codex plan, not Platform tokens. Enable device-code login in ChatGPT security settings, then **Sign in with ChatGPT**. Tokens are stored in `data/codex-home/auth.json` (isolated `CODEX_HOME`, never `~/.codex`).
   - **API key** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Set `CODEX_API_KEY` or paste it in Settings. Pay-as-you-go Platform billing. When this mode is selected, `CODEX_API_KEY` is passed to the CLI. App-server authenticates through `account/login/start` with `cli_auth_credentials_store="ephemeral"`, keeping the key in process memory and preserving the saved ChatGPT session. ChatGPT mode **strips** API-key env variables so the CLI cannot silently bill API.
3. **CLI override (optional)** — Settings `codexBin` or env `CODEX_BIN` if `codex` is not resolved from the bundled package.

Runtime data lives in `data/codex-home/` (isolated `CODEX_HOME`, never `~/.codex`).

## Create a chat

1. Confirm Settings → Harness shows Codex as ready (package + CLI + ChatGPT session or API key).
2. New chat → harness **Codex**.
3. Default model is `gpt-5.6-sol` when using an API key (override with `CODEX_DEFAULT_MODEL` or the chat picker). On a **ChatGPT plan** the picker uses the account catalog Codex writes to `data/codex-home/models_cache.json` — models that are not in that list (often `gpt-6-astra` / Sol during rollout) will 400. Fallback list for API-key mode: `gpt-6-astra`, `gpt-5.6-sol` / `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
4. Agent uses `sandboxMode: danger-full-access`; Plan uses `read-only`. `approvalPolicy` is `never` for both transports.

Stop sends `turn/interrupt` to app-server (or aborts the exec SDK stream). The next prompt resumes `codexThreadId`.

## Troubleshooting

- **Package missing** — `npm install @openai/codex-sdk`.
- **CLI not found** — install `@openai/codex`, or set `CODEX_BIN`.
- **Termux / Android (`findCodexExecutable`)** — Node reports `platform: android`, so npm skips the linux optional package. The JS wrapper then throws. Match the installed Codex version, e.g. `npm install @openai/codex-linux-arm64@npm:@openai/codex@0.160.0-linux-arm64 --force`, then restart the server. If the musl binary still fails to execute, Codex CLI is not usable on that device.
- **Missing credentials** — Settings → Harness → Codex: sign in with ChatGPT, or set `CODEX_API_KEY`.
- **Device-code login fails** — enable device-code authorization in ChatGPT security settings, then retry Sign in with ChatGPT.
- **Termux `error sending request for url (…/deviceauth/usercode)`** — the musl Codex binary cannot see Android `/etc/resolv.conf` or CA certs. Install `pkg install proot ca-certificates`, restart Cretli. Cretli then wraps `codex` with proot and sets `SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE` to `$PREFIX/etc/tls/cert.pem`.
- Session resume uses `codexThreadId` stored on the chat after `thread.started`.
- Isolated `CODEX_HOME` uses `cli_auth_credentials_store = "file"` so ChatGPT tokens land in `data/codex-home/auth.json` (not the OS keyring).
- **`bwrap: Can't mkdir …/.git: Permission denied`** — Linux `workspace-write` tried to protect a missing `.git` under a workspace folder that is not a git repo. Cretli uses `danger-full-access` for Agent and `read-only` for Plan/Scout/reviews; restart the server if an old process is still on `workspace-write`.

## App-server transport and steering

App-server is enabled by default. `CRETLI_CODEX_APP_SERVER=1` still enables it
explicitly; `CRETLI_CODEX_APP_SERVER=0` restores the exec SDK. Restart Cretli
after changing the flag or updating the server code.

While Codex works, a normal send enters the queue. Use **Steer** on a queued
message or hold **Send** and choose **Steer the running turn** to inject text
through `turn/steer` with the active `expectedTurnId`.

An RPC rejection or a steer arriving during setup queues the message as a
follow-up. A steer arriving after the room becomes idle starts a normal turn.
A matching user item proves delivery even when the RPC reply is lost. Cancelling
re-queues acknowledged messages whose matching user item has not appeared yet,
at most once. A late acknowledgement after cancellation leaves the message
queued without a delivered echo. Matching uses exact text and turn id, consuming
repeated texts in order. An upstream item arriving after cancellation can still
cause a duplicate; preserving the user's text takes precedence.

Transport verification:

| Item | Evidence |
| --- | --- |
| Approval / sandbox | Fake RPC checks `never` and `read-only`. Live CLI 0.160 checks reject a file write in read-only mode and allow it in Agent mode. Interactive server requests are rejected. |
| Resume | Fake RPC verifies `thread/resume`. A real second turn recalls a value from the first turn on the same thread. |
| Cancel / steer | Fake RPC covers stale turns, setup, a lost reply after consumption, completion before the start reply, and late acknowledgement after cancel. Live steering changes the same turn's answer; cancelling queues an unseen steer once. |
| Usage | Live CLI MCP turns go through `runCodexAppServerTurn` and the production room handler. Non-zero input/output usage matches the growth of native thread totals. Fake RPC also compares the usage ledger record with the SDK record. |
| Compaction | Fake native `thread/compacted` / `contextCompaction` signals produce the same context reset as the rollout watcher. Real compaction remains untested. |
| MCP | A live isolated stdio fixture configured as the managed bridge returns a random token and an expected error. Both reach the production room handler with their result text; the failure has error status. Fake RPC verifies config forwarding and SDK parity. This does not exercise the running Cretli HTTP bridge's authentication or permissions. |
| API key | A local CLI test uses a fake key without a model call: `account/read` reports API-key mode while a pre-existing credential file remains byte-for-byte unchanged. Real paid API-key generation is not covered. |

Run deterministic transport checks:

```sh
node --test tests/codex-app-server.test.js tests/codex-app-server-auth.test.js tests/sdk-pending-steer.test.js
```

Live model checks spend tokens and require an authenticated Codex home:

```sh
CRETLI_CODEX_LIVE=1 CRETLI_CODEX_LIVE_HOME=<authenticated-home> node --test tests/codex-app-server-live.test.js
```

Without the live flag, CLI or authentication, model checks are skipped. All test
runtime data and MCP probes are isolated from the running Cretli instance.
