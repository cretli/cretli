/**
 * Filesystem guards and durable-write helpers of the offline history migration
 * tools (history-import.js, history-rollback.js). Nothing here is used by the
 * running server.
 *
 * Rules enforced for every path the tools touch:
 * - sources are only ever read; the tools never open them for writing;
 * - an output path must not exist, must sit in a real (non-symlink) directory
 *   and must be disjoint from every source;
 * - all output is written into a tool-owned `<output>.partial` directory with
 *   exclusive-create files, fsynced, and published by one directory rename.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { refuse } from './history-legacy-format.js';

/** Marker file that proves a `.partial` directory belongs to a migration tool. */
export const PARTIAL_MARKER_FILE = 'MIGRATION-INCOMPLETE.json';

/**
 * Resolve a path and refuse one whose real location differs from its spelling
 * (a symlink somewhere in the chain): the operator must name the real path.
 *
 * @param {string} input
 * @param {string} label
 * @returns {string} absolute real path
 */
export function resolveRealPath(input, label) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) refuse('path_invalid', `${label} path is invalid`, { label });
  const absolute = path.resolve(input);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return refuse('path_missing', `${label} path does not exist`, { label });
  }
  if (real !== absolute) refuse('path_symlink', `${label} path goes through a symlink; use the real path`, { label });
  return real;
}

/**
 * @param {string} input
 * @param {string} label
 * @returns {string} absolute real path of an existing directory
 */
export function assertRealDirectory(input, label) {
  const real = resolveRealPath(input, label);
  if (!fs.lstatSync(real).isDirectory()) refuse('path_not_directory', `${label} path is not a directory`, { label });
  return real;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true when one path equals or contains the other
 */
export function pathsOverlap(a, b) {
  const rel = path.relative(a, b);
  const inverse = path.relative(b, a);
  const inside = (value) => value === '' || (!value.startsWith('..') && !path.isAbsolute(value));
  return inside(rel) || inside(inverse);
}

/**
 * A migration work directory is scratch space the tool may rename or delete, so it must never sit
 * inside (or equal) a restore-managed path: a restore would replace it mid-migration.
 *
 * @param {string} workDir
 * @param {string[]} restorePaths absolute restore-managed paths
 * @returns {string} real path of the work directory
 */
export function assertWorkDirOutsideRestorePaths(workDir, restorePaths) {
  const real = assertRealDirectory(workDir, 'Work directory');
  for (const restorePath of restorePaths) {
    let base = path.resolve(restorePath);
    try {
      base = fs.realpathSync(base);
    } catch { /* a restore path that does not exist yet is compared as spelled */ }
    const rel = path.relative(base, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      refuse('workdir_in_restore_path', 'Work directory lies inside a restore path; choose a directory outside every restore path');
    }
  }
  return real;
}

/**
 * Validate an output location. The output and its `.partial` sibling are
 * created by the tool, so the output must not exist; its parent must be a real
 * directory and neither may overlap a source.
 *
 * @param {string} output
 * @param {string[]} sources absolute real source paths
 * @returns {{ output: string, partial: string, parent: string }}
 */
export function assertOutputPath(output, sources) {
  if (typeof output !== 'string' || !output.trim() || output.includes('\0')) refuse('path_invalid', 'Output path is invalid');
  const absolute = path.resolve(output);
  const parent = assertRealDirectory(path.dirname(absolute), 'Output parent');
  const resolved = path.join(parent, path.basename(absolute));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(path.basename(resolved))) {
    refuse('path_invalid', 'Output directory name must be a plain name (letters, digits, dot, underscore, hyphen)');
  }
  for (const source of sources) {
    if (pathsOverlap(resolved, source)) refuse('path_overlaps_source', 'Output path overlaps a source path');
  }
  if (lstatOrNull(resolved)) refuse('output_exists', 'Output path already exists; existing targets are never overwritten');
  return { output: resolved, partial: `${resolved}.partial`, parent };
}

/** @param {string} target @returns {fs.Stats | null} */
export function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} dir @returns {void} */
export function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Exclusive-create a file with the given content and fsync it. Refuses to
 * replace anything.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @returns {void}
 */
export function writeFileExclusiveDurable(filePath, content) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Atomically (re)write a file that the tool itself owns: temp file, fsync,
 * rename, directory fsync.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
export function replaceOwnFileDurable(filePath, content) {
  const temp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileExclusiveDurable(temp, content);
  fs.renameSync(temp, filePath);
  fsyncDirectory(path.dirname(filePath));
}

/**
 * Streaming SHA-256 of a file; memory stays at one chunk.
 *
 * @param {string} filePath
 * @returns {{ sha256: string, bytes: number }}
 */
export function hashFile(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Publish a finished `.partial` directory under its final name. The final name
 * must still be free (a rename onto a non-empty directory fails; an empty one
 * is excluded by the explicit check). The parent is fsynced afterwards.
 *
 * @param {string} partial
 * @param {string} output
 * @returns {void}
 */
export function publishDirectory(partial, output) {
  if (lstatOrNull(output)) refuse('output_exists', 'Output path appeared while the tool was running; nothing was overwritten');
  fs.renameSync(partial, output);
  fsyncDirectory(path.dirname(output));
}

/**
 * Remove a stale `.partial` directory, but only one that carries this tool's
 * marker (recursive removal unlinks symlinks, it never follows them).
 *
 * @param {string} partial
 * @returns {void}
 */
export function discardOwnPartial(partial) {
  const stat = lstatOrNull(partial);
  if (!stat) return;
  if (!stat.isDirectory() || !lstatOrNull(path.join(partial, PARTIAL_MARKER_FILE))) {
    refuse('partial_not_owned', 'Partial directory does not carry the migration marker; it is left untouched');
  }
  fs.rmSync(partial, { recursive: true, force: false });
}

/**
 * Open a finished store for reading without creating `-wal`/`-shm` files or
 * taking locks (`immutable=1`). Only valid for a cleanly closed store: an
 * immutable connection ignores a WAL, so callers refuse any WAL/SHM first.
 *
 * @param {string} dbPath
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openImmutableDatabase(dbPath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sibling = lstatOrNull(dbPath + suffix);
    if (sibling && sibling.size > 0) {
      refuse('store_not_cleanly_closed', 'The store has a WAL or journal file; close it through its owner first', { sibling: suffix });
    }
  }
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1&mode=ro`);
}
