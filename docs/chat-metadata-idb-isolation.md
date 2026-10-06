# Chat metadata IndexedDB — isolation and lifecycle

This document is the **5.1** contract for browser-side chat metadata storage. Stage
5.2 wires the shared persistence queue to this database; stage 7.1 owns archive reads.

## Server auth model (no stable account id)

Cretli auth (`lib/auth.js`) is **single-tenant per server instance**:

- One password in `data/auth.json`.
- Sessions are opaque HMAC-signed tokens in the `cr_session` cookie (`/api/auth-status`
  exposes `configured`, `authRequired`, and `csrfToken` — **no user id, account id, or
  workspace-scoped cache key**).
- Login creates a new session token; logout clears the cookie.

Therefore the frontend **must not** assume a stable account identifier for IndexedDB
namespacing. Isolation is **session-boundary reset**, not per-user key prefixes.

## Metadata cache isolation contract

| Layer | Database / store | On logout / 401 / explicit session boundary |
|-------|------------------|---------------------------------------------|
| Chat metadata (list rows, activity maps, boot snapshot strings, session marker) | `cretli-chat-metadata` | **Cleared** via `applyChatAuthSessionBoundary()` before queue flush and RAM hydrate |
| Synchronous cold-start bootstrap (active chat, workspace, ≤40 rows) | `localStorage` `cretli-chat-boot-sync-v1` | **Cleared** on auth boundary with legacy boot key; **not** stored in IDB (task 5.3) |
| SDK chat history mirror | `cretli-sdk-chat` | **Not touched** — separate lifecycle (see below) |
| Terminal buffers | `cretli-chat-buffers` | Unchanged at auth boundary (not metadata migration) |
| Preferences / push inbox | `cretli-preferences`, `cretli-push-inbox` | Unchanged at auth boundary |

Session epoch (task 2.3): every durable payload carries `sessionId` + `generation`.
The activity RAM store rejects foreign sessions; the metadata IDB module checks the same
scope before commit and drops the connection epoch on boundary so in-flight transactions
cannot apply after logout.

**User “clear local data”** (Settings) may delete all `cretli-*` IndexedDB databases,
including SDK history — that is an explicit wipe, not auth-boundary migration.

## Lifecycle: activity / last-used maps

- **RAM** (authoritative at runtime): `chatActivityStore.js`.
- **Durable** (P0): `localStorage` keys via `chatPersistenceAdapter.js`.
- **Durable** (5.1+): mirrored into `cretli-chat-metadata` / `meta` store (5.2 queue flush).
- Hydration runs **once per session** after the session marker exists; legacy raw maps
  migrate only when no marker is present.
- Logout / 401: rotate session id, clear RAM, clear metadata IDB, invalidate persistence
  queue — **no re-import** of the previous session’s maps.

## Lifecycle: `cretli-sdk-chat`

- Owned by `app_front/lib/sdk-chat-history-store.js` (message/event documents per chat id).
- **Not** deleted when metadata schema upgrades or when auth session boundaries fire.
- Cleared only by explicit SDK/history clear paths or full “clear local data”.
- Metadata migration (5.x) must never call `deleteDatabase('cretli-sdk-chat')` as a side effect.

## Schema summary (`cretli-chat-metadata`)

| Store | Key | Indexes | Content |
|-------|-----|---------|---------|
| `meta` | `key` (string) | — | Adapter KV strings (session marker, activity maps, boot cache JSON) |
| `chats` | `id` (chat uuid) | `byWorkspace`, `byArchived`, `byRankingMs` | Whitelisted metadata rows + `sessionId`, `generation`, index fields |

Retention: up to **5000** chat rows in `chats` (independent of the **300** row boot
snapshot cap). Prune lowest `rankingUpdatedAtMs` first; `watcherPinned` rows are retained
until explicitly removed.

Runtime fields (`pane`, `ws`, `_buffer`, DOM nodes, sockets) are stripped on write —
see `chatMetadataIdbSchema.js`.

Archive **reads** (virtualized list) are owned by task **7.1** in
`app_front/features/chat/chatArchiveCatalog.js` and
`app_front/features/chat/chatArchiveDataSource.js` (RAM first, then
`listChatMetadataChatRecords(..., { archivedOnly: true })`). This schema only
defines `archivedFlag` / `byArchived` for retention and those queries.

### List GET freshness (7.1)

Policy module: `app_front/features/chat/chatListLoadFreshness.js`.

| Rule | Behaviour |
| --- | --- |
| In-flight join | A later caller joins the same promise when the in-flight scope already covers the request (`full` covers `live`). |
| TTL skip | After a successful GET, skip an identical scope for **15 s** (`live`) or **30 s** (`full` / `includeArchived`). |
| Invalidation | `forceRefresh: true`, auth session rotation, or `getChatBootListHydrationController().bumpListRevision()` (e.g. live-sync reload) require a new GET. |
| Pending trim | A merged `pendingLoadQuery` follow-up is dropped when the completed in-flight scope already satisfied it (avoids a second full GET on rapid archive re-open). |

HTTP list responses are **not** paginated at 7.1: real data (~1167 archived in
`data/chats.json`, IDB cap 5000) stays one `GET /api/chats?includeArchived=1`;
DOM windowing is task **7.2**.
