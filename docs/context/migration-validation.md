# Context unification: final validation, decisions and rollback (stage 08)

Closing note for the eight-stage context unification. Stage docs:
[registry-contract](registry-contract.md), [skill-activation](skill-activation.md),
[agents-md-and-settings](agents-md-and-settings.md),
[instruction-epoch-and-budget](instruction-epoch-and-budget.md),
[delegation-context-and-mcp](delegation-context-and-mcp.md),
[harness-source-matrix](harness-source-matrix.md). Contract tests:
`tests/context-migration-validation.test.js`.

## Acceptance status

| Criterion | Status | Evidence |
|-----------|--------|----------|
| One data source | **Done** for discovery, picker, preview, manifests and delegation: the registry (`buildContextRegistry`) feeds `getCursorContext` and `assemble`, with the same stable IDs | `tests/context-migration-validation.test.js` (one data source), `tests/context-registry.test.js` |
| One builder | **Partial, by decision.** `assemble(context, adapter)` builds previews, snapshots and manifests and is proven equal to the legacy blocks of both send paths. The real send path still calls the legacy `apply*OutboundPrompt` functions; no setting switches it to the assembler | comparison tests; see "Comparison mode decision" |
| Clear boundaries, activation, snapshots | Done: authorized project root, host-only sources, explicit skill activation, per-send manifest and preview | stage 03-05 docs and tests |
| Portable formats | Done: `AGENTS.md`, `SKILL.md` (YAML frontmatter), `.cursor/rules`; `.cretli/context.json` carries settings only and cannot assign host sources | `tests/agents-md-context.test.js`, validation test |
| Measured repetition reduction | Done, opt-in: `instructions.dedupe = proven_adapters` skips the repeated static block only for the Claude adapter with a native session id. Default is delivery on every turn | validation test measures the characters saved over five turns and asserts the saving equals one static block per skipped turn |
| Controlled rollback | Done, see below | validation test (rollback) |

Instructions are never lost: the message, the first-turn static block, plans,
seeds and AGENTS.md follow the "required" class of the context budget, and every
epoch boundary (new session, failed resume, compaction, history trim, restart)
delivers the static block again.

## Comparison mode decision

`CRETLI_CONTEXT_BUILDER=compare` is **kept**, not disabled. It is observational
(`defaultResult: 'legacy'`), costs nothing when unset, and is the safety net for
the next step. The unified builder is **not** made the send default in this
migration, because the legacy send path still carries behaviour the registry
deliberately does not replicate (tolerant frontmatter scanner, parent-directory
skill walk-up; the registry marks such entries invalid or without an ID). Any
value other than `compare` resolves to `legacy`. Switching the send path is a
separate, later change that needs: no differences in `compareAllAdapters` on real
projects, a live test per adapter, and an explicit setting with a rollback.

## Live test coverage

No live provider run was possible here. Verified through the real send path in
tests: runtime SDK, session harness (Claude) and OpenRouter. Opencode, codex,
deepseek, qwen, codebuddy, mimo, mistral and zai are covered by adapter tests only
and are marked "no live test" in the [matrix](harness-source-matrix.md). Every
harness stays `unknown` for native AGENTS.md reading, so new AGENTS.md content is
not auto-injected anywhere.

## Rollback

Nothing needs a data migration; legacy files (`.cursor/rules`, project skills,
`additionalCursorContextDirs`) are neither moved nor deleted.

| Concern | Switch | Effect |
|---------|--------|--------|
| Builder comparison | unset `CRETLI_CONTEXT_BUILDER` (or `legacy`) | no assembler run on the observation path |
| Skill activation | `CRETLI_SKILL_SELECTION=legacy` (restart) | old keyword heuristic for skill bodies |
| Manifest recording | `CRETLI_CONTEXT_MANIFEST=0` | send manifests are not recorded |
| Instruction dedupe | `instructions.dedupe = off` (default) | static block on every turn |
| Context budget | `budget.mode = off` | no soft-budget warnings |
| AGENTS.md | `agentsMd.mode = off` | never pasted |
| Settings / config | remove `contextSettings`, `contextProfiles`, `contextPolicy` from `config.json`, the chat `contextSettings` field and `.cretli/context.json` | previous behaviour; unknown stored keys are rejected by older builds, so remove them first |
| Code | revert the stage commits in reverse order | each stage is additive |

## Known gaps

- No live harness run (above); no native-read evidence for AGENTS.md.
- Token figures in the budget are estimates (`chars / 4`), not provider counts.
- Window-error enrichment is wired for Claude only.
- The OpenRouter room runner does not call the hydrate/trim helpers outside the
  tested paths in this tree (see stage 06 limitations).
