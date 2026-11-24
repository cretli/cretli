# Workspace Docs

Docs uses ordinary UTF-8 `.md` files under one root per registered workspace.
The existing `<workspace>/docs` directory is the default; if it does not exist,
the module is unconfigured. No directory is created automatically.

## Setup in short

1. Open **Settings → Workspace → Docs** and pick a root: an existing directory,
   `./docs` (created on request) or none. A workspace that already has a `docs/`
   directory uses it without any setting.
2. For a folder outside the workspace (for example a notes vault kept by another
   app), confirm the consent dialog. Consent permits the panel to read and write
   that folder; the separate **agent read** switch lets agents read it too.
3. Open **Docs** in the tab bar. Agents use `doc_*` tools and can only propose
   changes, which you apply or reject in the panel.

## Note format

Notes are plain UTF-8 Markdown with an optional YAML frontmatter block:

```markdown
---
title: Release checklist
tags: [process, release]
cretli_id: 7d1c0b9e-0000-4000-8000-000000000001
cretli:
  todo: 11111111-2222-4333-8444-555555555555
---
# Release checklist

See [[deploy/runbook|the runbook]] and [[Glossary#Terms]]. Inline #tags count too.
```

- `title` wins over the first `# H1`, which wins over the file name. `tags` (list or
  comma/space separated string) and inline `#tags` are merged.
- `cretli_id` is an optional stable identity; together with the content hash it
  lets Cretli suggest a new path after a note was moved outside Cretli.
- `cretli: { todo, initiative, decision }` is a read-only hint, never a link.
- Wikilinks are `[[target]]`, `[[target|alias]]` and `[[target#heading]]`. A target
  resolves relative to the note, then from the root, then by unique base name;
  `.md` is optional. Wikilinks inside code are ignored.
- Managed links (note ↔ Todo/Initiative/Decision) live in the Cretli state store,
  not in the file, so notes stay clean Markdown. A standalone line
  `cretli-ref todo=<uuid>` in a note is a read-only mention.

## Working next to an external notes app

Docs deliberately uses nothing but ordinary files, so another notes application
can open the same folder. This is safe and supported:

- Cretli ignores hidden entries (`.obsidian/`, `.trash/`, sync temp files) and
  every non-`.md` file, and never writes configuration into the folder. Its only
  artefacts are the hidden `.cretli-trash/` directory and short-lived hidden
  `.cretli-write-*` staging directories, removed after each write.
- Edits made by the other app are picked up on the next request (mtime and size
  scan, plus a debounced directory watcher). An open draft in the panel is never
  replaced silently: saving sends the hash of the version that was read, and a
  stale hash opens the reviewed conflict flow.
- Moving or renaming a note in the other app leaves its managed links `dangling`,
  with a suggested new path when `cretli_id` or the content hash matches. Moves
  made inside Cretli rewrite wikilinks and managed links for you.
- Deleting in Cretli moves the note to `.cretli-trash/`; the other app's own trash
  is not used.
- The other app's MCP server, if connected to Cretli, is independent of the Docs
  approval gate (see the end of this document). Use Docs tools for reads you want
  scoped by consent and `agentRead`, and its per-tool policy for the rest.
- Symlinks that leave the root are refused, so do not link a second vault into the
  root; configure that folder as the root instead.

Choose a root with `PUT /api/docs/config`, passing `{ root: "docs" }`, another
workspace-relative directory, or an absolute external directory. `{ root: null }`
clears it. `{ root: "docs", create: true }` explicitly creates a missing directory
under an existing workspace directory; external folders must already exist.
Changing the root clears consent and preserves managed link records.

Human requests supply a registered workspace identity through `workspaceUuid`,
`workspaceId`, `workspaceFile` or `workspaceFolder` (query or body). The server
resolves the identity and home directory; arbitrary folders cannot select state.
Authentication and CSRF use the application's existing HTTP middleware. Agent MCP
requests ignore workspace selectors in query/body and use only the signed token's
workspace identity. Agent login cookies have no workspace binding and receive
`docs-agent-scope-required` (403); use a workspace-bound MCP session for Docs reads.

An external root is determined by realpath containment, even for a relative path
or a symlink. It is unusable until a human calls `POST /api/docs/consent`.
Consent stores the canonical root realpath, time, human grant and `agentRead`
(default `false`). A changed symlink target invalidates consent. A human can
revoke it with `DELETE /api/docs/consent`. Internal roots allow agent reads.
External roots additionally require explicit `{ agentRead: true }` for agents.
`docs-consent-required` and `docs-agent-read-denied` are stable 403 codes.

All direct file/link mutations require an authenticated human session with valid CSRF. Agent
sessions, MCP integration and widget callers receive 403. Agents cannot write
files through these endpoints. Read endpoints follow the external consent and
agent-read rules. The config endpoint exposes consent status even when access
is disabled. Every agent config response uses a sanitized view, including internal
roots and external roots with consent and `agentRead`. The root contains only
`external`, `consented`, `agentRead` and a generic `label`; internal roots add
`internal: true` and, only for a relatively configured root, `relativeHint` with
its folder basename. The consent view contains `granted`, `agentRead` and an
optional grant time `at`. Configured paths, resolved realpaths and the stored
consent record are never returned to agents. Humans retain the full root and
consent configuration. Other read responses use root-relative note paths;
MCP filesystem failures return generic domain messages without host paths.

| Method | Path | Input / result |
| --- | --- | --- |
| GET | `/api/docs/config` | Root, external flag, effective consent and agentRead |
| PUT | `/api/docs/config` | `root`, optional `create` |
| POST | `/api/docs/consent` | Optional boolean `agentRead` |
| DELETE | `/api/docs/consent` | Revoke consent |
| GET | `/api/docs/tree` | Flat bounded `items` with paths, titles, sizes and tags; bounded `skipped` diagnostics |
| GET | `/api/docs/note?path=` | `note`: text, sha256, frontmatter, wikilinks, mentions, tags, managed links and backlinks |
| GET | `/api/docs/search?q=` | Case-insensitive substring search, optional `limit` (1–100) |
| GET | `/api/docs/backlinks?path=` | Derived backlinks and managed links |
| POST | `/api/docs/note` | Create-only `path`, `text`; existing target returns 409 |
| PUT | `/api/docs/note` | `path`, `text`, required `expectedSha256` |
| POST | `/api/docs/note/rename` | `path`, `newPath`, required `expectedSha256` |
| DELETE | `/api/docs/note` | `path`, required `expectedSha256`; returns `trashPath` |

Managed links are read in both directions with `GET /api/docs/links?note=<path>`
or `?target=<kind>:<uuid>` (`todo`, `initiative`, `decision`). Create a link with
`POST /api/docs/links` and `{ note, kind, targetId }`; duplicate creation returns
the existing record. Delete explicitly with `DELETE /api/docs/links/:id`.
Confirm an external move with `POST /api/docs/links/:id/resolve` and `{ note }`
(or use a persisted `suggestedPath`). All three mutations require a human;
agent cookies and MCP tokens receive 403 even with valid CSRF.

Records stay in the Docs state store when either end disappears. Responses mark
`state: dangling`, `noteMissing` and `targetMissing`; external note moves can carry
`suggestedPath` without changing the stored path. Target titles can change without
breaking UUID identity. Missing targets can be restored without recreating links.
Standalone `cretli-ref todo=<id>` lines use the shared Todo reference parser;
code blocks and inline code are excluded. These derived links have
`source: mention`; persisted records have `source: managed`. Frontmatter
`cretli: { todo: <uuid>, initiative: [<uuid>], decision: <uuid> }` is a read-only
hint. `note.linkHints` reports unmatched hints with `conflict: true`; hints never
create links or override the Cretli store.

Read-only MCP tools: `doc_list`, `doc_read`, `doc_search`, `doc_backlinks`.
`doc_read({ path })` includes links, hints and wiki backlinks.
`doc_backlinks({ path })` returns wiki backlinks and links for a note;
`doc_backlinks({ target: "todo:<uuid>" })` (also initiative/decision) returns
reverse links, including dangling records. `doc_search({ q, limit })` searches
note text and titles. Every tool uses the session workspace, never workspace
arguments, and enforces external-root consent and `agentRead`. The in-process
and stdio clients share an explicit operation table. Agent reads
compute dangling state without writing the Docs state file; human refreshes
can persist missing-note diagnostics. Agent proposal tools create decision cards as described below; they never write
notes or managed links.

Paths are NFC, case-sensitive, root-relative POSIX paths ending in `.md`.
Absolute paths, traversal, NUL, hidden components and backslashes are rejected.
Every accessed component is checked with realpath; escaping symlinks are refused.
Parent directories must already exist. Notes are limited to 128 KiB. Writes use
the shared atomic text writer in a private staging directory, then move a complete
temporary file into the destination directory and publish it atomically. Creation
uses an exclusive hard link to avoid replacing a concurrently created file.
A missing hash precondition returns 428; a stale hash returns 409.

Deletion moves a note into `.cretli-trash/` inside the root, hidden from listing;
restore it manually from the returned path. Rename rewrites resolved wikilinks
(including heading/alias suffixes) and managed link paths. The operation has no
async yield during filesystem changes. Multi-file changes are not a filesystem
transaction: `docs-rename-partial` reports completed steps on failure. Inspect
those steps before retrying.

The in-memory index reads YAML frontmatter using the existing `js-yaml` dependency
with JSON schema; cyclic/shared aliases and excessively complex metadata are
rejected as frontmatter errors. The title comes from frontmatter, the first H1,
or the basename. The index derives wikilinks, backlinks, tags and todo mentions. Wikilinks in fenced
code blocks (backtick or tilde) and inline code spans are ignored by both link
parsing and rename rewriting. A blank line ends an inline code span; unmatched
backticks cannot hide links in a later paragraph.
Each request scans file mtimes and sizes; a debounced root-directory watcher invalidates
the cache when available. Limits: 2000 notes, 10000 directory entries, 32 levels,
16 MiB indexed content. Hidden directories are skipped. Invalid names, escaping or
dangling symlinks and unreadable entries do not block healthy notes. Tree responses
include at most 100 `skipped` records (`path` relative to the root, `reason` code);
they never expose resolved external paths. Links to skipped notes have `state: unknown`
and `noteMissing: null` when the target still exists. Once the diagnostic list
reaches its cap, all unindexed note links conservatively use this unknown status
rather than being reported or persisted as missing. Missing targets still make
a link dangling. Direct access still fails closed.
File-count, directory-entry, depth and total-index-size limits remain hard errors. A file moved externally
leaves its managed links dangling; matching previous content hashes or `cretli_id`
suggest a replacement without silently changing link identity.

Roots, consent and managed links persist in `data/docs-state.json` (v1,
`workspaces` keyed by verified workspace UUID). The owner is
`lib/docs/docs-state-store.js`; the registered store is `store.docs-state`,
rank 300, atomic JSON rename, migration `none`. Offline managed backup and restore
include the document; portable settings export excludes it. Note files belong to
the user and require their own backup. The index is disposable and not persisted.


## Docs panel

Open **Docs** from the main tab bar. `/docs?ws=<workspace-key>&folder=<folder-key>`
restores the workspace panel on reload and is an offline shell route; note reads
and writes require a server connection. Note selection and search are local panel
state, without note paths in view URLs. The panel follows the tab's resolved view
context, including workspace changes, rather than the server working directory.

The collapsible directory tree lists notes and exposes skipped entries in a closed
diagnostic notice with translated reasons and a generic fallback for unknown codes.
Search uses the bounded REST index, with a 250 ms input debounce and immediate
search on Enter. The note view shows wiki links, backlinks, managed links,
mentions, dangling targets and conflicting
frontmatter hints. Markdown is converted into an allowlisted tree and rendered
with static Lit tags: raw HTML is escaped, images are labels, event attributes and
frames cannot be created, and active URL protocols are limited to HTTP(S) and
mailto. Fragment links are shown as plain text rather than opening another tab.
Wikilinks resolve locally, then from the root, then by unique basename, matching
the backend without normalizing Unicode target spelling. Code spans and fenced
blocks stay literal.

Edit and preview share an in-memory draft. Save sends `expectedSha256`; a 409
preserves the draft and offers a confirmed reload or a review of the disk version
beside the draft. Replacing a reviewed version sends that version's hash, so a
further disk edit causes another conflict. A missing precondition (428) retains
the draft and offers reload. Focus or tab refresh detects disk changes without
replacing a draft. Dirty drafts are retained separately for each workspace scope while the panel
remains in memory, including switches while it is closed. Returning restores the
draft and checks for disk conflicts. An in-flight save belongs to its original
scope: returning before completion keeps that scope busy, successful completion
retires its stashed draft, and failure preserves it. Completion never updates a
different active scope. Drafts do not survive a full page reload.
Create, rename/move and move-to-trash use `cr-dialog`; all three require saving
or discarding pending edits first. Creation cannot replace an unsaved draft.
Create and rename trim surrounding whitespace from the entered path. Partial
rename errors close the dialog, refresh the tree and show translated completed
steps; the panel re-reads a surviving selected path or clears a vanished selection.
The status live region remains mounted, and the selected tree note carries
`aria-current="page"`.

**Settings → Workspace → Docs** chooses an existing root, explicitly creates or
uses `./docs`, or disables the module. External roots have a consent dialog showing
the canonical path. Consent permits panel access; the separate agent-read switch
additionally permits agents to read notes. Revocation disables external access.
The tree can collapse and the sidebar stacks below the note on narrow screens.

## Known limitations

- Markdown tables interpret an unescaped `|` as a cell separator, including in
  `[[note|alias]]`. Escape the pipe as `[[note\|alias]]` inside a table cell.

- F3: on a cross-folder rename, the moved note's own relative links to other notes
  are not rewritten. Review and adjust those outgoing relative links manually.
- F4: realpath checks on intermediate directory components have a TOCTOU window
  if another writer inside the root changes directories concurrently. `O_NOFOLLOW`
  protects only the final component of a file read; intermediate directory checks
  do not provide an atomic filesystem sandbox against such a concurrent writer.

## Todo links and chat references

Todo details (the Notes tab) and Initiative details include the same Docs section.
It shows note titles, root-relative paths and dangling links. Link note searches
existing notes; unlink removes only the managed relationship. Derived mentions
remain read-only. Open in Docs switches panels and selects the note locally,
without placing the path in the route. All link mutations use the human REST
client with workspace scope and CSRF protection.

Typing `@doc` or `@doc query` opens a keyboard-accessible note picker. It checks
agent access before listing notes, including the separate `agentRead` grant for
external roots. Choosing a note replaces the trigger with a standalone
`cretli-ref doc=<path>` line. Paths containing whitespace or quotes use a JSON
string as the value, for example `cretli-ref doc="project notes/design.md"`.
The parser validates the decoded value with the same path contract as note access;
extra arguments are rejected. Control characters are rejected in all note paths.
Sending adds a short `doc_read({ path })` instruction; it never pastes note text.
The existing `@todo` and continue flows retain their own picker and behavior.

Todo start prompts (direct, full orchestrator and plan refinement), warm
continuations and Workspace Watcher cycles list managed linked notes as titles
and paths only. The async caller resolves the todo workspace through Docs with
agent permissions, then supplies metadata to the synchronous prompt generator.
There is no listing for an unlinked todo or a root the agent cannot access.
Missing-note links remain marked as dangling. Lists contain at most 12 entries
and 2400 characters, including a truncation notice; `doc_backlinks` retrieves the
remaining links. Watcher prompts reserve a separate bounded allowance for this
metadata, so linking notes cannot make a previously fitting cycle contract fail.
The agent-context service examines only the requested todo's managed links,
inspects at most 50 linked notes and checks the single todo target once. It does
not resolve unrelated workspace targets or scan the whole note tree. All async
start/continuation/watcher callers share a 1500 ms helper deadline. Timeout or
failure returns empty context with a generic status (`timeout`, `error`, or
`unavailable`), never an exception or host path; timers are cleared and remaining
work is aborted cooperatively. Bounded file reads yield between notes so the
deadline can stop subsequent reads. Existing filesystem operations are synchronous
and cannot be preempted halfway through a single read.

Before JSON quoting, title metadata replaces C0/C1 controls, Unicode line and
paragraph separators, bidi/format controls, zero-width characters, variation
selectors and BOM with spaces, then collapses whitespace. Paths undergo the same
check; a path requiring alteration is omitted rather than renamed in the pointer.
Omissions retain the truncation notice. The 12-entry and 2400-character limits
are measured after sanitization and JSON escaping. The agent can check access
and remaining links with the read-only Docs tools. No note content is
added to context manifests or the SDK prompt pipeline.

## Agent proposals and human approval

`doc_propose_write({ path, text })` proposes creating or replacing a note;
`doc_propose_append({ path, text })` appends text exactly, without adding a newline;
`doc_propose_link({ path, target: "todo|initiative|decision:uuid" })` proposes
adding a managed relationship. These mutating MCP tools are available in Agent
mode and enforce the same target path, external consent and `agentRead` checks
as reads. They create only a `doc_proposal` decision, never a note or link.
The in-process client calls the Docs service; stdio uses
`POST /api/docs/proposals/write`, `/append` or `/link`. These endpoints require
a workspace-bound MCP bearer with a chat id; human cookies and agent login
cookies are refused. Workspace and proposing chat come exclusively from MCP
claims, ignoring request-body and query selectors. The global API gate admits
only the additional `/api/docs/` prefix for MCP integration sessions, so the
stdio client's read routes also reach Docs. Each Docs route then enforces its
own permissions: direct file/link/config/consent mutations still require a human.
The widget-session gate is unchanged; other host API paths remain unavailable
to MCP integration sessions.

The server stores the new text or link tuple, workspace UUID, root fingerprint,
base note SHA-256 and (for links) Docs state revision inside the decision card.
Proposed note text (the complete resulting note for append) is limited to
128 KiB of UTF-8 bytes, independently of JSON escaping. Metadata, including scope
and proposing chat, has a separate 4 KiB JSON limit; errors name the exceeded
limit. In addition, each new serialized decision card has a 48 KiB budget,
including a 4 KiB reservation for store-generated and resolution metadata.
Diff evidence is capped at 48 Ki characters and 128 KiB of UTF-8 bytes, then
shortened further to fit the card with an explicit truncation flag. Full proposed
text is retained exactly; it is never truncated before approval. If the payload
alone cannot fit, `docs-proposal-card-too-large` (413) asks for a smaller change.
Thus a note within the 128 KiB note limit can still exceed the separate card
budget, especially after JSON escaping. New cards store text directly; earlier
base64-encoded cards remain readable and resolvable.

At most 20 pending or currently resolving cards are allowed per workspace and
proposing chat. All chats in a workspace additionally share a 1 MiB pending-card
budget, counting serialized stored cards and reserving the entire incoming card
budget. `docs-proposal-workspace-limit` (429) asks the human to resolve a card
first. Admission is serialized per workspace within the server process, so
concurrent calls from different chats cannot bypass that budget. The pending
Docs cards stay below 1.5 MiB even with resolution metadata growth.
Identical pending proposals are rejected by a hash of operation, path, full text
or link change, and base SHA-256 (`docs-proposal-duplicate`, 409).
The count cap returns `docs-proposal-limit` (429); resolving a card frees both
count and pending-byte capacity. These errors do not include note or host paths.
The panel shows at most 16 Ki characters of diff with an explicit truncation
notice and expandable full proposed content.

**Storage limitation:** resolved and stale cards retain their payload as history.
The current shared decision query reads the complete workspace history before
Docs selects the latest 100; it has a 4 MiB worker-result limit. The new per-card
and pending-workspace budgets prevent pending Docs proposals alone from exhausting
that result, but do not bound accumulated history or other decision kinds.
Existing oversized cards are not migrated. A large history can still make listing
and proposal admission fail. Durable payload compaction after resolution or paged
history reads require changes in `lib/storage/decisions-store.js` and the shared
decision store/resolution callers, outside this Docs leaf's scope. No history is
silently removed or compacted here.

**Docs → Agent proposals and edit history** lists pending, stale and resolved
cards for the workspace (latest 100). It displays the proposing chat/time,
changes as literal text, and the human decision actor/time. Human viewers alone
can list proposals through `GET /api/docs/proposals`; agents cannot enumerate
other chats' payloads there. Apply/reject uses the existing human-only
`POST /api/decisions/:id` with the card revision. Apply checks root identity,
current agent access, note hash and link revision again, then publishes the
exact proposed content atomically or adds the proposed relationship. A changed
or deleted base, changed root, revoked grant or link revision conflict makes the
card stale without applying it. Rejection changes neither files nor links.
Repeated/concurrent resolutions return 409 after the first claim and do not
repeat the effect. Both human resolutions retain the decision audit record;
resolved cards retain the payload and proposing chat as edit history.

The kind is medium risk, irreversible and human-only, always recommends reject,
and takes no timeout action. It cannot be created with `decision_request`,
auto-approved, promoted through autonomy, swiped, answered by voice in car mode,
or resolved through a push action token. Touch controls remain available.
An external MCP server that independently writes the same folder is outside
this approval boundary; configure its per-tool policy separately.

## Audit

Final cross-cutting audit (leaf "Docs 7"). Every check was verified against the
code on this branch; the guards marked with a test are in `tests/docs-audit.test.js`
or the named suite and keep running in `npm test`.

| Check | Result |
| --- | --- |
| Path traversal: absolute, `..`, hidden, backslash, control and non-NFC paths rejected by one shared contract (`isDocPath`) used by REST, MCP, `@doc` and prompts (`docs-backend`) | pass |
| Symlinks: every component is realpath-checked, final read uses `O_NOFOLLOW`, escaping, cyclic and non-Markdown targets are refused or skipped, trash directory re-validated (`docs-backend`) | pass |
| Markdown XSS: `html: false`, allowlisted tree, static Lit templates, no `innerHTML`/`unsafeHTML`, URL allowlist (http, https, mailto), links `noopener noreferrer` (`docs-audit`, `docs-panel`) | pass |
| Size limits: 128 KiB notes (also checked before and after read), 4 KiB proposal metadata, 48 KiB card, 1 MiB pending budget, 20 pending per chat, 256-char query, index limits for notes, entries, depth and bytes | pass |
| External root consent: bound to the root realpath, cleared when the root changes or the symlink is retargeted, separate `agentRead`, re-checked when a proposal is applied (`docs-backend`, `docs-proposals`) | pass |
| Human/agent boundary: every non-GET route except proposal creation requires a human session with CSRF; proposal routes require a workspace-bound MCP chat and refuse humans, widgets and login agent cookies; the route list is enumerated so a new route cannot skip the check (`docs-audit`) | pass |
| Agent proposals never write: apply/reject only through the human-only decision route, with revision, base hash and link-revision re-checks (`docs-proposals`) | pass |
| Absolute-path leaks: agent config view is sanitized, skipped diagnostics and errors use root-relative paths, MCP maps native fs errors to generic codes; only the human config view returns the root realpath for the consent dialog (`docs-routes`, `docs-agent-context`). Defect found: agent proposal responses (REST, stdio and in-process `doc_propose_*`) spread the stored decision card, exposing its absolute `workspaceFolder`; they now return a whitelisted view without it (`docs-proposals`) | fix |
| Rename/delete/write concurrency: hash preconditions (428/409), exclusive create, atomic publish, partial rename reported with completed steps | pass |
| Docs accuracy: setup, note format, wikilinks, managed links, MCP tools, proposals, consent and external-app workflow documented here; `docs/ARCHITECTURE.md` and `docs/mcp/SETUP.md` point to this file | fixed (added setup, note format and external-app sections) |
| CHANGELOG: one coherent Docs entry under Added and one under Fixed instead of seven fragments | fixed |
| Repo rules: English comments, pl/en i18n parity for all `docs.*` keys, no Polish literals in components, `var(--cr-*)` tokens only in the Docs stylesheet, no private names or host paths (`docs-audit`, `i18n-dictionaries`) | pass |
| New regression guards: human-only route enumeration and static source rules | added (`tests/docs-audit.test.js`) |

One code defect was found and fixed: absolute `workspaceFolder` leaked in agent proposal responses (see the absolute-path row). Known limitations (F3, F4,
unpaged decision history, table pipes in wikilinks) are listed above and unchanged.
