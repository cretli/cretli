/**
 * Data side of the history cutover (stage 3 preparation; docs/storage-pre-cutover-runbook.md).
 *
 * Everything here runs OFFLINE, with every Cretli writer stopped by the caller (the snapshot tool's quiesced-window
 * hook). Order, each step failing closed:
 *   verify material -> strict source plan -> staging import -> verify-import -> source unchanged -> code apply
 *   -> publish store (recoverable) -> select `sqlite` through the coordinator lease -> verify marker.
 * Until the marker is written the legacy backend stays authoritative and the whole operation can be undone
 * (`abortBeforeMarker`). After a new backend accepted durable writes nothing here restores an old backup:
 * `rollbackPreCutover` refuses and the read-only rollback export is the only path.
 *
 * The legacy directory is only read; its bytes (including the protected ignore files) are proven unchanged by the
 * plan hash before and after. Output carries codes and counts, never conversation text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { HISTORY_CUTOVER_WITNESS_FILE, HISTORY_BACKEND_MARKER_FILE, readHistoryBackendMarker, selectHistoryBackend } from '../persist/chat-history-backend-marker.js';
import { createStorageCoordinator } from './coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME } from './db-lifecycle.js';
import { readDatasetBinding } from './dataset-binding.js';
import { applyLegacyImport, planLegacyImport, verifyImportStaging, PROTECTED_IGNORE_FILES } from './history-import.js';
import { refuse } from './history-legacy-format.js';
import {
  fsyncDirectory, hashFile, lstatOrNull, openImmutableDatabase, replaceOwnFileDurable,
} from './history-migration-fs.js';
import { applyRollbackExport, planRollbackExport, verifyRollbackExport } from './history-rollback.js';
import { digestCanonical } from './history-sidecar.js';
import { applyCodeCandidates, assertCodeMaterialUnchanged, revertCodeApply } from './cutover-code.js';

export const CUTOVER_MANIFEST_SCHEMA = 'cretli-cutover-manifest-v1';
export const CUTOVER_STATUS_SCHEMA = 'cretli-cutover-status-v1';
export const CUTOVER_EVIDENCE_SCHEMA = 'cretli-cutover-evidence-v1';
const MARKER_ACTOR_PREFIX = 'cutover-';
/** Backups older than this are not "fresh" unless the manifest narrows it further. */
const DEFAULT_BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Directory names the server derives from the data root (`resolveChatHistoryPaths`); a test keeps them equal.
 *
 * @param {string} dataRoot
 * @param {string} [legacyDir]
 * @returns {{ legacyDir: string, controlDir: string, dbDir: string, pendingDir: string }}
 */
export function resolveCutoverPaths(dataRoot, legacyDir) {
  const base = path.resolve(dataRoot);
  return {
    legacyDir: path.resolve(legacyDir ?? path.join(base, 'chat-history')),
    controlDir: path.join(base, 'storage-control'),
    dbDir: path.join(base, 'storage'),
    pendingDir: path.join(base, 'storage-pending'),
  };
}

/** @param {string} dir @returns {string[]} names, [] when the directory is absent */
function listOrEmpty(dir) {
  const stat = lstatOrNull(dir);
  if (!stat) return [];
  if (!stat.isDirectory()) refuse('cutover_path_not_directory', 'A cutover path exists but is not a directory', { path: path.basename(dir) });
  return fs.readdirSync(dir);
}

/** @param {string} dir */
function assertEmptyOrAbsent(dir) {
  if (listOrEmpty(dir).length > 0) refuse('cutover_not_clean_slate', 'A new-backend path is not empty; the legacy backend must be the only one in place', { path: path.basename(dir) });
}

/**
 * Persisted phase record so a monitor or a restarted operator can see where an interrupted operation stopped.
 *
 * @param {string} opsDir
 * @param {string} opId
 */
export function createStatusWriter(opsDir, opId) {
  const file = path.join(opsDir, 'cutover-status.json');
  const state = { schema: CUTOVER_STATUS_SCHEMA, opId, state: 'running', phases: /** @type {Array<Record<string, unknown>>} */ ([]), error: /** @type {Record<string, unknown> | null} */ (null) };
  const flush = () => replaceOwnFileDurable(file, `${JSON.stringify(state, null, 2)}\n`);
  return {
    file,
    state,
    /** @param {string} name @param {string} status @param {Record<string, unknown>} [extra] */
    phase(name, status, extra = {}) {
      state.phases.push({ phase: name, status, at: new Date().toISOString(), ...extra });
      flush();
    },
    /** @param {string} finalState @param {Record<string, unknown> | null} [error] */
    finish(finalState, error = null) {
      state.state = finalState;
      state.error = error;
      flush();
    },
  };
}

/**
 * Evidence of the fresh safety backup: the snapshot tool's own status record, archive checksum and size. Fails if
 * the backup is missing, unpublished, older than allowed, or its archive no longer matches its recorded checksum.
 *
 * @param {{ backupOpDir: string, notBeforeMs?: number, maxAgeMs?: number, nowMs?: number, verifyArchiveHash?: boolean }} options
 */
export function verifyBackupEvidence(options) {
  const nowMs = options.nowMs ?? Date.now();
  let status;
  try {
    status = JSON.parse(fs.readFileSync(path.join(options.backupOpDir, 'status.json'), 'utf8'));
  } catch {
    return refuse('backup_status_missing', 'The backup operation record is missing or unreadable');
  }
  const archiveInfo = status?.result;
  if (status?.state !== 'published' || !archiveInfo?.archive || !/^[0-9a-f]{64}$/.test(String(archiveInfo.sha256))) {
    refuse('backup_not_published', 'The backup operation did not publish a verified archive', { state: String(status?.state) });
  }
  const restartOutcome = status?.restart?.outcome;
  if (restartOutcome && !['running-verified', 'already-running', 'not-needed'].includes(restartOutcome)) {
    refuse('backup_restart_not_verified', 'The service was not verified running after the backup', { outcome: String(restartOutcome) });
  }
  const finishedMs = Date.parse(String(status.finishedAt ?? status.updatedAt ?? ''));
  if (!Number.isFinite(finishedMs)) refuse('backup_time_unknown', 'The backup record has no completion time');
  if (options.notBeforeMs !== undefined && finishedMs < options.notBeforeMs) refuse('backup_stale', 'The backup finished before the required time', { finishedAt: new Date(finishedMs).toISOString() });
  const maxAge = options.maxAgeMs ?? DEFAULT_BACKUP_MAX_AGE_MS;
  if (nowMs - finishedMs > maxAge) refuse('backup_stale', 'The backup is older than the allowed age', { ageMs: nowMs - finishedMs, maxAgeMs: maxAge });
  const archive = path.join(options.backupOpDir, String(archiveInfo.archive));
  const stat = lstatOrNull(archive);
  if (!stat || !stat.isFile() || stat.size !== archiveInfo.bytes) refuse('backup_archive_mismatch', 'The backup archive is missing or has another size');
  const sumFile = `${archive}.sha256`;
  const recorded = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0];
  if (recorded !== archiveInfo.sha256) refuse('backup_checksum_mismatch', 'The checksum file differs from the operation record');
  if (options.verifyArchiveHash !== false && hashFile(archive).sha256 !== archiveInfo.sha256) refuse('backup_archive_corrupt', 'The archive no longer matches its recorded checksum');
  return { finishedAt: new Date(finishedMs).toISOString(), bytes: stat.size, sha256: String(archiveInfo.sha256), files: archiveInfo.files ?? null, archive: path.basename(archive) };
}

/**
 * Every precondition that can be checked while the service is still up. Read-only; also the first step of the
 * quiesced run, repeated there on the final state.
 *
 * @param {{ manifest: Record<string, any>, confirmManifestHash: string, nowMs?: number, verifyArchiveHash?: boolean }} options
 */
export function verifyCutoverMaterial(options) {
  const { manifest } = options;
  const { manifestHash, ...body } = manifest;
  if (manifest.schema !== CUTOVER_MANIFEST_SCHEMA || digestCanonical(body) !== manifestHash) refuse('cutover_manifest_tampered', 'The cutover manifest does not match its hash');
  if (options.confirmManifestHash !== manifestHash) refuse('cutover_manifest_not_confirmed', 'The confirmed manifest hash differs from the manifest');
  const paths = manifest.paths;
  const slate = {
    markerSource: readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } }),
  };
  if (slate.markerSource.source !== 'default' || slate.markerSource.backend !== 'legacy') {
    refuse('cutover_not_clean_slate', 'A backend marker already exists', { backend: slate.markerSource.backend });
  }
  assertEmptyOrAbsent(paths.dbDir);
  assertEmptyOrAbsent(paths.pendingDir);
  const controlNow = listOrEmpty(paths.controlDir);
  if (controlNow.some((name) => name === HISTORY_BACKEND_MARKER_FILE || name === HISTORY_CUTOVER_WITNESS_FILE)) refuse('cutover_not_clean_slate', 'Cutover control files already exist');
  if (!lstatOrNull(paths.legacyDir)?.isDirectory()) refuse('cutover_legacy_missing', 'The legacy history directory is missing');
  const backup = verifyBackupEvidence({
    backupOpDir: manifest.backup.opDir, notBeforeMs: Date.parse(manifest.backup.notBefore), maxAgeMs: manifest.backup.maxAgeMs,
    nowMs: options.nowMs, verifyArchiveHash: options.verifyArchiveHash,
  });
  if (backup.sha256 !== manifest.backup.sha256) refuse('backup_changed_since_prepare', 'The backup archive is not the one the manifest names');
  const code = JSON.parse(fs.readFileSync(path.join(manifest.opsDir, 'code', 'manifest.json'), 'utf8'));
  if (code.manifestHash !== manifest.code.manifestHash) refuse('code_manifest_changed', 'The code manifest is not the one the cutover manifest names');
  assertCodeMaterialUnchanged({ mainRoot: manifest.paths.mainRoot, manifest: code, candidatesDir: path.join(manifest.opsDir, 'code', 'candidates') });
  const space = fs.statfsSync(manifest.opsDir);
  const freeOps = Number(space.bavail) * Number(space.bsize);
  if (freeOps < manifest.space.opsBytesRequired) refuse('cutover_insufficient_space', 'Not enough free space for the staging import', { required: manifest.space.opsBytesRequired, free: freeOps });
  const dataSpace = fs.statfsSync(path.dirname(paths.dbDir));
  const freeData = Number(dataSpace.bavail) * Number(dataSpace.bsize);
  if (freeData < manifest.space.dataBytesRequired) refuse('cutover_insufficient_space', 'Not enough free space on the data filesystem for the store', { required: manifest.space.dataBytesRequired, free: freeData });
  return { backup, code: { entries: code.entries.length, counts: code.counts }, controlPreexisting: controlNow.length > 0 };
}

/**
 * Strict source validation on the quiesced legacy directory. `minQuietMs: 0` because the caller proved the
 * writers are gone; the plan hash is the identity of the exact bytes the import will consume.
 *
 * @param {Record<string, any>} manifest
 */
export function planQuiescedSource(manifest) {
  const plan = planLegacyImport({ legacyDir: manifest.paths.legacyDir, datasetGeneration: manifest.datasetGeneration, minQuietMs: 0 });
  if (!plan.ok) refuse('source_plan_refused', 'The legacy directory has refusals', { refusals: plan.refusals.length, codes: [...new Set(plan.refusals.map((item) => item.code))].slice(0, 10) });
  if (plan.totals.warnings > 0) refuse('source_plan_has_warnings', 'The legacy directory has import warnings; they are not accepted silently', { warnings: plan.totals.warnings });
  if (plan.totals.chats < manifest.expect.minChats) refuse('source_below_expected', 'The legacy directory has fewer chats than the preflight floor', { chats: plan.totals.chats, minChats: manifest.expect.minChats });
  if (plan.protectedIgnored.some((item) => !PROTECTED_IGNORE_FILES.includes(item.file))) refuse('source_unexpected_protected', 'Unexpected protected entry');
  return plan;
}

/**
 * Publish the verified store file as the new `dbDir`: partial directory on the same filesystem, hash re-check,
 * one rename. Recorded in the journal so an interrupted run is recoverable.
 *
 * @param {{ stagingDir: string, dbDir: string, expectedSha256: string, opId: string }} options
 */
export function publishStoreDirectory(options) {
  const parent = path.dirname(options.dbDir);
  const partial = path.join(parent, `.${path.basename(options.dbDir)}.cutover-${options.opId}.partial`);
  if (lstatOrNull(partial)) refuse('cutover_partial_exists', 'A partial store directory from an earlier attempt exists; move it aside deliberately');
  assertEmptyOrAbsent(options.dbDir);
  fs.mkdirSync(partial, { mode: 0o700 });
  const target = path.join(partial, DEFAULT_STORAGE_DB_FILENAME);
  fs.copyFileSync(path.join(options.stagingDir, DEFAULT_STORAGE_DB_FILENAME), target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  const fd = fs.openSync(target, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (hashFile(target).sha256 !== options.expectedSha256) {
    fs.rmSync(partial, { recursive: true, force: true });
    refuse('cutover_store_copy_mismatch', 'The copied store differs from the verified staging store');
  }
  fsyncDirectory(partial);
  if (lstatOrNull(options.dbDir)) fs.rmdirSync(options.dbDir);
  fs.renameSync(partial, options.dbDir);
  fsyncDirectory(parent);
}

/**
 * Select `sqlite` for the verified generation through a live coordinator lease (witness first, then marker), then
 * give the lease up so the server acquires the next epoch itself.
 *
 * @param {{ controlDir: string, datasetGeneration: string, opId: string }} options
 */
export function selectSqliteThroughCoordinator(options) {
  fs.mkdirSync(options.controlDir, { recursive: true, mode: 0o700 });
  const coordinator = createStorageCoordinator({ controlDir: options.controlDir, autoRenew: false });
  try {
    coordinator.acquire();
    return selectHistoryBackend({
      controlDir: options.controlDir, coordinator, backend: 'sqlite', expectedRevision: 0, confirmCutover: true,
      selectedBy: `${MARKER_ACTOR_PREFIX}${options.opId}`, datasetGeneration: options.datasetGeneration,
    });
  } finally {
    try {
      coordinator.release();
    } catch { /* a lease that cannot be released expires by TTL */ }
  }
}

/**
 * Undo everything this operation created BEFORE the marker was committed: code (journal), the store directory and
 * any control files. Nothing is deleted - the store and control files are moved into `<opsDir>/aborted`.
 *
 * @param {{ manifest: Record<string, any>, stamp: string, controlPreexisting?: boolean }} options
 * @returns {{ movedStore: boolean, movedControl: boolean, codeReverted: number, codeRefused: string[] }}
 */
export function abortBeforeMarker(options) {
  const { manifest } = options;
  const aborted = path.join(manifest.opsDir, 'aborted', options.stamp);
  fs.mkdirSync(aborted, { recursive: true, mode: 0o700 });
  let movedStore = false;
  let movedControl = false;
  if (lstatOrNull(manifest.paths.dbDir)) {
    fs.renameSync(manifest.paths.dbDir, path.join(aborted, 'storage'));
    movedStore = true;
  }
  for (const name of [HISTORY_BACKEND_MARKER_FILE, HISTORY_CUTOVER_WITNESS_FILE]) {
    const file = path.join(manifest.paths.controlDir, name);
    if (lstatOrNull(file)) {
      fs.mkdirSync(path.join(aborted, 'storage-control'), { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(aborted, 'storage-control', name));
      movedControl = true;
    }
  }
  // A control directory this operation created and nothing else uses goes with it (the coordinator's own files only).
  if (options.controlPreexisting === false && lstatOrNull(manifest.paths.controlDir)) {
    fs.renameSync(manifest.paths.controlDir, path.join(aborted, 'storage-control-all'));
    movedControl = true;
  }
  const journalFile = path.join(manifest.opsDir, 'code', 'journal.json');
  let codeReverted = 0;
  /** @type {string[]} */
  let codeRefused = [];
  if (lstatOrNull(journalFile)) {
    const report = revertCodeApply({ mainRoot: manifest.paths.mainRoot, checkpointDir: path.join(manifest.opsDir, 'code', 'checkpoint'), journalFile });
    codeReverted = report.reverted;
    codeRefused = report.refused;
  }
  fsyncDirectory(path.dirname(manifest.paths.dbDir));
  return { movedStore, movedControl, codeReverted, codeRefused };
}

/**
 * Attach the machine-readable end state to a thrown error (`cutoverOutcome`); the CLI turns it into the durable
 * hook proof the snapshot helper requires before it may restart the service.
 *
 * @param {unknown} error @param {string} outcome @returns {unknown}
 */
function tagOutcome(error, outcome) {
  if (error && typeof error === 'object') /** @type {any} */ (error).cutoverOutcome = outcome;
  return error;
}

/**
 * The quiesced cutover. Returns a codes-and-counts result; throws (after aborting before the marker) on any failure.
 *
 * @param {{ manifest: Record<string, any>, confirmManifestHash: string, faultHook?: (point: string) => void, nowMs?: () => number }} options
 */
export function runQuiescedCutover(options) {
  const { manifest } = options;
  const hook = options.faultHook ?? (() => {});
  const status = createStatusWriter(manifest.opsDir, manifest.opId);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let markerCommitted = false;
  /** True once this run may have written code, the store or control files - only then is anything undone. */
  let mutated = false;
  let controlPreexisting = true;
  /** @type {Record<string, any>} */
  const result = { opId: manifest.opId, datasetGeneration: manifest.datasetGeneration };
  try {
    status.phase('verify-material', 'start');
    const material = verifyCutoverMaterial({ manifest, confirmManifestHash: options.confirmManifestHash, nowMs: options.nowMs?.() });
    controlPreexisting = material.controlPreexisting;
    result.backup = { sha256: material.backup.sha256, finishedAt: material.backup.finishedAt };
    status.phase('verify-material', 'ok', { codeEntries: material.code.entries });

    status.phase('source-plan', 'start');
    const plan = planQuiescedSource(manifest);
    result.source = { ...plan.totals, planHash: plan.planHash, protectedIgnored: plan.protectedIgnored.length };
    status.phase('source-plan', 'ok', { chats: plan.totals.chats, events: plan.totals.events });
    hook('after-source-plan');

    status.phase('staging-import', 'start');
    const stagingDir = path.join(manifest.opsDir, `staging-${manifest.datasetGeneration}-${stamp}`);
    const imported = applyLegacyImport({
      legacyDir: manifest.paths.legacyDir, datasetGeneration: manifest.datasetGeneration, stagingOut: stagingDir,
      confirmPlanHash: plan.planHash, minQuietMs: 0,
    });
    status.phase('staging-import', 'ok', { chats: imported.manifest.totals.chats });

    status.phase('verify-import', 'start');
    verifyImportStaging({ stagingDir, legacyDir: manifest.paths.legacyDir });
    const importManifest = imported.manifest;
    if (importManifest.datasetGeneration !== manifest.datasetGeneration || importManifest.planHash !== plan.planHash
      || importManifest.totals.chats !== plan.totals.chats || importManifest.totals.events !== plan.totals.events) {
      refuse('cutover_import_mismatch', 'The import manifest does not describe the planned source');
    }
    const staged = openImmutableDatabase(path.join(stagingDir, DEFAULT_STORAGE_DB_FILENAME));
    try {
      if (readDatasetBinding(staged) !== manifest.datasetGeneration) refuse('cutover_binding_mismatch', 'The staged store is not bound to the cutover generation');
    } finally {
      staged.close();
    }
    const again = planLegacyImport({ legacyDir: manifest.paths.legacyDir, datasetGeneration: manifest.datasetGeneration, minQuietMs: 0 });
    if (again.planHash !== plan.planHash) refuse('cutover_source_changed', 'The legacy directory changed during the import');
    result.import = { manifestHash: importManifest.manifestHash, dbSha256: importManifest.db.sha256, schemaVersion: importManifest.db.schemaVersion };
    result.controlPreexisting = controlPreexisting;
    // Recorded BEFORE any main/data write so a pre-ACK rollback or a recovery always knows what was imported.
    replaceOwnFileDurable(path.join(manifest.opsDir, 'cutover-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    status.phase('verify-import', 'ok', { manifestHash: importManifest.manifestHash });
    hook('after-verify-import');

    status.phase('code-apply', 'start');
    mutated = true;
    const codeManifest = JSON.parse(fs.readFileSync(path.join(manifest.opsDir, 'code', 'manifest.json'), 'utf8'));
    const code = applyCodeCandidates({
      mainRoot: manifest.paths.mainRoot, manifest: codeManifest, candidatesDir: path.join(manifest.opsDir, 'code', 'candidates'),
      checkpointDir: path.join(manifest.opsDir, 'code', 'checkpoint'), journalFile: path.join(manifest.opsDir, 'code', 'journal.json'),
    });
    result.code = code;
    status.phase('code-apply', 'ok', code);
    hook('after-code-apply');

    status.phase('publish-store', 'start');
    publishStoreDirectory({ stagingDir, dbDir: manifest.paths.dbDir, expectedSha256: importManifest.db.sha256, opId: manifest.opId });
    status.phase('publish-store', 'ok');
    hook('after-publish-store');

    status.phase('select-backend', 'start');
    const marker = selectSqliteThroughCoordinator({ controlDir: manifest.paths.controlDir, datasetGeneration: manifest.datasetGeneration, opId: manifest.opId });
    markerCommitted = true;
    hook('after-marker');
    const verified = readHistoryBackendMarker(manifest.paths.controlDir, { traceDirs: { dbDir: manifest.paths.dbDir, pendingDir: manifest.paths.pendingDir } });
    if (verified.backend !== 'sqlite' || verified.revision !== marker.revision || verified.datasetGeneration !== manifest.datasetGeneration) {
      refuse('cutover_marker_verify_failed', 'The marker read back differently');
    }
    const last = planLegacyImport({ legacyDir: manifest.paths.legacyDir, datasetGeneration: manifest.datasetGeneration, minQuietMs: 0 });
    if (last.planHash !== plan.planHash) refuse('cutover_source_changed', 'The legacy directory changed after the cutover');
    result.marker = { backend: verified.backend, revision: verified.revision };
    status.phase('select-backend', 'ok', { revision: verified.revision });
    replaceOwnFileDurable(path.join(manifest.opsDir, 'cutover-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    status.finish('cutover-committed');
    return result;
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? 'INTERNAL');
    if (markerCommitted) {
      // Past the point of no return: nothing is undone here; the operator decides between fixing forward and the
      // pre-ACK rollback (which re-checks that no durable write exists).
      status.finish('failed-after-marker', { code });
      throw tagOutcome(error, 'failed-after-marker');
    }
    if (!mutated) {
      // Nothing outside the operation directory was written: an earlier (possibly committed) cutover is not ours to undo.
      status.finish('failed-before-writes', { code });
      throw tagOutcome(error, 'failed-before-writes');
    }
    let undo = null;
    try {
      undo = abortBeforeMarker({ manifest, stamp, controlPreexisting });
    } catch (abortError) {
      status.finish('abort-failed', { code, abortCode: String(/** @type {any} */ (abortError)?.code ?? 'INTERNAL') });
      throw tagOutcome(error, 'abort-failed');
    }
    status.finish('aborted-before-marker', { code, ...undo });
    throw tagOutcome(error, undo.codeRefused.length === 0 ? 'aborted-before-marker' : 'abort-failed');
  }
}

/**
 * Finish what an interrupted run left behind (quiesced window). Marker absent: abort everything created so far.
 * Marker present: nothing is undone automatically; the caller gets the facts and chooses fix-forward or the
 * pre-ACK rollback.
 *
 * @param {{ manifest: Record<string, any>, confirmManifestHash: string }} options
 */
export function recoverInterrupted(options) {
  const { manifest } = options;
  const { manifestHash, ...body } = manifest;
  if (digestCanonical(body) !== manifestHash || options.confirmManifestHash !== manifestHash) refuse('cutover_manifest_not_confirmed', 'The confirmed manifest hash differs from the manifest');
  const markerFile = path.join(manifest.paths.controlDir, HISTORY_BACKEND_MARKER_FILE);
  if (lstatOrNull(markerFile)) {
    return { action: 'none', reason: 'marker_present', next: 'rollback-precutover (pre-ACK) or fix forward; nothing was changed' };
  }
  let controlPreexisting = true;
  try {
    controlPreexisting = JSON.parse(fs.readFileSync(path.join(manifest.opsDir, 'cutover-result.json'), 'utf8')).controlPreexisting !== false;
  } catch { /* no result file: only the marker files and the store are moved */ }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const undo = abortBeforeMarker({ manifest, stamp, controlPreexisting });
  return { action: 'aborted', ...undo };
}

/** @param {string} dir @returns {number} count of files below dir (0 when absent) */
function countFiles(dir) {
  const stat = lstatOrNull(dir);
  if (!stat) return 0;
  if (!stat.isDirectory()) return 1;
  return fs.readdirSync(dir).reduce((sum, name) => sum + countFiles(path.join(dir, name)), 0);
}

/**
 * Logical state of the live store, read through a read-only connection. Counts only.
 *
 * @param {string} dbDir
 */
export function readStoreCounts(dbDir) {
  const db = new DatabaseSync(path.join(dbDir, DEFAULT_STORAGE_DB_FILENAME), { readOnly: true });
  try {
    const one = (sql) => Number(db.prepare(sql).get().n);
    return {
      binding: readDatasetBinding(db),
      schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
      chats: one('SELECT count(*) AS n FROM chat_history_state'),
      events: one('SELECT count(*) AS n FROM chat_history_events'),
      importedEvents: one("SELECT count(*) AS n FROM chat_history_events WHERE producer_id = 'legacy-import'"),
      receipts: one('SELECT count(*) AS n FROM command_receipts'),
      dedupeRows: one('SELECT count(*) AS n FROM chat_history_dedupe'),
      integrity: String(db.prepare('PRAGMA quick_check').get().quick_check),
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
    };
  } finally {
    db.close();
  }
}

/**
 * Pre-ACK rollback (quiesced window): allowed only while the new backend holds exactly the imported dataset and
 * nothing is pending. Anything else means a durable write exists and the old backup must not be restored over it.
 *
 * @param {{ manifest: Record<string, any>, confirmManifestHash: string }} options
 */
export function rollbackPreCutover(options) {
  const { manifest } = options;
  const { manifestHash, ...body } = manifest;
  if (digestCanonical(body) !== manifestHash || options.confirmManifestHash !== manifestHash) refuse('cutover_manifest_not_confirmed', 'The confirmed manifest hash differs from the manifest');
  const paths = manifest.paths;
  const marker = readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } });
  if (marker.backend !== 'sqlite' || marker.revision !== 1 || marker.selectedBy !== `${MARKER_ACTOR_PREFIX}${manifest.opId}`) {
    refuse('rollback_not_this_cutover', 'The marker is not the one this operation wrote', { backend: marker.backend, revision: marker.revision });
  }
  const counts = readStoreCounts(paths.dbDir);
  const pendingFiles = countFiles(paths.pendingDir);
  const imported = JSON.parse(fs.readFileSync(path.join(manifest.opsDir, 'cutover-result.json'), 'utf8'));
  const ackSignals = [
    counts.receipts > 0, counts.events !== counts.importedEvents, counts.events !== imported.source.events,
    counts.chats !== imported.source.chats, counts.dedupeRows > 0, pendingFiles > 0,
  ];
  if (ackSignals.some(Boolean)) {
    refuse('rollback_post_cutover_ack_exists', 'The new backend holds durable writes or pending work; use the read-only rollback export, never an old backup', { receipts: counts.receipts, nonImportedEvents: counts.events - counts.importedEvents, pendingFiles });
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const undo = abortBeforeMarker({ manifest, stamp, controlPreexisting: imported.controlPreexisting });
  const after = readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } });
  if (after.source !== 'default' || after.backend !== 'legacy') refuse('rollback_marker_still_set', 'The legacy default did not come back');
  return { ...undo, backend: after.backend };
}

/** Most recent receipts / chats recorded as durability anchors in one evidence file. */
const EVIDENCE_ANCHOR_LIMIT = 200;

/**
 * Receipt/event anchors for retention-aware durability proof. Metadata only: command ids, digests, a hash of the stored
 * result and per-chat epoch/watermarks; never event or result text.
 *
 * @param {DatabaseSync} db
 * @param {{ chatId: string, seq: number }[]} newEvents
 */
function readDurabilityAnchors(db, newEvents) {
  const receipts = db.prepare(`SELECT command_id, request_digest, result_json, created_at FROM command_receipts
    ORDER BY created_at DESC, command_id DESC LIMIT ${EVIDENCE_ANCHOR_LIMIT}`).all().map((row) => ({
    commandId: String(row.command_id), requestDigest: String(row.request_digest),
    resultHash: createHash('sha256').update(String(row.result_json)).digest('hex'), createdAt: Number(row.created_at),
  }));
  const stateStmt = db.prepare('SELECT chat_epoch, next_seq, trimmed_through_seq FROM chat_history_state WHERE chat_id = ?');
  const chats = {};
  for (const chatId of new Set(newEvents.map((e) => e.chatId))) {
    const row = stateStmt.get(chatId);
    chats[chatId] = row ? { epoch: String(row.chat_epoch), nextSeq: Number(row.next_seq), trimmedThroughSeq: Number(row.trimmed_through_seq) } : null;
  }
  return { receipts, chats };
}

/**
 * Compare earlier evidence with the live store without mistaking legal retention for loss. Trimmed events (seq at or
 * below the chat's trim watermark in the same epoch), reset/deleted chats are legal;
 * any receipt from the earlier evidence that is gone from the store (there is no receipt GC or fencing proof), a changed
 * digest/result or a regressed head is not.
 *
 * @param {DatabaseSync} db @param {Record<string, any>} previous @param {{ receipts: any[], chats: Record<string, any> }} anchors
 * @returns {string[]} problem codes
 */
function compareWithPrevious(db, previous, anchors) {
  const problems = [];
  const probe = db.prepare('SELECT 1 AS present FROM chat_history_events WHERE chat_id = ? AND seq = ?');
  const stateStmt = db.prepare('SELECT chat_epoch, next_seq, trimmed_through_seq FROM chat_history_state WHERE chat_id = ?');
  for (const item of previous.newEvents ?? []) {
    if (probe.get(item.chatId, item.seq)) continue;
    const state = stateStmt.get(item.chatId);
    const before = previous.anchors?.chats?.[item.chatId];
    if (!state) continue; // chat deleted
    if (!before || String(state.chat_epoch) !== before.epoch) continue; // reset/new epoch
    if (item.seq <= Number(state.trimmed_through_seq)) continue; // retention trim
    problems.push('earlier_write_missing');
  }
  for (const [chatId, before] of Object.entries(previous.anchors?.chats ?? {})) {
    const now = anchors.chats[chatId] ?? (() => {
      const row = stateStmt.get(chatId);
      return row ? { epoch: String(row.chat_epoch), nextSeq: Number(row.next_seq) } : null;
    })();
    if (before && now && now.epoch === before.epoch && now.nextSeq < before.nextSeq) problems.push('chat_head_regressed');
  }
  const current = new Map(anchors.receipts.map((r) => [r.commandId, r]));
  const lookup = db.prepare('SELECT request_digest, result_json FROM command_receipts WHERE command_id = ?');
  for (const old of previous.anchors?.receipts ?? []) {
    const hit = current.get(old.commandId);
    if (hit) {
      if (hit.requestDigest !== old.requestDigest || hit.resultHash !== old.resultHash) problems.push('receipt_changed');
      continue;
    }
    const row = lookup.get(old.commandId);
    if (row) {
      const hash = createHash('sha256').update(String(row.result_json)).digest('hex');
      if (String(row.request_digest) !== old.requestDigest || hash !== old.resultHash) problems.push('receipt_changed');
      continue;
    }
    // Receipts are never garbage-collected, so a receipt absent by primary key is lost data, however old it is.
    problems.push('earlier_receipt_missing');
  }
  return [...new Set(problems)];
}

/**
 * Read-only evidence of the live store after a (re)start. `previous` (an earlier evidence file) proves durability
 * with receipt anchors and per-chat watermarks, so retention trims, resets, deletes and coalescing never look like loss
 * while a really lost acknowledged write still fails.
 *
 * @param {{ manifest: Record<string, any>, previous?: Record<string, any> | null }} options
 */
export function collectPostCutoverEvidence(options) {
  const { manifest } = options;
  const paths = manifest.paths;
  const marker = readHistoryBackendMarker(paths.controlDir, { traceDirs: { dbDir: paths.dbDir, pendingDir: paths.pendingDir } });
  const problems = [];
  if (marker.backend !== 'sqlite' || marker.datasetGeneration !== manifest.datasetGeneration) problems.push('marker_not_sqlite_for_generation');
  const counts = readStoreCounts(paths.dbDir);
  if (counts.binding !== manifest.datasetGeneration) problems.push('store_binding_mismatch');
  if (counts.integrity !== 'ok' || counts.foreignKeyViolations !== 0) problems.push('store_integrity');
  const result = JSON.parse(fs.readFileSync(path.join(manifest.opsDir, 'cutover-result.json'), 'utf8'));
  // Retention, reset and delete legally shrink the imported set; only growth beyond the import is impossible.
  if (counts.importedEvents > result.source.events) problems.push('imported_events_changed');
  const db = new DatabaseSync(path.join(paths.dbDir, DEFAULT_STORAGE_DB_FILENAME), { readOnly: true });
  let newEvents = [];
  let anchors = { receipts: [], chats: {} };
  try {
    newEvents = db.prepare("SELECT chat_id, seq FROM chat_history_events WHERE producer_id <> 'legacy-import' ORDER BY chat_id, seq LIMIT 200").all()
      .map((row) => ({ chatId: String(row.chat_id), seq: Number(row.seq) }));
    anchors = readDurabilityAnchors(db, newEvents);
    if (options.previous) problems.push(...compareWithPrevious(db, options.previous, anchors));
  } finally {
    db.close();
  }
  const pendingFiles = countFiles(path.join(paths.pendingDir, 'entries'));
  const quarantined = countFiles(path.join(paths.pendingDir, 'quarantine'));
  if (quarantined > 0) problems.push('pending_quarantine_not_empty');
  return {
    schema: CUTOVER_EVIDENCE_SCHEMA, opId: manifest.opId, at: new Date().toISOString(), ok: problems.length === 0, problems,
    marker: { backend: marker.backend, revision: marker.revision, source: marker.source },
    counts, newEventCount: counts.events - counts.importedEvents, newEvents, anchors, pending: { entries: pendingFiles, quarantined },
  };
}

/**
 * Rollback rehearsal on an ISOLATED copy of the live store (SQLite backup API; the live file is only read). Runs
 * export plan -> apply -> verify and reports whether post-cutover writes were part of the rehearsal.
 *
 * @param {{ manifest: Record<string, any>, scratchDir: string }} options
 */
export async function rehearseRollbackOnCopy(options) {
  const { manifest, scratchDir } = options;
  const { backup } = await import('node:sqlite');
  if (lstatOrNull(scratchDir)) refuse('rehearsal_scratch_exists', 'The rehearsal scratch directory already exists');
  const copyDir = path.join(scratchDir, 'store');
  fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
  const live = new DatabaseSync(path.join(manifest.paths.dbDir, DEFAULT_STORAGE_DB_FILENAME), { readOnly: true });
  const copyFile = path.join(copyDir, DEFAULT_STORAGE_DB_FILENAME);
  try {
    await backup(live, copyFile);
  } finally {
    live.close();
  }
  const copy = new DatabaseSync(copyFile);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    copy.close();
  }
  const plan = planRollbackExport({ storeDir: copyDir });
  const out = path.join(scratchDir, 'export');
  const applied = applyRollbackExport({ storeDir: copyDir, legacyOut: out, confirmPlanHash: plan.planHash });
  const verified = verifyRollbackExport({ exportDir: out, storeDir: copyDir });
  const counts = readStoreCounts(copyDir);
  return {
    ok: true, chats: plan.chats.length, manifestHash: applied.manifest.manifestHash, verified: verified.ok !== false,
    postCutoverEvents: counts.events - counts.importedEvents, includesPostCutoverWrites: counts.events > counts.importedEvents,
  };
}

/** @returns {string} operation id (UTC time + random), safe in file names and marker actors */
export function newOperationId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}
