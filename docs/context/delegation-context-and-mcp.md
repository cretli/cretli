# Delegation context manifest and the `context_manifest` MCP tool

Stage 07 of the context unification plan.

## Profiles (`lib/context/delegation-context-profile.ts`)

The delegation role selects a profile: `review`, `implement` or `plan`
(`workRole: plan`). All three currently share one policy: the child does **not**
inherit the global skills catalog; it gets only the skills the parent selected
by ID (`selected_skill_ids`, delivered as selected-skill blocks, mentions are
never parsed). Scope-matched `alwaysApply` rules and AGENTS.md keep following
their normal rules. The profile is applied in the real send path
(`harness-plan-prompt.ts`, resolved from the child chat via
`findDelegationByChildChatId`) and in the assembler, so the manifest matches
what is sent. Non-delegation chats are unchanged.

## Manifest (`lib/context/delegation-context-manifest.ts`)

Content-free (ids, hashes, sizes, reason codes), with separate fields:
`instructions` (profile, delivered and skipped entries), `task`, `handoff`,
`reports`, `omitted` (each source not delivered, with a reason, e.g.
`skills_catalog`, `parent_transcript`), `limits` (the legacy character limits:
task 100000, report 8000, handoff 24000) and `activation`. Bounded fields show
`overLimit` / `truncated`. `buildChatContextManifest` produces the same shape
for the parent; `compareContextManifests` diffs the two by stable entry ID.

## MCP tool `context_manifest`

Read-only (allowed in Plan mode). `delegation_id` returns the child manifest and,
unless `compare: false`, the parent manifest plus a comparison; without it the
calling chat's own manifest. Scope: the caller must be the parent, controller,
root or child chat of the delegation and the delegation must belong to the
caller's workspace; otherwise `NOT_FOUND` (no existence leak). Reading never
activates a skill, never marks a report delivered and never changes permissions.
