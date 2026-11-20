# Archive virtualization (7.2)

Date: 2026-10-06. Scope: leaf **7.2** — virtualize the sidebar archive list with
stable chat-id keys and a bounded DOM row budget. Archive **metadata** stays in
RAM/IDB (7.1); only `<cr-sidebar-chat-row>` mounts are windowed.

## Choice: custom viewport window (not `@lit-labs/virtualizer`)

| Criterion | Custom window (`sidebarArchiveVirtualizer.js`) | `@lit-labs/virtualizer` |
| --- | --- | --- |
| Light DOM | Fits `<cr-sidebar-archive-group>` with `createRenderRoot() → this` and existing `repeat(..., chatId)` | Targets scrollport hosts; integrating with nested `.sidebar-body` scroll + workspace tree is awkward |
| Variable row height | Measured per mounted row (`getBoundingClientRect`), prefix sums + overscan | Supported, but adds dependency and Lit version coupling |
| Groups / nest | Full `archiveTree` stays in RAM; slice preserves tree order and stable keys | Same possible, no clear win |
| Scroll anchoring | Top/bottom `<li>` spacers + `applyArchiveScrollAnchor` on spacer delta | Built-in, but scroll root mismatch |
| Maintenance | ~200 lines, no new npm dependency | New dependency, upgrade churn |

**Decision:** own sliding window with top/bottom spacers inside
`.sidebar-archive-list`, scroll listener on `.sidebar-body`.

**Rejected:** `@lit-labs/virtualizer` — extra dependency and scroll-container
mismatch with the sidebar layout; **content-visibility** alone — does not cap
node count; **cap-only without window** — still mounts thousands of Lit hosts on
open.

## Numeric DOM budget (test viewport)

Assumptions (baseline device from UI-freeze docs):

- Viewport height **400 px** (`SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX`) — sidebar
  body minus chrome on the reference layout.
- Row height **32 px** (`SIDEBAR_ARCHIVE_DEFAULT_ROW_HEIGHT_PX`) — matches
  `--sidebar-row-height: 2rem`; rows with preview/activity measure taller at
  runtime.
- Overscan **4** rows above and below the viewport
  (`SIDEBAR_ARCHIVE_OVERSCAN_ROWS`).
- Hard cap **64** rows (`SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS`).

Formula:

```text
visibleRows = ceil(viewportHeight / defaultRowHeight)   → ceil(400/32) = 13
mountedLimit = min(64, visibleRows + 2 * overscan)      → min(64, 13 + 8) = 21
```

At 400 px viewport the enforced maximum is **21** mounted archive rows (plus 0–2
spacer `<li>` nodes). For 1500 or 10000 archived chats the mounted
`cr-sidebar-chat-row` count stays ≤ limit.

Implementation: `computeSidebarArchiveMountedRowLimit`,
`selectArchiveVisibleWindow` in `app_front/features/sidebar/sidebarArchiveVirtualizer.js`.

## Runtime wiring

- `sidebarView.js` — registers row payloads only for the current window during
  the render pass; full `archiveTree` in `registerSidebarArchiveGroup`.
- `cr-sidebar-archive-group.js` — spacers, slice render, scroll sync, height
  measurement, `registerArchiveChatRowSliceDirect` on scroll.
- `sidebarArchiveVirtualState.js` — persists `{ startIndex, endIndex, spacers }`
  per workspace key across passes.

## Open cost (<50 ms baseline)

Opening the archive no longer loops all archived ids in
`registerArchiveGroupEntry` — only the first window (~21) is registered and
mounted. Full-tree work stays in existing RAM/IDB catalog reads (7.1). Remaining
open cost is header + one Lit slice; expected well under the 50 ms long-task
budget on the baseline device (no full-tree DOM or row registration).

## Accessibility and focus (7.3)

- Each mounted archive `role="option"` gets `aria-setsize` / `aria-posinset` for
  the **full** flattened `archiveTree` (search/filter changes setsize; nested rows
  count as separate options).
- Keyboard arrows / Home / End on archive rows call `revealLogicalIndex` so targets
  outside the DOM window scroll into the mounted slice (not only visible siblings).
- When user scroll unmounts the focused row, DOM focus moves to the `listbox` while
  logical focus (`sidebarArchiveVirtualFocus`) keeps the chat id for the next key.
- **Drag/swipe:** archive rows are not draggable; sidebar chat/workspace drag and
  panel swipe defer full sidebar rebuild (existing). Archive virtual focus handoff
  is skipped while any of those gestures is active so state is not torn mid-gesture.

## Related tests

- `tests/sidebar-archive-virtualizer.test.js` — window math, limits, anchoring.
- `tests/sidebar-archive-virtual-dom.test.js` — mounted row cap with 1500/10000
  synthetic trees (jsdom harness).
- `tests/sidebar-archive-virtual-a11y.test.js` — ARIA indices and navigation helpers.
