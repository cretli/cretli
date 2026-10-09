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
| API key | `MISTRAL_API_KEY` | `mistralApiKey` (Settings → Harness → Mistral) | Env wins over the saved value |
| Base URL | `MISTRAL_BASE_URL` | saved server URL | Optional; only for a proxy or a self-hosted gateway |
| Default model | `MISTRAL_DEFAULT_MODEL` | — | Defaults to `mistral-medium-latest` |

The key is soft-validated (at least 16 characters, no whitespace) because Mistral keys
have no fixed prefix. The browser only sees whether a key is configured, never the key.

## First start

1. Install dependencies (`npm install`).
2. Set `MISTRAL_API_KEY` or paste the key in Settings → Harness → Mistral.
3. Start Cretli (`npm start`).
4. Create a chat with harness **Mistral** and pick a model.
5. Send a prompt.

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
| `ready: false`, key missing | Set `MISTRAL_API_KEY` or save it in Settings |
| Only the fallback model list | The key is missing or `models.list()` failed; check `modelsSource` |
| Requests go to the wrong host | Check `MISTRAL_BASE_URL` |
| Prompt times out | Increase **SDK run idle timeout** (`sdkRunIdleTimeoutSeconds`) |
