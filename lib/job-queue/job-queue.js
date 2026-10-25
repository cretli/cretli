/**
 * Persistent background job queue with a core-scaled worker pool.
 *
 * Storage: the queue owns a dedicated store file opened through the storage
 * layer (`openStorageDb` from lib/storage/db-lifecycle.js: runtime gate,
 * identity/integrity checks, WAL, synchronous=FULL, busy_timeout, forward-only
 * migrations of lib/job-queue/schema.js) and guarded by a storage
 * coordinator lease (lib/storage/coordinator.js), so two server processes can
 * never both own - and double-run - the same queue. Job rows are tiny and the
 * statements are prepared, so the synchronous writes stay far below a frame.
 *
 * Durability: every job row lives in SQLite, so queued work survives a restart.
 * Rows left `running` by a crash are re-queued by `start()` (handlers must be
 * idempotent) unless their kind was registered with `recover: false`, in which
 * case they are failed as `interrupted` (nobody awaits them any more).
 *
 * Ordering: the in-memory scheduler is the storage fair queue
 * (lib/storage/fair-queue.js) configured with the job classes
 * interactive > cycle > maintenance, including its bounded aging bypass so
 * maintenance work is never starved. Classes order work; they do not cap it.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createStorageCoordinator } from '../storage/coordinator.js';
import { openStorageDb } from '../storage/db-lifecycle.js';
import { createFairQueue, percentile } from '../storage/fair-queue.js';
import { JOB_QUEUE_MIGRATIONS } from './schema.js';
import { resolvePoolSize } from './worker-pool.js';

export const JOB_PRIORITIES = Object.freeze(['interactive', 'cycle', 'maintenance']);
export const JOB_QUEUE_DB_FILENAME = 'job-queue.sqlite';
/** Jobs may wait a long time behind interactive work; this is ordering, not a deadline. */
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WAIT_SAMPLE_WINDOW = 1024;
const FINISHED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TEST_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_COMPLETIONS = 128;
/** Stored result/error text cap; a job result is a summary, not a payload store. */
const MAX_STORED_RESULT_CHARS = 256 * 1024;

/** @type {Set<any>} createJobQueue() results (typed loosely: the factory reads this set) */
const activeQueues = new Set();

/**
 * Metrics of every open queue, for the S1 exporter. Secret-free: counts and
 * durations only, never payloads.
 *
 * @returns {Array<ReturnType<ReturnType<typeof createJobQueue>['metrics']>>}
 */
export function getJobQueueMetricsSnapshot() {
  return [...activeQueues].map((queue) => queue.metrics());
}

/**
 * @param {number[]} list
 * @returns {{ n: number, p50: number | null, p95: number | null, max: number | null }}
 */
function summarize(list) {
  return { n: list.length, p50: percentile(list, 50), p95: percentile(list, 95), max: list.length ? Math.max(...list) : null };
}

/**
 * @param {{
 *   dir: string,
 *   filename?: string,
 *   handlers?: Record<string, (payload: any, job: { id: string, kind: string, priority: string }) => Promise<any> | any>,
 *   concurrency?: number,
 *   now?: () => number,
 *   fairQueue?: object,
 *   coordinator?: false | object,
 *   name?: string,
 * }} options `dir` is the absolute store directory. `coordinator: false` skips
 *   the owner lease (tests only); otherwise a lease under `<dir>/control` is
 *   taken and a live foreign owner makes creation fail with `busy`.
 */
export function createJobQueue(options) {
  if (!options || typeof options.dir !== 'string' || !path.isAbsolute(options.dir)) {
    throw new TypeError('dir must be an absolute path');
  }
  const now = options.now || (() => Date.now());
  const concurrency = options.concurrency ?? resolvePoolSize();
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new TypeError('concurrency must be a positive integer');
  let lost = false;
  const coordinator = options.coordinator === false
    ? null
    : (options.coordinator || createStorageCoordinator({
      controlDir: path.join(options.dir, 'control'),
      onLost: () => { lost = true; },
    }));
  // @ts-ignore - injected coordinators only need acquire/release
  if (coordinator) coordinator.acquire();
  /** @type {import('../storage/db-lifecycle.js').StorageDbHandle} */
  let handle;
  try {
    handle = openStorageDb({ dir: options.dir, filename: options.filename || JOB_QUEUE_DB_FILENAME, migrations: JOB_QUEUE_MIGRATIONS });
  } catch (error) {
    // @ts-ignore
    try { coordinator?.release(); } catch { /* keep the open failure */ }
    throw error;
  }
  const db = handle.db;
  /** @type {Record<string, Function>} */
  const handlers = { ...(options.handlers || {}) };
  /** @type {Set<string>} kinds whose interrupted rows are failed instead of re-run */
  const nonRecoverable = new Set();
  const fair = createFairQueue({
    now,
    priorities: JOB_PRIORITIES,
    maxDepth: 1_000_000,
    maxBytes: 1024 * 1024 * 1024,
    maxAgeMs: JOB_MAX_AGE_MS,
    ...(options.fairQueue || {}),
  });
  const insert = db.prepare('INSERT INTO job_queue_jobs (id, kind, priority, payload, status, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)');
  const markRunning = db.prepare("UPDATE job_queue_jobs SET status='running', attempts=attempts+1, started_at=? WHERE id=?");
  const markDone = db.prepare('UPDATE job_queue_jobs SET status=?, finished_at=?, result=?, error=? WHERE id=?');
  const getRow = db.prepare('SELECT * FROM job_queue_jobs WHERE id=?');
  const cacheGet = db.prepare('SELECT duration_ms FROM job_queue_test_results WHERE test=? AND hash=?');
  const cachePut = db.prepare('INSERT OR REPLACE INTO job_queue_test_results (test, hash, duration_ms, at) VALUES (?, ?, ?, ?)');
  const pruneJobs = db.prepare("DELETE FROM job_queue_jobs WHERE status IN ('done','failed') AND finished_at < ?");
  const pruneResults = db.prepare('DELETE FROM job_queue_test_results WHERE at < ?');
  let completionsSincePrune = 0;

  function prune() {
    pruneJobs.run(now() - FINISHED_JOB_RETENTION_MS);
    pruneResults.run(now() - TEST_RESULT_RETENTION_MS);
    completionsSincePrune = 0;
  }
  prune();

  function pruneAfterCompletion() {
    if (++completionsSincePrune >= PRUNE_EVERY_COMPLETIONS) {
      try { prune(); } catch { /* Retention is best effort; a completed job must still settle. */ }
    }
  }

  /** @type {Map<string, { resolve: Function, reject: Function }>} */
  const waiters = new Map();
  const counters = { enqueued: 0, started: 0, succeeded: 0, failed: 0, recovered: 0, interrupted: 0, cacheHits: 0, cacheMisses: 0 };
  /** @type {number[]} */
  const waitSamples = [];
  /** @type {number[]} */
  const runSamples = [];
  /** @type {Record<string, number[]>} */
  const waitSamplesByPriority = Object.fromEntries(JOB_PRIORITIES.map((p) => [p, []]));
  /** @type {Record<string, number>} */
  const runningByPriority = Object.fromEntries(JOB_PRIORITIES.map((p) => [p, 0]));
  let running = 0;
  let closed = false;
  let started = false;
  /** @type {Array<() => void>} */
  let idleWaiters = [];

  // Crash recovery, part 1 (constructor): remember what the previous process
  // left behind and make it distinguishable from rows enqueued by this one.
  // Part 2 (`start()`) schedules it once the handlers are wired.
  const stale = /** @type {any[]} */ (db.prepare(
    "SELECT id, kind, priority, payload FROM job_queue_jobs WHERE status IN ('running','queued') ORDER BY enqueued_at, rowid",
  ).all());
  db.exec("UPDATE job_queue_jobs SET status='queued' WHERE status='running'");

  /** @param {number[]} list @param {number} value */
  function sample(list, value) {
    list.push(value);
    if (list.length > WAIT_SAMPLE_WINDOW) list.shift();
  }

  function settleIdle() {
    if (running === 0 && fair.size === 0) {
      const waiting = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiting) resolve();
    }
  }

  /** @param {string} text */
  function capText(text) {
    return text.length > MAX_STORED_RESULT_CHARS ? text.slice(0, MAX_STORED_RESULT_CHARS) : text;
  }

  function pump() {
    if (closed || lost) return;
    while (running < concurrency) {
      const entry = fair.shift();
      if (!entry) break;
      let row;
      try {
        row = /** @type {any} */ (getRow.get(entry.id));
      } catch {
        fair.push({ id: entry.id, priority: entry.priority, sizeBytes: entry.sizeBytes });
        break;
      }
      if (!row) continue;
      const handler = handlers[row.kind];
      const priority = JOB_PRIORITIES.includes(row.priority) ? row.priority : 'maintenance';
      running += 1;
      try {
        markRunning.run(now(), row.id);
      } catch {
        // Could not claim the row: release the slot and keep the job queued
        // (still `queued` in SQLite) instead of stranding it until restart.
        running -= 1;
        fair.push({ id: entry.id, priority: entry.priority, sizeBytes: entry.sizeBytes });
        break;
      }
      runningByPriority[priority] += 1;
      counters.started += 1;
      const waited = Math.max(0, now() - row.enqueued_at);
      sample(waitSamples, waited);
      sample(waitSamplesByPriority[priority], waited);
      const startedAt = now();
      Promise.resolve()
        .then(() => {
          if (typeof handler !== 'function') throw new Error(`No handler for job kind: ${row.kind}`);
          return handler(JSON.parse(row.payload), { id: row.id, kind: row.kind, priority: row.priority });
        })
        .then(
          (result) => {
            counters.succeeded += 1;
            try {
              if (!closed) {
                markDone.run('done', now(), capText(JSON.stringify(result ?? null)), null, row.id);
                pruneAfterCompletion();
              }
              waiters.get(row.id)?.resolve(result);
            } catch (error) {
              waiters.get(row.id)?.reject(error);
            }
          },
          (error) => {
            counters.failed += 1;
            const message = String(error?.message || error).slice(0, 500);
            try {
              if (!closed) {
                markDone.run('failed', now(), null, message, row.id);
                pruneAfterCompletion();
              }
              waiters.get(row.id)?.reject(error);
            } catch (writeError) {
              waiters.get(row.id)?.reject(writeError);
            }
          },
        )
        .finally(() => {
          waiters.delete(row.id);
          sample(runSamples, now() - startedAt);
          running -= 1;
          runningByPriority[priority] -= 1;
          pump();
          settleIdle();
        });
    }
  }

  /**
   * Persist and schedule a job. The returned promise settles with the handler
   * result; the job itself stays durable even if nobody awaits it.
   *
   * @param {{ kind: string, priority?: string, payload?: unknown }} job
   * @returns {{ id: string, done: Promise<any> }}
   */
  function enqueue(job) {
    if (closed) throw new Error('Job queue is closed');
    if (lost) throw new Error('Job queue lost its owner lease');
    const priority = job.priority ?? 'maintenance';
    if (!JOB_PRIORITIES.includes(priority)) throw new TypeError(`Unknown job priority: ${String(priority)}`);
    if (typeof job.kind !== 'string' || !job.kind) throw new TypeError('Job kind is required');
    const payload = JSON.stringify(job.payload ?? null);
    const id = randomUUID();
    fair.push({ id, priority, sizeBytes: payload.length });
    try {
      insert.run(id, job.kind, priority, payload, 'queued', now());
    } catch (error) {
      fair.remove(id);
      throw error;
    }
    counters.enqueued += 1;
    const done = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    done.catch(() => {});
    pump();
    return { id, done };
  }

  /**
   * Wire (or replace) the handler of a job kind.
   *
   * @param {string} kind
   * @param {(payload: any, job: { id: string, kind: string, priority: string }) => Promise<any> | any} handler
   * @param {{ recover?: boolean }} [opts] `recover: false` fails interrupted rows of this kind on `start()`
   *   instead of re-running them (use for jobs whose caller is gone after a restart).
   */
  function registerHandler(kind, handler, opts = {}) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    handlers[kind] = handler;
    if (opts.recover === false) nonRecoverable.add(kind);
    else nonRecoverable.delete(kind);
  }

  /** @returns {Promise<void>} resolves when nothing is queued or running */
  function onIdle() {
    if (running === 0 && fair.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  /** Schedule jobs left by a previous process (call once handlers are wired). */
  function start() {
    if (closed) return;
    if (!started) {
      started = true;
      for (const row of stale) {
        if (nonRecoverable.has(String(row.kind))) {
          markDone.run('failed', now(), null, 'interrupted', String(row.id));
          counters.interrupted += 1;
          continue;
        }
        const priority = JOB_PRIORITIES.includes(String(row.priority)) ? String(row.priority) : 'maintenance';
        fair.push({ id: String(row.id), priority, sizeBytes: String(row.payload).length });
        counters.recovered += 1;
      }
      stale.length = 0;
    }
    pump();
  }

  const testStore = {
    /** @returns {object | null} */
    get(/** @type {string} */ test, /** @type {string} */ hash) {
      // A closed queue serves no cache: callers fall through to a real run.
      return closed ? null : (cacheGet.get(test, hash) || null);
    },
    put(/** @type {string} */ test, /** @type {string} */ hash, /** @type {any} */ row) {
      if (closed) return;
      cachePut.run(test, hash, Math.max(0, Math.round(Number(row?.durationMs) || 0)), now());
    },
  };

  /** @param {string} id */
  function getJob(id) {
    const row = /** @type {any} */ (getRow.get(id));
    return row ? { id: row.id, kind: row.kind, priority: row.priority, status: row.status, attempts: row.attempts, error: row.error } : null;
  }

  function metrics() {
    const fairMetrics = fair.metrics();
    return {
      name: options.name || 'jobs',
      concurrency,
      running,
      runningByPriority: { ...runningByPriority },
      queued: fair.size,
      depthByPriority: fairMetrics.depthByPriority,
      oldestWaitMs: fairMetrics.oldestAgeMs,
      counters: { ...counters },
      waitMs: summarize(waitSamples),
      waitMsByPriority: Object.fromEntries(JOB_PRIORITIES.map((p) => [p, summarize(waitSamplesByPriority[p])])),
      runMs: summarize(runSamples),
      testCache: { hits: counters.cacheHits, misses: counters.cacheMisses },
      bypassed: fairMetrics.counters.bypassed,
    };
  }

  /** Count a cache outcome (wired into `runTestsWithCache` `onCache`). */
  function recordCache(/** @type {'hit' | 'miss'} */ event) {
    if (event === 'hit') counters.cacheHits += 1;
    else counters.cacheMisses += 1;
  }

  function close() {
    if (closed) return;
    closed = true;
    activeQueues.delete(queue);
    // Settle everything still pending so no caller hangs on a closed queue.
    const closedError = new Error('Job queue is closed');
    for (const waiter of waiters.values()) waiter.reject(closedError);
    waiters.clear();
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
    try {
      handle.close();
    } finally {
      // @ts-ignore
      try { coordinator?.release(); } catch { /* lease expires on its own */ }
    }
  }

  const queue = Object.freeze({ enqueue, registerHandler, start, onIdle, getJob, metrics, testStore, recordCache, close });
  activeQueues.add(queue);
  return queue;
}
