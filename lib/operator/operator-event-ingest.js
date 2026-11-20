import {
  OPERATOR_COALESCE_WINDOW_MS,
  OPERATOR_QUEUE_MAX_PENDING,
} from './operator-constants.js';
import { getMeta, openOperatorStore, setMeta, withImmediateTx } from './operator-internal-store.js';

const iso = (ms) => new Date(ms).toISOString();

/**
 * Leaf id from the `... leaf <id>, ...` summary convention used by the producers.
 *
 * @param {string} summary
 * @returns {string}
 */
export function extractLeafId(summary) {
  return /\bleaf ([^,\s]+),/.exec(String(summary))?.[1] || '';
}

/**
 * `workspace|kind|leafId`, or `workspace|kind|reason` when the event has no leaf.
 *
 * @param {{ workspace: string, kind: string, summary: string }} event
 * @returns {string}
 */
export function buildDedupeKey(event) {
  const leafId = extractLeafId(event.summary);
  if (leafId) return `${event.workspace}|${event.kind}|${leafId}`;
  const text = String(event.summary || '');
  const reason = /\breason ([^\s,]+)/.exec(text)?.[1] || text.replace(/^[a-z_]+:\s*/i, '').trim().slice(0, 80);
  return `${event.workspace}|${event.kind}|${reason}`;
}

/**
 * Whether two timestamps fall inside one coalescing window.
 *
 * @param {number} firstMs
 * @param {number} secondMs
 * @param {number} [windowMs]
 * @returns {boolean}
 */
export function isWithinCoalesceWindow(firstMs, secondMs, windowMs = OPERATOR_COALESCE_WINDOW_MS) {
  return Math.abs(secondMs - firstMs) <= windowMs;
}

/**
 * Events of all workspaces after a cursor (SQLite rowid), oldest first. `id` is
 * the event UUID; `leafId` is parsed from the summary when present.
 *
 * @param {number} after
 * @param {{ kinds?: string[], limit?: number }} [query]
 * @param {Record<string, any>} [options]
 * @returns {{ events: { id: string, cursor: number, workspace: string, kind: string, summary: string, createdAt: string, leafId: string }[], cursor: number }}
 */
export function listOperatorEventsGlobalSince(after, query = {}, options = {}) {
  const db = openOperatorStore(options);
  try { return readGlobalSince(db, after, query); } finally { db.close(); }
}

function readGlobalSince(db, after, query = {}) {
  const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const limit = Number.isSafeInteger(query.limit) ? Math.min(1000, Math.max(1, query.limit)) : 200;
  const kinds = (Array.isArray(query.kinds) ? query.kinds : []).map(String).filter(Boolean);
  const head = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS head FROM operator_events').get().head) || 0;
  const rows = db.prepare(`SELECT id, rowid AS cursor, workspace_folder AS workspace, kind, summary, created_at AS createdAt FROM operator_events
    WHERE rowid>? AND rowid<=?${kinds.length ? ' AND kind IN (SELECT value FROM json_each(?))' : ''} ORDER BY rowid LIMIT ?`)
    // Caller-supplied kinds go in as one JSON parameter (docs/in-clause-audit.md), never one `?` each.
    .all(...(kinds.length ? [from, head, JSON.stringify(kinds), limit] : [from, head, limit]));
  const events = rows.map((row) => ({ id: row.id, cursor: Number(row.cursor), workspace: row.workspace, kind: row.kind, summary: row.summary, createdAt: row.createdAt, leafId: extractLeafId(row.summary) }));
  return { events, cursor: events.length >= limit ? events[events.length - 1].cursor : Math.max(from, head) };
}

/**
 * Detect a journal reset. Returns the reason or '' when the cursor is sound.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [knownJournalId] journal id the caller saw last time
 */
function detectReset(db, knownJournalId) {
  const cursor = Number(getMeta(db, 'internal_operator_cursor', '0')) || 0;
  const head = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS head FROM operator_events').get().head) || 0;
  if (knownJournalId && knownJournalId !== getMeta(db, 'journal_id')) return 'journal_id_changed';
  if (cursor > head) return 'cursor_beyond_head';
  if (cursor > 0) {
    const row = db.prepare('SELECT id FROM operator_events WHERE rowid=?').get(cursor);
    if (!row || row.id !== getMeta(db, 'last_event_uuid')) return 'cursor_uuid_mismatch';
  }
  return '';
}

/**
 * Enforce the pending cap. Order is (journal_epoch, event_rowid): rowids repeat
 * after a reset, so rowid alone would rank an old-epoch row above a new one.
 * First drop non-newest rows per (workspace, kind), oldest first; if the cap
 * still does not hold (many distinct pairs) drop the oldest pending rows.
 */
function enforceQueueBound(db, maxPending) {
  const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM operator_internal_queue WHERE state='pending'").get().n);
  const remove = db.prepare('DELETE FROM operator_internal_queue WHERE event_id=?');
  let excess = count() - maxPending;
  if (excess <= 0) return 0;
  let dropped = 0;
  const superseded = db.prepare(`SELECT event_id FROM operator_internal_queue q WHERE state='pending'
    AND EXISTS (SELECT 1 FROM operator_internal_queue n WHERE n.state='pending' AND n.workspace=q.workspace AND n.kind=q.kind
      AND (n.journal_epoch, n.event_rowid) > (q.journal_epoch, q.event_rowid))
    ORDER BY journal_epoch, event_rowid LIMIT ?`).all(excess);
  for (const row of superseded) { remove.run(row.event_id); dropped += 1; }
  excess = count() - maxPending;
  if (excess > 0) {
    const oldest = db.prepare("SELECT event_id FROM operator_internal_queue WHERE state='pending' ORDER BY journal_epoch, event_rowid LIMIT ?").all(excess);
    for (const row of oldest) { remove.run(row.event_id); dropped += 1; }
  }
  return dropped;
}

/**
 * Move new journal events into the internal queue. Inserts and the cursor
 * advance happen in ONE BEGIN IMMEDIATE, so a failure never moves the cursor.
 *
 * @param {Record<string, any>} options `{ dataDir?, file?, now?, kinds?, limit?, knownJournalId?, coalesceWindowMs?, maxPending?, logger?, afterInsert? }`
 *   `afterInsert` is a test seam called between the inserts and the cursor update.
 * @returns {{ ingested: number, coalesced: number, dropped: number, reset: string, cursor: number, journalId: string, epoch: number }}
 */
export function ingestOperatorEvents(options = {}) {
  const now = options.now ?? Date.now();
  const logger = options.logger || console;
  const db = openOperatorStore(options);
  try {
    return withImmediateTx(db, () => {
      let epoch = Number(getMeta(db, 'journal_epoch', '0')) || 0;
      const reset = detectReset(db, options.knownJournalId);
      if (reset) {
        epoch += 1;
        logger.warn?.(`[operator-ingest] journal reset detected (${reset}); epoch ${epoch}, cursor reset to 0`);
        setMeta(db, 'journal_epoch', epoch);
        setMeta(db, 'internal_operator_cursor', 0);
        setMeta(db, 'last_event_uuid', '');
      }
      const cursor = Number(getMeta(db, 'internal_operator_cursor', '0')) || 0;
      const page = readGlobalSince(db, cursor, { limit: options.limit ?? 500 });
      const wanted = Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds) : null;
      const window = options.coalesceWindowMs ?? OPERATOR_COALESCE_WINDOW_MS;
      const insert = db.prepare(`INSERT OR IGNORE INTO operator_internal_queue(event_id, event_rowid, workspace, kind, dedupe_key, state, attempts, journal_epoch, coalesced_into, enqueued_at, event_created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
      const findOpen = db.prepare("SELECT event_id, event_created_at FROM operator_internal_queue WHERE dedupe_key=? AND state='pending' ORDER BY journal_epoch DESC, event_rowid DESC LIMIT 1");
      let ingested = 0; let coalesced = 0;
      for (const event of page.events) {
        if (wanted && !wanted.has(event.kind)) continue;
        const key = buildDedupeKey(event);
        const open = findOpen.get(key);
        const merged = open && isWithinCoalesceWindow(Date.parse(String(open.event_created_at)), Date.parse(event.createdAt), window) ? open.event_id : null;
        const result = insert.run(event.id, event.cursor, event.workspace, event.kind, key, merged ? 'acked' : 'pending', epoch, merged, iso(now), event.createdAt, iso(now));
        if (!result.changes) continue;
        if (merged) coalesced += 1; else ingested += 1;
      }
      options.afterInsert?.();
      const last = page.events[page.events.length - 1];
      setMeta(db, 'internal_operator_cursor', page.cursor);
      if (last && page.cursor === last.cursor) setMeta(db, 'last_event_uuid', last.id);
      else if (page.cursor > cursor) {
        // Cursor advanced past filtered rows without a page row at that rowid.
        const tail = db.prepare('SELECT id FROM operator_events WHERE rowid=?').get(page.cursor);
        if (tail) setMeta(db, 'last_event_uuid', String(tail.id));
      }
      const dropped = enforceQueueBound(db, options.maxPending ?? OPERATOR_QUEUE_MAX_PENDING);
      if (dropped) setMeta(db, 'queue_dropped_total', (Number(getMeta(db, 'queue_dropped_total', '0')) || 0) + dropped);
      return { ingested, coalesced, dropped, reset, cursor: page.cursor, journalId: getMeta(db, 'journal_id'), epoch };
    });
  } finally { db.close(); }
}
