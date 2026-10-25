/**
 * Job-queue store schema (S4): persistent background job queue and test-result cache.
 *
 * The queue owns its own store file, so its migration list is
 * `[core, job-queue]` (the core step brands the file with the shared
 * application id and stays identical to the consolidated store's v1); it never
 * touches the chat-history schema lineage.
 *
 * - `job_queue_jobs`: one row per queued/running/finished job. A row left
 *   `running` by a crash is re-queued (or failed as `interrupted`) when the
 *   queue starts. Payload and result are JSON text, capped by the queue.
 * - `job_queue_test_results`: PASS results keyed by `(test, hash)` where the
 *   hash covers the test, its import closure and the environment facts.
 *
 * Forward-only; the tables are only touched by lib/job-queue/.
 */
import core0001 from '../storage/schema/0001-core.js';

const MAX_TEXT = 200;

const jobQueue0002 = Object.freeze({
  version: 2,
  name: 'job-queue',
  sql: `
CREATE TABLE job_queue_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND ${MAX_TEXT}),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0 AND length(kind) <= ${MAX_TEXT}),
  priority TEXT NOT NULL CHECK (length(trim(priority)) > 0 AND length(priority) <= ${MAX_TEXT}),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  enqueued_at INTEGER NOT NULL CHECK (enqueued_at >= 0),
  started_at INTEGER,
  finished_at INTEGER,
  result TEXT,
  error TEXT
) STRICT;

CREATE INDEX job_queue_jobs_status ON job_queue_jobs (status, enqueued_at);

CREATE TABLE job_queue_test_results (
  test TEXT NOT NULL CHECK (length(trim(test)) > 0 AND length(test) <= 512),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  at INTEGER NOT NULL CHECK (at >= 0),
  PRIMARY KEY (test, hash)
) STRICT, WITHOUT ROWID;

CREATE INDEX job_queue_test_results_at ON job_queue_test_results (at);
`,
});

/** @type {ReadonlyArray<import('../storage/migrations.js').StorageMigration>} */
export const JOB_QUEUE_MIGRATIONS = Object.freeze([core0001, jobQueue0002]);
