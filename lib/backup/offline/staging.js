/**
 * Private plaintext staging for encrypted backups (B5).
 *
 * Decrypted/unpacked material and the plaintext archive built before encryption live ONLY under
 * `<controlDir>/staging/<id>/`, created owner-only (0700 dir, 0600 files). Cretli does not encrypt
 * the disk: the staging area relies on host disk protection (full-disk encryption, a private user
 * account). Every operation removes its own directory in a `finally`; whatever a crash leaves
 * behind is swept by `cleanupStaging` the next time the exclusive lease is held (CLI commands and
 * startup recovery), except the directory an in-progress restore journal still needs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OfflineDataError } from './offline-errors.js';

/** A staging directory older than this is reported as stale-leftover in `describeStaging`. */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} controlDir
 * @returns {string}
 */
export function stagingRoot(controlDir) {
  return path.join(controlDir, 'staging');
}

/**
 * Create a fresh owner-only staging directory and verify its permissions.
 *
 * @param {string} controlDir
 * @param {string} [label]
 * @returns {string} absolute directory path
 */
export function createStagingDir(controlDir, label = 'op') {
  const root = stagingRoot(controlDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${label.replace(/[^a-z0-9-]/gi, '')}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  assertPrivateDir(root);
  assertPrivateDir(dir);
  return dir;
}

/**
 * Refuse a staging directory that other users could read (POSIX only; Windows has no mode bits).
 *
 * @param {string} dir
 */
export function assertPrivateDir(dir) {
  if (process.platform === 'win32') return;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new OfflineDataError('STAGING_UNSAFE', `staging path is not a plain directory: ${dir}`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new OfflineDataError('STAGING_UNSAFE', `staging directory is owned by another user: ${dir}`);
  }
  if ((st.mode & 0o077) !== 0) {
    try { fs.chmodSync(dir, 0o700); } catch { /* verified below */ }
    if ((fs.lstatSync(dir).mode & 0o077) !== 0) {
      throw new OfflineDataError('STAGING_UNSAFE', `staging directory is accessible to other users: ${dir}`);
    }
  }
}

/**
 * Best-effort removal; a plaintext leftover that cannot be removed is reported to stderr by path
 * only (never content) so the operator can delete it.
 *
 * @param {string} dir
 */
export function removeStagingDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`warning: could not remove plaintext staging ${dir}: ${/** @type {any} */ (err).code || 'error'}\n`);
  }
}

/**
 * Staging directories currently present.
 *
 * @param {string} controlDir
 * @returns {{ dir: string, ageMs: number }[]}
 */
export function describeStaging(controlDir) {
  const root = stagingRoot(controlDir);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const now = Date.now();
  return names.map((name) => {
    const dir = path.join(root, name);
    let ageMs = 0;
    try { ageMs = now - fs.lstatSync(dir).mtimeMs; } catch { /* vanished */ }
    return { dir, ageMs };
  });
}

/**
 * Sweep crash leftovers. MUST be called while holding the exclusive lease (nothing else can be
 * using a staging directory then). `keep` lists directories an in-progress restore still needs.
 *
 * @param {string} controlDir
 * @param {{ keep?: string[] }} [options]
 * @returns {string[]} removed directories
 */
export function cleanupStaging(controlDir, options = {}) {
  const keep = new Set((options.keep || []).filter(Boolean).map((p) => path.resolve(p)));
  const removed = [];
  for (const { dir } of describeStaging(controlDir)) {
    if ([...keep].some((k) => k === dir || k.startsWith(`${dir}${path.sep}`))) continue;
    removeStagingDir(dir);
    removed.push(dir);
  }
  return removed;
}
