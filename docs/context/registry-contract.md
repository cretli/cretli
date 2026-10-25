# Context registry contract (stage 1)

Static context entries share one registry shape before harness-specific adapters
assemble a turn. Implementation: `lib/context/registry-contract.ts`.

## Entry kinds

`rule`, `skill`, `command`, `agent` (dynamic blocks such as plans and handoffs
are out of scope for stage 1).

## Stable identity

- **ID:** `source + relPath + kind` via `buildRegistryEntryId(source, relPath, kind)`.
- **Version:** SHA-256 content hash (`computeRegistryContentHash`); hash changes
  when body changes, ID stays stable.
- **Call name:** frontmatter `name` when present; folder name is a fallback for
  skills. Mismatch with the directory name is a validation warning, not a hidden
  drop.

## Manifest and epoch

`buildContextManifest` carries:

| Field | Role |
|-------|------|
| `registryEpoch` | Bumps when registry composition rules or host assignment change |
| `assembledAt` | ISO timestamp for one assembly |
| `projectRoot` | Authorized project root for this chat/widget |
| `contentRevision` | Optional preview revision/hash |
| `entries` | Registry records included in this assembly |
| `warnings` | Non-fatal validation messages |

Send and preview must use the same assembler in later stages; stage 1 exposes
the schema and documents the split.

## Two hierarchies (do not merge)

1. **Name resolution** (`NAME_RESOLUTION_ORDER`): resolves ambiguous `@name` in
   the picker to a single catalog entry. Does not auto-load every skill sharing
   a name and does not delete other IDs.
2. **Instruction precedence** (`INSTRUCTION_PRECEDENCE_ORDER`): stacking order
   for instruction bodies. Host surfaces provenance; harness system layers stay
   outside this list.

## Project config (`.cretli/context.json`)

Optional, versioned (`PROJECT_CONTEXT_CONFIG_VERSION`). May reference only
**project-relative** paths whose realpath stays inside the authorized chat
project root. It must **not** assign host sources (`shared`, `user`, `bundled`,
`host`, or `shared:*`). Validation: `lib/context/project-context-config.ts`.

Host assignments (Settings extra dirs, home skills, bundled mirror) remain in
server configuration only.

## Trust and paths

All reads use `lib/context/source-trust.ts`: realpath, symlink escape checks,
traversal rejection, and per-kind size limits. Widget responses omit private
host roots by default (`audience: widget` on `getCursorContext`).

## Stage 2: shared registry, strict YAML and comparison builder

- **Registry:** `lib/context/registry.ts` (`buildContextRegistry`) scans project,
  bundled, shared and user sources once. Each entry carries origin (`source`,
  `scope`), stable ID, content hash, size, `valid`, `ambiguous` and diagnostics.
  `getCursorContext` (picker + `GET /api/cursor-context`) is a projection of it:
  the legacy lists keep their shape (plus `id`, `valid`, `diagnostics`) and the
  payload gains `registry` (public records, relative paths only).
- **Frontmatter:** `parseFrontmatterChecked` (`lib/skills/frontmatter.js`) uses
  `js-yaml` with `JSON_SCHEMA`, a frontmatter cap (`FRONTMATTER_MAX_BYTES`, 8 KiB)
  and the per-kind file caps from `source-trust.js`. `js-yaml` is a server-only
  dependency; it is not imported from `app_front/`.
- **Invalid entries:** unreadable, oversized, malformed-frontmatter, bad-name and
  trust-rejected entries stay visible with a diagnostic and are never executed.
  Trust-rejected ones (symlink escape, outside root) are not listed in the legacy
  lists and never read.
- **Collisions:** a call name shared inside one source marks every holder
  `ambiguous` (error diagnostic). `resolveEntryByName` refuses an ambiguous name
  and honours an explicit ID.
- **Assembler:** `assemble(context, adapter)` (`lib/context/context-assembler.ts`)
  returns `{ payload, blocks, manifest, warnings }` for the `sdk` and `harness`
  adapters, which stay separate: the SDK path adds no workspace rules and no
  textual mode hint, the non-SDK path adds both.
- **Comparison:** `lib/context/context-compare.ts` diffs each adapter against its
  own legacy blocks. The real send path is unchanged; `CRETLI_CONTEXT_BUILDER`
  defaults to `legacy`, and `compare` only observes.

Rollback: revert the stage-2 commit; the legacy send path and the legacy list
shapes were never switched, so no data or setting needs undoing.
