# SPA route navigation (RouteState v1)

Cretli’s browser shell uses **History API paths** instead of `?panel=` for primary
navigation. Shared parsing lives in `lib/spa-routes.js` (importable from the server,
service worker and frontend). The contract version is `SPA_ROUTE_CONTRACT_VERSION`
(currently **1**).

## RouteState v1 shape

A parsed route (`SpaRouteState`) contains:

| Field | Meaning |
|-------|---------|
| `panel` | Top-level panel id (`chat`, `git`, `settings`, …) |
| `subview` | Panel sub-view (Git: `main` or `worktrees`) |
| `settingsTab` | Settings second level when `panel === 'settings'` |
| `context.workspaceKey` | Opaque workspace id from query `ws=` |
| `context.folderKey` | Opaque folder id from query `folder=` |
| `scope` | Git-only explicit scope (`chat` / `todo`) with matching resource ids |
| `resource` | Panel resource (`chat`, `todo`, `session`, `path`, …) |
| `query` | Remaining allowlisted flags (`source`, debug switches, embed keys) |
| `canonical` | Normalized URL string for history and persistence |

Rules that matter for acceptance:

- Only allowlisted path segments are shell routes (e.g. `/git/worktrees` yes,
  `/git/unknown` no).
- `/git` without a segment means Git **main**; `/git/worktrees` is the only Git
  sub-view pathname.
- Resource query keys are **panel-local** — leaving a panel drops the previous panel’s
  resource parameters.
- View URLs never carry filesystem paths; context is always `ws` + `folder` ids.

Boot and navigation pipeline (frontend): `app_front/app/appShell/spaNavigation.js`
(parse → view context → panel ready → paint → resource restore). History writes go
through this module only.

## Workspace and folder route keys

Server-side ids are stored in `data/config.json` under `workspaceRouteKeys`
(`WORKSPACE_ROUTE_KEYS_VERSION = 1`):

- **File workspace** (`.code-workspace` registry id = file path): gets a minted UUID
  `workspaceKey`; legacy APIs and sidebar ids stay on the file path.
- **Folders workspace** (`cretli:ws:<uuid>`): reuses that registry id as `workspaceKey`
  (no second UUID).
- **Folder rows**: each `(workspaceKey, folder path)` pair gets a stable `folderKey`
  UUID; renames/clones do not rotate keys while the path mapping stays.

Minting and lookup: `lib/persist/workspace-route-keys.js`.  
List decoration and `GET /api/workspace/context` resolution:
`lib/workspace-route-context.js`.

The client resolves `ws` / `folder` through `GET /api/workspace/context?ws=&folder=`
before applying workspace selection (`app_front/app/appShell/viewContext.js`,
`workspaceContext.js`). Hand-crafted ids cannot onboard paths that are not in the
registry.

## Route persistence (storage v1)

| Store | Key | Scope |
|-------|-----|-------|
| `sessionStorage` | `cretli-view-route-v1` | Last explicit view **per tab** |
| `localStorage` | `cretli-view-route-v1` | Global fallback when the URL is `/` with no context |

Implementation: `app_front/app/appShell/viewRouteStorage.js`
(`VIEW_ROUTE_STORAGE_VERSION = 1`).

Behavior:

- Explicit URLs (non-root path or context/resource query) win over stored routes.
- Volatile ids (`session`, `browserSession`, `browserTab`, `run`) and one-shot
  `source` are stripped before writing the global fallback.
- Git persistence stores `subview: main` only (worktrees deep links are not replayed
  from global storage).
- Legacy keys `cretli-last-panel` / `cretli-settings-tab` migrate on read.

Per-view UI memory (filters, scroll, search within a panel) uses
`cretli-view-memory-v1` keyed by `buildViewKey()` in `viewMemory.js`
(workspaceKey, folderKey, panel, subview, resource).

## Resource restore adapters

Deep links may include panel resources (`chat=`, `path=`, `session=`, …). Restore
is **best-effort** and must not spawn side effects from the URL alone.

Core helpers and orchestration: `app_front/app/appShell/routeResourceRestore.js`.

| Panel | Query | Restore behavior |
|-------|-------|------------------|
| Files | `path` | Validate relative path; invalid → notice + strip param |
| Terminal | `session` | Join only if session is live; else clear param |
| Browser | `browserSession`, `browserTab` | Select tab if known; else clear |
| Tasks / Agents | `run` | Select run if known; else clear |
| Chat / TODO | `chat`, `todo` | Select resource when present |

To add a new adapter:

1. Add allowlisted query keys in `SPA_ROUTE_QUERY_KEYS` (`lib/spa-routes.js`) and
   mirror the shell contract in `public/sw-routes.js` if the path is offline-capable.
2. Extend `createRouteResourceRestorer` in `routeResourceRestore.js` with a small
   `resolve*` helper (pure decision) and a restore hook wired from `App.js`.
3. Never call Git, PTY, browser launch or task runners directly from parse/boot —
   only select existing state or strip the parameter and show
   `navigationResourceNotice`.
4. Add unit tests in `tests/route-resource-restore.test.js` for the resolver; add
   Playwright coverage when the flow is user-visible.

## Related modules

| Module | Role |
|--------|------|
| `lib/spa-routes.js` | Parse/build/canonicalize RouteState v1 |
| `lib/auth.js` + `lib/spa-routes.js` `isSpaLoginNextPath` | Login `next` allowlist |
| `public/sw-routes.js` | Offline shell path allowlist (must match server) |
| `app_front/app/appShell/panelRouter.js` | Legacy `?panel=` / tab aliases |
| `app_front/features/git/worktreeList.js` | Git sub-view paint (`applyGitSubviewFromRoute`) |

Playwright acceptance specs (project `playwright.config.js`):

| Spec | Flows |
|------|--------|
| `tests/e2e/git-worktrees-route.spec.js` | Scoped `/git/worktrees` reload, `/git` ↔ worktrees history, direct link, Git → Settings (Connection) → back |
| `tests/e2e/spa-route-navigation.spec.js` | Explicit URL over stored routes, scoped `/chat` + Settings `connection` F5, legacy `?panel=&tab=`, chat ↔ git back/forward |
| `tests/e2e/spa-route-two-tabs.spec.js` | Two tabs, distinct `folder` keys, no `PATCH /api/settings` on goto/popstate/reload; new tab deep link isolation |
| `tests/e2e/spa-route-resources.spec.js` | Invalid Files path, unknown Tasks `run` → notice + canonical URL (no spawn); terminal / browser / agents adapters in unit tests only |
| `tests/e2e/spa-route-shell-http.spec.js` | HTTP 404 for `/git/<unknown>`, shell for `/git/worktrees`, login `next`, embed not redirected to `/chat` |

## Acceptance matrix (todo leaf 6)

Status after the specs above plus existing unit tests. **Covered** = automated;
**Partial** = unit or HTTP only; **Manual** = built-in Browser / PWA / live WS.

| Requirement | Coverage | Where |
|-------------|----------|--------|
| Git main / worktrees / settings / chat: direct link, F5, back/forward | Covered | Git + `spa-route-navigation` E2E |
| TODO panel: direct link, F5, back/forward with `todo=` resource | Covered | `spa-route-navigation` E2E (`/todo?todo=`) |
| Explicit URL beats session/local storage | Covered | `spa-route-navigation` E2E; `tests/view-route-storage.test.js` |
| Cold vs warm boot | Partial | E2E reload + explicit `/git/worktrees` boot in unit tests; full cold start across all panels not matrixed |
| New tab | Partial | `spa-route-two-tabs` (two pages, same context); OS “new window” not automated |
| Two tabs / two folder keys, no global settings PATCH on boot or popstate | Covered | `spa-route-two-tabs` E2E; `tests/workspace-view-context.test.js` |
| Identical workspace display names, distinct opaque keys | Partial | Keys are UUIDs (`workspace-route-keys`); UI collision with same label not E2E |
| WS recovery must not switch the other tab | Manual | Requires live disconnect + two browsers; not Playwright-mocked |
| Pinned Git `scope=chat\|todo` + lock + history | Partial | `tests/view-context.test.js`, `tests/scoped-git-boot.test.js`, `tests/git-scope-ui.test.js` |
| Delayed navigation A→B (stale generation) | Covered | `tests/spa-navigation.test.js`, `tests/view-context.test.js`, `tests/route-resource-restore.test.js` |
| Failed resolve / retry of navigation A after user moved to B | Covered | `tests/view-context.test.js` (`a rejected route resolver for A after B already won leaves B intact and repaints nothing`); `tests/view-context.test.js` (`rapid A→B applies never paint the stale A answer`); `tests/view-context.test.js` (`an unknown or offline id keeps the link target and never repaints the scope`) |
| No double panel init / popstate subscription per navigation | Covered | `tests/spa-navigation.test.js` (`ensurePanelReady` once, `initPopstate` once) |
| Files / Tasks resource strip (invalid path, unknown run) | Covered | E2E: `spa-route-resources.spec.js` |
| Terminal expired session | Partial | Unit: `tests/route-resource-restore.test.js` (`resolveTerminalSessionRestore`, dead session); no xterm E2E |
| Browser / Agents unknown or expired tab/run | Partial | Unit: `tests/route-resource-restore.test.js` (`resolveBrowserRouteRestore`, agents `run`); live browser tab / offline not E2E |
| Parser / server / auth / SW alignment | Covered | `tests/spa-route-shell-contract.test.js`, `tests/spa-routes.test.js`; E2E HTTP smoke |
| `/git/worktrees` allowed, `/git/<unknown>` rejected | Covered | Shell contract + `spa-route-shell-http` E2E |
| Login `next` allowlist | Partial | E2E signed-out redirect; full post-login landing not every panel |
| Legacy `?panel=` / `?tab=` / notification aliases | Partial | E2E legacy settings; `tests/spa-navigation.test.js` |
| Service worker offline, push links, SW update | Partial | SW contract unit tests; offline/push/update manual or SW-specific tests |
| Embed `/embed/...`, widget host popstate | Partial | E2E: embed not rewritten to `/chat`; widget host popstate manual |
| No Git / PTY / browser / task spawn from URL alone | Covered | Resource restore unit + E2E strip behavior |

Unit tests (stages 1–5): `tests/spa-navigation.test.js`, `tests/view-route-storage.test.js`,
`tests/route-resource-restore.test.js`, `tests/spa-route-shell-contract.test.js`,
`tests/workspace-view-context.test.js`, `tests/view-context.test.js`, `tests/git-worktrees-route.test.js`.
