import { closeSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { resolveServedFrontBundle } from './front-bundle.js';
import { getProcessStartTime, isProcessAlive } from './delegation-owner-lock.js';
import { resolveDataPath, resolveProjectPath } from './runtime-paths.js';
import {
  getWebpackCliWatchLockPath,
  isWebpackCliWatchLockHeld,
  lockIdForWebpackConfig,
  readWebpackCliWatchLock,
  resolveWebpackConfigRealpath,
} from './webpack-cli-watch-lock.js';

/** Lock file serializing builds that write into public/dist (a dev watcher and a prod build must not race). */
export function getDistBuildLockPath() {
  return resolveDataPath('dist-build.lock');
}

/**
 * @param {{ pid?: number, pidStart?: string } | null} record
 * @returns {boolean} true when the recorded holder is gone (dead pid or recycled pid)
 */
export function isDistBuildLockStale(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return true;
  if (!isProcessAlive(record.pid)) return true;
  const start = getProcessStartTime(record.pid);
  return Boolean(record.pidStart && start && record.pidStart !== start);
}

/**
 * Take the public/dist build lock (O_EXCL create, stale holders are recovered).
 * @param {string} label what is building, shown to a rejected second requester
 * @param {{ lockPath?: string, pid?: number }} [options]
 * @returns {{ acquired: true, release: () => void } | { acquired: false, detail: string }}
 */
export function tryAcquireDistBuildLock(label, options = {}) {
  const lockPath = options.lockPath || getDistBuildLockPath();
  const pid = options.pid || process.pid;
  const record = { pid, pidStart: getProcessStartTime(pid), label, startedAt: new Date().toISOString() };
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
      return {
        acquired: true,
        release: () => {
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8'));
            if (current?.pid === pid && current?.startedAt === record.startedAt) unlinkSync(lockPath);
          } catch (_) {}
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch (_) {}
    if (!isDistBuildLockStale(holder)) {
      return {
        acquired: false,
        detail: `Another front build ("${holder?.label || 'unknown'}", pid ${holder?.pid}) already writes to public/dist. Wait for it to finish.`,
      };
    }
    try {
      unlinkSync(lockPath);
    } catch (_) {}
  }
  return { acquired: false, detail: 'Could not take the public/dist build lock.' };
}

/**
 * Warn when the served bundle is a dev build (eval-source-map) and no dev watcher owns the output.
 * @param {string} [bundlePath]
 * @returns {string|null} the warning, or null when fine
 */
export function detectStaleDevBundle(bundlePath = path.join(resolveServedFrontBundle({ publicDir: resolveProjectPath('public') }).dir, 'index.bundle.js')) {
  try {
    const fd = openSync(bundlePath, 'r');
    let head = '';
    try {
      const buf = Buffer.alloc(4096);
      head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
    if (!/eval-source-map|\beval\(/.test(head)) return null;
    const configRealpath = resolveWebpackConfigRealpath('webpack.dev.js', resolveProjectPath('app_front'));
    const lockPath = getWebpackCliWatchLockPath(lockIdForWebpackConfig(configRealpath));
    if (isWebpackCliWatchLockHeld(readWebpackCliWatchLock(lockPath))) return null;
    return `${bundlePath} looks like a dev build (eval-source-map) but no watch:front watcher is running; rebuild with "npm run build:front".`;
  } catch (_) {
    return null;
  }
}
