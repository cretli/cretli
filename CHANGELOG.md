# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
