# Chats → SQLite, leaf B: caller inventory and async naming convention

Part 1 of 5 of leaf B (ADR [storage-chats-metadata-decision.md](storage-chats-metadata-decision.md), sections 4, 6 and 10-B).
This file is the checklist for the conversion leaves B2–B4 and the removal of the sync API in B5.

## Convention

- Every store-touching export of `lib/persist/chats-persist.js` has an async twin with the **same name plus the `Async` suffix**
  (`addChat` → `addChatAsync`, `updateChat` → `updateChatAsync`, ...). `deleteChat` was already async; `deleteChatAsync` is its alias.
- The twins run on the **active chats runtime** (`lib/persist/chats-runtime.js`): the legacy adapter by default, a SQLite
  adapter only through an injected runtime (`createChatsRuntime({ backend })`) until B5 flips the code constant
  `CHATS_SQLITE_RUNTIME_ENABLED`.
- Pure helpers are not twinned and stay unchanged: `withTitleSource`, `inferChatTitleSource`, `createFreshSdkContextEntry`,
  `DEFAULT_CHAT_TITLE_RE`, `CHAT_TITLE_SOURCES`, `setChatArchiveRejector`, `onChatArchived`, `getChatsReadStats` (legacy diagnostics).
- Sync API contract during B1–B4: it is the legacy implementation. On a non-legacy runtime every sync function throws
  `chats_sync_api_unavailable`. Sync and async calls on the legacy adapter share one cache and one read-modify-write path
  (the async wrapper runs the sync body before its first `await`), so they are serialized in one process.
- Adapter operations (18, `CHATS_BACKEND_OPERATIONS`): loadChats, loadChatsSnapshot, peekChatsSnapshot, peekChats, peekChatsByIds,
  getChatById, getChatByCursorSessionId, saveChats, addChat, removeChat, deleteTemporaryForkChats, updateChat, markChatReadState,
  applyAutoTitle, setChatTitleLocked, setChatSessionField, rotateChatSdkSession, migrateChatWorkspaceIds. The facade composes the
  rest (`createConversationForkChatAsync`, `createTemporaryForkChatAsync`, `deleteChatAsync`, the `setChat*SessionIdAsync` setters).

## Behavior differences of the SQLite adapter (documented, to be settled before cutover)

| Operation | Legacy (`chats.json`) | SQLite adapter |
|---|---|---|
| `saveChatsAsync` | rewrites the whole collection | refused: `chats_save_all_unsupported` (no handler takes the whole collection); callers must move to row operations in B2–B4 |
| `loadChats*Async`, `peekChats*Async` | cached full list | paged compatibility read (`chats.page` + `chats.getMany`) in legacy position order; snapshot revision = `store_revision`. Not for hot paths; B3 moves `ChatCatalog` to page/get/counts |
| `removeChatAsync` | removes only the row | `chats.remove` removes the whole fork subtree in one transaction (handler semantics, ADR section 4) |
| `updateChatAsync` restore of a subtree, widget-pin dedupe | one atomic file write | one `chats.updateMany` transaction: CAS on every row, all rows or none; only changed rows are sent; more than 200 changed rows or 240 KiB is rejected up-front with `chats_subtree_too_large` (nothing written); pin dedupe is limited to the widget scope of the chat |
| `deleteTemporaryForkChatsAsync` | one write | one `chats.remove` per temporary fork |
| `addChatAsync` | one write | `chats.add` (position assigned by the store); a lost race on a reserved id returns the existing row |

## Where the legacy adapter lives (B1 → B5)

`lib/persist/chats-backend-legacy.js` is the adapter contract plus the injection point; the `chats.json` code itself stays in
`lib/persist/chats-persist.js` until the sync API is removed in B5 (it has ~300 importers, and `DATA_FILE` resolves at module load).
The shared domain rules (record building, update rules, title source, session fields, post-commit effects) live in
`lib/persist/chats-backend-domain.js` and are used by BOTH adapters. One legacy defect found while building the parity test and
fixed in `updateChat`: archive and widget-pin dedupe edited other rows in place on the shared cache, whose cached serialized text
(`rowJsonCache`) made the file keep the old values; those two paths now work on private row copies.

## B2 status: routes/HTTP, chat lifecycle and runs, titles (converted)

Converted to the `*Async` API: `lib/routes/**`, `lib/chat-run-service.js`, `lib/agent-run-state.js`, `lib/claude/**`,
`lib/codex/**`, `harnesses/*/*-agent-ws.js`, `lib/conversation-fork-execute.js`, `lib/fork-chat-text.js`,
`lib/chat-message-guard.js`, `lib/agent-harness/room-kernel.ts`, `lib/chat-run/kernel-adapter.ts`, `lib/chat-title-*.js`.

- Former sync read-after-write sequences use the row the command returns (`updateChatAsync` result) instead of a second read.
- Fire-and-forget writers (session ids, model, sdk mode) go through `lib/chat-write-async.js` (`runChatWrite`): serialized per
  chat, retried on a version conflict, never thrown into an event handler.
- `guardArchivedChatSocket` checks the archive flag asynchronously and keeps frame order (a queue behind a pending prompt frame);
  `ws.whenArchiveGuardIdle()` resolves when it drained.
- Signatures that unconverted callers still invoke synchronously keep a sync twin that reads through
  `lib/persist/chats-sync-compat.js` (legacy runtime only; removed in B5): `probeChatRunLiveness`, `getChatRunState`,
  `isChatRunConfirmedIdle`, `lookupChatRunRequest`, `countActiveChatRuns`, `getChatBySessionKey`, `rejectArchivedRoomPrompt`,
  `buildAgentTitleHint`, the recovery-resume collaborators. `summarizeChatRunStates(ids, { chats })` is pure over rows.
  A contract test (`tests/chats-b2-callers.test.js`) pins the list of shim users so it can only shrink.
- Tests: `tests/helpers/chats-backends.js` (`CHATS_TEST_BACKEND`, `seedChatRows`) and `tests/chats-b2-backend-matrix.test.js`
  run the converted tests on an isolated SQLite runtime. Tests that cross into an unconverted group (delegation bridge/mailbox,
  ws-router, chat-catalog, mcp-inprocess-client, context-scope) are listed with the blocking module in `SQLITE_BLOCKED`.

## B3 status: delegation, watcher, MCP/browser, context, push, git, usage (converted)

Converted to the `*Async` API: `lib/delegation-*`, `lib/workspace-watcher*`, `lib/orchestrator-leaf-resolution.js`,
`lib/model-pick-service.js`, `lib/workspace-scout-chat.js`, `lib/usage/**`, `lib/feedback-triage.js`, `lib/decisions/**`,
`lib/mcp/**`, `lib/browser/**`, `lib/context/**`, `lib/push.js`, `lib/agent-finished-push.js`, `lib/git-context.js`,
`lib/git-switch-guard.js`, `lib/worktree-list.js`, `lib/widget/widget-http.ts`, `lib/ws/ws-router.ts`, `lib/sdk/cursor-agent-sdk-ws.ts`.

- Pure core + async loader: functions with an injectable `chats` argument keep a synchronous pure core and gain an async
  entry (`isBrowserSessionVisibleToChatAsync`, `evaluateBrowserActionGuardAsync`, `buildChatCacheViewAsync`); the chat row is
  read once by the async caller and passed down (`chat` in the prompt-decoration / context-manifest inputs).
- Decision gates: `decisionRoomWorkspace` is async; harness gate sources return a Promise (`registerDecisionGateSource` always
  supported async sources); gate-change publication from sync handlers is fire-and-forget (`notifyRoomDecisionGateChange`).
- Scout read-only policy is asked from synchronous permission paths. `lib/scout-chat-registry.js` is a process-local index the
  facade fills with every row it hands out or creates (`pickPurpose` / `readOnlyScout` are host-owned and never rewritten), so a
  chat that runs was necessarily seen first. `isScoutReadOnlyChatId` (sync) uses the index, plus a sync legacy read on the legacy
  runtime only; `isScoutReadOnlyChatIdAsync` is authoritative where the caller can await.
- Scope contract: `tests/chats-b3-callers.test.js` greps `lib/**`, `harnesses/**` and `server.js`; after B2 + B3 only the facade, the
  mixed-phase shim, B4 (`lib/backup/conversations-store.js`) and B5 (`lib/chat-catalog.js`, `lib/chat-archive-policy.js`,
  `lib/chat-auto-archive.js`, `lib/chat-retention.js`) may import synchronous exports. The same file holds the B3 mixed-phase test.

## Direct `chats.json` access outside the legacy adapter (must be gone before B5 closes)

- `lib/backup/conversations-store.js` – reads and writes the file for backup/restore (leaf C: sidecar-aware path).
- `lib/sdk/sdk-history-isolation-fork-cli.ts` – `chatsPath: resolveDataPath('chats.json')` for the isolation CLI.
- `lib/routes/harness-diagnostics-routes.js`, `lib/boot-log.js` – file name only (diagnostics listing / boot log line).
- `scripts/`: `architecture-*.mjs`, `measure-*.js|mjs`, `profile-chat-fields.mjs`, `chat-workspace-ids-migrate.mjs` – benchmarks, fixtures and tools that read or seed the file on copies.
- Comments only: `lib/chat-run-service.js`, `lib/workspace-watcher.js`, `lib/delegation-runtime-boot.js`, `lib/persist/chat-title-history-persist.js`.

## Usage count per exported name (static + dynamic named imports; production + tests)

- `addChat`: 178
- `loadChats`: 115
- `updateChat`: 59
- `saveChats`: 38
- `getChatByCursorSessionId`: 21
- `peekChats`: 8
- `deleteChat`: 7
- `getChatById`: 6
- `applyAutoTitle`: 6
- `setChatClaudeSessionId`: 3
- `getChatsReadStats`: 3
- `createConversationForkChat`: 2
- `peekChatsByIds`: 2
- `setChatTitleLocked`: 2
- `migrateChatWorkspaceIds`: 2
- `createFreshSdkContextEntry`: 2
- `setChatCodeBuddySessionId`: 1
- `setChatDeepSeekSessionId`: 1
- `setChatOpenCodeSessionId`: 1
- `setChatQwenSessionId`: 1
- `loadChatsSnapshot`: 1
- `setChatArchiveRejector`: 1
- `peekChatsSnapshot`: 1
- `setChatCodexThreadId`: 1
- `onChatArchived`: 1
- `createTemporaryForkChat`: 1
- `deleteTemporaryForkChats`: 1
- `markChatReadState`: 1
- `rotateChatSdkSession`: 1
- `setChatSdkAgentId`: 1
- `inferChatTitleSource`: 1
- `removeChat`: 1

Method: `git ls-files` over `lib/**`, `server.js`, `scripts/**`, `harnesses/**`, `tests/**` and all `*.ts|js|mjs`; named imports (including multi-line and
`await import()` destructuring), aliases (`x as y` is listed under the exported name), namespace imports, re-exports and
`import().then`. No re-export of `chats-persist.js` exists in the repository; `lib/persist/chats-backend-domain.js` re-exports pure helpers
that `chats-persist.js` re-exports in turn.

Dynamic `import()` without destructuring (they pick names at the call site – check by hand in B2–B4): `lib/usage-limit-resume-executor.js`,
`lib/workspace.js`, `lib/agent-finished-push.js`, `lib/sdk/cursor-agent-sdk-ws.ts`, `scripts/architecture-stall-profile.mjs`.

## Production callers (108 files)

| File | Imported names | Notes |
|---|---|---|
| `app_front/features/chat/chatListLiveSync.js` | - | - |
| `harnesses/codebuddy/codebuddy-agent-ws.js` | `getChatByCursorSessionId`, `setChatCodeBuddySessionId`, `updateChat` | - |
| `harnesses/deepseek/deepseek-agent-ws.js` | `getChatByCursorSessionId`, `setChatDeepSeekSessionId`, `updateChat` | - |
| `harnesses/mimo/mimo-agent-ws.js` | `getChatByCursorSessionId`, `updateChat` | - |
| `harnesses/mistral/mistral-agent-ws.js` | `getChatByCursorSessionId`, `updateChat` | - |
| `harnesses/opencode/opencode-agent-ws.js` | `getChatByCursorSessionId`, `setChatOpenCodeSessionId`, `updateChat` | - |
| `harnesses/openrouter/openrouter-agent-ws.js` | `getChatByCursorSessionId`, `updateChat` | - |
| `harnesses/qwen/qwen-agent-ws.js` | `getChatByCursorSessionId`, `setChatQwenSessionId`, `updateChat` | - |
| `harnesses/zai/zai-agent-ws.js` | `getChatByCursorSessionId`, `updateChat` | - |
| `lib/agent-finished-push.js` | `loadChats` | 1 dynamic import(then) |
| `lib/agent-harness/room-kernel.ts` | `loadChats` | - |
| `lib/agent-run-state.js` | `peekChats` | - |
| `lib/backup/conversations-store.js` | `loadChats`, `loadChatsSnapshot`, `saveChats` | - |
| `lib/browser/chat-browser-scope.js` | `loadChats` | - |
| `lib/browser/guards.js` | `loadChats` | - |
| `lib/browser/navigation-consent.js` | `getChatById` | - |
| `lib/browser/routes.js` | `loadChats` | - |
| `lib/chat-archive-guard.js` | `setChatArchiveRejector` | - |
| `lib/chat-archive-policy.js` | `loadChats`, `updateChat` | - |
| `lib/chat-auto-archive.js` | `loadChats`, `updateChat` | - |
| `lib/chat-catalog.js` | `peekChatsSnapshot` | - |
| `lib/chat-created-push.js` | - | - |
| `lib/chat-list-sync.js` | - | - |
| `lib/chat-message-guard.js` | `getChatByCursorSessionId` | - |
| `lib/chat-retention.js` | `loadChats`, `updateChat` | - |
| `lib/chat-run/kernel-adapter.ts` | `getChatByCursorSessionId` | - |
| `lib/chat-run-service.js` | `getChatByCursorSessionId`, `getChatById`, `peekChats` | - |
| `lib/chat-title-agent.js` | `applyAutoTitle`, `loadChats` | - |
| `lib/chat-title-backfill.js` | `loadChats` | - |
| `lib/chat-title-dispatcher.js` | `loadChats` | - |
| `lib/chat-title-service.js` | `applyAutoTitle`, `loadChats` | - |
| `lib/claude/claude-agent-ws.ts` | `getChatByCursorSessionId`, `getChatByCursorSessionId as GetChatByCursorSessionId`, `setChatClaudeSessionId`, `updateChat` | - |
| `lib/claude/claude-peer-message.ts` | `loadChats` | - |
| `lib/codex/codex-agent-ws.ts` | `getChatByCursorSessionId`, `setChatCodexThreadId`, `updateChat` | - |
| `lib/context-compression-source.js` | `loadChats` | - |
| `lib/context/context-scope.ts` | `loadChats` | - |
| `lib/context/context-settings-runtime.ts` | `loadChats`, `updateChat` | - |
| `lib/conversation-fork-execute.js` | `createConversationForkChat` | - |
| `lib/decisions/decision-store.js` | `getChatById` | - |
| `lib/decisions/host-gates.js` | `getChatById` | - |
| `lib/delegation-mailbox.js` | `loadChats` | - |
| `lib/delegation-run-bridge.js` | `loadChats`, `updateChat` | - |
| `lib/delegation-runtime-boot.js` | `peekChats` | - |
| `lib/delegation-runtime-worker.js` | `loadChats` | - |
| `lib/delegation-service.js` | `addChat`, `loadChats`, `updateChat` | - |
| `lib/delegation-session-continuity.js` | `loadChats`, `updateChat` | - |
| `lib/delegation-takeover.js` | `loadChats`, `saveChats` | - |
| `lib/delegation-workflow.js` | `loadChats` | - |
| `lib/feedback-triage.js` | `addChat` | - |
| `lib/fork-chat-text.js` | `loadChats` | - |
| `lib/git-context.js` | `loadChats` | - |
| `lib/git-switch-guard.js` | `loadChats` | - |
| `lib/mcp/builtin/browser-tools.js` | `loadChats` | - |
| `lib/mcp/mcp-external-operator-tools.js` | `loadChats` | - |
| `lib/mcp/mcp-inprocess-client.js` | `deleteChat`, `loadChats`, `updateChat` | - |
| `lib/mcp/mcp-session.js` | `getChatByCursorSessionId` | - |
| `lib/model-pick-service.js` | `loadChats` | - |
| `lib/orchestrator-leaf-resolution.js` | `loadChats` | - |
| `lib/persist/chat-history-notify.js` | `loadChats` | - |
| `lib/persist/chat-title-history-persist.js` | - | - |
| `lib/persist/todos-legacy-move-adapter.js` | `loadChats`, `updateChat` | - |
| `lib/port-exposure/runtime.js` | `onChatArchived` | - |
| `lib/push.js` | `loadChats` | - |
| `lib/routes/chat-agent-routes.js` | `applyAutoTitle`, `createTemporaryForkChat`, `deleteTemporaryForkChats`, `getChatByCursorSessionId`, `loadChats`, `updateChat` | - |
| `lib/routes/chat-context-routes.js` | `loadChats` | - |
| `lib/routes/chat-media-routes.js` | `loadChats` | - |
| `lib/routes/chats-routes.js` | `addChat`, `deleteChat`, `loadChats`, `markChatReadState`, `peekChats`, `peekChatsByIds`, `rotateChatSdkSession`, `setChatTitleLocked`, `updateChat` | - |
| `lib/routes/claude-routes.js` | `loadChats` | - |
| `lib/routes/delegations-routes.js` | `loadChats` | - |
| `lib/routes/delegation-test-routes.js` | `loadChats` | - |
| `lib/routes/integrate-batch-routes.js` | `addChat` | - |
| `lib/routes/recovery-resume-routes.js` | `loadChats` | - |
| `lib/routes/review-lessons-routes.js` | `loadChats` | - |
| `lib/routes/todos-routes.js` | `addChat`, `loadChats`, `updateChat` | - |
| `lib/routes/worktrees-routes.js` | `addChat` | - |
| `lib/sdk/cursor-agent-sdk-ws.ts` | `getChatByCursorSessionId as getChatByCursorSessionIdRaw`, `setChatSdkAgentId`, `updateChat as updateChatRaw` | 1 dynamic import(then) |
| `lib/sdk/sdk-history-isolation-fork.ts` | `addChat`, `loadChats` | - |
| `lib/shared-types/chat-row.ts` | - | - |
| `lib/shared-types/chat.ts` | - | - |
| `lib/shared-types/persist-records.js` | - | - |
| `lib/todo-plan-sync.js` | `loadChats`, `updateChat` | - |
| `lib/todo-review-sync-hooks.js` | `loadChats` | - |
| `lib/usage/cache-freshness-view.ts` | `loadChats` | - |
| `lib/usage/keep-alive-service.ts` | `loadChats` | - |
| `lib/usage-limit-resume-executor.js` | - | 1 dynamic import(then) |
| `lib/usage/usage-top-read.ts` | `loadChats` | - |
| `lib/widget/widget-http.ts` | `loadChats` | - |
| `lib/workspace.js` | - | 1 dynamic import(then) |
| `lib/workspace-scout-chat.js` | `loadChats` | - |
| `lib/workspace-watcher-archive-sweep.js` | `loadChats` | - |
| `lib/workspace-watcher-control.js` | `loadChats` | - |
| `lib/workspace-watcher-cycle.js` | `addChat`, `loadChats` | - |
| `lib/workspace-watcher-delegation-guard.js` | `loadChats` | - |
| `lib/workspace-watcher.js` | `loadChats` | - |
| `lib/workspace-watcher-nudge.js` | `loadChats` | - |
| `lib/workspace-watcher-pinned-chat.js` | `addChat`, `loadChats` | - |
| `lib/workspace-watcher-scout.js` | `addChat`, `loadChats`, `updateChat` | - |
| `lib/workspace-watcher-todo-recover.js` | `loadChats` | - |
| `lib/worktree-list.js` | `loadChats` | - |
| `lib/ws/ws-router.ts` | `getChatByCursorSessionId` | - |
| `scripts/architecture-chat-list-bench.mjs` | `loadChats` | - |
| `scripts/architecture-stall-profile.mjs` | - | 2 dynamic import(then) |
| `scripts/chat-workspace-ids-migrate.mjs` | `migrateChatWorkspaceIds` | - |
| `scripts/lib/demo-seed.mjs` | `addChat` | - |
| `scripts/measure-todo-save.js` | `loadChats` | - |
| `scripts/pin-chat-url.js` | `getChatByCursorSessionId`, `loadChats`, `updateChat` | - |
| `scripts/scout-pass-fixture.mjs` | `saveChats` | - |
| `scripts/sdk-chat-probe.js` | `loadChats` | - |

## Test callers (203 files)

| File | Imported names | Notes |
|---|---|---|
| `harnesses/codebuddy/tests/codebuddy-disabled.test.js` | `addChat` | - |
| `harnesses/deepseek/tests/deepseek-disabled.test.js` | `addChat` | - |
| `harnesses/mimo/tests/mimo-disabled.test.js` | `addChat` | - |
| `harnesses/mistral/tests/mistral-harness-flow.test.js` | `addChat` | - |
| `harnesses/opencode/tests/opencode-disabled.test.js` | `addChat` | - |
| `harnesses/openrouter/tests/openrouter-disabled.test.js` | `addChat` | - |
| `harnesses/qwen/tests/qwen-disabled.test.js` | `addChat` | - |
| `harnesses/zai/tests/zai-disabled.test.js` | `addChat` | - |
| `tests/agent-run-state.test.js` | `addChat`, `peekChats` | - |
| `tests/apps-mcp-tools.test.js` | `addChat`, `updateChat` | - |
| `tests/auto-context-compression-gate.test.js` | `createFreshSdkContextEntry` | - |
| `tests/billing-mcp-import.test.js` | `addChat` | - |
| `tests/browser-agent-tools.test.js` | `saveChats` | - |
| `tests/chat-archive-guard.test.js` | `addChat`, `updateChat` | - |
| `tests/chat-archive-scope-http.test.js` | `saveChats` | - |
| `tests/chat-catalog-contract.test.js` | `getChatsReadStats`, `loadChats`, `peekChats`, `saveChats` | - |
| `tests/chat-context-manifest.test.js` | `loadChats`, `saveChats` | - |
| `tests/chat-created-push.test.js` | - | - |
| `tests/chat-create-harness-guard.test.js` | `loadChats`, `saveChats` | - |
| `tests/chat-history-isolation.test.js` | `addChat` | - |
| `tests/chat-history-pending-delegation.test.js` | `addChat` | - |
| `tests/chat-list-poll-http.test.js` | `saveChats` | - |
| `tests/chat-list-updates.test.js` | `addChat`, `deleteChat`, `saveChats`, `updateChat` | - |
| `tests/chat-media-routes.test.js` | `addChat` | - |
| `tests/chat-message-guard.test.js` | `addChat`, `updateChat` | - |
| `tests/chat-message-ref.test.js` | `addChat` | - |
| `tests/chat-parent-persist.test.js` | `loadChats`, `saveChats`, `updateChat` | - |
| `tests/chat-relation-history.test.js` | `addChat`, `loadChats`, `saveChats`, `updateChat` | - |
| `tests/chat-retention.test.js` | `loadChats`, `saveChats` | - |
| `tests/chat-run-accept.test.js` | `addChat` | - |
| `tests/chat-run-recovery-wiring.test.js` | `addChat` | - |
| `tests/chats-persist-cache.test.js` | `getChatByCursorSessionId`, `getChatById`, `getChatsReadStats`, `loadChats`, `saveChats` | - |
| `tests/chats-persist-harness.test.js` | `loadChats`, `saveChats`, `setChatClaudeSessionId`, `updateChat` | - |
| `tests/chats-persist-index.test.js` | `loadChats`, `peekChats`, `peekChatsByIds`, `saveChats` | - |
| `tests/chats-persist-remove-no-copy.test.js` | - | 1 dynamic import(then) |
| `tests/chats-persist-single-update.test.js` | `getChatById`, `getChatsReadStats`, `peekChats`, `saveChats`, `setChatClaudeSessionId`, `updateChat` | - |
| `tests/chat-title-agent.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/chat-title-backfill.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/chat-title-dispatcher.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/chat-title-history.test.js` | `addChat`, `applyAutoTitle`, `deleteChat`, `inferChatTitleSource`, `loadChats`, `saveChats`, `setChatTitleLocked`, `updateChat` | - |
| `tests/chat-title-providers.test.js` | `addChat`, `loadChats` | - |
| `tests/chat-title-routes.test.js` | `addChat`, `applyAutoTitle`, `loadChats`, `updateChat` | - |
| `tests/chat-title-service.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/chat-workspace-sql.test.js` | `loadChats`, `migrateChatWorkspaceIds`, `saveChats` | - |
| `tests/claude-session-reset.test.js` | `addChat`, `loadChats` | - |
| `tests/codex-review-guard-resume.test.js` | `addChat` | - |
| `tests/context-settings.test.js` | `loadChats`, `saveChats` | - |
| `tests/conversation-fork-reference.test.js` | `loadChats`, `saveChats` | - |
| `tests/conversation-fork.test.js` | `createConversationForkChat`, `deleteChat`, `loadChats`, `saveChats` | - |
| `tests/conversations-backup.test.js` | `loadChats`, `saveChats` | - |
| `tests/cursor-context-routes.test.js` | `loadChats`, `saveChats` | - |
| `tests/decision-autonomy.test.js` | `addChat` | - |
| `tests/decision-gate-adapters.test.js` | `addChat` | - |
| `tests/delegation-accept-cas.test.js` | `addChat` | - |
| `tests/delegation-ack.test.js` | `addChat` | - |
| `tests/delegation-adapter-incomplete.test.js` | `addChat` | - |
| `tests/delegation-allow-recheck-path.test.js` | `addChat` | - |
| `tests/delegation-archived-parent.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/delegation-attempt-usage-metrics.test.js` | `addChat` | - |
| `tests/delegation-audit-fixes.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-auto-verify.test.js` | `addChat` | - |
| `tests/delegation-cancel-unconfirmed.test.js` | `addChat` | - |
| `tests/delegation-child-permission.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-complexity-persist.test.js` | `addChat` | - |
| `tests/delegation-context-manifest.test.js` | `addChat` | - |
| `tests/delegation-contract.test.js` | `addChat` | - |
| `tests/delegation-controller-model.test.js` | `addChat`, `deleteChat` | - |
| `tests/delegation-controller-replay.test.js` | `addChat` | - |
| `tests/delegation-criteria.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-cross-role-session-resume-service.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-delivery-acceptance.test.js` | `addChat` | - |
| `tests/delegation-fallback-no-verdict.test.js` | `addChat` | - |
| `tests/delegation-fix-loop-regression.test.js` | `addChat` | - |
| `tests/delegation-flow.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-implement-verify-gate.test.js` | `addChat` | - |
| `tests/delegation-interrupt-retry.test.js` | `addChat` | - |
| `tests/delegation-list-compact.test.js` | `addChat` | - |
| `tests/delegation-list-metrics-dto.test.js` | `addChat` | - |
| `tests/delegation-mailbox.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/delegation-model-gates.test.js` | `addChat` | - |
| `tests/delegation-outbox-concurrency.test.js` | `addChat` | - |
| `tests/delegation-parent-reply-loop.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-parent-width-leaf-scope.test.js` | `addChat` | - |
| `tests/delegation-phase2-dispatch.test.js` | `addChat` | - |
| `tests/delegation-phase2-review.test.js` | `addChat` | - |
| `tests/delegation-phase2-runtime.test.js` | `addChat` | - |
| `tests/delegation-phase3-adapter-guards.test.js` | `addChat` | - |
| `tests/delegation-phase3b.test.js` | `addChat` | - |
| `tests/delegation-phase3.test.js` | `addChat` | - |
| `tests/delegation-pick-id-http.test.js` | `addChat` | - |
| `tests/delegation-plan-authoring-public.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-plan-window-reservation.test.js` | `addChat` | - |
| `tests/delegation-queued-resume-verify-override.test.js` | `addChat` | - |
| `tests/delegation-queue.test.js` | `addChat` | - |
| `tests/delegation-ratings.test.js` | `addChat` | - |
| `tests/delegation-reply-fencing.test.js` | `addChat` | - |
| `tests/delegation-reply-provenance.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-report-e2e-legacy-payload.test.js` | `addChat` | - |
| `tests/delegation-report-integrity.test.js` | `addChat` | - |
| `tests/delegation-report-reuse.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-retention.test.js` | `addChat` | - |
| `tests/delegation-review-continuation-run.test.js` | `addChat` | - |
| `tests/delegation-review-fanout.test.js` | `addChat` | - |
| `tests/delegation-review-followup.test.js` | `addChat` | - |
| `tests/delegation-review-independence-start.test.js` | `addChat` | - |
| `tests/delegation-review-lock.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-review-subject.test.js` | `addChat` | - |
| `tests/delegation-review-upgrade.test.js` | `addChat` | - |
| `tests/delegation-run-deadline.test.js` | `addChat` | - |
| `tests/delegation-run-stopping-stale.test.js` | `addChat` | - |
| `tests/delegation-runtime-worker.test.js` | `addChat` | - |
| `tests/delegation-selection-recovery.test.js` | `addChat` | - |
| `tests/delegation-session-resume-service.test.js` | `addChat`, `updateChat` | - |
| `tests/delegation-session-resume.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/delegation-shutdown-restart.test.js` | `addChat` | - |
| `tests/delegations-load-memo.test.js` | `loadChats`, `saveChats` | - |
| `tests/delegation-start-allow-recheck-mcp.test.js` | `addChat` | - |
| `tests/delegation-startup-retry.test.js` | `addChat` | - |
| `tests/delegation-stats-routes.test.js` | `addChat` | - |
| `tests/delegation-takeover-nested.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-takeover.test.js` | `addChat`, `loadChats` | - |
| `tests/delegation-tree-budget.test.js` | `addChat` | - |
| `tests/delegation-tree-cancel.test.js` | `addChat` | - |
| `tests/delegation-tree-depth.test.js` | `addChat` | - |
| `tests/delegation-tree-slots.test.js` | `addChat` | - |
| `tests/delegation-tree-visibility.test.js` | `addChat` | - |
| `tests/delegation-verify-manifest.test.js` | `addChat` | - |
| `tests/delegation-wait-signal.test.js` | `addChat` | - |
| `tests/delegation-wait.test.js` | `addChat` | - |
| `tests/delegation-workflow-http.test.js` | `addChat` | - |
| `tests/delegation-workflow-leaf-attribution.test.js` | `addChat` | - |
| `tests/delegation-workflow.test.js` | `addChat` | - |
| `tests/delegation-work-session-resume-service.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/delegation-workspace-guard.test.js` | `addChat` | - |
| `tests/demo-instance.test.js` | `loadChats` | - |
| `tests/execution-folder.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/helpers/recovery-chat-run-child.js` | `addChat` | - |
| `tests/helpers/review-round-fixtures.js` | `addChat` | - |
| `tests/instruction-epoch-budget.test.js` | `saveChats` | - |
| `tests/job-queue-verify-wiring.test.js` | `addChat` | - |
| `tests/keep-alive-run-observer.test.js` | `addChat` | - |
| `tests/kernel-chat-run-adapter.test.js` | `addChat` | - |
| `tests/local-harness-runtime.test.js` | `addChat`, `getChatByCursorSessionId`, `loadChats`, `saveChats` | - |
| `tests/mcp-bridge-reuse-keys.test.js` | `addChat`, `updateChat` | - |
| `tests/mcp-browser-tools.test.js` | `addChat` | - |
| `tests/mcp-builtin-bridge.test.js` | `addChat` | - |
| `tests/mcp-builtin-tools.test.js` | `addChat`, `applyAutoTitle` | - |
| `tests/mcp-chat-history-http.test.js` | `addChat` | - |
| `tests/mcp-chat-search.test.js` | `addChat` | - |
| `tests/mcp-delegation-start-allow-recheck.test.js` | `addChat` | - |
| `tests/mcp-external.test.js` | `addChat` | - |
| `tests/mcp-model-pick-controller-exclude.test.js` | `addChat` | - |
| `tests/mcp-reply-provenance-token.test.js` | `addChat`, `updateChat` | - |
| `tests/mcp-stdio-plan-policy.test.js` | `addChat` | - |
| `tests/mcp-update-todo-plan-sync.test.js` | `addChat` | - |
| `tests/model-pick-hard-gates.test.js` | `addChat` | - |
| `tests/notification-profiles.test.js` | `saveChats` | - |
| `tests/optional-harness-disabled-compat.test.js` | `addChat` | - |
| `tests/optional-harness-ws-router.test.js` | `addChat`, `updateChat` | - |
| `tests/orchestrator-leaf-resolution.test.js` | `addChat` | - |
| `tests/perf-budget-chats-baseline.test.js` | `saveChats`, `updateChat` | - |
| `tests/plan-reviewer-session-mcp.test.js` | `addChat` | - |
| `tests/recovery-presence.test.js` | `addChat` | - |
| `tests/resume-advice.test.js` | `addChat` | - |
| `tests/reviewer-pair-unstartable-member.test.js` | `addChat` | - |
| `tests/reviewer-policy-service.test.js` | `addChat`, `updateChat` | - |
| `tests/review-lessons-checks-transport.test.js` | `saveChats` | - |
| `tests/review-lessons-distill-transport.test.js` | `saveChats` | - |
| `tests/review-lessons-retry.test.js` | `addChat` | - |
| `tests/review-lessons-routes.test.js` | `saveChats` | - |
| `tests/review-lessons-transport.test.js` | `saveChats` | - |
| `tests/review-reviewer-wait.test.js` | `addChat` | - |
| `tests/review-verify-bridge-disconnect.test.js` | `addChat` | - |
| `tests/review-verify-parallel-timing.test.js` | `addChat` | - |
| `tests/sdk-context-reset.test.js` | `createFreshSdkContextEntry` | - |
| `tests/sdk-prompt-accept.test.js` | `addChat` | - |
| `tests/skill-selection.test.js` | `saveChats` | - |
| `tests/storage-chats-store.test.js` | - | 1 dynamic import(then) |
| `tests/storage-history-2b-e2e.test.js` | `saveChats` | - |
| `tests/summary-fork-route.test.js` | `loadChats`, `saveChats` | - |
| `tests/todo-body-truncation.test.js` | `addChat` | - |
| `tests/todo-chat-reuse-routes.test.js` | `addChat`, `loadChats`, `removeChat` | - |
| `tests/todo-home-routes.test.js` | `addChat`, `loadChats` | - |
| `tests/todo-leaf-material.test.js` | `addChat` | - |
| `tests/todo-manual-worktree.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/todo-move.test.js` | `addChat`, `loadChats`, `updateChat` | - |
| `tests/todo-review-sync-hooks.test.js` | `addChat` | - |
| `tests/todos-routes.test.js` | `addChat` | - |
| `tests/todo-tools.test.js` | `addChat`, `loadChats` | - |
| `tests/update-gate.test.js` | `addChat` | - |
| `tests/usage-control-mcp.test.js` | `addChat` | - |
| `tests/usage-limit-paused-hooks.test.js` | `addChat` | - |
| `tests/widget-api-gate.test.js` | `saveChats` | - |
| `tests/workspace-scout-templates-scope.test.js` | `addChat` | - |
| `tests/workspace-watcher-archive-sweep.test.js` | `addChat`, `loadChats`, `saveChats`, `updateChat` | - |
| `tests/workspace-watcher-delegation-guard.test.js` | `addChat` | - |
| `tests/workspace-watcher-e2e.test.js` | `addChat` | - |
| `tests/workspace-watcher-events.test.js` | `addChat` | - |
| `tests/workspace-watcher-orchestrator.test.js` | `addChat`, `loadChats` | - |
| `tests/workspace-watcher-pinned-chat.test.js` | `addChat`, `deleteChat`, `loadChats` | - |
| `tests/workspace-watcher-review-gate.test.js` | `addChat` | - |
| `tests/workspace-watcher-scout.test.js` | `addChat`, `loadChats` | - |
| `tests/workspace-watcher.test.js` | `addChat` | - |
