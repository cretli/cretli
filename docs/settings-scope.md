# Settings scope contract

Which Settings belong to the server, to a registry workspace, to a folder or to
a single item, how the UI picks the workspace, and how a runtime scope is
turned into a store key. The resolver lives in `lib/workspace-scope.js`.

## Scopes

| Scope | Meaning |
| --- | --- |
| Global | One value for the whole server/user, kept in `settings.json` or its own data file. |
| Server | Process-wide runtime limit; may be pinned by an env variable. |
| Workspace | One value per registry workspace (`.code-workspace` file path or `cretli:ws:<uuid>` id). |
| Folder | One value per folder path (a chat, Watcher or todo folder). |
| Per item | One value per chat, provider, installation or grant. |

## Inventory

Workspace pickers read the tab's view context (`getViewContextRuntimeScope`),
never the server's globally selected workspace (`settings.workspaceFile`, a
stale default). Cascade: **none** unless the row says otherwise (D4).

| Setting (tab) | Scope | Storage | Key shape | How the UI picks the workspace | Cascade |
| --- | --- | --- | --- | --- | --- |
| Browser policy (App → Browser) | Workspace, optional Folder override | `data/browser-policy.json` (`workspaces`, `legacyKeys`) | registry file path, `cretli:ws:<uuid>` id, or absolute folder path | tab's `workspaceFile` / `workspaceFolder` sent with every request | Folder-only scope: the folder's own entry, else the single registry workspace that has a policy; consent flags (`allowExternalBrowser`, `allowClaudeChrome`) inherit from the single registered workspace only |
| Browser storage consent and state (App → Browser) | Workspace | `data/browser-storage-state.json` | sha256 profile of the normalized workspace key | session's workspace key | none |
| External Chrome endpoint, default mode, limits (App → Browser) | Global | `settings.json` / env | n/a | n/a | none |
| Workspace Watcher policy (Settings → Workspace Watcher) | Folder | watcher store | workspace folder | `getWatcherWorkspaceFolder` | none |
| Workspace tab: registry list and cards (Settings → Workspace) | Per item | workspace registry | registry workspace id | each card is one workspace | none |
| Workspace tab: Additional Cursor sources (Settings → Workspace) | Global | `settings.json` | n/a | n/a | none |
| Workspace tab: active workspace info (Settings → Workspace) | Workspace | registry entry | registry file path or `cretli:ws:<uuid>` | tab's view context | none |
| Chat defaults, rules and agents, archive, titles, uploads, recovery (Settings → Chat) | Global | `settings.json` | n/a | n/a | none |
| Usage (Settings → Usage) | Global | `settings.json` / usage ledger | n/a | n/a | none |
| Connection: LAN, certificates, network (Settings → Connection) | Global | `settings.json` / `data/` certificates | n/a | n/a | none |
| Browser storage report (App → Browser) | Global | read-only diagnostics of the local origin | n/a | n/a | none |
| Execution (Settings → Execution) | Folder | per-folder execution settings | workspace folder | view context folder (`getWatcherWorkspaceFolder`) | none |
| Todos, memory | Folder | per-folder stores | folder path | view context | none |
| Delegation center, limits, review, sessions, models (Delegations) | Folder; fields the schema flags `server` render in their own Server card | `settings.json` + per-workspace delegation store | delegation workspace key derived from the folder the request carries | view context folder (`getWatcherWorkspaceFolder`); schema flags each field (`lib/delegation-settings-schema.js`) | none |
| Delegations → Lessons | Folder | per-folder lesson store | folder path | view context folder | none |
| Delegations → Prompts | Global | `data/prompt-overrides.json` (`lib/prompts/overrides-store.js`); routes `/api/prompt-registry*` take no scope | n/a | none: the panel edits one global set of block overrides | none |
| Harness → Permissions | Global rules, Per item grants | `settings.json` (approval broker) and the can-use-tool grant store behind `/api/approval-broker/grants` | grant id | none: the grant list is not filtered by workspace; the panel reads and revokes grants server-wide | none |
| Harness → models, keys, status (per provider) | Global | `settings.json` / provider files | provider id | n/a | none |
| MCP Servers (Settings → MCP) | Workspace (own scope model) | registry-id keyed stores | workspace id or all | own scope picker in the add/edit form; the badge shows the picker's selection | none |
| MCP Operator (Settings → MCP Operator) | Folder | per-folder prompt overrides | workspace folder | own folder picker in the panel; the badge shows the picked folder | none |
| External MCP clients (Settings → MCP) | Per item | per-client grants | client id | n/a | none |
| Wake-ups (kinds, settings, list) | Global | `settings.json` under each kind's `configKey` (`usageLimitResume`, `conditionCheck`); queue in the wake-up store | wake-up id | none: `/api/wakeups*` takes no workspace; a wake-up row may carry its own chat/workspace | none |
| Data and backups | Global | `data/` snapshots and exports via `/api/settings-backup/*` | snapshot id | none | none |
| Widgets | Per item | `data/widget-installations.json` | installation id; each row carries its own optional `workspaceFile` / `workspaceFolder` | scope is a field of the installation, edited with it | none |
| Account (password, login, sessions) | Global | auth store behind `/api/login`, `/api/auth-status` | n/a | n/a | none |
| Interface, voice, notifications, terminal, appearance | Global (per device for local UI prefs) | `settings.json` / `localStorage` | n/a | n/a | none |
| Sidebar layout | Global | `sidebar-layout.json` | n/a | n/a | none |

## Decisions

- **D1 — UI model: scope badge, no new tab.** Each Settings section or card
  carries one scope (Global, Server, Workspace, Folder, Per item) and shows the
  workspace or folder it edits. Tabs keep their place; mixed sections get split.
- **D2 — One resolver, no re-keying.** `resolveWorkspaceScope({ workspaceId,
  workspaceFile, workspaceFolder }, settings)` names the workspace by
  `workspaceId`, then `workspaceFile`; `workspaceFolder` selects a folder inside
  it. Disagreeing fields (id and file naming different workspaces, or a folder
  that is not a member of the named workspace) return
  `workspace-scope-conflict`; the resolver never picks a side. A folder alone
  resolves to that folder and is `ambiguous` (with no `workspaceId`) when
  several registry workspaces contain it. `resolveChatWorkspaceScope(chat,
  settings)` takes a stored chat's file, id and folder as trusted and skips the
  member check, because a chat folder can be a worktree outside the registry.
  The resolver never reads the global selection. Each store keeps its own key
  derivation.
- **D3 — Per-workspace REST endpoints require a scope.** Missing scope → 400
  `workspace-scope-required`; contradictory fields → 400
  `workspace-scope-conflict`. Server-wide routes stay scope-free and are listed
  in the inventory above.
- **D4 — No general cascade.** Values are workspace or folder values over code
  and env defaults. The only inheritance is Browser: a folder's own entry
  overrides for folder-only scopes, and consent flags inherit from its single
  registered workspace. A folder in several registry workspaces never inherits
  those flags and keeps its own entry if it has one. A scope that names a
  workspace uses the workspace entry. The panel shows this through
  `effectiveKey` and `folderOverrides`.
- **D5 — Migration quarantines, never guesses.** A mangled
  `<path>/cretli:ws:<id>` key maps to its id only when that id is registered;
  otherwise it moves to `legacyKeys`, kept but never applied. Folder entries
  are not merged into workspaces.

## Browser policy keys

`normalizeWorkspaceKey` (`lib/browser/scope-key.js`, shared by the policy store
and storage state) returns a `cretli:ws:` id unchanged and resolves every other
key to an absolute path, so a key no longer depends on the server's working
directory. Runtime callers (agent tools, session manager, Claude Chrome check)
derive the key with `browserScopeKey`: workspace file/id, then chat folder,
then cwd. The panel route and `resolveBrowserPolicyKey` then pick the stored
entry.

`GET /api/browser/policy` returns `workspaceKey`, `effectiveKey`,
`workspaceLabel` (registry name, never a raw id) and `folderOverrides`;
`DELETE /api/browser/policy/folder-override` removes one override.

Migration (idempotent): a stored `<path>/cretli:ws:<uuid>` key moves to the
plain id when registered, otherwise to the top-level `legacyKeys` object. For
`browser-storage-state.json`, the profile stored under the old
`path.resolve`-based hash of a `cretli:ws:` id is renamed to the new hash on
first use, so consent and cookies survive.

## REST scope contract

Per-workspace routes require `workspaceId`, `workspaceFile`, `workspaceFolder`,
the route's `ws`/`folder` keys, or a `chatId` whose stored workspace can be
resolved. They never infer a workspace from the server's current selection. A
widget request uses the workspace bound to its access token, including Git
and Watcher consumers; a supplied folder cannot replace that scope. Supplying a chat
with a workspace also checks membership; mismatch returns 403 `OUT_OF_SCOPE`.

Missing scope returns 400 `workspace-scope-required`. A workspace file or id
paired with a folder that is not its member returns 400
`workspace-scope-conflict`. These rules apply to `/api/apps`, `/api/git`,
`/api/browser/policy`, `/api/browser/sessions`, `/api/browser/storage-state`,
`/api/review-lessons`, `/api/tasks`, `/api/task-runs`, `/api/agents`,
`/api/wakeups/condition-check`, `/api/workspace-watcher`,
`/api/execution-settings`, and `/api/delegation-settings`.

First-party frontend callers resolve scope from `getViewContextRuntimeScope()`.
Browser policy and Watcher callers wait for `whenViewContextRuntimeReady()`:
route readiness alone can precede the default workspace loaded during boot.
Watcher GET coalescing includes the folder in its URL/cache key, and mutations
serialize that folder in their JSON body, including voice pause/resume.

These routes remain scope-free:

- Browser: `GET /api/browser/status`, `GET /api/browser/health`,
  `POST /api/browser/external/release`, `GET /api/browser/consent`,
  `POST /api/browser/consent/:id`, `GET/PUT /api/browser/runtime-config`, and
  `DELETE /api/browser/storage-state/all`.
- Watcher: `GET/PATCH /api/workspace-watcher/runtime-control`.
- Wake-ups: `GET /api/wakeups`, `GET /api/wakeups/kinds`,
  `GET /api/wakeups/status`, `PATCH /api/wakeups/kinds/:kind/settings`,
  `POST /api/wakeups/:id/run-now`, and `POST /api/wakeups/:id/cancel`.

### Usage attribution check

The shared harness writer (`lib/usage/harness-usage.ts`) resolves the stored
chat's workspace before recording token deltas and finished runs. The ledger's
`workspaceFile` is the registered file path for file workspaces, the
`cretli:ws:` id for folders workspaces, or the stored folder for legacy
folder-only chats. It never uses the global selection or a chat's execution
worktree. Production run starts share one asynchronous chat lookup across
measurements, on either chats backend. Missing chat metadata keeps the
measurement and any supplied room workspace identity; it never substitutes
the global selection.

`lib/usage/usage-event.js` preserves that key and the Usage filter compares it
exactly (`lib/usage/usage-insights.ts`). Existing ledger entries without a
workspace key are not backfilled.
