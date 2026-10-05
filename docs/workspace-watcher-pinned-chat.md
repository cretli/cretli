# Pinned Workspace Chat

One durable chat per workspace for the Workspace Watcher.

Autopilot cycles are ephemeral: each cycle owns a short-lived orchestrator chat
that is created, does its plan/implement/review work and disappears. The
operator had no stable place to watch the watcher or ask why it stopped. The
pinned chat fixes that by giving every workspace a single long-lived transcript
that survives individual cycles.

## Data model

- `workspace-watchers.json` rows gain `pinnedChatId` (normalized in
  `normalizeWorkspaceWatcherRow`, so it survives every CAS write).
- The chat itself is a normal entry in `chats.json` marked `watcherPinned: true`
  with the workspace folder it belongs to. Because it is a real chat, the whole
  existing chat infrastructure (history store, WebSocket sync, resume polling)
  applies unchanged.
- `ensurePinnedChat(workspaceFolder, { dataDir })` in
  `lib/workspace-watcher-pinned-chat.js` resolves the chat idempotently:
  1. the `pinnedChatId` on the row, when that chat still exists;
  2. any surviving `watcherPinned` chat for the same folder (adopts it and
     repairs the row);
  3. otherwise it creates a new chat, reusing the stored id when one is present.
- `applyWorkspaceWatcherPatch` calls `ensurePinnedChat` when the row becomes
  `autopilot`, so the first cycle already has somewhere to report.
- The pinned chat is excluded from watcher occupancy
  (`defaultWorkspaceWatcherSnapshotDeps.listWorkspaceChatIds`) and from the
  normal sidebar chat list; it appears only in the dedicated "Workspace"
  section.

## Notifications: persisted notices, not agent runs

The watcher is deterministic and has no LLM. The chosen mechanism is a new
persist API:

```js
appendChatNotice(chatId, text, { action, level, workspaceFolder, todoId, cycleId, chatId, at })
```

It appends a `meta` record with `variant: 'watcher'` and a JSON payload to the
chat history. It is delivered to open chat views on the existing
`sdkHistoryChanged` socket and to every list on `chatsChanged`, so live updates
need no new transport.

**Alternative rejected:** start a lightweight agent run per notification. That
would make every notice depend on a model being available and would burn quota
for what is pure telemetry.

Emitted actions: `cycle_start` / `plan_gate`, `cycle_stop`, `cycle_blocked`,
`cycle_failure`, `todo_done`, `blocked`, `alert`, `stopped`, `plan_approval`,
`idle_with_work` and `decision`. Decisions are already deduped by
`shouldRecordDecision` (kind + reason within the dedupe window), so the feed
carries signal rather than a line per tick.

## User commands: option A (API shell)

A pinned chat is **not** an LLM conversation. Typing plain text is refused with
a hint; slash commands map onto existing endpoints:

| Command | Endpoint |
| --- | --- |
| `/status` | `GET /api/workspace-watcher` |
| `/pause` | `POST /api/workspace-watcher/pause` |
| `/resume` | `POST /api/workspace-watcher/resume` |
| `/stop [reason]` | `PATCH /api/workspace-watcher` |
| `/clear-stop` | `POST /api/workspace-watcher/clear-stop` |
| `/tick` | `POST /api/workspace-watcher/tick` |
| `/cycle` | `POST /api/workspace-watcher/run-cycle` |
| `/skip <todoId>` | `PATCH /api/todos/:id` (`status: done` + changelog note) |

**Alternative rejected:** a resident watcher-assistant agent that listens for
messages. It would need a durable run or a chat trigger and introduce a new
harness mode, for a task the deterministic APIs already do.

Trade-off accepted: free-form natural language is not understood. `/help`
documents the surface, and `app_front/features/chat/watcherPinnedChat.js` is the
single parser, so adding a command later is a one-line mapping.

## Routes

- `GET /api/workspace-watcher/pinned-chat` — read `{ chatId, chat }` without
  creating anything.
- `POST /api/workspace-watcher/pinned-chat` — `ensurePinnedChat` (create or
  recover), idempotent.

## UI

- `app_front/features/sidebar/workspaceAutopilotBadge.js` stores `pinnedChatId`
  from the `agentPresence` watcher summary and exposes
  `listWorkspaceWatcherPinnedChats()`.
- `app_front/features/sidebar/sidebarView.js` renders the "Workspace" section,
  one robot-icon row per workspace; clicking selects the existing chat
  (`selectChat`), never creates a new one.
- `app_front/lib/sdk-rich-view.js` renders `variant: 'watcher'` records with a
  per-action Material icon, the notice text and the record timestamp.
- `app_front/chat.js` switches the pane into pinned mode: a command placeholder,
  a body class for styling, a one-time help notice, and the send intercept that
  routes text through `runWatcherCommand` instead of the agent.

## Tests

`tests/workspace-watcher-pinned-chat.test.js` covers idempotent create, recovery
after delete, recovery of a marked chat whose row id was lost, the notice record
shape, autopilot materialization, the presence row and the GET/POST routes.
