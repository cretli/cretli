# Chat harnesses

A harness is the agent backend behind a chat. Every chat uses one harness, and a task
can move between harnesses: plan on one model, implement on another, review on a third.
Settings → Harness shows which harnesses are ready and lets you switch each one on or off.

## Tiers

| Tier | Harnesses | Meaning |
|------|-----------|---------|
| **Recommended** | Claude Code, Codex, DeepSeek, OpenRouter | Enabled on a new install, covered by these docs |
| **Available** | OpenCode, Cursor SDK, Qwen Code, Mistral, Z.AI, MiMo, CodeBuddy | Installed; one switch in Settings → Harness |
| **Experimental** | Antigravity | Recently added, not yet verified in daily use |

Tiers never remove a harness. The source of truth is `lib/harness-tiers.js`; plugin
loading is described in [harnesses/README.md](../harnesses/README.md), which also
explains how to add a new harness.

Configure at least one harness. Terminal, files and git work without any key.

## Recommended

### Claude Code

1. `npm install` installs the optional `@anthropic-ai/claude-agent-sdk` (it bundles the CLI).
2. Settings → Harness → Claude: sign in with a Claude Code plan, **or** use an Anthropic
   API key (`ANTHROPIC_API_KEY`).
3. Create a chat with harness **Claude**.

Details: [docs/claude/SETUP.md](claude/SETUP.md).

### Codex

1. `npm install` tries to install optional `@openai/codex-sdk` (pulls `@openai/codex` and the platform binary).
2. Sign in with ChatGPT (Go / Plus / Pro) in Settings → Harness → Codex, **or** set `CODEX_API_KEY`.
3. Create a chat with harness **Codex**.

Details: [docs/codex/SETUP.md](codex/SETUP.md).

### DeepSeek

1. `npm install` tries to install optional `@deepseek-ai/dsh-sdk-client` and `@deepseek-ai/dsh` (pinned to `0.1.2-alpha.5`).
2. Set `DEEPSEEK_API_KEY` (or Settings → Harness → DeepSeek).
3. Create a chat with harness **DeepSeek**.

Details: [harnesses/deepseek/SETUP.md](../harnesses/deepseek/SETUP.md).

### OpenRouter

One key for hundreds of models, including most of the vendors that also have their own
harness.

1. Set `OPENROUTER_API_KEY` (or paste it in Settings → Harness).
2. Create a chat with harness **OpenRouter**.

## Available

### OpenCode

1. Install the [OpenCode CLI](https://opencode.ai/) (or rely on the optional `opencode-ai` npm package).
2. Set `OPENCODE_API_KEY` (Zen) or run `opencode auth login` on the host — also available in Settings.
3. Create a chat with harness **OpenCode**. First run may take 1–2 minutes while `opencode serve` starts.

Details: [harnesses/opencode/SETUP.md](../harnesses/opencode/SETUP.md).

### Cursor SDK

1. `npm install` already tries to install optional `@cursor/sdk`. If you skipped optional
   deps: `npm install @cursor/sdk`.
2. Set `CURSOR_API_KEY` (or Settings).
3. Create a chat with harness **Cursor SDK**.

Using Cursor API/CLI is subject to [Cursor Terms of Service](https://cursor.com). MIT here
covers only Cretli source code.

### Qwen Code

1. `npm install` tries to install optional `@qwen-code/sdk` (`^0.1.8`; CLI is bundled).
2. Create an API key at [home.qwencloud.com](https://home.qwencloud.com) (API Keys). Set `QWEN_API_KEY` or paste it in Settings → Harness → Qwen.
3. Pick the matching plan preset (pay-as-you-go / Token Plan / Coding Plan). The key and Base URL must match or the API returns 401.
4. Create a chat with harness **Qwen**.

Details: [harnesses/qwen/SETUP.md](../harnesses/qwen/SETUP.md).

### Mistral

1. `npm install` tries to install optional `@mistralai/mistralai`; otherwise
   `npm install @mistralai/mistralai@^2.7.0`.
2. Set `MISTRAL_VIBE_API_KEY` or paste a Vibe CLI key in Settings → Harness → Mistral. `MISTRAL_API_KEY` remains available as a Studio API fallback.
3. Create a chat with harness **Mistral** (default model `mistral-medium-latest`).

Details: [harnesses/mistral/SETUP.md](../harnesses/mistral/SETUP.md).

### Z.AI and MiMo

API-key harnesses configured in Settings → Harness → Z.AI / MiMo (Z.AI also reads
`ZHIPU_API_KEY`). Cretli runs the tool loop for both.

### CodeBuddy

1. Install the [CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/sdk) and optional `@tencent-ai/agent-sdk`.
2. Set `CODEBUDDY_API_KEY` (or Settings → Harness → CodeBuddy).
3. Create a chat with harness **CodeBuddy**.

Details: [harnesses/codebuddy/SETUP.md](../harnesses/codebuddy/SETUP.md).

## Experimental

### Antigravity

Google's Antigravity CLI through ACP (`agy acp`).

1. Install the CLI following [Google's instructions](https://antigravity.google/docs/install).
2. Sign in from Settings → Harness → Antigravity.
3. Create a chat with harness **Antigravity**.

Details: [harnesses/antigravity/SETUP.md](../harnesses/antigravity/SETUP.md).
