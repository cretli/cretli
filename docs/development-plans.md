# Development plans (initiatives)

Initiatives describe product direction above executing Todos: a desired outcome, baseline, success criteria, research
and dependencies. They live in their own domain, `store.initiatives`, keyed by the **workspace UUID**
(`resolveWorkspaceRef(dataDir, ref).uuid`), not by the legacy registry id or a folder. An initiative's status is never
derived from Todo status; `achieved` is an explicit human judgement of the success criteria.

This document covers the model, persistence, API contract (leaf 1) and the panel (leaf 2). Map and Scout research are
separate leaves.

## Model

| Field | Notes |
| --- | --- |
| `kind` | `goal` or `initiative` |
| `title`, `desiredOutcome` | required |
| `rationale`, `baseline`, `successCriteria[]`, `openQuestions[]` | optional text; missing data is empty/`unknown`, never invented |
| `scopeSize` | `unknown`, `S`, `M`, `L`, `XL` |
| `priority` | `unknown`, `low`, `normal`, `high`, `urgent` |
| `horizon` | `now`, `next`, `later` (separate axis from status) |
| `status` | `draft`, `exploring`, `planned`, `active`, `paused`, `achieved`, `dropped` |
| `revision`, `createdAt`, `updatedAt`, `archivedAt` | server-owned; `revision` is the CAS token |

Relations (`contributes_to`, `requires`, `supports`, `alternative_to`) are typed edges inside one workspace. Self links,
duplicates and foreign-workspace endpoints are refused; `requires` and `contributes_to` additionally refuse cycles in the
same transaction that would add the edge (recursive walk inside the worker). `supports` may form cycles.
`alternative_to` is symmetric and stored once (`from < to`). `A requires B` yields a planning signal
(`clear`, `waiting`, `waiting_paused`, `blocked_abandoned`, `blocked_archived`, `unknown`; see `requiresSignal`); it is not
a Todo scheduler gate.

Links point at existing `todo`, `decision`, `research` or `git` targets with a minimal name snapshot. Linking never
changes the target's parent, status, plan or review. A Todo or Decision link is read through its own facade in the
workspace's current todo-home; an unreadable or foreign target is `link_unavailable` and nothing about it is revealed.

Research entries are `observed`, `hypothesis` or `unknown`, with sources, limitations and the initiative revision at
write time. An edit appends a new version of the same lineage (`supersedesId`); the previous entry stays.

## Persistence

- `data/initiatives/initiatives.sqlite`, worker-owned (`lib/storage/initiatives-store.js`, schema
  `lib/storage/schema/0010-initiatives.js`), FULL durability, receipts and write gates like `store.decisions`.
- One command is one transaction: the change, its journal event (`initiative_events`, append-only) and the revision
  bumps commit together. `expectedRevision` is a compare-and-swap; create is idempotent by `idempotencyKey` plus a payload
  digest (a different payload under the same key is `idempotency_mismatch`).
- Lists and history use keyset cursors bound to the workspace revision (default page 50, max 100). A cursor created
  before a later write is refused with `cursor_stale`; restart the read. The graph slice returns at most 100 nodes and
  300 edges with `truncated`, `hasMore`, `nextCursor` and `skippedEdges`.
- `unknown_commit` after a lost worker is reconciled with `store.resolveUnknown` for the same command id, never by a
  blind retry with a new id.

### Expected-dataset declaration and restore

The decisions runtime recreates a missing file from `fs.stat` alone. The initiatives runtime does not: the control dir
(outside restore-managed paths) holds `initiatives-dataset.json` with the dataset generation and the control-state
generation at the time of declaration (`lib/persist/initiatives-runtime.js`).

- No declaration, no file: first install, bootstrap and declare.
- No declaration, file present: verify the dataset, then declare.
- Declaration current, file missing: refusal `INITIATIVES_STORE_MISSING`.
- A full restore moves the control-state generation (existing recovery journal and fence, unchanged). A restored
  store file is verified and re-declared; an archive that predates the domain removes the file and so explicitly allows an
  empty bootstrap, never mixing the old future with restored Todos.

## Creating a Todo from an initiative

An explicit human action (`POST /api/initiatives/:id/todos` with an `operationId`):

1. The intent (operation id + frozen payload + SHA-256 digest) is stored in `initiative_todo_intents`.
2. `addTodo` creates one `idea` Todo with a server-owned `initiativeOrigin` (`workspaceUuid`, `operationId`, `digest`)
   stored on the Todo record itself. A repeat with the same origin returns the same Todo (`replayed`), a different digest is
   `CONFLICT`. The origin is not part of the editable body and is ignored by `todo_update`.
3. The Todo id and link are written together (`todoIntentComplete`). A crash between 2 and 3 is repaired by the next call
   (or `recoverPendingTodoIntents`) without a second Todo.

No plan is approved, nothing is claimed or started, and the Todo parent is untouched.

## Actors

Session UI requests (auth + CSRF, not an agent session) act as `human`; MCP integration, widget and agent sessions act as
`agent`.

| Action | human | agent (MCP) |
| --- | --- | --- |
| read, list, history, graph | yes | yes |
| create | any status | `draft` / `exploring` only |
| update | yes | only while the initiative is draft/exploring; never `status` beyond those |
| strategic fields of an accepted initiative (title, outcome, horizon, status, ...) | yes | no, even if `status` is unchanged |
| archive, remove relation/link, create Todo | yes | no |
| `supports` / `alternative_to` relations, links, research | yes | yes |
| `requires` / `contributes_to` relations | yes | no |

## API

All paths take the workspace from the verified server resolver (`workspaceUuid`, `workspaceId` or alias in the query or
body); an unregistered folder or ambiguous workspace is `409 workspace_required`.

`GET/POST /api/initiatives`, `GET /api/initiatives/graph-slice`, `GET/PATCH /api/initiatives/:id`,
`POST /api/initiatives/:id/archive`, `GET /:id/history`, `GET/POST /:id/relations`, `DELETE /:id/relations/:relationId`,
`GET/POST /:id/links`, `DELETE /:id/links/:linkId`, `GET/POST /:id/research`, `POST /:id/todos`.

Errors carry `code`: `validation` (400), `forbidden` (403), `not_found` (404), `link_unavailable` (422), everything else
(`revision_conflict`, `archived`, `relation_cycle`, `relation_duplicate`, `cursor_stale`, `idempotency_mismatch`,
`workspace_required`, ...) is 409.

MCP tools: `initiative_list`, `initiative_get`, `initiative_history`, `initiative_graph`, `initiative_create`,
`initiative_update`, `initiative_relate`, `initiative_link`, `initiative_cite`.

## Panel (Development plans tab)

`app_front/features/initiatives/` renders the `/plans` view (`cr-initiatives-panel`, glue in `initiativesPanel.js`, pure
rules in `initiativeLogic.js`, REST client in `initiativesApi.js`). It only uses the API above.

- **List**: three groups by horizon (now / next / later), ordered by priority then last update. Status, horizon and
  priority are separate fields and chips; the card also has a horizon select, so moving between groups needs no
  drag. A done Todo or an `achieved` status never hides an initiative; only archiving does (opt-in toggle).
- **Detail**: Details (edit, CAS by `expectedRevision`), Research, History (keyset pages, `cursor_stale` restarts the
  read), Linked work. Research shows evidence (`observed`), hypotheses and unknowns in separate groups with different
  labels, only the newest version of a lineage; "Revise" appends a version.
- **Todos**: link an existing Todo (its live status is shown next to the link) or create one. Creation is a `cr-dialog`
  that posts `POST /api/initiatives/:id/todos` with one operation id kept until success, so a retry replays. The Todo
  is an `idea`; the panel never approves a plan, claims or starts anything.
- **Scope**: each tab uses its own ViewContext (`todoWorkspaceQuery`). After the first response the panel pins the
  canonical `workspaceUuid` from the records; alias translation stays on the server. A view-context change reloads and
  resets the detail; drafts are keyed by scope.
- **Failure handling**: a CAS miss opens a conflict banner (keep my edits on latest / take latest); a lost connection keeps
  the draft and offers retry (also on the browser `online` event); other refusals map to translated messages.
- **Drafts**: edits are mirrored to `sessionStorage` (`cretli-initiative-draft:<scope>:<id|new>` with the base revision).
  A list refresh, including one triggered by an `initiativeChanged` WebSocket frame (`cr-initiatives-changed`), only
  refreshes the base and shows a banner when the draft is dirty; it never overwrites the draft. The server does not emit
  `initiativeChanged` yet; until it does the panel refreshes on tab open, focus, view-context change and reconnect.
- **Accessibility**: native controls and buttons only; arrow keys move between tabs, Escape leaves the detail, focus
  moves to the heading on open and back to the card on close; status messages use `role="status"` / `role="alert"`.
  Layout wraps down to 360 px; colours are `--cr-*` tokens (dark/light).

## Not in this leaf

Server emission of the `initiativeChanged` WebSocket event, map (leaf 3), the Scout `initiative_cite` scan variant and
Decision adapter (leaf 4), and a Todo-domain tombstone for deleted created Todos (see the remaining-risk note in the
leaf report).

## Initiative map

The panel has a **List / Map** switch. The map (`app_front/features/initiatives/cr-initiatives-map.js`, layout in
`initiativeLogic.js`) is a view over the records the list already loaded plus the relations from the graph-slice read;
it keeps no copy of its own and no stored layout.

- Horizon is the column, scope size the node height, status and priority are written inside the node. Relation types
  (`requires`, `contributes_to`, `supports`, `alternative_to`) differ by dash pattern and a text label on the edge, never
  by colour alone. Closed (achieved or dropped) initiatives stay on the map with a dashed outline and "Closed" label.
- Selecting a node (click, Enter or Space) opens the same detail view as the list, including its History tab.
- Keyboard: Tab reaches nodes, arrow keys move between them, Enter opens. On the canvas, arrows pan, `+`/`-` zoom, `0`
  resets; buttons and Ctrl+wheel zoom, dragging pans.
- Equivalent list: every drawn relation is also written out under the map, and the List view shows the same initiatives.
- Size limit: at most 60 initiatives are drawn. The filter (search, horizon, status, hide closed) narrows the set, and
  when more match than fit, the map says how many are not drawn. Relations that lose an end to the filter are counted.
  Relations are read per drawn initiative from the relations API (complete, so a pair split across graph-slice pages still
  shows); a failed read shows a "relations may be missing" note.
- Cycles: `supports` and `alternative_to` may loop; a `requires` (or `contributes_to`) relation that would close a cycle
  is refused by the server with `initiative_relation_cycle`, shown as a plain-language error.
