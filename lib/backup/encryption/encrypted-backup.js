/**
 * Encrypted offline backups (B5): one authenticated envelope file wrapping the verified B4 backup
 * directory (details, manifest included, are encrypted). Operations, in order:
 *
 *   create   : verified plaintext backup in private staging -> pack -> envelope (.partial) -> re-decrypt
 *              check -> atomic rename -> staging removed.
 *   open     : full envelope authentication into private staging FIRST; only then unpack, then the normal
 *              B4 verification. Nothing parses or applies unauthenticated output.
 *   restore  : open + B4 journaled restore, with an ENCRYPTED pre-restore copy that is created and
 *              verified with the same key before any managed path changes.
 *
 * The password is only ever a function argument: it is not written to the control directory,
 * journal, manifest, descriptor, logs or error messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStorageRegistry } from '../../storage/store-registry.js';
import { acquireLease } from '../offline/control-dir.js';
import { OfflineDataError } from '../offline/offline-errors.js';
import { createOfflineBackup, verifyOfflineBackup } from '../offline/offline-backup.js';
import { assertWritersStopped } from '../offline/managed-files.js';
import { readRestoreJournal, recoverPendingRestore, restoreOfflineBackup } from '../offline/offline-restore.js';
import {
  assertPrivateDir, cleanupStaging, createStagingDir, removeStagingDir, stagingRoot,
} from '../offline/staging.js';
import { decryptToFile, encryptToFile, readEnvelopeListing } from './envelope.js';
import { packBackupDir, unpackBackup } from './pack.js';

export const ENCRYPTED_EXTENSION = '.cretlibak';

/**
 * Create an encrypted backup of all managed data.
 *
 * @param {{
 *   dataDir: string, controlDir: string, destRoot: string, password: string, registry?: object,
 *   includeCredentials?: boolean, lease?: { token: string },
 *   kdf?: { log2N: number, r: number, p: number }, chunkSize?: number, maxPlainBytes?: number,
 *   entropy?: { salt: Buffer, noncePrefix: Buffer },
 *   hooks?: { onKdf?: (k: object) => void, afterStaging?: (stageDir: string) => void },
 * }} options `lease` means the caller holds the exclusive lease (and already probed the writers).
 * @returns {Promise<{ file: string, id: string, profile: string, bytes: number }>}
 */
export async function createEncryptedBackup(options) {
  const registry = options.registry || getStorageRegistry();
  const ownLease = options.lease ? null : acquireLease(options.controlDir, 'encrypted-backup');
  const lease = options.lease || /** @type {{ token: string }} */ (ownLease);
  const destRoot = path.resolve(options.destRoot);
  let stage = '';
  let partial = '';
  try {
    if (ownLease) {
      assertWritersStopped(path.resolve(options.dataDir), { registry });
      cleanupStaging(options.controlDir);
    }
    stage = createStagingDir(options.controlDir, 'enc');
    const plain = /** @type {{ backupDir: string, manifest: any }} */ (await createOfflineBackup({
      dataDir: options.dataDir, controlDir: options.controlDir, destRoot: stage, registry, lease,
      includeCredentials: options.includeCredentials === true, encryptedStaging: true,
    }));
    options.hooks?.afterStaging?.(stage);
    const profile = options.includeCredentials ? 'data-credentials' : 'data';
    fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
    partial = path.join(destRoot, `${plain.manifest.id}${ENCRYPTED_EXTENSION}.partial`);
    const written = await encryptToFile(partial, options.password, packBackupDir(plain.backupDir), {
      descriptor: { createdAt: plain.manifest.createdAt, profile },
      kdf: options.kdf, chunkSize: options.chunkSize, maxPlainBytes: options.maxPlainBytes,
      entropy: options.entropy, hooks: options.hooks,
    });
    // Read the published bytes back with the key: the archive is only kept when it decrypts to the same digest.
    const check = path.join(stage, 'verify.pack');
    const back = await decryptToFile(partial, check, options.password, { maxPlainBytes: options.maxPlainBytes });
    fs.rmSync(check, { force: true });
    if (back.sha256 !== written.sha256) throw new OfflineDataError('ENVELOPE_AUTH_FAILED', 'written envelope does not decrypt to the packed backup');
    const file = path.join(destRoot, `${plain.manifest.id}${ENCRYPTED_EXTENSION}`);
    fs.renameSync(partial, file);
    partial = '';
    syncDir(destRoot);
    return { file, id: plain.manifest.id, profile, bytes: fs.statSync(file).size };
  } finally {
    if (partial) fs.rmSync(partial, { force: true });
    removeStagingDir(stage);
    ownLease?.release();
  }
}

/**
 * @param {string} dir
 */
function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* platform cannot fsync directories */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Authenticate, decrypt and unpack an encrypted backup into private staging, then run the normal
 * B4 verification on the result. The caller owns the returned `stage` and must remove it
 * (`removeStagingDir`); on failure it is already removed. Requires the exclusive lease.
 *
 * @param {string} file
 * @param {string} password
 * @param {{
 *   controlDir: string, registry?: object, maxPlainBytes?: number, stageDir?: string,
 *   hooks?: { onKdf?: (k: object) => void, beforeUnpack?: () => void },
 * }} options
 * @returns {Promise<{ stage: string, backupDir: string, manifest: any, descriptor: { createdAt: string, profile: string } }>}
 */
export async function openEncryptedBackup(file, password, options) {
  const stage = options.stageDir || createStagingDir(options.controlDir, 'open');
  if (options.stageDir) {
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    assertPrivateDir(stage);
  }
  const packFile = path.join(stage, 'plain.pack');
  const backupDir = path.join(stage, 'backup');
  try {
    const result = await decryptToFile(file, packFile, password, { maxPlainBytes: options.maxPlainBytes, hooks: options.hooks });
    // Fully authenticated from here on; only now may anything look inside the stream.
    options.hooks?.beforeUnpack?.();
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { mode: 0o700 });
    unpackBackup(packFile, backupDir);
    fs.rmSync(packFile, { force: true });
    const { manifest } = verifyOfflineBackup(backupDir, { registry: options.registry, allowCredentials: true });
    const expected = manifest.credentials === true ? 'data-credentials' : 'data';
    if (result.descriptor.profile !== expected) {
      throw new OfflineDataError('BACKUP_INVALID', 'envelope profile does not match the encrypted manifest');
    }
    return { stage, backupDir, manifest, descriptor: result.descriptor };
  } catch (err) {
    removeStagingDir(stage);
    throw err;
  }
}

/**
 * Full verification without touching data: authentication, unpack, manifest, digests, SQLite checks.
 *
 * @param {string} file
 * @param {string} password
 * @param {{ controlDir: string, registry?: object, maxPlainBytes?: number, hooks?: object }} options
 * @returns {Promise<{ manifest: any, descriptor: { createdAt: string, profile: string } }>}
 */
export async function verifyEncryptedBackup(file, password, options) {
  const lease = acquireLease(options.controlDir, 'encrypted-verify');
  try {
    cleanupStaging(options.controlDir);
    const opened = await openEncryptedBackup(file, password, options);
    removeStagingDir(opened.stage);
    return { manifest: opened.manifest, descriptor: opened.descriptor };
  } finally {
    lease.release();
  }
}

/**
 * Non-sensitive listing of encrypted backups in a directory: id, date, profile, size, status. No
 * password is needed and nothing from the encrypted manifest (paths, counts, content) is exposed.
 *
 * @param {string} destRoot
 * @returns {{ id: string, createdAt: string, profile: string, bytes: number, status: 'complete' | 'incomplete' | 'invalid' }[]}
 */
export function listEncryptedBackups(destRoot) {
  let names;
  try { names = fs.readdirSync(destRoot); } catch { return []; }
  const rows = [];
  for (const name of names.sort()) {
    const full = path.join(destRoot, name);
    if (name.endsWith(`${ENCRYPTED_EXTENSION}.partial`)) {
      rows.push({ id: name.slice(0, -(ENCRYPTED_EXTENSION.length + '.partial'.length)), createdAt: '', profile: '', bytes: fs.statSync(full).size, status: /** @type {const} */ ('incomplete') });
    } else if (name.endsWith(ENCRYPTED_EXTENSION)) {
      const id = name.slice(0, -ENCRYPTED_EXTENSION.length);
      try {
        const l = readEnvelopeListing(full);
        rows.push({ id, createdAt: l.createdAt, profile: l.profile, bytes: l.bytes, status: /** @type {const} */ ('complete') });
      } catch {
        rows.push({ id, createdAt: '', profile: '', bytes: fs.statSync(full).size, status: /** @type {const} */ ('invalid') });
      }
    }
  }
  return rows;
}

/**
 * Restore an encrypted backup. The pre-restore copy is encrypted with the same key and verified
 * (decrypt + unpack + B4 checks) before the first managed path changes.
 *
 * @param {{
 *   dataDir: string, controlDir: string, file: string, password: string, registry?: object,
 *   externalHighWater?: number, maxPlainBytes?: number,
 *   kdf?: { log2N: number, r: number, p: number },
 *   hooks?: { onStep?: (rel: string, step: string) => void, beforeStage?: (rel: string) => void, onKdf?: (k: object) => void, beforeUnpack?: () => void },
 * }} options
 * @returns {ReturnType<typeof restoreOfflineBackup>}
 */
export async function restoreEncryptedBackup(options) {
  const registry = options.registry || getStorageRegistry();
  const lease = acquireLease(options.controlDir, 'encrypted-restore');
  let opened = null;
  let keepStage = false;
  try {
    cleanupStaging(options.controlDir);
    opened = await openEncryptedBackup(options.file, options.password, { ...options, registry });
    const result = await restoreOfflineBackup({
      dataDir: options.dataDir, controlDir: options.controlDir, backupDir: opened.backupDir, registry,
      externalHighWater: options.externalHighWater, hooks: options.hooks, lease,
      encrypted: {
        source: options.file,
        async preRestoreCopy(args) {
          const pre = await createEncryptedBackup({
            ...args, password: options.password, kdf: options.kdf, maxPlainBytes: options.maxPlainBytes, hooks: options.hooks,
          });
          // The key must be able to open the recovery copy now, not on the day it is needed.
          const check = await openEncryptedBackup(pre.file, options.password, { controlDir: options.controlDir, registry, maxPlainBytes: options.maxPlainBytes });
          removeStagingDir(check.stage);
          return pre.file;
        },
      },
    });
    return result;
  } catch (err) {
    // An interrupted apply rolls forward from this stage: keep it (owner-only) until recovery finishes.
    const journal = readRestoreJournal(options.controlDir);
    keepStage = !!(journal && journal.status === 'applying' && journal.encryptedSource);
    throw err;
  } finally {
    if (opened && !keepStage) removeStagingDir(opened.stage);
    lease.release();
  }
}

/**
 * Finish an interrupted ENCRYPTED restore. Normally the owner-only stage kept for it is still there
 * and the key is not needed; when it was lost, the stage is rebuilt from the encrypted source with
 * the key, then the normal roll-forward runs.
 *
 * @param {{ dataDir: string, controlDir: string, password?: string, registry?: object, hooks?: any }} options
 */
export async function recoverPendingEncryptedRestore(options) {
  const journal = readRestoreJournal(options.controlDir);
  if (journal && ['applying'].includes(journal.status) && journal.encryptedSource
    && !fs.existsSync(path.join(journal.backupDir, 'manifest.json'))) {
    if (!options.password) {
      throw new OfflineDataError('RECOVERY_KEY_REQUIRED', `the decrypted stage of restore ${journal.id} is gone; the backup passphrase is required to rebuild it`, { id: journal.id });
    }
    const stage = path.dirname(journal.backupDir);
    if (path.dirname(stage) !== stagingRoot(options.controlDir)) {
      throw new OfflineDataError('STAGING_UNSAFE', 'journal stage is outside the control staging area');
    }
    const lease = acquireLease(options.controlDir, 'encrypted-recover');
    try {
      const opened = await openEncryptedBackup(journal.encryptedSource, options.password, { controlDir: options.controlDir, registry: options.registry, stageDir: stage });
      if (opened.manifest.id !== journal.id) {
        removeStagingDir(stage);
        throw new OfflineDataError('BACKUP_INVALID', 'encrypted source is not the backup this restore started from');
      }
    } finally {
      lease.release();
    }
  }
  return recoverPendingRestore(options);
}
