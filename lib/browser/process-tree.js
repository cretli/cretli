/**
 * Best-effort process-tree termination for the Chromium spawned by Playwright.
 *
 * Playwright's `browser.close()` is normally enough, but a wedged renderer or a
 * driver that ignores the graceful close must not keep the Node process alive.
 * These helpers are intentionally dependency-free and never throw.
 */

import { execFile } from 'child_process';
import { readFileSync, readdirSync } from 'fs';

/**
 * Returns the PIDs of the direct children of `pid` (Linux only). Used to attach
 * the spawned Chromium process to the session so it can be killed as a tree
 * even though Playwright's public `Browser` API does not expose the process.
 * @param {number} [pid]
 * @returns {number[]}
 */
export function readChildPids(pid = process.pid) {
  if (process.platform !== 'linux') return [];
  const childrenFile = `/proc/${pid}/task/${pid}/children`;
  try {
    const raw = readFileSync(childrenFile, 'utf8').trim();
    if (!raw) return [];
    return raw.split(/\s+/).map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/**
 * Recursively collects the process tree rooted at `pid` (Linux only).
 * @param {number} pid
 * @returns {number[]} PIDs including `pid` itself.
 */
export function collectProcessTree(pid) {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 0) return [];
  if (process.platform !== 'linux') return [root];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(`/proc/${current}/task`);
    } catch {
      entries = [];
    }
    for (const task of entries) {
      try {
        const raw = readFileSync(`/proc/${current}/task/${task}/children`, 'utf8').trim();
        for (const child of raw ? raw.split(/\s+/) : []) {
          const childPid = Number.parseInt(child, 10);
          if (Number.isInteger(childPid) && childPid > 0 && !seen.has(childPid)) {
            seen.add(childPid);
            queue.push(childPid);
          }
        }
      } catch {
        // process may have exited between reads
      }
    }
  }
  return [...seen];
}

/**
 * Kills a process tree. On POSIX it first tries the process group (negative
 * PID), then every known descendant, then the root; on Windows it delegates to
 * `taskkill /T /F`. Never throws.
 * @param {unknown} pid
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean} true when at least one kill signal was sent
 */
export function killProcessTree(pid, signal = 'SIGKILL') {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 1) return false;
  let sent = false;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(root), '/T', '/F'], () => {});
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-root, signal);
    sent = true;
  } catch {
    // not a process-group leader; fall through to per-pid kills
  }
  const tree = collectProcessTree(root).sort((a, b) => b - a); // children first
  for (const target of tree) {
    try {
      process.kill(target, signal);
      sent = true;
    } catch {
      // already gone
    }
  }
  return sent;
}
