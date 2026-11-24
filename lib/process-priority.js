/**
 * Best-effort OS scheduling priority for background child processes (agent,
 * verify and test runners), so the interactive HTTP/WS process keeps its CPU
 * share under load. Never throws: a missing permission or platform support
 * simply leaves the priority unchanged. Throughput is not capped — only the
 * relative scheduling weight changes.
 */
import os from 'node:os';

/** Default niceness for background children (0 = normal, 19 = lowest). */
export const BACKGROUND_NICE = 10;

/**
 * Lower the priority of a spawned process.
 *
 * @param {number | undefined} pid
 * @param {{ nice?: number, setPriority?: (pid: number, nice: number) => void }} [options]
 * @returns {boolean} true when the priority was applied
 */
export function applyBackgroundPriority(pid, options = {}) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return false;
  if (process.platform === 'win32' && !options.setPriority) return false;
  const raw = Number(options.nice ?? process.env.CRETLI_BACKGROUND_NICE ?? BACKGROUND_NICE);
  if (!Number.isFinite(raw)) return false;
  const nice = Math.max(0, Math.min(19, Math.trunc(raw)));
  if (nice === 0) return false;
  try {
    (options.setPriority || os.setPriority)(/** @type {number} */ (pid), nice);
    return true;
  } catch {
    return false;
  }
}
