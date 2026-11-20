/**
 * Offline full backup of registry-managed JSON/SQLite data (B4 MVP).
 *
 * The backup is a directory: `files/<rel>` copies plus a `manifest.json` written LAST (its presence
 * marks a complete backup). SQLite databases are copied with the supported backup API from a cleanly
 * closed database (never a bare copy of a live main file) and the staged copy must pass
 * `integrity_check` and `foreign_key_check`. Runtime locks are excluded. The server must be stopped.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { getStorageRegistry } from '../../storage/store-registry.js';
import { checkStorageRuntime } from '../../storage/runtime-check.js';
import { writeFileDurable } from '../durable-write.js';
import { acquireLease, readControlState } from './control-dir.js';
import { OfflineDataError } from './offline-errors.js';
import {
  assertSafeRel, assertWritersStopped, enumerateManaged, hasSqliteMagic, isCredentialPath, isSqliteMain,
  managedPatterns, ownerOf, sha256File,
} from './managed-files.js';

export const BACKUP_FORMAT = 'cretli-offline-backup/1';

/**
 * Integrity and foreign-key checks on a (staged) SQLite file, opened read-only.
 *
 * @param {string} file
 * @throws {OfflineDataError} SQLITE_CHECK_FAILED
 */
export function assertSqliteClean(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => String(Object.values(r)[0]));
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      throw new OfflineDataError('SQLITE_CHECK_FAILED', `integrity_check failed: ${integrity.slice(0, 3).join('; ')}`, { file });
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) {
      throw new OfflineDataError('SQLITE_CHECK_FAILED', `foreign_key_check reported ${fk.length} violation(s)`, { file });
    }
  } finally {
    db.close();
  }
}

/**
 * @param {string} srcFile
 * @param {string} destFile
 */
async function copySqlite(srcFile, destFile) {
  const src = new DatabaseSync(srcFile, { readOnly: true });
  try {
    await sqliteBackup(src, destFile);
  } finally {
    src.close();
  }
  assertSqliteClean(destFile);
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyFileDurable(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(dest, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Create a verified offline backup of all managed data.
 *
 * @param {{
 *   dataDir: string,
 *   controlDir: string,
 *   destRoot: string,
 *   registry?: object,
 *   lease?: { token: string },
 *   includeCredentials?: boolean,
 *   encryptedStaging?: boolean,
 *   hooks?: { beforeCopy?: (rel: string) => void },
 * }} options `lease` means the caller already holds the exclusive lease and writer probe.
 * `includeCredentials` (Cretli-managed secret documents) is accepted only with `encryptedStaging`: the
 * directory is a private plaintext stage that the encrypted-backup service packs and deletes.
 * @returns {Promise<{ backupDir: string, manifest: object }>}
 */
export async function createOfflineBackup(options) {
  const dataDir = path.resolve(options.dataDir);
  const registry = options.registry || getStorageRegistry();
  const runtime = checkStorageRuntime();
  if (options.includeCredentials && !options.encryptedStaging) {
    throw new OfflineDataError('CREDENTIALS_REQUIRE_ENCRYPTION', 'managed secrets can only be exported inside an encrypted backup');
  }
  const ownLease = options.lease ? null : acquireLease(options.controlDir, 'backup');
  /** @type {string} */
  let partial = '';
  try {
    if (!options.lease) assertWritersStopped(dataDir, { registry });
    const state = readControlState(options.controlDir);
    const id = `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(4).toString('hex')}`;
    const destRoot = path.resolve(options.destRoot);
    fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
    partial = path.join(destRoot, `${id}.partial`);
    const backupDir = path.join(destRoot, id);
    fs.mkdirSync(path.join(partial, 'files'), { recursive: true, mode: 0o700 });

    const enumerated = enumerateManaged(dataDir, { registry });
    const skipped = [...enumerated.skipped];
    const entries = [];
    for (const { rel, storeId } of enumerated.files) {
      if (isCredentialPath(rel) && !options.includeCredentials) {
        skipped.push(`${rel} (managed secret; encrypted profile only)`);
        continue;
      }
      options.hooks?.beforeCopy?.(rel);
      const src = path.join(dataDir, rel);
      const dest = path.join(partial, 'files', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let kind = 'file';
      if (isSqliteMain(rel) && fs.statSync(src).size > 0) {
        if (!hasSqliteMagic(src)) throw new OfflineDataError('SQLITE_CORRUPT', `${rel} is not a SQLite database`, { rel });
        await copySqlite(src, dest);
        kind = 'sqlite';
      } else {
        copyFileDurable(src, dest);
      }
      entries.push({ path: rel, storeId, kind, bytes: fs.statSync(dest).size, sha256: sha256File(dest) });
    }

    const markers = managedPatterns(registry)
      .filter((p) => p.marker)
      .filter((p, i, all) => all.findIndex((q) => q.storeId === p.storeId) === i)
      .map((p) => ({
        storeId: p.storeId, backendKind: p.backendKind, schemaVersion: p.schemaVersion, markerPath: p.marker,
        present: entries.some((e) => e.storeId === p.storeId),
      }));
    const manifest = {
      format: BACKUP_FORMAT,
      id,
      createdAt: new Date().toISOString(),
      runtime: { node: runtime.node, sqlite: runtime.sqlite },
      credentials: options.includeCredentials === true,
      registryVersion: /** @type {any} */ (registry).registryVersion,
      source: { datasetGeneration: state.datasetGeneration, fence: state.fence, highWater: state.highWater },
      entries,
      markers,
      omissions: skipped,
    };
    writeFileDurable(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(partial, backupDir);
    partial = '';
    return { backupDir, manifest };
  } finally {
    if (partial) fs.rmSync(partial, { recursive: true, force: true });
    ownLease?.release();
  }
}

/**
 * Verify a backup directory end to end without touching any data: manifest format, safe managed
 * paths, digests, and clean SQLite copies. Unsupported formats fail here, before any replacement.
 *
 * @param {string} backupDir
 * @param {{ registry?: object, allowCredentials?: boolean }} [options] `allowCredentials` is set only
 *   for a directory unpacked from an authenticated encrypted backup.
 * @returns {{ manifest: any }}
 * @throws {OfflineDataError}
 */
export function verifyOfflineBackup(backupDir, options = {}) {
  const manifestFile = path.join(backupDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    throw new OfflineDataError('BACKUP_INVALID', `backup manifest unreadable (incomplete backup?): ${/** @type {Error} */ (err).message}`, { backupDir });
  }
  if (manifest?.format !== BACKUP_FORMAT || !Array.isArray(manifest.entries)) {
    throw new OfflineDataError('BACKUP_UNSUPPORTED', `unsupported backup format ${JSON.stringify(manifest?.format)}`, { backupDir });
  }
  if (manifest.credentials === true && !options.allowCredentials) {
    throw new OfflineDataError('BACKUP_INVALID', 'a plain backup must not carry managed secrets', { backupDir });
  }
  const patterns = managedPatterns(options.registry || getStorageRegistry());
  const seen = new Set();
  for (const entry of manifest.entries) {
    const rel = assertSafeRel(entry.path);
    if (seen.has(rel)) throw new OfflineDataError('BACKUP_INVALID', `duplicate entry ${rel}`);
    seen.add(rel);
    if (manifest.credentials === false && isCredentialPath(rel)) throw new OfflineDataError('BACKUP_INVALID', `managed secret in a backup that declares none: ${rel}`);
    if (!ownerOf(rel, patterns)) throw new OfflineDataError('BACKUP_INVALID', `entry is not a registry-managed path: ${rel}`);
    const file = path.join(backupDir, 'files', rel);
    let st;
    try { st = fs.lstatSync(file); } catch { throw new OfflineDataError('BACKUP_INVALID', `missing payload for ${rel}`); }
    if (!st.isFile()) throw new OfflineDataError('BACKUP_INVALID', `payload is not a regular file: ${rel}`);
    if (sha256File(file) !== entry.sha256) throw new OfflineDataError('BACKUP_INVALID', `digest mismatch for ${rel}`, { rel });
    if (entry.kind === 'sqlite') assertSqliteClean(file);
  }
  return { manifest };
}
