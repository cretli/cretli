---
name: cretli-list-endpoint-window
description: Add an optional server-side scope/window param to an existing Cretli list GET (e.g. GET /api/chats) to shrink a heavy round-trip, without breaking backward compatibility or the client's replace-based reconcile / fullIndex activity-pruning coupling; prove the reduction at the route/HTTP layer.
source: auto-skill
extracted_at: '2026-10-07T15:05:41.963Z'
---

# Cretli list-endpoint window (scoped partial payload for an existing GET)

Trigger: a delegated `implement` round asks to "limit the payload/round-trip" of an
expansion that currently pulls a full index (e.g. archive expand firing
`GET /api/chats?includeArchived=1` → ~1797 rows / ~1.2 MB), and the only verifiable,
hard requirements live at the **route/payload layer**. Chosen strategy: server-side
window keyed by workspace, added as a NEW optional query param.

This is the coupling map that made the change safe. All facts below were read off the
live tree on 2026-10-07 (branch `next/2026-09-28`); re-verify before trusting line
numbers.

## The three invariants that constrain any window

1. **The client REPLACES the runtime list, it does not merge.**
   `app_front/features/chat/chatController.js` `loadChatsFromServer(...)` reconciles the
   response with `reconcileServerChatsInTimeSlices`, then does
   `chats.length = 0; nextChats.forEach((c) => chats.push(c))` where `nextChats` = the
   response rows + "live orphans" (existing rows that still hold a `chat.pane` or an open
   `ws`). A windowed response that omits rows therefore **drops them from runtime**. The
   fix: keep **every live row of every workspace** in the scoped response and only window
   the *archived* subset. Live tree correctness survives the replace.

2. **`fullIndex:true` is the gate that prunes activity for absent ids.**
   `lib/chat-list-payload.js` `shouldPruneChatActivityFromListResponse(data)` = true only
   when `data.fullIndex === true && data.chats.length > 0`; the controller then calls
   `pruneChatActivityToKnownIds(serverChatIds, { authoritative: true })`. A partial/windowed
   payload MUST return **`fullIndex:false`** so it can never prune state for the rows you
   deliberately left out. Route line to edit:
   `const fullIndex = !req.widgetAccess && !pinnedToQuery && includeArchived` → add
   `&& !archiveWorkspace`. The UNscoped archived path keeps `fullIndex:true` unchanged
   (backward-compat requirement — do NOT touch the unscoped tail, widget branch, or
   `isFullChatListIndexForServer`).

3. **Multi-open stays correct via the additive IDB archive catalog, not the network.**
   After any `includeArchived` load, `applyListLoadClientEffects` fires
   `onArchiveCatalogHydrate()` → `chatArchiveCatalog.hydrateMissingArchiveIntoRuntime()`,
   which **pushes** archived rows from the local IDB catalog into runtime (dedupe by id).
   So even when a scoped replace drops another workspace's archived rows, the catalog
   re-adds them without a server round-trip. This is what lets you window the network load
   at all — lean on it rather than building a merge path.

## Route-side windowing (lib/routes/chats-routes.js)

- Read the new param and normalize it: a small local helper `normalizeChatWorkspaceScope(v)`
  = `String(v).replace(/\\/g,'/').replace(/\/+$/,'').trim()`. Persisted rows and client keys
  mix `\` and `/` and trailing slashes, so normalize BOTH the scope and each `chat.workspaceFile`.
- Window only when `includeArchived && archiveWorkspace` (and non-widget):
  `liveRows = selectChatsForSidebarList(allChats, { includeArchived:false })` (already includes
  archived ancestors of live chats), then append archived rows matching the scope that are not
  already in `liveRows` (dedupe by `chat.id`). `archivedCounts` stays the **global**
  `countArchivedChatsByWorkspace(allChats)` so collapsed groups keep their count badge.
- Match by `workspaceFile` only, not folder: a workspace file is a **superset** over its clone
  folders, so you can never under-include the expanded group's own rows; the sidebar re-filters
  render through `chatBelongsToWorkspaceGroup`, so over-inclusion is harmless. (Per-folder
  precision would require porting `chatBelongsToWorkspaceGroup` server-side — name it a follow-up,
  don't silently widen.)

## Client threading — keep it minimally invasive

- Plumbing that must carry the scope: `lib/chat-list-payload.js` `buildChatsListApiQuery` (emit
  the param) + `mergeChatListLoadQuery` (preserve it across coalesced loads); `app_front/api.js`
  `getChats` (set the URLSearchParams entry); `chatController.js` builds `apiQuery` from
  `normalized.archiveWorkspace`; `App.js` `requestLoadArchivedChats(workspaceFile)` passes it;
  `sidebarView.js` `toggleArchiveSection` resolves the group's real `workspaceFile`
  (`getWorkspaces().find(w => (w.sidebarKey||w.workspaceFile)===key)?.workspaceFile || key` —
  clone groups carry a `sidebarKey` that is NOT the file) and passes it.
- **Do NOT edit the freshness scope-key / coalescing logic**
  (`app_front/features/chat/chatListLoadFreshness.js` `buildChatListLoadScopeKey`,
  `mergeChatListInFlightScopeKey`, `decideChatListNetworkLoad`). Just add `archiveWorkspace` as an
  EXTRA field in `normalizeChatListLoadQuery`. Verified safe: that suite never `deepEqual`s the
  whole normalized object — it reads specific fields and asserts `buildChatListLoadScopeKey(...)
  === 'full'`, which stays true because the scope field is ignored by the key builder. Keeping the
  key at 'full' means a repeat expand inside the TTL takes `skip-fresh` (no network) and relies on
  catalog hydrate — identical to today, so no regression. This is the "least invasive" the brief
  asks for: fewer files touched, no re-derivation of coalescing edge cases on a dirty tree.

## Prove it at the route/HTTP layer (not in e2e, not by editing counts)

New plain-assert script mirroring `tests/chat-list-poll-http.test.js`: import
`./helpers/isolated-data-dir.js` FIRST, `saveChats([...])` rows spanning ≥2 `workspaceFile`s
with a mix of live + `archivedAt` rows, `registerChatsRoutes` on an `express()` with the same
`ctx` stub shape, `app.listen(0,'127.0.0.1')`, then assert:
- unscoped `?includeArchived=1` → `fullIndex:true` + every archived row (backward compat);
- scoped `?includeArchived=1&archiveWorkspace=<fileA>` → `fullIndex:false`, contains all live
  rows of both files but only fileA's archived rows (the reduction), and `archiveWorkspace` is
  inert without `includeArchived`;
- `archivedCounts` on the scoped response still totals both files (global counts).
`scripts/run-unit-tests.mjs` auto-globs `tests/*.test.js` (and runs `node --test` only when the
source imports `node:test`), so the new file needs no package/runner edit.

## Related gotcha (same round)

A `[TASK]` predicate can be **dimensionally wrong**, not just mislocated: the archive e2e asked to
keep the longtask upper bound as `task.startMs <= clickWindowEndMs`, but `task.startMs` is an
absolute page timestamp while `clickWindowEndMs` is a **delta** from the click — that comparison
drops nearly everything. Re-derive the overlap in correct units
(`taskStart+taskDur > clickStart && taskStart <= clickStart + windowEndDelta`), preserve null guards,
and report the correction as an explicit deviation.
