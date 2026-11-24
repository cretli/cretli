import { spawn as spawnProcess } from 'node:child_process';

// Backend adapters used by the lifecycle module.
//
// Adapter contract (all methods may be sync or async):
//   kind        'external' | 'managed'
//   owned       true only when this app spawned the process (and must stop it)
//   start()     make the backend available; must be idempotent
//   stop()      stop ONLY what the app owns; external adapters never kill anything
//   check()     resolves true when the backend answers (health probe)
//   onExit(cb)  register cb({ code, signal }) for an unexpected process exit
//               (external adapters never fire it; health polling covers them)

/** Adapter for a server started independently of the app (e.g. `npm start`). */
export function createExternalBackend({ url, fetchImpl = globalThis.fetch, timeoutMs = 3000 }) {
  return {
    kind: 'external',
    owned: false,
    async start() {},
    // Never stops the external server: it outlives the app.
    async stop() {},
    async check() {
      try {
        const res = await fetchImpl(new URL('/api/settings', url).href, {
          signal: AbortSignal.timeout(timeoutMs)
        });
        // Any HTTP answer (even 401) proves the server process is alive.
        return Boolean(res);
      } catch {
        return false;
      }
    },
    onExit() {}
  };
}

/**
 * Default tree-termination strategy. `force=false` asks for a graceful stop,
 * `force=true` must kill the whole tree. May return a promise that settles when
 * the kill helper finished (stop() awaits it).
 *  - POSIX: the child is spawned detached (own process group), so a negative pid
 *    signals the group: SIGTERM first, SIGKILL when forced.
 *  - Windows: never `proc.kill()` first (it would kill only the parent and the
 *    later tree kill would target a dead PID). Graceful = `taskkill /pid <pid> /T`,
 *    forced = `taskkill /pid <pid> /T /F`, both run while the parent is alive.
 *    The promise resolves when taskkill exits or errors, bounded by `timeoutMs`.
 */
export function defaultKillTree(
  proc,
  {
    force = false,
    platform = process.platform,
    spawnImpl = spawnProcess,
    timeoutMs = 5000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}
) {
  const pid = proc?.pid;
  if (!pid) return proc?.kill?.(force ? 'SIGKILL' : 'SIGTERM');
  if (platform === 'win32') {
    const args = ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        clearTimer(timer);
        resolve();
      };
      timer = setTimer(finish, timeoutMs);
      try {
        const killer = spawnImpl('taskkill', args, { stdio: 'ignore' });
        killer.once('exit', finish);
        killer.once('error', finish);
      } catch {
        finish();
      }
    });
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    // ESRCH: group already gone. Anything else: fall back to the direct child.
    if (err?.code !== 'ESRCH') proc.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
  return undefined;
}

/**
 * Adapter for a backend spawned by the app. `spawn` is injected (child_process.spawn
 * compatible) so 1.4 can supply the real command and tests a fake. Start is
 * idempotent: a second call while the child is alive never spawns a duplicate.
 * `killTree(proc, { force })` is injectable (may return a promise); stop()
 * escalates graceful -> forced and ALWAYS resolves (exit, spawn error, kill
 * failure or timeouts). `platform` and `spawnTaskkill` are injectable for tests.
 */
export function createManagedBackend({
  spawn,
  command,
  args = [],
  options = {},
  check = async () => true,
  killTimeoutMs = 5000,
  platform = process.platform,
  spawnTaskkill = spawnProcess,
  killTree,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const kill =
    killTree ??
    ((proc, { force }) =>
      defaultKillTree(proc, {
        force,
        platform,
        spawnImpl: spawnTaskkill,
        timeoutMs: killTimeoutMs,
        setTimer,
        clearTimer
      }));
  let child = null;
  const exitListeners = [];
  let stopping = false;
  // Never throws; resolves true when the kill helper ran, false when it failed.
  const safeKill = async (proc, force) => {
    try {
      await kill(proc, { force });
      return true;
    } catch {
      return false;
    }
  };

  function start() {
    if (child) return;
    // Detached on POSIX so the child leads its own group and the tree can be signalled.
    const spawnOptions = platform === 'win32' ? options : { detached: true, ...options };
    const proc = spawn(command, args, spawnOptions);
    child = proc;
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null;
      if (!stopping) for (const cb of exitListeners) cb({ code, signal });
    });
    proc.once('error', () => {
      if (child === proc) {
        child = null;
        if (!stopping) for (const cb of exitListeners) cb({ code: null, signal: null });
      }
    });
  }

  async function stop() {
    const proc = child;
    if (!proc) return;
    stopping = true;
    let exited = false;
    let wake = null;
    const onGone = () => {
      exited = true;
      wake?.();
    };
    proc.once('exit', onGone);
    proc.once('error', onGone);
    // Resolves when the process is gone or the grace period elapsed.
    const waitGone = () =>
      exited
        ? Promise.resolve()
        : new Promise((resolve) => {
            const timer = setTimer(() => {
              wake = null;
              resolve();
            }, killTimeoutMs);
            wake = () => {
              clearTimer(timer);
              wake = null;
              resolve();
            };
          });
    let forced = false;
    try {
      // Graceful tree kill while the parent is still alive.
      // A failed kill call is not worth waiting out: escalate (or give up) at once.
      if (await safeKill(proc, false)) await waitGone();
      if (!exited) {
        forced = true;
        if (await safeKill(proc, true)) await waitGone();
      }
      // POSIX: the leader may be gone while descendants linger in the group, so
      // sweep it once more. Windows: the tree was already killed while the parent
      // was alive; taskkill on a dead PID cannot find descendants, so skip.
      if (!forced && platform !== 'win32') await safeKill(proc, true);
    } finally {
      if (child === proc) child = null;
      stopping = false;
    }
  }

  return {
    kind: 'managed',
    get owned() {
      return child !== null;
    },
    start,
    stop,
    check: () => (child ? check() : false),
    onExit(cb) {
      exitListeners.push(cb);
    }
  };
}
