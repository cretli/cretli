# Contributing to Cretli

Thanks for considering a contribution. Keep PRs focused. Public docs, issues, and
code comments are **English**. The UI has optional Polish strings in `app_front/i18n/`.
This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Setup

Cretli needs **Node >= 22.18** (`engines.node` in `package.json`; `node:sqlite`). The repo ships an
`.nvmrc`, so run `nvm use` in the repo root before `npm install`. `npm test` exits early with a
clear message on older Node.

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

## New files are TypeScript

Write **new server files in `.ts`** (`lib/`, `harnesses/`, `scripts/`), not `.js`. Node >= 22.18
strips types natively, so there is no build step: use erasable syntax only (type annotations,
`type`, `interface`, `declare`; no `enum`, `namespace` or constructor parameter properties, which
`erasableSyntaxOnly` rejects) and import with the real extension (`from './foo.ts'`). Existing
`.js` files are converted gradually; do not rename a module that `app_front` or
`harnesses/*/front.js` imports until the front build has a TypeScript loader (plan A4). Shared
types for the server and the front live in `lib/shared-types/`. `npm run typecheck` must stay
green (the per-file error ratchet only goes down).

### Lit reactive properties in `.ts`

In `app_front/**/*.ts`, every name listed in a Lit component's `static properties` must be
typed with `declare x: T;` and initialised in the constructor. A plain class field (`x = 1;`)
uses define semantics and shadows the accessor Lit installs, so the property silently stops
being reactive. `tests/lit-declare-fields.test.js` scans `app_front/**/*.ts` and fails on
violations.

## Where to look (do not boil the ocean)

| Area | Path | Notes |
|------|------|--------|
| HTTP bootstrap | `server.js` | Keep changes small; prefer `lib/routes/` |
| Domain modules | `lib/` | App services at top level; grouped folders below |
| Chat WS protocol | `lib/sdk/` | Shared by all three harnesses despite the `sdk-` prefix; `cursor-agent-sdk-ws.ts` is large, add helpers rather than growing it |
| OpenCode | `harnesses/opencode/` (plugin; `zai` and `mimo` depend on it) | WS room + `opencode serve` manager; shared pieces stay in core: `lib/process-probes.js`, `lib/approval/permission-classifier.ts` |
| OpenRouter | `lib/providers/openrouter/` (client), `harnesses/openrouter/` (chat plugin) | The client stays in core; only the chat harness is optional |
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

- Frontend: `app_front/` workspace (`cretli-front`) → `public/dist/` (gitignored). Dev rebuilds run through `npm run watch:front`.
- Backend: restart after `lib/` / `server.js` changes (or `/api/dev-actions` `restart-server`).
- Tests: `npm test` runs every `tests/*.test.js` in its own process against a throwaway
  data directory (`CRETLI_DATA_DIR`), so it never touches your own chats or settings.
- Parallel tests: `npm test -- --jobs N` (or `--jobs=N`, or `CRETLI_TEST_JOBS=N`) runs N test files
  at once. The default is `1`, which keeps the sequential run with one shared throwaway data
  directory and live output. With `N > 1` every file gets its own temporary `CRETLI_DATA_DIR`
  (removed when the file ends), the per-file timeout (`CRETLI_TEST_FILE_TIMEOUT_MS`) and exit codes
  behave as before, and each file's output is buffered and printed whole under its `==> name`
  header, so lines from different files never interleave. Files that share state outside their data
  directory (the repo tree, fixed or env-defaulted ports such as the sidebar DOM servers, wall-clock benchmarks) are listed in
  `SERIAL_ONLY_TEST_FILES` in `scripts/run-unit-tests.mjs` and run one at a time after the parallel
  pool; add a file there if it needs exclusivity. `--jobs` must be a positive integer. File names
  can still be passed after the flag, e.g. `npm test -- --jobs 4 foo.test.js bar.test.js`.
- Optional harness plugins: the runner also runs `harnesses/<id>/tests/*.test.js`. `npm run test:core` (`--core-only`) runs only `tests/`, `npm run test:plugins` (`--plugins-only`) only the plugin tests. CI runs them as the required jobs `core` (with `CRETLI_OPTIONAL_HARNESSES=` so no plugin loads at boot) and `optional` (default plugin set). A core test that needs a plugin loads it through `tests/helpers/default-optional-harnesses.js`.
- `npm run lint` must pass — lint failures block CI.
- Do not commit `public/dist/`, `data/`, or secrets.

## Before opening a PR

1. `npm test` passes (includes a scan of git-tracked files for live-looking tokens).
2. `npm run lint` passes.
3. `npm run build:front:prod` succeeds.
4. No private paths, keys, or internal notes in the diff.
5. Update [CHANGELOG.md](CHANGELOG.md) under "Unreleased" if the change is user-facing.
6. New files: English comments, guard clauses, no `any`-style sloppiness.

## Releases

Maintainers: version bumps, changelog freeze, and git tags are described in
[docs/RELEASING.md](docs/RELEASING.md).

## Security

Do not open public issues for security problems — see [SECURITY.md](SECURITY.md).
