// Pure lifecycle controller for the desktop shell. It never imports `electron`:
// everything platform specific is injected, so it is testable under plain node.
//
// Rules it enforces:
//  - closing the window only hides it (tray keeps the app alive); the backend,
//    managed or external, is untouched and does not depend on the window;
//  - the tray offers "Show window" and an explicit "Quit";
//  - Quit stops only app-owned processes (adapter.stop() decides; external is a no-op);
//  - a second launch focuses the existing instance instead of starting another backend;
//  - backend loss is detected (exit event or health polling) and recovered
//    (managed: bounded restart; external: wait until it answers again);
//  - after sleep/resume and on every window show the UI is refreshed.

export const BackendStatus = Object.freeze({ UP: 'up', DOWN: 'down', RESTARTING: 'restarting' });

export function createLifecycle({
  app, // { requestSingleInstanceLock, on, quit, exit }
  createWindow, // () => window (BrowserWindow-like)
  createTray, // ({ menu items, tooltip }) => tray handle { setStatus, destroy }
  powerMonitor, // EventEmitter-like with on('suspend'|'resume')
  backend, // adapter, see backend.js
  notify = () => {},
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  healthIntervalMs = 5000,
  maxRestarts = 3,
  restartDelayMs = 1000
}) {
  let window = null;
  let tray = null;
  let quitting = false;
  let quitPromise = null;
  let started = false;
  let status = BackendStatus.UP;
  let restarts = 0;
  let needsReload = false;
  let healthTimer = null;
  let healthBusy = false;

  const windowAlive = () => Boolean(window) && !window.isDestroyed?.();

  function setStatus(next) {
    if (status === next) return;
    const previous = status;
    status = next;
    tray?.setStatus?.(next);
    log(`backend ${previous} -> ${next}`);
    if (next === BackendStatus.DOWN) notify({ type: 'backend-down' });
    if (next === BackendStatus.UP && previous !== BackendStatus.UP) {
      // The page may have lost its socket while the server was away.
      needsReload = true;
      if (windowAlive() && window.isVisible?.()) refreshWindow();
    }
  }

  /** Reload when the page is stale, otherwise nudge the client to resync. */
  function refreshWindow() {
    if (!windowAlive()) return;
    const contents = window.webContents;
    if (needsReload) {
      needsReload = false;
      contents.reload();
    } else {
      // The web client listens for focus/visibility to refresh its state.
      void contents
        .executeJavaScript(
          "window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'))"
        )
        ?.catch?.(() => {});
    }
  }

  function attachWindow(win) {
    win.on('close', (event) => {
      if (quitting) return;
      // Hide to tray instead of destroying the window.
      event.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      if (window === win) window = null;
    });
  }

  function showWindow() {
    if (quitting) return;
    if (!windowAlive()) {
      window = createWindow();
      attachWindow(window);
      return;
    }
    if (window.isMinimized?.()) window.restore();
    window.show();
    window.focus();
    refreshWindow();
  }

  async function checkHealth() {
    if (quitting || healthBusy || status === BackendStatus.RESTARTING) return;
    healthBusy = true;
    try {
      const ok = await backend.check();
      if (quitting) return;
      if (ok) {
        restarts = 0;
        setStatus(BackendStatus.UP);
      } else if (backend.kind === 'managed') {
        await handleBackendLoss();
      } else {
        setStatus(BackendStatus.DOWN);
      }
    } catch {
      if (!quitting) setStatus(BackendStatus.DOWN);
    } finally {
      healthBusy = false;
    }
  }

  function scheduleHealth() {
    if (quitting) return;
    healthTimer = setTimer(async () => {
      await checkHealth();
      scheduleHealth();
    }, healthIntervalMs);
  }

  /** Managed backend died: restart a bounded number of times, then stay DOWN. */
  async function handleBackendLoss() {
    if (quitting || status === BackendStatus.RESTARTING) return;
    if (backend.kind !== 'managed') return setStatus(BackendStatus.DOWN);
    if (restarts >= maxRestarts) return setStatus(BackendStatus.DOWN);
    restarts += 1;
    setStatus(BackendStatus.RESTARTING);
    if (restartDelayMs > 0) await new Promise((resolve) => setTimer(resolve, restartDelayMs));
    if (quitting) return;
    try {
      await backend.start();
      const ok = await backend.check();
      setStatus(ok ? BackendStatus.UP : BackendStatus.DOWN);
    } catch (err) {
      log(`backend restart failed: ${err?.message || err}`);
      setStatus(BackendStatus.DOWN);
    }
  }

  /** Explicit Quit: stop app-owned processes, then leave. Idempotent. */
  function quit() {
    if (quitPromise) return quitPromise;
    quitting = true;
    clearTimer(healthTimer);
    quitPromise = (async () => {
      try {
        await backend.stop();
      } catch (err) {
        log(`backend stop failed: ${err?.message || err}`);
      }
      try {
        tray?.destroy?.();
      } catch {}
      tray = null;
      if (windowAlive()) window.destroy();
      app.exit(0);
    })();
    return quitPromise;
  }

  async function start() {
    if (started) return true;
    // A second instance must not start another backend: hand over and exit.
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return false;
    }
    started = true;
    app.on('second-instance', () => showWindow());
    // The tray keeps the process alive after the last window is hidden/closed.
    app.on('window-all-closed', () => {});
    // Any quit path (dock, OS shutdown, app.quit) goes through the controlled stop.
    app.on('before-quit', (event) => {
      // Always prevent: a second app.quit() while stop() is pending must not
      // terminate the app early; exit happens only via the controlled app.exit().
      event.preventDefault();
      void quit();
    });
    powerMonitor?.on('suspend', () => {
      log('system suspend');
      needsReload = true;
    });
    powerMonitor?.on('resume', () => {
      log('system resume');
      needsReload = true;
      // Give the network a moment, then verify the backend and refresh the page.
      setTimer(async () => {
        if (quitting) return;
        await checkHealth();
        if (windowAlive() && window.isVisible?.() && status === BackendStatus.UP) refreshWindow();
      }, 1000);
    });
    backend.onExit?.(({ code, signal }) => {
      log(`backend exited code=${code} signal=${signal}`);
      void handleBackendLoss();
    });
    try {
      await backend.start();
    } catch (err) {
      log(`backend start failed: ${err?.message || err}`);
      status = BackendStatus.DOWN;
    }
    tray = createTray({ onShow: showWindow, onQuit: quit, status });
    showWindow();
    scheduleHealth();
    return true;
  }

  return {
    start,
    showWindow,
    quit,
    handleBackendLoss,
    checkHealth,
    getStatus: () => status
  };
}
