# Frontend bundle serving

The server serves a **production** frontend bundle by default: minified, no
`eval-source-map`, Lit in production mode (no "Lit is in dev mode" warning).

| Bundle | Built by | Directory | Served when |
| --- | --- | --- | --- |
| production | `npm run build:front` / `npm run build:front:prod` (`webpack.prod.js`) | `public/dist/app` | default |
| development | `npm run watch:front` / `npm run build:dev -w cretli-front` (`webpack.dev.js`) | `public/dist/app-dev` | `CRETLI_FRONT_BUNDLE=dev` |

The browser URL is always `/dist/app/...`; the server maps it to the directory
above (`lib/front-bundle.js`). If the requested bundle was never built but the
other one exists, the server serves the other one and logs a warning, so a
checkout that only runs the dev watcher keeps working.

## Rollback

One flag restores the development bundle: start the server with
`CRETLI_FRONT_BUNDLE=dev` (unset it to return to production). No rebuild of the
production output is needed. Run `npm run watch:front` alongside for live
rebuilds; the PWA update banner and the hot fallback watch the served directory.

## Serving rules (`lib/dist-static.js`)

- Content negotiation: brotli (`br`), then gzip, using `node:zlib` only.
  Compressed bodies are cached in memory per file version (path, mtime, size),
  so brotli quality 11 is paid once. Files under 1 KiB are sent as is.
- `Vary: Accept-Encoding` and a weak `ETag` per encoding (304 on match).
- `Cache-Control`:
  - content-hashed files (lazy chunks `name.<hash8>.chunk.js`, hashed fonts):
    `public, max-age=31536000, immutable`
  - stable names (`index.bundle.js`, `vendor.bundle.js`, `*.css`, `i18n-pl.bundle.js`):
    `no-cache` (revalidate through the ETag)
  - development bundle: `no-store`

Entry and split-vendor files keep stable names because the static shells and
`public/sw.js` `SHELL_ASSETS` reference them; only lazy chunks are hashed.

## Lazy panels

Terminal, Tasks, Files, Git, GitHub, Browser, Instances, Tests and several
settings sections were already dynamic imports (`appShell/lazyPanelModules.js`).
The Decisions panel is now loaded from `bootApp.js` with a dynamic import
(chunk `panel-decisions`). Settings and Logs are wired into boot through many
`init*` calls and DOM lookups; splitting them is a follow-up.

## Service worker

`public/sw.js` `CACHE_NAME` was bumped to `cretli-v32` for the new layout, so
installed PWAs drop the old cache on activation and refetch the shell. Hashed
chunks are cached at runtime (`putInCache`); the old copy of a path is dropped
by `dropOtherVersions`.

## Measuring

```
node scripts/measure-front-first-load.mjs              # before (dev, gzip) vs after (prod, brotli)
node scripts/measure-front-first-load.mjs --no-browser # bytes only
node scripts/measure-front-first-load.mjs --json
```

Bytes are the initial JS and CSS actually sent for `/` with the real middleware.
When Playwright has a Chromium installed it also reports time to interactive on
an emulated phone (390x844, 4x CPU slowdown, 1.6 Mbit/s, 150 ms RTT) and whether
the Lit dev-mode warning appeared. Reference run (this repo, no browser):

```
dev  [gzip] 5477.8 KiB over 3 files; Lit dev-mode string in bundle: true
prod [br]    779.9 KiB over 3 files; Lit dev-mode string in bundle: false
ratio dev/prod: 7.0x fewer bytes (target >= 5x)
```
