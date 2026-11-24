# Cretli desktop window

This minimal Electron shell displays the existing Cretli server UI. It does not
copy `app_front/` or start the backend. Backend process startup and the
installer/runtime environment are delivered by task 1.4.

## Install and run

`electron` is deliberately **not** a dependency of the root package. It lives in
this separate package with its own `node_modules` (covered by the root
`.gitignore`) and its own lockfile, like `optional-packages/claude-agent-sdk`.

```sh
cd desktop
npm install          # one-time; creates desktop/node_modules and desktop/package-lock.json
npm start            # opens the window
```

Run the Cretli server separately first. The window opens `http://127.0.0.1:3011` by
default (Cretli's default port; start the server with `USE_HTTPS=0`). Set
`CRETLI_URL` for another URL, e.g. `https://localhost:3011` when the server
runs with HTTPS (a self-signed certificate is rejected, never bypassed).

During frontend development use the project's `npm run watch:front`; for a
packaged frontend use `npm run build:front`. The server never loads webpack.

## Tests

`tests/desktop-security.test.js` exercises the pure security helpers in
`desktop/lib/security.js`, which do not import `electron`, so the root test run
needs no Electron install:

```sh
node --test tests/desktop-security.test.js
```

## Security model

The renderer disables Node integration and enables context isolation and the
sandbox. Navigation stays on the configured origin. New windows are denied;
HTTP(S) destinations may be opened externally. The preload exposes only a
small frozen platform value. The preload is CommonJS (`preload.cjs`) as required by the sandbox.
Navigation, server redirects and subframe navigation are all origin-guarded.
No IPC handlers are registered; **all future IPC must be registered through
`guardedHandle(channel, handler)` in `main.js`**, which rejects senders outside
the configured origin (never call `ipcMain.handle` directly). TLS
certificate errors are not overridden, so Chromium rejects invalid
certificates by default.
