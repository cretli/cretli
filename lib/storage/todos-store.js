/**
 * Todos domain of the storage worker (ADR docs/storage-todos-worker-decision.md, sections 2, 3 and 5).
 *
 * Doubles as the worker handler registry (`commands`, `queries`) and, on the main thread, as
 * the Promise facade `createTodosStore`. The schema is `lib/storage/schema/0007-todos.js`.
 *
 * - Items are opaque JSON objects to this module except for the indexed fields
 *   (`id`, `title`, `status`, `parentId`, `siblingIndex`, `updatedAt`) and the lazily fetched
 *   heavy fields (`body`, `plan`, `changelog`, `review`). All other fields, unknown ones
 *   included, survive in `extra_json`; the original key order is kept per item.
 * - Mutations are receipt-wrapped commands (lib/storage/command-receipts.js): at most one
 *   application per `(datasetGeneration, commandId)`, same transaction as the receipt.
 * - CAS: `expectedUpdatedAt` is compared with the stored row inside the transaction; a
 *   mismatch throws before any write, so the transaction rolls back untouched.
 * - `todos.move` (source, target, indexes and receipt) and `todos.batch` (at most
 *   MAX_BATCH_MEMBERS operations) are single transactions: any failure changes nothing.
 * - `todos.list` returns indexed fields plus a bounded body preview only.
 * - The handlers never stamp time: callers pass `updatedAt` inside `set`, so a replay of the
 *   same command carries the same digest.
 */
import { StorageError } from './errors.js';
import { DATASET_GENERATION_PATTERN, executeCommand, RECEIPT_QUERIES, resolveUnknown, withReceipt } from './command-receipts.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';
import { MAX_BATCH_MEMBERS } from './worker-host.js';

const COMMAND_PREFIX = 'todos.';
/** Longest `bodyPreview` returned by list reads, in UTF-16 code units. */
export const TODOS_BODY_PREVIEW_MAX = 200;
/** Page size cap of `todos.list`. */
export const TODOS_LIST_PAGE_MAX = 500;
/** Operations per `todos.batch` transaction. */
export const TODOS_BATCH_MAX_OPS = MAX_BATCH_MEMBERS;
/** Item fields stored in columns and returned by list reads. */
const LIGHT_KEYS = Object.freeze(['id', 'title', 'status', 'parentId', 'siblingIndex', 'updatedAt']);
/** Item fields stored as JSON text and fetched by detail/export reads only. */
const HEAVY_KEYS = Object.freeze({ body: 'body_json', plan: 'plan_json', changelog: 'changelog_json', review: 'review_json' });
const FORBIDDEN_KEYS = new Set(['__proto__']);

/** Test-only seam: runs inside `todos.move` after the source rows were rewritten. */
let midMoveHook = null;
/** @param {(() => void) | null} hook */
export function setMidMoveHookForTests(hook) {
  midMoveHook = hook;
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(kind, details = {}) {
  throw new StorageError('conflict', 'Todos command refused', {
    details: { operation: 'todos', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {unknown} v @returns {boolean} */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v @returns {boolean} */
function isKey(v) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= 512;
}

/**
 * Split an item into column values, heavy JSON text and the extra remainder.
 * An indexed field of an unexpected type stays in `extra` so nothing is coerced.
 *
 * @param {Record<string, any>} item
 * @returns {Record<string, any>}
 */
function toRow(item) {
  if (!isPlainObject(item) || !isKey(item.id)) refuse('todo_invalid_item');
  const keys = Object.keys(item);
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) refuse('todo_invalid_item');
  const extra = {};
  const row = {
    id: item.id, parent_id: '', status: '', sibling_index: null, updated_at: '', title: '', body_preview: '',
    body_json: null, plan_json: null, changelog_json: null, review_json: null,
  };
  for (const key of keys) {
    const value = item[key];
    if (value === undefined) continue;
    if (key === 'id') continue;
    if (key === 'title' && typeof value === 'string') row.title = value;
    else if (key === 'status' && typeof value === 'string') row.status = value;
    else if (key === 'parentId' && typeof value === 'string') row.parent_id = value;
    else if (key === 'updatedAt' && typeof value === 'string') row.updated_at = value;
    else if (key === 'siblingIndex' && Number.isSafeInteger(value)) row.sibling_index = value;
    else if (key in HEAVY_KEYS) {
      row[HEAVY_KEYS[key]] = JSON.stringify(value);
      if (key === 'body' && typeof value === 'string') row.body_preview = value.slice(0, TODOS_BODY_PREVIEW_MAX);
    } else extra[key] = value;
  }
  row.extra_json = JSON.stringify(extra);
  row.key_order_json = JSON.stringify(keys.filter((k) => item[k] !== undefined));
  return row;
}

/**
 * @param {Record<string, any>} row
 * @param {boolean} heavy include heavy fields
 * @returns {Record<string, any>}
 */
function fromRow(row, heavy) {
  const extra = JSON.parse(row.extra_json);
  const out = {};
  for (const key of JSON.parse(row.key_order_json)) {
    if (key === 'id') out.id = row.id;
    else if (key === 'title' && !(key in extra)) out.title = row.title;
    else if (key === 'status' && !(key in extra)) out.status = row.status;
    else if (key === 'parentId' && !(key in extra)) out.parentId = row.parent_id;
    else if (key === 'updatedAt' && !(key in extra)) out.updatedAt = row.updated_at;
    else if (key === 'siblingIndex' && !(key in extra)) out.siblingIndex = Number(row.sibling_index);
    else if (key in HEAVY_KEYS) {
      if (heavy && row[HEAVY_KEYS[key]] !== null) out[key] = JSON.parse(row[HEAVY_KEYS[key]]);
    } else if (key in extra) out[key] = extra[key];
  }
  return out;
}

const UPSERT_ROW_SQL = `INSERT INTO todos (workspace_key, id, position, parent_id, status, sibling_index, updated_at, title, body_preview,
  body_json, plan_json, changelog_json, review_json, extra_json, key_order_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (workspace_key, id) DO UPDATE SET position = excluded.position, parent_id = excluded.parent_id, status = excluded.status,
  sibling_index = excluded.sibling_index, updated_at = excluded.updated_at, title = excluded.title, body_preview = excluded.body_preview,
  body_json = excluded.body_json, plan_json = excluded.plan_json, changelog_json = excluded.changelog_json,
  review_json = excluded.review_json, extra_json = excluded.extra_json, key_order_json = excluded.key_order_json`;

/**
 * @param {any} ctx
 * @param {string} workspaceKey
 * @param {number} position
 * @param {Record<string, any>} item
 */
function writeRow(ctx, workspaceKey, position, item) {
  const r = toRow(item);
  ctx.prepare(UPSERT_ROW_SQL).run(workspaceKey, r.id, position, r.parent_id, r.status, r.sibling_index, r.updated_at, r.title,
    r.body_preview, r.body_json, r.plan_json, r.changelog_json, r.review_json, r.extra_json, r.key_order_json);
}

/** @param {any} ctx @param {string} workspaceKey @param {string} id */
function readRow(ctx, workspaceKey, id) {
  return ctx.prepare('SELECT * FROM todos WHERE workspace_key = ? AND id = ?').get(workspaceKey, id);
}

/** @param {any} ctx @param {string} workspaceKey */
function ensureDoc(ctx, workspaceKey) {
  if (!isKey(workspaceKey)) refuse('todo_invalid_workspace');
  ctx.prepare("INSERT OR IGNORE INTO todo_docs (workspace_key, doc_version) VALUES (?, 1)").run(workspaceKey);
}

/** @param {any} ctx @param {string} workspaceKey */
function nextPosition(ctx, workspaceKey) {
  const row = ctx.prepare('SELECT max(position) AS p FROM todos WHERE workspace_key = ?').get(workspaceKey);
  return row.p === null ? 0 : Number(row.p) + 1;
}

/**
 * CAS gate: a present `expectedUpdatedAt` must equal the stored `updated_at`.
 * Runs before any write of the operation.
 *
 * @param {Record<string, any>} row
 * @param {unknown} expected
 */
function assertCas(row, expected) {
  if (typeof expected === 'string' && expected !== '' && expected !== row.updated_at) {
    refuse('todo_cas', { currentUpdatedAt: row.updated_at, id: row.id });
  }
}

/** @param {Record<string, any>} item @returns {Record<string, any>} */
function lightItem(item) {
  const out = {};
  for (const key of LIGHT_KEYS) if (key in item) out[key] = item[key];
  return out;
}

/**
 * Full item without heavy fields plus the bounded preview (what list and mutation results carry).
 *
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function summary(row) {
  return { ...lightItem(fromRow(row, false)), bodyPreview: row.body_preview, position: Number(row.position) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opAdd(ctx, p) {
  ensureDoc(ctx, p.workspaceKey);
  if (!isPlainObject(p.item) || !isKey(p.item.id)) refuse('todo_invalid_item');
  if (readRow(ctx, p.workspaceKey, p.item.id)) refuse('todo_exists', { id: p.item.id });
  writeRow(ctx, p.workspaceKey, nextPosition(ctx, p.workspaceKey), p.item);
  return { id: p.item.id, updatedAt: p.item.updatedAt ?? '' };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opUpdate(ctx, p) {
  if (!isKey(p.workspaceKey) || !isKey(p.id)) refuse('todo_invalid_item');
  const row = readRow(ctx, p.workspaceKey, p.id);
  if (!row) refuse('todo_not_found', { id: p.id });
  assertCas(row, p.expectedUpdatedAt);
  const set = p.set ?? {};
  const unset = p.unset ?? [];
  if (!isPlainObject(set) || !Array.isArray(unset) || 'id' in set || unset.includes('id')) refuse('todo_invalid_item');
  const item = fromRow(row, true);
  Object.assign(item, set);
  for (const key of unset) delete item[key];
  writeRow(ctx, p.workspaceKey, Number(row.position), item);
  return { id: p.id, updatedAt: item.updatedAt ?? '' };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opDelete(ctx, p) {
  if (!isKey(p.workspaceKey) || !isKey(p.id)) refuse('todo_invalid_item');
  const row = readRow(ctx, p.workspaceKey, p.id);
  if (!row) refuse('todo_not_found', { id: p.id });
  assertCas(row, p.expectedUpdatedAt);
  ctx.prepare('DELETE FROM todos WHERE workspace_key = ? AND id = ?').run(p.workspaceKey, p.id);
  return { id: p.id };
}

/**
 * Move the item and its descendants (parent links inside the source) to another workspace
 * in one transaction. The moved root gets `set` applied (typically `parentId`, `siblingIndex`).
 *
 * @param {any} ctx
 * @param {Record<string, any>} p
 */
function opMove(ctx, p) {
  const { sourceWorkspaceKey: from, targetWorkspaceKey: to, id } = p;
  if (!isKey(from) || !isKey(to) || !isKey(id) || from === to) refuse('todo_invalid_move');
  // Identity is immutable (as in opUpdate): renaming the root would leave descendants with a dangling parentId.
  if (p.set !== undefined && (!isPlainObject(p.set) || 'id' in p.set)) refuse('todo_invalid_move');
  const root = readRow(ctx, from, id);
  if (!root) refuse('todo_not_found', { id });
  assertCas(root, p.expectedUpdatedAt);
  const subtree = ctx.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM todos WHERE workspace_key = ? AND id = ?
      UNION SELECT t.id FROM todos t JOIN sub ON t.parent_id = sub.id WHERE t.workspace_key = ?)
    SELECT t.* FROM todos t JOIN sub ON t.id = sub.id WHERE t.workspace_key = ? ORDER BY t.position, t.id`).all(from, id, from, from);
  for (const row of subtree) if (readRow(ctx, to, row.id)) refuse('todo_exists', { id: row.id });
  ensureDoc(ctx, to);
  let position = nextPosition(ctx, to);
  for (const row of subtree) {
    const item = fromRow(row, true);
    if (row.id === id) Object.assign(item, p.set ?? {});
    writeRow(ctx, to, position, item);
    position += 1;
    ctx.prepare('DELETE FROM todos WHERE workspace_key = ? AND id = ?').run(from, row.id);
    if (row.id === id) midMoveHook?.();
  }
  return { id, moved: subtree.map((r) => r.id) };
}

/**
 * Document-level metadata of one workspace (`updatedAt`, format `version`, idempotency map). The
 * SQLite backend appends one of these to every command, so `updatedAt` is a revision token that
 * moves on every committed change. `expectedDocUpdatedAt` is the document-level CAS.
 *
 * @param {any} ctx
 * @param {Record<string, any>} p
 */
function opDocMeta(ctx, p) {
  ensureDoc(ctx, p.workspaceKey);
  const doc = ctx.prepare('SELECT * FROM todo_docs WHERE workspace_key = ?').get(p.workspaceKey);
  if (typeof p.expectedDocUpdatedAt === 'string' && p.expectedDocUpdatedAt !== doc.updated_at) {
    refuse('todo_doc_cas', { currentUpdatedAt: doc.updated_at });
  }
  const meta = p.meta ?? {};
  if (!isPlainObject(meta)) refuse('todo_invalid_document');
  // An imported document remembers which top-level keys it had; a key written later joins that list.
  const extra = JSON.parse(doc.extra_json);
  if (Array.isArray(extra.__docKeyOrder)) {
    const added = ['version', 'updatedAt', 'idempotency'].filter((k) => meta[k] !== undefined && !extra.__docKeyOrder.includes(k));
    if (added.length > 0) {
      extra.__docKeyOrder.push(...added);
      ctx.prepare('UPDATE todo_docs SET extra_json = ? WHERE workspace_key = ?').run(JSON.stringify(extra), p.workspaceKey);
    }
  }
  ctx.prepare('UPDATE todo_docs SET doc_version = ?, updated_at = ?, idempotency_json = ? WHERE workspace_key = ?').run(
    Number.isSafeInteger(meta.version) ? meta.version : Number(doc.doc_version),
    typeof meta.updatedAt === 'string' ? meta.updatedAt : doc.updated_at,
    meta.idempotency === undefined ? doc.idempotency_json : JSON.stringify(meta.idempotency),
    p.workspaceKey,
  );
  return { workspaceKey: p.workspaceKey };
}

const OPS = Object.freeze({ add: opAdd, update: opUpdate, delete: opDelete, move: opMove, docMeta: opDocMeta });

/** @param {any} ctx @param {Record<string, any>} p */
function opBatch(ctx, p) {
  const ops = p.ops;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > TODOS_BATCH_MAX_OPS) refuse('todo_batch_size');
  // Any throw rolls the whole worker transaction back: the batch is all-or-nothing.
  return { results: ops.map((op) => {
    const fn = isPlainObject(op) ? OPS[op.op] : undefined;
    if (!fn) refuse('todo_invalid_op');
    return fn(ctx, op);
  }) };
}

/** Replace a whole workspace document (migration import, tests). */
function opImport(ctx, p) {
  const doc = p.doc;
  if (!isKey(p.workspaceKey) || !isPlainObject(doc) || !Array.isArray(doc.items)) refuse('todo_invalid_document');
  const { version, updatedAt, items, idempotency, ...rest } = doc;
  if (typeof p.expectedDocUpdatedAt === 'string') {
    const current = ctx.prepare('SELECT updated_at FROM todo_docs WHERE workspace_key = ?').get(p.workspaceKey);
    if (p.expectedDocUpdatedAt !== (current ? current.updated_at : '')) refuse('todo_doc_cas', { currentUpdatedAt: current ? current.updated_at : '' });
  }
  ctx.prepare('DELETE FROM todos WHERE workspace_key = ?').run(p.workspaceKey);
  ctx.prepare('DELETE FROM todo_docs WHERE workspace_key = ?').run(p.workspaceKey);
  ctx.prepare('INSERT INTO todo_docs (workspace_key, doc_version, updated_at, idempotency_json, extra_json) VALUES (?, ?, ?, ?, ?)')
    .run(p.workspaceKey, Number.isSafeInteger(version) ? version : 1, typeof updatedAt === 'string' ? updatedAt : '',
      JSON.stringify(idempotency ?? {}), JSON.stringify({ ...rest, __docKeyOrder: Object.keys(doc) }));
  items.forEach((item, index) => {
    if (readRow(ctx, p.workspaceKey, item?.id)) refuse('todo_exists', { id: item.id });
    writeRow(ctx, p.workspaceKey, index, item);
  });
  return { count: items.length };
}

const dedupe = (fn) => withReceipt(fn);
export const commands = Object.freeze({
  [`${COMMAND_PREFIX}add`]: dedupe(opAdd),
  [`${COMMAND_PREFIX}update`]: dedupe(opUpdate),
  [`${COMMAND_PREFIX}delete`]: dedupe(opDelete),
  [`${COMMAND_PREFIX}move`]: dedupe(opMove),
  [`${COMMAND_PREFIX}batch`]: dedupe(opBatch),
  [`${COMMAND_PREFIX}importDocument`]: dedupe(opImport),
  [`${COMMAND_PREFIX}docMeta`]: dedupe(opDocMeta),
});

/** @param {any} ctx @param {Record<string, any>} p */
function queryList(ctx, p) {
  if (!isKey(p?.workspaceKey)) refuse('todo_invalid_workspace');
  const limit = Math.min(Number.isSafeInteger(p.limit) && p.limit > 0 ? p.limit : TODOS_LIST_PAGE_MAX, TODOS_LIST_PAGE_MAX);
  const after = Number.isSafeInteger(p.afterPosition) ? p.afterPosition : -1;
  const where = ['workspace_key = ?', 'position > ?'];
  const args = [p.workspaceKey, after];
  if (typeof p.status === 'string') { where.push('status = ?'); args.push(p.status); }
  if (typeof p.parentId === 'string') { where.push('parent_id = ?'); args.push(p.parentId); }
  const rows = ctx.prepare(`SELECT workspace_key, id, position, parent_id, status, sibling_index, updated_at, title, body_preview,
      extra_json, key_order_json FROM todos WHERE ${where.join(' AND ')} ORDER BY position, id LIMIT ?`).all(...args, limit + 1);
  const doc = ctx.prepare('SELECT doc_version, updated_at FROM todo_docs WHERE workspace_key = ?').get(p.workspaceKey);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => summary(r));
  return {
    docVersion: doc ? Number(doc.doc_version) : null,
    docUpdatedAt: doc ? doc.updated_at : null,
    items: page,
    nextAfterPosition: more ? page[page.length - 1].position : null,
  };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryGet(ctx, p) {
  const row = isKey(p?.workspaceKey) && isKey(p?.id) ? readRow(ctx, p.workspaceKey, p.id) : undefined;
  return row ? { item: fromRow(row, true) } : null;
}

/** Logical export of one workspace document: item order, unknown fields and key order preserved. */
function queryExport(ctx, p) {
  if (!isKey(p?.workspaceKey)) refuse('todo_invalid_workspace');
  const doc = ctx.prepare('SELECT * FROM todo_docs WHERE workspace_key = ?').get(p.workspaceKey);
  if (!doc) return null;
  const { __docKeyOrder: order, ...rest } = JSON.parse(doc.extra_json);
  const items = ctx.prepare('SELECT * FROM todos WHERE workspace_key = ? ORDER BY position, id').all(p.workspaceKey)
    .map((r) => fromRow(r, true));
  const known = { version: Number(doc.doc_version), updatedAt: doc.updated_at, items, idempotency: JSON.parse(doc.idempotency_json), ...rest };
  if (!Array.isArray(order)) return known;
  // The imported document's own key set is authoritative: a key it never had (e.g. `idempotency` in an old
  // format) is not invented on export. Items are always present.
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of order) if (key in known) out[key] = known[key];
  if (!('items' in out)) out.items = /** @type {any} */ (known).items;
  for (const key of Object.keys(rest)) if (!(key in out)) out[key] = known[key];
  return out;
}

/** Tree invariants of one workspace: dangling parents, self parents and cycles. */
function queryVerify(ctx, p) {
  if (!isKey(p?.workspaceKey)) refuse('todo_invalid_workspace');
  const rows = ctx.prepare("SELECT id, parent_id FROM todos WHERE workspace_key = ?").all(p.workspaceKey);
  const parents = new Map(rows.map((r) => [r.id, r.parent_id]));
  const dangling = [];
  const cyclic = [];
  for (const [id, parent] of parents) {
    if (parent !== '' && !parents.has(parent)) dangling.push(id);
    const seen = new Set([id]);
    for (let cur = parent; cur !== '' && parents.has(cur); cur = parents.get(cur)) {
      if (seen.has(cur)) { cyclic.push(id); break; }
      seen.add(cur);
    }
  }
  return { count: rows.length, dangling, cyclic };
}

/** Cheap revision token of one workspace document (no item is read). */
function queryRevision(ctx, p) {
  if (!isKey(p?.workspaceKey)) refuse('todo_invalid_workspace');
  const doc = ctx.prepare('SELECT doc_version, updated_at FROM todo_docs WHERE workspace_key = ?').get(p.workspaceKey);
  if (!doc) return null;
  const n = ctx.prepare('SELECT count(*) AS n FROM todos WHERE workspace_key = ?').get(p.workspaceKey);
  return { docVersion: Number(doc.doc_version), docUpdatedAt: doc.updated_at, count: Number(n.n) };
}

/** Every workspace key with its item count (migration verification, operator tools). */
function queryWorkspaces(ctx) {
  return {
    workspaces: ctx.prepare(`SELECT d.workspace_key AS workspaceKey, count(t.id) AS count FROM todo_docs d
      LEFT JOIN todos t ON t.workspace_key = d.workspace_key GROUP BY d.workspace_key ORDER BY d.workspace_key`).all()
      .map((r) => ({ workspaceKey: r.workspaceKey, count: Number(r.count) })),
  };
}

/** The store file must be bound to exactly the generation the backend marker selected. */
function queryVerifyDataset(ctx, p) {
  if (!p || typeof p.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(p.datasetGeneration)) refuse('todo_dataset_invalid');
  const row = ctx.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  if (!row) refuse('todo_store_unbound');
  if (row.dataset_generation !== p.datasetGeneration) refuse('todo_generation_mismatch', { bound: row.dataset_generation });
  return { datasetGeneration: row.dataset_generation };
}

export const queries = Object.freeze({
  ...RECEIPT_QUERIES,
  [`${COMMAND_PREFIX}revision`]: queryRevision,
  [`${COMMAND_PREFIX}workspaces`]: queryWorkspaces,
  [`${COMMAND_PREFIX}verifyDataset`]: queryVerifyDataset,
  [`${COMMAND_PREFIX}list`]: queryList,
  [`${COMMAND_PREFIX}get`]: queryGet,
  [`${COMMAND_PREFIX}exportDocument`]: queryExport,
  [`${COMMAND_PREFIX}verify`]: queryVerify,
});

/**
 * Promise facade over a started storage worker host. Every mutation needs a caller-owned
 * `commandId` kept across retries; after `unknown_commit` call `resolveUnknown` with the
 * same arguments before any retry (the host never retries a write by itself).
 *
 * @param {{ host: any, datasetGeneration: string, groupCommitter?: any, writeGate?: unknown }} options
 */
export function createTodosStore({ host, datasetGeneration, groupCommitter, writeGate } = /** @type {any} */ ({})) {
  if (!host || typeof host.query !== 'function') throw new TypeError('Todos store needs a worker host');
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) {
    throw new TypeError('Todos store needs a dataset generation');
  }
  const gate = writeGate ?? host.writeGate;
  const write = (operation, args) => {
    const { commandId, priority, deadlineMs, signal, error, ...payload } = args;
    assertWriteAllowed(gate);
    const request = { datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, priority, deadlineMs, signal, error, writeGate: gate };
    return groupCommitter ? groupCommitter.submit(request) : executeCommand(host, request);
  };
  const read = (name, args) => host.query(COMMAND_PREFIX + name, args);
  return Object.freeze({
    addTodo: (args) => write('add', args),
    updateTodo: (args) => write('update', args),
    deleteTodo: (args) => write('delete', args),
    moveTodo: (args) => write('move', args),
    batch: (args) => write('batch', args),
    importDocument: (args) => write('importDocument', args),
    listTodos: (args) => read('list', args),
    getTodo: (args) => read('get', args),
    exportDocument: (args) => read('exportDocument', args),
    verify: (args) => read('verify', args),
    revision: (args) => read('revision', args),
    workspaces: (args) => read('workspaces', args ?? {}),
    verifyDataset: (args) => read('verifyDataset', args),
    docMeta: (args) => write('docMeta', args),
    resolveUnknown: (args) => {
      const { commandId, priority, deadlineMs, signal, error, operation, ...payload } = args;
      return resolveUnknown(host, { datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, error });
    },
  });
}

/**
 * Handlers callable with a plain `{ prepare }` context (offline migration and rollback tools run them
 * on their own connection, outside the worker, so the row encoding is identical to the live store).
 */
export const offlineHandlers = Object.freeze({
  importDocument: opImport,
  exportDocument: queryExport,
  workspaces: queryWorkspaces,
  verify: queryVerify,
});
