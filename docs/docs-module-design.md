# Docs module — design decisions

Status: proposal for human review. Written by leaf 1 (`8d337ab2`) of the Docs plan
(root todo `3b74a185`). Leaves 2-6 build on the decisions below; leaf 2 stays `idea`
until a human has read this file. No code changed in leaf 1.

Citations are `path:line` against the working tree at the time of writing. Where a
decision departs from the plan text, it says so and lists the departure again under
[Decisions for the human](#decisions-for-the-human).

## 1. What the module is

A per-workspace set of plain `.md` files (Obsidian-compatible) shown in a `docs` panel,
linked to Todo, Initiatives and Decisions, readable by agents and writable by agents only
through a human-approved proposal. Cretli is not an Obsidian clone: no graph view, canvas,
plugins or sync.

## 2. Reconnaissance summary

| Area | What exists | Consequence for Docs |
| --- | --- | --- |
| Workspace identity | `resolveWorkspaceScope` (`lib/workspace-scope.js:14`) and the initiatives scope helper (`lib/initiatives/initiatives-service.js:90`) resolve a verified `workspaceUuid`; the registry itself lives in `config.json` (`lib/persist/workspace-registry.js:2`). | Docs state is keyed by `workspaceUuid`, never by a client-supplied folder. |
| Initiatives | Dedicated SQLite domain (`lib/storage/initiatives-store.js`, schema `lib/storage/schema/0010-initiatives.js`); link kinds are a closed list `['todo','decision','research','git']` (`lib/initiatives/constants.js:11`, enforced at `lib/storage/initiatives-store.js:199`). REST in `lib/routes/initiatives-routes.js`; actor `human`/`agent` derived per request (`:24`); matrix in `docs/development-plans.md:79-92`. | Best template for REST/MCP/panel wiring. Its link table is initiative-scoped, so it is not reused for note links (see D4). |
| MCP wiring | Tools are plain objects with `readOnly` (`lib/mcp/builtin/initiative-tools.js:26`), registered by spreading into `BUILTIN_TOOLS` (`lib/mcp/builtin/catalog.js:5-6,40-41`). They reach data through a client method (`requireClientMethod(client, 'initiativeRequest')`, `lib/mcp/builtin/initiative-tools.js:6-11`), implemented twice: in-process (`lib/mcp/mcp-inprocess-client.js:1051`) and remote/stdio over REST (`lib/remote-api-client.js:882`), driven by one op table (`lib/initiatives/initiative-ops.js:1-15`). | Doc tools need the same op-table + two client methods. Those two client files are not in any leaf scope today (see section 11). |
| Decisions | Closed server risk table `POLICY` (`lib/decisions/decision-store.js:6-17`); `classifyDecision` throws on unknown kinds (`:104-109`); a card needs a subject with `todoId`/`chatId`/`delegationId`/`findingId` and `subject.updatedAt` (`:115`). Effects run in `executeDecision` (`lib/decisions/decision-adapters.js:64-79`). Human channel: `isHumanDecisionRequest` (`lib/routes/decisions-routes.js:17-20`) built on `isAgentSessionRequest` (`lib/auth.js:303-306`). Contract: `docs/decision-cards.md` (Contract, Server risk policy, Human channel). | `doc_proposal` is a new row in `POLICY`, with an effect branch in `executeDecision`. |
| Agent context | `@todo` is a picker trigger (`app_front/features/chat/todoMention.js:46`); the chosen todo travels as a `cretli-ref todo=<id>` line (`:115`, `lib/todo-ref.js:53`), and the agent loads it with `todo_show`. The composer owns the picker (`app_front/features/chat/services/chatComposer.js:12,16,281`), the send handler appends the ref (`chatSendHandlers.js:15`). `context_manifest` (`lib/mcp/builtin/context-tools.js:55`) is content-free (ids, hashes, sizes). | `@doc` follows the same pointer pattern; content is fetched by `doc_read`, not pasted (token economy). |
| Files panel | `lib/routes/files-routes.js` reads workspace files; its containment check is lexical (`lib/files-list.js:45-49`, `startsWith`), not realpath-based. | Do not reuse it for Docs: symlink escape needs a realpath check written in `lib/docs/**`. `writeTextAtomic` exists (`lib/persist/atomic-write.js:391`) and is reused for note writes. |
| Panels | `plans` is the template: `lib/spa-routes.js:5-21,266`, `public/sw-routes.js:17-35`, `public/index.html:345,2920`, `app_front/app/appShell/panelRegistry.js:8-9`, `panelRouter.js:353-355`, `bootApp.js:233-234`; pinned by `tests/initiatives-panel.test.js:94`. | See the checklist in section 9. |
| Obsidian MCP | External tools `obsidian_list_vaults`, `obsidian_list_files`, `obsidian_read_file`, `obsidian_search`, `obsidian_create_note`, `obsidian_update_note`, `obsidian_append_to_note`, `obsidian_get_active_file`, `obsidian_open_file`. User-connected, not part of the repo. | See section 8. |

## 3. Decisions

### D1 Default root location

**Decision.** The default root is `<workspace home>/docs`, used only if that directory
already exists. Otherwise the module is "not configured" and the panel offers three
explicit choices: create/use `./docs`, pick another folder inside the workspace, or pick an
external folder (needs consent, D5). Nothing is created or scanned until a human chooses.
A root inside the workspace needs no consent; "inside" is decided on realpaths.

**Rests on.**
- Workspaces are folder- or file-based registry rows (`lib/persist/workspace-registry.js:2`), so a workspace home exists to anchor a relative root.
- Silent scanning of unconfigured folders would be a read outside user intent; Browser follows the same "nothing reachable until allowed" default (`lib/browser/policy-store.js:1-7`).
- `docs/` is the conventional location, and the existing code treats the workspace home as the trust boundary (`lib/files-list.js:75-81`).

**Not chosen.** `<workspace>/.cretli/docs`: `.cretli/` holds machine config such as
`apps.json` (`docs/apps-and-ports.md`, Agents section), which projects often gitignore;
notes the team wants to share would vanish from version control.

### D2 Note identity and rename handling

**Decision.** Identity is the root-relative POSIX path (case-sensitive, NFC-normalised,
`.md` only). An optional frontmatter key `cretli_id: <uuid>` is honoured when present but
is never written automatically. Renames:

1. Through Cretli (human REST rename): one operation renames the file, rewrites `[[...]]`
   links that point at it, and updates link-store rows. Atomic from the caller's view; a
   partial failure is reported, not hidden.
2. Outside Cretli (Obsidian, git, shell): the index refresh sees the old path missing. If a
   file with the same `cretli_id`, or the same content sha256 and a different path, appears
   in the same refresh, the link rows become `dangling` with `suggestedPath`. A human
   confirms the move. Rows are never rewritten or deleted silently.

**Rests on.**
- Obsidian itself identifies notes by path and rewrites wikilinks on rename, so path identity keeps files portable and avoids writing Cretli ids into a user's vault.
- Plan acceptance: "deleting/moving it does not silently drop links (dangling links are flagged)" (root plan, Acceptance).
- Todo/Initiative links already treat a vanished target as a visible state, not a deletion: `linkRows` marks `todoMissing` (`tests/initiatives-panel.test.js:80-92`).

**Not chosen.** Mandatory frontmatter ids: would modify every note on first link and
break read-only or external vaults.

### D3 Link semantics: what is a link

Three kinds, kept apart so the UI can say where a link came from:

| Kind | Source | Persisted by Cretli |
| --- | --- | --- |
| `wikilink` | `[[note]]`, `[[note#heading]]`, `[[note\|alias]]` in note text | No, recomputed by the index; backlinks are derived |
| `mention` | `cretli-ref todo=<id>` lines in note text (recognised by the same pattern as `lib/todo-ref.js`) | No, derived; shown as "mentioned", not as a managed link |
| `managed` | note <-> todo / initiative / decision, created by a human | Yes, in the Docs state store (D4) |

### D4 Link storage and where Cretli-side state persists

**Decision.** Managed links live on the Cretli side, in one new registered JSON store
`store.docs-state` (`docs-state.json`). The same file holds the per-workspace root and its
consent record (D5). Frontmatter is never auto-written. If a note carries a frontmatter
`cretli:` block, it is read as a hint and shown, but **the Cretli store wins on conflict**;
a mismatch is reported in the note's link panel, not "healed" in either direction.

Shape (`schemaVersion 1`, keyed by `workspaceUuid`):

```json
{
  "v": 1,
  "workspaces": {
    "<workspaceUuid>": {
      "root": { "path": "docs", "external": false },
      "consent": null,
      "links": [
        { "id": "<uuid>", "note": "plans/auth.md", "kind": "todo|initiative|decision",
          "targetId": "<uuid>", "createdAt": "<iso>", "createdBy": "human|proposal:<decisionId>",
          "state": "ok|dangling", "suggestedPath": null }
      ]
    }
  }
}
```

**Why a new file and not the alternatives.**

| Option | Verdict | Reason |
| --- | --- | --- |
| Reuse `store.config-settings` | Rejected | `config.json` is exported as `portable-settings-v1` with every field classified `portable`/`machine`/`secret`/`transient` and unclassified fields reported as omissions (`docs/backup/archive-profiles.md:45-52`). An absolute external path and a consent record are machine-bound and must not travel to another machine through a settings export. `config.json` also carries an in-memory cache (`docs/storage-registry.json:549-575`), so every link edit would rewrite the global settings file. |
| Extend the initiatives SQLite store | Rejected | Needs a schema migration `0011`, a worker handler, and a change to the closed `LINK_KINDS` list (`lib/initiatives/constants.js:11`). Links here are note-centric and cross three domains; the initiatives store is initiative-scoped and its lock-order slot sits among the worker stores (`docs/storage-registry.json:34`). Cost and blast radius are far above the benefit for a few thousand small rows. |
| New managed JSON file, registered | **Chosen** | Exactly the `browser-policy.json` precedent: small per-workspace JSON, atomic rename, `stays-file`, migration `none` (`docs/storage-registry.json:1099-1125`, `docs/storage-callers.md:57`, `docs/storage-registry.md:90`). |

**Consequences.**
- Unregistered files in `data/` are not backed up (`docs/backup/archive-profiles.md:99`), so the store must be registered (checklist rows R1-R5). The caller table is also machine-checked: `tests/storage-callers-contract.test.js` fails the suite if the new store has no row in `docs/storage-callers.md` or if its owner is not `stays-file: <reason>` (`tests/storage-callers-contract.test.js:12,52-57,68-71,98`), so R4 and R4a are mandatory for leaf 2, not documentation polish.
- Because consent and links share one file, leaf 3 needs **no** storage files of its own; the plan's contingency ("if leaf 3 needs a Cretli-side link store, leaf 1 updates leaf 3's scope") resolves to "no change" provided leaf 2 owns the store module (`lib/docs/docs-state-store.js`) and leaf 3 only extends the `links` section through it.
- Writers: HTTP routes in `lib/routes/docs-routes.js` and, after leaf 6, the proposal effect in `lib/docs/**`. Locking is in-process read-modify-write, as for `store.browser-policy`.
- Lock-order rank: next free after `store.browser-policy` (290), i.e. 300, appended to `lockOrderHint` (`docs/storage-registry.json:49`). `validate-storage-registry.js:141-143` rejects a hint that names an unknown store, so entry and hint must land together.

### D5 Consent model for an external root

**Decision.** A root is external when its realpath is not inside the workspace home
realpath. An external root is unusable (no tree, read, search, write; no agent read) until a
**human** has stored consent. Consent:

- is granted only through a human-only REST call (`isHumanDecisionRequest`); there is no agent-initiated consent card, because the human chooses the root in the panel and the choice itself is the prompt;
- is stored in `store.docs-state` as `{ realpath, grantedAt, grantedBy: "human", agentRead: false }`;
- is bound to the **canonical realpath**. If the configured path later resolves elsewhere (symlink retarget, moved mount), consent no longer matches and the root is unusable until re-granted;
- is revocable (`DELETE`), which immediately disables access;
- survives a restart (read from the file) and is not copied by settings export (D4).

**Decision.** `agentRead` is a separate flag, default `false` for external roots, so an
external vault can be used in the panel without exposing it to agents. For roots inside the
workspace `agentRead` is implicitly true. (Plan text says "no consent -> read refused"; this
is stricter and flagged for approval, see Decisions for the human.)

**Rests on.**
- The consent *pattern*: `port_expose` asks per action and never persists (`docs/apps-and-ports.md:527`), Browser persists a workspace allowlist but still re-checks hard blocks (`docs/browser-runtime.md:478`, `lib/browser/policy-store.js:1-7`). A root is long-lived, so it follows the persisted Browser model, not the one-shot port model.
- The human-channel rule: cookie session + CSRF, rejecting agent sessions (`lib/auth.js:303-306`, `lib/routes/decisions-routes.js:17-20`, `docs/decision-cards.md` "Human channel and threat model").
- Browser consent "changes only the allowlist" and does not override hard blocks (`docs/browser-runtime.md:478`); likewise consent here never overrides the realpath containment check (leaf 2) or the `.md`-only rule.

### D6 REST surface

All routes take the workspace from the verified server resolver (`workspaceUuid`,
`workspaceId`, `workspaceFile` or `workspaceFolder`), exactly as
`lib/routes/initiatives-routes.js:6-24` does. Registered from `lib/register-app-routes.js`
next to `registerInitiativesRoutes` (`:253-254`). Routes live in
`lib/routes/docs-routes.js`; logic in `lib/docs/**`.

| Method + path | Who | Notes |
| --- | --- | --- |
| `GET /api/docs/config` | human, agent | Root, `external`, consent state (no secrets). Agent sees `agentRead`. |
| `PUT /api/docs/config` | **human** | Set or clear the root. External roots stay unusable until consent. |
| `POST /api/docs/consent`, `DELETE /api/docs/consent` | **human** | Grant (with `agentRead`) or revoke. |
| `GET /api/docs/tree` | human, agent* | Bounded listing, `.md` only, hidden dirs skipped. |
| `GET /api/docs/note?path=` | human, agent* | Returns text, `sha256`, parsed frontmatter, links, backlinks. Size-capped. |
| `GET /api/docs/search?q=` | human, agent* | Index search, bounded results. |
| `GET /api/docs/backlinks?path=` | human, agent* | Derived from the index plus managed links. |
| `GET /api/docs/links?note=` / `?target=<kind>:<id>` | human, agent* | Two-way lookup (leaf 3). |
| `POST /api/docs/note` (create), `PUT /api/docs/note` (write, `expectedSha256`), `POST /api/docs/note/rename`, `DELETE /api/docs/note` | **human** | Atomic write; stale `expectedSha256` -> 409. |
| `POST /api/docs/links`, `DELETE /api/docs/links/:id`, `POST /api/docs/links/:id/resolve` | **human** | Managed links; `resolve` confirms a suggested move. |

`*` agent reads additionally require `agentRead` (D5). Every **human** row returns 403 to an
agent session and to MCP integration or widget callers; the check is the shared helper
`isHumanDecisionRequest` (`lib/routes/decisions-routes.js:17-20`, reused by
`lib/routes/initiatives-routes.js:9`). One test per mutating route, as in
`tests/initiatives-routes.test.js` (agent headers -> 403).

### D7 MCP surface

Defined in `lib/mcp/builtin/doc-tools.js`, spread into `BUILTIN_TOOLS` in
`lib/mcp/builtin/catalog.js` (as `INITIATIVE_MCP_TOOLS`, `:6,41`). Tools reach data through
a new client method `docRequest({ op, scope, args })` backed by an op table
`lib/docs/doc-ops.js` (pattern of `lib/initiatives/initiative-ops.js:1-15`), implemented in
both `mcp-inprocess-client.js` and `remote-api-client.js`.

| Leaf | Tools | `readOnly` | Mode |
| --- | --- | --- | --- |
| 3 | `doc_list`, `doc_read`, `doc_search`, `doc_backlinks` | true | all modes (read-only tools pass Plan/Ask/Scout, `lib/mcp/builtin/catalog.js` `denyMutatingBuiltinTool`) |
| 6 | `doc_propose_write`, `doc_propose_append`, `doc_propose_link` | false | Agent mode only; **not** added to `MCP_PLAN_MODE_OPEN_TOOLS` (`lib/mcp/mcp-tool-names.js:57`), which is reserved for single-record, create-only tools |

`doc_read` returns links and backlinks for the note, so no separate `doc_links` tool is
needed. No MCP tool mutates a file or a link; proposals only create a card (D8).
Exact tool-name lists are pinned in a test (pattern `tests/initiatives-routes.test.js:74-80`).

### D8 `doc_proposal` decision kind

**Card.** Created by the three `doc_propose_*` tools via `createDecision`, never by the
generic `decision_request`.

| Field | Value |
| --- | --- |
| `kind` | `doc_proposal` |
| `subject` | `{ chatId, updatedAt: <proposalId>, docPath, baseSha256, proposalKind: "write\|append\|link" }`; `chatId` satisfies the subject rule at `lib/decisions/decision-store.js:115` |
| `evidence[]` | unified diff (size-capped) and the proposing chat/time |
| payload | new content (or link tuple), capped at 128 KiB, stored in the card document so no extra store is registered (cards persist whole documents, `lib/storage/decisions-store.js:57-69`; `store.decisions` is already registered and backed up) |
| options | `apply` (effect: writes exactly the shown diff), `reject` (effect: nothing changes) |
| `recommended` | `reject` (a file write is never pre-selected) |
| `onTimeout` | `nothing` |

**Risk row** (`lib/decisions/decision-store.js:6-17`, `docs/decision-cards.md` risk table):

| Kind | Minimum risk | Reversible | Human only |
| --- | --- | --- | --- |
| `doc_proposal` | medium | no | **yes** (recommended; plan said `no`, see below) |

**Why `humanOnly: true` instead of the plan's `false`.** With `false`, four things still
reach a file write:
1. After 20 consecutive "accept the recommendation" decisions the autonomy layer proposes a `policy_upgrade` card for the kind (`lib/decisions/decision-autonomy.js:147-163`; the only skip is `HUMAN_ONLY_KINDS`, `:12,152`). `canAutoDecide` would still refuse (needs low risk and reversible, `:68`), but the nag card and any future table change would weaken "no auto-approve" (`docs/decision-cards.md` autonomy section).
2. Car mode lets non-human-only cards be decided by voice; human-only cards accept touch only (`app_front/features/car/carChoice.js:11,24,40`).
3. Gesture decisions are allowed for non-human-only cards (`docs/decision-cards.md`, "Human-only cards must be decided by an explicit UI action, with no gesture, push action token, timeout recommendation, automatic decision, or autonomy policy").
4. `recommended` could be mis-set by a producer.

`humanOnly: true` in `POLICY` plus adding the kind to `HUMAN_ONLY_KINDS` in
`decision-autonomy.js:12` (and the mirror list in `carChoice.js:24`, which already honours
`card.humanOnly` at `:40`) closes all four. This costs two files outside leaf 6's scope
(section 11).

**Push-token decision: UI only.** A `doc_proposal` is never resolvable from a
push-notification token.
- It is already excluded by construction: `resolveYesNoOptions` requires `risk === 'low'`, `reversible === true` and `humanOnly === false` (`lib/decisions/decision-push.js:34-35`), none of which hold.
- It is also added to `NEVER_TOKEN_KINDS` (`decision-push.js:14`), because that list is the explicit, kind-based guard checked again on the token route (`lib/routes/decisions-routes.js:73`), independent of a later change to the classification table. Defence in depth, one array element.
- The push payload for the card is the plain deep-link (`decision-push.js:91`), no actions.
- The plan default (UI only) is confirmed; there is no reason to overrule it.

**Effect (`executeDecision`).** A new branch before the generic chat-notice path
(`lib/decisions/decision-adapters.js:71`), otherwise a `chatId`-only subject would be
answered with a notice and nothing would be applied. The branch:
1. verifies the card carries a server-written proposal payload (a card minted without one is refused);
2. re-reads the note and compares `sha256` with `baseSha256`; mismatch -> card goes `stale`, nothing written (external edit after the proposal);
3. applies exactly the proposed change through the same atomic write used by the human REST route, records who/when/which chat in the edit history;
4. `reject` writes nothing; the decision audit line is still written (`lib/routes/decisions-routes.js` `audit`).

**Anti-forgery.** `decision_request` passes `kind` through (`lib/decisions/decision-request.js:49`,
`lib/mcp/builtin/decision-tools.js:12`). Once `doc_proposal` is in `POLICY`, an agent could
mint such a card. The effect branch refuses cards without a proposal payload (step 1), and
`decision-request.js` must additionally reject reserved kinds (`doc_proposal`) from
`decision_request`.

**Resolution channel.** Existing decision route only (cookie + CSRF, not an agent session,
`lib/routes/decisions-routes.js:17-20`, `docs/decision-cards.md` "Human channel"). An agent
session resolving the card gets 403; tested in leaf 6.

### D9 Agent context and `@doc`

- **Todo context.** For a todo with managed links, the agent context lists linked note titles and paths only; content comes through `doc_read` (token economy, same reasoning as `cretli-ref todo=` pointers, `lib/todo-ref.js:1-5`).
- **`@doc`.** A doc mention parser sits next to `parseTodoMention` (`todoMention.js:46`); the picker is modelled on `todoMentionPicker.js` and created by the composer (`chatComposer.js:281`). On send, the handler (`chatSendHandlers.js`) appends a `cretli-ref doc=<root-relative-path>` line, not the content; the agent loads it with `doc_read`. This keeps `context_manifest` content-free (`lib/mcp/builtin/context-tools.js:55`) and avoids a second injection path with its own truncation rules. If the human wants inline content, `doc_read` already returns a size-limited body with an explicit truncation notice (leaf 5 acceptance).
- **Consent.** `doc_read` and the picker refuse an external root without stored consent and `agentRead` (D5).
- **Injection safety.** Note text is untrusted data. `doc_read` results are marked as such, mirroring `FEEDBACK_UNTRUSTED_RULE` in `lib/todo-execution-prompt.js:191`; a note cannot change an agent's scope or permissions.

## 4. State and ownership summary

| State | Where | Registered for backup |
| --- | --- | --- |
| Note files | The configured root on disk (source of truth) | Not Cretli's data; the user's own backup |
| Root, consent, managed links | `data/docs-state.json`, store `store.docs-state` | Yes (checklist R1-R5) |
| Proposal payload and decision | `store.decisions` (existing) | Already registered |
| Search index | In memory, rebuilt on start and refreshed on mtime change | No persistence in the MVP |

## 5. Failure and safety rules for leaf 2 to carry

- Realpath of every path stays inside the realpath of the root; escaping symlinks rejected; `.md` only; size limit; no reads or writes through the lexical helper in `lib/files-list.js:45-49`.
- Writes use `writeTextAtomic` (`lib/persist/atomic-write.js:391`) and an `expectedSha256` precondition.
- Markdown is untrusted: sanitised on render (leaf 4), never executed server-side.
- Errors for external-root-without-consent use a stable code (e.g. `docs-consent-required`) in the style of the `port_expose` refusal codes (`docs/apps-and-ports.md`, Agents section).

## 6. Index

Frontmatter, title, wikilinks, tags and full-text search without new heavy dependencies
(plain in-memory inverted index or substring scan with caps). Refresh on external edits by
comparing mtime and size per file at request time and on a debounced watcher where
available. The index is a cache; losing it loses nothing.

## 7. Out of scope for the MVP

Graph view, canvas, plugins, sync, attachments and images upload, templates, daily notes,
non-`.md` files, Watcher suggestions, auto-approve of agent writes, cross-workspace links.

## 8. Comparison with the connected Obsidian MCP tools

The Obsidian tools are an external server the user connects; Cretli neither ships nor
gates them. They talk to an Obsidian vault by vault name.

| Capability | Obsidian MCP | Docs module | Decision |
| --- | --- | --- | --- |
| List vaults | `obsidian_list_vaults` | none | Out of scope: a workspace has one docs root. |
| List files | `obsidian_list_files` | `doc_list`, tree route | Overlaps on purpose: Docs lists the **workspace's** root, scoped and consent-checked. |
| Read a note | `obsidian_read_file` | `doc_read` | Overlap; Docs adds links, backlinks, size cap, untrusted marking. |
| Search | `obsidian_search` | `doc_search` | Overlap; Docs searches only the configured root. |
| Create / update / append | `obsidian_create_note`, `_update_note`, `_append_to_note` | `doc_propose_write` / `_append` (human-approved) | Different on purpose: Obsidian MCP writes immediately and has no human-approval gate Cretli controls; Docs never writes on an agent call. |
| Active file / open in app | `obsidian_get_active_file`, `obsidian_open_file` | none | Out of scope: Obsidian application state, not a file-set concern. |
| Link note <-> todo / initiative / decision | none | managed links (D4) | **The reason the module exists.** |
| Backlinks | none | `doc_backlinks` | New. |
| Context hook | none | `@doc`, linked-note listing on a todo | New. |
| UI inside Cretli | none | `docs` panel | New. |

What stays out of scope because the Obsidian MCP already does it: vault discovery,
Obsidian-app interaction (active file, open file), and vault-wide editing from an agent
that the user is happy to let write directly. Docs does not wrap, proxy or replace those
tools.

**Residual risk to document in leaf 7.** If the external root is an Obsidian vault and the
Obsidian MCP is also connected, an agent can reach the same files through the MCP and skip
the `doc_proposal` gate and `agentRead`. Cretli cannot gate a third-party MCP server; the
mitigation is documentation and, for users who care, the existing per-tool MCP permission
policy (`docs/mcp/SETUP.md`).

## 9. Registry, contract-test and size-gate checklist

Templates: the `plans` panel (P), the `initiative_*` tools (I), an existing decision kind
`browser_consent` (K), and `browser-policy.json` (S, commit `ffbe5abe2`). "Leaf" is the
leaf expected to touch it; entries marked **+** are outside that leaf's declared scope
today (section 11).

### 9.1 Data store (template S) — leaf 2

| # | File | Change | Guard |
| --- | --- | --- | --- |
| R1 | `docs/storage-registry.json` | New entry `store.docs-state` (`json-document`, `docs-state.json`, rank 300, adapters `raw-json-...`, `stop-server-copy`, `atomic-rename`, migration `none`; copy of `:1099-1125`) | `lib/storage/validate-storage-registry.js` |
| R2 | `docs/storage-registry.json` | Append `store.docs-state` to `lockOrderHint` (after `store.browser-policy`, `:49`) | `validate-storage-registry.js:141-143` |
| R3 | `docs/storage-registry.md` | Paragraph in the style of `:90` | doc review |
| R4 | `docs/storage-callers.md` | `store.docs-state` row in the `## HTTP routes (Express)` table in the style of `:57`: columns Store id / Route module / Pattern / Sync / Owner = `store.docs-state` \| `lib/routes/docs-routes.js` \| RMW `docs-state.json` via the docs state store \| S \| `stays-file: small per-workspace JSON, registry migration none` | `tests/storage-callers-contract.test.js` (R4a) |
| R4a | `tests/storage-callers-contract.test.js` | **No edit; it is a gate the new row must satisfy.** The test parses only tables under `## HTTP routes`, `## WebSocket`, `## Background timers`, `## MCP tools`, `## Subprocess` (`:13`, `:21-46`). It fails when (a) a registry store has no row anywhere in those tables (`:98`, "registry store ... missing from the doc"), so R1 without R4 breaks the suite; (b) the Owner cell is not one of `A3a A3b A4 A5 A6 B4` or `stays-file: <reason>` with a reason of at least 5 characters (`:12`, `:52-57`); (c) the registry says migration `none`/`retain*` or a credential boundary but the owner is not `stays-file` (`:68-71`, `:95`), which is the case for R1 (migration `none`), so the owner **must** be `stays-file: ...`; (d) a store id appears with two different owners (`:87`); (e) the id is not in the registry (`:90-93`). Writers: the HTTP row covers the new `docs-routes.js` writers. A `## MCP tools` row for `doc_*` is **not required**: `store.initiatives` has an HTTP row only (`docs/storage-callers.md:38`) and no MCP row; `doc_*` tools in leaf 3 are read-only, and the leaf-6 `doc_propose_*` tools write the decision store, not `docs-state.json` (the approved link applies through the decision route). If a leaf adds an MCP row anyway, it must repeat the same owner string verbatim. | itself |
| R5 | `tests/storage-registry.test.js` | Case in the style of `:90-105`: entry exists, `managedPaths == ['docs-state.json']`, `enumerateManaged` returns the file with the store id | the test itself |
| R6 | `lib/docs/docs-state-store.js` | Owner module; `writeJsonAtomic` (`lib/persist/atomic-write.js:332`) | `tests/docs-*.test.js` |

### 9.2 REST (template I) — leaf 2, 3

| # | File | Change |
| --- | --- | --- |
| E1 | `lib/routes/docs-routes.js` | New; uses `isHumanDecisionRequest` |
| E2 | `lib/register-app-routes.js` | Import + `registerDocsRoutes(app, { dataDir })` beside `:253-254` |
| E3 | `docs/ARCHITECTURE.md` **+** | One pointer line next to `:9` (ARCHITECTURE is the canonical API reference; do not copy tables, link `docs/docs-module.md`) |
| E4 | `docs/docs-module.md`, `CHANGELOG.md` | New doc and `[Unreleased] / Added` entry |

### 9.3 MCP tools (template I) — leaf 3, 6

| # | File | Change | Guard |
| --- | --- | --- | --- |
| M1 | `lib/mcp/builtin/doc-tools.js` | New, `readOnly` per D7 | name-list test |
| M2 | `lib/mcp/builtin/catalog.js` | Import + spread into `BUILTIN_TOOLS` (`:5-6,40-41`) | `tests/mcp-builtin-tools.test.js` |
| M3 | `lib/docs/doc-ops.js` | Op table (run + http), pattern of `lib/initiatives/initiative-ops.js` | doc tests |
| M4 | `lib/mcp/mcp-inprocess-client.js` **+** | `docRequest` beside `initiativeRequest` (`:1051`) | in-process client test |
| M5 | `lib/remote-api-client.js` **+** | `docRequest` beside `initiativeRequest` (`:882`) | stdio bridge |
| M6 | `docs/mcp/SETUP.md` | List the tools (`:19` mentions builtin read/write rules) | doc review |
| M7 | `lib/mcp/mcp-tool-names.js` | No change: `doc_propose_*` stay out of `MCP_PLAN_MODE_OPEN_TOOLS` (`:57`) | — |

`lib/mcp/mcp-policy.js` derives read/mutating lists from the catalog
(`getBuiltinMcpReadTools`, `:27-41`), so no edit is needed there.

### 9.4 Decision kind (template K) — leaf 6

| # | File | Change |
| --- | --- | --- |
| K1 | `lib/decisions/decision-store.js` | Row in `POLICY` (`:6-17`): `doc_proposal: { risk: 'medium', reversible: false, humanOnly: true }` |
| K2 | `lib/decisions/decision-push.js` | Add to `NEVER_TOKEN_KINDS` (`:14`) |
| K3 | `lib/decisions/decision-adapters.js` | Effect branch before `:71` |
| K4 | `lib/decisions/decision-request.js` | Reject reserved kind from `decision_request` (`:49`) |
| K5 | `lib/decisions/decision-autonomy.js` **+** | Add to `HUMAN_ONLY_KINDS` (`:12`) |
| K6 | `app_front/features/car/carChoice.js` **+** | Mirror list (`:24`) |
| K7 | `docs/decision-cards.md` | Risk table row and a sentence in the human-only paragraph |
| K8 | `app_front/i18n/pl.js`, `en.js` | Kind title and "about" text next to the existing per-kind blocks (`app_front/i18n/en.js:3167-3185`) |
| K9 | `tests/fixtures/i18n-snapshot-pl.json`, `-en.json` | Same keys |
| K10 | `tests/decision-push.test.js` | No token for `doc_proposal` |
| K11 | decision tests that pin the kind list | Re-run `tests/decision-gate-adapters.test.js`, `decision-autonomy.test.js`, `decision-stack-logic.test.js`, `car-decisions.test.js`, `decisions-routes.test.js` |
| K12 | `app_front/features/docs/**`, `app_front/features/decisions/**` | Diff approval view |

### 9.5 SPA panel (template P) — leaf 4

| # | File | Change | Guard |
| --- | --- | --- | --- |
| P1 | `lib/spa-routes.js` | `docs` in `SPA_PANELS` (`:5-21`) and `SPA_ROUTE_QUERY_KEYS.docs` (`:266`; `docs: []` or `['path']` for deep links) | `tests/spa-route-shell-contract.test.js` |
| P2 | `public/sw-routes.js` | Mirror in `SPA_VIEW_PANELS` (`:17-35`) | contract test (`:44`, `:84-86`) |
| P3 | `docs/spa-route-navigation.md` | Document the route | doc review |
| P4 | `public/index.html` | `.tab[data-panel="docs"]` (cf. `:345`) and `#docs-panel` (cf. `:2920`) | panel test |
| P5 | `app_front/app/appShell/panelRegistry.js` | `docs` in `MAIN_PANELS` (`:8-9`) | panel test |
| P6 | `app_front/app/appShell/panelRouter.js` | Lazy-load + refresh branch (cf. `:353-355`) | panel test |
| P7 | `app_front/app/appShell/bootApp.js` | Register panel listeners only if the panel needs them at boot (cf. `:233-234`) | — |
| P8 | `panelLoader.js`, `runtime.js`, `startup.js` | **No change expected**: `plans` has no entry in them (a search for `plans` hits only the files above) | — |
| P9 | `app_front/css/features/docs/**` and `app_front/css/app.scss` | Partial + `@use`. Note: the `plans` panel has **no** `@use` in `app.scss`; the leaf-4 test must not copy that assertion blindly | `ui-colors-lint`, `ui-tokens-lint` |
| P10 | `app_front/i18n/pl.js`, `en.js` + both `tests/fixtures/i18n-snapshot-*.json` | `tabs.docs` and all panel strings | `tests/i18n-harness-packs.test.js:38-46` |
| P11 | `app_front/components/ui/index.js` | Export new `cr-*` components | — |
| P12 | `tests/docs-*.test.js` | Panel-wiring test modelled on `tests/initiatives-panel.test.js:94` | itself |
| P13 | `tests/e2e/docs.spec.js` | Open via tab, reload on `/docs`, wikilink, search, edit/save, conflict banner | e2e |

Settings: choose the root and answer consent in a **section of the existing `workspace`
settings tab**, not a new tab. A new tab id would also require `SPA_SETTINGS_TABS`
(`lib/spa-routes.js:73`) and the mirrored list in `public/sw-routes.js:91+`.

### 9.6 Frontend size gate — leaf 4, 5, 6

`tests/front-size-ratchet.test.js:41-48`: a file absent from the baseline must be
<= 1000 lines and contain no `innerHTML`; a baseline file over 1000 lines may not grow; a
file under 1000 may grow to 1000. Consequences:
- All new Docs code goes into new files under `app_front/features/docs/` (split by concern: api, tree, viewer, editor, links, consent, diff).
- Files that leaf 5 and 6 edit in place (`cr-todo-card.js`, `chatComposer.js`, `chatSendHandlers.js`, `cr-decision-stack.js`, `app_front/i18n/*.js`) must be measured first (`wc -l`, `node scripts/front-size-baseline.js`); if any is over 1000 lines, move the new logic into a new file and keep the existing file's line count flat or lower.
- Do not run `front-size-baseline.js --write` to hide growth (the baseline only tightens).
- Markdown rendering must not use `innerHTML`: use Lit templates, or a sanitiser that returns nodes.

## 10. Security notes carried into leaf 7

Path traversal and symlinks (D5, section 5); markdown XSS; external-root consent bound to
realpath; human/agent boundary on every mutating route and on card resolution; forged
`doc_proposal` via `decision_request` (D8); Obsidian-MCP bypass (section 8); session-cookie
theft is a pre-existing, separately tracked risk (`docs/decision-cards.md`, "Human channel
and threat model").

## 11. Scope corrections

Files the checklist needs that are **not** in the declared `## Leaf scope` of the leaf.
The parent updates the leaf bodies; leaf 1 does not edit todos.

| Leaf | Todo id | Add to `## Leaf scope` | Why |
| --- | --- | --- | --- |
| Docs 2 | `dbd19733-727d-4890-a0e3-20ed453359e9` | `tests/storage-callers-contract.test.js` | Gate for the `docs/storage-callers.md` row (R4a). Already added to leaf 2 scope by the parent; no further action. |
| Docs 2 | `dbd19733-727d-4890-a0e3-20ed453359e9` | `docs/ARCHITECTURE.md` | Pointer to the new module next to `docs/ARCHITECTURE.md:9` (E3) |
| Docs 2 | `dbd19733-727d-4890-a0e3-20ed453359e9` | *(optional cleanup)* remove `lib/routes/settings-routes.js` | Root and consent go through `docs-routes.js` (D6), so the settings route is not needed; harmless if kept |
| Docs 3 | `567dd79b-2d73-46bb-9342-0ceebe6f6162` | `lib/mcp/mcp-inprocess-client.js` | `docRequest` beside `initiativeRequest` (`:1051`), M4 |
| Docs 3 | `567dd79b-2d73-46bb-9342-0ceebe6f6162` | `lib/remote-api-client.js` | `docRequest` for the stdio bridge (`:882`), M5 |
| Docs 4 | `eda4909d-06e1-4a5c-bddc-ffbb6ae3855f` | none required | `panelLoader.js`, `runtime.js`, `startup.js` are listed but expected untouched (P8); `app.scss` `@use` is correct but the `plans` template has none (P9) |
| Docs 5 | `466e494b-3aaf-48b4-98cb-2ad7334a4106` | none required, one caveat | Context listing for a linked todo is best done in `doc_read`/todo tools and `lib/docs/**`; if leaf 5 wants to add linked-note titles into the todo execution prompt, `lib/todo-execution-prompt.js` is also needed (not in scope today) |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | `lib/decisions/decision-autonomy.js` | `HUMAN_ONLY_KINDS` (`:12`), K5 |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | `app_front/features/car/carChoice.js` | Mirror list (`:24`), K6 |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | `lib/mcp/mcp-inprocess-client.js`, `lib/remote-api-client.js` | Only if leaf 3's `docRequest` does not already expose the propose ops; otherwise unchanged |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | `docs/mcp/SETUP.md` | New propose tools (M6) |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | `tests/decision-autonomy.test.js`, `tests/car-decisions.test.js` | K5/K6 behaviour changes; add a case each |
| Docs 3 | `567dd79b-2d73-46bb-9342-0ceebe6f6162` | `tests/storage-callers-contract.test.js` | Already added to leaf 3 scope by the parent. It is only exercised if leaf 3 adds a `## MCP tools` row to `docs/storage-callers.md`, which this design does not require (R4a); keep the same owner string if it does. |
| Docs 6 | `70946867-4e1a-4eb6-8f3e-7f2aacc53c06` | none required | `doc_propose_*` write `store.decisions` (existing row `docs/storage-callers.md:37`), not `store.docs-state`; add `docs/storage-callers.md` and `tests/storage-callers-contract.test.js` to leaf 6 only if it chooses to add an MCP-tool row. |
| Docs 3 / 5 | — | No storage files | Resolved by D4: one store, owned and registered in leaf 2 |

## 12. Decisions for the human

| # | Question | Recommendation |
| --- | --- | --- |
| H1 | `doc_proposal` as `humanOnly: true` (touch-only in car mode, no metacard) instead of the plan's `false`? | **Yes.** It is the only setting that keeps "no auto-approve" true across autonomy, gestures and car voice (D8). Cost: two extra files in leaf 6. |
| H2 | Separate `agentRead` flag for external roots (default off)? | **Yes.** A vault often holds private notes; consent to show them in the panel should not imply agents may read them. If you prefer the plan's single consent, drop the flag and treat consent as both. |
| H3 | Default root: `<workspace>/docs` only if it exists, otherwise unconfigured? | **Yes.** Avoids scanning or creating folders without intent. Alternative: always create `.cretli/docs` (rejected, D1). |
| H4 | Links stored on the Cretli side only (frontmatter read-only hint, Cretli wins)? | **Yes.** Keeps vault files untouched and external roots writable only through human actions. Downside: links do not travel with the files if the notes are copied to another machine. |
| H5 | Proposal payload (up to 128 KiB) kept inside the decision card document? | **Yes** for the MVP: no extra store to register or back up. If proposals grow large, move payloads to a Docs-owned file and register it then. |
| H6 | Delete in the MVP: hard delete of the file, or move to a trash folder inside the root? | **Trash folder** (`.cretli-trash/` under the root, hidden from the tree): reversible, cheap, and the only destructive REST route. Plan says "delete"; hard delete is also acceptable if you accept no undo. |
| H7 | `@doc` sends a `cretli-ref doc=<path>` pointer (agent calls `doc_read`) instead of pasting the note? | **Yes.** Consistent with `@todo`, token-economical, keeps the manifest content-free. Plan wording "the note loads into the turn" is satisfied by the size-limited `doc_read`. |
| H8 | Settings UI as a section of the existing `workspace` tab (no new SPA settings tab)? | **Yes.** Avoids changes to `SPA_SETTINGS_TABS`, `public/sw-routes.js` and the contract test. |
| H9 | Drop leaf 7 or keep it? | **Keep.** The forged-card, Obsidian-MCP-bypass and symlink findings span leaves 2-6 and need a fresh reviewer. |
