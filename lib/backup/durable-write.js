/**
 * Durable file publication: temp file -> fsync(file) -> atomic rename ->
 * fsync(directory) where the platform supports it.
 *
 * The result reports what was actually guaranteed. A failed file fsync or
 * rename throws (nothing is published, the temp file is removed). A directory
 * fsync that the platform cannot do (Windows, some network filesystems) is not
 * an error but is reported in `limitations` so callers never claim more than
 * was achieved.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class DurableWriteError extends Error {
  /**
   * @param {string} message
   * @param {string} stage
   * @param {unknown} [cause]
   */
  constructor(message, stage, cause) {
    super(message);
    this.name = 'DurableWriteError';
    this.code = 'DURABLE_WRITE_FAILED';
    this.stage = stage;
    if (cause) this.cause = cause;
  }
}

/** errno codes meaning "this platform cannot fsync a directory". */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'EACCES', 'EBADF']);

/**
 * @param {string} dir
 * @param {typeof fs} fsImpl
 * @returns {{ synced: boolean, limitation?: string }}
 */
function syncDirectory(dir, fsImpl) {
  let fd;
  try {
    fd = fsImpl.openSync(dir, 'r');
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (DIR_FSYNC_UNSUPPORTED.has(code) || process.platform === 'win32') {
      return { synced: false, limitation: `directory cannot be opened for fsync on this platform (${code || process.platform})` };
    }
    throw new DurableWriteError(`directory open failed: ${/** @type {any} */ (err)?.message}`, 'directory-open', err);
  }
  try {
    fsImpl.fsyncSync(fd);
    return { synced: true };
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (DIR_FSYNC_UNSUPPORTED.has(code)) {
      return { synced: false, limitation: `directory fsync is not supported here (${code})` };
    }
    throw new DurableWriteError(`directory fsync failed: ${/** @type {any} */ (err)?.message}`, 'directory-fsync', err);
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* best effort */ }
  }
}

/**
 * @param {string} filePath
 * @param {string | Buffer} data
 * @param {{ mode?: number, fsImpl?: typeof fs }} [options]
 * @returns {{ path: string, bytes: number, sha256: string, durability: { fileFsync: true, atomicRename: true, directoryFsync: boolean, platform: string, limitations: string[] } }}
 */
export function writeFileDurable(filePath, data, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const dir = path.dirname(filePath);
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new DurableWriteError(`cannot create directory: ${/** @type {any} */ (err)?.message}`, 'mkdir', err);
  }
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx', options.mode ?? 0o600);
    fsImpl.writeSync(fd, buffer, 0, buffer.length, 0);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* ignore */ }
    }
    try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
    throw new DurableWriteError(`file write failed: ${/** @type {any} */ (err)?.message}`, 'write', err);
  }
  try {
    fsImpl.renameSync(tmp, filePath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
    throw new DurableWriteError(`rename failed: ${/** @type {any} */ (err)?.message}`, 'rename', err);
  }
  const dirResult = syncDirectory(dir, fsImpl);
  const limitations = [];
  if (!dirResult.synced) limitations.push(dirResult.limitation || 'directory fsync unavailable');
  return {
    path: filePath,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    durability: {
      fileFsync: true,
      atomicRename: true,
      directoryFsync: dirResult.synced,
      platform: process.platform,
      limitations,
    },
  };
}

/**
 * Read a published file back and compare its digest with what was written.
 *
 * @param {string} filePath
 * @param {string} expectedSha256
 * @param {typeof fs} [fsImpl]
 * @returns {boolean}
 */
export function verifyFileDigest(filePath, expectedSha256, fsImpl = fs) {
  const raw = fsImpl.readFileSync(filePath);
  return crypto.createHash('sha256').update(raw).digest('hex') === expectedSha256;
}
