/**
 * Online backup (B6): a consistent copy of registry-managed data while the server keeps running.
 *
 * Two phases, split by the shared maintenance coordinator (lib/storage/maintenance-coordinator.js):
 *
 *   inside the barrier : every writer gate is closed, drained and flushed, store locks are held in the
 *                        registry's fixed order, and the managed files are copied into a private stage
 *                        (SQLite through the backup API, everything else byte-copied; NO hard links,
 *                        mutable journals and databases keep changing after the barrier ends).
 *   after the barrier  : gates, locks and lease are released. Packaging (manifest, digests, optional
 *                        encryption, verification) runs from the stage and never blocks a writer.
 *
 * Nothing is published unless the stage was copied completely and the final backup verified; any failure
 * leaves no archive behind. Immutable blobs (attachments) are protected from GC by the `gc` participant
 * gate that stays closed for the whole barrier, and they are copied (not linked) into the same stage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { getStorageRegistry } from '../../storage/store-registry.js';
import { MaintenanceError } from '../../storage/maintenance-coordinator.js';
import { createEncryptedBackup, verifyEncryptedBackup } from '../encryption/encrypted-backup.js';
import { createOfflineBackup, verifyOfflineBackup } from '../offline/offline-backup.js';
import { OfflineDataError } from '../offline/offline-errors.js';
import { enumerateManaged, hasSqliteMagic, isCredentialPath, isSqliteMain } from '../offline/managed-files.js';
import { STAGING_MAX_AGE_MS, createStagingDir, describeStaging, removeStagingDir } from '../offline/staging.js';

/** Free space required beyond the estimated payload (stage + final archive both need room). */
export const FREE_SPACE_FACTOR = 2.2;

/**
 * @param {string} dir
 * @returns {number} free bytes on the filesystem holding `dir` (nearest existing ancestor)
 */
export function freeBytesOf(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const s = fs.statfsSync(cur);
      return Number(s.bavail) * Number(s.bsize);
    } catch (err) {
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      cur = parent;
    }
  }
}

/**
 * Copy managed files into `stageData`, enforcing the barrier's byte/time/event-loop budgets and
 * detecting writers that ignored the gates (a source file that changed while it was being copied).
 *
 * @param {{
 *   dataDir: string, stageData: string, registry: object, includeCredentials: boolean,
 *   ctx: { assertWithinBudget: () => void, budgets: { maxStageBytes: number } },
 *   hooks?: { duringCopy?: (rel: string) => Promise<void> | void, afterCopy?: (rel: string) => Promise<void> | void },
 * }} args
 * @returns {Promise<{ files: number, bytes: number, omissions: string[] }>}
 */
export async function stageManagedFiles(args) {
  const { dataDir, stageData, ctx } = args;
  const enumerated = enumerateManaged(dataDir, { registry: args.registry });
  const omissions = [...enumerated.skipped];
  let bytes = 0;
  let files = 0;
  for (const { rel } of enumerated.files) {
    if (isCredentialPath(rel) && !args.includeCredentials) {
      omissions.push(`${rel} (managed secret; encrypted profile only)`);
      continue;
    }
    const src = path.join(dataDir, rel);
    const dest = path.join(stageData, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const before = fs.statSync(src);
    if (bytes + before.size > ctx.budgets.maxStageBytes) {
      throw new MaintenanceError('STAGE_TOO_LARGE', 'managed data exceeds the online staging limit; use the offline backup', { maxStageBytes: ctx.budgets.maxStageBytes });
    }
    if (isSqliteMain(rel) && before.size > 0) {
      if (!hasSqliteMagic(src)) throw new OfflineDataError('SQLITE_CORRUPT', `${rel} is not a SQLite database`, { rel });
      const db = new DatabaseSync(src, { readOnly: true });
      try { await sqliteBackup(db, dest); } finally { db.close(); }
    } else {
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      await args.hooks?.duringCopy?.(rel);
      const after = fs.statSync(src);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new MaintenanceError('WRITER_DURING_BARRIER', 'a managed file changed while the barrier was held: an unregistered writer ignored the gates', { rel });
      }
    }
    bytes += fs.statSync(dest).size;
    files += 1;
    await args.hooks?.afterCopy?.(rel);
    // Yield twice so timers (the coordinator's event-loop lag sampler, other requests) run between files.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    ctx.assertWithinBudget();
  }
  return { files, bytes, omissions };
}

/**
 * Create and verify an online backup.
 *
 * @param {{
 *   dataDir: string, controlDir: string, destRoot: string,
 *   coordinator: ReturnType<typeof import('../../storage/maintenance-coordinator.js').createMaintenanceCoordinator>,
 *   registry?: object,
 *   password?: string,
 *   includeCredentials?: boolean,
 *   freeBytes?: (dir: string) => number,
 *   kdf?: { log2N: number, r: number, p: number },
 *   hooks?: { duringCopy?: (rel: string) => Promise<void> | void, afterCopy?: (rel: string) => Promise<void> | void, afterBarrier?: () => Promise<void> | void },
 * }} options
 * @returns {Promise<{ id: string, path: string, kind: 'plain' | 'encrypted', bytes: number, createdAt: string,
 *   stage: { files: number, bytes: number }, metrics: object }>}
 * @throws {MaintenanceError | OfflineDataError} nothing is published on any error
 */
export async function createOnlineBackup(options) {
  const registry = options.registry || getStorageRegistry();
  const dataDir = path.resolve(options.dataDir);
  const destRoot = path.resolve(options.destRoot);
  const free = options.freeBytes || freeBytesOf;
  if (options.includeCredentials && !options.password) {
    throw new OfflineDataError('CREDENTIALS_REQUIRE_ENCRYPTION', 'managed secrets can only be exported inside an encrypted backup');
  }
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  // No lease is held here, so only this module's own long-abandoned stages are swept (never another operation's).
  for (const { dir, ageMs } of describeStaging(options.controlDir)) {
    if (path.basename(dir).startsWith('online-') && ageMs > STAGING_MAX_AGE_MS) removeStagingDir(dir);
  }
  const stage = createStagingDir(options.controlDir, 'online');
  const stageData = path.join(stage, 'data');
  fs.mkdirSync(stageData, { mode: 0o700 });
  try {
    // Disk check before the barrier so a full disk never costs a writer pause.
    const estimate = enumerateManaged(dataDir, { registry }).files.reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(dataDir, f.rel)).size; } catch { return sum; }
    }, 0);
    const needed = Math.ceil(estimate * FREE_SPACE_FACTOR);
    if (free(stage) < needed || free(destRoot) < needed) {
      throw new OfflineDataError('DISK_FULL', 'not enough free disk space for an online backup', { needed });
    }

    const { value: staged, metrics } = await options.coordinator.run({ purpose: 'online-backup' }, (ctx) => stageManagedFiles({
      dataDir, stageData, registry, includeCredentials: options.includeCredentials === true, ctx, hooks: options.hooks,
    }));
    await options.hooks?.afterBarrier?.();

    // Barrier is over. From here on only the private stage is read.
    /** @type {{ id: string, path: string, kind: 'plain' | 'encrypted', bytes: number, createdAt: string }} */
    let published;
    if (options.password) {
      const made = await createEncryptedBackup({
        dataDir: stageData, controlDir: options.controlDir, destRoot, password: options.password, registry,
        includeCredentials: options.includeCredentials === true, lease: { token: 'online-stage' }, kdf: options.kdf,
      });
      try {
        await verifyEncryptedBackup(made.file, options.password, { controlDir: options.controlDir, registry });
      } catch (err) {
        fs.rmSync(made.file, { force: true });
        throw err;
      }
      published = { id: made.id, path: made.file, kind: 'encrypted', bytes: made.bytes, createdAt: new Date().toISOString() };
    } else {
      const made = await createOfflineBackup({
        dataDir: stageData, controlDir: options.controlDir, destRoot, registry, lease: { token: 'online-stage' },
      });
      try {
        verifyOfflineBackup(made.backupDir, { registry });
      } catch (err) {
        fs.rmSync(made.backupDir, { recursive: true, force: true });
        throw err;
      }
      const manifest = /** @type {{ id: string, createdAt: string }} */ (/** @type {any} */ (made.manifest));
      published = { id: manifest.id, path: made.backupDir, kind: 'plain', bytes: dirBytes(made.backupDir), createdAt: manifest.createdAt };
    }
    return { ...published, stage: { files: staged.files, bytes: staged.bytes }, metrics };
  } finally {
    removeStagingDir(stage);
  }
}

/**
 * @param {string} dir
 * @returns {number}
 */
function dirBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(full) : fs.statSync(full).size;
  }
  return total;
}
