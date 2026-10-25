# Frontend baseline and measurements (stage 5)

Status: **deterministic parts measured; every real-browser and real-device run is NOT executed in this leaf.**
Frozen budgets and caps: [architecture-baseline.md](architecture-baseline.md) section 5 (unchanged here; changing the DOM cap needs a
human decision). Contract context: [architecture-list-sync-contract.md](architecture-list-sync-contract.md),
[architecture-vertical-dag.md](architecture-vertical-dag.md) (Stage 5 section).

## What was added (all behind flags, default OFF)

| Piece | File | Notes |
| --- | --- | --- |
| Shared state | `app_front/state/` and existing chat/sidebar state modules | signal-based state remains the single model; no parallel entity-store path is shipped |
| Sync client fixes | `app_front/features/chat/chatListSyncClient.js` | scope binding, archived=tree parity, `dispose()` |

Not wired: `chatListSyncClient` is not connected to the app yet (flag `sidebar-sync-client` is reserved); the legacy `GET /api/chats` path
and `chatListLiveSync` are unchanged. The legacy sidebar renderer, Lit rows, status patches and the archive virtualizer are untouched.

## Selector semantics

The removed experimental entity-store benchmark and its tests are not part of the current baseline. Sidebar behavior remains on the established
state and rendering path until a separately reviewed replacement is introduced.

## NOT executed (reproduction commands)

1. **sidebarRenderMetrics scenario, desktop and mobile-edge emulation** - `public/dist/app` is not built in this worktree and no server was
   started. Commands (project Playwright config; Chromium 1208 exists in the Playwright cache of this machine):
   ```
   npm run build:front
   CHAT_E2E_MEASURE=1 npx playwright test -c playwright.config.js tests/e2e/sidebar-render-metrics.spec.js
   CHAT_E2E_MEASURE=1 CHAT_E2E_MOBILE=1 npx playwright test -c playwright.config.js tests/e2e/sidebar-render-metrics.spec.js
   ```
   Output: one `SIDEBAR_RENDER_METRICS {...}` line and a JSON attachment with DOM nodes (whole page and sidebar), rendered rows, long-task
   count, and 50 search-latency samples vs the 100/200 ms budget. The pre-existing presence-churn scenario
   (`tests/e2e/sidebar-status-measure.spec.js`, 60 s, 3-5 chats, Watcher observe) is the complement; it needs `CHAT_E2E_MEASURE=1` too.
   The DOM cap proposal (<= 5 000 nodes, <= 300 rows) therefore stays **unvalidated on a real page**; run the commands above with
   `CHAT_E2E_MEASURE_CHATS=400` before any decision.
2. **Real mobile device** profile (touch scroll frames, cold/warm/offline/reconnect) - needs a device and a LAN/HTTPS session; not available here.
3. **Shell cold/warm/offline/reconnect** timings (V7) - need the browser runs above; see next section.

## V7 shell: finding and decision

`public/sw.js` serves navigations and the app shell **network-first with a 3 s timeout** (`NETWORK_TIMEOUT_MS`) and falls back to the cache.
Consequence (by reading the code, not measured): with a reachable-but-slow server a cached shell is shown only after up to 3 s, which
cannot meet "shell with a usable cached view <= 500 ms desktop / 1000 ms mobile" in that case; with a fast server or a fully offline device
the cached path is immediate. A stale-while-revalidate navigation would fix it but changes update semantics (new HTML/bundle versions
and the update banner) and needs a real cold/warm/offline run first, so **`sw.js` and `CACHE_NAME` were not changed** (cache versioning rules
untouched). Proposed follow-up (needs a decision): serve the cached shell immediately when the cache is warm and revalidate in the background,
keeping `?v=` ignore-search fallback and the version bump. `tests/sw-shell-assets.test.js` locks the current invariants (versioned cache
name, existing shell files, bounded precache list, bundles precached, ignore-search fallback, timeout value) so any change is deliberate.
Boot requests were not re-measured in a browser; the settings endpoint P95 is in [architecture-http-baseline.md](architecture-http-baseline.md).

## Remaining before the per-view flag can be accepted

Wire `chatListSyncClient` behind `sidebar-sync-client` (scope key = workspace/widget scope), render the sidebar from the store selectors with a
windowed row mount (reusing the archive virtualizer), compare against the legacy renderer for ordering, active ancestors, worktree/unread/pinned,
focus/keyboard/drag/swipe/scroll and light/dark/i18n in a real browser, then record the numbers above on a built front.
