import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPath } from '../runtime-paths.js';

export const OPERATOR_NOTE_KINDS = Object.freeze(['decision', 'question', 'in_progress', 'temporary_setting', 'lesson']);
export const OPERATOR_LEASE_TTL_MS = 90_000;
const PROCESS_INSTANCE_ID = randomUUID();

/**
 * Open the journal DB (creating the base schema). Callers must close it.
 *
 * @param {Record<string, any>} [options]
 * @returns {DatabaseSync}
 */
export function openOperatorJournalDb(options = {}) {
  const file = options.file || path.join(options.dataDir || path.dirname(resolveDataPath('operator-journal.sqlite')), 'operator-journal.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS operator_notes (
      id TEXT PRIMARY KEY, workspace_folder TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      todo_id TEXT, author_client_id TEXT NOT NULL, author_client_name TEXT NOT NULL,
      author_session_id TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS operator_notes_workspace_open ON operator_notes(workspace_folder, resolved_at, created_at);
    CREATE TABLE IF NOT EXISTS operator_sessions (
      workspace_folder TEXT NOT NULL, session_id TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_handoff_at TEXT,
      PRIMARY KEY(workspace_folder, session_id)
    );
    CREATE TABLE IF NOT EXISTS operator_leases (
      workspace_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL, client_id TEXT NOT NULL,
      client_name TEXT NOT NULL, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_events (
      id TEXT PRIMARY KEY, workspace_folder TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_journal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS operator_events_workspace_time ON operator_events(workspace_folder, created_at);`);
  return db;
}

const open = openOperatorJournalDb;

function workspace(value) {
  const result = path.resolve(String(value || ''));
  if (!value || result === path.parse(result).root) throw Object.assign(new Error('workspaceFolder is required'), { code: 'VALIDATION_ERROR' });
  return result;
}

function iso(ms) { return new Date(ms).toISOString(); }

export function addOperatorNote(scope, input, options = {}) {
  const kind = String(input.kind || '');
  const body = String(input.text || '').trim();
  if (!OPERATOR_NOTE_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of: ${OPERATOR_NOTE_KINDS.join(', ')}`), { code: 'VALIDATION_ERROR' });
  if (!body || body.length > 10_000) throw Object.assign(new Error('text must be 1-10000 characters'), { code: 'VALIDATION_ERROR' });
  const now = options.now ?? Date.now();
  const expiresMs = input.expiresAt ? Date.parse(String(input.expiresAt)) : NaN;
  if (input.expiresAt && !Number.isFinite(expiresMs)) throw Object.assign(new Error('expires_at must be an ISO date'), { code: 'VALIDATION_ERROR' });
  const expiresAt = input.expiresAt ? iso(expiresMs) : null;
  if (kind === 'temporary_setting' && !expiresAt) throw Object.assign(new Error('temporary_setting requires expires_at'), { code: 'VALIDATION_ERROR' });
  const row = { id: randomUUID(), workspaceFolder: workspace(scope.workspaceFolder), kind, text: body, todoId: String(input.todoId || '').trim() || null, authorClientId: scope.clientId, authorClientName: scope.clientName, authorSessionId: scope.sessionId, createdAt: iso(now), resolvedAt: null, expiresAt };
  const db = open(options);
  try { db.prepare(`INSERT INTO operator_notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.workspaceFolder, row.kind, row.text, row.todoId, row.authorClientId, row.authorClientName, row.authorSessionId, row.createdAt, null, row.expiresAt); }
  finally { db.close(); }
  return row;
}

function mapNote(row) {
  return { id: row.id, workspaceFolder: row.workspace_folder, kind: row.kind, text: row.text, todoId: row.todo_id, author: { clientId: row.author_client_id, clientName: row.author_client_name, sessionId: row.author_session_id }, createdAt: row.created_at, resolvedAt: row.resolved_at, expiresAt: row.expires_at };
}

export function resolveOperatorNote(workspaceFolder, id, options = {}) {
  const db = open(options); const at = iso(options.now ?? Date.now());
  try {
    const result = db.prepare('UPDATE operator_notes SET resolved_at = ? WHERE id = ? AND workspace_folder = ? AND resolved_at IS NULL').run(at, String(id), workspace(workspaceFolder));
    if (!result.changes) throw Object.assign(new Error('operator note not found in this workspace or already resolved'), { code: 'NOT_FOUND' });
    return mapNote(db.prepare('SELECT * FROM operator_notes WHERE id = ?').get(String(id)));
  } finally { db.close(); }
}

export function listOperatorNotes(workspaceFolder, options = {}) {
  const db = open(options);
  try {
    const where = options.includeResolved ? '' : 'AND resolved_at IS NULL';
    return db.prepare(`SELECT * FROM operator_notes WHERE workspace_folder = ? ${where} ORDER BY created_at DESC`).all(workspace(workspaceFolder)).map(mapNote);
  } finally { db.close(); }
}

export function acquireOperatorLease(scope, input = {}, options = {}) {
  const folder = workspace(scope.workspaceFolder); const now = options.now ?? Date.now(); const at = iso(now); const expiresAt = iso(now + (options.ttlMs || OPERATOR_LEASE_TTL_MS));
  const db = open(options);
  try {
    db.exec('BEGIN IMMEDIATE');
    const current = db.prepare('SELECT * FROM operator_leases WHERE workspace_folder = ?').get(folder);
    const activeOther = current && Date.parse(String(current.expires_at)) > now && current.session_id !== scope.sessionId;
    if (activeOther && input.takeover !== true) { db.exec('ROLLBACK'); return { ok: false, conflict: true, lease: current }; }
    db.prepare(`INSERT INTO operator_leases VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_folder) DO UPDATE SET session_id=excluded.session_id, client_id=excluded.client_id, client_name=excluded.client_name,
      acquired_at=CASE WHEN operator_leases.session_id=excluded.session_id THEN operator_leases.acquired_at ELSE excluded.acquired_at END,
      heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`).run(folder, scope.sessionId, scope.clientId, scope.clientName, at, at, expiresAt);
    db.prepare(`INSERT INTO operator_sessions VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_folder, session_id) DO UPDATE SET client_id=excluded.client_id, client_name=excluded.client_name, last_seen_at=excluded.last_seen_at`).run(folder, scope.sessionId, scope.clientId, scope.clientName, at, at, null);
    db.exec('COMMIT');
    return { ok: true, takeover: Boolean(activeOther), lease: db.prepare('SELECT * FROM operator_leases WHERE workspace_folder = ?').get(folder) };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
}

export function operatorHandoff(scope, input = {}, options = {}) {
  const previousDb = open(options); let previous;
  try { previous = previousDb.prepare('SELECT last_handoff_at FROM operator_sessions WHERE workspace_folder=? AND session_id=?').get(workspace(scope.workspaceFolder), scope.sessionId)?.last_handoff_at || null; } finally { previousDb.close(); }
  const lease = acquireOperatorLease(scope, input, options);
  if (!lease.ok) return lease;
  const now = options.now ?? Date.now(); const db = open(options);
  try {
    const markerKey = `process_instance:${workspace(scope.workspaceFolder)}`;
    const processMarker = db.prepare('SELECT value FROM operator_journal_meta WHERE key=?').get(markerKey);
    if (processMarker && processMarker.value !== PROCESS_INSTANCE_ID) {
      db.prepare('INSERT INTO operator_events VALUES (?, ?, ?, ?, ?)').run(randomUUID(), workspace(scope.workspaceFolder), 'restart', 'Cretli server restarted', iso(now));
    }
    db.prepare('INSERT INTO operator_journal_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(markerKey, PROCESS_INSTANCE_ID);
    const events = previous ? db.prepare('SELECT kind, summary, created_at AS createdAt FROM operator_events WHERE workspace_folder=? AND created_at>? ORDER BY created_at').all(workspace(scope.workspaceFolder), previous) : [];
    db.prepare('UPDATE operator_sessions SET last_handoff_at=?, last_seen_at=? WHERE workspace_folder=? AND session_id=?').run(iso(now), iso(now), workspace(scope.workspaceFolder), scope.sessionId);
    return { ...lease, since: previous, notes: listOperatorNotes(scope.workspaceFolder, options), events, sessions: listOperatorSessions(scope.workspaceFolder, options) };
  } finally { db.close(); }
}

export function listOperatorSessions(workspaceFolder, options = {}) {
  const db = open(options); const folder = workspace(workspaceFolder);
  try { return db.prepare(`SELECT s.session_id AS sessionId, s.client_id AS clientId, s.client_name AS clientName, s.first_seen_at AS firstSeenAt, s.last_seen_at AS lastSeenAt, s.last_handoff_at AS lastHandoffAt,
      CASE WHEN l.session_id=s.session_id AND l.expires_at>? THEN 1 ELSE 0 END AS active FROM operator_sessions s LEFT JOIN operator_leases l ON l.workspace_folder=s.workspace_folder WHERE s.workspace_folder=? ORDER BY s.last_seen_at DESC`).all(iso(options.now ?? Date.now()), folder).map((row) => ({ ...row, active: Boolean(row.active) })); } finally { db.close(); }
}

export function assertOperatorLease(scope, options = {}) {
  // Acquisition and ownership verification must be one SQLite transaction. A
  // read followed by a separate acquire lets two sessions both observe expiry.
  const result = acquireOperatorLease({
    ...scope,
    clientId: scope.clientId || '',
    clientName: scope.clientName || 'operator',
  }, {}, options);
  if (!result.ok || result.lease?.session_id !== scope.sessionId) {
    throw Object.assign(new Error('Call operator_handoff before mutating workspace state; another active session may hold the lease'), { code: 'OPERATOR_LEASE_REQUIRED' });
  }
  return result.lease;
}

export function recordOperatorEvent(workspaceFolder, kind, summary, options = {}) {
  const db = open(options); try { db.prepare('INSERT INTO operator_events VALUES (?, ?, ?, ?, ?)').run(randomUUID(), workspace(workspaceFolder), String(kind), String(summary), iso(options.now ?? Date.now())); } finally { db.close(); }
}

/**
 * State-transition producers call this: a failing journal write is logged and
 * swallowed so it can never break the transition that triggered it.
 *
 * @param {string} workspaceFolder
 * @param {string} kind
 * @param {string} summary
 * @param {Record<string, any>} [options]
 * @returns {boolean} whether the event was written
 */
export function recordOperatorEventSafe(workspaceFolder, kind, summary, options = {}) {
  try {
    recordOperatorEvent(workspaceFolder, kind, summary, options);
    notifyOperatorEventListeners(workspaceFolder);
    return true;
  } catch (error) {
    console.warn('[operator-journal] state event not recorded', kind, error instanceof Error ? error.message : error);
    return false;
  }
}

const eventListeners = new Set();

/**
 * Wake long-poll waiters after a write. In-process only; a waiter also re-reads
 * on its own bounded timer so a missed wake-up only delays delivery.
 *
 * @param {(workspaceFolder: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onOperatorEventRecorded(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function notifyOperatorEventListeners(workspaceFolder) {
  for (const listener of [...eventListeners]) {
    try { listener(workspaceFolder); } catch { /* a bad listener must not affect the writer */ }
  }
}

/**
 * Events after a cursor (the SQLite rowid) for one workspace, oldest first.
 *
 * @param {string} workspaceFolder
 * @param {{ after?: number, kinds?: string[], limit?: number }} [query]
 * @param {Record<string, any>} [options]
 * @returns {{ events: { cursor: number, kind: string, summary: string, createdAt: string }[], cursor: number }}
 */
export function listOperatorEventsSince(workspaceFolder, query = {}, options = {}) {
  const db = open(options);
  try {
    const after = Number.isSafeInteger(query.after) && query.after > 0 ? query.after : 0;
    const limit = Number.isSafeInteger(query.limit) ? Math.min(500, Math.max(1, query.limit)) : 100;
    const kinds = (Array.isArray(query.kinds) ? query.kinds : []).map(String).filter(Boolean);
    const marks = kinds.map(() => '?').join(',');
    // Snapshot the head first and bound the page by it, so a row inserted
    // between the two reads can never be jumped over by the returned cursor.
    const head = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS head FROM operator_events WHERE workspace_folder=?').get(workspace(workspaceFolder)).head) || 0;
    const rows = db.prepare(`SELECT rowid AS cursor, kind, summary, created_at AS createdAt FROM operator_events WHERE workspace_folder=? AND rowid>? AND rowid<=?${kinds.length ? ` AND kind IN (${marks})` : ''} ORDER BY rowid LIMIT ?`)
      .all(workspace(workspaceFolder), after, head, ...kinds, limit);
    const events = rows.map((row) => ({ cursor: Number(row.cursor), kind: String(row.kind), summary: String(row.summary), createdAt: String(row.createdAt) }));
    // A full page continues from its last row; otherwise the cursor advances
    // past events the type filter skipped, up to the snapshot head.
    // A cursor beyond the head (client ahead of a reset journal) is echoed back,
    // so the cursor never moves backwards.
    const cursor = events.length >= limit ? events[events.length - 1].cursor : Math.max(after, head);
    return { events, cursor };
  } finally { db.close(); }
}

/**
 * Current head cursor of one workspace's event feed (0 when empty).
 *
 * @param {string} workspaceFolder
 * @param {Record<string, any>} [options]
 * @returns {number}
 */
export function getOperatorEventsHead(workspaceFolder, options = {}) {
  const db = open(options);
  try { return Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS head FROM operator_events WHERE workspace_folder=?').get(workspace(workspaceFolder)).head) || 0; } finally { db.close(); }
}

/**
 * Latest event of the given kinds per leaf. The leaf id is read from the
 * summary prefix `... leaf <id>, ...` written by the reviewer pair gate, so no
 * new store or column is needed.
 *
 * @param {string} workspaceFolder
 * @param {string[]} kinds
 * @param {Record<string, any>} [options]
 * @returns {Map<string, { kind: string, summary: string, createdAt: string, leafId: string }>}
 */
export function readLatestOperatorEventsByLeaf(workspaceFolder, kinds, options = {}) {
  const db = open(options);
  try {
    const list = (Array.isArray(kinds) ? kinds : []).map(String);
    if (list.length === 0) return new Map();
    const marks = list.map(() => '?').join(',');
    const rows = db.prepare(`SELECT kind, summary, created_at AS createdAt FROM operator_events WHERE workspace_folder=? AND kind IN (${marks}) ORDER BY created_at, rowid`).all(workspace(workspaceFolder), ...list);
    const latest = new Map();
    for (const row of rows) {
      const leafId = /\bleaf ([^,\s]+),/.exec(String(row.summary))?.[1];
      if (leafId) latest.set(leafId, { kind: row.kind, summary: row.summary, createdAt: row.createdAt, leafId });
    }
    return latest;
  } finally { db.close(); }
}
