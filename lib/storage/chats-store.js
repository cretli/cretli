/**
 * Chats domain of the storage worker (ADR docs/storage-chats-metadata-decision.md, sections 3-6).
 *
 * Doubles as the worker handler registry (`commands`, `queries`) and, on the main thread, as the Promise
 * facade `createChatsStore`. The schema is `lib/storage/schema/0009-chats.js`; the data lives in its own
 * `chats.sqlite` file (opened through the `filename` option), and nothing in production opens it yet.
 *
 * - A chat is an opaque JSON object except for the column fields (`COLUMN_FIELDS`) and the small list-visible
 *   remainder (`LIGHT_KEYS`, `light_json`). Everything else, unknown fields included, is kept in
 *   `chat_details.extra_json` with the original key order, so a read reproduces the record exactly.
 * - Mutations are receipt-wrapped commands (lib/storage/command-receipts.js). Every mutation keeps the
 *   `chat_scope_counts` buckets, `chat_store_meta` and the receipt in the same transaction as the chat rows;
 *   a CAS failure, a limit error or a replay changes no counter.
 * - Statement counts never depend on the number of chats or of changed rows: batch operations use `json_each`
 *   and recursive CTEs instead of per-chat statements.
 * - Handlers never read the clock; callers pass `archivedAt` and every timestamp inside the payload.
 * - Command payloads are capped at CHATS_MAX_PAYLOAD_BYTES so a group-commit member always fits.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';
import { DATASET_GENERATION_PATTERN, executeCommand, RECEIPT_QUERIES, resolveUnknown, withReceipt } from './command-receipts.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';

const COMMAND_PREFIX = 'chats.';
/** Page size of `chats.page` when the caller gives none, and its hard cap. */
export const CHATS_PAGE_DEFAULT_LIMIT = 50;
export const CHATS_PAGE_MAX_LIMIT = 500;
/** Ids per `getMany`, rows per `importBatch`, roots per `archive`, rows per `subtree` page. */
export const CHATS_BATCH_MAX_ITEMS = 200;
/** Rows one `archive` or `remove` may touch (whole subtrees included). */
export const CHATS_MAX_SUBTREE_ROWS = 10000;
/**
 * Payload budget of a command. The group-commit member entry (`{"name","commandId","payload"}` + comma) must
 * stay below `maxMemberBytes` (256 KiB - 14 B); 240 KiB leaves room for the envelope.
 */
export const CHATS_MAX_PAYLOAD_BYTES = 240 * 1024;
/** Rows the widget stream may read from its index range before a page is complete. */
export const CHATS_WIDGET_SCAN_LIMIT = 5001;
/** Ancestor chain bounds of `archived=tree`. */
export const CHATS_TREE_MAX_DEPTH = 64;
export const CHATS_TREE_MAX_ANCESTORS = 3200;
/** Buckets one `archivedCountsByWorkspace` result may carry. */
export const CHATS_COUNTS_MAX_BUCKETS = 5000;
/** A light field whose JSON is larger than this moves to `chat_details`. */
export const CHATS_LIGHT_VALUE_MAX_BYTES = 1024;

/** Record field -> `chats` column, for fields stored as plain strings. */
const COLUMN_FIELDS = Object.freeze({
  title: 'title',
  workspaceFolder: 'workspace_folder',
  workspaceFile: 'workspace_file',
  widgetInstallationId: 'widget_installation_id',
  widgetPageSessionId: 'widget_page_session_id',
  forkParentChatId: 'parent_id',
  todoId: 'todo_id',
  agentTransport: 'agent_transport',
  cursorSessionId: 'cursor_session_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  archivedAt: 'archived_at',
});
/** Fields whose column holds `trim(value)`; the raw string stays in `extra_json` when it differs. */
const TRIMMED_FIELDS = new Set(['forkParentChatId', 'archivedAt']);
/** List-visible small fields kept in `light_json` (profile: docs/storage-chats-field-profile.md). */
const LIGHT_KEYS = Object.freeze([
  'model', 'sdkMode', 'sdkUiMode', 'titleSource', 'titleRev', 'lastSeenAt', 'lastFinishedAt',
  'autoArchivePostponedAt', 'watcherPinned', 'isTemporary', 'forkKind', 'workspaceId', 'widgetPinnedUrl',
]);
const LIGHT_KEY_SET = new Set(LIGHT_KEYS);
const FORBIDDEN_KEYS = new Set(['__proto__']);
/** Fields `markRead` may set. */
const READ_MARK_KEYS = Object.freeze(['lastSeenAt', 'lastFinishedAt', 'autoArchivePostponedAt']);

/** Columns of a `chats` row that a write sets, in schema order (the INSERT/UPDATE column list). */
const WRITE_COLUMNS = Object.freeze([
  'workspace_folder_key', 'workspace_file_key', 'workspace_folder', 'workspace_file', 'widget_installation_id',
  'widget_page_session_id', 'parent_id', 'todo_id', 'title', 'agent_transport', 'cursor_session_id', 'created_at',
  'updated_at', 'last_activity_at', 'archived_at', 'light_json',
]);
const LIST_COLUMNS = 'id, position, workspace_folder, workspace_file, widget_installation_id, widget_page_session_id, parent_id, '
  + 'todo_id, title, agent_transport, cursor_session_id, created_at, updated_at, last_activity_at, archived_at, revision, light_json';
const BUCKET_COLUMNS = 'workspace_file, workspace_folder, workspace_file_key, workspace_folder_key, archived_at, parent_id';

/**
 * @param {string} kind
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(kind, details = {}) {
  throw new StorageError('conflict', 'Chats command refused', {
    details: { operation: 'chats', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v @returns {boolean} */
function isId(v) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= 512;
}

/** `path.resolve(trim(value))`, `''` for an empty value (the rule of `matchesWorkspaceScope`). */
export function workspaceKeyOf(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? '' : path.resolve(trimmed);
}

/**
 * Sort key of the list: `updatedAt`, else `createdAt` (both trimmed), `''` when neither is a string.
 *
 * @param {Record<string, any>} chat
 * @returns {string}
 */
export function lastActivityOf(chat) {
  const updated = typeof chat.updatedAt === 'string' ? chat.updatedAt.trim() : '';
  if (updated !== '') return updated;
  return typeof chat.createdAt === 'string' ? chat.createdAt.trim() : '';
}

/** @param {unknown} payload @param {number} [limit] */
function assertPayloadSize(payload, limit = CHATS_MAX_PAYLOAD_BYTES) {
  if (Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8') > limit) refuse('batch_too_large', { limit });
}

/**
 * Split a record into column values, the light remainder, the extra remainder and the key order.
 * A column field of an unexpected type stays in `extra`, so nothing is coerced.
 *
 * @param {Record<string, any>} chat
 * @returns {{ id: string, cols: Record<string, string>, extra: Record<string, any>, order: string[], light: Record<string, any> }}
 */
export function splitChat(chat) {
  if (!isPlainObject(chat) || !isId(chat.id)) refuse('chat_invalid_record');
  const keys = Object.keys(chat);
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) refuse('chat_invalid_record');
  /** @type {Record<string, string>} */
  const cols = {};
  for (const column of Object.values(COLUMN_FIELDS)) cols[column] = '';
  const extra = {};
  const light = {};
  const order = [];
  for (const key of keys) {
    const value = chat[key];
    if (value === undefined) continue;
    order.push(key);
    if (key === 'id') continue;
    const column = /** @type {Record<string, string>} */ (COLUMN_FIELDS)[key];
    if (column !== undefined && typeof value === 'string') {
      if (TRIMMED_FIELDS.has(key)) {
        cols[column] = value.trim();
        if (cols[column] !== value) extra[key] = value;
      } else cols[column] = value;
    } else if (LIGHT_KEY_SET.has(key) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= CHATS_LIGHT_VALUE_MAX_BYTES) {
      light[key] = value;
    } else extra[key] = value;
  }
  cols.workspace_folder_key = workspaceKeyOf(cols.workspace_folder);
  cols.workspace_file_key = workspaceKeyOf(cols.workspace_file);
  cols.last_activity_at = lastActivityOf(chat);
  cols.light_json = JSON.stringify(light);
  return { id: chat.id, cols, extra, order, light };
}

/**
 * Rebuild the record from a `chats` row and its details. `archivedAt` is appended when the column is set
 * and the key was never recorded (bulk archive sets the column without touching the details).
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>} details
 * @returns {Record<string, any>}
 */
export function joinChat(row, details) {
  const extra = JSON.parse(details.extra_json);
  const light = JSON.parse(row.light_json);
  const order = JSON.parse(details.key_order_json);
  /** @type {Record<string, any>} */
  const out = {};
  const valueOf = (key) => {
    if (key in extra) return extra[key];
    if (key === 'id') return row.id;
    const column = /** @type {Record<string, string>} */ (COLUMN_FIELDS)[key];
    if (column !== undefined) return row[column];
    return light[key];
  };
  for (const key of order) out[key] = valueOf(key);
  if (!('archivedAt' in out) && row.archived_at !== '') out.archivedAt = row.archived_at;
  return out;
}

/**
 * List-row view: non-empty columns under their record names, the light fields, plus `revision`/`position`.
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function listRow(row) {
  const out = { id: row.id };
  for (const [field, column] of Object.entries(COLUMN_FIELDS)) if (row[column] !== '') out[field] = row[column];
  Object.assign(out, JSON.parse(row.light_json));
  out.lastActivityAt = row.last_activity_at;
  out.revision = Number(row.revision);
  out.position = Number(row.position);
  return out;
}

/**
 * Bucket of one chat in `chat_scope_counts`.
 *
 * @param {Record<string, any>} row anything carrying the BUCKET_COLUMNS
 * @returns {{ f: string, d: string, fk: string, dk: string, a: number, r: number }}
 */
function contribution(row) {
  return {
    f: row.workspace_file, d: row.workspace_folder, fk: row.workspace_file_key, dk: row.workspace_folder_key,
    a: row.archived_at !== '' ? 1 : 0, r: row.parent_id === '' ? 1 : 0,
  };
}

/** Accumulates bucket deltas; zero deltas are dropped. */
class Deltas {
  constructor() {
    /** @type {Map<string, any>} */
    this.map = new Map();
  }

  /** @param {ReturnType<typeof contribution>} c @param {number} sign +1 adds the chat, -1 removes it */
  add(c, sign) {
    const key = `${c.a}\u0000${c.f}\u0000${c.d}`;
    const entry = this.map.get(key) ?? { f: c.f, d: c.d, a: c.a, fk: c.fk, dk: c.dk, n: 0, r: 0 };
    entry.n += sign;
    entry.r += sign * c.r;
    this.map.set(key, entry);
  }

  /** @returns {any[]} */
  list() {
    return [...this.map.values()].filter((e) => e.n !== 0 || e.r !== 0);
  }
}

/** @param {any} ctx @param {Deltas} deltas */
function applyDeltas(ctx, deltas) {
  const list = deltas.list();
  if (list.length === 0) return;
  const json = JSON.stringify(list);
  // A negative result violates the CHECK constraints (missing bucket included), which rolls the operation back.
  ctx.prepare(`UPDATE chat_scope_counts SET count = count + d.n, root_count = root_count + d.r
    FROM (SELECT value ->> '$.f' AS f, value ->> '$.d' AS d, value ->> '$.a' AS a, value ->> '$.n' AS n, value ->> '$.r' AS r
      FROM json_each(?)) d
    WHERE chat_scope_counts.workspace_file = d.f AND chat_scope_counts.workspace_folder = d.d AND chat_scope_counts.archived = d.a`).run(json);
  ctx.prepare(`INSERT INTO chat_scope_counts (workspace_file, workspace_folder, archived, workspace_file_key, workspace_folder_key, count, root_count)
    SELECT value ->> '$.f', value ->> '$.d', value ->> '$.a', value ->> '$.fk', value ->> '$.dk', value ->> '$.n', value ->> '$.r'
    FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM chat_scope_counts c
      WHERE c.workspace_file = j.value ->> '$.f' AND c.workspace_folder = j.value ->> '$.d' AND c.archived = j.value ->> '$.a')`).run(json);
  ctx.prepare(`DELETE FROM chat_scope_counts WHERE count = 0 AND (workspace_file, workspace_folder, archived) IN
    (SELECT value ->> '$.f', value ->> '$.d', value ->> '$.a' FROM json_each(?))`).run(json);
}

/**
 * Bump the store revision and adjust the row counters in one statement.
 *
 * @param {any} ctx
 * @param {{ rows?: number, positions?: number }} [change]
 * @returns {number} the new store revision
 */
function bumpMeta(ctx, change = {}) {
  const row = ctx.prepare(`UPDATE chat_store_meta SET store_revision = store_revision + 1, row_count = row_count + ?,
    next_position = next_position + ? WHERE id = 1 RETURNING store_revision`).get(change.rows ?? 0, change.positions ?? 0);
  return Number(row.store_revision);
}

/** @param {any} ctx @returns {{ store_revision: number, row_count: number, next_position: number }} */
function readMeta(ctx) {
  return ctx.prepare('SELECT store_revision, row_count, next_position FROM chat_store_meta WHERE id = 1').get();
}

/**
 * Insert chats (new ids only) at positions `first, first+1, ...` with set-based statements.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof splitChat>[]} parts
 * @param {number} first
 * @param {Deltas} deltas
 */
function insertChats(ctx, parts, first, deltas) {
  const rows = parts.map((p, index) => ({
    id: p.id, position: first + index, ...p.cols, extra: JSON.stringify(p.extra), order: JSON.stringify(p.order),
  }));
  const json = JSON.stringify(rows);
  const taken = ctx.prepare("SELECT value ->> '$.id' AS id FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM chats c WHERE c.id = j.value ->> '$.id') LIMIT 1").get(json);
  if (taken) refuse('chat_exists', { id: taken.id });
  const select = WRITE_COLUMNS.map((c) => `value ->> '$.${c}'`).join(', ');
  ctx.prepare(`INSERT INTO chats (id, position, ${WRITE_COLUMNS.join(', ')}, revision)
    SELECT value ->> '$.id', value ->> '$.position', ${select}, 1 FROM json_each(?)`).run(json);
  ctx.prepare(`INSERT INTO chat_details (chat_id, extra_json, key_order_json)
    SELECT value ->> '$.id', value ->> '$.extra', value ->> '$.order' FROM json_each(?)`).run(json);
  for (const p of parts) deltas.add(contribution({ ...p.cols, parent_id: p.cols.parent_id }), 1);
}

/** @param {any} ctx @param {string} id */
function readRow(ctx, id) {
  return ctx.prepare('SELECT * FROM chats WHERE id = ?').get(id);
}

/** The `chats` row joined with its details row (one statement); null when the chat is missing. */
function readRowWithDetails(ctx, id) {
  return ctx.prepare('SELECT c.*, d.extra_json, d.key_order_json FROM chats c JOIN chat_details d ON d.chat_id = c.id WHERE c.id = ?').get(id);
}

/** @param {Record<string, any>} row @param {unknown} expected */
function assertCas(row, expected) {
  if (expected !== undefined && expected !== null && expected !== Number(row.revision)) {
    refuse('chat_cas', { id: row.id, currentRevision: Number(row.revision) });
  }
}

/**
 * Write the diff of one chat: only the changed columns are in the UPDATE (SQLite then maintains only the
 * indexes whose columns changed), the details only when they changed. Returns null for a no-op.
 *
 * @param {any} ctx
 * @param {Record<string, any>} row current `chats` row
 * @param {Record<string, any>} details current details row
 * @param {Record<string, any>} record the new record
 * @param {Deltas} deltas
 * @returns {{ revision: number } | null}
 */
function writeChatDiff(ctx, row, details, record, deltas) {
  const next = splitChat(record);
  const changed = WRITE_COLUMNS.filter((c) => next.cols[c] !== row[c]);
  const extraJson = JSON.stringify(next.extra);
  const orderJson = JSON.stringify(next.order);
  const detailsChanged = extraJson !== details.extra_json || orderJson !== details.key_order_json;
  if (changed.length === 0 && !detailsChanged) return null;
  const revision = Number(row.revision) + 1;
  const sets = [...changed.map((c) => `${c} = ?`), 'revision = ?'];
  const result = ctx.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .run(...changed.map((c) => next.cols[c]), revision, row.id, row.revision);
  if (Number(result.changes) !== 1) refuse('chat_cas', { id: row.id });
  if (detailsChanged) ctx.prepare('UPDATE chat_details SET extra_json = ?, key_order_json = ? WHERE chat_id = ?').run(extraJson, orderJson, row.id);
  const before = contribution(row);
  const after = contribution({ ...row, ...next.cols });
  if (before.f !== after.f || before.d !== after.d || before.fk !== after.fk || before.dk !== after.dk
    || before.a !== after.a || before.r !== after.r) {
    deltas.add(before, -1);
    deltas.add(after, 1);
  }
  return { revision };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opAdd(ctx, p) {
  assertPayloadSize(p);
  const part = splitChat(p?.chat);
  const meta = readMeta(ctx);
  const deltas = new Deltas();
  insertChats(ctx, [part], Number(meta.next_position), deltas);
  applyDeltas(ctx, deltas);
  const storeRevision = bumpMeta(ctx, { rows: 1, positions: 1 });
  return { id: part.id, revision: 1, storeRevision };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opImportBatch(ctx, p) {
  assertPayloadSize(p);
  const chats = p?.chats;
  if (!Array.isArray(chats) || chats.length === 0 || chats.length > CHATS_BATCH_MAX_ITEMS) refuse('batch_too_large', { limit: CHATS_BATCH_MAX_ITEMS });
  const parts = chats.map(splitChat);
  if (new Set(parts.map((x) => x.id)).size !== parts.length) refuse('chat_exists');
  const meta = readMeta(ctx);
  const deltas = new Deltas();
  insertChats(ctx, parts, Number(meta.next_position), deltas);
  applyDeltas(ctx, deltas);
  const storeRevision = bumpMeta(ctx, { rows: parts.length, positions: parts.length });
  return { affectedCount: parts.length, storeRevision, affectedDigest: digestIds(parts.map((x) => x.id)) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opUpdate(ctx, p) {
  assertPayloadSize(p);
  if (!isId(p?.id)) refuse('chat_invalid_record');
  const set = p.set ?? {};
  const unset = p.unset ?? [];
  if (!isPlainObject(set) || !Array.isArray(unset) || 'id' in set || unset.includes('id')) refuse('chat_invalid_record');
  const row = readRowWithDetails(ctx, p.id);
  if (!row) refuse('chat_not_found', { id: p.id });
  assertCas(row, p.expectedRevision);
  const details = row;
  const record = joinChat(row, details);
  Object.assign(record, set);
  for (const key of unset) delete record[key];
  const deltas = new Deltas();
  const written = writeChatDiff(ctx, row, details, record, deltas);
  if (!written) return { id: p.id, revision: Number(row.revision), changed: false, storeRevision: Number(readMeta(ctx).store_revision) };
  applyDeltas(ctx, deltas);
  return { id: p.id, revision: written.revision, changed: true, storeRevision: bumpMeta(ctx) };
}

/**
 * Update up to 200 distinct rows in ONE transaction. Every row is CAS-checked against its `expectedRevision`
 * (a stale or missing row refuses the whole command, which rolls back every earlier row of the same call).
 *
 * @param {any} ctx
 * @param {Record<string, any>} p `{ updates: [{ id, expectedRevision, set, unset }] }`
 */
function opUpdateMany(ctx, p) {
  assertPayloadSize(p);
  const updates = p?.updates;
  if (!Array.isArray(updates) || updates.length === 0 || updates.length > CHATS_BATCH_MAX_ITEMS) refuse('batch_too_large', { limit: CHATS_BATCH_MAX_ITEMS });
  if (!updates.every((u) => isPlainObject(u) && isId(u.id))) refuse('chat_invalid_record');
  if (new Set(updates.map((u) => u.id)).size !== updates.length) refuse('chat_invalid_record');
  const deltas = new Deltas();
  const rows = [];
  let anyChanged = false;
  for (const u of updates) {
    const set = u.set ?? {};
    const unset = u.unset ?? [];
    if (!isPlainObject(set) || !Array.isArray(unset) || 'id' in set || unset.includes('id')) refuse('chat_invalid_record');
    const row = readRowWithDetails(ctx, u.id);
    if (!row) refuse('chat_not_found', { id: u.id });
    assertCas(row, u.expectedRevision);
    const record = joinChat(row, row);
    Object.assign(record, set);
    for (const key of unset) delete record[key];
    const written = writeChatDiff(ctx, row, row, record, deltas);
    if (written) anyChanged = true;
    rows.push({ id: u.id, revision: written ? written.revision : Number(row.revision), changed: Boolean(written) });
  }
  if (!anyChanged) return { rows, storeRevision: Number(readMeta(ctx).store_revision) };
  applyDeltas(ctx, deltas);
  return { rows, storeRevision: bumpMeta(ctx) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opMarkRead(ctx, p) {
  assertPayloadSize(p);
  const marks = p?.marks;
  if (!isId(p?.id) || !isPlainObject(marks) || Object.keys(marks).length === 0
    || Object.keys(marks).some((k) => !READ_MARK_KEYS.includes(k) || typeof marks[k] !== 'string')) refuse('chat_invalid_record');
  return opUpdate(ctx, { id: p.id, expectedRevision: p.expectedRevision, set: marks });
}

const SUBTREE_CTE = `WITH RECURSIVE sub(id) AS (SELECT c.id FROM chats c WHERE c.id IN (SELECT value FROM json_each(?))
  UNION SELECT c.id FROM chats c JOIN sub ON c.parent_id = sub.id)`;

/**
 * Rows of the subtrees under `ids` (roots included), capped one above the limit to detect overflow.
 *
 * @param {any} ctx
 * @param {string[]} ids
 * @returns {Record<string, any>[]}
 */
function readSubtrees(ctx, ids) {
  const rows = ctx.prepare(`${SUBTREE_CTE} SELECT id, ${BUCKET_COLUMNS} FROM chats WHERE id IN (SELECT id FROM sub) LIMIT ?`)
    .all(JSON.stringify(ids), CHATS_MAX_SUBTREE_ROWS + 1);
  if (rows.length > CHATS_MAX_SUBTREE_ROWS) refuse('batch_too_large', { limit: CHATS_MAX_SUBTREE_ROWS });
  return rows;
}

/** @param {string[]} ids @returns {string} */
function digestIds(ids) {
  return `sha256:${createHash('sha256').update([...ids].sort().join('\n')).digest('hex')}`;
}

/** @param {any} ctx @param {Record<string, any>} p */
function opRemove(ctx, p) {
  assertPayloadSize(p);
  if (!isId(p?.id)) refuse('chat_invalid_record');
  const root = readRow(ctx, p.id);
  if (!root) refuse('chat_not_found', { id: p.id });
  assertCas(root, p.expectedRevision);
  const rows = readSubtrees(ctx, [p.id]);
  const deltas = new Deltas();
  for (const row of rows) deltas.add(contribution(row), -1);
  const json = JSON.stringify(rows.map((r) => r.id));
  ctx.prepare('DELETE FROM chat_details WHERE chat_id IN (SELECT value FROM json_each(?))').run(json);
  ctx.prepare('DELETE FROM chats WHERE id IN (SELECT value FROM json_each(?))').run(json);
  applyDeltas(ctx, deltas);
  const storeRevision = bumpMeta(ctx, { rows: -rows.length });
  return { affectedCount: rows.length, storeRevision, affectedDigest: digestIds(rows.map((r) => r.id)) };
}

/**
 * Archive the subtrees under up to 200 roots. Rows that are already archived keep their stamp.
 *
 * @param {any} ctx
 * @param {Record<string, any>} p
 */
function opArchive(ctx, p) {
  assertPayloadSize(p);
  const ids = p?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > CHATS_BATCH_MAX_ITEMS) refuse('batch_too_large', { limit: CHATS_BATCH_MAX_ITEMS });
  if (!ids.every(isId) || typeof p.archivedAt !== 'string' || p.archivedAt.trim() === '') refuse('chat_invalid_record');
  const stamp = p.archivedAt.trim();
  const rows = readSubtrees(ctx, [...new Set(ids)]);
  const live = rows.filter((r) => r.archived_at === '');
  const deltas = new Deltas();
  for (const row of live) {
    const before = contribution(row);
    deltas.add(before, -1);
    deltas.add({ ...before, a: 1 }, 1);
  }
  if (live.length > 0) {
    ctx.prepare('UPDATE chats SET archived_at = ?, revision = revision + 1 WHERE id IN (SELECT value FROM json_each(?)) AND archived_at = \'\'')
      .run(stamp, JSON.stringify(live.map((r) => r.id)));
    applyDeltas(ctx, deltas);
  }
  const storeRevision = live.length > 0 ? bumpMeta(ctx) : readMeta(ctx).store_revision;
  return { affectedCount: live.length, storeRevision: Number(storeRevision), affectedDigest: digestIds(live.map((r) => r.id)) };
}

const dedupe = (fn) => withReceipt(fn);
export const commands = Object.freeze({
  [`${COMMAND_PREFIX}add`]: dedupe(opAdd),
  [`${COMMAND_PREFIX}update`]: dedupe(opUpdate),
  [`${COMMAND_PREFIX}updateMany`]: dedupe(opUpdateMany),
  [`${COMMAND_PREFIX}remove`]: dedupe(opRemove),
  [`${COMMAND_PREFIX}archive`]: dedupe(opArchive),
  [`${COMMAND_PREFIX}markRead`]: dedupe(opMarkRead),
  [`${COMMAND_PREFIX}importBatch`]: dedupe(opImportBatch),
});

// ---------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------

/**
 * Normalised scope. `catalog` follows `matchesWorkspaceScope` (folder first, then file); `widget` follows
 * `widgetChatListScope` (raw equality, optional file/folder).
 *
 * @param {unknown} scope
 * @returns {{ kind: 'none' } | { kind: 'catalog', folder: string, file: string } | { kind: 'widget', installationId: string, pageSessionId: string, file: string, folder: string }}
 */
function normalizeScope(scope) {
  if (scope === undefined || scope === null) return { kind: 'none' };
  if (!isPlainObject(scope)) refuse('chat_scope_invalid');
  const s = /** @type {Record<string, any>} */ (scope);
  if (s.widgetInstallationId) refuse('chat_scope_unsupported');
  const folder = workspaceKeyOf(s.workspaceFolder);
  const file = workspaceKeyOf(s.workspaceFile);
  if (s.widget !== undefined && s.widget !== null) {
    const w = s.widget;
    if (folder || file || !isPlainObject(w) || typeof w.installationId !== 'string' || w.installationId === ''
      || typeof w.pageSessionId !== 'string') refuse('chat_scope_invalid');
    return {
      kind: 'widget', installationId: w.installationId, pageSessionId: w.pageSessionId,
      file: typeof w.workspaceFile === 'string' ? w.workspaceFile : '', folder: typeof w.workspaceFolder === 'string' ? w.workspaceFolder : '',
    };
  }
  if (!folder && !file) return { kind: 'none' };
  return { kind: 'catalog', folder, file };
}

/**
 * SQL for the scope on table alias `alias`; shared by the tree ancestors and the counters.
 *
 * @param {ReturnType<typeof normalizeScope>} scope
 * @param {string} alias
 * @returns {{ sql: string, args: any[] }}
 */
function scopeCondition(scope, alias) {
  const a = alias ? `${alias}.` : '';
  if (scope.kind === 'none') return { sql: '1', args: [] };
  if (scope.kind === 'widget') {
    const parts = [`${a}widget_installation_id = ?`, `${a}widget_page_session_id = ?`];
    const args = [scope.installationId, scope.pageSessionId];
    if (scope.file) { parts.push(`${a}workspace_file = ?`); args.push(scope.file); }
    if (scope.folder) { parts.push(`${a}workspace_folder = ?`); args.push(scope.folder); }
    return { sql: parts.join(' AND '), args };
  }
  if (scope.folder && scope.file) {
    return { sql: `(${a}workspace_folder_key = ? OR (${a}workspace_folder_key = '' AND ${a}workspace_file_key = ?))`, args: [scope.folder, scope.file] };
  }
  if (scope.folder) return { sql: `${a}workspace_folder_key = ?`, args: [scope.folder] };
  return { sql: `${a}workspace_file_key = ?`, args: [scope.file] };
}

/** @param {unknown} archived @returns {'live' | 'archived' | 'all' | 'tree'} */
function normalizeArchived(archived) {
  switch (archived) {
    case undefined: case 'include': case 'all': return 'all';
    case 'exclude': case 'live': return 'live';
    case 'only': case 'archived': return 'archived';
    case 'tree': return 'tree';
    default: return refuse('chat_archive_filter_invalid');
  }
}

/**
 * Index streams serving one half (live/archived) of a scope. Each stream is an index range ordered by
 * `(last_activity_at, id)` descending; a page merges them.
 *
 * @param {ReturnType<typeof normalizeScope>} scope
 * @param {'live' | 'archived'} half
 * @returns {{ index: string, where: string, args: any[], residual?: { sql: string, args: any[] } }[]}
 */
export function buildStreams(scope, half) {
  const pred = half === 'live' ? "archived_at = ''" : "archived_at <> ''";
  if (scope.kind === 'none') return [{ index: `chats_global_${half}`, where: pred, args: [] }];
  if (scope.kind === 'widget') {
    const residual = { sql: [], args: [] };
    if (scope.file) { residual.sql.push('workspace_file = ?'); residual.args.push(scope.file); }
    if (scope.folder) { residual.sql.push('workspace_folder = ?'); residual.args.push(scope.folder); }
    return [{
      index: `chats_widget_${half}`,
      where: `${pred} AND widget_installation_id <> '' AND widget_installation_id = ? AND widget_page_session_id = ?`,
      args: [scope.installationId, scope.pageSessionId],
      residual: residual.sql.length > 0 ? { sql: residual.sql.join(' AND '), args: residual.args } : undefined,
    }];
  }
  const folderStream = () => ({
    index: `chats_folder_${half}`, where: `${pred} AND workspace_folder_key <> '' AND workspace_folder_key = ?`, args: [scope.folder],
  });
  const fileStream = (folderEmpty) => ({
    index: `chats_file_${half}`,
    where: `${pred} AND workspace_file_key <> '' AND workspace_file_key = ? AND (workspace_folder_key = '') = ?`,
    args: [scope.file, folderEmpty],
  });
  if (scope.folder && scope.file) return [folderStream(), fileStream(1)];
  if (scope.folder) return [folderStream()];
  // File-only scope ignores the chat folder: both folder_empty ranges belong to it.
  return [fileStream(0), fileStream(1)];
}

/** @param {string} la @param {string} id @param {number} revision @returns {string} */
function encodeCursor(la, id, revision) {
  return Buffer.from(JSON.stringify({ l: la, i: id, r: revision }), 'utf8').toString('base64url');
}

/** @param {unknown} cursor @returns {{ la: string, id: string } | null} */
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof v?.l === 'string' && typeof v?.i === 'string') return { la: v.l, id: v.i };
  } catch { /* fall through */ }
  return refuse('chat_cursor_invalid');
}

const CURSOR_SQL = ' AND (last_activity_at, id) < (?, ?)';
const ORDER_SQL = ' ORDER BY last_activity_at DESC, id DESC';

/**
 * Run one stream for up to `take` rows after the cursor. A widget stream reads at most
 * CHATS_WIDGET_SCAN_LIMIT index rows; when that budget ends before the page is complete the call fails with
 * `scope_scan_limit` instead of returning a short page.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof buildStreams>[number]} stream
 * @param {{ la: string, id: string } | null} cursor
 * @param {number} take
 * @returns {Record<string, any>[]}
 */
function runStream(ctx, stream, cursor, take) {
  const where = stream.where + (cursor ? CURSOR_SQL : '');
  const args = [...stream.args, ...(cursor ? [cursor.la, cursor.id] : [])];
  const inner = `SELECT ${LIST_COLUMNS} FROM chats INDEXED BY ${stream.index} WHERE ${where}${ORDER_SQL}`;
  if (!stream.residual) return ctx.prepare(`${inner} LIMIT ?`).all(...args, take);
  const rows = ctx.prepare(`SELECT ${LIST_COLUMNS} FROM (${inner} LIMIT ${CHATS_WIDGET_SCAN_LIMIT}) WHERE ${stream.residual.sql} LIMIT ?`)
    .all(...args, ...stream.residual.args, take);
  if (rows.length < take) {
    const scanned = ctx.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM chats INDEXED BY ${stream.index} WHERE ${where}${ORDER_SQL} LIMIT ${CHATS_WIDGET_SCAN_LIMIT})`)
      .get(...args);
    if (Number(scanned.n) >= CHATS_WIDGET_SCAN_LIMIT) refuse('scope_scan_limit', { limit: CHATS_WIDGET_SCAN_LIMIT });
  }
  return rows;
}

/**
 * Archived ancestors of the given live rows that are inside the scope (the `archived=tree` rule).
 *
 * @param {any} ctx
 * @param {Record<string, any>[]} liveRows
 * @param {ReturnType<typeof normalizeScope>} scope
 * @returns {Record<string, any>[]}
 */
function readTreeAncestors(ctx, liveRows, scope) {
  const parents = [...new Set(liveRows.map((r) => r.parent_id).filter((id) => id !== ''))];
  const seed = scopeCondition(scope, 'c');
  const step = scopeCondition(scope, 'p');
  const rows = ctx.prepare(`WITH RECURSIVE anc(id, parent_id, depth) AS (
      SELECT c.id, c.parent_id, 1 FROM chats c WHERE c.id IN (SELECT value FROM json_each(?)) AND c.archived_at <> '' AND ${seed.sql}
      UNION SELECT p.id, p.parent_id, anc.depth + 1 FROM anc JOIN chats p ON p.id = anc.parent_id
        WHERE p.archived_at <> '' AND ${step.sql} AND anc.depth <= ${CHATS_TREE_MAX_DEPTH})
    SELECT ${LIST_COLUMNS.split(', ').map((c) => `x.${c}`).join(', ')}, anc.depth AS depth
    FROM anc JOIN chats x ON x.id = anc.id LIMIT ${CHATS_TREE_MAX_ANCESTORS + 1}`).all(JSON.stringify(parents), ...seed.args, ...step.args);
  if (rows.length > CHATS_TREE_MAX_ANCESTORS || rows.some((r) => Number(r.depth) > CHATS_TREE_MAX_DEPTH)) refuse('tree_too_deep');
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryPage(ctx, p) {
  const scope = normalizeScope(p?.scope);
  const archived = normalizeArchived(p?.archived);
  const requested = Number.isSafeInteger(p?.limit) ? p.limit : CHATS_PAGE_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), CHATS_PAGE_MAX_LIMIT);
  const cursor = decodeCursor(p?.cursor);
  const halves = archived === 'all' ? ['live', 'archived'] : archived === 'tree' ? ['live'] : [archived];
  const streams = halves.flatMap((half) => buildStreams(scope, /** @type {'live' | 'archived'} */ (half)));
  const merged = streams.flatMap((stream) => runStream(ctx, stream, cursor, limit + 1));
  merged.sort((a, b) => (a.last_activity_at === b.last_activity_at
    ? (a.id < b.id ? 1 : -1) : (a.last_activity_at < b.last_activity_at ? 1 : -1)));
  const more = merged.length > limit;
  const rows = merged.slice(0, limit);
  const storeRevision = Number(readMeta(ctx).store_revision);
  const last = rows[rows.length - 1];
  const result = {
    items: rows.map(listRow),
    nextCursor: more && last ? encodeCursor(last.last_activity_at, last.id, storeRevision) : null,
    storeRevision,
  };
  if (archived === 'tree') {
    return { ...result, ancestors: readTreeAncestors(ctx, rows, scope).map((r) => ({ ...listRow(r), ancestor: true })) };
  }
  return result;
}

/** @param {any} ctx @param {string} id */
function readChat(ctx, id) {
  const row = readRowWithDetails(ctx, id);
  if (!row) return null;
  return { chat: joinChat(row, row), revision: Number(row.revision), position: Number(row.position) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryGet(ctx, p) {
  return isId(p?.id) ? readChat(ctx, p.id) : null;
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryGetMany(ctx, p) {
  const ids = p?.ids;
  if (!Array.isArray(ids) || ids.length > CHATS_BATCH_MAX_ITEMS || !ids.every(isId)) refuse('batch_too_large', { limit: CHATS_BATCH_MAX_ITEMS });
  const json = JSON.stringify([...new Set(ids)]);
  const rows = ctx.prepare('SELECT c.*, d.extra_json, d.key_order_json FROM chats c JOIN chat_details d ON d.chat_id = c.id WHERE c.id IN (SELECT value FROM json_each(?))').all(json);
  return { chats: rows.map((r) => ({ chat: joinChat(r, r), revision: Number(r.revision), position: Number(r.position) })) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryByCursorSession(ctx, p) {
  if (!isId(p?.cursorSessionId)) return null;
  const row = ctx.prepare("SELECT id FROM chats INDEXED BY chats_by_cursor_session WHERE cursor_session_id = ? AND cursor_session_id <> '' ORDER BY id LIMIT 1").get(p.cursorSessionId);
  return row ? readChat(ctx, row.id) : null;
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryChildren(ctx, p) {
  if (!isId(p?.parentId)) refuse('chat_invalid_record');
  const limit = Math.min(Math.max(Number.isSafeInteger(p.limit) ? p.limit : CHATS_BATCH_MAX_ITEMS, 1), CHATS_BATCH_MAX_ITEMS);
  const after = typeof p.afterId === 'string' ? p.afterId : '';
  const rows = ctx.prepare(`SELECT ${LIST_COLUMNS} FROM chats INDEXED BY chats_by_parent WHERE parent_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .all(p.parentId.trim(), after, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(listRow), nextAfterId: rows.length > limit ? page[page.length - 1].id : null };
}

/** Paged pre-read of the descendants of a chat (root included): ids and todo links, keyset on id. */
function querySubtree(ctx, p) {
  if (!isId(p?.id)) refuse('chat_invalid_record');
  const limit = Math.min(Math.max(Number.isSafeInteger(p.limit) ? p.limit : CHATS_BATCH_MAX_ITEMS, 1), CHATS_BATCH_MAX_ITEMS);
  const after = typeof p.afterId === 'string' ? p.afterId : '';
  const rows = ctx.prepare(`${SUBTREE_CTE} SELECT id, todo_id FROM chats WHERE id IN (SELECT id FROM sub) AND id > ? ORDER BY id LIMIT ?`)
    .all(JSON.stringify([p.id]), after, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map((r) => ({ id: r.id, todoId: r.todo_id })), nextAfterId: rows.length > limit ? page[page.length - 1].id : null };
}

/**
 * `{ total, archived, live, roots }` from the counter table (folder/file/none scopes) or from the widget
 * index ranges (widget scope). Same figures as `ChatCatalog.counts`.
 *
 * @param {any} ctx
 * @param {Record<string, any>} p
 */
function queryCounts(ctx, p) {
  const scope = normalizeScope(p?.scope);
  const storeRevision = Number(readMeta(ctx).store_revision);
  if (scope.kind === 'widget') {
    let total = 0; let archived = 0; let roots = 0;
    for (const half of /** @type {const} */ (['live', 'archived'])) {
      for (const stream of buildStreams(scope, half)) {
        const row = ctx.prepare(`SELECT count(*) AS n, coalesce(sum(parent_id = ''), 0) AS r FROM chats INDEXED BY ${stream.index}
          WHERE ${stream.where}${stream.residual ? ` AND ${stream.residual.sql}` : ''}`).get(...stream.args, ...(stream.residual?.args ?? []));
        total += Number(row.n); roots += Number(row.r);
        if (half === 'archived') archived += Number(row.n);
      }
    }
    return { total, archived, live: total - archived, roots, storeRevision };
  }
  const cond = bucketScopeCondition(scope);
  const row = ctx.prepare(`SELECT coalesce(sum(count), 0) AS total, coalesce(sum(CASE archived WHEN 1 THEN count END), 0) AS archived,
    coalesce(sum(root_count), 0) AS roots FROM chat_scope_counts WHERE ${cond.sql}`).get(...cond.args);
  return { total: Number(row.total), archived: Number(row.archived), live: Number(row.total) - Number(row.archived), roots: Number(row.roots), storeRevision };
}

/** Scope condition over the key columns of `chat_scope_counts` (identical semantics to `scopeCondition`). */
function bucketScopeCondition(scope) {
  if (scope.kind === 'none') return { sql: '1', args: [] };
  if (scope.kind === 'widget') return refuse('chat_scope_unsupported');
  if (scope.folder && scope.file) {
    return { sql: "(workspace_folder_key = ? OR (workspace_folder_key = '' AND workspace_file_key = ?))", args: [scope.folder, scope.file] };
  }
  if (scope.folder) return { sql: 'workspace_folder_key = ?', args: [scope.folder] };
  return { sql: 'workspace_file_key = ?', args: [scope.file] };
}

/**
 * Archived-row counts keyed like `countArchivedChatsByWorkspace` (raw file, newline, raw folder). Reads the
 * counter table only; colliding legacy keys are summed over buckets. A result with more than
 * CHATS_COUNTS_MAX_BUCKETS buckets is an error, never a truncated map.
 *
 * @param {any} ctx
 * @param {Record<string, any>} p
 */
function queryArchivedCounts(ctx, p) {
  const scope = normalizeScope(p?.scope);
  const cond = bucketScopeCondition(scope);
  const rows = ctx.prepare(`SELECT workspace_file, workspace_folder, count FROM chat_scope_counts
    WHERE archived = 1 AND ${cond.sql} LIMIT ?`).all(...cond.args, CHATS_COUNTS_MAX_BUCKETS + 1);
  if (rows.length > CHATS_COUNTS_MAX_BUCKETS) refuse('counts_result_too_large', { limit: CHATS_COUNTS_MAX_BUCKETS });
  const counts = {};
  for (const r of rows) {
    const key = `${r.workspace_file}\n${r.workspace_folder}`;
    counts[key] = (counts[key] ?? 0) + Number(r.count);
  }
  return { counts, storeRevision: Number(readMeta(ctx).store_revision) };
}

/**
 * Full-table check of the counters against a reference GROUP BY over `chats` (migration verification and
 * tests; O(N), not a hot path).
 *
 * @param {any} ctx
 */
function queryVerifyCounts(ctx) {
  const reference = `SELECT workspace_file AS f, workspace_folder AS d, (archived_at <> '') AS a, workspace_file_key AS fk,
    workspace_folder_key AS dk, count(*) AS n, sum(parent_id = '') AS r FROM chats GROUP BY 1, 2, 3, 4, 5`;
  const stored = 'SELECT workspace_file AS f, workspace_folder AS d, archived AS a, workspace_file_key AS fk, workspace_folder_key AS dk, count AS n, root_count AS r FROM chat_scope_counts';
  const missing = ctx.prepare(`SELECT count(*) AS n FROM (${reference} EXCEPT ${stored})`).get();
  const extra = ctx.prepare(`SELECT count(*) AS n FROM (${stored} EXCEPT ${reference})`).get();
  const meta = readMeta(ctx);
  const rows = ctx.prepare('SELECT count(*) AS n FROM chats').get();
  const buckets = ctx.prepare('SELECT count(*) AS n FROM chat_scope_counts').get();
  const ok = Number(missing.n) === 0 && Number(extra.n) === 0 && Number(rows.n) === Number(meta.row_count);
  return { ok, rowCount: Number(rows.n), metaRowCount: Number(meta.row_count), buckets: Number(buckets.n), mismatches: Number(missing.n) + Number(extra.n) };
}

/** The store file must be bound to exactly the generation the backend marker selected. */
function queryVerifyDataset(ctx, p) {
  if (!p || typeof p.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(p.datasetGeneration)) refuse('chat_dataset_invalid');
  const row = ctx.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  if (!row) refuse('chat_store_unbound');
  if (row.dataset_generation !== p.datasetGeneration) refuse('chat_generation_mismatch', { bound: row.dataset_generation });
  return { datasetGeneration: row.dataset_generation };
}

export const queries = Object.freeze({
  ...RECEIPT_QUERIES,
  [`${COMMAND_PREFIX}page`]: queryPage,
  [`${COMMAND_PREFIX}get`]: queryGet,
  [`${COMMAND_PREFIX}getMany`]: queryGetMany,
  [`${COMMAND_PREFIX}byCursorSession`]: queryByCursorSession,
  [`${COMMAND_PREFIX}children`]: queryChildren,
  [`${COMMAND_PREFIX}subtree`]: querySubtree,
  [`${COMMAND_PREFIX}counts`]: queryCounts,
  [`${COMMAND_PREFIX}archivedCountsByWorkspace`]: queryArchivedCounts,
  [`${COMMAND_PREFIX}verifyCounts`]: queryVerifyCounts,
  [`${COMMAND_PREFIX}verifyDataset`]: queryVerifyDataset,
});

/**
 * Bare handler bodies (no receipt wrapper) for tests, migration tools and offline verification: they run
 * on any `{ prepare }` context, so the row encoding is identical to the live store.
 */
export const offlineHandlers = Object.freeze({
  add: opAdd,
  update: opUpdate,
  updateMany: opUpdateMany,
  remove: opRemove,
  archive: opArchive,
  markRead: opMarkRead,
  importBatch: opImportBatch,
  page: queryPage,
  get: queryGet,
  getMany: queryGetMany,
  byCursorSession: queryByCursorSession,
  children: queryChildren,
  subtree: querySubtree,
  counts: queryCounts,
  archivedCountsByWorkspace: queryArchivedCounts,
  verifyCounts: queryVerifyCounts,
});

/**
 * Promise facade over a started storage worker host (the host must open `chats.sqlite`). Every mutation needs
 * a caller-owned `commandId` kept across retries; after `unknown_commit` call `resolveUnknown` with the same
 * arguments before any retry.
 *
 * @param {{ host: any, datasetGeneration: string, groupCommitter?: any, writeGate?: unknown }} options
 */
export function createChatsStore({ host, datasetGeneration, groupCommitter, writeGate } = /** @type {any} */ ({})) {
  if (!host || typeof host.query !== 'function') throw new TypeError('Chats store needs a worker host');
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) {
    throw new TypeError('Chats store needs a dataset generation');
  }
  const gate = writeGate ?? host.writeGate;
  const write = (operation, args) => {
    const { commandId, priority, deadlineMs, signal, error, ...payload } = args;
    assertWriteAllowed(gate);
    const request = { datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, priority, deadlineMs, signal, error, writeGate: gate };
    return groupCommitter ? groupCommitter.submit(request) : executeCommand(host, request);
  };
  const read = (name, args) => host.query(COMMAND_PREFIX + name, args ?? {});
  return Object.freeze({
    add: (args) => write('add', args),
    update: (args) => write('update', args),
    updateMany: (args) => write('updateMany', args),
    remove: (args) => write('remove', args),
    archive: (args) => write('archive', args),
    markRead: (args) => write('markRead', args),
    importBatch: (args) => write('importBatch', args),
    page: (args) => read('page', args),
    get: (args) => read('get', args),
    getMany: (args) => read('getMany', args),
    byCursorSession: (args) => read('byCursorSession', args),
    children: (args) => read('children', args),
    subtree: (args) => read('subtree', args),
    counts: (args) => read('counts', args),
    archivedCountsByWorkspace: (args) => read('archivedCountsByWorkspace', args),
    verifyCounts: (args) => read('verifyCounts', args),
    verifyDataset: (args) => read('verifyDataset', args),
    resolveUnknown: (args) => {
      const { commandId, priority, deadlineMs, signal, error, operation, ...payload } = args;
      return resolveUnknown(host, { datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, error });
    },
  });
}
