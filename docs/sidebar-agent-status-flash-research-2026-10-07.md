# Sidebar agent status flashing — research (2026-10-07)

Todo: `47d0809f-631c-4e18-868d-f45c3d77c71b`  
Workspace: Cretli (`app_front` sidebar chat list)

## Symptom (PL)

Przy wielu równoległych chatach (np. `[Watcher]` / `[Scout]` w autopilot) lewe
ikony i statusy w sidebarze **migają** i użytkownik ma wrażenie, że **nie
odzwierciedlają realnego stanu każdego wiersza** — czasem jakby stany
„przeskakiwały” między wierszami zamiast stabilnie trzymać się `data-chat-id`.

To zadanie to **tylko research** (bez poprawki w kodu).

## Architecture map (status → DOM)

```text
Chat object signals → resolveHarnessChatStateMeta (chatStatusMeta.js)
        │
        ▼
chat.js getSidebarChatStateMeta() + sidebarStatusStabilizer (500ms exit/label hold)

Public alias (one stabilizer per chatId):
  App.js:510 → getTerminalStateMetaPublic → getSidebarChatStateMeta (chat.js:3537-3538)
  sidebarView.js:887-888 → getSidebarChatStateMeta: getTerminalStateMeta (same alias)

Structural HTML (Lit):
  buildSidebarChatRowHtml → <li> starts idle, no data-visual-key (sidebarChatRowModel.js:96)
  cr-sidebar-chat-row render() unsafeHTML → replace <li> when rowHtml string changes
  applyRowVisualPatchFromRegistration after updateComplete → real status (cr-sidebar-chat-row.js:88-104)

In-place status (no <li> replace when rowHtml unchanged):
  scheduleChatListStateRefresh → patchSidebarChatRowVisualState (visualKey dedup :33)
```

## Root causes (ranked)

### P0 — `<li>` replacement on **structural** signature changes (idle → patched flash)

**Evidence**

- Workspace structure signature includes chat ids, `rows`, `groups`, titles, pins,
  fork links, archive edges (`sidebarView.js:1515-1566`, title at ~1554).
- **Not** in signature: per-row status tone, `_pushPreview` (`sidebarChatRowModel.js:30-32, :75`).
- Autopilot adds chats often (new cycle orchestrator, delegation children,
  archive moves) → signature changes **more often** than manual single-chat use.
- When one row’s `rowHtml` changes, **neighbors** can change too: `is-last-child`
  (`sidebarChatRowModel.js:72`), `continuationLevels`, nest level, subchat summary,
  `is-active` (`:70`) — same signature pass updates multiple strings.
- Watcher/scout **titles** are set once at chat creation
  (`lib/workspace-watcher-cycle.js` ~700, `lib/workspace-watcher-scout.js` ~3146);
  title-only churn is **rare** (sync/rename events), not the main autopilot driver.
- Fresh `<li>` HTML always renders
  `sidebar-chat-item-state--idle` with empty title (`sidebarChatRowModel.js:96`).
  Real status applies only after async `updateComplete` patch → brief **idle**
  frame and **mdi-spin restart** (`sidebarChatStatus.js:11-13) when `<li>` was
  replaced.

**Mechanism**

Many parallel agents ⇒ frequent list membership / tree updates ⇒ multiple
`<li>` replacements per rebuild ⇒ user sees a **wave of idle/spin transitions**
even on rows whose harness state did not change — easy to read as statuses
“jumping” between rows.

**Fix direction (not implemented)**

- Emit status in initial row HTML (or preserve indicator node across structural
  class-only changes via in-place patch, not full `unsafeHTML` replace).
- Trace: count `<li>` replacements per signature change (`recordSidebarPatch` +
  structural diff); measure under 3+ concurrent watcher chats.

### P1 — Stale protocol fields for chats outside background WS cap (hypothesis)

**Evidence**

- Desktop: `CHAT_BACKGROUND_WS_MAX = 4` (`config.js`); mobile `backgroundWsMax = 0`
  (`chatBackgroundPolicy.js:122`).
- Stabilizer exit when `serverKnown && !serverBusy && !localActive`
  (`sidebarChatStatusStability.js:183-188`).
- `hasKeepAliveHarnessWork` prevents `_agentState` idle while protocol busy
  (`chatStatusMeta.js:145-151`, `chat.js:3695-3698`) **when fields are current**.

**Hypothesis**

If presence/sync lags for a chat without a WS slot, meta may flicker idle ↔ busy
between hydrates. Opposite case (local idle while server busy) is already guarded.

### P1 — Full-list refresh when opening sidebar

`openSidebar` → `refreshStates` → `scheduleChatListStateRefreshAll()` (`chat.js:3811`).
O(n) visits; `visualKey` limits writes to changed meta.

### P2 — Wrong status on wrong `data-chat-id` (unconfirmed)

No code path copies status across ids. Open: `reg.chat` vs `event.chatById` staleness.

## Ruled out (reviews 2026-10-07)

- Stabilizer bypass on Lit vs bus — **same** `getTerminalStateMetaPublic` alias.
- `_agentState` dropping to idle after 1.5s while `hasProtocolAgentRun` — blocked by
  `hasKeepAliveHarnessWork`.

## Tests / mitigations

- `tests/chat-status-meta.test.js` — stabilizer.
- `tests/sidebar-chat-row.test.js`, `sidebar-lit-lifecycle.test.js`,
  `sidebar-transient-patch.test.js`, `sidebar-workspace-lit.test.js`.
- `node scripts/review-verify.js sidebar-lit-migration-contract` — contract checks.

## Recommended next steps (out of scope)

1. Reproduce + trace: concurrent watcher chats, count structural `<li>` replacements.
2. Fix P0: status in initial HTML or patch structural attrs without replacing `<li>`.
3. Investigate WS-cap / hydrate lag (desktop vs mobile).
4. Confirm `reg.chat` staleness if flicker persists after P0 fix.

## Open questions

- Visible one-frame idle vs only spin restart?
- Delegation child rows vs orchestrator rows only?

---

*Orchestrator `03b97f9f`; implement delegation blocked (`8e1fe1f8`). Reviews:
`27b00322` FAIL (false dual-path), `a5780fde` FAIL (title-churn corrected → this revision).*
