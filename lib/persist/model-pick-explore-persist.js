/**
 * Durable store for out-of-band exploration attempts (stage 6).
 *
 * One JSON document (`data/model-pick-explore.json`) holds every explore
 * attempt. Reads and writes run inside the SAME cross-process mutex as the pick
 * decision journal (`withModelPickFileLock` keys its SQLite lock on the
 * document directory), so a pick-slot reservation and an explore reservation are
 * serialized against each other and one budget can never be spent twice.
 *
 * Reservation semantics required by the explore policy:
 * - a pick that never starts consumes nothing: the caller writes a `reserved`
 *   row only at `delegation_start`, and rolls it back if the start is refused;
 * - a restart resets nothing: the same `idempotencyKey` replays the existing
 *   row instead of adding a second attempt or moving its timestamps;
 * - the limit check runs inside the lock, so two concurrent starts cannot both
 *   see a free slot.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import {
  MODEL_PICK_LOCK_TIMEOUT_MS,
  ModelPickLockError,
  withModelPickFileLock,
} from './model-pick-decisions-persist.js';

export const MODEL_PICK_EXPLORE_FILE = resolveDataPath('model-pick-explore.json');
export const MODEL_PICK_EXPLORE_SCHEMA_VERSION = 1;

/** Statuses that hold a slot; `rolled_back` and a finished attempt release it. */
export const MODEL_PICK_EXPLORE_OPEN_STATUSES = Object.freeze(['reserved', 'started']);
export const MODEL_PICK_EXPLORE_STATUSES = Object.freeze([
  'reserved',
  'started',
  'finished',
  'rolled_back',
]);

/**
 * @param {string} file
 * @returns {{ schemaVersion: number, attempts: Record<string, object> }}
 */
function readDocument(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const attempts = parsed && typeof parsed === 'object' && parsed.attempts && typeof parsed.attempts === 'object'
      ? parsed.attempts
      : {};
    return { schemaVersion: MODEL_PICK_EXPLORE_SCHEMA_VERSION, attempts };
  } catch {
    return { schemaVersion: MODEL_PICK_EXPLORE_SCHEMA_VERSION, attempts: {} };
  }
}

/**
 * @param {string} file
 * @param {{ attempts: Record<string, object> }} doc
 */
function writeDocument(file, doc) {
  writeJsonAtomic(file, { schemaVersion: MODEL_PICK_EXPLORE_SCHEMA_VERSION, attempts: doc.attempts || {} });
}

/**
 * @param {number} ms
 * @returns {string}
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} at
 * @returns {string} '' when the caller gave no usable timestamp
 */
function stampOf(at) {
  const ms = Number(at);
  return Number.isFinite(ms) && ms > 0 ? iso(ms) : '';
}

/**
 * @param {unknown} at
 * @returns {number}
 */
function msOf(at) {
  const ms = Number(at);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const parsed = Date.parse(String(at || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {object} row
 * @returns {object | null}
 */
export function normalizeModelPickExploreAttempt(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '').trim();
  const pairKey = String(row.pairKey || '').trim().toLowerCase();
  const harness = String(row.harness || '').trim().toLowerCase();
  const role = String(row.role || '').trim().toLowerCase();
  if (!id || !pairKey || !harness || !role) return null;
  const statusRaw = String(row.status || '').trim().toLowerCase();
  const outcomeRaw = String(row.outcome || '').trim().toLowerCase();
  const budget = Number(row.budgetUsd);
  const executorMs = Number(row.maxExecutorMs);
  return {
    id,
    pairKey,
    harness,
    baseModel: String(row.baseModel || '').trim().toLowerCase(),
    model: String(row.model || '').trim(),
    role,
    workspaceKey: String(row.workspaceKey || '').trim().toLowerCase(),
    segment: String(row.segment || '').trim(),
    policyVersion: String(row.policyVersion || '').trim(),
    delegationId: String(row.delegationId || '').trim(),
    pickId: String(row.pickId || '').trim(),
    idempotencyKey: String(row.idempotencyKey || '').trim(),
    status: MODEL_PICK_EXPLORE_STATUSES.includes(statusRaw) ? statusRaw : 'reserved',
    outcome: outcomeRaw || '',
    reservedAt: String(row.reservedAt || '').trim(),
    startedAt: String(row.startedAt || '').trim(),
    finishedAt: String(row.finishedAt || '').trim(),
    cooldownUntil: String(row.cooldownUntil || '').trim(),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0,
    maxExecutorMs: Number.isFinite(executorMs) && executorMs > 0 ? executorMs : 0,
  };
}

/**
 * @param {{ file?: string }} [options]
 * @returns {object[]} newest first; unreadable store is an empty list
 */
export function loadModelPickExploreAttempts(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_EXPLORE_FILE;
  const doc = readDocument(file);
  const out = [];
  for (const [id, row] of Object.entries(doc.attempts || {})) {
    const attempt = normalizeModelPickExploreAttempt({ ...row, id });
    if (attempt) out.push(attempt);
  }
  out.sort((left, right) => msOf(right.reservedAt || right.startedAt) - msOf(left.reservedAt || left.startedAt));
  return out;
}

/**
 * Reserve one explore attempt.
 *
 * `guard` runs **inside** the cross-process lock with the durable rows as they
 * are at that instant and returns `{ ok, code?, blocked? }`. A refused guard
 * writes nothing, so a blocked exploration consumes no budget. An idempotent
 * replay (same `idempotencyKey`) returns the existing row untouched: a restart
 * must not add a second attempt nor reset the pair interval.
 *
 * @param {{
 *   pairKey: string,
 *   harness: string,
 *   model?: string,
 *   baseModel?: string,
 *   role: string,
 *   workspaceKey?: string,
 *   segment?: string,
 *   policyVersion?: string,
 *   delegationId?: string,
 *   pickId?: string,
 *   idempotencyKey?: string,
 *   budgetUsd?: number,
 *   maxExecutorMs?: number,
 *   guard?: (attempts: object[], now: number) => { ok: boolean, code?: string, blocked?: string[] },
 *   now?: number,
 *   file?: string,
 *   lockTimeoutMs?: number,
 * }} input
 * @returns {Promise<{ ok: true, replay: boolean, attempt: object } | { ok: false, code: string, error: string, blocked?: string[] }>}
 */
export async function reserveModelPickExploreAttempt(input = {}) {
  const pairKey = String(input.pairKey || '').trim().toLowerCase();
  const harness = String(input.harness || '').trim().toLowerCase();
  const role = String(input.role || '').trim().toLowerCase();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  if (!pairKey || !harness || !role) {
    return { ok: false, code: 'validation', error: 'explore reservation needs a pair, a harness and a role' };
  }
  if (!delegationId || !idempotencyKey) {
    return {
      ok: false,
      code: 'idempotency_key_required',
      error: 'An explore attempt is reserved for one delegation start with an idempotency key.',
    };
  }
  const file = typeof input.file === 'string' && input.file ? input.file : MODEL_PICK_EXPLORE_FILE;
  try {
    return withModelPickFileLock(file, () => {
      const doc = readDocument(file);
      /** @type {object[]} */
      const durable = [];
      for (const [id, row] of Object.entries(doc.attempts || {})) {
        const attempt = normalizeModelPickExploreAttempt({ ...row, id });
        if (attempt) durable.push(attempt);
      }
      const existing = durable.find((attempt) => attempt.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.pairKey !== pairKey || existing.role !== role) {
          return {
            ok: false,
            code: 'idempotency_conflict',
            error: 'This idempotency key already reserved another explore attempt.',
          };
        }
        if (existing.delegationId && delegationId && existing.delegationId !== delegationId) {
          return { ok: false, code: 'idempotency_conflict', error: 'This idempotency key belongs to another delegation.' };
        }
        // Replay: keep every timestamp and the consumed credit exactly as they
        // were, so a restart resets nothing.
        return { ok: true, replay: true, attempt: existing };
      }
      const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
      if (typeof input.guard === 'function') {
        const verdict = input.guard(durable, now) || { ok: true };
        if (verdict.ok !== true) {
          return {
            ok: false,
            code: String(verdict.code || 'explore_blocked'),
            error: `Explore reservation refused (${verdict.code || 'explore_blocked'})`,
            blocked: Array.isArray(verdict.blocked) ? verdict.blocked : [],
          };
        }
      }
      const attempt = normalizeModelPickExploreAttempt({
        id: randomUUID(),
        pairKey,
        harness,
        model: input.model,
        baseModel: input.baseModel,
        role,
        workspaceKey: input.workspaceKey,
        segment: input.segment,
        policyVersion: input.policyVersion,
        delegationId,
        pickId: input.pickId,
        idempotencyKey,
        status: 'reserved',
        reservedAt: iso(now),
        budgetUsd: input.budgetUsd,
        maxExecutorMs: input.maxExecutorMs,
      });
      if (!attempt) return { ok: false, code: 'validation', error: 'explore attempt could not be normalized' };
      doc.attempts[attempt.id] = attempt;
      writeDocument(file, doc);
      return { ok: true, replay: false, attempt };
    }, { lockTimeoutMs: input.lockTimeoutMs });
  } catch (error) {
    if (error instanceof ModelPickLockError) return { ok: false, code: 'lock_timeout', error: error.message };
    throw error;
  }
}

/**
 * Mutate one attempt under the lock. `mutate` returns the patch, or null to
 * leave the store untouched (a late callback for an attempt that already
 * finished must never overwrite the recorded outcome).
 *
 * @param {{ id?: string, delegationId?: string, file?: string, lockTimeoutMs?: number, now?: number }} input
 * @param {(attempt: object, now: number) => (object | null)} mutate
 * @returns {object | null} the attempt after the patch
 */
function patchAttempt(input, mutate) {
  const file = typeof input.file === 'string' && input.file ? input.file : MODEL_PICK_EXPLORE_FILE;
  const id = String(input.id || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  if (!id && !delegationId) return null;
  let result = null;
  withModelPickFileLock(file, () => {
    const doc = readDocument(file);
    for (const [key, row] of Object.entries(doc.attempts || {})) {
      const attempt = normalizeModelPickExploreAttempt({ ...row, id: key });
      if (!attempt) continue;
      if (!((id && attempt.id === id) || (!id && delegationId && attempt.delegationId === delegationId))) continue;
      const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
      const patch = mutate(attempt, now);
      if (patch) {
        const next = normalizeModelPickExploreAttempt({ ...attempt, ...patch, id: key });
        if (next) {
          doc.attempts[key] = next;
          writeDocument(file, doc);
          result = next;
        }
      } else {
        result = attempt;
      }
      return;
    }
  }, { lockTimeoutMs: input.lockTimeoutMs });
  return result;
}

/**
 * Mark the reservation as actually running. Keeps `reservedAt` (the pair
 * interval and the daily counters stay anchored on the original start).
 *
 * @param {{ id?: string, delegationId?: string, now?: number, file?: string }} input
 * @returns {object | null}
 */
export function startModelPickExploreAttempt(input = {}) {
  return patchAttempt(input, (attempt, now) => {
    if (attempt.status !== 'reserved') return null;
    return {
      status: 'started',
      startedAt: attempt.startedAt || stampOf(now) || iso(now),
    };
  });
}

/**
 * Close an attempt with its outcome.
 *
 * - `infra_fail` and `timeout` start the pair cooldown, so a fault or a run
 *   that burned its executor budget cannot be retried by opening a fresh
 *   attempt immediately;
 * - `cancelled` records the outcome but never a cooldown and never rates
 *   quality (the caller classifies the outcome; this store only keeps it).
 *
 * @param {{
 *   id?: string,
 *   delegationId?: string,
 *   outcome: string,
 *   now?: number,
 *   cooldownMs?: number,
 *   file?: string,
 * }} input
 * @returns {object | null}
 */
export function finishModelPickExploreAttempt(input = {}) {
  const outcome = String(input.outcome || '').trim().toLowerCase();
  if (!outcome) return null;
  const cooldownMs = Number(input.cooldownMs);
  return patchAttempt(input, (attempt, now) => {
    if (attempt.status === 'rolled_back' || attempt.outcome) return null;
    const patch = { status: 'finished', outcome, finishedAt: iso(now) };
    const cooldown = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0;
    if (cooldown > 0) patch.cooldownUntil = iso(now + cooldown);
    return patch;
  });
}

/**
 * Roll back a reservation whose start was refused, so the attempt consumes
 * nothing. A finished or running attempt is never rewound.
 *
 * @param {{ id?: string, delegationId?: string, now?: number, file?: string }} input
 * @returns {boolean}
 */
export function rollbackModelPickExploreAttempt(input = {}) {
  const patched = patchAttempt(input, (attempt, now) => {
    if (MODEL_PICK_EXPLORE_OPEN_STATUSES.includes(attempt.status) && !attempt.outcome) {
      return { status: 'rolled_back', finishedAt: stampOf(now) || attempt.finishedAt };
    }
    return null;
  });
  return patched?.status === 'rolled_back';
}

/**
 * @param {{ status?: string, file?: string }} [options]
 * @returns {number} attempts currently holding a slot
 */
export function countOpenModelPickExploreAttempts(options = {}) {
  const wanted = String(options.status || '').trim().toLowerCase();
  return loadModelPickExploreAttempts(options).filter((attempt) => (
    wanted ? attempt.status === wanted : MODEL_PICK_EXPLORE_OPEN_STATUSES.includes(attempt.status)
  )).length;
}

/**
 * Find one durable attempt by id or delegation id (newest match for delegation).
 *
 * @param {{ id?: string, delegationId?: string, file?: string }} input
 * @returns {object | null}
 */
export function findModelPickExploreAttempt(input = {}) {
  const id = String(input.id || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  if (!id && !delegationId) return null;
  const attempts = loadModelPickExploreAttempts({ file: input.file });
  if (id) {
    return attempts.find((attempt) => attempt.id === id) || null;
  }
  return attempts.find((attempt) => attempt.delegationId === delegationId) || null;
}

/**
 * Roll back a reservation after a refused start (alias of {@link rollbackModelPickExploreAttempt}).
 *
 * @param {{ id?: string, delegationId?: string, now?: number, file?: string }} input
 * @returns {boolean}
 */
export function releaseModelPickExploreAttempt(input = {}) {
  return rollbackModelPickExploreAttempt(input);
}
