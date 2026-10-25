/**
 * Deterministic post-integration step: rebuild the front when app_front/
 * changed and restart the server (once per batch) when lib/ changed.
 * Policy `autoRestart` is OFF by default; with it off nothing is executed.
 * All side effects go through injectable deps so the logic is unit-testable.
 */

export const DEFAULT_RESTART_WAIT_LIMIT_MS = 40 * 60 * 1000;
export const DEFAULT_POLL_MS = 5000;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * @param {{
 *   policy?: Record<string, any>, changedPaths?: string[], activeCycles?: number,
 *   elapsedMs?: number, limitMs?: number,
 * }} input
 * @returns {{ rebuildFront: boolean, restart: boolean, wait: boolean, timeout: boolean, reason: string }}
 */
export function decidePostIntegration(input = {}) {
  const out = { rebuildFront: false, restart: false, wait: false, timeout: false, reason: '' };
  if (input.policy?.autoRestart !== true) return { ...out, reason: 'auto_restart_disabled' };
  const paths = (input.changedPaths || []).map(norm);
  out.rebuildFront = paths.some((p) => p.startsWith('app_front/'));
  const libChanged = paths.some((p) => p.startsWith('lib/'));
  if (!libChanged) return { ...out, reason: out.rebuildFront ? 'front_changed' : 'no_relevant_changes' };
  const limit = Number.isFinite(input.limitMs) ? input.limitMs : DEFAULT_RESTART_WAIT_LIMIT_MS;
  const active = Number.isFinite(input.activeCycles) ? input.activeCycles : 1;
  if (active <= 0) return { ...out, restart: true, reason: 'lib_changed_idle' };
  if ((input.elapsedMs || 0) >= limit) return { ...out, timeout: true, reason: 'restart_wait_timeout' };
  return { ...out, wait: true, reason: 'waiting_for_active_cycles' };
}

/**
 * Coalescing runner: integrations call `record()`; one `flush()` handles the
 * accumulated batch with at most one build and one restart.
 * @param {{
 *   getPolicy: () => Record<string, any>,
 *   exec: (cmd: string, args: string[]) => Promise<{ ok: boolean }>,
 *   runtime: { block: () => any, unblock: () => any, activeCycles: () => { count: number, unavailable?: boolean } },
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   limitMs?: number, pollMs?: number,
 * }} deps
 */
export function createPostIntegrator(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pending = new Set();
  let flushing = null;

  function record(paths) {
    if (deps.getPolicy()?.autoRestart !== true) return false;
    for (const p of paths || []) pending.add(norm(p));
    return true;
  }

  async function run() {
    const policy = deps.getPolicy();
    const paths = [...pending];
    pending.clear();
    let d = decidePostIntegration({ policy, changedPaths: paths, activeCycles: 0, limitMs: deps.limitMs });
    const result = { rebuilt: false, restarted: false, reason: d.reason };
    if (d.rebuildFront) {
      const r = await deps.exec('npm', ['run', 'build:front']);
      result.rebuilt = r?.ok === true;
      if (!result.rebuilt) result.buildFailed = true;
    }
    if (!d.restart) return result;
    const start = now();
    let keepBlocked = false;
    try {
      try {
        deps.runtime.block();
      } catch (error) {
        // A failed block must never lead to a restart without the drain lock.
        result.reason = 'block_failed';
        result.blockError = error?.message || String(error);
        return result;
      }
      for (;;) {
        const a = deps.runtime.activeCycles();
        d = decidePostIntegration({
          policy, changedPaths: paths, limitMs: deps.limitMs,
          activeCycles: a.unavailable ? 1 : a.count, elapsedMs: now() - start,
        });
        if (!d.wait) break;
        await sleep(deps.pollMs ?? DEFAULT_POLL_MS);
      }
      result.reason = d.reason;
      if (d.restart) {
        const r = await deps.exec('bash', ['scripts/task-restart-server.sh']);
        result.restarted = r?.ok === true;
        if (!result.restarted) result.reason = 'restart_failed';
        // The new process releases the owned block at boot; unblocking here
        // would reopen starts in the old process before it is replaced.
        keepBlocked = result.restarted;
      }
    } finally {
      if (!keepBlocked) deps.runtime.unblock();
    }
    return result;
  }

  /** Drain loop: paths recorded during a run get their own pass (one restart per pass). */
  async function drain() {
    let last = null;
    while (pending.size > 0) {
      last = await run();
      // The process is being replaced and the owned block must stay; stop here.
      if (last.restarted) break;
    }
    return last || { rebuilt: false, restarted: false, reason: 'nothing_pending' };
  }

  /** Concurrent flushes share one drain; it re-runs until nothing is pending. */
  function flush() {
    if (!flushing) flushing = drain().finally(() => { flushing = null; });
    return flushing;
  }

  return { record, flush, pendingPaths: () => [...pending] };
}
