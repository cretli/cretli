# Harness context: cretli-browser skill and project rules

Full eight-harness source classification (native vs configured vs unknown):
`docs/context/harness-source-matrix.md`.

This matrix describes how Cretli injects browser preview instructions (`browser_*`
MCP tools, not private Playwright) for each harness. Canonical sources in the
Cretli repo:

| Source | Location | Content |
|--------|----------|---------|
| Skill | `.agents/skills/cretli-browser/SKILL.md` | Full browser workflow |
| Rule | `.cursor/rules/cretli-browser.mdc` (`alwaysApply: true`) | Short always-on policy; the full guide is the skill |
| Claude project file | `CLAUDE.md` | Browser section for Claude Code |
| MCP tool descriptions | `lib/mcp/builtin/browser-tools.js` | Per-tool hints (all harnesses) |

## Injection by harness

| Harness | `[AVAILABLE AGENT SKILLS]` (incl. cretli-browser) | Workspace `alwaysApply` rules | Shared `alwaysApply` (Settings extra dirs) | Native project rules | `CLAUDE.md` |
|---------|---------------------------------------------------|------------------------------|--------------------------------------------|----------------------|-------------|
| **sdk** (Cursor) | Yes — `cursor-agent-sdk-ws.ts` | Yes — Cursor `settingSources: ['project']` | Yes — `buildSharedAlwaysApplyRulesPrompt` in SDK prompt prefix | Via Cursor SDK | Cretli static block |
| **opencode** | Yes — `harness-plan-prompt.ts` | Yes — `buildWorkspaceAlwaysApplyRulesPrompt` | Yes — `buildSharedAlwaysApplyRulesPrompt` | No | Cretli static block |
| **codex** | Yes | Yes | Yes | No | Cretli static block |
| **deepseek** | Yes | Yes | Yes | No | Cretli static block |
| **claude** | Yes | Yes | Yes | No | Yes (Claude Code reads `CLAUDE.md`) |
| **qwen** | Yes | Yes | Yes | No | Cretli static block |
| **codebuddy** | Yes | Yes | Yes | No | Cretli static block |
| **openrouter** | Yes | Yes | Yes | No | Cretli static block |

Implementation entry points:

- Skills: `lib/skills/skill-context.js` → `buildAvailableSkillsPrompt`
- Non-SDK prompt decoration: `lib/sdk/harness-plan-prompt.ts` → `applyHarnessOutboundPrompt`
- SDK prompt prefix: `lib/sdk/cursor-agent-sdk-ws.ts`
- Rule parsing: `lib/sdk/shared-cursor-context.ts` → `buildWorkspaceAlwaysApplyRulesPrompt`, `buildSharedAlwaysApplyRulesPrompt`

Bundled Cretli skills (including `cretli-multi-harness`) are mirrored to
`data/cursor-share` for SDK `dirs` without copying `.cursor/rules`; see
`docs/ARCHITECTURE.md`.

## Other workspaces

When the chat `cwd` is not the Cretli git root, workspace rules and project
skills come from **that** project's tree. Bundled app skills still appear in the
`[AVAILABLE AGENT SKILLS]` list via `ensureCursorShare()` and home/extra roots
configured in Settings.

Non-Claude runtimes receive project `CLAUDE.md` through the shared static block. See `docs/context/harness-source-matrix.md#shared-claudemd-delivery`.
