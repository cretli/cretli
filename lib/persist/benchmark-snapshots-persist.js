/**
 * Versioned local store for benchmark source preferences, terms verification
 * and imported snapshots (`data/benchmark-snapshots.json`).
 *
 * model_pick reads this file only for the shadow benchmark explanation
 * (`lib/model-pick-benchmark.js`), never for selection. Writes are atomic and guarded
 * by a raw-content ETag. The last valid snapshot per source is never removed.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ifMatchMatches } from '../model-role-config-store.js';
import {
  BenchmarkSnapshotError,
  computeSnapshotFreshness,
  isValidStoredSnapshotRow,
  normalizeTermsVerification,
  validateImportableSnapshot,
  whitelistSnapshotRecord,
} from '../benchmark-snapshot.js';
import { findBuiltinBenchmarkSource } from '../benchmark-source-registry.js';

export const BENCHMARK_SNAPSHOTS_KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  'version',
  'sourcePreferences',
  'termsVerifications',
  'snapshots',
]);

export const BENCHMARK_SNAPSHOTS_SCHEMA_VERSION = 1;

/** Keep at most this many snapshots per source (never below 1 valid). */
export const BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE = 5;

/**
 * @param {Record<string, any>} [input]
 * @returns {string}
 */
export function resolveBenchmarkSnapshotsPath(input = {}) {
  return String(input.filePath || '').trim() || resolveDataPath('benchmark-snapshots.json');
}

/**
 * @param {string | null | undefined} rawText
 * @returns {string}
 */
export function computeBenchmarkSnapshotsEtag(rawText) {
  const basis = rawText == null ? 'benchmark-snapshots:missing' : String(rawText);
  return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/**
 * @param {string} filePath
 * @returns {{ state: 'missing' | 'valid' | 'invalid', rawText: string | null, document: Record<string, any> | null, error?: string }}
 */
function readRawDocument(filePath) {
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT') {
      return { state: 'missing', rawText: null, document: null };
    }
    return { state: 'invalid', rawText: null, document: null, error: 'benchmark-snapshots.json is unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { state: 'invalid', rawText, document: null, error: 'benchmark-snapshots.json is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'invalid', rawText, document: null, error: 'benchmark-snapshots.json is not a valid JSON object' };
  }
  const doc = /** @type {Record<string, unknown>} */ (parsed);
  if (Object.prototype.hasOwnProperty.call(doc, 'termsVerifications') && !Array.isArray(doc.termsVerifications)) {
    return {
      state: 'invalid',
      rawText,
      document: null,
      error: 'termsVerifications must be an array when present',
    };
  }
  if (Object.prototype.hasOwnProperty.call(doc, 'snapshots') && !Array.isArray(doc.snapshots)) {
    return {
      state: 'invalid',
      rawText,
      document: null,
      error: 'snapshots must be an array when present',
    };
  }
  const termsRows = Array.isArray(doc.termsVerifications) ? doc.termsVerifications : [];
  for (const row of termsRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { state: 'invalid', rawText, document: null, error: 'termsVerifications rows must be objects' };
    }
  }
  const snapshotRows = Array.isArray(doc.snapshots) ? doc.snapshots : [];
  for (const row of snapshotRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { state: 'invalid', rawText, document: null, error: 'snapshots rows must be objects' };
    }
  }
  return { state: 'valid', rawText, document: parsed };
}

/**
 * @param {any} value
 * @returns {any}
 */
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {Record<string, any> | null} document
 * @returns {Record<string, any>}
 */
function baseDocument(document) {
  const doc = document && typeof document === 'object' && !Array.isArray(document)
    ? cloneJson(document)
    : {};
  if (!doc.sourcePreferences || typeof doc.sourcePreferences !== 'object' || Array.isArray(doc.sourcePreferences)) {
    doc.sourcePreferences = {};
  }
  if (!Array.isArray(doc.termsVerifications)) doc.termsVerifications = [];
  if (!Array.isArray(doc.snapshots)) doc.snapshots = [];
  doc.version = BENCHMARK_SNAPSHOTS_SCHEMA_VERSION;
  return doc;
}

/**
 * @param {Record<string, any> | null} document
 * @param {number} [now]
 * @returns {Record<string, any>[]}
 */
function readTermsVerifications(document, now) {
  const rows = document && Array.isArray(document.termsVerifications) ? document.termsVerifications : [];
  return rows.map((row) => normalizeTermsVerification(row, { now }));
}

/**
 * @param {Record<string, any> | null} document
 * @returns {Record<string, any>[]}
 */
function readSnapshots(document) {
  const rows = document && Array.isArray(document.snapshots) ? document.snapshots : [];
  return rows
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => whitelistSnapshotRecord(row));
}

/**
 * @param {string} sourceId
 * @param {Record<string, any>[]} verifications
 * @returns {Record<string, any> | null}
 */
export function pickLatestTermsVerification(sourceId, verifications) {
  const id = String(sourceId || '').trim();
  const matches = verifications.filter((row) => String(row.sourceId || '').trim() === id);
  if (!matches.length) return null;
  return matches[matches.length - 1];
}

/**
 * @param {Record<string, any>[]} snapshots
 * @param {number} [now]
 * @returns {Record<string, any>[]}
 */
export function enrichSnapshotsWithFreshness(snapshots, now = Date.now()) {
  return snapshots.map((row) => {
    const sourceId = String(row.sourceId || '').trim();
    const builtin = findBuiltinBenchmarkSource(sourceId);
    const ttlMs = builtin?.cacheTtlMs ?? 0;
    const capturedAt = String(row.capturedAt || '').trim();
    const freshness = computeSnapshotFreshness(capturedAt, ttlMs, now);
    return {
      ...row,
      freshness: {
        stale: freshness.stale,
        ageMs: freshness.ageMs,
        ttlMs,
      },
    };
  });
}

/**
 * @param {{ filePath?: string, now?: number }} [input]
 * @returns {Record<string, any>}
 */
export function readBenchmarkSnapshots(input = {}) {
  const filePath = resolveBenchmarkSnapshotsPath(input);
  const raw = readRawDocument(filePath);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  if (raw.state === 'invalid') {
    return {
      path: filePath,
      state: 'invalid',
      error: raw.error || 'benchmark-snapshots.json is not a valid JSON object',
      etag: computeBenchmarkSnapshotsEtag(raw.rawText),
      sourcePreferences: {},
      termsVerifications: [],
      snapshots: [],
      unknownTopLevelKeys: [],
    };
  }
  const document = raw.document;
  const unknownTopLevelKeys = document
    ? Object.keys(document).filter((key) => !BENCHMARK_SNAPSHOTS_KNOWN_TOP_LEVEL_KEYS.includes(key)).sort()
    : [];
  let termsVerifications = [];
  if (document) {
    try {
      termsVerifications = readTermsVerifications(document, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: filePath,
        state: 'invalid',
        error: message,
        etag: computeBenchmarkSnapshotsEtag(raw.rawText),
        sourcePreferences: {},
        termsVerifications: [],
        snapshots: [],
        unknownTopLevelKeys,
      };
    }
  }
  const snapshots = enrichSnapshotsWithFreshness(readSnapshots(document), now);
  return {
    path: filePath,
    state: /** @type {'missing'|'valid'} */ (raw.state),
    error: null,
    etag: computeBenchmarkSnapshotsEtag(raw.rawText),
    sourcePreferences: document?.sourcePreferences && typeof document.sourcePreferences === 'object'
      ? cloneJson(document.sourcePreferences)
      : {},
    termsVerifications,
    snapshots,
    unknownTopLevelKeys,
  };
}

/**
 * @param {{
 *   filePath?: string,
 *   verification?: Record<string, any>,
 *   ifMatch?: string | null,
 *   now?: number,
 *   verifiedBy?: string,
 * }} input
 */
export function writeBenchmarkTermsVerification(input = {}) {
  const filePath = resolveBenchmarkSnapshotsPath(input);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const current = readBenchmarkSnapshots({ filePath, now: input.now });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error || 'invalid store', etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'benchmark store changed on disk', etag: current.etag, conflict: true };
  }
  let verification;
  try {
    verification = normalizeTermsVerification({
      ...input.verification,
      verifiedBy: input.verifiedBy || input.verification?.verifiedBy,
      verifiedAt: input.verification?.verifiedAt || new Date(now).toISOString(),
    }, { now });
  } catch (err) {
    if (err instanceof BenchmarkSnapshotError) {
      return { ok: false, state: current.state, error: err.message, etag: current.etag, code: err.code };
    }
    throw err;
  }
  const doc = baseDocument(readRawDocument(filePath).document);
  const rows = Array.isArray(doc.termsVerifications) ? doc.termsVerifications : [];
  const without = rows.filter((row) => String(row?.sourceId || '').trim() !== verification.sourceId);
  doc.termsVerifications = [...without, verification];
  writeJsonAtomic(filePath, doc);
  const next = readBenchmarkSnapshots({ filePath, now: input.now });
  return { ok: true, state: next.state, etag: next.etag, verification };
}

/**
 * Sort key for snapshot history (newest first).
 *
 * @param {Record<string, any>} row
 * @returns {string}
 */
function snapshotHistorySortKey(row) {
  const importedAt = String(row.importedAt || '').trim();
  const capturedAt = String(row.capturedAt || '').trim();
  return `${importedAt}\0${capturedAt}`;
}

/**
 * Trim per-source history: keep the newest valid rows up to the limit; never
 * drop the last remaining valid snapshot for that source.
 *
 * @param {Record<string, any>[]} snapshots
 * @param {string} sourceId
 * @returns {Record<string, any>[]}
 */
function trimSnapshotsForSource(snapshots, sourceId) {
  const id = String(sourceId || '').trim();
  const forSource = snapshots.filter((row) => String(row.sourceId || '').trim() === id);
  const other = snapshots.filter((row) => String(row.sourceId || '').trim() !== id);
  const valid = forSource.filter((row) => isValidStoredSnapshotRow(row));
  const invalid = forSource.filter((row) => !isValidStoredSnapshotRow(row));
  const sortedValid = [...valid].sort((a, b) => snapshotHistorySortKey(b).localeCompare(snapshotHistorySortKey(a)));
  let keptValid = sortedValid;
  if (sortedValid.length > BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE) {
    keptValid = sortedValid.slice(0, BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE);
  }
  if (!keptValid.length && valid.length) {
    keptValid = [sortedValid[0]];
  }
  return [...other, ...invalid, ...keptValid];
}

/**
 * @param {{
 *   filePath?: string,
 *   importBody?: Record<string, any>,
 *   ifMatch?: string | null,
 *   now?: number,
 *   importedBy?: string,
 *   generateId?: () => string,
 * }} input
 */
export function importBenchmarkSnapshot(input = {}) {
  const filePath = resolveBenchmarkSnapshotsPath(input);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const current = readBenchmarkSnapshots({ filePath, now: input.now });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error || 'invalid store', etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'benchmark store changed on disk', etag: current.etag, conflict: true };
  }
  const body = input.importBody && typeof input.importBody === 'object' ? input.importBody : {};
  const termsRecord = pickLatestTermsVerification(String(body.sourceId || ''), current.termsVerifications);
  let validated;
  try {
    validated = validateImportableSnapshot(body, termsRecord, { now });
  } catch (err) {
    if (err instanceof BenchmarkSnapshotError) {
      return { ok: false, state: current.state, error: err.message, etag: current.etag, code: err.code };
    }
    throw err;
  }
  const id = typeof input.generateId === 'function'
    ? String(input.generateId()).trim()
    : randomUUID();
  const record = whitelistSnapshotRecord({
    id,
    sourceId: validated.sourceId,
    kind: validated.kind,
    capturedAt: validated.capturedAt,
    importedAt: new Date(now).toISOString(),
    importedBy: String(input.importedBy || '').trim() || 'operator',
    payload: validated.payload,
    mappingSummary: validated.mappingSummary,
  });
  const rawDoc = readRawDocument(filePath);
  if (rawDoc.state === 'invalid') {
    return { ok: false, state: 'invalid', error: rawDoc.error || 'invalid store', etag: current.etag };
  }
  const doc = baseDocument(rawDoc.document);
  const previous = readSnapshots(doc);
  doc.snapshots = trimSnapshotsForSource([...previous, record], validated.sourceId);
  writeJsonAtomic(filePath, doc);
  const next = readBenchmarkSnapshots({ filePath, now: input.now });
  return { ok: true, state: next.state, etag: next.etag, snapshot: record };
}

/**
 * @param {{
 *   filePath?: string,
 *   sourceId?: string,
 *   enabled?: boolean,
 *   ifMatch?: string | null,
 * }} input
 */
export function setBenchmarkSourceEnabled(input = {}) {
  const filePath = resolveBenchmarkSnapshotsPath(input);
  const sourceId = String(input.sourceId || '').trim();
  if (!findBuiltinBenchmarkSource(sourceId)) {
    const current = readBenchmarkSnapshots({ filePath });
    return { ok: false, state: current.state, error: 'unknown benchmark source', etag: current.etag, code: 'source_unknown' };
  }
  const current = readBenchmarkSnapshots({ filePath });
  if (current.state === 'invalid') {
    return { ok: false, state: 'invalid', error: current.error || 'invalid store', etag: current.etag };
  }
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'benchmark store changed on disk', etag: current.etag, conflict: true };
  }
  const rawDoc = readRawDocument(filePath);
  if (rawDoc.state === 'invalid') {
    return { ok: false, state: 'invalid', error: rawDoc.error || 'invalid store', etag: current.etag };
  }
  const doc = baseDocument(rawDoc.document);
  doc.sourcePreferences = doc.sourcePreferences && typeof doc.sourcePreferences === 'object'
    ? doc.sourcePreferences
    : {};
  doc.sourcePreferences[sourceId] = { enabled: Boolean(input.enabled) };
  writeJsonAtomic(filePath, doc);
  const next = readBenchmarkSnapshots({ filePath });
  return { ok: true, state: next.state, etag: next.etag, sourceId, enabled: Boolean(input.enabled) };
}

/**
 * @param {Record<string, any>} input
 */
export function resetBenchmarkSnapshotsStore(input = {}) {
  const filePath = resolveBenchmarkSnapshotsPath(input);
  const current = readBenchmarkSnapshots({ filePath, now: input.now });
  if (input.ifMatch != null && !ifMatchMatches(input.ifMatch, current.etag)) {
    return { ok: false, state: current.state, error: 'benchmark store changed on disk', etag: current.etag, conflict: true };
  }
  const raw = readRawDocument(filePath);
  let backupPath = null;
  if (raw.state !== 'missing' && raw.rawText != null) {
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    backupPath = `${filePath}.bak-${stamp}`;
    writeTextAtomic(backupPath, raw.rawText);
  }
  writeJsonAtomic(filePath, {
    version: BENCHMARK_SNAPSHOTS_SCHEMA_VERSION,
    sourcePreferences: {},
    termsVerifications: [],
    snapshots: [],
  });
  const next = readBenchmarkSnapshots({ filePath, now: input.now });
  return { ok: true, state: next.state, etag: next.etag, backupPath };
}
