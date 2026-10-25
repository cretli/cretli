# ChatCatalog read contract (vertical V1, stage 2)

Status: **frozen contract**, implemented as `lib/chat-catalog.js`; tests in
`tests/chat-catalog-contract.test.js`. Context: [architecture-vertical-dag.md](architecture-vertical-dag.md) V1,
[architecture-target-adr.md](architecture-target-adr.md).

## Ownership

- **Writes**: only `lib/persist/chats-persist.js` (`saveChats`, `addChat`, `updateChat`, ...). The
  catalog has no write method; a test fails if the module references a store writer.
- **Format/writer of `chats.json` is unchanged**, so this does not pre-empt metadata migration
  A3b `c688a6a1` or storage cf4fed89. `loadChats()` stays as a facade with the same shape.
- **Reads**: `readChatCatalog()` takes one `loadChatsSnapshot()` (one copy, one `stat`) and builds
  indexes; `createChatCatalog(chats, opts)` is the pure constructor for tests and callers that
  already hold a list.

## Queries

| Query | Result |
| --- | --- |
| `get(id)` | the first row with exactly that string id, else `null` (no trimming; non-string ids give `null`) |
| `require(id, scope?)` | like `get`, but throws `ChatCatalogError` `NOT_FOUND` / `OUT_OF_SCOPE` |
| `list({ scope?, archived? })` | frozen array in store order; `archived` is `include` (default) / `exclude` / `only` / `tree` (live rows + archived ancestors of live rows within the scoped rows, stage 4); `INVALID_ARGUMENT` for anything else |
| `page({ scope?, archived?, limit?, cursor? })` | `{ items, nextCursor, revision }`: keyset page over store order. Scope and archive filters run before the limit. The scan walks the store from the cursor position and stops at the first row after the page is full, but `archived=tree` first computes the kept-ancestor set over all scoped rows (O(rows) per call), so the cost of a page is not bounded by `limit` alone; only the number of rows returned is. `limit` defaults to 100 and is clamped to 1..500 (`CHAT_CATALOG_PAGE_DEFAULT_LIMIT` / `CHAT_CATALOG_PAGE_MAX_LIMIT`). The cursor is `<store position>@<revision>`; a malformed cursor is `INVALID_ARGUMENT`, a cursor from another revision is `STALE_CURSOR` (the client restarts the walk) |
| `archivedCountsByWorkspace({ scope? })` | `{ "<workspaceFile>\n<workspaceFolder>": n }` for archived rows in scope, keyed like `countArchivedChatsByWorkspace`; implemented as a full scan of the scoped rows per call (it builds the scoped `list()` array and counts archived rows), so it is O(rows), not O(limit) |
| `children(parentId)` | frozen direct children by `forkParentChatId` (trimmed), store order |
| `counts({ scope? })` | `{ total, archived, live, roots }` |
| `revision`, `size` | store revision and row count of this snapshot |

Scope = `{ workspaceFolder?, workspaceFile?, widgetInstallationId? }`. Workspace match: folder pair
wins, then file pair (resolved paths); an empty scope matches everything. The MCP rule that resolves a
folder through the SDK cwd is not part of the contract; pass `matchesWorkspace` to the constructor.

## `GET /api/chats/page` vs `GET /api/chats`

The route maps `page()` rows with the same helpers as the full list (`mapChatsForClientList`,
`markWorktreeChats` for `onWorktree`, `harnessState` for persisted local transports, `linkedChat` for
widget `pinnedTo`). Differences that remain by design:

- Default `archived=tree` equals the live-only full list (archived ancestors of live rows are kept);
  `archived=exclude` is strict and drops them. Invalid values are 400.
- `archivedCounts` follows the request scope; non-widget `GET /api/chats` counts globally.
- `workspaceFolder`/`workspaceFile` narrow the page; `GET /api/chats` has no such filter (it uses
  `archiveWorkspace` for archive windows, which the page does not support).
- `pinnedTo` (widget only, full rows only): `linkedChat` is a separate body field, not a page row. It is looked up
  with `findChatPinnedToPageUrl` among the chats of the widget installation that pass the same controller scope
  (`widgetChatListScope`) as the page, but with archived rows included, and it is independent of
  `limit`/`cursor`/`archived` (so the linked chat may be absent from `chats`, e.g. archived). `GET /api/chats` instead merges the linked chat into `chats`. With
  `view=list` the field is omitted. Clients that need the linked chat should read `linkedChat`, not search `chats`.
- Page size: `page()` clamps `limit` to 1..500 (default 100) in the catalog; the HTTP layer adds no stricter clamp.
  The 100-row / 128 KiB figures in the list-sync contract are the *client/sync* budget (a delta above them is
  `resync` / `too-large`; clients should request `limit<=100` per page), not a server rejection of larger pages.
- Pages are bounded; HTTP statuses: 400 `INVALID_ARGUMENT`, 409 `STALE_CURSOR`.

## Semantics

- **Revision**: the store file signature (inode, size, mtime) or `''` when no file exists. Equal
  non-empty revisions mean identical data; any `saveChats` changes it. A snapshot never changes
  after creation (no refresh); take a new one per request.
- **Errors**: the catalog reports codes only. HTTP 404/403, WS frames and MCP errors stay in each
  transport (their policies and read-only capabilities are not merged).
- **Idempotency**: every query is pure and repeatable on one snapshot; duplicate ids resolve to
  the first row (same as the request-local index in `delegations-routes.js`).
- **Cancellation/transactions**: reads are synchronous and bounded; there is nothing to cancel or
  roll back. Cross-store transactions remain A4 `6e483edd`.
- **Records**: zero-copy rows from the snapshot; read-only by contract, not deep-frozen.

## Migrated call sites (V0 coverage, behaviour identical)

- `lib/routes/delegations-routes.js` `findParent` (request-local index, test
  `tests/delegation-route-chat-index.test.js`, 1 chat load per request).
- `lib/routes/chats-routes.js` `GET /api/chats/:id/title-history` and `POST /api/chats/:id/seen`
  (`find(row.id === id)` with a string route id equals `get(id)`).

Remaining `loadChats(` call sites (~130) are listed by `docs/architecture-sync-io-inventory.json`; they
migrate in S3 only where the same proof holds (string id, read-only use, no duplicate-id or
`.some(...)`/predicate differences).

## Command/query boundaries for V2/V5 (contract text only, nothing implemented)

| Boundary | Contract | Status |
| --- | --- | --- |
| V2 list DTO query (`chats` list without history, revision + delta + gap resync) | query over `ChatCatalog.list`/`counts`; the transport owns DTO shaping | specified here; recovery statuses in the sidebar **blocked by R13 `e304b86d`** |
| V2 sync commands (archive, reorder, nest) | stay in `chats-routes.js` -> `chats-persist.js` | unchanged; no catalog involvement |
| V5 TODO/watcher/delegation aggregates (queries) | counters via SQL aggregates, read-only | queries specified in S3; **blocked by A4 `6e483edd`** for transactions |
| V5 mutation commands (todo/watcher/delegation state) | single owner per mutation; transactional contract belongs to A4 | **blocked by A4 `6e483edd`** |
| Recovery status projections | recovery contract is frozen | **blocked by R13 `e304b86d`** |

## Dependency-cycle report

`node scripts/architecture-dependency-cycles.mjs --out docs/architecture-dependency-cycles.json`
(deterministic; see the file header for the method). `lib/chat-catalog.js` adds no cycle.
