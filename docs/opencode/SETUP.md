# OpenCode harness — user setup

Cretli can run chats through [OpenCode Zen](https://opencode.ai/) instead of `@cursor/sdk` or OpenRouter. The UI, history, queue, and reconnect behave like SDK chats.

## Requirements

- Node.js **22+** (same as Cretli)
- `opencode` CLI on the server PATH, or set **`opencodeBin`** in Settings
- Zen API key — one of:
  - `OPENCODE_API_KEY` environment variable
  - Settings → OpenCode → API key
  - `opencode auth login` on the host (stored in OpenCode config)

## First start

1. Install dependencies (`npm install`).
2. Configure the Zen key (Settings or env).
3. Start Cretli (`npm start`).
4. Create a chat with harness **OpenCode** and pick a model (e.g. `opencode/x-preview-f-free`).
5. Send a prompt — the server lazily starts `opencode serve` for the workspace folder (first run may take ~1–2 minutes).

Each workspace folder gets its own OpenCode server instance and port. Cretli attaches to an existing serve when health checks pass.

## Interactive skills in the UI

| Skill | UI | Action |
|-------|-----|--------|
| **Question** | Options + custom answer, Send / Reject | Answered in browser — no terminal |
| **Permission** | Once / Always / Reject | Approved in browser — no terminal |

The chat shows **“Needs action”** while a question or permission is pending.

## Plan mode

- Toggle **Plan** in the mode bar (same as SDK).
- OpenCode receives a plan-only system prompt.
- Mutating tools (`edit`, `write`, `shell`, …) are blocked server-side; the UI shows **Plan mode blocked** (`sdkPlanGuard`).
- Switch to **Agent** to apply changes.

## Queue and reconnect

- While the agent is busy, new prompts are queued (same UX as SDK).
- Force-send (⚡) aborts the current run and prioritizes the selected queued prompt.
- Reconnect replays recent room events; HTTP history fills gaps. Pending questions/permissions stay in the room until answered.
- Long-running runs emit progress notices (`sdkRunProgress`) with OpenCode label.
- On timeout/stream interruption, Cretli performs one controlled recovery retry before reporting a hard failure.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| Prompt times out | Increase **SDK run idle timeout** in Settings (`sdkRunIdleTimeoutSeconds`) |
| “OpenCode client unavailable” | Check `opencode` binary path; inspect server logs for serve startup |
| Stale serve / wrong port | Stop orphan `opencode serve` processes; restart Cretli |
| Permission still in terminal | Upgrade to a build with permission UI; ensure chat uses `agentTransport: opencode` |
| Empty model list | Verify Zen key and `GET /provider` on the local serve port |

## Developer reference

- Index: [README.md](./README.md)
- Vendor tree: `bash scripts/setup-opencode-reference.sh`
- Tests: `npm run test:opencode-permission`, `npm run test:opencode-ws-protocol`, `npm run test:opencode-harness-e2e` (live, needs key)
- Extra parity checks: `npm run test:sdk-room-state`, `npm run test:sdk-transport-labels`
- Playwright live suite: `npm run test:e2e:live` (includes OpenCode chat + reconnect flow)
- OpenCode-only live smoke: `npm run test:e2e:live:opencode`
- Dedicated `x-alpha-free` UI flow: `npm run test:e2e:live:opencode:alpha-free`
