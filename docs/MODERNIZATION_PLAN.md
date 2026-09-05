# Cretli modernization plan

Actionable backlog for small, independently shippable changes. One task per PR when possible. Before changing code, run the verification command for that task; after the change, run the same command plus `npm run lint`. Do not refactor beyond the task scope.

## Executor rules

- Keep comments in English.
- Prefer guard clauses and small diffs.
- Do not commit unless asked.
- Phases 1–3 depend on Phase 0 landing first.

## A. Known bugs (Phase 0)

| ID | Bug | Location | Severity |
|----|-----|----------|----------|
| B1 | `flushPtyOutput()` reads `_pendingOutput`, which is never written | `lib/pty-broadcast.js` | low |
| B2 | No `bufferedAmount` backpressure on PTY broadcast | `lib/pty-broadcast.js` | medium |
| B3 | No WS ping/pong keepalive — ghost sockets | `lib/ws/*`, harness rooms | medium |
| B4 | `rejectOpenCodePlanPermission` awaits instance create outside `try` → unhandled rejection | `lib/opencode/opencode-agent-ws.js` | high |
| B5 | Qwen copy-paste: `_pendingOpenCodeQuestions` / `opencodeQuestionResolved` | `lib/qwen/qwen-agent-ws.js` | medium |
| B6 | Codex replay does not cancel the per-socket timer | `lib/codex/codex-agent-ws.js` | medium |
| B7 | Logic matches localized PL/EN error strings | SDK WS, rich view, title fork | medium |
| B8 | Listener/timer leaks in a long-lived PWA | `app_front/tasks.js`, `chat.js`, `logger.js` | high |
| B9 | Corrupt `widget-installations.json` throws forever | `lib/widget/widget-installations.js` | medium |
| B10 | Empty `catch` blocks swallow errors | PTY WS, chat, fork-title | low |
| B11 | Agent callback token compared with `===` | `lib/auth.js` | low |
| B12 | No Origin check on WS upgrade with `SameSite=None` | `lib/ws/ws-router.js` | medium |
| B13 | Polish prompt seed text (legacy history still uses PL markers) | `app_front/lib/context-seed-payload.js` | medium |
| B14 | User-visible Polish strings outside i18n | `app_front/chat.js` | low |
| B15 | Production source maps published; no `[contenthash]` | `app_front/webpack.prod.js` | medium |

## B. Architecture weaknesses (later phases)

- Harness room logic is copied 6–7 times (~grace shutdown, broadcast, persist buffer).
- Persistence: sync `readFileSync` per request; whole-file rewrite; no lock.
- `server.js` and `app_front/chat.js` / `app.scss` are oversized.
- Six reconnect/recovery systems answer “did the server restart?” differently.
- PWA `SHELL_ASSETS` is hand-maintained.

## C. Tasks

### Phase 0 — bugfixes

| ID | Task | Verification |
|----|------|----------------|
| T01 | Remove dead `_pendingOutput` flush (keep a no-op hook before `onExit`) | `npm run test:bind-host`; grep `_pendingOutput` |
| T02 | Skip/warn PTY send when `bufferedAmount > 512 KB` | `node tests/pty-broadcast.test.js` |
| T03 | Shared WS ping/pong helper (30 s, 2 misses → terminate) | `node tests/ws-keepalive.test.js`; `npm run test:sdk-ws-reconnect-smoke` |
| T04 | Move OpenCode instance await into `try` | `npm run test:opencode-plan-mode` |
| T05 | Rename Qwen pending questions; emit neutral `questionResolved` | `npm run test:qwen-question` |
| T06 | Cancel Codex replay timer like OpenCode | `npm run test:codex-event-normalizer`; `npm run test:sdk-disconnect-replay` |
| T07 | `timingSafeEqual` for agent callback token | `npm run test:auth-session-persist` |
| T08 | Backup+recover corrupt widget installations file | `npm run test:widget` |
| T09 | Log empty catches instead of swallowing | `npm run lint` |
| T10 | WS Origin allowlist: same-host + `CRETLI_EXTRA_WS_ORIGINS` + widget/page-bridge | `node tests/ws-origin.test.js` |
| T11 | `t()` warns on missing keys; i18n for queue/settings log labels | grep `[kolejka` |
| T12 | Shared `lib/notices.js` for PL/EN setup-cancel and timeout notices | `node tests/notices.test.js` |
| T13 | `devtool: 'hidden-source-map'` in prod (hashed filenames wait for T31) | `npm run build:front:prod` |
| T14 | Move `STATUS_TEST_FIXTURES` to JSON | `npm run test:status-parser:all` |
| T15 | Remove task resize listeners; stop unused debug intervals | `npm run test:modernization` |

### Phase 1 — backend room kernel

- **T16** Extract `lib/agent-harness/room-kernel.js`. **Done**
- **T17–T22** OpenRouter, DeepSeek, Qwen, CodeBuddy, Codex, OpenCode on the kernel. **Done**
- **T23** Slim `server.js` (<400 lines): workspace helpers, widget-auth page, client-debug-log, HMR. **Done**
- **T24** mtime cache for settings/chats/auth; `fsync` in `writeJsonAtomic`.
- **T25** Central `lib/config/env.js` registry (`CRETLI_*` + aliases), migrate gradually.

### Phase 2 — frontend split

- **T26** Split `chat.js` along existing seams (`chatTransport` / `chatView` / `chatController`). Target `<2000` lines.
- **T27** Unify reconnect/recovery in `features/chat/serverSession.js`.
- **T28** Hex-token lint + replace hardcoded colors in `app.scss` / widget palette.
- **T29** Incremental Lit/recipes migration: chat list → settings modal → sidebar.
- **T30** Real HMR disposal (after T26/T27).

### Phase 3 — PWA and extras

| ID | Work |
|----|------|
| T31 | Generate `SHELL_ASSETS` from the webpack manifest; bump `CACHE_NAME` from `package.json`; precache panel chunks |
| T32 | Terminal session reaper (TTL ~6 h) + `/api/health` metric |
| T33 | Rate limiter: optional `X-Forwarded-For` when `CRETLI_TRUST_PROXY=1` |
| T34 | Per-chat persist files + mutex |
| T35 | Unit test that `en.js` and `pl.js` keys match |

## Order

```
Phase 0 (T01–T15)  independently shippable
Phase 1 (T16–T25)  T16 blocks T17–T22; T23/T24/T25 parallel
Phase 2 (T26–T30)  T26 blocks T30
Phase 3            T31 may start after T13
```
