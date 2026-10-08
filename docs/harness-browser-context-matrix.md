# Harness context: cretli-browser skill and project rules

This matrix describes how Cretli injects browser preview instructions (`browser_*`
MCP tools, not private Playwright) for each harness. Canonical sources in the
Cretli repo:

| Source | Location | Content |
|--------|----------|---------|
| Skill | `.agents/skills/cretli-browser/SKILL.md` | Full browser workflow |
| Rule | `.cursor/rules/cretli-browser.mdc` (`alwaysApply: true`) | Same policy, always-on |
| Claude project file | `CLAUDE.md` | Browser section for Claude Code |
| MCP tool descriptions | `lib/mcp/builtin/browser-tools.js` | Per-tool hints (all harnesses) |

## Injection by harness

| Harness | `[AVAILABLE AGENT SKILLS]` (incl. cretli-browser) | Workspace `alwaysApply` rules | Shared `alwaysApply` (Settings extra dirs) | Native project rules | `CLAUDE.md` |
|---------|---------------------------------------------------|------------------------------|--------------------------------------------|----------------------|-------------|
| **sdk** (Cursor) | Yes — `cursor-agent-sdk-ws.js` | Yes — Cursor `settingSources: ['project']` | Yes — `buildSharedAlwaysApplyRulesPrompt` in SDK prompt prefix | Via Cursor SDK | No (uses `.cursor/rules`) |
| **opencode** | Yes — `harness-plan-prompt.js` | Yes — `buildWorkspaceAlwaysApplyRulesPrompt` | Yes — `buildSharedAlwaysApplyRulesPrompt` | No | No |
| **codex** | Yes | Yes | Yes | No | No |
| **deepseek** | Yes | Yes | Yes | No | No |
| **claude** | Yes | Yes | Yes | No | Yes (Claude Code reads `CLAUDE.md`) |
| **qwen** | Yes | Yes | Yes | No | No |
| **codebuddy** | Yes | Yes | Yes | No | No |
| **openrouter** | Yes | Yes | Yes | No | No |

Implementation entry points:

- Skills: `lib/skills/skill-context.js` → `buildAvailableSkillsPrompt`
- Non-SDK prompt decoration: `lib/sdk/harness-plan-prompt.js` → `applyHarnessOutboundPrompt`
- SDK prompt prefix: `lib/sdk/cursor-agent-sdk-ws.js`
- Rule parsing: `lib/sdk/shared-cursor-context.js` → `buildWorkspaceAlwaysApplyRulesPrompt`, `buildSharedAlwaysApplyRulesPrompt`

Bundled Cretli skills (including `cretli-multi-harness`) are mirrored to
`data/cursor-share` for SDK `dirs` without copying `.cursor/rules`; see
`docs/ARCHITECTURE.md`.

## Other workspaces

When the chat `cwd` is not the Cretli git root, workspace rules and project
skills come from **that** project's tree. Bundled app skills still appear in the
`[AVAILABLE AGENT SKILLS]` list via `ensureCursorShare()` and home/extra roots
configured in Settings.
