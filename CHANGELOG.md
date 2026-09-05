# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Switching harness from a nested sidebar chat now creates the new chat under
  the same parent instead of making a new folder and moving the current chat
  into it.
- OpenCode Plan no longer stays locked after the user confirms a plan in the
  question UI: Cretli switches to Agent and lifts write permissions before the
  answer is sent, so the same turn can implement instead of repeating the plan
  hint.
- OpenCode permission Once/Always no longer shows `PermissionNotFoundError` after
  the request was already auto-denied. Stale replies are treated as resolved, the
  card closes when the matching tool errors, session permission rules are re-synced
  on each prompt, and the SSE loop stops after room abort (it previously kept
  writing a second event stream).
- OpenCode no longer snaps back to Plan after you switch to Agent mid-run (retries
  and queued prompts used the mode from send time). `session.idle` while a
  question or permission is open no longer ends the turn. Plan bash is asked
  (not blanket-denied) so read-only shell can explore; mutating bash is still
  blocked.
- Plan mode denies mutating tools before execution for OpenCode, Cursor SDK, Qwen,
  CodeBuddy, OpenRouter, and DeepSeek (`canUseTool` / permission / catalog / run abort).
  Codex Plan stays prompt-only and does not abort the turn.
- A later, shorter complete Plan-mode answer now replaces the previous plan file
  instead of being ignored because it was shorter. Progress comments no longer
  append to the plan.
- Stop on a delegated job no longer reports cancelled while the executor may
  still be running; the card stays on Stopping until the run ends.
- Delegation report cards are written to history before they are marked
  delivered, and boot recovery retries a missing card.
- Parent-model report confirmation uses the ids placed in that prompt, not every
  pending report. OpenRouter confirms after the agent loop starts, not before.
- Retry of an old job is blocked while another job for the same planner chat is
  active.
- Production delegation API checks the enabled model catalog. The build-plan
  form shows the approved plan revision and limits harnesses to server-started
  executors. Waiting-for-input updates the parent card.
- WebSocket widget subprotocol no longer bypasses Origin checks on terminal, task, or log
  paths; widget chat and page bridge still require a valid widget access token (iframe chat
  uses the Cretli origin, external embeds must match the token origin).
- `USE_HTTPS=1` no longer falls back to HTTP when TLS key/cert files are missing or invalid;
  startup exits with a remediation message. Use `USE_HTTPS=0` for explicit HTTP.
- Mutating API calls authenticated with the session cookie require `X-Cretli-Csrf`; a 403
  with `csrfRequired: true` refreshes the token once. Logout and session invalidation close
  active cookie-authenticated WebSocket connections.
- Same-host WebSocket Origin checks compare scheme, host, and port. `CRETLI_PUBLIC_ORIGIN`
  identifies the Cretli iframe behind a TLS proxy without trusting `CRETLI_EXTRA_WS_ORIGINS`
  as first-party. `USE_HTTPS=0` in `.env` is honored by the launcher; default certs are
  generated only for HTTPS with the default `data/` paths.

### Added
- Sidebar chats can be **reordered** with a press-and-hold drag (same gesture as
  workspace groups). Hover another chat for ~0.5s (dashed, then solid outline) to
  nest it as a sub-chat; drag among roots to lift it back out. Custom order is
  stored in the browser; the parent link is saved on the chat. Switching harness
  and keeping the previous chat hangs that chat under the new one.
- Chat list polls lightweight agent presence (`GET /api/chats/agent-states`) so an
  executor still shows working or needs-action without an open WebSocket. Finished
  jobs keep an attention badge until **Mark as reviewed** (`POST /api/delegations/:id/ack`);
  opening the executor only clears waiting-for-input. OpenRouter rooms hydrate
  conversation history after dispose so a later continue keeps context. Deleting a
  chat with an active job cancels that job first.
- Disconnected chats in the sidebar use the same muted action-icon size as
  trash/star, with a broken-chain glyph. Connecting uses a yellow blinking
  spinner instead of the “Connecting…” label. An active agent uses a spinning
  cog instead of “Agent working”. Needs-action uses a yellow alert icon.
  Status polls do not restart the spinner animation.

### Changed
- Production webpack uses `hidden-source-map` so map files are not referenced from the
  published bundles. Status-parser unit fixtures live in
  `public/fixtures/status-parser-unit.json` instead of the production parser module.
- `server.js` is a composition root: workspace selection, widget auth HTML,
  client debug log, webpack HMR, and HTTP route registration live in `lib/`.
- Codex and OpenCode chat rooms also use `lib/agent-harness/room-kernel.js`
  (Codex aborts the in-flight exec turn; OpenCode releases the instance lease
  and SSE subscription). Cursor SDK rooms remain separate.
- Chat model pickers (mode bar and new chat) only list **checked** catalog
  values. Sibling variants and stale ids no longer appear as choices.
- Voice `set_model` is instructed to run immediately when the user names a
  model. `list_models` now returns a short page (optional `query`) instead of
  the full SDK catalog, which was delaying the next Live function call.
- **Analyze current agent** is a sub-chat with empty history, not a conversation
  fork: it only gets the parent chat id and a live status snapshot (no copied
  transcript). The parent stays the subject to diagnose.
- Fork chat no longer auto-sends “continue previous work”. The new chat stays a
  quiet fork; the continue/handoff text is left in the send field and is only
  sent when you submit it (or replace it with your own message). Analyze-agent
  and **Fork chat + this message** still send immediately.

### Fixed
- Plan mode allows Codex `web_search` and no longer treats `rg 'a|b|delete'` as a
  mutating pipeline (quoted `|` is not a shell pipe). Incomplete shell starts and
  `$(` / `|` inside `rg` patterns no longer abort the turn; Codex `parsed_cmd` is
  ignored when the real exec argv is present.
- Codex Plan mode no longer aborts the exec turn. Host-side plan-guard heuristics
  were cancelling read-only `rg`/`cat`/`web_search` batches; Plan is prompt-only
  (`danger-full-access` cannot use a read-only sandbox on non-git workspace roots).
- OpenCode plan-mode permission reject no longer leaves an unhandled rejection when the
  instance cannot be created.
- PTY broadcast skips slow clients when the WebSocket buffer exceeds 512 KB.
- WebSocket connections get a 30 s ping keepalive and reject cross-site Origins unless
  they are same-host or listed explicitly in `CRETLI_EXTRA_WS_ORIGINS` (full origin URLs).
  Widget chat and page bridge require a valid widget token; the widget subprotocol alone
  does not grant access to terminal or log streams.
- Corrupt `widget-installations.json` is backed up and replaced instead of crashing every
  request.
- Agent callback tokens are compared with `timingSafeEqual`.
- Task-run resize listeners and debug intervals are cleaned up; Codex replay timers are
  cancelled on disconnect.

### Added
- Plan execution can be **delegated** to another harness/model: prepare the plan
  in Plan mode, then **Build plan → New agent** or `/wykonaj` (`/execute`). Cretli
  copies the approved plan, starts the executor without a browser tab, shows a
  status card in the planner chat, and injects the report into the planner's
  next turn. One active job per planner chat. Stop stays `cancelling` until the
  run actually ends; reports are confirmed only for ids included in that prompt;
  retry respects the parent busy lock.
- `docs/MODERNIZATION_PLAN.md` — phased bugfix and architecture backlog.
- Settings → Harness overview rows can be **reordered** (drag handle). The
  order is stored in settings and used in new chat, the mode bar, and voice.
- Connection dialog has **Reload page** for PWA installs that have no browser
  refresh control.
- Settings → Harness overview shows **enabled/total** models on the right of
  each backend row (checked catalog entries used in new chat and voice).
- Settings → Harness can turn each backend **on/off**. A disabled harness is
  hidden from new chat, the mode bar, and voice (`switch_harness` /
  `list_models`). Existing chats keep working. Voice and pickers only offer
  **checked** models of an enabled harness.
- Voice Live sessions now keep tool timings (`durationMs`, `resultBytes`) and
  OpenAI/Gemini wire events. `GET /api/voice/sessions/:id?diagnose=1` returns
  gap analysis; `GET /api/voice/requests` lists token-mint HTTP timings under
  `data/voice-sessions/http-requests.ndjson`.
- Sidebar workspace groups can be reordered with a press-and-hold drag (mouse
  and touch). The custom order is stored in the browser and survives a reload;
  pinning the active workspace still keeps it at the top.
- PWA update toast (**A new version is available**) can be dismissed with **×**;
  it stays hidden until the next full page reload if the version mismatch remains.
- Desktop sidebar can be **pinned** next to the close button: the drawer stays
  in the left column (header, tabs, and panels start beside it) instead of
  overlaying the chat. Open + pin are stored in the browser and restored on
  refresh; mobile overlay still uses overlay and can close on PWA resume.
- Codex picker now lists **GPT-6 Astra** (`gpt-6-astra`) plus Spark, GPT-5.5,
  and GPT-5.4 Mini in the API-key fallback catalog. ChatGPT plan chats use the
  live account list from `models_cache.json` so models the plan has not rolled
  out yet (often Astra) are not offered.
- Optional `@openai/codex-sdk` (and bundled CLI) bumped to **0.153.4**, which
  includes Astra in the CLI model catalog.
- Plan mode **Build plan** is a compact dropdown: this chat, or a **new agent**
  (new-chat modal for harness + model). The source chat stays in Plan; the new
  chat starts in Agent with a prompt pointing at the approved plan file.

### Fixed
- Voice Live on phones: agent replies now play through a hidden `<audio>` element
  (Chrome was silent on Web Audio / the earpiece). Connect no longer waits on
  `audio.play()` before the WebRTC handshake (that hung on “Connecting…”).
  The bar under the mic is input level, not volume — **Test sound** plays a beep
  on the same output.
- OpenCode no longer leaks a running turn into a newly opened empty chat. One
  server instance broadcasts every workspace session; rooms without their own
  OpenCode session id were accepting those events and writing them to history.
- Plan mode on OpenCode, Codex, DeepSeek, Qwen, CodeBuddy, and OpenRouter now
  persists the plan to `.cursor/plans/cretli-{chatId}.md` and the linked Todo
  after the run (same host-side path as Cursor SDK). Build-plan no longer looks
  for a file the model was not allowed to write.
- Codex ChatGPT 400s (e.g. Astra not on the plan) now show the API message
  instead of `Codex Exec exited with code 1: Reading prompt from stdin...`.
- Codex Plan mode no longer aborts on `/bin/bash -lc` wrappers around read-only
  shell (`pwd`, `rg --files`, `ls`). Codex always wraps exec that way; the plan
  guard now unwraps the inner script and still blocks writes, `edit`, and
  mutating commands.
- Sidebar **Delete chat** now honors **Delete and don't ask again**. The
  preference still cannot skip confirmation while the agent is working; that
  dialog warns that deleting stops the run. Server-side room dispose on chat
  delete already interrupts the process.
- Widget: **New agent** / **+** on a URL-pinned page creates a new chat and keeps
  the send bar visible, instead of reusing the pinned chat or ending on an empty
  Agent pane.
- DeepSeek Harness no longer offers `read_image` on text-only models (Flash/Pro), and `web_fetch` can open local/LAN HTTP(S) URLs instead of failing on private IPs.
- Tasks panel loads `.vscode/tasks.json` from **every** workspace folder (Cursor
  multi-root), instead of stopping at the first file found. Duplicate labels
  are prefixed with the folder name. The list follows the open chat's workspace
  (`GET /api/tasks?workspaceFile=…`) and is refreshed when the Tasks tab opens.
- Importing a `.code-workspace` file now copies its folders into the Cretli overlay
  (relative, absolute, `~`, Windows/`file://` paths). Previously the registry row
  was added with an empty folder list. Workspaces already imported with no overlay
  are filled on the next workspace list load.

## [0.3.0] - 2026-09-04

### Added
- Settings → Workspace folder list can be reordered (up/down). The first folder
  is the workspace root used for Cursor rules, skills, and agents.
- Sidebar drawer is wider on mobile (`min(90vw, 360px)`) and can be dragged to
  resize; the width is remembered per browser.
- Server-side folder/file **picker** (`GET /api/fs/entries`, `POST /api/fs/mkdir`)
  with a reusable `cr-fs-picker` Lit element and a "Browse" button next to path
  fields (Settings → Workspace, first-run workspace step, additional Cursor
  context dirs). The picker can create a new folder in the current directory.
- Workspace actions: **Convert to a Cretli workspace** (a `.code-workspace` entry
  becomes a self-config `cretli:ws:` workspace — folders stay, syncing stops) and
  **Export to `.code-workspace`…** (writes a self-config workspace's enabled folders
  into a new file). `GET /api/workspaces` reports `fileExists` per file workspace.
- Todo cards show which harness and chat created the task, with a link back to that chat.
- Todo plan section renders Markdown with the same preview as Files.
- **Fork chat** in More actions opens the new-chat modal to pick harness and model; the source chat stays open.
- Voice Live tools: switch/list workspaces and folders, list tasks with fuzzy `run_task`,
  archive (`close_chat`) and rename a chat, and `delete_chat` now requires `confirm=true`.
  The panel shows when the coding agent is working after `send_prompt`. Voice can also
  send terminal keys (`send_nav`, including permission Once/Reject), list/set the chat
  model, and switch harness (`switch_harness` requires `confirm=true`; default archives
  the old chat and hands off the transcript). Voice can fork a chat, set chat TTS
  read-aloud (`off`/`final`/`stream`), read the Live session cost, and end voice mode
  by saying so (`end_voice_mode` — not `stop_agent`).
- Voice Live panel has a **Commands** toggle with example spoken phrases
  (chat, workspace, agent, session), kept in sync with the server-pinned tools.
- Release process documented in [docs/RELEASING.md](docs/RELEASING.md) (SemVer,
  Unreleased freeze, and `v*` GitHub tags).

### Fixed
- Codex Plan mode no longer aborts on read-only shell (`ls`, `rg`, `cat`,
  `git status`). It still blocks writes, `edit`, and mutating commands.
- OpenCode session errors (e.g. missing payment method) now show once as an
  error block, instead of a fake Answer plus Error plus a duplicate notice.
- Chat no longer duplicates the last **Answer** bubble after a WS hello/reconnect
  mid-reply. The live assistant block is reused the same way as Thinking.
- PWA again shows **A new version is available** after a webpack rebuild (or a
  waiting service worker). Standalone mode cannot pull-to-refresh, so the banner
  is the reload path; `/__webpack_hmr` is no longer intercepted by the worker.
- Deleting a chat on one device no longer loops `sdkError` / “SDK chat not
  found” on another device that still had it open. The other client stops
  reconnecting and closes the chat locally.
- Mobile/PWA send bar stays in the chat layout (`position: sticky`) instead of
  `position: fixed` inside an `overflow: hidden` panel.
- Saving Chat settings from a non-Chat tab no longer hides the send bar.
  WebKit reported the hidden "Show send field" checkbox as unchecked and wrote
  that to localStorage (`cretli-chat-show-send-field=false`). Existing clients
  ignore that legacy value; hiding the bar now requires an explicit new flag.
- Forked / harness-switch chats no longer paste the inherited transcript
  a second time as one giant user message. The new agent still gets the
  full context; the UI shows a short continuation line.
- Folder picker in Settings → Workspace no longer stays on "Loading…" (Lit
  did not re-render after `/api/fs/entries`). `~` opens the login home, not
  the worktree sandbox `data/runtime-home`; a missing typed path walks up to
  the nearest existing folder.
- Sidebar chat delete shows the same confirmation dialog as the chat menu (the
  modal lived inside `#chat-panel`, so it stayed hidden when another tab was
  active or the drawer covered it).
- Todo status changes persist (`detail.status`); `ready` is labeled as ready to start, not done.
- Agent finish-summary `{"title":…}` JSON is stripped from Todo history.
- Starting an agent from Todo no longer forces Cursor SDK when the task came from OpenCode or OpenRouter.
- The attachment menu no longer shows the "Pick page element" entry in the
  standalone app (page-element picking only works inside the embedded widget),
  instead of rendering it disabled with a "(widget only)" suffix.

### Changed
- **Analyze current agent** opens the same new-chat modal as Fork (folder,
  harness, model) instead of a browser prompt, so the diagnosis can run on a
  different harness. The new agent gets an analysis prompt, not a task handoff.
- Settings → **App** uses sub-tabs like Harness: Appearance, Terminal, Voice,
  and Storage. `/settings/browser` still opens Storage.
- Single env template [`.env.example`](.env.example); SDK key template is
  [`.cretli-sdk.env.example`](.cretli-sdk.env.example).
- npm workspaces: one `npm install` covers `app_front/` (`cretli-front`).
- Backend modules grouped into `lib/sdk/`, `lib/opencode/`, `lib/openrouter/`, `lib/persist/`, `lib/widget/`.
- `.cursor/rules/cretli-system.mdc` is a short English alwaysApply rule;
  full architecture stays in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Agent rules renamed to `cretli-*.mdc`; `npm test` runs every `tests/*.test.js`.
- API/WS errors that were hardcoded in Polish go through [lib/messages.js](lib/messages.js).

### Removed
- Internal launch checklist (`docs/LAUNCH.md`).

## [0.2.0] - 2026-08-26

### Added
- Public product name **Cretli**; OpenCode, OpenRouter, and Cursor SDK documented as
  equal chat backends.
- `NOTICE` and trademark disclaimer (not affiliated with Anysphere/Cursor).
- LAN first-run guard: bind beyond localhost without a password requires
  `CRETLI_SETUP_TOKEN` (server refuses to start otherwise).
- Settings harness wizard showing which backends are installed and configured.
- Login setup-token field when LAN setup is required.
- Dockerfile, `docker-compose.yml`, [docs/INSTALL.md](docs/INSTALL.md),
  and [website/index.html](website/index.html).
- CI job that uninstalls `@cursor/sdk` and runs `test:without-cursor-sdk`.
- Issue forms with a harness dropdown; good-first-issue template.

### Changed
- Default bind is **127.0.0.1** in code (matches README/SECURITY). Use
  `npm run start:lan` / `CRETLI_BIND=0.0.0.0` for LAN.
- `@cursor/sdk` moved to `optionalDependencies`.
- Package name `cretli`, repository URLs `github.com/cretli/cretli`, version `0.2.0`.
- Runtime fallbacks no longer use maintainer home paths; examples use TEST-NET
  (`192.0.2.10`).
- Public docs are English; widget panel strings are i18n.

### Removed
- Internal Polish planning notes from `docs/` (Obsidian mirrors, SDK phase TODOs).
- Maintainer-only push command details (SSH key paths).

## [0.1.0] - 2026-07-02

### Added
- First public release as open source (MIT).
- Password authentication (scrypt-hashed, signed `HttpOnly` session cookie) with a
  `/login` setup/login page; default bind to `127.0.0.1`.
- [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [.env.example](.env.example),
  GitHub issue/PR templates and CI workflow.
- `docs/ARCHITECTURE.md` (English) describing HTTP/WS, shared sessions and HMR.
- Umbrella `npm test` script.

### Changed
- Server binds to `127.0.0.1` by default; LAN exposure is opt-in via
  `CURSOR_REMOTE_BIND=0.0.0.0`.
- Agent callback endpoints (`/api/set-*-from-agent`) require `AGENT_CALLBACK_TOKEN` when
  the server is exposed on a non-localhost bind.
- File endpoints (`/api/files/entries`, `/api/files/read`) resolve symlinks via
  `realpathSync` to prevent path traversal.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS
  on HTTPS) and global `uncaughtException`/`unhandledRejection` handlers.
- README rewritten in English.

### Removed
- Internal-only documentation (`DOCS/`), G-Mode agents/rules/scratchpad, private dev
  plans, and one-shot migration scripts.
- Build artifacts (`public/dist/`) from git tracking (now gitignored).

[Unreleased]: https://github.com/cretli/cretli/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cretli/cretli/releases/tag/v0.3.0
[0.2.0]: https://github.com/cretli/cretli/releases/tag/v0.2.0
[0.1.0]: https://github.com/cretli/cretli/releases/tag/v0.1.0
