/**
 * Durable store for model_pick proposals and slot reservations.
 *
 * One JSON document (`data/model-pick-decisions.json`) holds every open and
 * executed pick. Every read-modify-write (create, purge, reserve, release) runs
 * inside a cross-process lock: SQLite's write lock on a sibling
 * `model-pick-decisions.lock.sqlite` (the same mutex the workspace watcher store
 * uses). `BEGIN IMMEDIATE` is an OS record lock tied to the open descriptor, so
 * a crashed holder releases it in the kernel and no stale-lock detector exists.
 * Two processes can therefore never both reserve one slot or lose each other's
 * document update.
 */

import { normalizeComplexity } from '../model-pick-complexity.js';
import { normalizeComplexityShadow } from '../model-pick-complexity-classifier.js';
import { normalizeCostPolicyRecord } from '../model-pick-cost-policy.js';
import { normalizeCostProxy } from '../model-pick-cost-proxy-record.js';
import { normalizeBenchmarkShadow } from '../model-pick-benchmark.js';
import { normalizePlanPaceSnapshot } from '../model-pick-plan-window.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { recordWriteStat, writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  MODEL_PICK_EXPLORE_MAX_EXECUTOR_MS,
  MODEL_PICK_EXPLORE_MAX_USD,
  MODEL_PICK_MAX_CANDIDATES,
  MODEL_PICK_MAX_SLOTS,
  MODEL_PICK_RETENTION_MS,
  MODEL_PICK_TTL_MS,
} from '../model-pick-policy.js';

export const MODEL_PICK_DECISIONS_FILE = resolveDataPath('model-pick-decisions.json');
export const MODEL_PICK_DECISIONS_SCHEMA_VERSION = 1;
/** Picks that reserved a slot are kept longer (delegation replay), but not forever. */
export const MODEL_PICK_SLOTTED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Hard cap on stored picks; the oldest by `createdAt` go first. */
export const MODEL_PICK_MAX_RECORDS = 5000;

/**
 * Bounded retention for the pick map. Open (slot-less) picks expire after
 * `MODEL_PICK_RETENTION_MS`, slotted ones after `MODEL_PICK_SLOTTED_RETENTION_MS`;
 * then the newest `MODEL_PICK_MAX_RECORDS` are kept. Rows with an unparsable
 * `createdAt` are kept until the cap evicts them (oldest = unknown first).
 *
 * @param {Record<string, Record<string, any>>} picks already-normalized rows
 * @param {number} now
 * @returns {Record<string, Record<string, any>>}
 */
export function applyModelPickRetention(picks, now) {
  /** @type {[string, Record<string, any>, number][]} */
  const kept = [];
  for (const [id, row] of Object.entries(picks || {})) {
    const createdMs = Date.parse(row?.createdAt);
    const hasSlot = Object.keys(row?.slots || {}).length > 0;
    const limit = hasSlot ? MODEL_PICK_SLOTTED_RETENTION_MS : MODEL_PICK_RETENTION_MS;
    if (Number.isFinite(createdMs) && now - createdMs > limit) continue;
    kept.push([id, row, Number.isFinite(createdMs) ? createdMs : 0]);
  }
  if (kept.length > MODEL_PICK_MAX_RECORDS) {
    kept.sort((a, b) => a[2] - b[2]);
    kept.splice(0, kept.length - MODEL_PICK_MAX_RECORDS);
  }
  return Object.fromEntries(kept.map(([id, row]) => [id, row]));
}

/**
 * One-off safe prune of an existing document: copies the file to
 * `<file>.pre-prune.bak` (never overwritten) before rewriting it pruned.
 *
 * @param {{ file?: string, now?: number }} [options]
 * @returns {{ pruned: boolean, before: number, after: number, backup: string | null }}
 */
export function pruneModelPickDecisionsFile(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    const before = Object.keys(doc.picks).length;
    const rows = loadModelPickRecords({ file, now });
    const after = Object.keys(rows).length;
    if (after === before) return { pruned: false, before, after, backup: null };
    const backup = `${file}.pre-prune.bak`;
    if (!fs.existsSync(backup)) {
      // The document may live only in the journal (no snapshot yet): keep both.
      if (fs.existsSync(file)) fs.copyFileSync(file, backup);
      else fs.writeFileSync(backup, JSON.stringify(doc), 'utf8');
      if (fs.existsSync(journalPath(file))) fs.copyFileSync(journalPath(file), `${backup}.journal`);
    }
    doc.picks = rows;
    compactSnapshot(file, doc);
    return { pruned: true, before, after, backup };
  });
}

/** How long a writer waits for the cross-process document lock. */
export const MODEL_PICK_LOCK_TIMEOUT_MS = 5_000;
const LOCK_BUSY_ERRCODE = 5;

/** @type {Map<string, DatabaseSync>} */
const lockDbs = new Map();
/** @type {Map<string, number>} */
const heldLocks = new Map();

/**
 * @param {number} ms
 */
function sleepMs(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {any} error
 * @returns {boolean}
 */
function isBusyError(error) {
  if (!error || typeof error !== 'object') return false;
  const source = /** @type {{ errcode?: unknown, message?: unknown }} */ (error);
  return Number(source.errcode) === LOCK_BUSY_ERRCODE || /database is locked/i.test(String(source.message ?? ''));
}

export class ModelPickLockError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ModelPickLockError';
    this.code = 'lock_timeout';
  }
}

/**
 * Run `work` (synchronous) while holding the cross-process lock of the
 * document. Re-entrant inside one process.
 *
 * @template T
 * @param {string} file
 * @param {() => T} work
 * @param {Record<string, any>} [options]
 * @returns {T}
 */
export function withModelPickFileLock(file, work, options = {}) {
  const held = heldLocks.get(file);
  if (held != null) {
    heldLocks.set(file, held + 1);
    try {
      return work();
    } finally {
      const next = (heldLocks.get(file) || 1) - 1;
      if (next > 0) heldLocks.set(file, next);
      else heldLocks.delete(file);
    }
  }
  const lockDbPath = path.join(path.dirname(file), 'model-pick-decisions.lock.sqlite');
  let db = lockDbs.get(lockDbPath);
  if (!db) {
    fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
    db = new DatabaseSync(lockDbPath);
    db.exec('PRAGMA busy_timeout = 0;');
    lockDbs.set(lockDbPath, db);
  }
  const configured = Number(options.lockTimeoutMs);
  const timeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : MODEL_PICK_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (!isBusyError(error)) throw new ModelPickLockError(`Could not acquire the model pick store lock: ${error?.message || error}`);
      if (Date.now() >= deadline) throw new ModelPickLockError('Timed out waiting for the model pick store lock.');
      sleepMs(backoff);
      backoff = Math.min(50, Math.round(backoff * 1.6));
    }
  }
  heldLocks.set(file, 1);
  try {
    return work();
  } finally {
    heldLocks.delete(file);
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt += 1) {
      try {
        db.exec('COMMIT');
        done = true;
      } catch (error) {
        if (!isBusyError(error)) break;
        sleepMs(2 * (attempt + 1));
      }
    }
    if (!done) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Closing the connection drops the OS lock with the descriptor.
        lockDbs.delete(lockDbPath);
        try { db.close(); } catch { /* already closed */ }
      }
    }
  }
}

/**
 * Append-only journal next to the snapshot (`<file>.journal`, JSONL). A
 * mutation appends one small `put`/`del` op instead of rewriting the whole
 * (tens of MB) snapshot; the snapshot is rewritten only on compaction. Readers
 * replay the journal over the snapshot, so the legacy snapshot format is
 * unchanged and a store without a journal reads exactly as before. Replaying an
 * op is idempotent (last op per id wins), so a crash between "snapshot written"
 * and "journal removed" loses nothing. A torn last line is ignored.
 */
export const MODEL_PICK_JOURNAL_COMPACT_LINES = 500;
export const MODEL_PICK_JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;

/**
 * In-memory copy of the document, keyed by file, valid while the snapshot
 * signature is unchanged and the journal is only extended past `jOffset`
 * (appended tails are replayed incrementally, never re-parsed from scratch).
 *
 * @type {Map<string, { sig: string, doc: Record<string, any>, jIno: string, jOffset: number, jLines: number }>}
 */
const documentCache = new Map();

/** Counters for tests and diagnostics. */
export const modelPickDocumentStats = {
  parses: 0,
  cacheHits: 0,
  journalAppends: 0,
  journalBytes: 0,
  snapshotWrites: 0,
};

/** @param {string} file */
function journalPath(file) {
  return `${file}.journal`;
}

/** @param {string} file */
function statBig(file) {
  try {
    return fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
}

/** @param {any} st */
function sigOf(st) {
  return st ? `${st.ino}:${st.mtimeNs}:${st.size}` : '';
}

/**
 * @param {string} file
 * @returns {string} '' when the file is missing/unreadable
 */
function fileSignature(file) {
  return sigOf(statBig(file));
}

/**
 * Signature of snapshot + journal; changes on every persisted mutation.
 * `'|'` means neither file exists.
 *
 * @param {string} file
 * @returns {string}
 */
export function modelPickStoreSignature(file) {
  return `${fileSignature(file)}|${fileSignature(journalPath(file))}`;
}

/** Drop cached documents (all, or one file). Test hook and error recovery. */
export function resetModelPickDocumentCache(file) {
  if (file) documentCache.delete(file);
  else documentCache.clear();
}

/**
 * Apply the complete lines of `buf` to `picks`.
 *
 * @param {Record<string, any>} picks
 * @param {Buffer} buf
 * @returns {{ consumed: number, lines: number }} bytes up to the last newline
 */
function replayJournal(picks, buf) {
  const end = buf.lastIndexOf(10);
  if (end < 0) return { consumed: 0, lines: 0 };
  let lines = 0;
  for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
    if (!line) continue;
    lines += 1;
    try {
      const op = JSON.parse(line);
      if (op?.op === 'put' && typeof op.id === 'string' && op.id && op.row && typeof op.row === 'object') {
        picks[op.id] = op.row;
      } else if (op?.op === 'del' && Array.isArray(op.ids)) {
        for (const id of op.ids) delete picks[String(id)];
      }
    } catch { /* corrupt line: skip, later ops still apply */ }
  }
  return { consumed: end + 1, lines };
}

/**
 * @param {string} file
 * @param {number} offset
 * @returns {Buffer}
 */
function readJournalTail(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Returns the (cached) document. Callers mutate `doc.picks` only right before
 * `persistOps`, which journals the change; a failed persist drops the cache.
 *
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readDocument(file) {
  const sSig = fileSignature(file);
  const jp = journalPath(file);
  const jst = statBig(jp);
  const cached = documentCache.get(file);
  if (cached && cached.sig === sSig) {
    if (!jst && cached.jOffset === 0 && cached.jIno === '') {
      modelPickDocumentStats.cacheHits += 1;
      return cached.doc;
    }
    if (jst && String(jst.ino) === cached.jIno && jst.size >= BigInt(cached.jOffset)) {
      if (jst.size > BigInt(cached.jOffset)) {
        try {
          const { consumed, lines } = replayJournal(cached.doc.picks, readJournalTail(jp, cached.jOffset));
          cached.jOffset += consumed;
          cached.jLines += lines;
        } catch {
          documentCache.delete(file);
          return readDocument(file);
        }
      }
      modelPickDocumentStats.cacheHits += 1;
      return cached.doc;
    }
  }
  documentCache.delete(file);
  /** @type {Record<string, any>} */
  let picks = {};
  modelPickDocumentStats.parses += 1;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.picks && typeof parsed.picks === 'object') picks = parsed.picks;
  } catch { /* missing or unreadable snapshot: the journal may still replay */ }
  let jOffset = 0;
  let jLines = 0;
  if (jst) {
    try {
      const replayed = replayJournal(picks, readJournalTail(jp, 0));
      jOffset = replayed.consumed;
      jLines = replayed.lines;
    } catch { /* journal vanished mid-read: treat as absent */ }
  }
  const doc = { schemaVersion: MODEL_PICK_DECISIONS_SCHEMA_VERSION, picks };
  // Re-stat after the read: cache only when neither file moved meanwhile.
  const jAfter = statBig(jp);
  if (fileSignature(file) === sSig && String(jAfter?.ino ?? '') === String(jst?.ino ?? '')) {
    documentCache.set(file, { sig: sSig, doc, jIno: jst ? String(jst.ino) : '', jOffset, jLines });
  }
  return doc;
}

/**
 * Full snapshot rewrite (compaction): folds the journal into the snapshot and
 * removes it. Amortised over `MODEL_PICK_JOURNAL_COMPACT_*` mutations.
 *
 * @param {string} file
 * @param {Record<string, any>} doc
 */
function compactSnapshot(file, doc) {
  documentCache.delete(file);
  writeJsonAtomic(file, doc, 'utf8', { compact: true });
  modelPickDocumentStats.snapshotWrites += 1;
  try {
    fs.rmSync(journalPath(file), { force: true });
  } catch {
    return; // stale journal replays idempotently; the next read re-syncs
  }
  const sig = fileSignature(file);
  if (sig) documentCache.set(file, { sig, doc, jIno: '', jOffset: 0, jLines: 0 });
}

/**
 * Journal the mutation(s) already applied to `doc.picks`.
 *
 * @param {string} file
 * @param {Record<string, any>} doc
 * @param {Record<string, any>[]} ops
 */
function persistOps(file, doc, ops) {
  const jp = journalPath(file);
  const entry = documentCache.get(file);
  try {
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    const fd = fs.openSync(jp, 'a+');
    let bytes = 0;
    let size = 0;
    let ino = '';
    const ioStart = process.hrtime.bigint();
    try {
      const before = fs.fstatSync(fd);
      let prefix = '';
      if (before.size > 0) {
        // A torn tail has no newline: terminate it so it cannot swallow this op.
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, before.size - 1);
        if (last[0] !== 10) prefix = '\n';
      }
      const data = Buffer.from(`${prefix}${ops.map((op) => JSON.stringify(op)).join('\n')}\n`);
      fs.writeSync(fd, data);
      bytes = data.length;
      const after = fs.fstatSync(fd);
      size = after.size;
      ino = String(after.ino);
    } finally {
      fs.closeSync(fd);
    }
    modelPickDocumentStats.journalAppends += 1;
    modelPickDocumentStats.journalBytes += bytes;
    recordWriteStat({ filePath: jp, bytes, ioMs: Number(process.hrtime.bigint() - ioStart) / 1e6 });
    if (!entry || entry.doc !== doc || (entry.jIno && entry.jIno !== ino) || size !== entry.jOffset + bytes) {
      // Someone else appended or a torn tail is pending: re-sync on next read.
      documentCache.delete(file);
      return;
    }
    entry.jIno = ino;
    entry.jOffset = size;
    entry.jLines += ops.length;
    if (entry.jLines >= MODEL_PICK_JOURNAL_COMPACT_LINES || entry.jOffset >= MODEL_PICK_JOURNAL_COMPACT_BYTES) {
      compactSnapshot(file, doc);
    }
  } catch (error) {
    documentCache.delete(file);
    throw error;
  }
}

/**
 * @param {any} value
 * @returns {string}
 */
function candidateIdOf(value) {
  const harness = String(value?.harness || '').trim().toLowerCase();
  const model = String(value?.model || '').trim();
  if (!harness || !model) return '';
  return `${harness}/${model}`;
}

/**
 * The out-of-band exploration marker of a proposal. Bounded and prompt-free by
 * construction: it names the pair, the cohort segment it was chosen under, and
 * the ceiling the attempt may not exceed — nothing else. `mode` stays `dry-run`
 * unless real exploration was deliberately enabled.
 *
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Record<string, any> | null}
 */
export function normalizeModelPickExploreMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const harness = String(raw.harness || '').trim().toLowerCase();
  const model = String(raw.model || '').trim();
  const role = String(raw.role || '').trim().toLowerCase();
  const pairKey = String(raw.pairKey || '').trim().toLowerCase();
  if (!harness || !model || !role || !pairKey) return null;
  const mode = String(raw.mode || '').trim().toLowerCase();
  const budget = Number(raw.budgetUsd);
  const executor = Number(raw.maxExecutorMs);
  return {
    pairKey,
    harness,
    model,
    baseModel: String(raw.baseModel || '').trim().toLowerCase(),
    role,
    mode: mode === 'real' ? 'real' : 'dry-run',
    segment: String(raw.segment || '').trim().slice(0, 120),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.min(budget, MODEL_PICK_EXPLORE_MAX_USD) : 0,
    maxExecutorMs: Number.isFinite(executor) && executor > 0
      ? Math.min(executor, MODEL_PICK_EXPLORE_MAX_EXECUTOR_MS)
      : 0,
  };
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any> | null}
 */
export function normalizeModelPickRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id || '').trim();
  if (!id) return null;
  const createdAt = String(input.createdAt || '').trim();
  const expiresAt = String(input.expiresAt || '').trim();
  const chatId = String(input.chatId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const purpose = String(input.purpose || '').trim();
  const role = String(input.role || '').trim().toLowerCase();
  const policyVersion = String(input.policyVersion || '').trim();
  /** @type {Record<string, any>[]} */
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.slice(0, MODEL_PICK_MAX_CANDIDATES).map((row) => ({
      // Audit-only candidates carry no slot; `Number(null)` must not read as 0.
      selectionSlot: row?.selectionSlot != null && Number.isInteger(Number(row.selectionSlot)) ? Number(row.selectionSlot) : null,
      candidateId: String(row?.candidateId || candidateIdOf(row)).trim() || candidateIdOf(row),
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
    })).filter((row) => row.harness && row.model)
    : [];
  /** @type {Record<string, any>[]} */
  const picks = Array.isArray(input.picks)
    ? input.picks.slice(0, MODEL_PICK_MAX_SLOTS).map((row, index) => ({
      // Explicit null/undefined must not become slot 0 via Number(null).
      selectionSlot: row?.selectionSlot != null && Number.isInteger(Number(row.selectionSlot)) && Number(row.selectionSlot) >= 0
        ? Number(row.selectionSlot)
        : index,
      candidateId: String(row?.candidateId || candidateIdOf(row)).trim() || candidateIdOf(row),
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
      originDetailHint: String(row?.originDetailHint || '').trim(),
    })).filter((row) => row.harness && row.model)
    : [];
  const slotsRaw = input.slots && typeof input.slots === 'object' ? input.slots : {};
  /** @type {Record<string, { delegationId: string, idempotencyKey: string, reservedAt: string }>} */
  const slots = {};
  for (const [key, slot] of Object.entries(slotsRaw)) {
    if (!slot || typeof slot !== 'object') continue;
    const delegationId = String(slot.delegationId || '').trim();
    const idempotencyKey = String(slot.idempotencyKey || '').trim();
    if (!delegationId || !idempotencyKey) continue;
    slots[String(key)] = {
      delegationId,
      idempotencyKey,
      reservedAt: String(slot.reservedAt || '').trim(),
    };
  }
  const leafId = String(input.leafId || input.leaf_id || '').trim();
  const leafSource = String(input.leafSource || input.leaf_source || '').trim();
  const complexity = normalizeComplexity(input.complexity);
  const complexityShadow = normalizeComplexityShadow(input.complexityShadow);
  const costProxy = normalizeCostProxy(input.costProxy);
  const benchmark = normalizeBenchmarkShadow(input.benchmark);
  const costPolicy = normalizeCostPolicyRecord(input.costPolicy);
  return {
    id,
    createdAt,
    expiresAt,
    chatId,
    workspaceFolder,
    purpose,
    role,
    policyVersion,
    explore: normalizeModelPickExploreMarker(input.explore),
    candidates,
    picks,
    slots,
    ...(leafId ? { leafId } : {}),
    ...(leafSource ? { leafSource } : {}),
    // Closed-list level + signal codes only; never the leaf text.
    ...(complexity ? { complexity } : {}),
    // Decision-classifier shadow: closed lists + level distribution only.
    ...(complexityShadow ? { complexityShadow } : {}),
    // RCU index with basis/tokenSource only; never a `usd` field.
    ...(costProxy ? { costProxy } : {}),
    // Shadow benchmark signal (scores, weight, source, date); never a selection input.
    ...(benchmark ? { benchmark } : {}),
    // Closed reason codes and candidate ids only.
    ...(costPolicy ? { costPolicy } : {}),
    // Pick-time weekly pace snapshot (same `now`/planLimits as the decision),
    // bounded like the other telemetry. `null` for a pick made without pace.
    planPace: normalizePlanPaceSnapshot(input.planPace),
  };
}

/**
 * @param {{ file?: string, now?: number }} [options]
 * @returns {Record<string, Record<string, any>>}
 */
export function loadModelPickRecords(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const doc = readDocument(file);
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const [id, row] of Object.entries(doc.picks || {})) {
    // Clone the row: normalizers may keep nested references into the cached document.
    const normalized = normalizeModelPickRecord({ ...structuredClone(row), id });
    if (normalized) out[id] = normalized;
  }
  return applyModelPickRetention(out, Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now());
}

/**
 * @param {string} pickId
 * @param {{ file?: string, now?: number }} [options]
 * @returns {Record<string, any> | null}
 */
export function getModelPickRecord(pickId, options = {}) {
  const id = String(pickId || '').trim();
  if (!id) return null;
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  // Normalize only the requested row; the rest of the document is irrelevant.
  const row = readDocument(file).picks?.[id];
  if (!row || typeof row !== 'object') return null;
  return normalizeModelPickRecord({ ...structuredClone(row), id });
}

/**
 * @param {Record<string, any>} record
 * @param {{ file?: string }} [options]
 * @returns {Record<string, any>}
 */
export function saveModelPickRecord(record, options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const normalized = normalizeModelPickRecord(record);
  if (!normalized) throw new Error('Invalid model pick record');
  return withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    doc.picks[normalized.id] = normalized;
    persistOps(file, doc, [{ op: 'put', id: normalized.id, row: normalized }]);
    // Hand out a copy: the stored object is shared with the document cache.
    return structuredClone(normalized);
  });
}

/**
 * Drop expired unclaimed picks older than retention.
 *
 * @param {Record<string, any>} [options]
 */
export function purgeStaleModelPickRecords(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    /** @type {Record<string, Record<string, any>>} */
    const all = {};
    /** @type {string[]} */
    const drop = [];
    for (const [id, row] of Object.entries(doc.picks || {})) {
      const normalized = normalizeModelPickRecord({ ...row, id });
      if (normalized) all[id] = normalized;
      else drop.push(id);
    }
    const next = applyModelPickRetention(all, now);
    for (const id of Object.keys(all)) if (!(id in next)) drop.push(id);
    // Nothing expired: write nothing. Reads normalize rows on load, so legacy
    // rows left as stored change no result. Removals are journaled as one op.
    if (!drop.length) return;
    for (const id of drop) delete doc.picks[id];
    persistOps(file, doc, [{ op: 'del', ids: drop }]);
  });
}

/**
 * @param {{
 *   chatId?: string,
 *   workspaceFolder?: string,
 *   purpose?: string,
 *   role?: string,
 *   policyVersion?: string,
 *   candidates?: Record<string, any>[],
 *   picks?: Record<string, any>[],
 *   now?: number,
 *   file?: string,
 *   planPace?: Record<string, any> | null,
 * }} input
 * @returns {Record<string, any>}
 */
export function createModelPickRecord(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const createdAt = new Date(now).toISOString();
  const record = normalizeModelPickRecord({
    id: randomUUID(),
    createdAt,
    expiresAt: new Date(now + MODEL_PICK_TTL_MS).toISOString(),
    chatId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    purpose: input.purpose,
    role: input.role,
    policyVersion: input.policyVersion,
    candidates: input.candidates,
    picks: input.picks,
    slots: {},
    leafId: input.leafId,
    leafSource: input.leafSource,
    complexity: input.complexity,
    complexityShadow: input.complexityShadow,
    costProxy: input.costProxy,
    costPolicy: input.costPolicy,
    benchmark: input.benchmark,
    planPace: input.planPace,
  });
  if (!record) throw new Error('Failed to normalize model pick record');
  return saveModelPickRecord(record, { file: input.file });
}

/**
 * Atomically reserve one execution slot on a pick (cross-process safe).
 *
 * `selectionSlot` is a non-negative integer for a proposed slot, or a
 * `fallback:<delegationId>` key for a fallback attempt with its own slot. A
 * missing slot is a validation error, never slot 0.
 *
 * @param {{
 *   pickId: string,
 *   selectionSlot: number | string,
 *   delegationId: string,
 *   idempotencyKey: string,
 *   file?: string,
 *   now?: number,
 *   lockTimeoutMs?: number,
 * }} input
 * @returns {Promise<{ ok: true, replay: boolean, record: Record<string, any> } | { ok: false, code: string, error: string }>}
 */
export async function reserveModelPickSlot(input) {
  const pickId = String(input.pickId || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const slotKey = normalizeSlotKey(input.selectionSlot);
  if (!pickId || !delegationId || !idempotencyKey || !slotKey) {
    return { ok: false, code: 'validation', error: 'pickId, selectionSlot, delegationId, and idempotencyKey are required' };
  }
  const file = typeof input.file === 'string' && input.file ? input.file : MODEL_PICK_DECISIONS_FILE;
  try {
    return withModelPickFileLock(file, () => {
      const doc = readDocument(file);
      const current = normalizeModelPickRecord({ ...(doc.picks?.[pickId] || {}), id: pickId });
      if (!current || !doc.picks?.[pickId]) {
        return { ok: false, code: 'not_found', error: 'Unknown pick_id' };
      }
      // Only slots the proposal actually offered (or a per-fallback key) can be
      // reserved: an arbitrary numeric key must never mint a fanout slot beyond
      // the explicit picks.
      if (!slotKey.startsWith('fallback:')) {
        const offered = new Set(
          (Array.isArray(current.picks) ? current.picks : []).map((row, index) => {
            const n = Number(row?.selectionSlot);
            return String(Number.isInteger(n) && n >= 0 ? n : index);
          }),
        );
        if (!offered.has(slotKey)) {
          return { ok: false, code: 'validation', error: 'selectionSlot is not one of the explicit pick slots' };
        }
      }
      const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
      const expiresMs = Date.parse(current.expiresAt);
      if (Number.isFinite(expiresMs) && now > expiresMs) {
        return { ok: false, code: 'expired', error: 'pick_id expired' };
      }
      const existing = current.slots[slotKey];
      if (existing) {
        if (existing.idempotencyKey === idempotencyKey) {
          return { ok: true, replay: true, record: structuredClone(current) };
        }
        return { ok: false, code: 'slot_taken', error: 'Selection slot already reserved' };
      }
      current.slots[slotKey] = {
        delegationId,
        idempotencyKey,
        reservedAt: new Date(now).toISOString(),
      };
      doc.picks[pickId] = current;
      persistOps(file, doc, [{ op: 'put', id: pickId, row: current }]);
      return { ok: true, replay: false, record: structuredClone(current) };
    }, { lockTimeoutMs: input.lockTimeoutMs });
  } catch (error) {
    if (error instanceof ModelPickLockError) return { ok: false, code: 'lock_timeout', error: error.message };
    throw error;
  }
}

/**
 * @param {any} value
 * @returns {string} '' when the slot is missing/invalid
 */
export function normalizeSlotKey(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && /^fallback:\S+$/.test(value.trim())) return value.trim();
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return '';
  return String(n);
}

/**
 * Release a reservation made for a delegation whose start was aborted, so the
 * slot is not burned by a start that never happened.
 *
 * @param {{ pickId: string, delegationId: string, file?: string }} input
 * @returns {boolean}
 */
export function releaseModelPickSlotsForDelegation(input) {
  const pickId = String(input.pickId || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  if (!pickId || !delegationId) return false;
  const file = typeof input.file === 'string' && input.file ? input.file : MODEL_PICK_DECISIONS_FILE;
  return withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    const current = normalizeModelPickRecord({ ...(doc.picks?.[pickId] || {}), id: pickId });
    if (!current || !doc.picks?.[pickId]) return false;
    let changed = false;
    for (const [key, slot] of Object.entries(current.slots)) {
      if (slot.delegationId === delegationId) {
        delete current.slots[key];
        changed = true;
      }
    }
    if (changed) {
      doc.picks[pickId] = current;
      persistOps(file, doc, [{ op: 'put', id: pickId, row: current }]);
    }
    return changed;
  });
}
