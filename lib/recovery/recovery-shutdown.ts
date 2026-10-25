/**
 * Graceful shutdown: durable restart intent and bounded checkpoint (leaf R9).
 *
 * A SIGTERM/SIGINT on its own is not proof of a planned restart: it may be a
 * user stop, and a SIGKILL/crash never reaches any handler at all. The proof a
 * restart was planned is a durable shutdown intent whose reason is
 * `planned_restart`, written by the shutdown handler into the recovery store
 * (`recovery_meta`, key `restartIntent`). The next boot reads it, attaches it
 * to the boot evidence of the runs it classifies, and deletes it only after
 * that classification succeeded. No intent (SIGKILL, OOM kill, fatal crash)
 * means no planned-restart evidence: those runs stay classified by R8 from
 * liveness alone (`unknown` / `server_restart`), never as planned.
 *
 * The reason is decided from the signal *and* the explicit scheduled-restart
 * flag (`serverRestartScheduled` / `resolveRestartScheduled()`): a graceful
 * SIGTERM/SIGINT is `planned_restart` only when a restart was already
 * scheduled; otherwise it is `user_stop`. No intent is written for fatal
 * events (crash, server error), so SIGKILL-like paths leave no planned mark.
 *
 * Boundaries:
 * - The intent is evidence only. It never changes a run's lifecycle state or
 *   the R1 retry accounting.
 * - The per-run checkpoint is a metadata patch (`shutdownCheckpoint`) applied
 *   through the store CAS with the state re-applied unchanged. A run that was
 *   still in progress is therefore never recorded as completed.
 * - Asynchronous shutdown work is bounded by a hard timeout; a synchronous
 *   task is expected to be small and runs to completion before the timer is
 *   armed. Failures are reported, never thrown, so shutdown can always exit.
 * - No runtime imports: callers inject the flush work and the run list.
 */

import { randomUUID } from 'node:crypto';
import { getRecoveryStoreDatabase, listOpenRuns, transitionRun } from './recovery-store.ts';

/** Shape version of the durable intent record. */
export const RESTART_INTENT_SCHEMA_VERSION = 1;
/** `recovery_meta` key that holds the single pending intent. */
export const RESTART_INTENT_META_KEY = 'restartIntent';
/** Reasons an intent may carry. */
export const RESTART_INTENT_REASONS = Object.freeze(['planned_restart', 'user_stop']);
/** Graceful signals whose shutdown handler may write a shutdown intent. */
export const SHUTDOWN_GRACEFUL_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);
/** Bounded deadline written into the intent, and the default staleness bound. */
export const RESTART_INTENT_DEFAULT_DEADLINE_MS = 120000;
/** Hard timeout of the whole flush/checkpoint phase. */
export const SHUTDOWN_FLUSH_DEFAULT_TIMEOUT_MS = 5000;

/** Identity of this process, stable for its lifetime. */
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_GENERATION = Date.now();

/**
 * @returns {{ instanceId: string, generation: number, pid: number }}
 */
export function getProcessInstance(): { instanceId: string, generation: number, pid: number } {
  return { instanceId: PROCESS_INSTANCE_ID, generation: PROCESS_GENERATION, pid: process.pid };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveMs(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Pure decision for the shutdown intent reason.
 *
 * A signal alone is never proof of a planned restart: it may be a user stop
 * (Ctrl+C, `systemctl stop`, `docker stop`). Only the explicit scheduled-restart
 * flag makes a graceful signal `planned_restart`; every other graceful signal is
 * `user_stop`. A non-graceful event (fatal crash, server error) gets no intent
 * at all, so the next boot classifies those runs from liveness alone.
 *
 * @param {{ signal?: string, restartScheduled?: boolean }} [input]
 * @returns {'planned_restart' | 'user_stop' | null} `null` means write no intent
 */
export function resolveShutdownIntentReason(input: { signal?: string, restartScheduled?: boolean } = {}): 'planned_restart' | 'user_stop' | null {
  const signal = text(input.signal).toUpperCase();
  if (!SHUTDOWN_GRACEFUL_SIGNALS.includes(signal)) return null;
  return input.restartScheduled === true ? 'planned_restart' : 'user_stop';
}

/**
 * Durably record that this process is shutting down on purpose. Atomic and
 * idempotent: a second call replaces the record (last writer wins). An
 * unspecified or unknown reason is recorded as `user_stop`: `planned_restart`
 * must always be explicit.
 *
 * @param {{
 *   reason?: string, signal?: string, now?: number, deadlineMs?: number,
 *   instance?: { instanceId: string, generation: number, pid: number },
 *   store?: object,
 * }} [input]
 * @returns {object} the written intent
 */
export function writeRestartIntent(input: { reason?: string, signal?: string, now?: number, deadlineMs?: number, instance?: { instanceId: string, generation: number, pid: number }, store?: Record<string, any>, } = {}): Record<string, any> {
  const reason = RESTART_INTENT_REASONS.includes(text(input.reason)) ? text(input.reason) : 'user_stop';
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const instance = input.instance || getProcessInstance();
  const deadlineMs = positiveMs(input.deadlineMs, RESTART_INTENT_DEFAULT_DEADLINE_MS);
  const intent = {
    schemaVersion: RESTART_INTENT_SCHEMA_VERSION,
    reason,
    signal: text(input.signal),
    instanceId: instance.instanceId,
    generation: instance.generation,
    pid: instance.pid,
    writtenAt: new Date(now).toISOString(),
    deadlineMs,
    deadlineAt: new Date(now + deadlineMs).toISOString(),
  };
  const db = getRecoveryStoreDatabase(input.store);
  db.prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
    .run(RESTART_INTENT_META_KEY, JSON.stringify(intent));
  return intent;
}

/**
 * Pure validity check for an intent read at boot.
 *
 * @param {unknown} intent
 * @param {{ now?: number, currentInstanceId?: string }} [options]
 * @returns {{ valid: boolean, reason: string }}
 */
export function evaluateRestartIntent(intent: unknown, options: { now?: number, currentInstanceId?: string } = {}): { valid: boolean, reason: string } {
  if (!intent || typeof intent !== 'object') return { valid: false, reason: 'malformed' };
  const record = intent as Record<string, any>;
  if (record.schemaVersion !== RESTART_INTENT_SCHEMA_VERSION) return { valid: false, reason: 'schema_mismatch' };
  if (!RESTART_INTENT_REASONS.includes(text(record.reason))) return { valid: false, reason: 'unknown_reason' };
  const currentInstanceId = text(options.currentInstanceId) || PROCESS_INSTANCE_ID;
  // An intent written by this very process cannot describe a previous death.
  if (text(record.instanceId) === currentInstanceId) return { valid: false, reason: 'same_instance' };
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const writtenAt = Date.parse(text(record.writtenAt));
  const deadlineAt = Date.parse(text(record.deadlineAt));
  if (!Number.isFinite(writtenAt) || !Number.isFinite(deadlineAt)) return { valid: false, reason: 'malformed' };
  // Written in the future relative to boot: clock skew or tampering.
  if (writtenAt > now + 1000) return { valid: false, reason: 'from_future' };
  // Boot happens after the process died; the bound covers shutdown plus restart.
  if (now > deadlineAt + RESTART_INTENT_DEFAULT_DEADLINE_MS) return { valid: false, reason: 'stale' };
  return { valid: true, reason: 'valid' };
}

/**
 * Read the pending intent without consuming it. Boot uses this before
 * classification so a failed classification keeps the evidence for the next
 * boot; `consumeRestartIntent` deletes it only once classification succeeded.
 *
 * @param {{ now?: number, currentInstanceId?: string, store?: object }} [input]
 * @returns {{ status: 'absent' | 'pending' | 'ignored', reason: string, intent: object | null }}
 */
export function readRestartIntent(input: { now?: number, currentInstanceId?: string, store?: Record<string, any> } = {}): { status: 'absent' | 'pending' | 'ignored', reason: string, intent: Record<string, any> | null } {
  const db = getRecoveryStoreDatabase(input.store);
  const row = db.prepare('SELECT value FROM recovery_meta WHERE key = ?').get(RESTART_INTENT_META_KEY);
  if (!row) return { status: 'absent', reason: 'no_intent', intent: null };
  let intent = null;
  try {
    intent = JSON.parse(String(row.value));
  } catch {
    return { status: 'ignored', reason: 'malformed', intent: null };
  }
  const verdict = evaluateRestartIntent(intent, { now: input.now, currentInstanceId: input.currentInstanceId });
  return verdict.valid
    ? { status: 'pending', reason: 'valid', intent }
    : { status: 'ignored', reason: verdict.reason, intent: null };
}

/**
 * Consume the pending intent exactly once (read + delete in one IMMEDIATE
 * transaction). A stale or malformed record is deleted too, so it can never be
 * attached to a later boot, but it is reported as ignored.
 *
 * @param {{ now?: number, currentInstanceId?: string, store?: object }} [input]
 * @returns {{ status: 'absent' | 'consumed' | 'ignored', reason: string, intent: object | null }}
 */
export function consumeRestartIntent(input: { now?: number, currentInstanceId?: string, store?: Record<string, any> } = {}): { status: 'absent' | 'consumed' | 'ignored', reason: string, intent: Record<string, any> | null } {
  const db = getRecoveryStoreDatabase(input.store);
  let raw = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT value FROM recovery_meta WHERE key = ?').get(RESTART_INTENT_META_KEY);
    if (row) {
      raw = String(row.value);
      db.prepare('DELETE FROM recovery_meta WHERE key = ?').run(RESTART_INTENT_META_KEY);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback may fail when the transaction never started.
    }
    throw err;
  }
  if (raw === null) return { status: 'absent', reason: 'no_intent', intent: null };
  let intent = null;
  try {
    intent = JSON.parse(raw);
  } catch {
    return { status: 'ignored', reason: 'malformed', intent: null };
  }
  const verdict = evaluateRestartIntent(intent, { now: input.now, currentInstanceId: input.currentInstanceId });
  return verdict.valid
    ? { status: 'consumed', reason: 'valid', intent }
    : { status: 'ignored', reason: verdict.reason, intent: null };
}

/**
 * Record on every still-open run that it was in progress when a planned
 * shutdown began. Metadata only (state re-applied unchanged): the run is not
 * completed, not failed, and no retry counter moves.
 *
 * @param {{ intent: object, now?: number, store?: object }} input
 * @returns {{ checkpointed: number, conflicts: number, errors: number }}
 */
export function checkpointOpenRunsForShutdown(input: { intent: Record<string, any>, now?: number, store?: Record<string, any> }): { checkpointed: number, conflicts: number, errors: number } {
  const result = { checkpointed: 0, conflicts: 0, errors: 0 };
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  for (let offset = 0; ; offset += 1000) {
    const page = listOpenRuns({ limit: 1000, offset }, input.store);
    for (const run of page) {
      try {
        const out = transitionRun({
          logicalRunId: run.logicalRunId,
          expectedRevision: run.revision,
          to: run.state,
          patch: {
            shutdownCheckpoint: {
              interruptedBy: input.intent.reason,
              inProgress: true,
              instanceId: input.intent.instanceId,
              at,
            },
          },
          now,
        }, input.store);
        if (out.ok) result.checkpointed += 1;
        else result.conflicts += 1;
      } catch {
        result.errors += 1;
      }
    }
    if (page.length < 1000) return result;
  }
}

/**
 * Run the flush tasks under one hard deadline. The timeout bounds only the
 * asynchronous work: every `task.run()` is invoked synchronously while the
 * task list is mapped, so a synchronous task runs to completion before the
 * timer is armed (such tasks are expected to be small). Never throws; a task
 * that rejects or stays pending is reported and abandoned.
 *
 * @param {{
 *   tasks: Array<{ name: string, run: () => unknown }>,
 *   timeoutMs?: number,
 *   onError?: (name: string, err: unknown) => void,
 * }} input
 * @returns {Promise<{ ok: boolean, timedOut: boolean, failed: string[], completed: string[], elapsedMs: number }>}
 */
export async function runBoundedShutdownFlush(input: { tasks: Array<{ name: string, run: () => unknown }>, timeoutMs?: number, onError?: (name: string, err: unknown) => void, }): Promise<{ ok: boolean, timedOut: boolean, failed: string[], completed: string[], elapsedMs: number }> {
  const timeoutMs = positiveMs(input.timeoutMs, SHUTDOWN_FLUSH_DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const failed: string[] = [];
  const completed: string[] = [];
  const work = (input.tasks || []).map(async (task) => {
    try {
      await task.run();
      completed.push(task.name);
    } catch (err) {
      failed.push(task.name);
      if (typeof input.onError === 'function') input.onError(task.name, err);
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([Promise.all(work).then(() => 'done'), deadline]);
  if (timer) clearTimeout(timer);
  const timedOut = outcome === 'timeout';
  return {
    ok: !timedOut && failed.length === 0,
    timedOut,
    failed,
    completed,
    elapsedMs: Date.now() - startedAt,
  };
}
