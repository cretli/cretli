/**
 * Size-capped rotation helpers for redirected server logs in `data/`.
 *
 * Two strategies are provided:
 * - `rotateLogIfNeeded` renames the current file aside. Use it only when no
 *   process holds the file open (for example after the old server is verified
 *   gone).
 * - `copyTruncateLog` copies the current content to `x.log.1` and then
 *   truncates the live file. Use it only for a file a live process holds open
 *   with `O_APPEND`: after truncation those writes land at the new end, but
 *   lines written between the copy and the truncate can be lost.
 *
 * Archive shifting is a sequence of renames, so a single rotator is assumed per
 * file; concurrent rotations of the same file are not supported.
 */

import {
  copyFileSync,
  existsSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'fs';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 3;

const nodeFsOps = {
  copyFileSync,
  existsSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
};

/**
 * @param {string} filePath
 * @param {number} index
 * @returns {string}
 */
function archivePath(filePath, index) {
  return `${filePath}.${index}`;
}

/**
 * Removes a path, ignoring a missing file. Any other failure (for example a
 * directory occupying the archive name) propagates so the rotation aborts with
 * a warning instead of dropping data.
 *
 * @param {typeof nodeFsOps} fsOps
 * @param {string} targetPath
 */
function removePath(fsOps, targetPath) {
  try {
    fsOps.unlinkSync(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Shifts `x.log.1` -> `.2` -> ... and drops the oldest archive, leaving room
 * for the current file to become `x.log.1`.
 *
 * @param {typeof nodeFsOps} fsOps
 * @param {string} filePath
 * @param {number} keep
 */
function shiftArchives(fsOps, filePath, keep) {
  removePath(fsOps, archivePath(filePath, keep));
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = archivePath(filePath, index);
    if (fsOps.existsSync(from)) fsOps.renameSync(from, archivePath(filePath, index + 1));
  }
}

/**
 * Missing file is a no-op; a stat failure on an existing file propagates to the
 * caller so it can warn.
 *
 * @param {typeof nodeFsOps} fsOps
 * @param {string} filePath
 * @returns {number | null}
 */
function readSizeOrNull(fsOps, filePath) {
  if (!fsOps.existsSync(filePath)) return null;
  return fsOps.statSync(filePath).size;
}

/**
 * Builds a rotator. `overrides` injects filesystem operations for tests; in
 * production the Node `fs` functions are used.
 *
 * @param {Partial<typeof nodeFsOps>} [overrides]
 */
export function createLogRotator(overrides = {}) {
  const fsOps = { ...nodeFsOps, ...overrides };

  /**
   * Renames `filePath` aside when it exceeds `maxBytes`. Never throws: a failed
   * rotation warns and returns false.
   *
   * @param {string} filePath
   * @param {{ maxBytes?: number, keep?: number }} [options]
   * @returns {boolean} true when the file was rotated
   */
  function rotateLogIfNeeded(filePath, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
    try {
      const size = readSizeOrNull(fsOps, filePath);
      if (size === null || size <= maxBytes) return false;
      shiftArchives(fsOps, filePath, keep);
      fsOps.renameSync(filePath, archivePath(filePath, 1));
      return true;
    } catch (error) {
      console.warn('[log-rotate]', error?.message || error);
      return false;
    }
  }

  /**
   * Copies the current content to `x.log.1` and truncates the live file. Never
   * throws: a failed rotation warns and returns false.
   *
   * @param {string} filePath
   * @param {{ maxBytes?: number, keep?: number }} [options]
   * @returns {boolean} true when the file was rotated
   */
  function copyTruncateLog(filePath, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
    try {
      const size = readSizeOrNull(fsOps, filePath);
      if (size === null || size <= maxBytes) return false;
      shiftArchives(fsOps, filePath, keep);
      fsOps.copyFileSync(filePath, archivePath(filePath, 1));
      fsOps.truncateSync(filePath, 0);
      return true;
    } catch (error) {
      console.warn('[log-rotate]', error?.message || error);
      return false;
    }
  }

  return { rotateLogIfNeeded, copyTruncateLog };
}

const defaultRotator = createLogRotator();

export const rotateLogIfNeeded = defaultRotator.rotateLogIfNeeded;
export const copyTruncateLog = defaultRotator.copyTruncateLog;

/**
 * Decides whether a restart may rename the server log aside. `processGone` is
 * the verified old-PID check and `portFree` is the listener check. Rotation is
 * skipped unless both hold, so a writer that survived the stop never loses its
 * open file.
 *
 * @param {{ processGone: boolean, portFree?: boolean }} input
 * @returns {{ rotate: boolean, reason: string }}
 */
export function resolveRestartLogRotation({ processGone, portFree = true }) {
  if (!processGone) return { rotate: false, reason: 'old process still alive, log rotation skipped' };
  if (!portFree) return { rotate: false, reason: 'port 3011 still in use, log rotation skipped' };
  return { rotate: true, reason: '' };
}

/**
 * Reads a positive integer from an env map, falling back to a default for a
 * missing, non-numeric or non-positive value. Kept pure so the cap config can
 * be unit tested without touching `process.env`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function resolvePositiveIntEnv(env, name, fallback) {
  const parsed = Number.parseInt(String(env?.[name] ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Starts an unref'd interval timer that caps a live log file. Without a file
 * path the timer is not created (a plain `npm start` in a terminal is a no-op).
 * Bounds per file: `maxBytes` plus writes during one (possibly delayed) interval
 * plus the copy cost; at most `keep` archives plus the live file stay on disk.
 *
 * @param {string | undefined} filePath
 * @param {{ intervalMs?: number, maxBytes?: number, keep?: number, setIntervalFn?: typeof setInterval }} [options]
 * @returns {NodeJS.Timeout | null}
 */
export function startLogCapTimer(filePath, {
  intervalMs = 60_000,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  setIntervalFn = setInterval,
} = {}) {
  if (!filePath) return null;
  const timer = setIntervalFn(() => {
    copyTruncateLog(filePath, { maxBytes, keep });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
