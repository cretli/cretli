# Codex CLI native compaction, resume, and prompt cache

Read-only probe of the installed OpenAI Codex CLI, run offline with a throwaway
`CODEX_HOME` (no API key, no network call). It documents what Cretli can and
cannot configure natively, and why `lib/codex/codex-compaction-config.js` only
exposes an opt-in compaction pass-through.

Probed version: `codex-cli 0.160.0`
(`@openai/codex`, `@openai/codex-linux-x64`, `@openai/codex-sdk` all `0.160.0`).

## Compaction: configurable through `--config`

There is **no** `codex config` and **no** `codex compact` subcommand — both
`--help` invocations print top-level help. Compaction is configured through the
global `-c/--config key=value` flag (dotted TOML paths) and
`$CODEX_HOME/config.toml`.

Recognized keys (wrong type ⇒ "config could not be loaded"; unknown key ⇒
ignored with a warning, verified via `codex doctor --json`):

| Key | Meaning |
| --- | --- |
| `model_context_window` | Declared context window (int64) |
| `model_auto_compact_token_limit` | Token count that triggers auto-compaction (int64) |
| `model_auto_compact_token_limit_scope` | `total` \| `body_after_prefix` |
| `model_post_turn_compact_threshold_percent` | Post-turn trigger (0..100) |
| `compact_prompt` | Custom compaction prompt |
| `features.token_budget.auto_compact_fallback_prompt` / `.auto_compact_fallback_buffer_tokens` | Feature-gated fallback |

Proof that the keys are parsed (offline config load):

```bash
export CODEX_HOME=/tmp/codex-probe-home
printf 'model_auto_compact_token_limit = "abc"\n' > "$CODEX_HOME/config.toml"
codex doctor --json   # config.load => fail "config could not be loaded"
printf 'totally_unknown_key_xyz = "abc"\n' > "$CODEX_HOME/config.toml"
codex doctor --json   # config.load ok + "'totally_unknown_key_xyz' is ignored."
```

The bundled model catalog (`codex debug models --bundled`) reports
`context_window=272000`, `max_context_window=872000`,
`effective_context_window_percent=95`, and carries **no**
`auto_compact_token_limit`; the effective trigger is model/catalog-derived
unless pinned. Manual compaction exists as the app-server RPC
`thread/compact/start` (+ `PreCompact`/`PostCompact` hooks), not as a CLI
subcommand; the exact TUI `/compact` spelling was not proven.

## Resume / thread continuation

`codex resume [SESSION_ID] | --last | --all`, `codex exec resume`, `codex fork`,
`codex queue --thread`; rollouts are reconstructed from history. The SDK exposes
`resumeThread()`, which Cretli already uses
(`lib/codex/codex-agent-ws.js`, `codex.resumeThread(room.codexThreadId, ...)`).
Resume rebuilds the same prompt prefix but gives no cache guarantee.

## Prompt cache: no configurable seam

No `prompt_cache*` field exists in the config schema, the generated app-server
JSON schema, or the SDK. `codex debug prompt-input "hello"` (offline) emits no
cache directive. `prompt_cache_key` appears once in an OpenAI Rust SDK symbol
pool, and `prompt_cache_options.ttl` only in bundled Responses-API guidance —
neither is a Codex CLI knob.

Caching is **automatic and server-side**, observable through
`cached_input_tokens` / `cache_write_input_tokens`. Resume rebuilds the same
prefix, so reuse is likely but not guaranteed. Cretli must not try to set it.

## On-disk storage

`CODEX_HOME` is honored. State: `state_5.sqlite`, `thread_history_1.sqlite`,
`goals_1.sqlite`, `logs_2.sqlite`, `memories_*.sqlite`, `queue_1.sqlite`,
`config.toml`, `auth.json`, plus `sessions/` + `archived_sessions/` with
`rollout-*`, `session_index.jsonl`, and `paginated_history.jsonl[.zst]`.
`codex exec --ephemeral` opts out of persistence (keep it off when resume is
wanted).

## What Cretli does

Cretli already isolates `CODEX_HOME` and resumes the native thread. The only
evidence-backed extra lever is the SDK's existing `CodexOptions.config`
(maps to `--config key=value`), so
`lib/codex/codex-compaction-config.js` adds an **opt-in, default-off**
pass-through for `model_auto_compact_token_limit` (and optionally
`model_post_turn_compact_threshold_percent`, validated to 0..100). With no
setting the override object is empty and Codex keeps its model-derived
behavior. No `prompt_cache_*` value is ever set.

Full probe transcript and raw artifacts live in the (untracked) `.tmp/`
directory of the worktree that produced this change; this file is the durable
summary.
