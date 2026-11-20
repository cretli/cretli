/**
 * Minimal durable job runner for long backup operations (B3).
 *
 * A job outlives the HTTP request that created it: state transitions are written
 * to `<dir>/<jobId>.json` (fsync + rename), the runner is detached from the
 * request, and a server restart marks jobs that were still running as
 * `interrupted` instead of leaving them "running" forever. An idempotency key maps
 * a retried request to the job it already created.
 *
 * Artifacts (a finished export) are published only after the runner has verified
 * their digest: temp file -> checksum read-back -> atomic rename.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurable, verifyFileDigest } from './durable-write.js';

export const JOB_ID_PATTERN = /^j-[a-z0-9]+-[a-f0-9]{8}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_STORED_JOBS = 200;

export class BackupJobError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupJobError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @typedef {Object} JobRecord
 * @property {string} id
 * @property {string} kind
 * @property {'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ done: number, total: number, label?: string }} progress
 * @property {string} [idempotencyKey]
 * @property {Record<string, unknown>} [result] small metadata only, never payloads
 * @property {{ code: string, message: string }} [error]
 * @property {{ fileName: string, bytes: number, sha256: string, contentType: string }} [artifact]
 */

/**
 * @typedef {Object} JobContext
 * @property {(done: number, total: number, label?: string) => void} progress
 * @property {() => boolean} isCancelled
 * @property {(fileName: string, bytes: Buffer, contentType: string) => { fileName: string, bytes: number, sha256: string, contentType: string }} publish
 */

/**
 * @param {{ dir: string, now?: () => Date }} options
 */
export function createJobManager(options) {
  const dir = options.dir;
  const now = options.now || (() => new Date());
  /** @type {Map<string, JobRecord>} */
  const jobs = new Map();
  /** @type {Map<string, Promise<void>>} */
  const running = new Map();
  /** @type {Set<string>} */
  const cancelRequested = new Set();
  /** @type {Set<string>} */
  const uncancellable = new Set();
  let loaded = false;

  const jobFile = (id) => path.join(dir, `${id}.json`);
  const artifactDir = (id) => path.join(dir, `${id}.artifact`);

  /** @param {JobRecord} job */
  function persist(job) {
    job.updatedAt = now().toISOString();
    writeFileDurable(jobFile(job.id), JSON.stringify(job, null, 2));
  }

  function load() {
    if (loaded) return;
    loaded = true;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!job || !JOB_ID_PATTERN.test(String(job.id))) continue;
        if (job.status === 'running' || job.status === 'queued') {
          // No runner survives a restart: say so instead of reporting progress forever.
          job.status = 'interrupted';
          job.error = { code: 'INTERRUPTED', message: 'The server restarted before the job finished' };
          persist(job);
        }
        jobs.set(job.id, job);
      } catch {
        /* an unreadable job file is ignored; it never blocks new jobs */
      }
    }
  }

  function prune() {
    const finished = [...jobs.values()].filter((j) => !running.has(j.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (jobs.size > MAX_STORED_JOBS && finished.length > 0) {
      remove(/** @type {JobRecord} */ (finished.shift()).id);
    }
  }

  /** @param {string} id */
  function remove(id) {
    jobs.delete(id);
    try { fs.unlinkSync(jobFile(id)); } catch { /* already gone */ }
    fs.rmSync(artifactDir(id), { recursive: true, force: true });
  }

  return {
    /**
     * @param {string} kind
     * @param {(ctx: JobContext) => Promise<Record<string, unknown> | void>} runner
     * @param {{ idempotencyKey?: string, cancellable?: boolean }} [opts]
     * @returns {JobRecord}
     */
    start(kind, runner, opts = {}) {
      load();
      const key = opts.idempotencyKey === undefined ? undefined : String(opts.idempotencyKey);
      if (key !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(key)) throw new BackupJobError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key must be 1-128 characters of [A-Za-z0-9._:-]');
      if (key) {
        for (const job of jobs.values()) {
          // A failed/interrupted/cancelled job does not block a retry; callers keep their own idempotency (receipts).
          if (job.idempotencyKey === key && job.kind === kind && ['queued', 'running', 'succeeded'].includes(job.status)) return job;
        }
      }
      const id = `j-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      /** @type {JobRecord} */
      const job = {
        id, kind, status: 'queued', createdAt: now().toISOString(), updatedAt: now().toISOString(),
        progress: { done: 0, total: 0 }, ...(key ? { idempotencyKey: key } : {}),
      };
      jobs.set(id, job);
      persist(job);
      prune();
      if (opts.cancellable === false) uncancellable.add(id);
      /** @type {JobContext} */
      const ctx = {
        progress(done, total, label) { job.progress = { done, total, ...(label ? { label } : {}) }; },
        isCancelled: () => cancelRequested.has(id),
        publish(fileName, bytes, contentType) {
          if (cancelRequested.has(id)) throw new BackupJobError('CANCELLED', 'Job cancelled before publication', 409);
          const safeName = path.basename(fileName);
          const target = path.join(artifactDir(id), safeName);
          const written = writeFileDurable(target, bytes);
          if (!verifyFileDigest(target, written.sha256)) {
            try { fs.unlinkSync(target); } catch { /* ignore */ }
            throw new BackupJobError('VERIFY_FAILED', 'Published archive failed its read-back checksum', 500);
          }
          return { fileName: safeName, bytes: written.bytes, sha256: written.sha256, contentType };
        },
      };
      const run = (async () => {
        job.status = 'running';
        persist(job);
        try {
          const result = await runner(ctx);
          if (cancelRequested.has(id)) throw new BackupJobError('CANCELLED', 'Job cancelled', 409);
          if (result && typeof result === 'object') {
            const { artifact, ...rest } = /** @type {Record<string, any>} */ (result);
            if (artifact) job.artifact = artifact;
            job.result = rest;
          }
          job.status = 'succeeded';
          job.progress = { done: job.progress.total, total: job.progress.total, label: 'done' };
        } catch (err) {
          const code = /** @type {any} */ (err)?.code || 'FAILED';
          job.status = code === 'CANCELLED' || code === 'cancelled' ? 'cancelled' : 'failed';
          job.error = { code: String(code), message: String(/** @type {any} */ (err)?.message || err) };
          // A failed or cancelled job leaves no published artifact behind.
          fs.rmSync(artifactDir(id), { recursive: true, force: true });
          delete job.artifact;
        }
        try { persist(job); } catch { /* status stays in memory; the next load marks it interrupted */ }
      })().finally(() => { running.delete(id); cancelRequested.delete(id); uncancellable.delete(id); });
      running.set(id, run);
      return job;
    },
    /** @param {string} id @returns {JobRecord | null} */
    get(id) {
      load();
      return jobs.get(id) || null;
    },
    /** @returns {JobRecord[]} */
    list() {
      load();
      return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    /** @param {string} id @returns {JobRecord} */
    cancel(id) {
      load();
      const job = jobs.get(id);
      if (!job) throw new BackupJobError('JOB_NOT_FOUND', 'Job not found', 404);
      if (uncancellable.has(id) && running.has(id)) throw new BackupJobError('JOB_NOT_CANCELLABLE', 'This job cannot be cancelled once started', 409);
      if (running.has(id)) cancelRequested.add(id);
      return job;
    },
    /** Resolves once the job's runner settled (tests and graceful shutdown). @param {string} id */
    async wait(id) {
      await running.get(id);
      return jobs.get(id) || null;
    },
    /** @param {string} id @returns {string | null} absolute artifact path of a succeeded job */
    artifactPath(id) {
      load();
      const job = jobs.get(id);
      if (!job || job.status !== 'succeeded' || !job.artifact) return null;
      const target = path.join(artifactDir(id), job.artifact.fileName);
      return fs.existsSync(target) ? target : null;
    },
    /** @param {string} id */
    delete(id) {
      load();
      if (running.has(id)) throw new BackupJobError('JOB_RUNNING', 'Cancel the job before deleting it', 409);
      if (!jobs.has(id)) throw new BackupJobError('JOB_NOT_FOUND', 'Job not found', 404);
      remove(id);
    },
    /** Test hook: forget in-memory state so the next call re-reads the directory. */
    resetForTests() {
      jobs.clear();
      loaded = false;
    },
  };
}
