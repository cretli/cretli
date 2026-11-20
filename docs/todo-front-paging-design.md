# Todo front end: rendering and paging (design v2, phase 3 / section 3.9)

Status: **design only, no code.** v2 of 2026-11-13 after two independent plan reviews (both FAIL on v1).
Implements section 3.9 of [todo-scalable-architecture.md](todo-scalable-architecture.md) on top of the reviewed
`GET /api/todos/page`, `/counts`, `/:id/children` and the point read `GET /api/todos/:id`
(`lib/routes/todos-routes.js:694-760`, `lib/persist/todo-repository.js`). Legacy `GET /api/todos` stays unchanged.

**Parent decision (rescope).** v1 changed the data source in its first slice and broke consumers of the whole list.
v2 splits the work by risk:

- **F1 -- render-only.** The whole slim list stays the single source of truth in memory (`S.latestItems`, same
  fetch, same mutation-response handling). F1 only makes rendering, counting and refreshing cheaper. No consumer changes.
- **F2 -- data layer.** Active-set loading, `shape=slim` pages, server counters, paged Done tab. Every review finding is
  an explicit requirement/gate here (section 6).
- **F3 -- tree on expand, server readiness.**

Binding constraints for the implementation (`.agents/skills/cretli-ui/SKILL.md`, `docs/frontend-architecture.md`,
`tests/front-size-ratchet.test.js`): colours only through `var(--cr-*)`, rem sizes, sentence case, copy through
`t('key')` (en + pl), English comments, no `innerHTML` in new files. The ratchet only freezes files **over 1000 lines**
(`front-size-ratchet.test.js:42`, plus new files <= 1000 / zero innerHTML), so "put new code in new small modules" is a
**project choice** (target <= 600 lines), not a ratchet requirement; `todoTreeView.js` (817), `todoToolbar.js` (562),
`todoRowMenu.js` (620) and `core/api/todos.js` (550) should still delegate rather than grow.

## 1. Current state (verified in code)

| Fact | Evidence |
| --- | --- |
| One request loads the whole lean list on tab show, workspace switch and every `cretli:todo-changed` (debounced 400 ms); the result replaces `S.latestItems`. | `todoListRefresh.js:88-122`, `todoFieldHandlers.js:148-165`, `core/api/todos.js:33-39` |
| `renderList` derives visible set, tree rows, deferred/feedback split, tab counters and a paint-skip key (joins **all** `id@updatedAt`) from that array. | `todoListRender.js:46-150` |
| Rows are painted in chunks of 60 into a plain `.todo-rows` container: DOM grows with the list, no windowing. | `todoListRender.js:166-196` |
| Real workspace: 2000 rows, ~75 % `done` (1514), 242 deferred, 196 idea, 33 doing, 15 ready, depth <= 5. | scalable-architecture section 2 |
| `GET /api/todos` already sends `ETag` + `Cache-Control: no-cache` and answers 304 on `req.fresh`; the body is cached per file revision (3 s TTL). So browser-level conditional GET exists; whether it is effective for `getTodos` (it goes through `dedupeGetJson`/`sharedStartupGet`) must be measured. | `todos-routes.js:656-690` |
| Lean rows drop `changelog`, `leafMaterial`, `execution`, `chats` (-> scalars), `linkedChatIds`, compact `review`, `integration` limited to 5 keys, `body`/`plan.markdown` cut to a preview; rows still carry `batchEligibility`, `integrationSummary`, `review`. | `slimTodoForList` `todos-routes.js:345-395`, `integrate-batch.js:259-276` |
| `/page` light rows are **not** the lean row: no `body`, `blockedReason`, `plan`, `integration`/`integrationSummary`, `review`, `feedbackOrigin`, `batchEligibility`, chat scalars, `worktree`. Page envelope uses `rows`, `nextCursor`, `revision`, `stale`. | `todo-repository.js:49-91,420-455` |
| `revision` is an opaque, **equality-only** token (a file signature today), not an ordered counter. | `todo-repository.js:654-657` |
| `/counts` counts **individual rows** by status and by `reviewCodeState`. | `todo-repository.js:185-197,628-648` |
| Blocked tab and counter come from the watcher view, not the list. | `watcherPanel.js:119`, `todoPanel.js:101` |
| **Payload size: not measured.** The dev server is HTTPS + authenticated; I did not read `data/` or look for credentials. Step 0 (section 8) produces the numbers; figures in section 2.4 are expectations, not measurements. | -- |

## 2. F1 -- render-only

Data flow is untouched: `refreshTodoList` -> `getTodos({slim})` -> `listModel.applySuccess` -> `S.latestItems`.
Everything below happens after that point. Voice, mention picker, batch/integrate, mutation responses, review badges,
stage view, offline state, live updates and workspace scope keep exactly their current inputs.

### 2.0 Step 0 -- measured baseline that DECIDES what ships

The size of the DOM problem is **not known**: on a first visit `applyCollapseDefaults` already collapses every finished
parent (`todoPanelContext.js:163-170`), so 1514 `done` records do not mean 1514 rows in `flattenTodoTree`/DOM. Before any
F1 code, on the real workspace and under the current default filters, record: (1) flattened `rows.length` and mounted
`.todo-row` count per tab (list, deferred, feedback) with default and with "all expanded" state; (2) `todo.renderList`
and `todo.paintRow` probe totals, long tasks on a cold tab show (`browser_trc_*`); (3) bytes of `GET /api/todos?slim=1`
(200 vs 304) and the per-field table (2.4).

**Decision rule (ships only if the number justifies the risk):**
- *Windowing (2.1)* ships only if, in the default state, the median mounted rows are **> 300** or the cold tab show has a
  task **> 100 ms** attributable to row paint. Otherwise it is deferred to F2 (where it is required for the Done tab).
- *Folding (2.2)* ships only if, after default collapse, **> 40 %** of flattened rows are closed (`done`) children of open
  parents **and** windowing is not already enough to meet the paint gate. Otherwise dropped.
- *No-op refresh/memoized counters (2.3)* ship regardless (cheap, local, no behaviour change) when the unchanged-refresh
  path costs > 20 ms on the real workspace; otherwise skipped.
- *Slim trimming (2.4)* ships per field only with the byte table and the grep proof.
If none of the thresholds is met, F1 reduces to "measure, record, ship 2.3 if warranted" and the project proceeds to F2.

### 2.1 Windowed mount of the flat row list

`renderListImpl` already produces a flat, ordered `rows` array before touching the DOM (`todoListRender.js:110-123`).
F1 mounts only part of it:

- Reuse the DOM-free math of the sidebar archive virtualizer (`sidebarArchiveVirtualizer.js`: `buildArchiveRowOffsetPrefix`,
  `findArchiveRowIndexAtScroll`, `selectArchiveVisibleWindow`, `applyArchiveScrollAnchor`,
  `computeArchiveListScrollTopForAnchor`). Step 1 is a pure move to `app_front/lib/virtualWindow.js` (archive file
  re-exports; sidebar tests unchanged). Note the archive virtualizer recenters **one contiguous window** around an anchor
  and hands focus off when a row leaves it (`sidebarArchiveVirtualFocus.js:137`, `reconcileArchiveFocusAfterWindowChange`);
  the todo window must **not** copy that focus transfer.
- **Mount policy: disjoint runs.** The mounted set is the union of (a) the viewport run (viewport rows +- overscan 4,
  cap 64) and (b) one small run (the row +- 0) per **pinned** row far from the viewport. Between runs the container holds
  one spacer element per gap whose height is the prefix-sum difference, so geometry, scrollbar and `offsetTop` of every
  mounted row match the unwindowed layout. Pinned rows: the focused row, the dragged row and its current drop target (pointer
  capture lives on the grip, `onGripPointerDown`, so the dragged row must stay mounted), a row with an open menu
  (`rowMenus`, `todoPanelState.js`), the editor's row. Hard bound: 64 + at most 5 pinned runs; pins beyond that are
  released oldest first (menu closes, editor does not need its row). A spacer is a plain `div` with `aria-hidden`, never a
  `.todo-row`.
- **Threshold:** lists <= 150 rows (after step-0 tuning) render exactly as today.
- **renderListImpl rewiring (must be explicit, tested):** above the threshold (i) the chunked paint
  (`TODO_PAINT_CHUNK`, `todoPaintContinuation`, `todoPaintResumeFrom`, `todoListRender.js:166-196`) is bypassed -- the window
  is small; (ii) the paint-skip check `querySelectorAll('.todo-row').length === rows.length` (`:133`) can never hold while
  windowed and compares against the mounted-row expectation instead; (iii) the deferred section head is positioned by child
  index (`headIndex = split.main.length`, `:153-157`) -- it becomes a logical row of the window (with its own height) rather
  than an `insertBefore` by DOM index.
- **Lookups by id.** `todoRowElForId` (`todoBatchView.js:84-89`) and focus restore (`todoPanelContext.js:361`) return null
  for unmounted rows. Callers use `ensureRowMounted(id)`: scroll the row into the window, mount, then focus. The focus id
  stored in view memory is **not** pinned; restore mounts it explicitly.
- **Row height.** Estimate from a rem-based CSS custom property read via `getComputedStyle` (UI scaled by `--cr-ui-scale`),
  real heights measured with one `ResizeObserver` into a typed array; prefix sums rebuilt lazily. **Invalidation:** on
  container width change (ResizeObserver on the list), `--cr-ui-scale` / font-size setting change, language change and the
  `max-width: 640px` media query flip, measured heights are discarded and re-measured for mounted rows (estimates for the rest).
- **a11y.** Keep `role="tree"`/`treeitem`; `aria-level` from the row, and `aria-setsize`/`aria-posinset` are **sibling-level**
  (position among siblings of the same parent in the *full* `rows` array, computed once per render), not the flat index.
  No `aria-rowcount` (grid/table only). Keyboard: Arrow/Home/End/PageUp/PageDown over the logical list through
  `ensureRowMounted`; Tab stays natural because the focused row is pinned.
- **Selection:** selection is an id set (`todoList.batchSelected`); eligibility comes from the full visible rows
  (`currentBatchSelection`, `todoBatchView.js:62-67`), not from mounted DOM; checkbox state is repainted on mount.
  `pruneBatchSelection` keeps pruning against the full eligible list (`todoListRender.js:207-211`). No shift/range
  selection handler exists today (grep), so none must be preserved.
- **Drag and drop:** `resolveTodoDrop` works on the full `S.latestItems` (`todoRowInteractions.js:68`); only mounted rows
  are targets; edge auto-scroll mounts more rows while dragging.
- **Scroll/focus memory:** `buildTodoViewMemorySlice` additionally stores `{ anchorId, offsetPx }`; restore resolves the
  anchor on the full `rows` array. Old slices with `scrollTop` still work.

### 2.2 Folded closed children (render-only stubs)

Decided by the step-0 rule. Done children of an open parent are folded into one **render-only stub row** "N done" in the view
layer after `flattenTodoTree`.

- **Span rule.** Folding operates on **complete flattened subtree spans**: a done child folds together with *all* of its
  descendants that `flattenTodoTree` emitted after it (until the next row of level <= the child's). An expanded done child
  whose own descendants are visible is never folded half-way; if any row of the span is pinned, selected or a search hit,
  the stub stays expanded.
- **Never in data.** Stubs live only in the `rows` array given to the painter; never in `S.latestItems`, sibling groups,
  `readTodoRowMark`, `isTodoReviewedButOpen`, toolbar lengths, `canAddTodoChild` or the batch eligible list. `hasChildren`
  of the parent comes from the real list.
- **Batch selection invariant (blocking review finding).** `buildBatchSelection` flattens `items` with only the *real*
  collapse set (`todoBatchSelection.js:46-63`; `currentBatchSelection`, `todoBatchView.js:62-67`; `paintBatchActionBar`
  `:127,139`; prune `todoListRender.js:207-211`), so folded done leaves -- exactly the `verify` candidates
  (`integrate-batch.js:232`) -- would still count as eligible and "select all" could send hidden rows, breaking "a hidden row
  can never be sent" (`todoBatchSelection.js:84-85`). **Rule: folding is disabled while `S.batchSelectionMode` is true**
  (stubs auto-expand exactly like search/filters do), so the eligible set equals the visible set by construction. Entering
  batch mode expands stubs and leaving it restores the previous fold state. (Alternative considered: pass fold ids through
  `effectiveCollapsedIds`; rejected because it makes eligibility depend on a view-only concept.)
- **Auto-expand** also on: search, active review/integration filter, `deferredSectionOpen`, pinned/selected/hit rows.
- **Drag and drop.** A stub is never a drop target or drag source. `nest`/`after` on a parent computes its index from the full
  list (as today) and cannot land "inside" a folded group because the stub is not a sibling row; a drag over a folded group
  auto-expands nothing and the drop marker snaps to the nearest real row.
- **Persistence.** Expand state is per workspace via the scoped-storage helpers (`readScopedStorage` with a new prefix, like
  the sort key, `todoPanelContext.js` `SORT_PREFIX`), cleared in `resetTodoWorkspaceView` (`todoFieldHandlers.js:120-128`).
  Kill switch `cretli-todo-fold-done=0`.

### 2.3 No-op refresh and memoized counters

- Counters (`countDeferredRoots`, `countOpenFeedback`, toolbar status/review/integration counts) keep today's definitions
  over `S.latestItems`; they are memoized per list identity / `rev` and the filter-menu counts are computed lazily when the
  menu opens (`todoToolbar.js:108-155`).
- The paint-skip key (`computePaintSkipKey`, `todoListRender.js:46-73`) replaces its whole-list joins by `rev` + mounted ids.
- **Detail-cache and `applyCachedDetail` skipping is gated on an unchanged payload `rev`.** `updatedAt` alone does not prove
  unchanged content: `mergeCachedDetail` (`todoDetailCache.js:17-29`) also checks `review.generation` and chat count / latest
  chat / `chatLastAt`, because chats change without bumping `updatedAt`. Rule: skip the merge only when the payload `rev` is
  unchanged (then every row is identical); otherwise run every existing validity check per row. Tests: same `updatedAt` with a
  changed chat count / latest chat / `chatLastAt` / `review.generation` must still stay lean/refresh.
- Conditional GET: measure first (step 0); if the 304 path is not taken for `getTodos`, fix the client cache option rather
  than add an endpoint.


### 2.4 Lighter slim payload (measure first, additive, proven unread)

Step 0 produces a per-field byte table of `GET /api/todos?slim=1` for the large workspace (script walks the response and
sums `JSON.stringify` bytes per top-level field and per nested key; also gzip size). Only fields that **no consumer
reads** may be trimmed, proven by a repo-wide grep recorded in the PR. Candidates to examine, not assumed: `body` and
`plan.markdown` previews on **done** rows (`LEAN_TEXT_PREVIEW_CHARS`; search reads body, `isFeedbackRootTodo` reads the
body prefix, editor reads detail separately), `review` sub-objects of done parents, `batchEligibility.reason` text, empty
`chatCount`. Consumers of the lean list that must be included in the grep: panel (`todoListRefresh`), voice
(`realtimeWorkDeps.js:48-49`), initiatives (`features/initiatives/initiativesApi.js:77-81`), settings watcher
(`features/settings/watcher/refresh.js:125-129`), decisions (`features/decisions/decisionsPanel.js:43-47`),
and server-side MCP `todo_list` (`remote-api-client.js`). No trimming ships without the table and the grep.

### 2.5 F1 acceptance gates

0. Step-0 numbers recorded and the decision rule applied; sections whose threshold is not met are not shipped.
1. Behavioural parity: flags off, or lists <= threshold, produce the same DOM as today (existing todo UI tests unchanged).
2. Mounted `.todo-row` <= 64 + pinned runs for a 2000-row list; the cold tab show meets the step-0 target (task <= 100 ms,
   >= 50 % shorter median of 3).
3. New tests: **fold on + batch mode + "select all eligible" sends only visible rows**; **subtree-span folding** (an expanded done
   child's descendants never stay visible under a collapsed stub); **simultaneous distant pins** (focused row, dragged row,
   open menu, editor row) while scrolling keep geometry and pointer capture; unmounted selected id survives scroll and
   refresh; DnD with a stub between source and target; focus restore of an unmounted row; renderListImpl rewiring (skip check,
   deferred head, chunked paint bypass); stub state cleared by `resetTodoWorkspaceView`; same-`updatedAt` changed-chat/review
   detail-cache cases.
4. Counters equal legacy values for all fixtures (same code).
5. `front-size-ratchet`, no new `innerHTML`, i18n parity green.
6. Flag-off restores the legacy render path exactly.
7. Memory: `lib/browser/trace-summary.js` exposes no heap figure (`:73-79`), so memory is **not** a trace-based gate; if needed
   it is measured with `performance.memory`/heap snapshots outside the trace and treated as informational.

## 3. Consumer inventory (whole-list readers)

"Needs" = what the consumer really reads. **F1 keeps every one of these on `S.latestItems`/the full slim list.**

| # | Consumer (evidence) | Needs | Target |
| --- | --- | --- | --- |
| C1 | Tree: `getVisibleTodoItems` -> `buildTodoTreeRows` -> `flattenTodoTree` (`todoPanelContext.js:248-285`, `todoTreeView.js:288-320`) | open rows + ancestors + count of closed children | F1 window/stubs, F2 active set |
| C2 | Root-status filter (`todoTreeView.js:132-158`) | whole tree | F2 server filter |
| C3 | Deferred section, feedback tab (`todoListRender.js:110-123`) | whole list | F2 paged / F3 |
| C4 | Tab counters (`todoTabCounts.js`, `todoListRender.js:83-90`) | two integers | F1 memoized local; F2 server dimension |
| C5 | Toolbar counts: **entire subtrees** selected by root status (`todoToolbar.js:113-115`, `filterTodoItemsByRootStatus`), review counts over **leaves only** with "stale" = plan OR code (`todoReviewBadge.js:399-410`), integration counts (`todoToolbar.js:150-155`) | subtree-level and leaf-level counts | F1 local; F2 requires equivalent server dimensions (R9) |
| C6 | Readiness/blocked marks (`todoTreeView.js:658-750`, `lib/todo-tree.js`) | open siblings, ancestors, parallel scope | F1 local; F2 on active set (R2); F3 server |
| C7 | Status icon + subtree agents (`todoStatusIcon.js:34-63`) | subtree of the row | F1 local |
| C8 | Stage stepper / plan inheritance (`todoRowRender.js:132,190`, `todoEditor.js:56-59`, `todoDetail.js:191-193`) | ancestor chain, direct children | F1 local; F2 R1 |
| C9 | Review badge/aggregate (`todoRowRender.js:174`, `todoReviewBadge.js:336`) | row + child aggregate | F1 local; F2 full-data aggregate (R8) |
| C10 | Batch selection/eligibility (`todoListRender.js:262-270`, `todoBatchSelection.js:56-99`) | selected ids vs eligible | F1 local; F2 R7 |
| C11 | Subtree integrate ids `listSubtreeIntegrateIds` (`todoIntegrationRules.js:91-96`, `todoRowMenu.js:96`, `todoBatchFlow.js:200`) | leaf ids of a subtree incl. done leaves | F1 local; F2 server subtree ids **in the same step** |
| C12 | `canAddTodoChild`, `hasChildren`, follow-ups, `isLeaf` (`todoRowMenu.js:94,130,320`, `todoRowInteractions.js:32-34,130`, `todoPanel.js:219`, `todoDetail.js:19-21`, `todoAgentStart.js:324,342`) | parent chain, direct children, `sourceTodoId` | F1 local; F2 server authoritative |
| C13 | Search (`todoPanelContext.js:250-253`, `todoTreeView.js:575`): title **or id** over every row | whole list | F2 (see Q6) |
| C14 | Paint-skip key, status-patch subscriber (`todoListRender.js:57`, `todoPanel.js:140-150`) | list identity | F1 cheaper key |
| C15 | Review refresher refetches whole slim list (`todoFieldHandlers.js:148-165`, `todoReviewRefresh.js`) | changed ids | F1 unchanged; F2 by id |
| C16 | `ensureTodoLoaded` (`todoDetail.js:126-138`) | one row | F1 unchanged |
| C17 | `retryWorkspaceWatcherTodo` (`core/api/todos.js:152-158`) full list for one row | one row | F1 unchanged (candidate for `getTodo`, not required) |
| C18 | Mention picker (`chat/todoMentionPicker.js:192`) full non-slim list | top N by query | F2 |
| C19 | Voice (`realtimeWorkDeps.js:48-49`, `voiceWorkTools.js:254-289`): `listReadyTodoLeaves(items)` for `todo_ready` and `startable` | whole list incl. blockers, plans, integration gates | **stays on the full read until an equivalent server readiness API exists (F3)** |
| C20 | View memory (`todoPanelContext.js:292-370`) | row id + offset | F1 anchor |
| C21 | Offline model (`todoOfflineState.js`, `todoListRefresh.js:112-121`) | last good array | F1 unchanged |
| C22 | Scope guard (`notifyViewContextTodoScope`, `todoListRefresh.js:166-182`) | one row | F1 unchanged |
| C23 | **Drag-and-drop reorder** `resolveTodoDrop` (`todoTreeView.js:769-808`, caller `todoRowInteractions.js:68`) computes `siblingIndex` from the siblings it can see; the server renumbers the **full** group with `placeTodoInSiblingGroup` (`lib/persist/todos-persist.js:1448-1461`). Missing done siblings => wrong index. `todoSubtreeHeight` depth check also undercounts hidden descendants. | real sibling indexes, subtree height | F1 unaffected (full list); F2: either disable DnD under the data-layer flag (safe default) or send the target's real `siblingIndex` **adjusted for removal of the dragged row** (moving A before C in [A,B,C,D] needs index 1, not C's stored index 2; after = adjusted + 1; nest = append); server stays authoritative for depth |
| C24 | Mutation responses: `renderList(data)` after save/plan-approve/delete/menu actions (`todoFieldHandlers.js:41,106`, `todoRowInteractions.js:152`, `todoRowMenu.js:615`) replace `latestItems` with the response list | whole lean list per write (`patchTodo ?slim=1`) | F1 unchanged; F2 needs one flag-aware adapter (R10) |
| C25 | Sort by activity reads **done descendants'** timestamps (`todoTreeView.js:238-255`) | subtree last activity | F2: server `lastActivityAt` per row (subtree max) |
| C26 | Initiatives panel `slim=1` fetch (`features/initiatives/initiativesApi.js:77-81`) | whole lean list | unchanged (legacy route stays) |
| C27 | Settings watcher refresh (`features/settings/watcher/refresh.js:125-129`), decisions panel (`features/decisions/decisionsPanel.js:43-47`) | whole list / titles | unchanged until a titles-by-id endpoint exists |
| C28 | Editor `hasChildren`, `followUps`, `planInherited` (`todoEditor.js:56-59`, `todoDetail.js:19-21,191-193`) | children, source chain, ancestors | F2 point read with ancestors |

Not consumers: sidebar; blocked tab (watcher view).

## 4. F2 -- data layer (active set, server counters, paged Done tab)

Only after F1 has shipped and been measured. Each requirement below is a gate; a failing one blocks F2 (or its slice).

**Backend additions (all additive, legacy route byte-identical).**
1. `GET /api/todos/page?shape=slim` -- rows in the lean shape of `slimTodoForList` **plus** `batchEligibility`,
   `integrationSummary`, `review`, `feedbackOrigin`, `blockedReason`, `plan` flags, chat scalars. `batchEligibility`
   needs full-list context server side (`hasAwaitingDescendantWorktree`, `integrate-batch.js:174,237`), so it is computed
   by the server from the full index, never by the client.
2. `GET /api/todos/page?scope=active&includeAncestors=1` and a cursor-following wrapper `GET /api/todos/active`
   (`maxRows`, `truncated`). Parents carry `closedChildCount`, `lastActivityAt` (subtree max, C25) and the stored
   (persisted) status; client never recomputes parent status from partial children.
3. `GET /api/todos/:id/subtree?fields=ids&eligible=integrate&limit=1000` (C11) and `GET /api/todos/ids?<filter>` for
   "select all matching"; `GET /api/todos/page?ids=` (<= 100) for by-id reads.
4. Point read by id **or prefix** for pasted ids (C13) -- shipped in the **first F2 step that drops closed rows**, not later.
5. Counters (R9): new dimensions with the **same semantics the UI shows today**, each with a fixture comparing server and
   legacy front-end function: `subtreeByRootStatus` (count of rows in subtrees whose root has status s),
   `reviewLeaves` (leaves only; `stale` = plan OR code), `byIntegration`, `topmostByStatus` (deferred roots),
   `feedbackOpen`. Raw `byStatus`/`byReviewCode` histograms are **not** substitutes and the parity gate does not accept them.

**Requirements carried from review.**
- **R1 (ancestors).** Every open row's ancestors are in the loaded set regardless of status.
- **R2 (readiness parity).** `readTodoRowMark`/`BlockKind`/`GateMark` on the active set equal the full-list value for every
  row of the set. Property test (randomized trees + the real workspace). Documented parent-status invariant: **no open
  child under a done parent** (`synchronizeTodoParentStatuses`, `lib/todo-tree.js:292-317`) -- asserted in the same test.
  Caveats to cover: `isFeedbackDerivedTodo` follows `sourceTodoId` to a possibly-done row (`lib/feedback-marker.js:116-131`);
  `collectTodoSubtreeScopePaths` returns differently for "no kids" and "only done kids" (hence `closedChildCount`).
- **R3 (closed children outside the model)** -- paged/expanded closed children live in a per-parent LRU and are never merged
  into `S.latestItems`. **Prerequisite R17 below must land first.**
- **R5 (done -> open)**: fetch the row and its ancestors by id, insert; open -> done: remove and bump parent counter.
- **R6 (overflow).** If the active set is truncated, the client takes the **atomic legacy load** (whole slim list, F1 path)
  instead of a partial tree -- a 3000-row truncated tree cannot preserve ancestor/sibling completeness. Gate: a synthetic
  workspace with 20 000 **open** rows works through that fallback (and is the F3 motivation).
- **R7 (integration closure).** Every done row with `batchEligibility.mode !== 'none'` or an unintegrated integration state
  stays in the loaded set; server subtree ids (C11) ship in the same step; the integration filter and "pending" count
  (`todoPanelContext.js:249-255`, `todoToolbar.js:154-155`) are either server-computed (R9) or computed over a set that
  contains all such rows. `lib/integrate-batch.js:232` (`status === 'done'` for `verify`) is the reason.
  A done parent must not lose its descendant-worktree guard when its children are paged out.
- **R8 (aggregates from full data).** Review aggregates of a parent and persisted parent statuses come from the server
  (counter-based, scalable-architecture section 3.3), never from the loaded subset.
- **R10 (mutation adapter).** One central, flag-aware adapter replaces direct `renderList(data)` after mutations
  (C24): it projects the response onto the active set or refetches it, and invalidates cached pages/child views.
- **R11 (revision semantics).** `revision` is equality-only. No "lower revision" or "expected next" logic. Each fetch carries a
  request-generation guard (stale response dropped by generation, as `S.refreshGeneration` does today); on token change the
  client invalidates affected pages and child views and **restarts the cursor chain** (a cursor cannot recover rows moved
  before its boundary); counters are accepted only from a response matching the latest generation. Test: interleaved
  responses, token change mid-scroll, `stale: true` pages.
- **R12 (selection across eviction).** Selection stays an id set; page eviction never prunes it. Pruning uses a server
  recheck (`ids` filtered by current criteria) on token change. Batch request ordering is the full-list order
  (`buildBatchRequestIds`, `todoBatchSelection.js:73-99`), so the server returns ordered ids.
- **R13 (voice).** Stays on the full read; migrating requires a server readiness API with parity tests (C19).
- **R14 (search).** Server `q` changes semantics: the repository haystack is `title + preview` (`todo-repository.js` hay),
  the UI searches title **or id** over every row. F2 ships: id/prefix point read + `q` for text; closed-row hits are
  included (Q6).
- **R17 (shared lookup/detail adapter -- F2 prerequisite, blocks switching sources).** `findItem`/`findItemWithDetail`
  (`todoDetail.js:94-104`) resolve only `S.latestItems`; row menus call `findItem` (`todoRowMenu.js`), and `ensureTodoLoaded`
  (`todoDetail.js:126-138`) refetches the **full list** (C16). Before any source switch, introduce one adapter
  `resolveTodo(id) -> { item, ancestors }` over (active rows + page cache + children cache), falling back to the point
  read `GET /api/todos/:id` (id or prefix) with ancestor context, with explicit invalidation on token change (R11) and on
  workspace reset. Row menus, editor, `ensureTodoLoaded`, view-context scope check (C22), agent-start (C12) and detail
  loading go through it; `findItem` becomes a thin wrapper. Gate: row menu, editor, deep link and stage view work for a
  paged closed row that is not in `S.latestItems`.
- **R15 (DnD)** as C23. **R16 (done-tab a11y):** list/tree ARIA, no grid roles; real DOM eviction with focus retention
  (an LRU of data pages alone cannot bound mounted rows -- the F1 window does).

**F2 flow.** Flag `cretli-todo-paging` (default off). On: `getTodos` active set -> model; Done/Deferred tabs read
`/page?status=done&shape=slim` (sort `updated`, limit 50) through the F1 window; counters from the R9 dimensions; live
updates by id (`page?ids=`), revision token change => R11.

**F2 gates.** (1) R2/R7/R9 parity tests green on randomized fixtures and the real workspace; (2) first-request bytes
<= 40 % of the F1 baseline and <= 2 requests on tab show; (3) all items R1-R16 have a named test; (4) flag-off is
byte-identical to F1; (5) integrate/batch, DnD, voice, review badges, stage view, offline, mutation flows pass the
existing suites with the flag on.

## 5. F3 -- tree on expand and server-side readiness

Children of open parents via `/children?shape=slim`; server fields `blocked`/`ready`/`planInherited`/`lastActivityAt`;
voice readiness API (R13); feedback category filter; titles-by-id for settings/decisions; then retire the whole-list
consumers one by one. Gate: no request in the todo flow returns O(N) rows; a 100 000-row synthetic workspace opens within
the budget; the R6 fallback is no longer reachable.

## 6. Tests

Existing tests that will need updating (verified by grep for the modules): `tests/todo-tree-view.test.js`,
`tests/todo-list-performance.test.js` (reuse `referenceMark` for R2 parity), `tests/todo-review-refresh.test.js`,
`tests/todo-batch-selection.test.js`, `tests/todo-batch-actions.test.js`, `tests/feedback-category.test.js`,
`tests/todo-offline-state.test.js`, `tests/todo-list-state.test.js`, `tests/todo-workspace-scope.test.js`,
`tests/scoped-request-adapters.test.js`, `tests/view-memory-panel.test.js`, `tests/todo-editor-i18n-saving.test.js`,
`tests/todo-mention.test.js`, `tests/ui-freeze-render-budgets.test.js`, `tests/e2e/docs.spec.js` (opens a todo row by id, line ~191), `tests/todo-row-menu-lazy.test.js` and `tests/todo-review-badge.test.js` (source-contract checks: re-verify after refactors, not behavioural), `tests/front-size-ratchet.test.js` +
`tests/fixtures/front-size-baseline.json` (tighten with `node scripts/front-size-baseline.js --write`); server side
`tests/todo-repository.test.js`, `tests/todo-repository-routes.test.js`, `tests/todos-routes.test.js`,
`tests/todo-read-model-parity.test.js`.

New in F1 (only for the parts step 0 approves): `todo-row-window.test.js` (window math, disjoint runs with simultaneous distant
pins, anchor, sibling-level aria), `todo-fold-done.test.js` (stubs never in `S.latestItems`; subtree-span folding; fold on +
batch mode + select all sends only visible rows; auto-expand on search/filter/pins; DnD with a stub between source and target),
`todo-counts-memo.test.js`, `todo-detail-cache-rev.test.js` (same `updatedAt`, changed chats/review), selection/keyboard
tests with an unmounted target. New in F2: R17 adapter (paged row menu/editor/deep link), R2/R7/R9 parity, R11 generation/restart, R10 adapter, R12 selection survival, R14 id search,
a 20 000-open-row fallback test.

## 7. Open questions -- resolved with a recommendation (owner marked)

| Q | Recommendation | Owner? |
| --- | --- | --- |
| Q1 Done roots only in a flat Done tab? | F1 does not change the tree (done roots stay under today's root-status filter, windowed). Flat Done tab only in F2; keep tree browsing of done subtrees via the stub/expand. | **owner** (UX change in F2) |
| Q2 Stub wording/placement | "N done" after the last open sibling, collapsed; auto-expands on search/filter. | no |
| Q3 Deferred cap | Keep deferred in the active set; revisit at > 1000. | no |
| Q4 Sentinel + LRU vs wait for virtualizer | Moot: the F1 window (if step 0 approves it) is real DOM eviction with disjoint pinned runs. | no |
| Q5 select-all cap | Equal to the `integrate-batch` server cap (read it before F2); 1000 as default. | no |
| Q6 Search over closed rows | F1 unchanged (still searches all). F2 must not regress: id/prefix point read + server `q` including done rows; accepting a regression needs an explicit decision. | **owner** if any regression is allowed |
| Q7 Feedback tab | Client-side in F1/F2 (open feedback is always in the active set); server filter in F3. | no |
| Q8 Flag scope | F1: tiny local kill switches (`cretli-todo-window`, `cretli-todo-fold-done`) for quick rollback. F2: server setting so one switch rolls back all clients. | **owner** (setting placement) |
| Q9 `closedChildCount` from JSON index | Yes, derived per revision in `buildIndex`; becomes a counter with SQLite. | no |
| Q10 Mounted-row budget / threshold (64, 150) | Start with these, tune from step-0 measurements; decision rule in 2.0 (> 300 mounted rows or > 100 ms paint task for windowing; > 40 % closed children for folding). | no |
| Q11 Folding vs batch mode | Folding is off in batch mode (eligible == visible by construction). | no |

## 8. Measurement plan (built-in Browser, no private Playwright)

Step 0 (before any code) records a baseline in the PR description:

1. **Payload:** `browser_open` the Todo tab of the large workspace, `browser_network` for `GET /api/todos?slim=1`: bytes,
   gzip bytes, status (200 vs 304), timing. A one-off node script (run by the owner or on a copy, not on `data/` by an agent)
   sums bytes per field of the response to produce the table needed in 2.4.
2. **Rendering:** `browser_trc_start` / `browser_trc_sum` around a cold tab show and a scripted scroll through the list;
   long tasks, scripting time; `browser_console` for existing probes (`probeSync/probeStart` in `lib/perfProbe.js`:
   `todo.fetch`, `todo.renderList`, `todo.paintRow`, `todo.applySuccess`, `todo.isUnchanged`).
3. **DOM/memory:** `browser_dom` count of `.todo-row`. Heap is **not** available from the trace summary
   (`lib/browser/trace-summary.js:73-79`): use `browser_console` with `performance.memory` or a heap snapshot, informational only.
4. **Visual:** `browser_screenshot` of tree, stubs, expanded stub and filter menu before/after.
5. Server side: `scripts/stall-todos-dedupe.mjs`, `scripts/perf-bench.mjs`, `scripts/architecture-stall-profile.mjs`; render
   budgets in `lib/uiFreezeRenderBudgets.js` (add a todo mounted-rows budget). Synthetic 20 000-row workspace from
   `scripts/benchmark-todos.js`.

Step 0 outputs the decision-rule inputs of section 2.0. Run each scenario 3 times on the same data, report the median. Budgets (targets until baselined): first paint -50 % (F1) /
-70 % (F2); no task > 100 ms (F1) / 50 ms (F2); mounted rows <= 64 + pinned; interaction p95 (expand, filter, tab switch)
<= 100 ms (F1) / 50 ms (F2); first-request bytes <= 40 % of baseline (F2).

## 9. Risks

1. Windowing interacts with focus, drag, menus, selection: mitigated by disjoint pinned runs, threshold, tests with an unmounted
   target, and the kill switch; it ships only if step 0 shows it is needed.
2. Stub folding hides closed rows: disabled in batch mode, auto-expand on search/filter/pins, visible count, kill switch.
3. Payload trimming can break an unlisted consumer: gated by measured table + repo-wide grep (including the consumers
   listed in 2.4 and C26-C27, and MCP).
4. F2 correctness hinges on R2 and R7 parity; any failing counterexample ships the missing field or drops the slice.
5. Dirty working tree: `todos-routes.js`, `todo-read-model.js` and tests are uncommitted; F2 backend work rebases onto them.
