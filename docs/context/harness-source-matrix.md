# Harness context source matrix (8 harnesses)

Classification for **project rules/skills** delivery:

| Class | Meaning |
|-------|---------|
| **native** | Harness runtime loads from project tree (`settingSources`, SDK `dirs`, or vendor project files) without Cretli pasting rule bodies | adapter test only; **no live test** |
| **configured** | Cretli injects text via `decorateHarnessPrompt` / `applyHarnessOutboundPrompt` or SDK prefix (`applySdkHarnessOutboundPrompt`) | adapter test only; **no live test** |
| **unknown** | No confirmed native load for that source type; legacy Cretli paste remains the safe default | adapter test only; **no live test** |

Browser preview policy (`cretli-browser`) is documented in
`docs/harness-browser-context-matrix.md`. This matrix covers **all** static
context channels.

## Matrix

| Harness | Skills catalog in prompt | Workspace `.cursor/rules` alwaysApply | Shared / Settings extra dirs | Native project rules/skills | Other native project files | Evidence (file → symbol) | Live test |
|---------|--------------------------|---------------------------------------|------------------------------|----------------------------|----------------------------|---------------------------|-----------|
| **sdk** | configured | native | configured (shared only in prefix) | native (`settingSources: ['project']`, optional `dirs`) | — | `lib/sdk/cursor-agent-sdk-ws.ts` → `connectAgent` localOptions; `lib/sdk/harness-plan-prompt.ts` → `applySdkHarnessOutboundPrompt` (`includeWorkspaceRules: false`) | send path in tests; no live run |
| **opencode** | configured | configured | configured | unknown | — | `lib/opencode/opencode-agent-ws.js` → `decorateHarnessPrompt`; `lib/sdk/harness-plan-prompt.ts` → `applyHarnessOutboundPrompt` | adapter test only; **no live test** |
| **codex** | configured | configured | configured | unknown | — | `lib/codex/codex-agent-ws.ts` → `decorateHarnessPrompt` | adapter test only; **no live test** |
| **deepseek** | configured | configured | configured | unknown | — | `lib/deepseek/deepseek-agent-ws.js` → `decorateHarnessPrompt` | adapter test only; **no live test** |
| **claude** | configured | configured | configured | native in Plan/Ask/review (`settingSources: ['project']`); Agent mode SDK default sources | `CLAUDE.md` via Claude Code preset | `lib/claude/claude-agent-ws.ts` → `CLAUDE_AGENT_SETTING_SOURCES`, `decorateHarnessPrompt`; tests: `tests/claude-agent-ws-policy.test.js` | send path + epoch tests; no live run |
| **qwen** | configured | configured | configured | unknown (CLI session; no `settingSources` in Cretli) | — | `lib/qwen/qwen-agent-ws.js` → `decorateHarnessPrompt` | adapter test only; **no live test** |
| **codebuddy** | configured | configured | configured | native (`settingSources: ['project']`) | `CODEBUDDY.md`, `.codebuddy/` per vendor docs | `lib/codebuddy/codebuddy-live-session.js` → `settingSources: ['project']`; `lib/codebuddy/codebuddy-agent-ws.js` → `decorateHarnessPrompt` | adapter test only; **no live test** |
| **openrouter** | configured | configured | configured | unknown (in-memory decorated history) | — | `lib/openrouter/openrouter-agent-ws.js` → `decorateHarnessPrompt`; always-static transports in `HARNESS_PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS` | send path + hydrate/trim tests; no live run |

## Shared Cretli decoration (non-SDK)

- Skills list: `lib/skills/skill-context.js` → `buildAvailableSkillsPrompt`
- Workspace rules paste: `lib/sdk/shared-cursor-context.ts` → `buildWorkspaceAlwaysApplyRulesPrompt`
- Shared dirs paste: `buildSharedAlwaysApplyRulesPrompt`
- Orchestration: `lib/sdk/harness-plan-prompt.ts` → `applyHarnessOutboundPrompt` / `decorateHarnessPrompt`

## SDK multi-root

- Primary cwd + extra roots: `lib/sdk/shared-cursor-context.ts` → `resolveSdkCwdList`
- Bundled skills mirror (no `.cursor/rules` copy): `lib/sdk/cursor-share.ts` → `ensureCursorShare`

## Catalog vs prompt

The UI catalog (`getCursorContext`) lists availability; harnesses may still load
a **subset** natively. Do not equate catalog entries with pasted prompt content.

## Live-test status (stage 08)

"Live" means a real harness process or provider call answering with the
delivered context. None was run for stage 08: the environment has no provider
credentials. What is verified instead is the real Cretli send path
(`decorateHarnessPrompt`, `applySdkHarnessOutboundPrompt`) for the runtime SDK,
the session harness (Claude: epochs, dedupe, resume) and OpenRouter (hydrate/trim
epochs), see `tests/context-migration-validation.test.js` and
`tests/instruction-epoch-budget.test.js`. Every other adapter (opencode, codex,
deepseek, qwen, codebuddy, mimo, mistral, zai) relies on adapter tests only; the
missing live test is explicit, and its AGENTS.md row stays `unknown`
(`AGENTS_MD_MATRIX`, which also lists mimo, mistral and zai). The AGENTS.md
column of the registry is separate from this table: all harnesses are `unknown`.
