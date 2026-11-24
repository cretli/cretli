import { randomUUID } from 'node:crypto';
import { openOperatorJournalDb } from '../persist/operator-journal-persist.js';
import {
  OPERATOR_AUDIT_MAX_AGE_MS,
  OPERATOR_AUDIT_MAX_ROWS,
  OPERATOR_MAX_REQUEUES,
  OPERATOR_RUN_LEASE_MS,
} from './operator-constants.js';

/** Stage 2a schema; lives in the same SQLite file as the operator journal. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS operator_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operator_internal_queue (
    event_id TEXT PRIMARY KEY, event_rowid INTEGER NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','acked','parked')),
    attempts INTEGER NOT NULL DEFAULT 0, journal_epoch INTEGER NOT NULL DEFAULT 0, coalesced_into TEXT,
    claimed_by_run TEXT, enqueued_at TEXT NOT NULL, event_created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS operator_queue_state ON operator_internal_queue(state, event_rowid);
  CREATE INDEX IF NOT EXISTS operator_queue_dedupe ON operator_internal_queue(dedupe_key, state);
  CREATE TABLE IF NOT EXISTS operator_runs (
    id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('running','completed','failed','interrupted')),
    workspace TEXT, trigger_event_id TEXT, trigger_kind TEXT, owner_instance_id TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, failure_reason TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS operator_runs_single_running ON operator_runs(state) WHERE state = 'running';
  CREATE TABLE IF NOT EXISTS operator_proposals (
    id TEXT PRIMARY KEY, run_id TEXT, workspace TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS operator_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tool TEXT NOT NULL, action TEXT, outcome TEXT NOT NULL,
    detail TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS operator_audit_time ON operator_audit(created_at);
  CREATE TABLE IF NOT EXISTS operator_owner_messages (
    id TEXT PRIMARY KEY, direction TEXT NOT NULL, text TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL, read_at TEXT
  );`;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Stage 2b adds the run report to `operator_runs` (a run is "reported" once
 * `reported_at` is set; ending the run stays with the scheduler). Added with
 * ALTER so journals created by stage 2a keep working. The column check and the
 * ALTERs share one write transaction, and a "duplicate column" error from a
 * process that won the race is tolerated.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureRunReportColumns(db) {
  withImmediateTx(db, () => {
    const have = new Set(db.prepare('PRAGMA table_info(operator_runs)').all().map((col) => String(col.name)));
    // Stage 2c adds the run chat, kind, deadline, untrusted refs and measured tokens.
    for (const [column, type] of [['reported_at', 'TEXT'], ['report_summary', 'TEXT'], ['report_proposals', 'TEXT'],
      ['chat_id', 'TEXT'], ['run_kind', 'TEXT'], ['deadline_at', 'TEXT'], ['untrusted_refs', 'TEXT'], ['tokens_used', 'INTEGER'],
      ['harness', 'TEXT'], ['model', 'TEXT']]) {
      if (have.has(column)) continue;
      try {
        db.exec(`ALTER TABLE operator_runs ADD COLUMN ${column} ${type}`);
      } catch (error) {
        if (!/duplicate column/i.test(String(/** @type {Error} */ (error)?.message))) throw error;
      }
    }
  });
}

/**
 * Open the journal with the operator state schema ensured. `journal_id` is
 * created once with the DB so a swapped file can be told apart.
 *
 * @param {Record<string, any>} [options] `{ dataDir?, file? }`
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openOperatorStore(options = {}) {
  const db = openOperatorJournalDb(options);
  try {
    db.exec(SCHEMA);
    ensureRunReportColumns(db);
    db.prepare("INSERT OR IGNORE INTO operator_meta(key, value) VALUES ('journal_id', ?)").run(randomUUID());
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function getMeta(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM operator_meta WHERE key=?').get(key);
  return row ? String(row.value) : fallback;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string|number} value
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO operator_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

/**
 * Run `fn` inside BEGIN IMMEDIATE; commit on return, roll back on throw.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withImmediateTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
}

/** @param {Record<string, any>} options @param {(db: import('node:sqlite').DatabaseSync) => any} fn */
function withStore(options, fn) {
  const db = openOperatorStore(options);
  try { return fn(db); } finally { db.close(); }
}

// ---- Run slot -------------------------------------------------------------

/**
 * End a run's claims after an interruption: claimed events return to pending
 * once (OPERATOR_MAX_REQUEUES), a further interruption parks them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} runId
 * @param {string} at ISO timestamp
 * @returns {{ requeued: number, parked: number }}
 */
export function releaseRunClaims(db, runId, at) {
  const parked = Number(db.prepare("UPDATE operator_internal_queue SET state='parked', updated_at=? WHERE state='claimed' AND claimed_by_run=? AND attempts > ?").run(at, runId, OPERATOR_MAX_REQUEUES).changes);
  const requeued = Number(db.prepare("UPDATE operator_internal_queue SET state='pending', claimed_by_run=NULL, updated_at=? WHERE state='claimed' AND claimed_by_run=?").run(at, runId).changes);
  return { requeued, parked };
}

/** True when the run is `running`, owned by `ownerInstanceId` and its lease has not expired. */
function holdsLiveSlot(db, runId, ownerInstanceId, now) {
  const run = db.prepare("SELECT owner_instance_id, lease_expires_at FROM operator_runs WHERE id=? AND state='running'").get(String(runId));
  return Boolean(run) && run.owner_instance_id === ownerInstanceId && !(Date.parse(String(run.lease_expires_at)) < now);
}

/**
 * Take the single run slot. A live lease is never taken over; an expired one is
 * marked interrupted first.
 *
 * @param {Record<string, any>} options `{ dataDir?, file?, now?, ttlMs? }`
 * @param {{ ownerInstanceId: string, workspace?: string, triggerEventId?: string, triggerKind?: string }} input
 * @returns {{ ok: true, runId: string, tookOver: boolean } | { ok: false, reason: 'slot_busy', run: Record<string, any> }}
 */
export function claimRunSlot(options, input) {
  const now = options.now ?? Date.now();
  return withStore(options, (db) => withImmediateTx(db, () => {
    const running = db.prepare("SELECT * FROM operator_runs WHERE state='running'").get();
    let tookOver = false;
    if (running) {
      if (!(Date.parse(String(running.lease_expires_at)) < now)) return { ok: false, reason: 'slot_busy', run: { ...running } };
      db.prepare("UPDATE operator_runs SET state='interrupted', finished_at=?, failure_reason='lease_expired' WHERE id=?").run(iso(now), running.id);
      releaseRunClaims(db, String(running.id), iso(now));
      tookOver = true;
    }
    const runId = randomUUID();
    db.prepare(`INSERT INTO operator_runs(id, state, workspace, trigger_event_id, trigger_kind, owner_instance_id, heartbeat_at, lease_expires_at, started_at)
      VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)`).run(runId, input.workspace ?? null, input.triggerEventId ?? null, input.triggerKind ?? null, input.ownerInstanceId, iso(now), iso(now + (options.ttlMs ?? OPERATOR_RUN_LEASE_MS)), iso(now));
    return { ok: true, runId, tookOver };
  }));
}

/**
 * Extend the lease; false when the run is no longer ours (taken over/finished).
 *
 * @param {Record<string, any>} options
 * @param {{ runId: string, ownerInstanceId: string }} input
 * @returns {boolean}
 */
export function heartbeatRunSlot(options, input) {
  const now = options.now ?? Date.now();
  return withStore(options, (db) => Boolean(db.prepare("UPDATE operator_runs SET heartbeat_at=?, lease_expires_at=? WHERE id=? AND owner_instance_id=? AND state='running'")
    .run(iso(now), iso(now + (options.ttlMs ?? OPERATOR_RUN_LEASE_MS)), input.runId, input.ownerInstanceId).changes));
}

/**
 * Free the slot (clean shutdown or run end). Only the owner can release.
 *
 * @param {Record<string, any>} options
 * @param {{ runId: string, ownerInstanceId: string, state?: 'completed'|'failed'|'interrupted', failureReason?: string, requeueClaims?: boolean }} input
 *   `requeueClaims` gives a failed run's claimed events the same one-retry-then-park treatment as an interruption.
 * @returns {boolean}
 */
export function releaseRunSlot(options, input) {
  const now = options.now ?? Date.now();
  const state = input.state || 'completed';
  return withStore(options, (db) => withImmediateTx(db, () => {
    const changed = Boolean(db.prepare("UPDATE operator_runs SET state=?, finished_at=?, failure_reason=? WHERE id=? AND owner_instance_id=? AND state='running'")
      .run(state, iso(now), input.failureReason ?? null, input.runId, input.ownerInstanceId).changes);
    if (changed && (state === 'interrupted' || input.requeueClaims === true)) releaseRunClaims(db, input.runId, iso(now));
    return changed;
  }));
}

// ---- Queue claim / recovery ----------------------------------------------

/**
 * Claim the oldest pending events for a run. Only the live owner of the slot can
 * claim; a stale run gets an empty list.
 *
 * @param {Record<string, any>} options
 * @param {{ runId: string, ownerInstanceId: string, limit?: number, workspace?: string }} input `workspace` limits the claim to one workspace (a run serves one workspace)
 * @returns {Record<string, any>[]}
 */
export function claimPendingEvents(options, input) {
  const now = options.now ?? Date.now();
  return withStore(options, (db) => withImmediateTx(db, () => {
    if (!holdsLiveSlot(db, input.runId, input.ownerInstanceId, now)) return [];
    const rows = input.workspace
      ? db.prepare("SELECT * FROM operator_internal_queue WHERE state='pending' AND workspace=? ORDER BY journal_epoch, event_rowid LIMIT ?").all(input.workspace, input.limit ?? 1)
      : db.prepare("SELECT * FROM operator_internal_queue WHERE state='pending' ORDER BY journal_epoch, event_rowid LIMIT ?").all(input.limit ?? 1);
    const update = db.prepare("UPDATE operator_internal_queue SET state='claimed', attempts=attempts+1, claimed_by_run=?, updated_at=? WHERE event_id=?");
    for (const row of rows) update.run(input.runId, iso(now), row.event_id);
    return rows.map((row) => ({ ...row, state: 'claimed', claimed_by_run: input.runId, attempts: Number(row.attempts) + 1 }));
  }));
}

/**
 * Ack events claimed by this run; ignored unless the run still holds a live slot.
 *
 * @param {Record<string, any>} options
 * @param {{ runId: string, ownerInstanceId: string, eventIds: string[] }} input
 * @returns {number} acked rows
 */
export function ackEvents(options, input) {
  const now = options.now ?? Date.now();
  return withStore(options, (db) => withImmediateTx(db, () => {
    if (!holdsLiveSlot(db, input.runId, input.ownerInstanceId, now)) return 0;
    const update = db.prepare("UPDATE operator_internal_queue SET state='acked', updated_at=? WHERE event_id=? AND state='claimed' AND claimed_by_run=?");
    return input.eventIds.reduce((sum, id) => sum + Number(update.run(iso(now), id, input.runId).changes), 0);
  }));
}

/**
 * Startup recovery: interrupts only runs whose lease has expired (a live run of
 * another instance is untouched) and releases only THEIR claims.
 *
 * @param {Record<string, any>} options
 * @returns {{ requeued: number, parked: number, runsInterrupted: number }}
 */
export function recoverInterruptedWork(options) {
  const now = options.now ?? Date.now();
  const at = iso(now);
  return withStore(options, (db) => withImmediateTx(db, () => {
    const expired = db.prepare("SELECT id, lease_expires_at FROM operator_runs WHERE state='running'").all()
      .filter((run) => Date.parse(String(run.lease_expires_at)) < now);
    let requeued = 0; let parked = 0;
    for (const run of expired) {
      db.prepare("UPDATE operator_runs SET state='interrupted', finished_at=?, failure_reason='server_restart' WHERE id=?").run(at, run.id);
      const released = releaseRunClaims(db, String(run.id), at);
      requeued += released.requeued; parked += released.parked;
    }
    return { requeued, parked, runsInterrupted: expired.length };
  }));
}

// ---- Retention ------------------------------------------------------------

/**
 * Delete old journal events but never the newest row: rowids are reused after
 * the table empties, which would corrupt cursors held by the ingest.
 *
 * @param {Record<string, any>} options `{ olderThanMs }`
 * @returns {number} deleted rows
 */
export function pruneOperatorEvents(options) {
  const cutoff = iso((options.now ?? Date.now()) - options.olderThanMs);
  return withStore(options, (db) => Number(db.prepare('DELETE FROM operator_events WHERE created_at < ? AND rowid < (SELECT MAX(rowid) FROM operator_events)').run(cutoff).changes));
}

/**
 * operator_audit keeps 30 days and at most 50k rows.
 *
 * @param {Record<string, any>} options `{ maxAgeMs?, maxRows? }`
 * @returns {number} deleted rows
 */
export function pruneOperatorAudit(options) {
  const cutoff = iso((options.now ?? Date.now()) - (options.maxAgeMs ?? OPERATOR_AUDIT_MAX_AGE_MS));
  const maxRows = options.maxRows ?? OPERATOR_AUDIT_MAX_ROWS;
  return withStore(options, (db) => withImmediateTx(db, () => {
    let deleted = Number(db.prepare('DELETE FROM operator_audit WHERE created_at < ?').run(cutoff).changes);
    deleted += Number(db.prepare('DELETE FROM operator_audit WHERE id NOT IN (SELECT id FROM operator_audit ORDER BY id DESC LIMIT ?)').run(maxRows).changes);
    return deleted;
  }));
}
