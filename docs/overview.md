# Cretli in detail

The [README](../README.md) is the short version. This page collects how the pieces work,
the configuration table and the architecture outline.

## How it works

- Workspaces are **self-config first**: a workspace is its own list of folders in
  Cretli settings — no Cursor file required. Folder enable/disable, names and the
  default folder save immediately. Folder order in the list is the workspace order:
  the first folder is the root (Cursor rules, skills, and agents). A `.code-workspace` file (Cursor/VS Code) is an
  optional **import/link**: sync re-reads it on demand, you can convert a file
  workspace into a plain Cretli workspace (stop syncing), and you can export any
  workspace's folders to a new `.code-workspace` file. Paths can be typed or picked
  with the built-in folder/file browser (`Browse` next to each path field); the
  browser can also create a new folder.
- **Terminal** — a PTY (`node-pty`) running your shell in the workspace CWD, rendered
  with xterm.js. One PTY per session; output is broadcast to every connected client.
- **Chat** — an agent in the same workspace, rendered as a rich HTML view (tool calls,
  markdown, plan/agent mode). Each chat uses one harness; see [harnesses.md](harnesses.md).
- **Todo, delegations and review** — todos with plans, sub-chats on other harnesses
  (`delegation_start`), independent reviews and an optional autopilot, the
  [Workspace Watcher](workspace-watcher.md). A todo's review badge is written only by the
  server ([todo-review-contract.md](todo-review-contract.md)).
- **Tasks / Files / Git** — VS Code tasks, workspace tree, git actions and worktrees.
- Same live view on every device: the in-app link/QR points at the LAN URL.

## Built-in browser

A server-side Chromium the user watches live in the **Browser** panel of the same
chat. An agent drives it with the `browser_*` MCP tools: `browser_open` starts or
adopts a session, the read tools (`browser_screenshot`, `browser_elements`,
`browser_dom`, `browser_console`, `browser_network`) inspect the page, and in agent
mode `browser_input` and `browser_navigate` act on it. Origins are **default-deny**
under the workspace Browser policy, and screenshots come back as a temp file path to
open instead of inline base64. Chromium is a separate native binary, so availability
depends on the host (the Docker image ships none, and Termux is unsupported by design) —
see [browser-runtime.md](browser-runtime.md) and the `cretli-browser` skill
(`.agents/skills/cretli-browser/SKILL.md`).

## Install as an app (PWA)

The app ships a web manifest and a service worker. Add to Home Screen on a phone
(or install in desktop Chromium). Live data (terminal/chat) always goes to the running server.

## HTTPS (microphone from a phone)

```bash
npm run gen-cert
# or set SSL_IP to your LAN address, then: node scripts/generate-ssl-cert.js
npm start
```

On the phone open `https://<lan-ip>:3011` and accept the self-signed cert warning.

## Configuration

All variables are optional. Copy [.env.example](../.env.example) to `.env` — `npm start`
loads it automatically (Node's native `--env-file`). Highlights:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3011` | HTTP/WS port |
| `CRETLI_BIND` | `127.0.0.1` | Bind host (`0.0.0.0` for LAN) |
| `CRETLI_SETUP_TOKEN` | — | Required for first-run setup when bound beyond localhost |
| `USE_HTTPS` | `1` (via `npm start`) | HTTPS with `data/key.pem`+`cert.pem` |
| `WORKSPACE_FILE` | `cretli.code-workspace` if present | Optional default `.code-workspace` (you can also add folders in Settings) |
| `WORKSPACES_SCAN_DIR` | parent of the current workspace | Seed/sync scan root for `*.code-workspace` files |
| `CRETLI_DATA_DIR` | `data` | Where chats, settings, auth and certs are stored |
| `CRETLI_LAN_HOST` | auto | Host used in the in-app link/QR |
| `CRETLI_OPTIONAL_HARNESSES` | unset | Comma-separated harness plugins to load; unset loads every plugin with `defaultEnabled` |
| `ANTHROPIC_API_KEY` | — | Claude Code in API-key mode (or plan sign-in in Settings) |
| `CODEX_API_KEY` | — | Codex SDK chat (or ChatGPT sign-in in Settings) |
| `DEEPSEEK_API_KEY` | — | DeepSeek Harness chat |
| `OPENROUTER_API_KEY` | — | OpenRouter chat |
| `OPENCODE_API_KEY` | — | OpenCode Zen key |
| `MISTRAL_VIBE_API_KEY` | — | Mistral Vibe Code plan key; `MISTRAL_API_KEY` is the Studio API key. Select the active key type in Harness → Mistral. Optional `MISTRAL_BASE_URL`, `MISTRAL_DEFAULT_MODEL` |
| `CURSOR_API_KEY` | — | Cursor SDK chat |
| `CODEBUDDY_API_KEY` | — | CodeBuddy chat |
| `QWEN_API_KEY` | — | Qwen Code chat (Qwen Cloud). Alias: `DASHSCOPE_API_KEY` |
| `QWEN_ENDPOINT` | `payg` | Qwen Cloud plan: `payg` / `token-plan` / `coding-plan` / `custom` |
| `AGENT_CALLBACK_TOKEN` | — | Required for agent callbacks when exposed on LAN |

Legacy `CURSOR_REMOTE_*` aliases still work. Documented names are `CRETLI_*`.

Runtime data lives in `data/` (gitignored).

## Comparison

| | Cretli | OpenCode TUI | code-server | Open WebUI |
|--|--------|--------------|-------------|------------|
| Phone PWA + shared live session | yes | no | IDE in browser | chatbot UI |
| Full PTY terminal | yes | TUI only | yes | no |
| Several agent vendors on one task (plan / implement / cross-review) | yes | no | no | no |
| Pluggable agent backends | 12 harnesses | OpenCode | extensions | models |
| Self-hosted on your PC | yes | yes | yes | yes |

## Architecture (brief)

- **HTTP** — `public/`, REST API (workspace, chats, settings, files, git, todos).
- **WebSocket** — `/ws` (terminal), `/ws-agent-sdk` (chat rooms for all harnesses).
- **Backend** — Node.js, Express, `node-pty`, `ws`, optional harness SDKs.
- **Frontend** — SPA in `app_front/` (webpack → `public/dist/`).

[ARCHITECTURE.md](ARCHITECTURE.md) · [MULTI-INSTANCE.md](MULTI-INSTANCE.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
