# OpenCode harness — user setup

Cretli can run chats through [OpenCode](https://opencode.ai/) instead of `@cursor/sdk` or OpenRouter. The UI, history, queue, and reconnect behave like SDK chats.

## Requirements

- Node.js **22+** (same as Cretli)
- `opencode` CLI on the server PATH, or set **`opencodeBin`** in Settings
- **One** of these credentials (Zen is optional if you have Z.AI):
  - OpenCode Zen — `OPENCODE_API_KEY`, Settings → OpenCode → Zen, or `opencode auth login`
  - Z.AI — `ZAI_CODING_API_KEY` / `ZAI_API_KEY`, or Settings → OpenCode → Z.AI (default provider: GLM Coding Plan)

## First start

1. Install dependencies (`npm install`).
2. Configure a Zen **or** Z.AI key (Settings or env).
3. Start Cretli (`npm start`).
4. Create a chat with harness **OpenCode** and pick a model (Zen e.g. `opencode/x-preview-f-free`, or GLM e.g. `zai-coding-plan/glm-5.3`).
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
| `spawn opencode EACCES` | Cretli is not root but PATH still includes `/root/...` (typical Cursor remote). Restart after this fix — unreadable PATH dirs are dropped and a found CLI (`opencodeBin`, bundled `opencode-*`, or `~/.opencode/bin`) is prepended |
| Stale serve / wrong port | Stop orphan `opencode serve` processes; restart Cretli |
| Permission still in terminal | Upgrade to a build with permission UI; ensure chat uses `agentTransport: opencode` |
| Empty model list | Verify a Zen or Z.AI key and `GET /provider` on the local serve port |

## Developer reference

- Index: [README.md](./README.md)
- Vendor tree: `bash scripts/setup-opencode-reference.sh`
- Tests: `npm run test:opencode-permission`, `npm run test:opencode-ws-protocol`, `npm run test:opencode-harness-e2e` (live, needs key)
- Extra parity checks: `npm run test:sdk-room-state`, `npm run test:sdk-transport-labels`
- Playwright live suite: `npm run test:e2e:live` (includes OpenCode chat + reconnect flow)
- OpenCode-only live smoke: `npm run test:e2e:live:opencode`
- Dedicated `x-alpha-free` UI flow: `npm run test:e2e:live:opencode:alpha-free`
