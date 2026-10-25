# AGENTS.md, instruction scopes and context settings (stage 05)

## AGENTS.md delivery

Code: `lib/context/agents-md.ts`. Wired into the real send path
(`buildDecorationBlocks` in `lib/sdk/harness-plan-prompt.ts`) and into the
comparison assembler (`agents_md` block id).

- **Chain:** AGENTS.md files from the authorized project root (the chat's
  `workspaceFolder`, never a client path) down to the cwd, general first, most
  local last. On conflict the more local file wins; Cretli does not resolve
  semantic conflicts. A cwd outside the root falls back to the root chain with a
  warning. Other subdirectories are only *indexed* (depth 4, 300 dirs, no
  symlink following) and never loaded.
- **Matrix:** `AGENTS_MD_MATRIX` records `native | cretli | both | unknown` per
  harness. **Every harness is `unknown` today**: no captured run or adapter test
  confirms a native AGENTS.md read, and `settingSources` is not proof.
- **Delivery decision** (`resolveAgentsMdDelivery`):
  `off` -> never; `native`/`both` -> never pasted (no double delivery, whatever
  the mode); `cretli` -> pasted; `unknown` + `auto` -> **not** injected, warning
  `agents_md_unknown_not_injected`; `unknown` + `force` -> pasted with warning
  `agents_md_unknown_forced` (the file may reach the model twice).
- **Trust:** realpath/symlink/size checks from `source-trust.js` apply to every
  file; an AGENTS.md symlinked outside the root is reported invalid and never read.

To confirm a harness, change its row in `AGENTS_MD_MATRIX` together with the
evidence (captured run or adapter test). Until then the default sends nothing new.

## Legacy globs

Rules with `globs:` (and not `alwaysApply`) are exposed as a structural index
(`buildGlobScopeIndex`, metadata only). They are **not** activated by general
words in a message. The concrete path read (`GET /api/context-instructions?chatId=&path=`,
`readInstructionsForPath`) returns the ancestor AGENTS.md chain plus the rules whose
globs match that path. Cretli has no file-read hook in the harnesses, so it does
not promise activation on every read.

## Settings layers

Code: `lib/context/context-settings.ts` (pure resolver),
`context-settings-runtime.js` (disk), `lib/routes/context-settings-routes.js`.

`safe defaults -> host global -> project (.cretli/context.json) -> chat`, within
host policy (`contextPolicy.locked`, `contextPolicy.forbiddenValues`). A
**profile** is a named set of the same settings, applied by the same `applyLayer`
step (profile values first, then the layer's explicit values); there is no
second resolver. Host profiles are `contextProfiles`; a project may define its own
under `profiles`.

Settings (only keys the send path reads): `agentsMd.mode` (`auto|off|force`),
`globs.index` (boolean).

`.cretli/context.json` (version 1) may carry `settings` and `profiles`. It cannot
carry host-only keys (`sharedDirs`, `additionalCursorContextDirs`, `sources`,
`assignments`, `shared`, `user`, `home`, `bundled`, `host`, `external`): such a
file is rejected (`host_source_in_repo_config`). Selecting and assigning external
sources stays in host settings outside the repo.

### Storage

| Layer | Stored in |
|-------|-----------|
| host | `data/config.json`: `contextSettings`, `contextProfiles`, `contextPolicy` |
| project | `<project root>/.cretli/context.json` (root of the chat's own folder; in a multi-root workspace each chat uses its own folder's file) |
| chat | chat record, field `contextSettings` |

`additionalCursorContextDirs` stays the stored host value and is read as before;
the effective view shows it read-only (`sharedDirs`). Patching `contextSettings`
never rewrites it, so no owner setting is lost.

### API

- `GET /api/context-settings?chatId=` - effective values with provenance, layers,
  blocked entries, repo-config activity, per-key effect, AGENTS.md chain/delivery,
  nested scopes, glob index. Widgets get no host-only data.
- `PATCH /api/context-settings?chatId=` body `{ level: 'chat'|'host', settings, profiles? }`;
  `null` clears a key. Invalid patches are rejected whole. Widgets: 403.
- `GET /api/context-instructions?chatId=&path=` - explicit path read.

### When a change applies

`agentsMd.mode` and `globs.index`: from the **next turn** (the static block hash
changes, so the block is re-sent). Text already delivered into a running native
session is not withdrawn; use a new session. The chat context panel states this.

## Rollback

All additions are additive. Removing `contextSettings` / `contextProfiles` /
`contextPolicy` from `config.json`, the chat `contextSettings` field and
`.cretli/context.json` `settings`/`profiles` restores previous behaviour; with
defaults (`agentsMd.mode: auto`, all harnesses `unknown`) the sent prompt is
byte-identical to before this stage.
