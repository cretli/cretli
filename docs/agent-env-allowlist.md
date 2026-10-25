# Agent child-process environment allowlist

**Opt-in.** By default (flag unset) harness child processes inherit `process.env`
exactly as before. With `CRETLI_AGENT_ENV_ALLOWLIST=1` (also `true`/`yes`/`on`)
`lib/agent-env.js` (`buildAgentChildEnv(harness, { base, home, overrides })`)
builds the child env from an allowlist instead:

- always: `PATH`, `HOME`, `USER`, `LANG`/`LC_*`, `TERM`, `TMPDIR`, `TZ`, `XDG_*`,
  proxy/CA variables and a few toolchain/session variables (see the source);
- only the harness's own provider variables (prefix table
  `HARNESS_PROVIDER_ENV`: claude `ANTHROPIC_/CLAUDE_/AWS_`, codex
  `OPENAI_/CODEX_`, qwen `QWEN_/DASHSCOPE_/OPENAI_`, codebuddy `CODEBUDDY_`,
  deepseek `DEEPSEEK_/DSH_`, zai `ZAI_`, opencode `OPENCODE_` + the providers
  Cretli configures for it, cursor `CURSOR_`; `tool` gets none);
- never: `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `CRETLI_*`, `CURSOR_REMOTE_*`
  (explicit `overrides` from Cretli, e.g. `CRETLI_DATA_DIR` for review-verify,
  are still applied last).

`HOME`/`XDG_*` are kept so CLI logins keep working; harnesses that already own
an isolated home (CodeBuddy, Qwen) set it through `overrides`/`home`.

## Enabling, aliases and extras

- `CRETLI_AGENT_ENV_ALLOWLIST=1` turns the allowlist on (server env, set at start).
- `CRETLI_AGENT_ENV_PASSTHROUGH=1` is kept as an alias that force-disables it
  (wins over the flag).
- `CRETLI_AGENT_ENV_EXTRA=NAME1,PREFIX_*` adds variables to every harness's
  allowlist (e.g. `ANTHROPIC_API_KEY` for OpenCode if you rely on its native
  Anthropic provider). Explicit names may also re-allow a denied name.
- Explicit `overrides` from Cretli (`CRETLI_DATA_DIR` for review-verify,
  `CRETLI_MCP_TOKEN`/`CRETLI_URL` for the MCP bridge, which are passed through the
  MCP server config rather than inherited) are applied after the deny list.

Known trade-off: OpenCode only gets `OPENCODE_/OPENROUTER_/ZAI_/MIMO_/MISTRAL_`;
Cretli injects its own provider keys through `OPENCODE_CONFIG_CONTENT`, but a
native `ANTHROPIC_*`/`OPENAI_*` provider in OpenCode needs `CRETLI_AGENT_ENV_EXTRA`.
Mistral, MiMo and OpenRouter chats are in-process HTTP clients (no child env).

## Manual login smoke (per harness)

Start Cretli with the flag, open a chat per harness (Claude, Codex, Qwen,
CodeBuddy, OpenCode, DeepSeek) and send a prompt with a pre-existing CLI login
(no API key in Settings). It must authenticate as before. If one fails, unset the
flag and add the missing variable via `CRETLI_AGENT_ENV_EXTRA` (or the table).

Smoke status of this change (flag on):

| Harness | Status |
|---|---|
| codex, opencode (`providers list`, `models`), deepseek (`dsh --version`) | executed; same results as flag-off (codex reported "Not logged in" in both modes: no login on that host) |
| `tool` env (bash child), zai env (python child) | executed (`bash -lc`, `python3 -c`) |
| claude, qwen, codebuddy, zai worker, cursor, in-process agent-harness tool shell | NOT run live (no CLI/credentials on the test host); verified only by static analysis and unit tests |
| mistral, openrouter, mimo | in-process HTTP clients, no child env |

Manual host checklist for the harnesses that were not run live (flag on, restart
Cretli first):

1. Claude: send one prompt with the subscription login (and once with an API key if you use one).
2. Qwen and CodeBuddy: send one prompt each; confirm login/key still works (HOME is the isolated per-harness home).
3. Z.AI: run Settings → install SDK, then one prompt; custom `ZAI_PYTHON_BIN` must be honored.
4. Cursor: one prompt and a fork-title generation.
5. Agent-harness shell tool: run `env | grep -c TOKEN` through a chat; no `GITHUB_TOKEN`/`CRETLI_*` expected.
6. On any failure: unset the flag, then add the missing variable via `CRETLI_AGENT_ENV_EXTRA`.

## Interactive terminal and other effects

`lib/pty-env.js` uses the `tool` profile, so with the flag on the interactive
terminal also loses provider API keys, `CRETLI_*`, `GITHUB_TOKEN`/`GH_TOKEN`,
`NPM_TOKEN`, `GIT_ASKPASS`-style credential helpers and other variables outside the
allowlist (e.g. `PIP_*`, `GOOGLE_CLOUD_PROJECT`, `CLOUDSDK_CONFIG`, `AWS_*`).
Kept in the base: `PYTHONPATH`, `VIRTUAL_ENV`, `PYTHON_BIN`, `GIT_AUTHOR_*`,
`GIT_COMMITTER_*`. Re-add others with `CRETLI_AGENT_ENV_EXTRA`, e.g.
`CRETLI_AGENT_ENV_EXTRA=GOOGLE_CLOUD_PROJECT,CLOUDSDK_CONFIG,PIP_*`.

## Inventory: `rg "process\.env" lib harnesses` (spawn-relevant hits)

The tree has ~150 files reading `process.env` for configuration (flags,
timeouts, paths, key lookup). Those are reads, not child-env construction, and
are out of scope. Hits that build or pass a child env:

| Site | Decision |
|---|---|
| `lib/pty-env.js` | wired (`tool`); the user's interactive terminal is affected too (see below) |
| `lib/claude/claude-api-key.ts` | wired (`claude`) |
| `lib/codex/codex-api-key.ts` | wired (`codex`) |
| `lib/sdk/sdk-review-verify.ts`, `lib/sdk/sdk-history-isolation-probe.ts` | wired (`tool`, CRETLI_* via overrides) |
| `lib/agent-harness/tool-executor.ts` (rg, bash) | wired (`tool`) |
| `lib/routes/chats-routes.js`, `lib/agent-cli.js` (`buildAgentSpawnEnv`, used by `lib/fork-title.js`) | wired (`cursor`) |
| `harnesses/opencode/opencode-server-manager.js` | wired (`opencode`) |
| `harnesses/codebuddy/codebuddy-models.js` | wired (`codebuddy`, direct spawn) |
| `harnesses/codebuddy/codebuddy-agent-ws.js` `buildQueryEnv` | wired (`codebuddy`) via masking: `@tencent-ai/agent-sdk` spawns the CLI with `{...process.env, ...options.env}`, so keys the allowlist would drop are set to `undefined` (`buildAgentEnvMask`), then the explicit CodeBuddy env is applied. Empty mask without the flag |
| `harnesses/deepseek/deepseek-api-key.js` | wired (`deepseek`) |
| `harnesses/zai/zai-sdk-client.js` | wired (`zai`) |
| `harnesses/zai/zai-routes.js` (setup script) | wired (`tool`) plus explicit `ZAI_PYTHON_BIN` / `PYTHON_BIN` overrides, which `scripts/setup-zai-sdk.sh` reads |
| `harnesses/qwen/qwen-api-key.js` `buildQwenProcessEnv` | wired (`qwen`) via masking: `@qwen-code/sdk` spawns with `{...process.env, ...options.env}`, so the overlay sets every key the allowlist would drop to `undefined` (`buildAgentEnvMask`); Node omits undefined entries from the child env. No masking under the opt-out |
| `lib/worktree/git-worktree.ts`, `lib/workspace-scout-git.js`, `lib/workspace-watcher-worktree.js`, `lib/storage/cutover-code.js` | out of scope: git commands, not harnesses; need user git credentials/config (decision for the system-user leaf) |
| `lib/harness-package-update.js`, `lib/routes/harness-versions-routes.js` | out of scope: npm install/update of harness packages needs npm auth/registry env |
| `lib/routes/dev-actions-routes.js` | out of scope: operator dev actions, not a harness |
