# Desktop tray and process lifecycle

Modules (none imports `electron`, except `main.js` which wires them):

- `lib/lifecycle.js` — pure controller with injected app / window / tray / power / backend.
- `lib/backend.js` — backend adapters: `createExternalBackend` (today) and
  `createManagedBackend` (spawn-based; task 1.4 supplies the real command).
- `lib/tray.js` — tray menu template and Electron tray wrapper.

## Behaviour

- **Close window** hides it to the tray. The backend, managed or external, keeps
  running; agents and the Android/LAN clients keep working because nothing in the
  backend depends on the window or its socket.
- **Tray**: click or "Show window" restores the existing window (never a second
  backend); "Quit" is the explicit exit. The tray also shows backend status.
- **Quit** (tray, or any `before-quit` path) calls `adapter.stop()` once and exits.
  The managed adapter terminates the child's whole process tree through an
  injectable `killTree`: on POSIX the child is spawned detached and its group gets
  SIGTERM, then SIGKILL after `killTimeoutMs`. On Windows `proc.kill()` is never
  called first (it would only kill the parent); the tree is terminated while the
  parent is still alive with `taskkill /pid <pid> /T`, escalating after the grace
  timeout to `taskkill /pid <pid> /T /F`. `stop()` awaits each taskkill run
  (it resolves when taskkill exits or errors, bounded by a timeout). `stop()` always resolves (exit, spawn
  error, kill failure or a final timeout), so Quit cannot hang. This is best
  effort: a descendant that deliberately leaves the group/tree (setsid, daemonizing)
  can still survive. The external adapter's `stop()` is a no-op, so an
  independently started server is never killed. Repeated `before-quit` events are
  all prevented while cleanup runs; exit only happens via `app.exit()`.
- **Second launch** is rejected by the single-instance lock and only focuses the
  running window, so the backend is never duplicated.
- **Backend failure**: a managed child exit triggers up to 3 restarts
  (`maxRestarts`), then the status stays DOWN. An external server is polled
  (`check()` every 5 s); when it answers again the window is reloaded.
  A failed start leaves the app running in DOWN state with the tray available.
- **Sleep / resume**: on `resume` the lifecycle waits 1 s, re-checks the backend
  and reloads the visible window so the client reconnects its socket.
  A hidden window is reloaded on its next show.
- **Window show** refreshes state: reload when the page is stale (after resume or
  backend recovery), otherwise it dispatches `focus`/`visibilitychange` so the web
  client resyncs.

## Hooking up the managed backend (1.4)

Replace `createExternalBackend` in `main.js` with `createManagedBackend({ spawn,
command, args, check })`. The lifecycle needs no change.

## Tests

```sh
node --test tests/desktop-lifecycle.test.js tests/desktop-security.test.js
```
