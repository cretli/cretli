# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Todo cards show which harness and chat created the task, with a link back to that chat.
- Todo plan section renders Markdown with the same preview as Files.

### Fixed
- Todo status changes persist (`detail.status`); `ready` is labeled as ready to start, not done.
- Agent finish-summary `{"title":…}` JSON is stripped from Todo history.
- Starting an agent from Todo no longer forces Cursor SDK when the task came from OpenCode or OpenRouter.

### Changed
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
