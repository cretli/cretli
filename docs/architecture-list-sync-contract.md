# Chat list DTO and sync contract (vertical V2, stage 4)

Status: **implemented, additive**. Code: `lib/chat-list-dto.js`, `lib/chat-list-sync.js`,
`GET /api/chats/page`, `GET /api/chats/sync` in `lib/routes/chats-routes.js`; client state machine
`app_front/features/chat/chatListSyncClient.js` + `getChatListSync` / `getChatListPage` in `app_front/api.js`.
Tests: `tests/chat-list-sync.test.js`, `tests/chat-list-sync-client.test.js`,
`tests/chat-list-live-sync-delta.test.js`, `tests/chat-catalog-pagination.test.js`.
Context: [architecture-chat-catalog-contract.md](architecture-chat-catalog-contract.md),
[architecture-target-adr.md](architecture-target-adr.md) D4/D5, [architecture-vertical-dag.md](architecture-vertical-dag.md) V2/V7.

## Scope and non-goals

- **Read side only.** No writer changed: `chats-persist.js`, `chats.json` format, `GET /api/chats` and the
  `chatsChanged` WS frames are exactly as before (this contract is additive, the old list is the fallback).
- **Not here (owned elsewhere, blocked):** history pages / receipts / generation / producer fencing / durable
  ACK / "reject v1 writes after v2 cutover" belong to A3a `aadeac30` (blocked by A2 `4fb174ca`); recovery
  statuses in the sidebar belong to R13 `e304b86d`. The sync client therefore has no write path and no
  unsent-content queue: its offline queue only defers *pull* triggers (see Client rules).
- **Transports keep their own policy.** HTTP applies widget scope (installation + `widgetChatListScope`) before
  any limit or delta, identically for `/page` and `/sync`. WS and MCP scope guards are unchanged; MCP chat tools do
  not call these endpoints.

## Frozen API caps (human decision, 2026-10-17)

Client page budget ≤ 100 rows and ≤ 128 KiB uncompressed JSON; ordinary response ≤ 1 MiB (baseline §5, ADR D5).
`/api/chats/page` defaults to `limit=100` but the catalog clamps `limit` to 1..500 (it does not reject larger
pages), so the 100-row figure is the default and the recommended client request size. A *delta* that would exceed
100 rows or 128 KiB is never sent: the server answers `mode: 'resync'`, `reason: 'too-large'`.

## List DTO v1 (`dtoVersion: 1`)

Allowlist of scalar fields (`CHAT_LIST_DTO_FIELDS`): `id, title, titleSource, titleRev, workspaceFolder,
workspaceFile, model, agentTransport, sdkMode, sdkUiMode, createdAt, updatedAt, archivedAt, forkParentChatId,
forkKind, todoId, delegationParentChatId, delegationId, delegationDepth, delegationRootChatId,
delegationAssignment, pickPurpose, lastFinishedAt, lastSeenAt, widgetInstallationId, widgetPageSessionId,
widgetPinnedUrl, watcherPinned, isTemporary`, plus derived `onWorktree: true` (only when true).

Deliberately absent: history, `summaries`, provider session ids (`cursorSessionId`, `claudeSessionId`,
`sdkAgentId`, ...), `executionFolder` (a local path), and `harnessState` (environment-derived; it stays on the
full-row `/api/chats` and `/api/chats/page` without `view=list`). The full row remains available through the
existing endpoints; DTO v1 is the minimal sidebar projection. In the synthetic fixture rows are tiny, so the
size gain is small there (see [architecture-http-baseline.md](architecture-http-baseline.md)); real rows carry
session ids and paths that the DTO drops.

## Position, revision, delta

- `revision` is the store signature of the snapshot (catalog contract); it only versions cursors.
- Sync position is `<epoch>.<seq>`: `epoch` = random id per server process, `seq` = number of observed list
  transitions. The server **observes** catalog snapshots (memoized per revision + live-worktree key, so N concurrent
  requests share one O(N) digest pass), diffs per-row DTO digests and appends one entry to a bounded ring
  (32 entries, ≤ 100 changed rows each).
- `GET /api/chats/sync?since=<epoch>.<seq>` answers one of:

| `mode` | When | Payload |
| --- | --- | --- |
| `noop` | `since.seq == seq` | position only |
| `delta` | ring covers `(since.seq, seq]` | `upserts[]` (current DTOs of touched rows in scope), `removed[]` (ids), `archivedCounts`, `since`, `seq` |
| `resync` | `no-since`, `epoch` (restart), `ahead`, `gap` (ring overflow), `too-large` | position + `reason`; the client walks `GET /api/chats/page?view=list&archived=tree` |

  Malformed `since` is **400** `INVALID_ARGUMENT`. Deltas are *state-based*: touched ids are re-read from the
  current snapshot, so a row changed A→B→A still arrives once (upsert is idempotent), and duplicate delivery or
  repeating the same request returns the same answer.
- **Archived ancestors** of an upserted live row travel with it (no orphaned child after un-archive/nest).
- **Widget scope:** upserts and removals are computed against the widget scope; a removal is only reported when
  some observed state of the row was visible to that scope, so ids and content of foreign chats never leak
  (tested). A row leaving the widget page scope is a removal.
- `/api/chats/page` returns `sync` (position at the snapshot), so `page walk → /sync?since=sync` resumes without a gap.

## Parity with `GET /api/chats` (stage-3 review gaps)

| Gap | Resolution |
| --- | --- |
| archived parents of live chats orphaned by `archived=exclude` | new `archived=tree` mode in `ChatCatalog` (live + archived ancestors, computed within the scoped rows) = `selectChatsForSidebarList` parity; `/page` defaults to `tree`; `exclude` stays available and strict (documented in ARCHITECTURE.md) |
| `onWorktree` | added to `/page` rows and to DTOs |
| `harnessState` | resolved for persisted local transports on full rows (`/page` without `view=list`); explicitly **not** in DTO v1 |
| `pinnedTo` (widget) | `/page?pinnedTo=` adds a separate `linkedChat` field (widget only, full rows only, searched among installation chats within the controller scope, archived included, independent of limit/cursor/archived); differs from `GET /api/chats`, which merges it into `chats` (see catalog contract, Differences) |
| `fullIndex` / `archiveWorkspace` window | not replicated: `/page` is keyset-paged and the client chooses `archived` per walk; `GET /api/chats` keeps those semantics |

## Client rules (`chatListSyncClient.js`)

- One request in flight; further triggers set a dirty flag → exactly one follow-up (in-flight coalescing). A burst of
  N `chatsChanged` frames therefore costs ≤ 2 sync requests and **zero** list refetches (tested with 100 triggers).
  `chatListLiveSync` can opt in with `requestListDelta`; when absent or `false`, it falls back to the full `refresh`.
- A delta applies only when `delta.since <= position.seq < delta.seq`; `seq <= position.seq` is stale/duplicate and
  dropped; `since > position.seq` or another epoch is a gap → resync.
- Resync walks bounded pages into a staging map, swaps atomically, restarts (≤ 3) on 409; older resync generations
  are discarded.
- Retry: network/5xx/408/429 with exponential backoff (500 ms base, 5 attempts); 4xx is terminal and keeps rows.
- Offline: no request; the dirty flag survives; reconnect triggers one sync. Persisted snapshot (`persist.load/save`,
  IndexedDB in the app) resumes with a delta instead of a page walk.
- Multi-tab: tabs announce `list-applied {epoch, seq, scopeKey}` on a `BroadcastChannel`-like channel; a tab syncs only when it is
  behind and on the same scope. (Channel and persistence are injected; the app wiring is flag-gated, see the frontend baseline.)
- **Scope binding (stage-5 fix of review F1).** The server token `<epoch>.<seq>` does not encode the request scope (workspace /
  widget scope), so the same token is valid for two scopes and a delta would silently keep rows of the old one. The client therefore
  binds rows, position, persisted snapshots and channel announcements to `getScopeKey()`: a scope change drops rows + position
  (next round is a page walk, `reason: 'scope'`), an answer requested under another scope is discarded, `restore()` refuses a snapshot
  whose `scopeKey` differs (snapshots without one are refused by a scoped client), and peer announcements of another scope are
  ignored. The server token format is unchanged (binding is client-side only, no API change).
- **Delta vs `archived=tree` parity (stage-5 fix).** A resync returns live rows + archived ancestors of live rows. A delta upserts any
  touched in-scope row, so after applying one the client prunes archived rows that have no live descendant
  (`pruneArchivedWithoutLiveDescendants`), which makes delta state identical to a resync for the `tree` mode. Server behavior is unchanged.
- `dispose()` clears the retry timer and the channel listener and discards in-flight answers.

## Settings / boot (V7)

`GET /api/settings` does not read the chat list. Measured P95 on the 500/5000/20000 fixtures is far below the
100 ms target (see the HTTP baseline); no response-shape or code change was needed. Boot list reads are bounded by
the page cap (≤ 100 rows) when the client uses `/api/chats/page?view=list`; switching the boot path is stage 5.

## Known limits

- The ring is in memory: a server restart is an `epoch` resync by design.
- Observation costs one synchronous O(N) pass per changed revision, measured ≈ 25-35 ms at 20 000 chats (DTO build + serialize),
  on top of the store copy the catalog already pays; it runs lazily on the first request after a change, never per request, and
  holds one serialized DTO per chat in memory. Moving it off the main loop or removing the copy needs a storage-owned read (A2).
- Equal store signatures are treated as equal data (catalog contract).
