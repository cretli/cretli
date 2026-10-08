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

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  MODEL_PICK_MAX_CANDIDATES,
  MODEL_PICK_MAX_SLOTS,
  MODEL_PICK_RETENTION_MS,
  MODEL_PICK_TTL_MS,
} from '../model-pick-policy.js';

export const MODEL_PICK_DECISIONS_FILE = resolveDataPath('model-pick-decisions.json');
export const MODEL_PICK_DECISIONS_SCHEMA_VERSION = 1;

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
 * @param {unknown} error
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
 * @param {{ lockTimeoutMs?: number }} [options]
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
 * @param {string} file
 * @returns {object}
 */
function readDocument(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { schemaVersion: MODEL_PICK_DECISIONS_SCHEMA_VERSION, picks: {} };
    const picks = parsed.picks && typeof parsed.picks === 'object' ? parsed.picks : {};
    return { schemaVersion: MODEL_PICK_DECISIONS_SCHEMA_VERSION, picks };
  } catch {
    return { schemaVersion: MODEL_PICK_DECISIONS_SCHEMA_VERSION, picks: {} };
  }
}

/**
 * @param {string} file
 * @param {object} doc
 */
function writeDocument(file, doc) {
  writeJsonAtomic(file, doc);
}

/**
 * @param {unknown} value
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
 * @param {object | null | undefined} raw
 * @returns {object | null}
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
 * @param {object} input
 * @returns {object | null}
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
  /** @type {object[]} */
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.slice(0, MODEL_PICK_MAX_CANDIDATES).map((row) => ({
      // Audit-only candidates carry no slot; `Number(null)` must not read as 0.
      selectionSlot: row?.selectionSlot != null && Number.isInteger(Number(row.selectionSlot)) ? Number(row.selectionSlot) : null,
      candidateId: String(row?.candidateId || candidateIdOf(row)).trim() || candidateIdOf(row),
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
    })).filter((row) => row.harness && row.model)
    : [];
  /** @type {object[]} */
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
  };
}

/**
 * @param {{ file?: string, now?: number }} [options]
 * @returns {Record<string, object>}
 */
export function loadModelPickRecords(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const doc = readDocument(file);
  /** @type {Record<string, object>} */
  const out = {};
  for (const [id, row] of Object.entries(doc.picks || {})) {
    const normalized = normalizeModelPickRecord({ ...row, id });
    if (normalized) out[id] = normalized;
  }
  return out;
}

/**
 * @param {string} pickId
 * @param {{ file?: string }} [options]
 * @returns {object | null}
 */
export function getModelPickRecord(pickId, options = {}) {
  const id = String(pickId || '').trim();
  if (!id) return null;
  const rows = loadModelPickRecords(options);
  return rows[id] || null;
}

/**
 * @param {object} record
 * @param {{ file?: string }} [options]
 * @returns {object}
 */
export function saveModelPickRecord(record, options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const normalized = normalizeModelPickRecord(record);
  if (!normalized) throw new Error('Invalid model pick record');
  return withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    doc.picks[normalized.id] = normalized;
    writeDocument(file, doc);
    return normalized;
  });
}

/**
 * Drop expired unclaimed picks older than retention.
 *
 * @param {{ file?: string, now?: number }} [options]
 */
export function purgeStaleModelPickRecords(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_DECISIONS_FILE;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    /** @type {Record<string, object>} */
    const next = {};
    for (const [id, row] of Object.entries(doc.picks || {})) {
      const normalized = normalizeModelPickRecord({ ...row, id });
      if (!normalized) continue;
      const createdMs = Date.parse(normalized.createdAt);
      const hasSlot = Object.keys(normalized.slots || {}).length > 0;
      if (!hasSlot && Number.isFinite(createdMs) && now - createdMs > MODEL_PICK_RETENTION_MS) continue;
      next[id] = normalized;
    }
    doc.picks = next;
    writeDocument(file, doc);
  });
}

/**
 * @param {{
 *   chatId?: string,
 *   workspaceFolder?: string,
 *   purpose?: string,
 *   role?: string,
 *   policyVersion?: string,
 *   candidates?: object[],
 *   picks?: object[],
 *   now?: number,
 *   file?: string,
 * }} input
 * @returns {object}
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
 * @returns {Promise<{ ok: true, replay: boolean, record: object } | { ok: false, code: string, error: string }>}
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
          return { ok: true, replay: true, record: current };
        }
        return { ok: false, code: 'slot_taken', error: 'Selection slot already reserved' };
      }
      current.slots[slotKey] = {
        delegationId,
        idempotencyKey,
        reservedAt: new Date(now).toISOString(),
      };
      doc.picks[pickId] = current;
      writeDocument(file, doc);
      return { ok: true, replay: false, record: current };
    }, { lockTimeoutMs: input.lockTimeoutMs });
  } catch (error) {
    if (error instanceof ModelPickLockError) return { ok: false, code: 'lock_timeout', error: error.message };
    throw error;
  }
}

/**
 * @param {unknown} value
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
      writeDocument(file, doc);
    }
    return changed;
  });
}
