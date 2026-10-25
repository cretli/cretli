# OpenCode harness reference

Cretli integrates [OpenCode](https://opencode.ai/) (Zen) as an alternative chat harness (`agentTransport: opencode`). Events are normalized to the same WebSocket protocol as `@cursor/sdk`.

## Local vendor tree (gitignored)

Run once (or after SDK upgrades):

```bash
bash scripts/setup-opencode-reference.sh
```

This creates `.vendor/opencode/`:

| Path | Purpose |
|------|---------|
| `src/` | Shallow clone of [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| `sdk-types.d.ts` | Copy of `@opencode-ai/sdk` generated types |
| `openapi.json` | Live OpenAPI from `opencode serve` (`/doc`) when the server is running |

Optional: add `.vendor/opencode/src` to **Settings → Workspace → Additional Cursor context dirs** so the IDE agent sees upstream sources while editing the harness.

## External docs

- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [GitHub — anomalyco/opencode](https://github.com/anomalyco/opencode)

## Event flow (SSE → UI)

```text
opencode serve (per workspace)
  → client.event.subscribe() SSE
  → harnesses/opencode/opencode-event-normalizer.js
  → harnesses/opencode/opencode-agent-ws.js (room broadcast)
  → WebSocket sdkEvent / opencode_question / opencode_permission
  → app_front/lib/sdk-rich-view.js
```

## HTTP endpoints used by Cretli

| Area | Endpoint | Module |
|------|----------|--------|
| Session | `POST /session`, `POST /session/{id}/prompt` | `opencode-agent-ws.js` |
| Events | SSE `event.subscribe` | `opencode-server-manager.js` |
| Question | `POST /api/session/{id}/question/{requestID}/reply\|reject` (+ `directory` query/header; fallback `/question/{id}/…`) | `opencode-question.js` |
| Permission | `POST /api/session/{id}/permission/{requestID}/reply` (+ `directory` query/header; fallback `/permission/{id}/reply`) | `opencode-permission.js` |
| Health | `GET /doc` (OpenAPI) | setup script |

## Harness source files

- `harnesses/opencode/opencode-agent-ws.js` — WebSocket room, queue, replay
- `harnesses/opencode/opencode-server-manager.js` — lazy `opencode serve` per workspace
- `harnesses/opencode/opencode-event-normalizer.js` — SSE → SDK-shaped events
- `harnesses/opencode/opencode-question.js`, `harnesses/opencode/opencode-permission.js` — interactive skills
- `harnesses/opencode/opencode-prompt-run.js` — idle timeout / run lifecycle

User setup: [SETUP.md](./SETUP.md). Architecture overview: [../ARCHITECTURE.md](../ARCHITECTURE.md).
