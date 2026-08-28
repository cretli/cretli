# Contributing to Cretli

Thanks for considering a contribution. Keep PRs focused. Public docs, issues, and
code comments are **English**. The UI has optional Polish strings in `app_front/i18n/`.
This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Setup

```bash
git clone https://github.com/cretli/cretli.git
cd cretli
npm install
npm run build:front:prod
npm start
```

Open `https://localhost:3011`, set the password at `/login`.

`@cursor/sdk` is an **optional** dependency. OpenCode and OpenRouter chats work without it.
Cursor SDK tests that need the package skip or fail closed when it is missing
(`npm run test:without-cursor-sdk`).

## Where to look (do not boil the ocean)

| Area | Path | Notes |
|------|------|--------|
| HTTP bootstrap | `server.js` | Keep changes small; prefer `lib/routes/` |
| Domain modules | `lib/` | App services at top level; grouped folders below |
| Chat WS protocol | `lib/sdk/` | Shared by all three harnesses despite the `sdk-` prefix; `cursor-agent-sdk-ws.js` is large, add helpers rather than growing it |
| OpenCode | `lib/opencode/`, `lib/agent-harness/` | WS room + `opencode serve` manager |
| OpenRouter | `lib/openrouter/`, `lib/agent-harness/` | |
| Persist | `lib/persist/` | chats, history, settings, todos |
| Widget | `lib/widget/` | CORS, installations, page URL |
| SPA orchestrator | `app_front/chat.js` | Large orchestrator — new features go in `app_front/features/` |
| UI primitives | `app_front/components/ui/` | Lit + `var(--cr-*)` tokens |
| Tests | `tests/` | Add a regression test with the change |

Do **not** start a PR whose only goal is splitting `chat.js` or `app.scss` unless
maintainers asked for that epic.

### New chat logic goes to `app_front/features/chat/`

`chat.js` is ~5700 lines and holds around 35 module-level state variables, with
`activeChatId` threaded through almost all of them, and it has no unit tests. Treat it
as a wiring layer that is frozen in size: when you add chat behaviour, put the logic in
a module under `app_front/features/chat/` (view, controller, history, HTML helpers are
already there), export a small function, and call it from `chat.js`. Feature modules are
testable in isolation — `chat.js` is not. The same rule applies on the send bar
(`app_front/features/sendBar/`) and the sidebar (`app_front/features/sidebar/`).

## Good first issues

These are usually reviewable without the full chat stack:

- Docs / typos in README, INSTALL, ARCHITECTURE
- i18n keys (add English + Polish together)
- Docker / install cookbook improvements
- Small UI bugs with a screenshot
- Tests for a parser or persist helper in `tests/`

Label suggestions for maintainers: `good first issue`, `docs`, `harness:opencode`,
`harness:openrouter`, `harness:sdk`.

## Development workflow

- Frontend: `app_front/` workspace (`cretli-front`) → `public/dist/` (gitignored). Dev HMR runs through Express.
- Backend: restart after `lib/` / `server.js` changes (or `/api/dev-actions` `restart-server`).
- Tests: `npm test` runs every `tests/*.test.js` in its own process against a throwaway
  data directory (`CRETLI_DATA_DIR`), so it never touches your own chats or settings.
- `npm run lint` must pass — lint failures block CI.
- Do not commit `public/dist/`, `data/`, or secrets.

## Before opening a PR

1. `npm test` passes.
2. `npm run build:front:prod` succeeds.
3. No private paths, keys, or internal notes in the diff.
4. Update [CHANGELOG.md](CHANGELOG.md) under "Unreleased" if the change is user-facing.
5. New files: English comments, guard clauses, no `any`-style sloppiness.

## Security

Do not open public issues for security problems — see [SECURITY.md](SECURITY.md).
