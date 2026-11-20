/**
 * Retention of `command_receipts` (A3a, protocol: lib/storage/receipts.md "Retention").
 *
 * Three pieces, split by thread:
 *
 * - worker thread: `pruneReceiptBatch()` deletes ONE small batch of expired receipts inside the storage worker's
 *   own write transaction (control op `receipts.prune`). One batch is one request, so the host queue interleaves
 *   normal commands between batches (the yield) and a batch stays far below the execution watchdog.
 * - an ephemeral worker thread: `planReceiptsPrune()` and `backupBeforePrune()` run on separate connections
 *   (WAL readers) because a `VACUUM INTO` of a multi-GB store would trip the storage worker's execution watchdog
 *   and block its queue. Nothing here ever runs on the main thread except the scheduler timers.
 * - main thread: `createReceiptsRetention()` schedules the periodic run (first run after a delay) and drives
 *   plan -> backup -> batches.
 *
 * Safety rule: if a run would remove more than `BACKUP_ROW_FRACTION` of the rows, a verified consistent copy
 * must exist in the backup dir first; without it nothing is deleted. Copies are never deleted automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { StorageError, STORAGE_ERROR_CODES } from './errors.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';

/**
 * Retry window kept in the store. A receipt is only read to deduplicate a retry of the same commandId or to
 * reconcile an `unknown_commit` (`resolveUnknown`); both happen within seconds to minutes of the original call
 * (callers persist pending commands for at most a day, retry tokens are single-session). 7 days leaves a wide
 * margin for a server that was down over a long weekend with pending work.
 */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows deleted per worker transaction. */
export const DEFAULT_PRUNE_BATCH_ROWS = 5000;
/** A run removing more than this fraction of the rows needs the pre-prune copy first. */
export const BACKUP_ROW_FRACTION = 0.1;
/** Infix of the copy file name: `<store file>-pre-receipts-prune-<ts>.sqlite`. */
export const PRUNE_BACKUP_INFIX = '-pre-receipts-prune-';
/** Pages released per batch when the file uses `auto_vacuum = INCREMENTAL`. */
const INCREMENTAL_VACUUM_PAGES = 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 2 * 60 * 1000;
const JOB_KEY = 'cretliReceiptsRetentionJob';

/** @param {string} backupDir @param {string} filename @returns {string[]} verified copies of this store file */
export function findPruneBackups(backupDir, filename) {
  const prefix = `${filename}${PRUNE_BACKUP_INFIX}`;
  try {
    return fs.readdirSync(backupDir).filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite')).sort();
  } catch {
    return [];
  }
}

/**
 * Worker side: delete up to `batchRows` receipts older than `cutoff` in one write transaction. Walks the
 * `(dataset_generation, created_at)` index per generation. The generations come from the run's plan (computed once
 * per run); without them the batch falls back to one `SELECT DISTINCT` index scan, which is O(table).
 *
 * @param {DatabaseSync} db
 * @param {{ cutoff: number, batchRows?: number, generations?: string[], requireBackup?: { dir: string, filename: string } | null }} params
 * @param {() => void} [beforeWrite] fence check, runs right after BEGIN IMMEDIATE
 * @returns {{ deleted: number, more: boolean, freelistPages: number }}
 */
export function pruneReceiptBatch(db, params, beforeWrite) {
  const cutoff = Number(params?.cutoff);
  const batchRows = params?.batchRows ?? DEFAULT_PRUNE_BATCH_ROWS;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > 100000) {
    throw new StorageError(STORAGE_ERROR_CODES.IO, 'Invalid receipts prune parameters', {
      retryable: false, details: { operation: 'receipts_prune', commitState: 'not_committed' },
    });
  }
  const req = params.requireBackup;
  if (req && findPruneBackups(req.dir, req.filename).length === 0) {
    throw new StorageError(STORAGE_ERROR_CODES.CONFLICT, 'Receipts prune needs a verified pre-prune copy first', {
      retryable: false, details: { operation: 'receipts_prune', conflictKind: 'receipts_backup_missing', commitState: 'not_committed' },
    });
  }
  let deleted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    beforeWrite?.();
    const generations = Array.isArray(params.generations) && params.generations.every((g) => typeof g === 'string')
      ? params.generations
      : db.prepare('SELECT DISTINCT dataset_generation AS g FROM command_receipts').all().map((r) => String(r.g));
    const del = db.prepare(`DELETE FROM command_receipts WHERE dataset_generation = ? AND command_id IN (
      SELECT command_id FROM command_receipts WHERE dataset_generation = ? AND created_at < ? LIMIT ?)`);
    for (const g of generations) {
      if (deleted >= batchRows) break;
      deleted += Number(del.run(g, g, cutoff, batchRows - deleted).changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  // Free pages are reused by later receipts; the file only shrinks when the database uses INCREMENTAL auto_vacuum.
  if (deleted > 0 && Number(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum) === 2) {
    db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
  }
  return {
    deleted,
    more: deleted >= batchRows,
    freelistPages: Number(db.prepare('PRAGMA freelist_count').get().freelist_count),
  };
}

/**
 * Read-only plan of a run (separate connection): how many rows exist and how many are expired.
 *
 * @param {{ dbPath: string, cutoff: number }} args
 * @returns {{ total: number, expired: number, needsBackup: boolean, generations: string[] }}
 */
export function planReceiptsPrune({ dbPath, cutoff }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const total = Number(db.prepare('SELECT count(*) AS n FROM command_receipts').get().n);
    let expired = 0;
    const count = db.prepare('SELECT count(*) AS n FROM command_receipts WHERE dataset_generation = ? AND created_at < ?');
    const generations = db.prepare('SELECT DISTINCT dataset_generation AS g FROM command_receipts').all().map((r) => String(r.g));
    for (const g of generations) expired += Number(count.get(g, cutoff).n);
    return { total, expired, generations, needsBackup: expired > 0 && expired > total * BACKUP_ROW_FRACTION };
  } finally {
    db.close();
  }
}

/** @param {DatabaseSync} db @returns {Record<string, number>} row counts of every table except receipts and sqlite internals */
function domainCounts(db) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'command_receipts' ORDER BY name").all()) {
    out[String(t.name)] = Number(db.prepare(`SELECT count(*) AS n FROM "${String(t.name).replaceAll('"', '""')}"`).get().n);
  }
  return out;
}

/**
 * Consistent copy via `VACUUM INTO` on a separate read connection, written under a temp name, opened again and
 * compared (row counts of every non-receipt table, e.g. the decisions) and only then renamed to its final name.
 * Throws on any failure and leaves no final file, so a failed backup means no prune.
 *
 * @param {{ dbPath: string, backupDir: string, filename: string, now?: number }} args
 * @returns {{ path: string, tables: Record<string, number> }}
 */
export function backupBeforePrune({ dbPath, backupDir, filename, now = Date.now() }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const finalPath = path.join(backupDir, `${filename}${PRUNE_BACKUP_INFIX}${stamp}.sqlite`);
  const tmpPath = `${finalPath}.tmp`;
  fs.rmSync(tmpPath, { force: true });
  // VACUUM INTO needs roughly the live size; refuse early instead of filling the disk.
  const need = fs.statSync(dbPath).size;
  const stat = fs.statfsSync(backupDir);
  if (Number(stat.bavail) * Number(stat.bsize) < need * 1.1) throw new Error('not enough free space for the pre-prune copy');
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout = 5000');
    const before = domainCounts(src);
    src.prepare('VACUUM INTO ?').run(tmpPath);
    const after = domainCounts(src);
    const copy = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const copied = domainCounts(copy);
      // The source keeps serving writes; accept a copy equal to the state before or after the copy ran.
      const same = (a) => JSON.stringify(a) === JSON.stringify(copied);
      if (!same(before) && !same(after)) throw new Error('backup copy row counts differ from the source');
      fs.renameSync(tmpPath, finalPath);
      return { path: finalPath, tables: copied };
    } finally {
      copy.close();
    }
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    src.close();
  }
}

/** Ephemeral worker entry: runs one job off the main and storage threads. */
if (!isMainThread && workerData?.[JOB_KEY]) {
  const job = workerData[JOB_KEY];
  try {
    const result = job.kind === 'plan' ? planReceiptsPrune(job) : backupBeforePrune(job);
    parentPort?.postMessage({ ok: true, result });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(/** @type {any} */ (err)?.message ?? err) });
  }
}

/**
 * @param {Record<string, unknown>} job
 * @returns {Promise<any>}
 */
function runJob(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { [JOB_KEY]: job } });
    worker.once('message', (msg) => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))));
    worker.once('error', reject);
    // A no-op after resolve/reject; covers a worker that exits (even with 0) without answering.
    worker.once('exit', (code) => reject(new Error(`receipts retention worker exited with ${code} without a result`)));
  });
}

/**
 * Scheduler for one store. `runOnce()` is also the manual / test entry point.
 *
 * @param {{
 *   host: { control: Function },
 *   dbPath: string,
 *   backupDir: string,
 *   writeGate?: any,
 *   retentionMs?: number,
 *   batchRows?: number,
 *   intervalMs?: number,
 *   startDelayMs?: number,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function createReceiptsRetention(options) {
  const { host, dbPath, backupDir } = options;
  const filename = path.basename(dbPath);
  const retentionMs = options.retentionMs ?? RECEIPT_RETENTION_MS;
  const batchRows = options.batchRows ?? DEFAULT_PRUNE_BATCH_ROWS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line) => console.log(line));
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let stopped = false;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: 'running' };
    running = true;
    try {
      assertWriteAllowed(options.writeGate);
      const cutoff = now() - retentionMs;
      const plan = await runJob({ kind: 'plan', dbPath, cutoff });
      if (plan.expired === 0) return { deleted: 0, plan };
      let requireBackup = null;
      if (plan.needsBackup && findPruneBackups(backupDir, filename).length === 0) {
        const copy = await runJob({ kind: 'backup', dbPath, backupDir, filename, now: now() });
        log(`[receipts-retention] backup ${copy.path}`);
      }
      if (plan.needsBackup) requireBackup = { dir: backupDir, filename };
      let deleted = 0;
      for (;;) {
        if (stopped) break;
        assertWriteAllowed(options.writeGate);
        const batch = await host.control('receipts.prune', {}, { cutoff, batchRows, generations: plan.generations, requireBackup });
        deleted += batch.deleted;
        if (!batch.more) break;
        // Yield to the event loop so queued commands and timers run between batches.
        await new Promise((resolve) => setImmediate(resolve));
      }
      log(`[receipts-retention] ${filename}: deleted ${deleted} of ${plan.total}`);
      return { deleted, plan };
    } finally {
      running = false;
    }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(() => {
      runOnce().catch((err) => log(`[receipts-retention] ${filename} failed: ${err?.message ?? err}`)).finally(() => schedule(options.intervalMs ?? DEFAULT_INTERVAL_MS));
    }, delay);
    timer.unref?.();
  }

  return Object.freeze({
    runOnce,
    start() { schedule(options.startDelayMs ?? DEFAULT_START_DELAY_MS); },
    stop() { stopped = true; if (timer) clearTimeout(timer); },
  });
}
