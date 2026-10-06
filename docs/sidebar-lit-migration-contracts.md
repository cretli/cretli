# Sidebar Lit migration — light DOM contracts (stage 6.2)

This document is the inventory and migration contract for moving the chat sidebar from
imperative HTML strings to Lit **without Shadow DOM**. It defines what must stay stable
for external selectors, delegated events, status patches, drag/swipe, and global SCSS.

Related code constants (scanner tests): `app_front/features/sidebar/sidebarLitMigrationContract.js`.

## Render root: light DOM only

**Decision:** Sidebar Lit components use **light DOM** (`createRenderRoot() { return this; }`),
the same pattern as `LoginApp`, `cr-fs-picker`, and `cr-todo-card`. **Do not** attach
Shadow DOM to chat rows or workspace groups in stages 6.3–6.5.

**Why:**

- Hundreds of call sites query `#app-sidebar .sidebar-chat-item[data-chat-id="…"]` in
  the document tree.
- Status updates patch rows via `querySelector` + `className` / `dataset` in `chat.js`
  (no Lit render pass).
- Global layout lives in `app_front/css/app.scss` (grid columns, harness icons, activity
  chip width). Shadow DOM would break `::part` migration cost and duplicate tokens.

Lit row components are **hosts in the existing tree**, not encapsulated islands.

## Mount boundaries (single owner per subtree)

Today’s ownership model must survive migration. **Never** let Lit and the legacy
`innerHTML` renderer update the same node in the same frame.

| Region | Stable shell (not replaced on rebuild) | Owner today | Lit stage |
|--------|--------------------------------------|-------------|-----------|
| `#app-sidebar` | `<aside>` shell from app HTML | `sidebarView.js` visibility/width/swipe | Unchanged shell |
| `.sidebar-body` | **Static** — delegated click/keydown/pointerdown/drag | `sidebarView.js` `wireBodyEvents()` | **Static** — Lit mounts *inside* lists only |
| `.sidebar-pinned-section` | Replaced when pinned HTML changes | `applyPinnedSection()` | 6.4 |
| `.sidebar-workspaces` `<ul>` | **Never recreated** on rebuild | `reconcileWorkspaceNodes()` | 6.4 — Lit owns children |
| `<li.sidebar-workspace>` | Reused when per-workspace structure sig matches | Legacy `renderWorkspaceGroup` HTML | 6.4 — one Lit host per workspace |
| `<ul.sidebar-chat-list>` | Inside workspace `<li>` | Legacy HTML | 6.4 |
| `<li.sidebar-chat-item>` | Rebuilt when workspace structure sig changes | Legacy `renderChatItem` | **6.3** — `<cr-sidebar-chat-row>` (light DOM) |
| Inside chat row | Spans/buttons | Legacy HTML / `chat.js` patch | **6.3** Lit template; **6.5** patches via Lit props or shared patch helpers |
| `.sidebar-subchat-group`, `.sidebar-archive-group` | Inside workspace list | Legacy HTML | **6.4** |
| Transient active row / badges | Any mounted row | `patchTransientVisualStates()` + `updateSidebarChatStates()` | Outside structural Lit re-render (same as today) |

**6.3 boundary:** Introduce `<cr-sidebar-chat-row chat-id="…">` (light DOM) that renders
the `<li class="sidebar-chat-item" …>` contract. Parent list uses Lit `repeat` **or**
continues to reconcile workspace nodes but **only** mounts row components — no parallel
`renderChatItem` string for the same `data-chat-id`.

**6.4 boundary:** Replace `renderWorkspaceGroup` / `renderSubchatGroup` / archive section
strings with Lit hosts (`<cr-sidebar-workspace>`, etc.). Keep `.sidebar-workspaces` ul
and `.sidebar-body` delegation unchanged.

**6.5 boundary:** Delete `renderChatItem`, `buildSidebarNode` workspace HTML path, and
signature-driven HTML reuse for rows; single code path emits row DOM (Lit). Keep
`renderSignature` semantics (or equivalent) so status/active still skip full rebuilds.

**Forbidden during migration:** Lit updating a row while `updateSidebarChatStates` or
`patchTransientVisualStates` mutates the same `<li>` — coordinate via properties /
requestUpdate after patch, or keep patch targeting stable child selectors inside the row.

## DOM contract — chat row (`<li.sidebar-chat-item>`)

### Element and ARIA

- Tag: `li`
- Classes (base): `sidebar-chat-item` plus optional modifiers (see below)
- Role: `role="option"`
- `aria-selected`: `"true"` | `"false"` (patched transiently)
- `tabindex`: `"0"` on one roving item per `.sidebar-chat-list`, else `"-1"`

### Row `data-*` and inline style

| Attribute | Purpose |
|-----------|---------|
| `data-chat-id` | Primary id; **required** on every row |
| `data-visual-key` | Skip redundant status patch (`chat.js` `dataset.visualKey`) |
| `data-nest-level` | Tree depth for drag/nest |
| `data-parent-id` | Fork parent id |
| `data-archived="1"` | Archive list rows only |
| `style="--sidebar-nest-level:N"` | Optional indent (CSS var) |

### Modifier classes (structural vs transient)

**Structural** (part of render signature / full rebuild): `is-child`, `is-last-child`,
`is-archived`, `has-pin-actions`, `has-push-preview`, `has-activity-status` (also toggled
on status — see below).

**Transient** (patch without signature): `is-active`; drag: `is-drop-nest`,
`is-drop-nest-pending`; keyboard nav filter: `is-subchat-hidden` (reserved for folded
subchat rows — consumers already filter it).

### Child structure (order matters for grid CSS)

1. Tree continuation markers (nest guides) — optional prefix
2. `span.sidebar-chat-item-state.sidebar-chat-item-state--{dotState}` (`aria-hidden`)
3. `span.sidebar-chat-item-harness.sidebar-chat-item-harness--{modifier}` (+ optional `<img>`)
4. `span.sidebar-chat-item-main` → `span.sidebar-chat-item-title` (+ optional badges:
   `sidebar-chat-item-temp-badge`, `sidebar-chat-item-todo-badge`, `sidebar-chat-item-pin-badge`)
   and optional `span.sidebar-chat-item-preview`
5. Optional `span.sidebar-chat-item-subchat-summary` (`data-summary-label`)
6. `span.sidebar-chat-item-awaiting.sidebar-chat-item-awaiting--{tone}` with
   `data-status-tone`, `data-status-label`, `data-activity-key`, `data-status-outcome`,
   optional `hidden`; may contain `span.sidebar-chat-item-activity-label`
7. Action `button.sidebar-chat-action` (+ `sidebar-chat-pin-btn`, `sidebar-chat-archive-btn`,
   `sidebar-chat-restore-btn`, `sidebar-chat-fav-btn`, `sidebar-chat-action-first`)

Parent list: `ul.sidebar-chat-list[role=listbox]` inside `li.sidebar-workspace`.

## Event contract

Events are **delegated on `.sidebar-body`** (bubble phase except pointerdown capture).
Lit rows must not stop propagation on interactive controls except where drag already does.

| Input | Handler | Dispatch rule |
|-------|---------|---------------|
| `click` | `onSidebarBodyClick` | `closest('.sidebar-chat-item')` → select chat; `.sidebar-chat-action` → row actions |
| `keydown` | `onSidebarBodyKeydown` | Arrows/Home/End among `.sidebar-chat-item:not(.is-subchat-hidden)`; Enter/Space |
| `pointerdown` (capture) | `onSidebarBodyPointerDown` | `.sidebar-chat-action` → `stopPropagation()` (vs drag) |
| Chat drag | `sidebarChatDrag.js` on `body` | `closest('.sidebar-chat-item')`; ignores archived/hidden/`is-subchat-hidden`/actions |
| Workspace drag | `sidebarWorkspaceDrag.js` on `body` | `.sidebar-workspace-header` |
| Swipe | `sidebarSwipe.js` on `#app-sidebar` | Defers `render()` while `isSwiping()`; ignores `[hidden]` / `.is-subchat-hidden` |

**Custom window events** (unchanged): `cr-lang-changed` → full sidebar rerender;
`cretli:workspace-watcher-changed` → schedule update.

No new composed shadow events in 6.3–6.5.

## CSS contract

Global rules in `app_front/css/app.scss` (approx. lines 11231–11914) assume:

- `.sidebar-chat-item` flex/grid layout and nest indent via `--sidebar-nest-level`
- State dot: `.sidebar-chat-item-state--*`
- Harness icons: `.sidebar-chat-item-harness--*` (+ theme filters on `img`)
- Activity chip width: `.sidebar-chat-item.has-activity-status` (+ `.has-pin-actions` combo)
- Awaiting tones: `.sidebar-chat-item-awaiting--{disconnected,connecting,syncing,awaiting,approval,question,textarea,choice,active,idle,attention,...}`
- Actions visibility: `.sidebar-chat-item:hover .sidebar-chat-action`, `.is-active`
- Drag affordance: `.is-drop-nest`, `.is-drop-nest-pending`
- Mobile swipe: `body.sidebar-swipe-settling` (aside transform — not row-level)

Lit migration **must not** move these rules into shadow-only sheets without updating this
contract and all consumers.

## Consumer inventory — `.sidebar-chat-item` / `[data-chat-id]`

### Runtime (production)

| File | Lines (approx.) | Usage |
|------|-----------------|--------|
| `app_front/features/sidebar/sidebarView.js` | 993–1088 | `renderChatItem` HTML emission |
| | 1697–1702 | `patchTransientVisualStates` — all rows active class/ARIA |
| | 1749–1757 | Parent row subchat summary badge patch |
| | 1870 | Focus preservation before rebuild |
| | 2054 | `restoreSidebarFocus` |
| | 2222–2224 | `handleChatRowAction` — `closest('.sidebar-chat-item')` |
| | 2382–2383 | Click → `selectChatRow` |
| | 2396–2414 | Keyboard roving focus |
| | 2445–2448 | `ensureChatListRovingTabindex` |
| | 1880 | `setRenderedSidebarChatIds` after render pass |
| `app_front/chat.js` | 3711–3725 | `applyChatListItemVisualState` (sidebar branch) |
| | 3779–3807 | `updateSidebarChatStates` — per-id or full list patch |
| `app_front/features/sidebar/sidebarVisibleChats.js` | 72–73 | `getRenderedSidebarChatIds()` (in-memory set, not DOM) |
| `app_front/features/chat/chatHistorySyncPoll.js` | 594, 603 | Poll scope uses rendered id set |
| `app_front/features/sidebar/sidebarChatDrag.js` | 33–34, 50, 78, 144–154, 215, 287–291 | Drag hit-testing, nest classes, order |
| `app_front/features/sidebar/sidebarChatOrder.js` | 64 | `collectChatIdsFromList` selector |
| `app_front/features/sidebar/sidebarChatStatus.js` | 15, 90 | `ACTIVITY_LABEL_CLASS`, awaiting class string |
| `app_front/features/sidebar/sidebarSwipe.js` | 467 | Ignore hidden/subchat-hidden targets |
| `app_front/App.js` | 2048 | Wires `patchTransientVisualStates` hook from `chat.js` |
| `app_front/css/app.scss` | 11231–11914 | Row layout, states, actions, grid breakpoints |

**Note:** `app_front/features/chat/chatView.js` uses `.chat-list-item[data-chat-id]` in the
modal drawer — parallel contract, not sidebar row class.

### Tests and E2E

| File | Lines (approx.) | Usage |
|------|-----------------|--------|
| `tests/sidebar-signature.test.js` | — | Structural `renderSignature()` behavior (no DOM strings today) |
| `tests/sidebar-transient-patch.test.js` | 83–86, 134–156, 158–168, 233–240 | Patch + source guards for `updateSidebarChatStates` |
| `tests/sidebar-chat-status.test.js` | 16–214 | `applySidebarChatStatusEl` DOM shape |
| `tests/sidebar-chat-order.test.js` | 48 | `data-chat-id` collection |
| `tests/sidebar-swipe.test.js` | — | Swipe behavior (indirect row interaction) |
| `tests/sidebar-keyboard-nav.test.js` | — | `resolveNextItemIndex` + nav contract |
| `tests/sidebar-delegation.test.js` | 95 | HTML contains `data-chat-id` |
| `tests/e2e/chat-e2e-helpers.js` | 36, 146, 169 | Playwright locators |
| `tests/e2e/sidebar-status-mock.spec.js` | 23, 57–58, 118 | Status chip DOM |
| `tests/e2e/sidebar-status-measure.spec.js` | 86 | Active row |
| `tests/delegation-phase2b-ui-e2e/delegation-center.spec.js` | 308, 314 | Sidebar row locator |

## Test adaptation plan (6.5+, start designing in 6.2)

### `tests/sidebar-signature.test.js`

**Today:** Calls exported `renderSignature()` on `createSidebarView` deps — already
behavioral, not HTML string snapshots.

**After Lit:** Keep signature tests on the **data layer** (`renderSignature` or successor).
If signature moves into a Lit controller, expose the same test seam (`renderSignature()`).
Do not assert `innerHTML` of workspace groups.

### `tests/sidebar-transient-patch.test.js`

**Today:** Mix of DOM identity tests (`patchTransientVisualStates` with fake nodes) and
**source scans** of `chat.js` / `sidebarView.js`.

**Migration:**

1. Keep identity tests: after Lit, `patchTransientVisualStates` must still toggle
   `is-active` / `aria-selected` without replacing row nodes when signature unchanged.
2. Replace `viewSource.match(/data-status-tone=/)` with assertions on **rendered row**
   (JSDOM or Lit fixture) using `sidebarLitMigrationContract.js` selectors.
3. Keep `updateSidebarChatStates` scheduling guards as source scans until chat.js splits
   patch module; optionally move to unit tests on `scheduleChatListStateRefresh`.

Add **contract test** `tests/sidebar-lit-migration-contract.test.js` (selector/class guard).

## Stage boundaries (leaves 6.3 – 6.5)

| Leaf | Delivers | Out of scope |
|------|----------|--------------|
| **6.3** Row component | `<cr-sidebar-chat-row>` light DOM, implements DOM contract above; wired from one workspace list behind feature flag or full replace of `renderChatItem` only | Workspace headers, archive, pinned, delete legacy renderer |
| **6.4** Groups / workspace | Lit hosts for `sidebar-workspace`, subchat group, archive section; `repeat` for lists; preserve `reconcileWorkspaceNodes` ul reuse | Removing `renderChatItem` strings if 6.3 not fully switched |
| **6.5** Remove legacy render | Delete HTML string builders for rows/groups; single owner; migrate signature tests; behavioral E2E | Virtualization (stage 7), shadow DOM |

## Verification checklist (for implementers)

- [ ] Row still matches `SIDEBAR_CHAT_ROW_SELECTOR` and child selectors in contract module
- [ ] `updateSidebarChatStates` finds rows after Lit mount
- [ ] Drag, keyboard, swipe, and SCSS grid unchanged in manual smoke
- [ ] `getRenderedSidebarChatIds()` still updated on each structural pass
- [ ] No shadow root under `#app-sidebar` for chat rows
