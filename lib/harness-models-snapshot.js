/**
 * Shared on-disk snapshot of refreshed harness model catalogs.
 * Read paths (harness-catalog) stay network-free; only the refresh dispatcher writes here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureWritableDir } from './ensure-writable-dir.js';
import { resolveDataPath } from './runtime-paths.js';

/** Snapshot file under the data directory (via resolveDataPath). */
export const SNAPSHOT_FILE_NAME = 'harness-models-catalog.json';

/** Serializes snapshot read-modify-write across harnesses in this process. */
/** @type {Promise<unknown>} */
let snapshotWriteQueue = Promise.resolve();

/** @type {number} */
let snapshotTempWriteSeq = 0;

/**
 * Runs a synchronous snapshot critical section after prior writes finish.
 *
 * @template T
 * @param {() => T} fn Must not await; performs read-modify-write atomically.
 * @returns {Promise<T>}
 */
export function withHarnessModelsSnapshotLock(fn) {
  const run = snapshotWriteQueue.then(() => fn());
  snapshotWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * @typedef {object} HarnessModelsSnapshotEntry
 * @property {import('./model-catalog.js').ModelCatalogEntry[]} entries
 * @property {string} source
 * @property {boolean} stale
 * @property {string|null} lastAttemptAt
 * @property {string|null} lastSuccessAt
 * @property {string} warning
 */

/**
 * @param {{ snapshotPath?: string }} [options]
 * @returns {object|null}
 */
function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{ snapshotPath?: string }} [options]
 * @returns {{ updatedAt: string, harnesses: Record<string, HarnessModelsSnapshotEntry> }|null}
 */
export function readHarnessModelsSnapshot(options = {}) {
  const filePath = options.snapshotPath || resolveDataPath(SNAPSHOT_FILE_NAME);
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  const harnesses = parsed.harnesses && typeof parsed.harnesses === 'object'
    ? parsed.harnesses
    : {};
  return {
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    harnesses,
  };
}

/**
 * @param {string} harness
 * @param {{ snapshotPath?: string }} [options]
 * @returns {HarnessModelsSnapshotEntry|null}
 */
export function readHarnessModelsSnapshotEntry(harness, options = {}) {
  const id = String(harness || '').trim().toLowerCase();
  if (!id) return null;
  const snap = readHarnessModelsSnapshot(options);
  const entry = snap?.harnesses?.[id];
  if (!entry || !Array.isArray(entry.entries)) return null;
  return entry;
}

/**
 * @param {object} snapshot
 * @param {{ snapshotPath?: string }} [options]
 * @returns {string}
 */
export function writeHarnessModelsSnapshot(snapshot, options = {}) {
  const filePath = options.snapshotPath || resolveDataPath(SNAPSHOT_FILE_NAME);
  ensureWritableDir(path.dirname(filePath));
  snapshotTempWriteSeq += 1;
  const tempPath = `${filePath}.${process.pid}.${snapshotTempWriteSeq}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
  return filePath;
}

/**
 * Merge refresh outcome into the snapshot. Never drops prior entries on failure.
 *
 * @param {string} harness
 * @param {{
 *   entries?: import('./model-catalog.js').ModelCatalogEntry[],
 *   source: string,
 *   stale: boolean,
 *   lastAttemptAt: string,
 *   lastSuccessAt: string|null,
 *   warning: string,
 *   persistEntries: boolean,
 * }} update
 * @param {{ snapshotPath?: string }} [options]
 * @returns {Promise<string>} path written
 */
export function applyHarnessModelsSnapshotUpdate(harness, update, options = {}) {
  return withHarnessModelsSnapshotLock(() => {
    const id = String(harness || '').trim().toLowerCase();
    const filePath = options.snapshotPath || resolveDataPath(SNAPSHOT_FILE_NAME);
    const existing = readHarnessModelsSnapshot({ snapshotPath: filePath });
    const harnesses = { ...(existing?.harnesses || {}) };
    const prior = harnesses[id];
    const nextEntries = update.persistEntries && Array.isArray(update.entries) && update.entries.length > 0
      ? update.entries
      : (prior?.entries || []);
    harnesses[id] = {
      entries: nextEntries,
      source: update.persistEntries ? update.source : (prior?.source || update.source),
      stale: update.stale,
      lastAttemptAt: update.lastAttemptAt,
      lastSuccessAt: update.lastSuccessAt ?? prior?.lastSuccessAt ?? null,
      warning: update.warning || '',
    };
    const snapshot = {
      updatedAt: new Date().toISOString(),
      harnesses,
    };
    return writeHarnessModelsSnapshot(snapshot, { snapshotPath: filePath });
  });
}
