/**
 * Offline restore of a verified backup with a durable per-path journal (B4 MVP).
 *
 * Only registry-managed paths are replaced. Every replacement is staged next to its destination
 * (so rename never crosses a filesystem or touches the data root / mount point itself), the previous
 * file is kept as a sibling `.prev` for explicit rollback, and the journal records
 * pending -> prepared -> displaced -> replaced -> verified per path. Recovery is idempotent and
 * decides from the actual disk state, so a crash after any step rolls forward.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getStorageRegistry } from '../../storage/store-registry.js';
import { checkStorageRuntime } from '../../storage/runtime-check.js';
import {
  acquireLease, allocateGeneration, controlPaths, readControlState, readJsonStrict, writeControlState, writeJsonDurable,
} from './control-dir.js';
import { OfflineDataError } from './offline-errors.js';
import {
  assertSafeRel, assertWritersStopped, enumerateManaged, isCredentialPath, sha256File,
} from './managed-files.js';
import { assertSqliteClean, createOfflineBackup, verifyOfflineBackup } from './offline-backup.js';
import { cleanupStaging, describeStaging } from './staging.js';

const IN_PROGRESS = new Set(['preparing', 'applying', 'rolling-back']);

/** @typedef {'pending' | 'prepared' | 'displaced' | 'replaced' | 'verified'} Step */

/**
 * @param {string} dataDir
 * @param {string} rel
 * @param {string} id
 */
function sidePaths(dataDir, rel, id) {
  const target = path.join(dataDir, rel);
  const dir = path.dirname(target);
  const base = path.basename(target);
  return {
    target,
    staged: path.join(dir, `.${base}.restore-${id}.staged`),
    prev: path.join(dir, `.${base}.restore-${id}.prev`),
  };
}

/**
 * @param {string} dir
 */
function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* platform cannot fsync directories */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
const exists = (p) => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};

/**
 * @param {string} controlDir
 * @returns {any | null}
 */
export function readRestoreJournal(controlDir) {
  return readJsonStrict(controlPaths(controlDir).journal);
}

/**
 * @param {string} src
 * @param {string} dest
 */
function stageCopy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(dest, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * @param {{ dataDir: string, controlDir: string, journal: any, hooks?: any }} ctx
 * @param {any} p journal path row
 * @param {Step} step
 */
function setStep(ctx, p, step) {
  p.step = step;
  writeJsonDurable(controlPaths(ctx.controlDir).journal, ctx.journal);
  ctx.hooks?.onStep?.(p.rel, step);
}

/**
 * Drive one path to `verified` from whatever state the disk is in.
 *
 * @param {{ dataDir: string, controlDir: string, journal: any, hooks?: any }} ctx
 * @param {any} p
 */
function driveOne(ctx, p) {
  const { journal } = ctx;
  const { target, staged, prev } = sidePaths(ctx.dataDir, p.rel, journal.id);
  const dir = path.dirname(target);
  if (p.action === 'remove') {
    if (exists(target)) {
      if (p.hadOriginal && !exists(prev)) {
        fs.renameSync(target, prev);
        syncDir(dir);
        setStep(ctx, p, 'displaced');
      } else {
        throw new OfflineDataError('RESTORE_CONFLICT', `${p.rel} changed during restore`, { rel: p.rel });
      }
    }
    if (exists(target)) throw new OfflineDataError('RESTORE_VERIFY_FAILED', `${p.rel} still exists`, { rel: p.rel });
    if (p.step !== 'replaced') setStep(ctx, p, 'replaced');
    setStep(ctx, p, 'verified');
    return;
  }
  const done = exists(target) && sha256File(target) === p.sha256;
  if (!done) {
    if (exists(target)) {
      if (p.hadOriginal && !exists(prev)) {
        fs.renameSync(target, prev);
        syncDir(dir);
        setStep(ctx, p, 'displaced');
      } else {
        throw new OfflineDataError('RESTORE_CONFLICT', `${p.rel} changed during restore`, { rel: p.rel });
      }
    }
    if (!exists(staged) || sha256File(staged) !== p.sha256) {
      const src = path.join(journal.backupDir, 'files', p.rel);
      stageCopy(src, staged);
      if (sha256File(staged) !== p.sha256) throw new OfflineDataError('RESTORE_VERIFY_FAILED', `staged ${p.rel} digest mismatch`, { rel: p.rel });
    }
    fs.renameSync(staged, target);
    syncDir(dir);
    setStep(ctx, p, 'replaced');
  } else {
    fs.rmSync(staged, { force: true });
    if (p.step !== 'replaced') setStep(ctx, p, 'replaced');
  }
  if (sha256File(target) !== p.sha256) throw new OfflineDataError('RESTORE_VERIFY_FAILED', `${p.rel} digest mismatch after replace`, { rel: p.rel });
  if (p.kind === 'sqlite') assertSqliteClean(target);
  setStep(ctx, p, 'verified');
}

/**
 * @param {{ dataDir: string, controlDir: string, journal: any, hooks?: any }} ctx
 */
function finishApply(ctx) {
  const { journal } = ctx;
  for (const p of journal.paths) {
    if (p.step !== 'verified') driveOne(ctx, p);
  }
  // Fresh generation + fence stay paused until an operator explicitly resumes.
  writeControlState(ctx.controlDir, {
    datasetGeneration: journal.newState.datasetGeneration,
    fence: journal.newState.fence,
    paused: true,
    pauseReason: `restore ${journal.id}`,
  });
  journal.status = 'complete';
  writeJsonDurable(controlPaths(ctx.controlDir).journal, journal);
  ctx.hooks?.onStep?.('', 'complete');
}

/**
 * @param {{ dataDir: string, controlDir: string, journal: any }} ctx
 */
function cleanupStaged(ctx) {
  for (const p of ctx.journal.paths) {
    fs.rmSync(sidePaths(ctx.dataDir, p.rel, ctx.journal.id).staged, { force: true });
  }
}

/**
 * @param {{ dataDir: string, controlDir: string, journal: any, hooks?: any }} ctx
 */
function rollbackBody(ctx) {
  const { journal } = ctx;
  for (const p of [...journal.paths].reverse()) {
    const { target, prev, staged } = sidePaths(ctx.dataDir, p.rel, journal.id);
    fs.rmSync(staged, { force: true });
    if (exists(prev)) {
      fs.rmSync(target, { force: true });
      fs.renameSync(prev, target);
      syncDir(path.dirname(target));
    } else if (!p.hadOriginal) {
      fs.rmSync(target, { force: true });
    }
    ctx.hooks?.onStep?.(p.rel, 'rolled-back');
  }
  const next = allocateGeneration(ctx.controlDir, [journal.newState.fence]);
  writeControlState(ctx.controlDir, {
    datasetGeneration: next.datasetGeneration, fence: next.fence, paused: true, pauseReason: `rollback ${journal.id}: reconcile`,
  });
  journal.status = 'rolled-back';
  writeJsonDurable(controlPaths(ctx.controlDir).journal, journal);
}

/**
 * Restore a backup. Everything that can fail (verification, pre-restore copy, staging, full disk)
 * happens before the first destination file is touched.
 *
 * @param {{
 *   dataDir: string, controlDir: string, backupDir: string, registry?: object,
 *   externalHighWater?: number,
 *   lease?: { token: string, release: () => void },
 *   encrypted?: {
 *     source: string,
 *     preRestoreCopy: (args: { dataDir: string, controlDir: string, destRoot: string, registry: object, lease: { token: string }, includeCredentials: boolean }) => Promise<string>,
 *   },
 *   hooks?: { onStep?: (rel: string, step: string) => void, beforeStage?: (rel: string) => void },
 * }} options `encrypted` marks `backupDir` as the private plaintext stage of an authenticated encrypted
 *   backup (`source`, recorded in the journal; never the key). Its `preRestoreCopy` MUST write an encrypted
 *   copy and verify it with the key BEFORE returning, so an encrypted restore never changes managed paths
 *   without an encrypted, verified recovery copy and a working key.
 * @returns {Promise<{ id: string, preRestoreBackup: string, generation: string, fence: number, replaced: number, removed: number }>}
 */
export async function restoreOfflineBackup(options) {
  const dataDir = path.resolve(options.dataDir);
  const backupDir = path.resolve(options.backupDir);
  const registry = options.registry || getStorageRegistry();
  checkStorageRuntime();
  const { manifest } = verifyOfflineBackup(backupDir, { registry, allowCredentials: !!options.encrypted });
  const lease = options.lease || acquireLease(options.controlDir, 'restore');
  try {
    const existing = readRestoreJournal(options.controlDir);
    if (existing && existing.status !== 'rolled-back') {
      throw new OfflineDataError('RESTORE_PENDING', `a previous restore (${existing.id}) is ${existing.status}; run recover / finalize / rollback first`);
    }
    assertWritersStopped(dataDir, { registry });

    // Verified recovery copy of the current data BEFORE anything is replaced; kept outside the payload.
    const preRestoreDir = controlPaths(options.controlDir).preRestore;
    const pre = options.encrypted
      ? {
        backupDir: await options.encrypted.preRestoreCopy({
          dataDir, controlDir: options.controlDir, destRoot: preRestoreDir, registry, lease, includeCredentials: manifest.credentials === true,
        }),
      }
      : await createOfflineBackup({ dataDir, controlDir: options.controlDir, destRoot: preRestoreDir, registry, lease });
    if (!options.encrypted) verifyOfflineBackup(pre.backupDir, { registry });

    const id = manifest.id;
    const targetFiles = enumerateManaged(dataDir, { registry, includeSidecars: true }).files.map((f) => f.rel);
    const incoming = new Set(manifest.entries.map((/** @type {any} */ e) => e.path));
    const paths = [
      ...manifest.entries.map((/** @type {any} */ e) => ({
        rel: assertSafeRel(e.path), action: 'replace', kind: e.kind, sha256: e.sha256,
        hadOriginal: exists(path.join(dataDir, e.path)), step: 'pending',
      })),
      // A backup that declares no managed secrets never removes the destination's own credentials.
      ...targetFiles.filter((rel) => !incoming.has(rel) && !(manifest.credentials === false && isCredentialPath(rel))).map((rel) => ({
        rel, action: 'remove', kind: 'file', sha256: '', hadOriginal: true, step: 'pending',
      })),
    ];
    const state = readControlState(options.controlDir);
    const journal = {
      schema: 1,
      id,
      status: 'preparing',
      createdAt: new Date().toISOString(),
      backupDir,
      encryptedSource: options.encrypted ? path.resolve(options.encrypted.source) : null,
      preRestoreBackup: pre.backupDir,
      priorState: { datasetGeneration: state.datasetGeneration, fence: state.fence },
      newState: allocateGeneration(options.controlDir, [manifest.source?.fence, manifest.source?.highWater, options.externalHighWater || 0]),
      paths,
    };
    const ctx = { dataDir, controlDir: options.controlDir, journal, hooks: options.hooks };
    writeJsonDurable(controlPaths(options.controlDir).journal, journal);

    try {
      for (const p of paths) {
        if (p.action === 'replace') {
          options.hooks?.beforeStage?.(p.rel);
          const { staged } = sidePaths(dataDir, p.rel, id);
          stageCopy(path.join(backupDir, 'files', p.rel), staged);
          if (sha256File(staged) !== p.sha256) throw new OfflineDataError('RESTORE_VERIFY_FAILED', `staged ${p.rel} digest mismatch`);
          if (p.kind === 'sqlite') assertSqliteClean(staged);
        }
        setStep(ctx, p, 'prepared');
      }
    } catch (err) {
      // No destination file was touched yet: drop staging and the journal.
      cleanupStaged(ctx);
      fs.rmSync(controlPaths(options.controlDir).journal, { force: true });
      throw err;
    }
    journal.status = 'applying';
    writeJsonDurable(controlPaths(options.controlDir).journal, journal);
    finishApply(ctx);
    return {
      id,
      preRestoreBackup: pre.backupDir,
      generation: journal.newState.datasetGeneration,
      fence: journal.newState.fence,
      replaced: paths.filter((p) => p.action === 'replace').length,
      removed: paths.filter((p) => p.action === 'remove').length,
    };
  } finally {
    if (!options.lease) lease.release();
  }
}

/**
 * Remove crash-leftover plaintext staging when no restore needs it. A held lease means another
 * operation is running (its staging is live): skip silently.
 *
 * @param {string} controlDir
 */
function sweepStagingIfAny(controlDir) {
  if (describeStaging(controlDir).length === 0) return;
  let lease;
  try { lease = acquireLease(controlDir, 'staging-cleanup'); } catch { return; }
  try { cleanupStaging(controlDir); } finally { lease.release(); }
}

/**
 * Finish an interrupted restore/rollback (roll forward) or abandon one that never reached the
 * first destination replacement. Safe to call on every startup before any store is opened.
 *
 * @param {{ dataDir: string, controlDir: string, hooks?: any }} options
 * @returns {{ action: 'none' | 'aborted' | 'rolled-forward' | 'rollback-completed', id?: string }}
 */
export function recoverPendingRestore(options) {
  const dataDir = path.resolve(options.dataDir);
  const journal = readRestoreJournal(options.controlDir);
  if (!journal || !IN_PROGRESS.has(journal.status)) {
    sweepStagingIfAny(options.controlDir);
    return { action: 'none', id: journal?.id };
  }
  const lease = acquireLease(options.controlDir, 'recover');
  try {
    // Plaintext staging of crashed operations goes; the stage an unfinished encrypted restore still reads stays.
    cleanupStaging(options.controlDir, { keep: journal.encryptedSource ? [journal.backupDir] : [] });
    const ctx = { dataDir, controlDir: options.controlDir, journal, hooks: options.hooks };
    if (journal.status === 'preparing') {
      cleanupStaged(ctx);
      fs.rmSync(controlPaths(options.controlDir).journal, { force: true });
      if (journal.encryptedSource) cleanupStaging(options.controlDir);
      return { action: 'aborted', id: journal.id };
    }
    if (journal.status === 'rolling-back') {
      rollbackBody(ctx);
      return { action: 'rollback-completed', id: journal.id };
    }
    if (!exists(path.join(journal.backupDir, 'manifest.json'))) {
      if (journal.encryptedSource) {
        throw new OfflineDataError('RECOVERY_KEY_REQUIRED', `the decrypted stage of restore ${journal.id} is gone; re-run recover with the backup passphrase (${journal.encryptedSource}) or use rollback`, { id: journal.id });
      }
      throw new OfflineDataError('RECOVERY_BACKUP_MISSING', `backup ${journal.backupDir} needed to finish restore ${journal.id} is gone; use rollback`, { id: journal.id });
    }
    finishApply(ctx);
    if (journal.encryptedSource) cleanupStaging(options.controlDir);
    return { action: 'rolled-forward', id: journal.id };
  } finally {
    lease.release();
  }
}

/**
 * Explicit rollback to the previous files kept by a completed restore. Anything written after the
 * restore is lost; the dataset gets another fresh generation and stays paused for reconciliation.
 *
 * @param {{ dataDir: string, controlDir: string, acknowledgeLossy?: boolean, hooks?: any }} options
 */
export function rollbackRestore(options) {
  if (options.acknowledgeLossy !== true) {
    throw new OfflineDataError('ROLLBACK_NOT_ACKNOWLEDGED', 'rollback discards writes made after the restore; pass acknowledgeLossy');
  }
  const journal = readRestoreJournal(options.controlDir);
  if (!journal || journal.status !== 'complete') {
    throw new OfflineDataError('ROLLBACK_UNAVAILABLE', 'no completed, unfinalized restore to roll back');
  }
  const lease = acquireLease(options.controlDir, 'rollback');
  try {
    const dataDir = path.resolve(options.dataDir);
    assertWritersStopped(dataDir);
    journal.status = 'rolling-back';
    writeJsonDurable(controlPaths(options.controlDir).journal, journal);
    rollbackBody({ dataDir, controlDir: options.controlDir, journal, hooks: options.hooks });
    return { id: journal.id, preRestoreBackup: journal.preRestoreBackup };
  } finally {
    lease.release();
  }
}

/**
 * Discard the retained previous files and the journal once the restore is accepted.
 * The pre-restore recovery backup stays under the control directory.
 *
 * @param {{ dataDir: string, controlDir: string }} options
 */
export function finalizeRestore(options) {
  const journal = readRestoreJournal(options.controlDir);
  if (!journal || (journal.status !== 'complete' && journal.status !== 'rolled-back')) {
    throw new OfflineDataError('FINALIZE_UNAVAILABLE', 'no completed restore to finalize');
  }
  for (const p of journal.paths) {
    fs.rmSync(sidePaths(path.resolve(options.dataDir), p.rel, journal.id).prev, { force: true });
  }
  fs.rmSync(controlPaths(options.controlDir).journal, { force: true });
  return { id: journal.id };
}

/**
 * Clear the restore pause flag (explicit operator action, refused while a restore is in progress).
 *
 * @param {string} controlDir
 */
export function resumeAfterRestore(controlDir) {
  const journal = readRestoreJournal(controlDir);
  if (journal && IN_PROGRESS.has(journal.status)) {
    throw new OfflineDataError('RESTORE_PENDING', `restore ${journal.id} is ${journal.status}; recover it first`);
  }
  return writeControlState(controlDir, { paused: false, pauseReason: '' });
}
