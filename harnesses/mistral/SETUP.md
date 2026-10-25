# Mistral harness — user setup

Cretli can run chats through the [Mistral AI](https://mistral.ai/) API using the
official `@mistralai/mistralai` SDK. Mistral is an API-only harness: the model runs
remotely and Cretli executes the workspace tools (read, edit, shell, git) in its own
host tool loop. The UI, history, queue, and reconnect behave like SDK chats.

## Requirements

- Node.js **22+** (same as Cretli)
- Optional package **`@mistralai/mistralai@^2.7.0`** (`npm install` tries to install it;
  if you skipped optional deps: `npm install @mistralai/mistralai@^2.7.0`)
- A Mistral API key (no CLI is needed)

## Configuration

| Setting | Env | Settings key | Notes |
|---------|-----|--------------|-------|
| Vibe Code key | `MISTRAL_VIBE_API_KEY` | `mistralVibeApiKey` (Settings → Harness → Mistral → Keys) | Create from Vibe Code / Vibe CLI settings |
| Studio API key | `MISTRAL_API_KEY` | `mistralApiKey` | Create in Studio API keys |
| Billing selection | — | `mistralBillingMode` | `auto` prefers Vibe when available; `vibe_code` and `api` force a key type |
| Base URL | `MISTRAL_BASE_URL` | saved server URL | Optional; only for a proxy or a self-hosted gateway |
| Default model | `MISTRAL_DEFAULT_MODEL` | — | Defaults to `mistral-medium-latest` |

The key is soft-validated (at least 16 characters, no whitespace) because Mistral keys
have no fixed prefix. The browser only sees whether a key is configured, never the key.

## First start

1. Install dependencies (`npm install`).
2. Create a key from Mistral Vibe Code settings (Vibe CLI key), then set `MISTRAL_VIBE_API_KEY` or paste it in Settings → Harness → Mistral → Keys. A Studio API key uses the Studio API allowance instead.
3. Start Cretli (`npm start`).
4. Create a chat with harness **Mistral** and pick a model.
5. Send a prompt.

Usage settings can group Mistral token telemetry by billing source. Older events are shown as unclassified because Cretli did not record which key was active for them.

## Models

The picker uses the live `models.list()` result when a key is set and falls back to a
static list otherwise: `mistral-medium-latest` (default), `mistral-large-latest`,
`mistral-small-latest`, `codestral-latest`, `ministral-8b-latest`,
`ministral-3b-latest`. The `devstral` and `magistral` families are deprecated and are
not offered by default.

## Plan / Ask / Review

- **Plan** and **Ask** block mutating tools (`write_file`, `search_replace`,
  `run_terminal_command`, mutating git); Ask does not write a plan or TODO. This is a
  tool deny in the host loop, not an OS sandbox.
- **Review** delegations (`delegation_start` with `assignment=review`) run read-only.
- **Agent** mode runs the full tool set.

## Status and models endpoints

- `GET /api/mistral/status` — SDK installed, key configured, `ready`, default model.
- `GET /api/mistral/models` — model catalog, enabled models, `modelsSource` (`live` or fallback).

## Recovery

`mistral` is a deferred recovery adapter (like `openrouter`): after a crash only the
user/assistant text is restored, not an in-flight tool-call/tool-result loop. See
[recovery-contract.md](../recovery-contract.md).

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `ready: false`, `sdkAvailable: false` | `npm install @mistralai/mistralai@^2.7.0`, restart Cretli |
| `ready: false`, key missing | Set `MISTRAL_VIBE_API_KEY` or save a Vibe key in Settings |
| Only the fallback model list | The key is missing or `models.list()` failed; check `modelsSource` |
| Requests go to the wrong host | Check `MISTRAL_BASE_URL` |
| Prompt times out | Increase **SDK run idle timeout** (`sdkRunIdleTimeoutSeconds`) |

## Plugin

Mistral is a repo plugin (`harnesses/mistral/`, `defaultEnabled: true`), so it loads
when `CRETLI_OPTIONAL_HARNESSES` is unset. Set that variable to a list without
`mistral` (or to an empty value) to turn the harness off entirely; see
`harnesses/README.md`.
