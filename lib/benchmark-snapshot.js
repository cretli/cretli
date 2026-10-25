/**
 * Validation and mapping helpers for imported benchmark snapshots.
 *
 * Real snapshots require a persisted terms verification record; fixture imports
 * are allowed only for built-in fictional registry sources. Snapshots never feed
 * model_pick in this task.
 */

import { findBuiltinBenchmarkSource } from './benchmark-source-registry.js';

/** @typedef {'release' | 'base' | 'effort' | 'unmapped'} BenchmarkMappingDimension */

export const BENCHMARK_SNAPSHOT_SCHEMA_VERSION = 1;
export const BENCHMARK_SNAPSHOT_MAX_BYTES = 256 * 1024;
export const BENCHMARK_SNAPSHOT_MAX_ENTRIES = 500;
export const BENCHMARK_TERMS_MAX_BYTES = 8 * 1024;

export const BENCHMARK_MAPPING_DIMENSIONS = Object.freeze(['release', 'base', 'effort']);

export const BENCHMARK_TERMS_KNOWN_KEYS = Object.freeze([
  'sourceId',
  'officialTermsUrl',
  'verifiedAt',
  'scopeOfConsent',
  'verifiedBy',
  'licenseNotes',
  'attributionRequired',
  'redistributionAllowed',
  'costAcknowledged',
  'freshnessPolicyDays',
  'version',
]);

export const BENCHMARK_SNAPSHOT_ROW_KEYS = Object.freeze([
  'id',
  'sourceId',
  'kind',
  'capturedAt',
  'importedAt',
  'importedBy',
  'payload',
  'mappingSummary',
]);

export class BenchmarkSnapshotError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'BenchmarkSnapshotError';
    this.code = code;
  }
}

/**
 * @param {string} sourceId
 * @returns {boolean}
 */
export function isRegistryFictionalSource(sourceId) {
  const builtin = findBuiltinBenchmarkSource(sourceId);
  return Boolean(builtin?.fictional);
}

/**
 * Fixture exemption depends only on the built-in fictional registry entry.
 *
 * @param {unknown} snapshot
 * @returns {boolean}
 */
export function isFictionalFixtureSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const sourceId = String(/** @type {Record<string, unknown>} */ (snapshot).sourceId || '').trim();
  return isRegistryFictionalSource(sourceId);
}

/**
 * @param {string} candidateUrl
 * @param {string} registryUrl
 * @returns {boolean}
 */
export function officialTermsUrlMatchesRegistry(candidateUrl, registryUrl) {
  let candidate;
  let registry;
  try {
    candidate = new URL(String(candidateUrl || '').trim());
    registry = new URL(String(registryUrl || '').trim());
  } catch {
    return false;
  }
  if (candidate.origin !== registry.origin) return false;
  const registryPath = registry.pathname.replace(/\/$/, '') || '/';
  const candidatePath = candidate.pathname.replace(/\/$/, '') || '/';
  if (candidatePath === registryPath) return true;
  return candidatePath.startsWith(`${registryPath}/`);
}

/**
 * @param {object} terms
 * @param {number} [now]
 * @returns {void}
 */
export function assertTermsUnlockImport(terms, now = Date.now()) {
  if (!terms || typeof terms !== 'object') {
    throw new BenchmarkSnapshotError('terms_unverified', 'terms verification is required before importing real snapshot data');
  }
  if (terms.redistributionAllowed !== true) {
    throw new BenchmarkSnapshotError('terms_redistribution_denied', 'redistribution must be explicitly allowed in terms verification');
  }
  if (terms.costAcknowledged !== true) {
    throw new BenchmarkSnapshotError('terms_cost_unacknowledged', 'cost must be acknowledged in terms verification');
  }
  const verifiedMs = Date.parse(String(terms.verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) {
    throw new BenchmarkSnapshotError('terms_expired', 'terms verification timestamp is invalid');
  }
  if (verifiedMs > now) {
    throw new BenchmarkSnapshotError('terms_expired', 'terms verification cannot be in the future');
  }
  const policyDays = Math.max(1, Math.min(365, Number(terms.freshnessPolicyDays) || 30));
  const ageMs = now - verifiedMs;
  if (ageMs > policyDays * 24 * 60 * 60 * 1000) {
    throw new BenchmarkSnapshotError('terms_expired', 'terms verification is older than freshness policy');
  }
}

/**
 * @param {unknown} verification
 * @param {{ now?: number }} [options]
 * @returns {object}
 */
export function normalizeTermsVerification(verification, options = {}) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    throw new BenchmarkSnapshotError('terms_invalid', 'terms verification must be an object');
  }
  const row = /** @type {Record<string, unknown>} */ (verification);
  const sourceId = String(row.sourceId || '').trim();
  const officialTermsUrl = String(row.officialTermsUrl || '').trim();
  const verifiedAt = String(row.verifiedAt || '').trim();
  const scopeOfConsent = String(row.scopeOfConsent || '').trim();
  const verifiedBy = String(row.verifiedBy || '').trim() || 'operator';
  const version = String(row.version || '').trim();
  if (!sourceId) throw new BenchmarkSnapshotError('terms_invalid', 'sourceId is required');
  const builtin = findBuiltinBenchmarkSource(sourceId);
  if (!builtin) {
    throw new BenchmarkSnapshotError('source_unknown', 'unknown benchmark source');
  }
  if (isRegistryFictionalSource(sourceId)) {
    throw new BenchmarkSnapshotError('terms_invalid', 'fictional sources do not require terms verification');
  }
  if (!officialTermsUrl.startsWith('https://')) {
    throw new BenchmarkSnapshotError('terms_invalid', 'officialTermsUrl must be an https URL');
  }
  if (!officialTermsUrlMatchesRegistry(officialTermsUrl, String(builtin.officialTermsUrl || ''))) {
    throw new BenchmarkSnapshotError('terms_url_mismatch', 'officialTermsUrl must match the registry source terms URL');
  }
  if (!version || version.length < 1) {
    throw new BenchmarkSnapshotError('terms_invalid', 'version is required');
  }
  if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt))) {
    throw new BenchmarkSnapshotError('terms_invalid', 'verifiedAt must be a valid ISO timestamp');
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  if (Date.parse(verifiedAt) > now) {
    throw new BenchmarkSnapshotError('terms_invalid', 'verifiedAt cannot be in the future');
  }
  if (scopeOfConsent.length < 8) {
    throw new BenchmarkSnapshotError('terms_invalid', 'scopeOfConsent is required');
  }
  const normalized = {
    sourceId,
    officialTermsUrl,
    verifiedAt,
    scopeOfConsent,
    verifiedBy,
    version,
    licenseNotes: String(row.licenseNotes || '').trim(),
    attributionRequired: Boolean(row.attributionRequired),
    redistributionAllowed: Boolean(row.redistributionAllowed),
    costAcknowledged: Boolean(row.costAcknowledged),
    freshnessPolicyDays: Math.max(1, Math.min(365, Number(row.freshnessPolicyDays) || 30)),
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > BENCHMARK_TERMS_MAX_BYTES) {
    throw new BenchmarkSnapshotError('terms_invalid', `terms record exceeds ${BENCHMARK_TERMS_MAX_BYTES} bytes`);
  }
  return normalized;
}

/**
 * Classify one entry row onto release/base/effort or unmapped.
 *
 * @param {unknown} entry
 * @returns {{ dimension: BenchmarkMappingDimension, explicit: boolean }}
 */
export function classifyBenchmarkEntryMapping(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { dimension: 'unmapped', explicit: false };
  }
  const row = /** @type {Record<string, unknown>} */ (entry);
  const status = String(row.mappingStatus || '').trim().toLowerCase();
  if (status === 'unmapped') return { dimension: 'unmapped', explicit: true };
  const dimension = String(row.mappingDimension || '').trim().toLowerCase();
  if (BENCHMARK_MAPPING_DIMENSIONS.includes(dimension)) {
    return { dimension: /** @type {BenchmarkMappingDimension} */ (dimension), explicit: true };
  }
  const hasRelease = row.releaseTier != null || row.release != null;
  const hasBase = row.baseScore != null || row.base != null;
  const hasEffort = row.effortHint != null || row.effort != null;
  const hits = [hasRelease, hasBase, hasEffort].filter(Boolean).length;
  if (hits !== 1) return { dimension: 'unmapped', explicit: false };
  if (hasRelease) return { dimension: 'release', explicit: false };
  if (hasBase) return { dimension: 'base', explicit: false };
  return { dimension: 'effort', explicit: false };
}

/**
 * @param {unknown} payload
 * @param {{ serializedByteLength?: number }} [options]
 * @returns {{ entries: object[], mappingSummary: Record<string, number> }}
 */
export function validateBenchmarkSnapshotPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BenchmarkSnapshotError('schema_invalid', 'snapshot payload must be an object');
  }
  const byteLength = Number(options.serializedByteLength);
  if (Number.isFinite(byteLength) && byteLength > BENCHMARK_SNAPSHOT_MAX_BYTES) {
    throw new BenchmarkSnapshotError('size_exceeded', `snapshot exceeds ${BENCHMARK_SNAPSHOT_MAX_BYTES} bytes`);
  }
  const body = /** @type {Record<string, unknown>} */ (payload);
  const entriesRaw = body.entries;
  if (!Array.isArray(entriesRaw)) {
    throw new BenchmarkSnapshotError('schema_invalid', 'entries must be an array');
  }
  if (entriesRaw.length > BENCHMARK_SNAPSHOT_MAX_ENTRIES) {
    throw new BenchmarkSnapshotError('size_exceeded', `entries exceed ${BENCHMARK_SNAPSHOT_MAX_ENTRIES} rows`);
  }
  /** @type {Record<string, number>} */
  const mappingSummary = { release: 0, base: 0, effort: 0, unmapped: 0 };
  const entries = entriesRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BenchmarkSnapshotError('schema_invalid', `entries[${index}] must be an object`);
    }
    const row = /** @type {Record<string, unknown>} */ (entry);
    const modelKey = String(row.modelKey || row.model || '').trim();
    if (!modelKey) {
      throw new BenchmarkSnapshotError('schema_invalid', `entries[${index}].modelKey is required`);
    }
    const { dimension } = classifyBenchmarkEntryMapping(row);
    mappingSummary[dimension] += 1;
    return { ...row, modelKey, mappingDimension: dimension };
  });
  return { entries, mappingSummary };
}

/**
 * @param {object} input
 * @param {object | null} termsRecord
 * @param {{ now?: number }} [options]
 * @returns {object}
 */
export function validateImportableSnapshot(input, termsRecord, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const sourceId = String(input.sourceId || '').trim();
  const capturedAt = String(input.capturedAt || '').trim();
  if (!sourceId) throw new BenchmarkSnapshotError('schema_invalid', 'sourceId is required');
  const builtin = findBuiltinBenchmarkSource(sourceId);
  if (!builtin) {
    throw new BenchmarkSnapshotError('source_unknown', 'unknown benchmark source');
  }
  if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) {
    throw new BenchmarkSnapshotError('schema_invalid', 'capturedAt must be a valid ISO timestamp');
  }
  const capturedMs = Date.parse(capturedAt);
  if (capturedMs > now) {
    throw new BenchmarkSnapshotError('captured_at_future', 'capturedAt cannot be in the future');
  }
  const fictional = isRegistryFictionalSource(sourceId);
  if (!fictional && sourceId !== 'artificial-analysis') {
    if (!termsRecord || String(termsRecord.sourceId || '').trim() !== sourceId) {
      throw new BenchmarkSnapshotError('terms_unverified', 'terms verification is required before importing real snapshot data');
    }
    const normalizedTerms = normalizeTermsVerification(termsRecord, { now });
    assertTermsUnlockImport(normalizedTerms, now);
  }
  const serialized = JSON.stringify(input.payload ?? input);
  const validated = validateBenchmarkSnapshotPayload(input.payload ?? input, {
    serializedByteLength: Buffer.byteLength(serialized, 'utf8'),
  });
  return {
    sourceId,
    capturedAt,
    kind: fictional ? 'fixture' : 'real',
    payload: { version: BENCHMARK_SNAPSHOT_SCHEMA_VERSION, entries: validated.entries },
    mappingSummary: validated.mappingSummary,
  };
}

/**
 * @param {string} capturedAt
 * @param {number} ttlMs
 * @param {number} [now]
 * @returns {{ stale: boolean, ageMs: number }}
 */
export function computeSnapshotFreshness(capturedAt, ttlMs, now = Date.now()) {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return { stale: true, ageMs: Number.POSITIVE_INFINITY };
  const ageMs = Math.max(0, now - capturedMs);
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const stale = ttl > 0 ? ageMs > ttl : false;
  return { stale, ageMs };
}

/**
 * @param {unknown} row
 * @returns {boolean}
 */
export function isValidStoredSnapshotRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const snap = /** @type {Record<string, unknown>} */ (row);
  if (!String(snap.sourceId || '').trim()) return false;
  if (!String(snap.capturedAt || '').trim() || !Number.isFinite(Date.parse(String(snap.capturedAt)))) return false;
  const payload = snap.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  try {
    validateBenchmarkSnapshotPayload(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whitelist snapshot fields for persistence.
 *
 * @param {object} record
 * @returns {object}
 */
export function whitelistSnapshotRecord(record) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of BENCHMARK_SNAPSHOT_ROW_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      out[key] = record[key];
    }
  }
  return out;
}
