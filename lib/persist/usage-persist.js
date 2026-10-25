/**
 * Usage journal and durable ledger read-model.
 *
 * Source of truth
 * ---------------
 * The append-only JSONL journal under `data/usage/` is the source of truth.
 * Every new record is written as a small versioned envelope:
 *
 *   {"v":1,"seq":<n>,"kind":"usage","at":"<iso>","event":{...},"crc":"<hex>"}
 *
 * The envelope is versioned (`USAGE_JOURNAL_VERSION`) and checksummed so a
 * torn/incomplete trailing line is detected as *corrupt* instead of being
 * treated as committed. Legacy raw event lines (written before the envelope)
 * are still read back, but only a line that parses AND is terminated by a
 * newline counts as committed.
 *
 * Read-model
 * ----------
 * `ledger-index.json` is a durable, rebuildable index of:
 *   - `keys`: `logicalEventKey -> committed event` (identity dedup);
 *   - `baselines`: `baselineKey -> last accepted cumulative snapshot`
 *     (sourceSession/run/attempt/turn/contextEpoch);
 *   - `runs`: `runKey -> active|ended run` (runId assigned at run-start);
 *   - `corrections` / `supersededKeys`: legacy backfill provenance.
 *
 * The index is never a second source of truth: a crash after the journal append
 * but before the index write is recovered by tailing the journal on the next
 * refresh, keyed by per-file size. A full journal rebuild only happens when the
 * index is missing/corrupt, never on the hot path. Writes are serialized with an
 * inter-process lock so several processes cannot commit the same logical key.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';
import { recordWriteStat } from './atomic-write.js';
import {
  USAGE_FINAL_USAGE_GRACE_MS,
  USAGE_NORMALIZATION_VERSION,
  applyUsageCoverageCorrection,
  canAwaitFinalUsage,
} from '../usage/usage-contract.js';

/** Version of the journal envelope written by `appendJournalRecord`. */
export const USAGE_JOURNAL_VERSION = 1;
/** Version of the persisted identity/baseline/run read-model. */
export const USAGE_LEDGER_INDEX_VERSION = 1;

/**
 * Minimum retention for identity keys and snapshot baselines: the whole active
 * run, then at least 30 days after close / last accepted late usage. It is
 * never shorter than the journal retention or the documented provider
 * redelivery horizon (24 h, `USAGE_FINAL_USAGE_GRACE_MS`).
 */
export const USAGE_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const USAGE_JOURNAL_RETENTION_MS = USAGE_KEY_RETENTION_MS;
export const USAGE_PROVIDER_REDELIVERY_HORIZON_MS = USAGE_FINAL_USAGE_GRACE_MS;

const LEDGER_INDEX_FILE = 'ledger-index.json';
const LEDGER_LOCK_DIR = '.ledger.lock';
const MAX_DIAGNOSTIC_SAMPLES = 25;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

/**
 * Parsed day files keyed by absolute path. Entries are dropped when the file's
 * mtime/size changes or when an append happens through this module.
 *
 * @type {Map<string, { mtimeMs: number, size: number, events: Record<string, any>[], supersedes: Array<{ key: string, seq: number, event: Record<string, any> }>, corrupt: number }>}
 */
const dayFileCache = new Map();
const MAX_CACHED_DAY_FILES = 400;
/**
 * Budget for the on-disk size of cached day files (parsed events weigh about as
 * much on the heap). A busy instance writes several MB per day: 64 MB keeps
 * about two weeks, so 7-day reads hit the cache and a month read reparses only
 * its older half (see docs/perf-memory-report.md). `CRETLI_USAGE_DAY_CACHE_MB`
 * overrides it.
 */
export const MAX_CACHED_DAY_FILE_BYTES = resolveDayCacheBudget(process.env.CRETLI_USAGE_DAY_CACHE_MB);

/**
 * @param {unknown} raw
 * @returns {number}
 */
function resolveDayCacheBudget(raw) {
  const mb = Number(raw);
  if (Number.isFinite(mb) && mb >= 1) return Math.floor(mb * 1024 * 1024);
  return 64 * 1024 * 1024;
}
let dayFileCacheBytes = 0;
/** Parse counters so callers and tests can tell cache hits from reparses. */
let dayFileCacheHits = 0;
let dayFileCacheParses = 0;

/**
 * Drops a day-file entry and keeps the byte counter in step.
 *
 * @param {string} file
 */
function forgetDayFile(file) {
  const entry = dayFileCache.get(file);
  if (!entry) return;
  dayFileCacheBytes -= entry.size;
  dayFileCache.delete(file);
}

/** @returns {{ entries: number, bytes: number, hits: number, parses: number }} */
export function getDayFileCacheStats() {
  return { entries: dayFileCache.size, bytes: dayFileCacheBytes, hits: dayFileCacheHits, parses: dayFileCacheParses };
}

/** In-memory ledger read-model per data dir (refreshed from disk on writes). */
const ledgerCache = new Map();

/** Token of the ledger writer lock held by this process (release verifies owner). */
let heldLedgerLockToken = null;

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function resolveUsageDataDir(dataDir) {
  const root = String(dataDir || '').trim() || resolveDataPath();
  return path.join(root, 'usage');
}

/**
 * @param {string|undefined} dataDir
 * @param {string} isoDate
 * @returns {string}
 */
export function usageDayPath(dataDir, isoDate) {
  const day = String(isoDate || '').slice(0, 10);
  return path.join(resolveUsageDataDir(dataDir), `${day}.jsonl`);
}

function textOf(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string|null|undefined} left
 * @param {string|null|undefined} right
 * @returns {string}
 */
function maxIsoTimestamp(left, right) {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  const hasLeft = Number.isFinite(leftMs);
  const hasRight = Number.isFinite(rightMs);
  if (!hasLeft) return String(right || left || '');
  if (!hasRight) return String(left || '');
  return leftMs >= rightMs ? String(left) : String(right);
}

function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nowFrom(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

/**
 * Deterministic JSON (objects sorted by key) so a checksum does not depend on
 * property insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => canonicalJson(row)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * @param {Record<string, any>} core
 * @returns {string}
 */
function recordChecksum(core) {
  return createHash('sha1').update(canonicalJson(core)).digest('hex').slice(0, 16);
}

/**
 * @param {Record<string, any>} record
 * @returns {Record<string, any>}
 */
function recordCore(record) {
  const core = {
    v: USAGE_JOURNAL_VERSION,
    seq: record.seq,
    kind: record.kind,
    at: record.at,
  };
  if (record.event !== undefined) core.event = record.event;
  if (record.run !== undefined) core.run = record.run;
  if (record.snapshot !== undefined) core.snapshot = record.snapshot;
  if (record.stale !== undefined) core.stale = record.stale;
  if (record.noneIdentity !== undefined) core.noneIdentity = record.noneIdentity;
  if (record.supersede !== undefined) core.supersede = record.supersede;
  if (record.coverageCorrection !== undefined) core.coverageCorrection = record.coverageCorrection;
  if (record.correction !== undefined) core.correction = record.correction;
  if (record.prunedKeys !== undefined) core.prunedKeys = record.prunedKeys;
  if (record.removedKeys !== undefined) core.removedKeys = record.removedKeys;
  if (record.removedBaselines !== undefined) core.removedBaselines = record.removedBaselines;
  return core;
}

/**
 * Rebuild a usage event for reads from an index `keys` row (post-correction).
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>|null}
 */
function eventFromIndexKeyRow(row) {
  if (!row || !row.logicalEventKey) return null;
  const out = {
    id: row.eventId,
    logicalEventKey: row.logicalEventKey,
    identityClass: row.identityClass || 'none',
    eventType: row.eventType || 'delta',
    harness: row.harness,
    runId: row.runId,
    attemptId: row.attemptId,
    sourceSessionId: row.sourceSessionId,
    contextEpoch: row.contextEpoch,
    tokens: row.tokens || {},
    at: row.at,
    accountingScope: row.accountingScope,
    provenance: row.provenance,
    normalizationVersion: row.normalizationVersion,
    schemaVersion: row.schemaVersion,
    legacy: row.legacy === true,
  };
  if (row.provider != null) out.provider = row.provider;
  if (row.model != null) out.model = row.model;
  if (row.feature != null) out.feature = row.feature;
  if (row.chatId != null) out.chatId = row.chatId;
  if (row.cycleId != null) out.cycleId = row.cycleId;
  if (row.usd != null) out.usd = row.usd;
  if (row.reportedUsd != null) out.reportedUsd = row.reportedUsd;
  if (row.estimated === true) out.estimated = true;
  if (row.pricing != null) out.pricing = row.pricing;
  if (row.billingMode != null) out.billingMode = row.billingMode;
  if (row.billingClass != null) out.billingClass = row.billingClass;
  if (row.accountId != null) out.accountId = row.accountId;
  if (row.billingAccountIdentityStatus === 'pending_identity') {
    out.billingAccountIdentityStatus = 'pending_identity';
  }
  if (row.outcome != null) out.outcome = row.outcome;
  if (row.role != null) out.role = row.role;
  if (row.delegationId != null) out.delegationId = row.delegationId;
  if (row.latencyMs != null) out.latencyMs = row.latencyMs;
  if (row.ttftMs != null) out.ttftMs = row.ttftMs;
  if (row.errorCode != null) out.errorCode = row.errorCode;
  if (row.measurementPresent === true) out.measurementPresent = true;
  if (row.completeness != null) out.completeness = row.completeness;
  if (row.coverage != null) out.coverage = row.coverage;
  if (row.lifecycle != null) out.lifecycle = row.lifecycle;
  if (row.usageShape != null) out.usageShape = row.usageShape;
  if (row.inputIncludesCache != null) out.inputIncludesCache = row.inputIncludesCache;
  if (row.reasoningRelation != null) out.reasoningRelation = row.reasoningRelation;
  if (row.workspaceFile != null) out.workspaceFile = row.workspaceFile;
  if (row.variant != null) out.variant = row.variant;
  if (row.requestId != null) out.requestId = row.requestId;
  return out;
}

/**
 * @param {string} dir
 * @param {string} logicalEventKey
 * @param {string} [hintDay]
 * @param {Set<string>} [parsedFiles]
 * @returns {Record<string, any>|null}
 */
function findCommittedUsageEventByLogicalKey(dir, logicalEventKey, hintDay, parsedFiles) {
  const key = textOf(logicalEventKey);
  if (!key) return null;
  /** @type {string[]} */
  const days = hintDay && /^\d{4}-\d{2}-\d{2}$/.test(hintDay)
    ? [hintDay]
    : listJournalFiles(dir).map((name) => name.replace(/\.jsonl$/, ''));
  for (const day of days) {
    const file = path.join(dir, `${day}.jsonl`);
    if (parsedFiles) parsedFiles.add(file);
    const { records } = parseJournalFile(file);
    for (const record of records) {
      if (record.kind !== 'usage' || record.supersede) continue;
      const ev = record.event;
      if (ev && ev.logicalEventKey === key) return ev;
    }
  }
  return null;
}

/**
 * Calendar days that may hold a superseded key's journal replacement or original.
 *
 * @param {Record<string, any>} index
 * @param {string} key
 * @returns {string[]}
 */
function supersedeJournalHintDays(index, key) {
  /** @type {Set<string>} */
  const days = new Set();
  const row = index?.keys?.[key];
  const meta = index?.supersededKeys?.[key];
  if (row?.at) {
    const day = String(row.at).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  }
  if (meta?.eventDay) {
    const day = String(meta.eventDay).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  }
  if (meta?.at) {
    const day = String(meta.at).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  }
  return [...days];
}

/**
 * @param {Record<string, any>} index
 * @param {string} key
 * @param {Record<string, any>|undefined} meta
 * @param {Record<string, any>|null} journalReplacement
 * @param {Set<string>} wantedDays
 * @returns {string|null}
 */
function pickSupersedeFallbackHintDay(index, key, meta, journalReplacement, wantedDays) {
  if (journalReplacement && typeof journalReplacement === 'object') {
    const day = String(journalReplacement.at || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && wantedDays.has(day)) return day;
    return null;
  }
  for (const day of supersedeJournalHintDays(index, key)) {
    if (wantedDays.has(day)) return day;
  }
  return null;
}

/**
 * @param {Record<string, any>|null} original
 * @param {Record<string, any>} change
 * @returns {Record<string, any>|null}
 */
function buildCorrectionReplacementEvent(original, change) {
  if (!original || typeof original !== 'object') return null;
  const nextTokens = change.next?.tokens && typeof change.next.tokens === 'object'
    ? change.next.tokens
    : original.tokens;
  /** @type {Record<string, any>} */
  const out = {
    ...original,
    tokens: nextTokens,
    normalizationVersion: change.version ?? original.normalizationVersion,
  };
  if (change.next?.coverage) out.coverage = change.next.coverage;
  return out;
}

/**
 * @param {string} dir
 * @param {Record<string, any>} index
 * @param {string} key
 * @param {Record<string, any>|null} journalReplacement
 * @param {string|null} [hintDay]
 * @param {Set<string>} [parsedFiles]
 * @returns {Record<string, any>|null}
 */
function resolveSupersededReplacementEvent(
  dir,
  index,
  key,
  journalReplacement,
  hintDay,
  parsedFiles
) {
  if (journalReplacement && typeof journalReplacement === 'object') return journalReplacement;
  const row = index.keys?.[key];
  if (!row) return null;
  const day = hintDay && /^\d{4}-\d{2}-\d{2}$/.test(hintDay)
    ? hintDay
    : String(row.at || '').slice(0, 10);
  const original = findCommittedUsageEventByLogicalKey(dir, key, day, parsedFiles);
  if (original) {
    return {
      ...original,
      tokens: row.tokens || original.tokens,
      normalizationVersion: row.normalizationVersion ?? original.normalizationVersion,
    };
  }
  return eventFromIndexKeyRow(row);
}

/**
 * @param {Record<string, any>} event
 * @param {number|undefined} seq
 * @param {string} at
 * @returns {Record<string, any>}
 */
function indexKeyRowFromEvent(event, seq, at) {
  return {
    logicalEventKey: event.logicalEventKey,
    identityClass: event.identityClass || 'none',
    eventId: event.id,
    seq: Number.isFinite(seq) ? seq : undefined,
    at,
    eventType: event.eventType,
    harness: event.harness,
    runId: event.runId,
    attemptId: event.attemptId,
    sourceSessionId: event.sourceSessionId,
    contextEpoch: event.contextEpoch,
    tokens: event.tokens || {},
    accountingScope: event.accountingScope,
    provenance: event.provenance,
    normalizationVersion: event.normalizationVersion,
    schemaVersion: event.schemaVersion,
    legacy: event.normalizationVersion == null,
    provider: event.provider,
    model: event.model,
    feature: event.feature,
    chatId: event.chatId,
    cycleId: event.cycleId,
    usd: event.usd ?? undefined,
    reportedUsd: event.reportedUsd,
    estimated: event.estimated === true ? true : undefined,
    pricing: event.pricing,
    billingMode: event.billingMode,
    billingClass: event.billingClass,
    accountId: event.accountId,
    billingAccountIdentityStatus: event.billingAccountIdentityStatus === 'pending_identity'
      ? 'pending_identity'
      : undefined,
    outcome: event.outcome,
    role: event.role,
    delegationId: event.delegationId,
    latencyMs: event.latencyMs,
    ttftMs: event.ttftMs,
    errorCode: event.errorCode,
    measurementPresent: event.measurementPresent === true ? true : undefined,
    completeness: event.completeness,
    coverage: event.coverage,
    lifecycle: event.lifecycle,
    usageShape: event.usageShape,
    inputIncludesCache: event.inputIncludesCache,
    reasoningRelation: event.reasoningRelation,
    workspaceFile: event.workspaceFile,
    variant: event.variant,
    requestId: event.requestId,
  };
}

/**
 * Replacement usage events for superseded keys (highest journal seq wins).
 *
 * @param {string} dir
 * @param {Set<string>|Iterable<string>} supersededKeys
 * @returns {{ replacements: Map<string, Record<string, any>>, filesParsed: number }}
 */
function buildSupersedeReplacementMap(dir, supersededKeys, index, queryDays, parsedFiles) {
  const wanted = supersededKeys instanceof Set ? supersededKeys : new Set(supersededKeys);
  if (wanted.size === 0) return { replacements: new Map(), filesParsed: 0 };
  const daysToScan = new Set();
  for (const key of wanted) {
    for (const day of supersedeJournalHintDays(index, key)) daysToScan.add(day);
  }
  if (queryDays instanceof Set && queryDays.size > 0) {
    for (const day of [...daysToScan]) {
      if (!queryDays.has(day)) daysToScan.delete(day);
    }
  }
  const latest = new Map();
  let filesParsed = 0;
  for (const day of [...daysToScan].sort()) {
    const file = path.join(dir, `${day}.jsonl`);
    if (!existsSync(file)) continue;
    filesParsed += 1;
    if (parsedFiles) parsedFiles.add(file);
    // The cached parse already lists supersede records, so this does not
    // re-read and re-checksum the day file on every query.
    for (const row of loadDayFile(file).supersedes || []) {
      if (!row.key || !wanted.has(row.key)) continue;
      const prev = latest.get(row.key);
      if (!prev || row.seq >= Number(prev.seq)) {
        latest.set(row.key, { seq: row.seq, event: row.event });
      }
    }
  }
  const replacements = new Map();
  for (const [key, row] of latest) replacements.set(key, row.event);
  return { replacements, filesParsed };
}

/**
 * Run keys whose journal scope could not be fully rebuilt at corrupt lines.
 *
 * @param {string} file
 * @param {number[]} corruptLines
 * @returns {Set<string>}
 */
function runKeysAffectedByCorruptLines(file, corruptLines) {
  const affected = new Set();
  if (!Array.isArray(corruptLines) || corruptLines.length === 0) return affected;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return affected;
  }
  const corruptSet = new Set(corruptLines);
  const terminated = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (terminated) lines.pop();
  let lastRunKey = null;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNum = index + 1;
    const line = lines[index];
    if (!line.trim()) continue;
    if (corruptSet.has(lineNum)) {
      if (lastRunKey) affected.add(lastRunKey);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (corruptSet.has(lineNum) && lastRunKey) affected.add(lastRunKey);
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.v === USAGE_JOURNAL_VERSION && parsed.seq != null) {
      const { crc, ...core } = parsed;
      if (!crc || recordChecksum(core) !== crc) {
        if (lastRunKey) affected.add(lastRunKey);
        continue;
      }
      if (core.kind === 'run-start') {
        const run = core.run || {};
        if (run.runKey) lastRunKey = run.runKey;
        continue;
      }
      if (core.kind === 'usage' && core.event) {
        lastRunKey = deriveRunKey(core.event) || lastRunKey;
      }
      continue;
    }
    if (parsed.v == null || parsed.seq == null) {
      lastRunKey = deriveRunKey(parsed) || lastRunKey;
    }
  }
  return affected;
}

/**
 * @param {Record<string, any>} index
 */
function reconcileRunPartialFlags(index) {
  const affected = new Set();
  for (const [day, scan] of Object.entries(index.fileScan || {})) {
    const lines = Array.isArray(scan?.corruptLines) ? scan.corruptLines : [];
    if (lines.length === 0) continue;
    const file = path.join(index.dir, `${day}.jsonl`);
    for (const runKey of runKeysAffectedByCorruptLines(file, lines)) {
      affected.add(runKey);
    }
  }
  for (const run of Object.values(index.runs)) {
    if (run.status === 'active') {
      if (affected.has(run.runKey)) run.partial = true;
      else if (run.partial === true) delete run.partial;
    } else if (run.partial === true && !affected.has(run.runKey)) {
      delete run.partial;
    }
  }
}

/**
 * Copy journal + index before mutating corrections/backfill.
 *
 * @param {{ dataDir?: string }} ctx
 * @returns {string|null}
 */
function backupUsageLedgerBeforeMutation(ctx = {}) {
  const dir = resolveUsageDataDir(ctx.dataDir);
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const backupDir = path.join(dir, `.backup-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  const indexFile = path.join(dir, LEDGER_INDEX_FILE);
  if (existsSync(indexFile)) {
    copyFileSync(indexFile, path.join(backupDir, LEDGER_INDEX_FILE));
  }
  for (const name of listJournalFiles(dir)) {
    copyFileSync(path.join(dir, name), path.join(backupDir, name));
  }
  return backupDir;
}

/**
 * Drop an unterminated trailing journal fragment so the next append starts on
 * a new line (crash-safe append after a torn write).
 *
 * @param {string} file
 * @returns {boolean}
 */
function trimJournalTailIfUnterminated(file) {
  if (!existsSync(file)) return false;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!raw || raw.endsWith('\n')) return false;
  const lastNewline = raw.lastIndexOf('\n');
  writeFileSync(file, lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : '', 'utf8');
  forgetDayFile(file);
  return true;
}

// ---------------------------------------------------------------------------
// Journal parsing
// ---------------------------------------------------------------------------

/**
 * Parse one journal file. A line is committed only when it parses and the file
 * ends with a newline; an unterminated trailing line is reported as corrupt.
 *
 * @param {string} file
 * @returns {{ records: Record<string, any>[], corrupt: Array<{ line: number, reason: string }> }}
 */
function parseJournalFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { records: [], corrupt: [] };
  }
  const records = [];
  const corrupt = [];
  if (!raw) return { records, corrupt };
  const terminated = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (terminated) lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const isLast = index === lines.length - 1;
    if (!terminated && isLast) {
      corrupt.push({ line: index + 1, reason: 'unterminated_last_line' });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt.push({ line: index + 1, reason: 'invalid_json' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      corrupt.push({ line: index + 1, reason: 'not_an_object' });
      continue;
    }
    if (parsed.v === USAGE_JOURNAL_VERSION && parsed.seq != null) {
      const { crc, ...core } = parsed;
      if (!crc || recordChecksum(core) !== crc) {
        corrupt.push({ line: index + 1, reason: 'checksum_mismatch' });
        continue;
      }
      records.push({ ...core, committed: true });
      continue;
    }
    if (parsed.v != null && parsed.seq == null) {
      corrupt.push({ line: index + 1, reason: 'malformed_envelope' });
      continue;
    }
    // Legacy raw event line (pre-envelope). Treated as committed once parsed.
    records.push({
      v: 0,
      seq: null,
      kind: 'usage',
      at: parsed.at,
      event: parsed,
      legacy: true,
      committed: true,
    });
  }
  return { records, corrupt };
}

/**
 * Read diagnostics for committed journal files in a UTC date window.
 * @param {{ dataDir?: string, from?: string, to?: string }} query
 * @returns {{ corrupt: number, retainedOut: number }}
 */
export function readUsageDiagnostics(query = {}) {
  const dir = resolveUsageDataDir(query.dataDir);
  const from = String(query.from || '').slice(0, 10);
  const to = String(query.to || '').slice(0, 10);
  if (!existsSync(dir)) return { corrupt: 0, retainedOut: 0 };
  let corrupt = 0;
  for (const name of listJournalFiles(dir)) {
    const day = name.slice(0, 10);
    if (day < from || day > to) continue;
    corrupt += loadDayFile(path.join(dir, name)).corrupt;
  }
  const allDays = listJournalFiles(dir).map((name) => name.slice(0, 10));
  // The window reaches back before the oldest retained day file: the days in
  // between may have been removed by retention, so they cannot be proven present.
  // Older files outside the window do not affect completeness.
  return { corrupt, retainedOut: allDays.length > 0 && from < allDays[0] ? 1 : 0 };
}

/**
 * Parsed day file, cached by (path, mtimeMs, size); checksums are verified only
 * when the file is new or changed. The returned `events` are shared with the
 * cache: callers must clone before handing them out (see readDayFile).
 *
 * @param {string} file
 * @returns {{ events: Record<string, any>[], supersedes: Array<{ key: string, seq: number, event: Record<string, any> }>, corrupt: number }}
 */
function loadDayFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    forgetDayFile(file);
    return { events: [], supersedes: [], corrupt: 0 };
  }
  const cached = dayFileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Refresh recency so eviction is least-recently-used.
    dayFileCache.delete(file);
    dayFileCache.set(file, cached);
    dayFileCacheHits += 1;
    return cached;
  }
  if (cached) forgetDayFile(file);
  dayFileCacheParses += 1;
  const { records, corrupt } = parseJournalFile(file);
  const events = [];
  /** @type {Array<{ key: string, seq: number, event: Record<string, any> }>} */
  const supersedes = [];
  for (const record of records) {
    if (record.kind === 'usage' && record.supersede && record.event && typeof record.event === 'object') {
      supersedes.push({ key: textOf(record.supersede), seq: Number(record.seq), event: record.event });
    }
    if (record.kind && record.kind !== 'usage') continue;
    if (record.stale === true) continue;
    if (record.event && typeof record.event === 'object') events.push(record.event);
  }
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, events, supersedes, corrupt: corrupt.length };
  if (makeRoomForDayFile(file, stat.size)) {
    dayFileCache.set(file, entry);
    dayFileCacheBytes += stat.size;
  }
  return entry;
}

/**
 * Evict until `size` more bytes fit. Victims are the oldest days by file name,
 * not the least recently used: reads scan a date window from old to new, so
 * LRU would evict exactly the file the next request starts with and a window
 * larger than the budget would never hit. A file older than every cached one
 * is not cached at all when it does not fit.
 *
 * @param {string} file
 * @param {number} size
 * @returns {boolean} whether the file may be cached
 */
function makeRoomForDayFile(file, size) {
  if (size > MAX_CACHED_DAY_FILE_BYTES) return false;
  const day = path.basename(file);
  while (
    dayFileCache.size > 0
    && (dayFileCache.size >= MAX_CACHED_DAY_FILES || dayFileCacheBytes + size > MAX_CACHED_DAY_FILE_BYTES)
  ) {
    let oldest = '';
    for (const key of dayFileCache.keys()) {
      if (!oldest || path.basename(key) < path.basename(oldest)) oldest = key;
    }
    if (path.basename(oldest) > day) return false;
    forgetDayFile(oldest);
  }
  return true;
}

/**
 * Events of one day file as private copies, so callers can mutate them without
 * corrupting the cache.
 *
 * @param {string} file
 * @returns {Record<string, any>[]}
 */
function readDayFile(file) {
  return loadDayFile(file).events.map((event) => structuredClone(event));
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function daysInRange(from, to) {
  const start = String(from || '').slice(0, 10);
  const end = String(to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  if (start > end) return [];
  const days = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJournalFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

/**
 * @param {{ from?: string, to?: string, dataDir?: string }} [query]
 * @returns {import('../shared-types/index.ts').UsageEvent[]} ledger events in the range (open-ended records)
 */
export function readUsageEvents(query = {}) {
  const to = String(query.to || new Date().toISOString());
  const from = String(query.from || to);
  const dir = resolveUsageDataDir(query.dataDir);
  if (!existsSync(dir)) return [];
  const wanted = new Set(daysInRange(from, to));
  if (wanted.size === 0) return [];
  const index = refreshLedgerIndex({ dataDir: query.dataDir, reason: 'read-events' });
  const superseded = new Set(Object.keys(index.supersededKeys || {}));
  const files = listJournalFiles(dir).filter((name) => wanted.has(name.replace(/\.jsonl$/, '')));
  const events = [];
  for (const name of files) {
    // A loop keeps large day files from blowing the spread-argument limit.
    for (const event of readDayFile(path.join(dir, name))) {
      if (event && event.logicalEventKey && superseded.has(event.logicalEventKey)) continue;
      events.push(event);
    }
  }
  const parsedSupersedeFiles = new Set();
  const { replacements: replacementByKey } = buildSupersedeReplacementMap(
    dir,
    superseded,
    index,
    wanted,
    parsedSupersedeFiles
  );
  for (const key of superseded) {
    const meta = index.supersededKeys?.[key];
    if (meta?.pendingReplacement === true) continue;
    const journalReplacement = replacementByKey.get(key) || null;
    const hintDay = pickSupersedeFallbackHintDay(index, key, meta, journalReplacement, wanted);
    if (!hintDay) continue;
    const replacement = resolveSupersededReplacementEvent(
      dir,
      index,
      key,
      journalReplacement,
      hintDay,
      parsedSupersedeFiles
    );
    if (!replacement) continue;
    const day = String(replacement.at || '').slice(0, 10);
    if (!wanted.has(day)) continue;
    // Journal replacements come from the shared day-file cache.
    events.push(structuredClone(replacement));
  }
  index._lastReadEventsSupersedeFiles = parsedSupersedeFiles.size;
  return events;
}

// ---------------------------------------------------------------------------
// Ledger index
// ---------------------------------------------------------------------------

function emptyIndex(dir) {
  return {
    version: USAGE_LEDGER_INDEX_VERSION,
    dir,
    lastSeq: 0,
    fileMaxSeq: {},
    fileScan: {},
    rawPrefix: {},
    keys: {},
    baselines: {},
    runs: {},
    retiredRuns: {},
    corrections: {},
    supersededKeys: {},
    diagnostics: {
      duplicates: 0,
      stale: 0,
      unknown: 0,
      corrupt: 0,
      noneIdentity: 0,
      corrections: 0,
      empty: 0,
      samples: { duplicates: [], stale: [], unknown: [], corrupt: [], empty: [], noneIdentity: [], corrections: [] },
    },
    _indexStat: null,
    _lastScan: { filesRead: 0, recordsApplied: 0, fullRebuild: false },
  };
}

/**
 * @param {Record<string, any>} index
 * @param {string} kind
 * @param {Record<string, any>} [info]
 */
function pushDiagnostic(index, kind, info = {}) {
  const diagnostics = index.diagnostics;
  if (typeof diagnostics[kind] === 'number') diagnostics[kind] += 1;
  const samples = diagnostics.samples && diagnostics.samples[kind];
  if (Array.isArray(samples) && samples.length < MAX_DIAGNOSTIC_SAMPLES) {
    samples.push({ at: new Date().toISOString(), ...info });
  }
}

/**
 * @param {Record<string, any>} index
 * @param {Record<string, any>} record
 */
function applyRecordToIndex(index, record) {
  const seq = Number(record.seq);
  if (Number.isFinite(seq)) index.lastSeq = Math.max(index.lastSeq, seq);
  const at = record.at || record.event?.at || record.run?.at || '';
  const day = String(at).slice(0, 10) || 'unknown';
  if (Number.isFinite(seq)) {
    index.fileMaxSeq[day] = Math.max(index.fileMaxSeq[day] || 0, seq);
  }
  // A stale record is kept only as a diagnostic: it never populates identity,
  // baseline or run state, so a late event can never start a new run or be
  // counted a second time.
  if (record.stale === true) return;
  if (record.kind === 'run-start') {
    const run = record.run || {};
    if (run.runKey && !index.runs[run.runKey]) {
      index.runs[run.runKey] = {
        ...run,
        status: 'active',
        startedAt: run.startedAt || at,
        startedSeq: Number.isFinite(seq) ? seq : undefined,
      };
    }
    return;
  }
  if (record.kind === 'retention-prune') {
    for (const runKey of record.prunedKeys || []) {
      const run = index.runs[runKey];
      if (run) {
        index.retiredRuns[runKey] = { runKey, retiredAt: at, lastAcceptedAt: run.lastAcceptedAt || null };
        delete index.runs[runKey];
      }
    }
    return;
  }
  if (record.kind === 'key-prune') {
    for (const key of record.removedKeys || []) {
      delete index.keys[key];
    }
    for (const baselineKey of record.removedBaselines || []) {
      delete index.baselines[baselineKey];
    }
    return;
  }
  if (record.kind === 'correction') {
    if (record.supersede) {
      const supersedeKey = textOf(record.supersede);
      const keyRow = supersedeKey ? index.keys[supersedeKey] : null;
      const eventDay = keyRow?.at
        ? String(keyRow.at).slice(0, 10)
        : String(at).slice(0, 10);
      index.supersededKeys[record.supersede] = {
        key: record.supersede,
        at,
        eventDay,
        version: record.correction?.version,
        scope: record.correction?.scope || 'tokens',
        pendingReplacement: true,
      };
      index.corrections[record.supersede] = {
        key: record.supersede,
        at,
        version: record.correction?.version,
        scope: record.correction?.scope || 'tokens',
        previous: record.correction?.previous || null,
        next: record.correction?.next || null,
      };
    }
    return;
  }
  if (record.kind !== 'usage') return;
  const event = record.event || {};
  if (record.supersede) {
    const supersedeKey = textOf(record.supersede);
    if (supersedeKey) {
      index.supersededKeys[supersedeKey] = {
        key: supersedeKey,
        at,
        eventDay: String(event.at || at).slice(0, 10),
        version: event.normalizationVersion ?? record.correction?.version,
        scope: record.correction?.scope || 'tokens',
        pendingReplacement: false,
        replacementSeq: Number.isFinite(seq) ? seq : undefined,
      };
      if (record.correction) {
        index.corrections[supersedeKey] = {
          key: supersedeKey,
          at,
          version: record.correction.version,
          scope: record.correction.scope || 'tokens',
          previous: record.correction.previous || null,
          next: record.correction.next || null,
        };
        pushDiagnostic(index, 'corrections', { key: supersedeKey });
      }
    }
  }
  if (event.logicalEventKey) {
    index.keys[event.logicalEventKey] = indexKeyRowFromEvent(event, seq, at);
  }
  if (record.snapshot?.baselineKey) {
    const previous = index.baselines[record.snapshot.baselineKey];
    index.baselines[record.snapshot.baselineKey] = {
      key: record.snapshot.baselineKey,
      runKey: deriveRunKey(event),
      contextEpoch: event.contextEpoch,
      tokens: mergeTokensMonotonic(previous?.tokens, record.snapshot.tokens),
      seq: Number.isFinite(seq) ? seq : undefined,
      at,
      lastAcceptedAt: at,
    };
  }
  const runKey = deriveRunKey(event);
  if (!runKey) return;
  const descriptor = runDescriptorFromEvent(event);
  if (event.eventType === 'run') {
    const previous = index.runs[runKey];
    if (record.supersede && previous?.status === 'ended') {
      index.runs[runKey] = {
        ...previous,
        ...descriptor,
        status: 'ended',
        startedAt: previous.startedAt || at,
        endedAt: previous.endedAt || at,
        endedSeq: previous.endedSeq,
        outcome: previous.outcome,
        measurementPresent: previous.measurementPresent === true,
        completeness: previous.completeness,
        coverage: previous.coverage || null,
        lastAcceptedAt: maxIsoTimestamp(previous.lastAcceptedAt, at),
      };
      return;
    }
    index.runs[runKey] = {
      ...previous,
      ...descriptor,
      status: 'ended',
      startedAt: previous?.startedAt || at,
      endedAt: at,
      endedSeq: Number.isFinite(seq) ? seq : undefined,
      outcome: event.outcome,
      measurementPresent: event.measurementPresent === true,
      completeness: event.completeness,
      coverage: event.coverage ? { ...event.coverage } : (previous?.coverage || null),
      lastAcceptedAt: at,
    };
    return;
  }
  let previous = index.runs[runKey];
  if (!previous) {
    previous = {
      runKey,
      status: 'active',
      startedAt: at,
      inferredWithoutRunStart: true,
    };
    pushDiagnostic(index, 'unknown', { reason: 'usage_without_run_start', runKey });
  }
  const next = {
    ...previous,
    ...descriptor,
    status: previous.status === 'ended' ? 'ended' : 'active',
    lastAcceptedAt: record.supersede ? maxIsoTimestamp(previous.lastAcceptedAt, at) : at,
  };
  if (record.coverageCorrection) {
    next.coverage = { ...(previous.coverage || {}), ...record.coverageCorrection };
    if (record.coverageCorrection.completeness) {
      next.completeness = record.coverageCorrection.completeness;
    }
    // A late credible measurement also proves the run had a measurement, so a
    // run recorded as `missing` becomes `complete`/`partial` accordingly.
    next.measurementPresent = true;
    next.correctedAt = at;
    next.correctionVersion = record.coverageCorrection.version;
    index.corrections[runKey] = {
      runKey,
      at,
      version: record.coverageCorrection.version,
      scope: 'coverage',
      previous: previous.coverage || null,
      next: next.coverage,
    };
    pushDiagnostic(index, 'corrections', { runKey });
  }
  index.runs[runKey] = next;
}

/**
 * Apply every committed journal record newer than the last scan, reading only
 * files whose size changed. A missing index entry is recovered from the journal
 * (crash after append, before index write).
 *
 * @param {Record<string, any>} index
 * @param {Record<string, any>} ctx
 */
function recoverIndexFromJournal(index, ctx = {}) {
  if (!index.fileScan) index.fileScan = {};
  if (!index.rawPrefix) index.rawPrefix = {};
  let filesRead = 0;
  let applied = 0;
  let corruptCount = 0;
  const fullRebuild = index.lastSeq === 0 && Object.keys(index.fileScan).length === 0;
  /** @type {Array<{ day: string, file: string, scan: Record<string, any>|undefined, stat: import('fs').Stats }>} */
  const pending = [];
  for (const name of listJournalFiles(index.dir)) {
    const day = name.replace(/\.jsonl$/, '');
    const file = path.join(index.dir, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const scan = index.fileScan[day];
    if (scan && scan.size === stat.size) continue;
    pending.push({ day, file, scan, stat });
  }
  filesRead = pending.length;
  const sortBySeq = pending.length > 1;
  if (sortBySeq) {
    /** @type {Record<string, any>[]} */
    const batch = [];
    /** @type {Array<{ day: string, stat: import('fs').Stats, corrupt: Record<string, any>[], rawSeen: number, rawPending: Record<string, any>[] }>} */
    const fileUpdates = [];
    for (const { day, file, scan, stat } of pending) {
      const { records, corrupt } = parseJournalFile(file);
      const prevCorruptLines = new Set(Array.isArray(scan?.corruptLines) ? scan.corruptLines : []);
      for (const row of corrupt) {
        if (!prevCorruptLines.has(row.line)) corruptCount += 1;
      }
      let rawSeen = 0;
      /** @type {Record<string, any>[]} */
      const rawPending = [];
      for (const record of records) {
        const isRaw = record.legacy === true || record.seq == null;
        if (isRaw) {
          rawSeen += 1;
          if (rawSeen <= (index.rawPrefix[day] || 0)) continue;
          rawPending.push(record);
          continue;
        }
        batch.push(record);
      }
      fileUpdates.push({ day, stat, corrupt, rawSeen, rawPending });
    }
    let maxEnvelopeSeq = index.lastSeq;
    for (const record of batch) {
      if (record.legacy === true || record.seq == null) continue;
      maxEnvelopeSeq = Math.max(maxEnvelopeSeq, Number(record.seq));
    }
    let assignSeq = maxEnvelopeSeq;
    for (const update of fileUpdates) {
      for (const raw of update.rawPending) {
        assignSeq += 1;
        batch.push({
          ...raw,
          seq: assignSeq,
          kind: 'usage',
          at: raw.at || raw.event?.at,
          _syntheticSeq: true,
        });
      }
      index.rawPrefix[update.day] = update.rawSeen;
    }
    batch.sort((left, right) => {
      const seqDiff = Number(left.seq) - Number(right.seq);
      if (seqDiff !== 0) return seqDiff;
      const leftSynthetic = left._syntheticSeq === true || left.legacy === true;
      const rightSynthetic = right._syntheticSeq === true || right.legacy === true;
      if (leftSynthetic !== rightSynthetic) return leftSynthetic ? 1 : -1;
      return String(left.at || '').localeCompare(String(right.at || ''));
    });
    for (const record of batch) {
      if (Number(record.seq) <= index.lastSeq) continue;
      applyRecordToIndex(index, record);
      applied += 1;
    }
    for (const update of fileUpdates) {
      index.fileScan[update.day] = {
        size: update.stat.size,
        maxSeq: index.lastSeq,
        corruptLines: update.corrupt.map((row) => row.line),
      };
    }
  } else {
    for (const { day, file, scan, stat } of pending) {
      const { records, corrupt } = parseJournalFile(file);
      const prevCorruptLines = new Set(Array.isArray(scan?.corruptLines) ? scan.corruptLines : []);
      for (const row of corrupt) {
        if (!prevCorruptLines.has(row.line)) corruptCount += 1;
      }
      let rawSeen = 0;
      /** @type {Record<string, any>[]} */
      const envelopePending = [];
      /** @type {Record<string, any>[]} */
      const rawPending = [];
      for (const record of records) {
        const isRaw = record.legacy === true || record.seq == null;
        if (isRaw) {
          rawSeen += 1;
          if (rawSeen <= (index.rawPrefix[day] || 0)) continue;
          rawPending.push(record);
          continue;
        }
        envelopePending.push(record);
      }
      for (const record of envelopePending) {
        if (Number(record.seq) <= index.lastSeq) continue;
        applyRecordToIndex(index, record);
        applied += 1;
      }
      let synthSeq = index.lastSeq;
      for (const raw of rawPending) {
        synthSeq += 1;
        raw.seq = synthSeq;
        raw.kind = 'usage';
        raw.at = raw.at || raw.event?.at;
        applyRecordToIndex(index, raw);
        applied += 1;
      }
      index.rawPrefix[day] = rawSeen;
      index.fileScan[day] = {
        size: stat.size,
        maxSeq: index.lastSeq,
        corruptLines: corrupt.map((row) => row.line),
      };
    }
  }
  if (corruptCount > 0) {
    index.diagnostics.corrupt += corruptCount;
    const corruptSamples = index.diagnostics.samples?.corrupt;
    if (Array.isArray(corruptSamples) && corruptSamples.length < MAX_DIAGNOSTIC_SAMPLES) {
      corruptSamples.push({
        at: new Date().toISOString(),
        count: corruptCount,
        context: ctx.reason || 'recovery',
      });
    }
  }
  reconcileRunPartialFlags(index);
  index._lastScan = { filesRead, recordsApplied: applied, fullRebuild: fullRebuild && filesRead > 0 };
}

/**
 * @param {string} dir
 * @param {Record<string, any>} persisted
 * @returns {Record<string, any>}
 */
function normalizeIndex(dir, persisted) {
  const index = emptyIndex(dir);
  if (!persisted || typeof persisted !== 'object') return index;
  index.lastSeq = Number(persisted.lastSeq) || 0;
  index.fileMaxSeq = persisted.fileMaxSeq && typeof persisted.fileMaxSeq === 'object' ? persisted.fileMaxSeq : {};
  index.fileScan = persisted.fileScan && typeof persisted.fileScan === 'object' ? persisted.fileScan : {};
  index.rawPrefix = persisted.rawPrefix && typeof persisted.rawPrefix === 'object' ? persisted.rawPrefix : {};
  index.keys = persisted.keys && typeof persisted.keys === 'object' ? persisted.keys : {};
  index.baselines = persisted.baselines && typeof persisted.baselines === 'object' ? persisted.baselines : {};
  index.runs = persisted.runs && typeof persisted.runs === 'object' ? persisted.runs : {};
  index.retiredRuns = persisted.retiredRuns && typeof persisted.retiredRuns === 'object' ? persisted.retiredRuns : {};
  index.corrections = persisted.corrections && typeof persisted.corrections === 'object' ? persisted.corrections : {};
  index.supersededKeys = persisted.supersededKeys && typeof persisted.supersededKeys === 'object' ? persisted.supersededKeys : {};
  if (persisted.diagnostics && typeof persisted.diagnostics === 'object') {
    index.diagnostics = {
      ...index.diagnostics,
      ...persisted.diagnostics,
      samples: { ...index.diagnostics.samples, ...(persisted.diagnostics.samples || {}) },
    };
  }
  return index;
}

/**
 * @param {string} file
 * @returns {Record<string, any>|null}
 */
function readIndexFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== USAGE_LEDGER_INDEX_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load/refresh the durable ledger read-model. Must be called inside the writer
 * lock for commits; read-only callers may call it directly.
 *
 * @param {{ dataDir?: string, reason?: string, readOnly?: boolean }} [ctx]
 * @returns {Record<string, any>}
 */
export function refreshLedgerIndex(ctx = {}) {
  const dir = resolveUsageDataDir(ctx.dataDir);
  mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, LEDGER_INDEX_FILE);
  let index = ledgerCache.get(dir);
  let stat = null;
  try {
    stat = statSync(indexFile);
  } catch {
    stat = null;
  }
  const changed =
    !index
    || !index._indexStat
    || !stat
    || stat.mtimeMs !== index._indexStat.mtimeMs
    || stat.size !== index._indexStat.size;
  if (!index || changed) {
    const loaded = stat ? readIndexFile(indexFile) : null;
    index = loaded ? normalizeIndex(dir, loaded) : emptyIndex(dir);
    if (stat) index._indexStat = stat;
    ledgerCache.set(dir, index);
  }
  recoverIndexFromJournal(index, ctx);
  return index;
}

/**
 * @param {Record<string, any>} index
 * @param {Record<string, any>} [ctx]
 */
function persistLedgerIndex(index, ctx = {}) {
  if (ctx.persistIndex === false) return;
  mkdirSync(index.dir, { recursive: true });
  const file = path.join(index.dir, LEDGER_INDEX_FILE);
  const payload = {
    version: USAGE_LEDGER_INDEX_VERSION,
    lastSeq: index.lastSeq,
    fileMaxSeq: index.fileMaxSeq,
    fileScan: index.fileScan,
    rawPrefix: index.rawPrefix,
    keys: index.keys,
    baselines: index.baselines,
    runs: index.runs,
    retiredRuns: index.retiredRuns,
    corrections: index.corrections,
    supersededKeys: index.supersededKeys,
    diagnostics: index.diagnostics,
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const statStart = process.hrtime.bigint();
  const indexText = JSON.stringify(payload);
  const stringifyMs = Number(process.hrtime.bigint() - statStart) / 1e6;
  const ioStart = process.hrtime.bigint();
  writeFileSync(tmp, indexText, 'utf8');
  renameSync(tmp, file);
  recordWriteStat({
    filePath: file,
    bytes: indexText.length,
    stringifyMs,
    ioMs: Number(process.hrtime.bigint() - ioStart) / 1e6,
  });
  try {
    index._indexStat = statSync(file);
  } catch {
    index._indexStat = null;
  }
}

// ---------------------------------------------------------------------------
// Writer lock
// ---------------------------------------------------------------------------

/**
 * @returns {string}
 */
function makeLedgerLockToken() {
  return `${process.pid}:${randomBytes(8).toString('hex')}:${Date.now()}`;
}

/**
 * @param {string} ownerPath
 * @returns {string|null}
 */
function readLockOwnerToken(ownerPath) {
  try {
    return readFileSync(ownerPath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isLockOwnerProcessAlive(token) {
  const pid = Number(String(token || '').split(':')[0]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * @param {string} ownerPath
 * @param {string} expectedToken
 * @param {string} newToken
 * @returns {boolean}
 */
function tryClaimLedgerLock(ownerPath, expectedToken, newToken) {
  const current = readLockOwnerToken(ownerPath);
  if (current == null || current !== expectedToken) return false;
  try {
    unlinkSync(ownerPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  try {
    writeFileSync(ownerPath, `${newToken}\n`, { flag: 'wx' });
    heldLedgerLockToken = newToken;
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Synchronous sleep used only while waiting on the ledger lock.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} lockDir
 * @param {{ lockTimeoutMs?: number, lockStaleMs?: number, dataDir?: string, lock?: boolean }} [ctx]
 */
function acquireLedgerLock(lockDir, ctx = {}) {
  const timeoutMs = Number(ctx.lockTimeoutMs) > 0 ? Number(ctx.lockTimeoutMs) : LOCK_TIMEOUT_MS;
  const startedAt = Date.now();
  mkdirSync(lockDir, { recursive: true });
  const ownerPath = path.join(lockDir, 'owner');
  const token = makeLedgerLockToken();
  for (;;) {
    try {
      writeFileSync(ownerPath, `${token}\n`, { flag: 'wx' });
      heldLedgerLockToken = token;
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingToken = readLockOwnerToken(ownerPath);
      if (!existingToken) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('usage ledger lock timeout');
        }
        sleepSync(5);
        continue;
      }
      if (isLockOwnerProcessAlive(existingToken)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('usage ledger lock timeout');
        }
        sleepSync(5);
        continue;
      }
      if (tryClaimLedgerLock(ownerPath, existingToken, token)) return;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('usage ledger lock timeout');
      }
      sleepSync(5);
    }
  }
}

/**
 * @param {string} lockDir
 */
function releaseLedgerLock(lockDir) {
  const token = heldLedgerLockToken;
  heldLedgerLockToken = null;
  const ownerPath = path.join(lockDir, 'owner');
  try {
    if (token) {
      const current = readFileSync(ownerPath, 'utf8').trim();
      if (current !== token) return;
    }
    unlinkSync(ownerPath);
  } catch {
    /* best effort */
  }
}

/**
 * @template T
 * @param {{ dataDir?: string, lock?: boolean }} ctx
 * @param {() => T} fn
 * @returns {T}
 */
function withLedgerLock(ctx, fn) {
  if (ctx.lock === false) return fn();
  const dir = resolveUsageDataDir(ctx.dataDir);
  mkdirSync(dir, { recursive: true });
  const lockDir = path.join(dir, LEDGER_LOCK_DIR);
  acquireLedgerLock(lockDir, ctx);
  try {
    return fn();
  } finally {
    releaseLedgerLock(lockDir);
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function mergeTokensMonotonic(previous, next) {
  const out = {};
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    out[key] = Math.max(toCount(previous?.[key]), toCount(next?.[key]));
  }
  return out;
}

function deltaTokenBag(current, previous) {
  const out = {};
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(previous || {})]);
  for (const key of keys) {
    out[key] = Math.max(0, toCount(current?.[key]) - toCount(previous?.[key]));
  }
  return out;
}

function hasAnyToken(tokens) {
  return Object.values(tokens || {}).some((value) => Number(value) > 0);
}

// ---------------------------------------------------------------------------
// Identity / run descriptors
// ---------------------------------------------------------------------------

/**
 * Durable run key. A run is identified by runId and/or attempt, falling back to
 * the durable source session. Anonymous runs (no durable id) are never grouped.
 *
 * @param {Record<string, any>} event
 * @returns {string|null}
 */
export function deriveRunKey(event) {
  if (!event || typeof event !== 'object') return null;
  const runId = textOf(event.runId);
  const attemptId = textOf(event.attemptId);
  const sessionId = textOf(event.sourceSessionId);
  if (!runId && !attemptId && !sessionId) return null;
  return JSON.stringify(['run', textOf(event.harness), runId, attemptId, sessionId]);
}

function runDescriptorFromEvent(event) {
  return {
    runKey: deriveRunKey(event),
    harness: textOf(event.harness),
    runId: textOf(event.runId) || undefined,
    attemptId: textOf(event.attemptId) || undefined,
    sourceSessionId: textOf(event.sourceSessionId) || undefined,
    chatId: textOf(event.chatId) || undefined,
    role: textOf(event.role) || undefined,
    model: textOf(event.model) || undefined,
    contextEpoch: event.contextEpoch,
  };
}

// ---------------------------------------------------------------------------
// Commit path
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} index
 * @param {Record<string, any>} event
 * @param {Record<string, any>} hints
 * @param {Record<string, any>} ctx
 * @returns {Record<string, any>}
 */
function classifyCommit(index, event, hints, ctx) {
  const now = nowFrom(ctx.now);
  const runKey = deriveRunKey(event);
  const run = runKey ? index.runs[runKey] : null;
  const retired = runKey && !run ? index.retiredRuns[runKey] : null;
  let resolved = event;
  let snapshot = null;

  // Durable snapshot baseline: recompute the delta against the committed
  // baseline so a restart or an out-of-order snapshot never double counts.
  if (hints.baselineKey && hints.snapshotTokens && event.eventType !== 'run') {
    const baseline = index.baselines[hints.baselineKey];
    const delta = deltaTokenBag(hints.snapshotTokens, baseline?.tokens || {});
    if (!hasAnyToken(delta)) {
      return {
        status: 'empty',
        reason: baseline ? 'out_of_order_or_repeat_snapshot' : 'empty_snapshot',
      };
    }
    resolved = { ...event, tokens: delta };
    snapshot = { baselineKey: hints.baselineKey, tokens: hints.snapshotTokens };
  }

  // Run-ended is exactly once per durable run/attempt key.
  if (event.eventType === 'run' && runKey && run && run.status === 'ended') {
    return { status: 'duplicate', reason: 'duplicate_run_finish', runKey };
  }
  // A finish for an already pruned run must not resurrect it.
  if (event.eventType === 'run' && retired) {
    return { status: 'duplicate', reason: 'retired_run_finish', runKey };
  }

  // Exactly-once applies only to reproducible identities.
  const identityClass = textOf(event.identityClass) || 'none';
  const logicalKey = textOf(event.logicalEventKey);
  if (identityClass !== 'none' && logicalKey) {
    const existing = index.keys[logicalKey];
    if (existing) {
      if (hints.supersedes === true || hints.correction === true) {
        return { status: 'committed', event: resolved, runKey, snapshot, supersede: existing, correction: true };
      }
      return { status: 'duplicate', reason: 'duplicate_logical_key', logicalEventKey: logicalKey };
    }
  }

  // Late usage against an already ended run: inside the 24 h window it may
  // correct coverage/tokens but never the run count; after it (or once the run
  // has been retired by retention) -> stale.
  let stale = false;
  let coverageCorrection = null;
  if (event.eventType !== 'run' && (run?.status === 'ended' || retired)) {
    if (!retired && canAwaitFinalUsage({ endedAt: run.endedAt, now })) {
      const corrected = applyUsageCoverageCorrection({
        runCount: 1,
        previous: {
          completeness: run.completeness || run.coverage?.completeness || 'partial',
          coveredRequests: run.coverage?.coveredRequests ?? run.coveredRequests ?? 0,
        },
        correction: {
          completeness: hints.final === true ? 'complete' : 'partial',
          coveredRequests: Math.max(0, Number(run.coverage?.coveredRequests) || 0) + 1,
        },
      });
      coverageCorrection = {
        completeness: corrected.completeness,
        coveredRequests: corrected.coveredRequests,
        proof: run.coverage?.proof === true || hints.final === true,
        scope: run.coverage?.scope || 'own',
        version: event.normalizationVersion,
      };
    } else {
      stale = true;
    }
  }

  return {
    status: 'committed',
    event: resolved,
    runKey,
    snapshot,
    stale,
    coverageCorrection,
    noneIdentity: identityClass === 'none',
    legacy: hints.legacy === true || event.normalizationVersion == null,
  };
}

/**
 * Append one committed record (with checksum) and fsync it.
 *
 * @param {Record<string, any>} record
 * @param {Record<string, any>} ctx
 * @returns {Record<string, any>}
 */
function appendJournalRecord(record, ctx = {}) {
  const core = recordCore(record);
  const line = `${JSON.stringify({ ...core, crc: recordChecksum(core) })}\n`;
  const file = usageDayPath(ctx.dataDir, record.at);
  mkdirSync(path.dirname(file), { recursive: true });
  const trimmedTail = trimJournalTailIfUnterminated(file);
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, line, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  forgetDayFile(file);
  return { ...core, committed: true, trimmedTail };
}

/**
 * @param {Record<string, any>} index
 * @param {string} at
 * @param {Record<string, any>} ctx
 */
function markJournalFileScanned(index, at, ctx = {}, scanOptions = {}) {
  const day = String(at || '').slice(0, 10) || 'unknown';
  const file = usageDayPath(ctx.dataDir, at);
  try {
    const stat = statSync(file);
    const previous = index.fileScan[day];
    const trimmedTail = scanOptions.trimmedTail === true;
    const hadCorrupt = Array.isArray(previous?.corruptLines) && previous.corruptLines.length > 0;
    if (!trimmedTail && !hadCorrupt) {
      index.fileScan[day] = {
        size: stat.size,
        maxSeq: index.lastSeq,
        corruptLines: previous?.corruptLines || [],
      };
      return;
    }
    const { corrupt } = parseJournalFile(file);
    index.fileScan[day] = {
      size: stat.size,
      maxSeq: index.lastSeq,
      corruptLines: corrupt.map((row) => row.line),
    };
  } catch {
    /* ignore */
  }
}

/**
 * Commit one canonical usage event idempotently.
 *
 * @param {Record<string, any>} event
 * @param {Record<string, any>} [ctx]
 * @param {Record<string, any>} [hints]
 * @returns {Record<string, any>}
 */
export function commitUsageEvent(event, ctx = {}, hints = {}) {
  if (!event || typeof event !== 'object') return { status: 'invalid' };
  return withLedgerLock(ctx, () => {
    const index = refreshLedgerIndex({ ...ctx, reason: 'commit' });
    const decision = classifyCommit(index, event, hints, ctx);
    if (decision.status !== 'committed') {
      if (decision.status === 'duplicate') {
        pushDiagnostic(index, 'duplicates', {
          reason: decision.reason,
          logicalEventKey: decision.logicalEventKey,
          runKey: decision.runKey,
        });
      } else if (decision.status === 'empty') {
        pushDiagnostic(index, 'empty', { reason: decision.reason });
      }
      persistLedgerIndex(index, ctx);
      return decision;
    }
    if (decision.noneIdentity) pushDiagnostic(index, 'noneIdentity', { at: event.at });
    if (decision.stale) pushDiagnostic(index, 'stale', { at: event.at, runKey: decision.runKey });
    if (decision.legacy) pushDiagnostic(index, 'unknown', { at: event.at, reason: 'legacy_event' });
    const supersedeKey = decision.supersede ? textOf(decision.supersede.logicalEventKey) : '';
    const record = recordCore({
      seq: index.lastSeq + 1,
      kind: 'usage',
      at: event.at,
      event: decision.event,
      snapshot: decision.snapshot || undefined,
      stale: decision.stale === true ? true : undefined,
      noneIdentity: decision.noneIdentity === true ? true : undefined,
      coverageCorrection: decision.coverageCorrection || undefined,
      supersede: supersedeKey || undefined,
      correction: decision.correction === true && decision.supersede ? {
        version: decision.event.normalizationVersion,
        scope: 'tokens',
        previous: {
          tokens: decision.supersede.tokens || {},
          provenance: decision.supersede.provenance,
        },
        next: { tokens: decision.event.tokens || {} },
      } : undefined,
    });
    const appended = appendJournalRecord(record, ctx);
    applyRecordToIndex(index, record);
    markJournalFileScanned(index, event.at, ctx, { trimmedTail: appended.trimmedTail === true });
    persistLedgerIndex(index, ctx);
    return {
      status: 'committed',
      seq: record.seq,
      event: decision.event,
      stale: decision.stale === true,
      logicalEventKey: decision.event.logicalEventKey || null,
      runKey: decision.runKey || null,
    };
  });
}

/**
 * Backwards-compatible low-level append. New callers should use
 * `commitUsageEvent` for identity dedup; this simply commits without hints.
 *
 * @param {Record<string, any>} event
 * @param {{ dataDir?: string }} [ctx]
 * @returns {Record<string, any>|null}
 */
export function appendUsageEvent(event, ctx = {}) {
  if (!event || typeof event !== 'object') return null;
  const result = commitUsageEvent(event, ctx);
  return { seq: result.seq, at: event.at, kind: 'usage', status: result.status };
}

/**
 * Persist a run-start record before the harness launches. The returned `runId`
 * is durable even when the transport did not supply one.
 *
 * @param {Record<string, any>} run
 * @param {{ dataDir?: string, now?: number }} [ctx]
 * @returns {Record<string, any>}
 */
export function commitRunStart(run = {}, ctx = {}) {
  const runKey = run.runKey || deriveRunKey(run);
  if (!runKey) return { status: 'invalid' };
  return withLedgerLock(ctx, () => {
    const index = refreshLedgerIndex({ ...ctx, reason: 'run-start' });
    const existing = index.runs[runKey];
    if (existing) return { status: 'existing', runId: existing.runId || run.runId, runKey };
    const record = recordCore({
      seq: index.lastSeq + 1,
      kind: 'run-start',
      at: run.at || new Date().toISOString(),
      run: { ...run, runKey },
    });
    const appended = appendJournalRecord(record, ctx);
    applyRecordToIndex(index, record);
    markJournalFileScanned(index, record.at, ctx, { trimmedTail: appended.trimmedTail === true });
    persistLedgerIndex(index, ctx);
    return { status: 'started', runId: run.runId, runKey, seq: record.seq };
  });
}

// ---------------------------------------------------------------------------
// Read-model snapshots / retention / corrections
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} run
 * @returns {Record<string, any>}
 */
function serializeRun(run) {
  return {
    runKey: run.runKey,
    harness: run.harness || '',
    runId: run.runId || null,
    attemptId: run.attemptId || null,
    sourceSessionId: run.sourceSessionId || null,
    chatId: run.chatId || null,
    role: run.role || null,
    model: run.model || null,
    status: run.status,
    startedAt: run.startedAt || null,
    endedAt: run.endedAt || null,
    outcome: run.outcome || null,
    measurementPresent: run.measurementPresent === true,
    completeness: run.completeness || null,
    coverage: run.coverage || null,
    correctedAt: run.correctedAt || null,
    partial: run.partial === true,
    inferredWithoutRunStart: run.inferredWithoutRunStart === true,
    lastAcceptedAt: run.lastAcceptedAt || null,
  };
}

/**
 * Read-only ledger read-model snapshot (identity keys, runs, baselines,
 * diagnostics, retention).
 *
 * @param {{ dataDir?: string, now?: number, persistIndex?: boolean }} [query]
 * @returns {Record<string, any>}
 */
export function readUsageLedgerState(query = {}) {
  const index = refreshLedgerIndex({ dataDir: query.dataDir, reason: 'read' });
  // Persist a rebuilt read-model once so the next read does not rescan the
  // whole journal (the hot path never performs a full scan).
  if (!index._indexStat && query.persistIndex !== false) {
    try {
      persistLedgerIndex(index, { dataDir: query.dataDir });
    } catch {
      /* read must not fail because the index is unwritable */
    }
  }
  const runs = Object.values(index.runs).map(serializeRun);
  const activeRuns = runs.filter((run) => run.status === 'active').length;
  const endedRuns = runs.filter((run) => run.status === 'ended').length;
  return {
    activeRuns,
    endedRuns,
    runCount: runs.length,
    keyCount: Object.keys(index.keys).length,
    baselineCount: Object.keys(index.baselines).length,
    correctionCount: Object.keys(index.corrections).length,
    // Historical reports must reveal the version and scope of any correction.
    corrections: Object.values(index.corrections)
      .slice(-MAX_DIAGNOSTIC_SAMPLES)
      .map((row) => ({
        key: row.key || row.runKey || null,
        at: row.at || null,
        version: row.version ?? null,
        scope: row.scope || null,
      })),
    supersededKeyCount: Object.keys(index.supersededKeys).length,
    retiredRunCount: Object.keys(index.retiredRuns).length,
    lastSeq: index.lastSeq,
    lastScan: index._lastScan,
    lastReadEventsSupersedeFiles: index._lastReadEventsSupersedeFiles ?? null,
    diagnostics: {
      duplicates: index.diagnostics.duplicates,
      stale: index.diagnostics.stale,
      unknown: index.diagnostics.unknown,
      corrupt: index.diagnostics.corrupt,
      noneIdentity: index.diagnostics.noneIdentity,
      corrections: index.diagnostics.corrections,
      empty: index.diagnostics.empty,
      samples: index.diagnostics.samples,
    },
    retention: {
      keyRetentionMs: USAGE_KEY_RETENTION_MS,
      journalRetentionMs: USAGE_JOURNAL_RETENTION_MS,
      providerRedeliveryHorizonMs: USAGE_PROVIDER_REDELIVERY_HORIZON_MS,
    },
    runs,
  };
}

/**
 * Read one run's durable record (active or ended), or null.
 *
 * @param {string} runKey
 * @param {{ dataDir?: string }} [ctx]
 * @returns {Record<string, any>|null}
 */
export function readUsageRun(runKey, ctx = {}) {
  const index = refreshLedgerIndex({ dataDir: ctx.dataDir, reason: 'read-run' });
  const run = index.runs[runKey];
  return run ? serializeRun(run) : null;
}

/**
 * Effective retention: never shorter than the journal retention or the
 * documented provider redelivery horizon.
 *
 * @param {{ retentionMs?: number }} [ctx]
 * @returns {number}
 */
export function resolveUsageRetentionMs(ctx = {}) {
  return Math.max(
    USAGE_KEY_RETENTION_MS,
    USAGE_JOURNAL_RETENTION_MS,
    USAGE_PROVIDER_REDELIVERY_HORIZON_MS,
    Number(ctx.retentionMs) || 0
  );
}

/**
 * Prune identity keys / baselines of runs closed longer ago than the retention
 * window. Active runs are never removed. Pruned runs become tombstones so a
 * late event is classified `stale` instead of silently starting a new run.
 *
 * @param {{ dataDir?: string, now?: number, retentionMs?: number, pruneJournal?: boolean, dryRun?: boolean }} [ctx]
 * @returns {Record<string, any>}
 */
export function pruneUsageRetention(ctx = {}) {
  const now = nowFrom(ctx.now);
  const retentionMs = resolveUsageRetentionMs(ctx);
  return withLedgerLock(ctx, () => {
    const index = refreshLedgerIndex({ ...ctx, reason: 'retention' });
    const prunedRunKeys = [];
    const removedKeys = [];
    for (const [runKey, run] of Object.entries(index.runs)) {
      if (run.status === 'active') continue; // active runs are never pruned
      const closedAt = Date.parse(run.lastAcceptedAt || run.endedAt || run.startedAt || '');
      if (!Number.isFinite(closedAt)) continue;
      if (now - closedAt <= retentionMs) continue;
      prunedRunKeys.push(runKey);
      for (const [key, record] of Object.entries(index.keys)) {
        const keyRunKey = deriveRunKey(record);
        if (keyRunKey && keyRunKey === runKey) removedKeys.push(key);
      }
    }
    const removedBaselines = [];
    for (const [key, baseline] of Object.entries(index.baselines)) {
      if (baseline.runKey && prunedRunKeys.includes(baseline.runKey)) removedBaselines.push(key);
    }
    const journalFiles = [];
    if (ctx.pruneJournal === true) {
      const cutoff = new Date(now - retentionMs).toISOString().slice(0, 10);
      for (const name of listJournalFiles(index.dir)) {
        const day = name.replace(/\.jsonl$/, '');
        if (day < cutoff) journalFiles.push(name);
      }
    }
    const plan = {
      now,
      retentionMs,
      prunedRunKeys,
      removedKeys,
      removedBaselines,
      journalFiles,
    };
    if (ctx.dryRun === true) return { ...plan, dryRun: true, applied: false };
    if (prunedRunKeys.length > 0) {
      const record = recordCore({
        seq: index.lastSeq + 1,
        kind: 'retention-prune',
        at: new Date(now).toISOString(),
        prunedKeys: prunedRunKeys,
      });
      const appendedPrune = appendJournalRecord(record, ctx);
      applyRecordToIndex(index, record);
      markJournalFileScanned(index, record.at, ctx, { trimmedTail: appendedPrune.trimmedTail === true });
    }
    if (removedKeys.length > 0 || removedBaselines.length > 0) {
      const keyRecord = recordCore({
        seq: index.lastSeq + 1,
        kind: 'key-prune',
        at: new Date(now).toISOString(),
        removedKeys,
        removedBaselines: removedBaselines.length > 0 ? removedBaselines : undefined,
      });
      const appendedKeyPrune = appendJournalRecord(keyRecord, ctx);
      applyRecordToIndex(index, keyRecord);
      markJournalFileScanned(index, keyRecord.at, ctx, { trimmedTail: appendedKeyPrune.trimmedTail === true });
    }
    for (const name of journalFiles) {
      try {
        rmSync(path.join(index.dir, name), { force: true });
        forgetDayFile(path.join(index.dir, name));
      } catch {
        /* ignore */
      }
    }
    persistLedgerIndex(index, ctx);
    return { ...plan, dryRun: false, applied: true };
  });
}

/**
 * True when a run key is only known as a pruned tombstone (late event after the
 * retention horizon).
 *
 * @param {string} runKey
 * @param {{ dataDir?: string }} [ctx]
 * @returns {boolean}
 */
export function isRetiredUsageRun(runKey, ctx = {}) {
  if (!runKey) return false;
  const index = refreshLedgerIndex({ dataDir: ctx.dataDir, reason: 'read-retired' });
  return Boolean(index.retiredRuns[runKey]);
}

/**
 * Idempotent legacy correction/supersede. The previous logical event is
 * superseded (replaced) rather than charged a second time. Supports a dry-run
 * comparison; a repeat with the same key is a no-op.
 *
 * @param {{ dataDir?: string, now?: number, dryRun?: boolean, corrections?: Array<Record<string, any>> }} [ctx]
 * @returns {Record<string, any>}
 */
export function applyUsageCorrections(ctx = {}) {
  const corrections = Array.isArray(ctx.corrections) ? ctx.corrections : [];
  const now = nowFrom(ctx.now);
  return withLedgerLock(ctx, () => {
    const index = refreshLedgerIndex({ ...ctx, reason: 'corrections' });
    const changes = [];
    const skipped = [];
    const plannedKeys = new Set();
    for (const correction of corrections) {
      const key = textOf(correction?.logicalEventKey);
      if (!key) {
        skipped.push({ logicalEventKey: null, reason: 'missing_logical_key' });
        continue;
      }
      const existing = index.keys[key];
      if (!existing) {
        skipped.push({ logicalEventKey: key, reason: 'unknown_logical_key' });
        continue;
      }
      const supersedeMeta = index.supersededKeys[key];
      if (supersedeMeta && supersedeMeta.pendingReplacement !== true) {
        skipped.push({ logicalEventKey: key, reason: 'already_superseded' });
        continue;
      }
      if (plannedKeys.has(key)) {
        skipped.push({ logicalEventKey: key, reason: 'duplicate' });
        continue;
      }
      plannedKeys.add(key);
      changes.push({
        logicalEventKey: key,
        previous: { tokens: existing.tokens, provenance: existing.provenance },
        next: {
          tokens: correction.tokens && typeof correction.tokens === 'object' ? correction.tokens : existing.tokens,
          coverage: correction.coverage || null,
        },
        version: USAGE_NORMALIZATION_VERSION,
        scope: correction.coverage ? 'tokens+coverage' : 'tokens',
      });
    }
    if (ctx.dryRun === true) return { dryRun: true, applied: 0, changes, skipped };
    if (changes.length === 0) {
      return { dryRun: false, applied: 0, changes, skipped, backupDir: null };
    }
    const backupDir = backupUsageLedgerBeforeMutation(ctx);
    let applied = 0;
    let seq = index.lastSeq;
    const scannedDays = new Map();
    for (const change of changes) {
      const existing = index.keys[change.logicalEventKey];
      if (!existing) continue;
      const pendingOnly = index.supersededKeys[change.logicalEventKey]?.pendingReplacement === true;
      const correctionAt = new Date(now).toISOString();
      const correctionMeta = {
        version: change.version,
        scope: change.scope,
        previous: change.previous,
        next: change.next,
      };
      if (!pendingOnly) {
        seq += 1;
        const correctionRecord = recordCore({
          seq,
          kind: 'correction',
          at: correctionAt,
          supersede: change.logicalEventKey,
          correction: correctionMeta,
        });
        const correctionAppended = appendJournalRecord(correctionRecord, ctx);
        applyRecordToIndex(index, correctionRecord);
        scannedDays.set(String(correctionAt).slice(0, 10), correctionAppended.trimmedTail === true);
      }
      seq += 1;
      const hintDay = String(existing.at || '').slice(0, 10);
      const originalEvent = findCommittedUsageEventByLogicalKey(
        resolveUsageDataDir(ctx.dataDir),
        change.logicalEventKey,
        hintDay
      );
      let replacementEvent = buildCorrectionReplacementEvent(originalEvent, change);
      if (!replacementEvent) {
        replacementEvent = eventFromIndexKeyRow(existing);
        if (replacementEvent && change.next?.tokens) {
          replacementEvent.tokens = change.next.tokens;
          replacementEvent.normalizationVersion = change.version;
        }
      }
      if (!replacementEvent) continue;
      const usageRecord = recordCore({
        seq,
        kind: 'usage',
        at: existing.at || correctionAt,
        event: replacementEvent,
        supersede: change.logicalEventKey,
        correction: correctionMeta,
      });
      const usageAppended = appendJournalRecord(usageRecord, ctx);
      applyRecordToIndex(index, usageRecord);
      const usageDay = String(existing.at || correctionAt).slice(0, 10);
      scannedDays.set(usageDay, scannedDays.get(usageDay) === true || usageAppended.trimmedTail === true);
      applied += 1;
    }
    for (const [day, trimmedTail] of scannedDays) {
      markJournalFileScanned(index, `${day}T12:00:00.000Z`, ctx, { trimmedTail });
    }
    persistLedgerIndex(index, ctx);
    return { dryRun: false, applied, changes, skipped, backupDir };
  });
}

/**
 * Explicit repair: drop the in-memory index and rebuild it from the committed
 * journal.
 *
 * @param {{ dataDir?: string }} [ctx]
 * @returns {Record<string, any>}
 */
export function repairUsageLedger(ctx = {}) {
  const dir = resolveUsageDataDir(ctx.dataDir);
  ledgerCache.delete(dir);
  const index = emptyIndex(dir);
  recoverIndexFromJournal(index, { ...ctx, reason: 'explicit-repair' });
  ledgerCache.set(dir, index);
  persistLedgerIndex(index, ctx);
  return {
    lastSeq: index.lastSeq,
    keyCount: Object.keys(index.keys).length,
    runCount: Object.keys(index.runs).length,
    baselineCount: Object.keys(index.baselines).length,
    lastScan: index._lastScan,
    diagnostics: {
      duplicates: index.diagnostics.duplicates,
      stale: index.diagnostics.stale,
      unknown: index.diagnostics.unknown,
      corrupt: index.diagnostics.corrupt,
      noneIdentity: index.diagnostics.noneIdentity,
      corrections: index.diagnostics.corrections,
      empty: index.diagnostics.empty,
      samples: index.diagnostics.samples,
    },
  };
}

/**
 * Test seam: drop every cached day file and read-model for a data dir.
 *
 * @param {string} [dataDir]
 */
export function resetUsageLedgerCache(dataDir) {
  if (dataDir == null) {
    dayFileCache.clear();
    dayFileCacheBytes = 0;
    dayFileCacheHits = 0;
    dayFileCacheParses = 0;
    ledgerCache.clear();
    return;
  }
  const dir = resolveUsageDataDir(dataDir);
  ledgerCache.delete(dir);
  for (const key of [...dayFileCache.keys()]) {
    if (key.startsWith(dir)) forgetDayFile(key);
  }
}
