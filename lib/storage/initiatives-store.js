/**
 * Initiatives domain of the storage worker (docs/development-plans.md). Schema:
 * `lib/storage/schema/0010-initiatives.js`.
 *
 * Doubles as the worker handler registry (`commands`, `queries`) and, on the main thread, as the Promise facade
 * `createInitiativesStore`. One command is one transaction: the change, its journal event and the revision bumps
 * commit together, inside a receipt (lib/storage/command-receipts.js). Handlers never stamp time or mint ids:
 * callers pass `now` and ids in the payload. Every row is keyed by the workspace UUID.
 */
import { StorageError } from './errors.js';
import { DATASET_GENERATION_PATTERN, executeCommand, RECEIPT_QUERIES, resolveUnknown, withReceipt } from './command-receipts.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';
import {
  ACYCLIC_RELATION_TYPES, DEFAULT_PAGE_LIMIT, GRAPH_MAX_EDGES, GRAPH_MAX_NODES, LINK_KINDS, MAX_PAGE_LIMIT, RELATION_TYPES,
  RESEARCH_KINDS,
} from '../initiatives/constants.js';

const PREFIX = 'initiatives.';

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function refuse(kind, details = {}) {
  throw new StorageError('conflict', 'Initiatives command refused', {
    details: { operation: 'initiatives', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {unknown} v */
const isKey = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 512;
/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @param {any} ctx @param {string} ws @returns {number} the new workspace revision */
function bump(ctx, ws) {
  ctx.prepare('UPDATE initiative_meta SET revision = revision + 1 WHERE id = 1').run();
  ctx.prepare('INSERT INTO initiative_workspace_meta (workspace_uuid, revision) VALUES (?, 1) ON CONFLICT(workspace_uuid) DO UPDATE SET revision = revision + 1').run(ws);
  return wsRevision(ctx, ws);
}

/** @param {any} ctx @param {string} ws */
function wsRevision(ctx, ws) {
  const row = ctx.prepare('SELECT revision FROM initiative_workspace_meta WHERE workspace_uuid = ?').get(ws);
  return row ? Number(row.revision) : 0;
}

/** @param {any} ctx @param {string} ws @param {string} id @param {string} type @param {string} actor @param {number} revision @param {string} at @param {unknown} payload */
function journal(ctx, ws, id, type, actor, revision, at, payload) {
  ctx.prepare('INSERT INTO initiative_events (workspace_uuid, initiative_id, type, actor, revision, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ws, id, type, actor, revision, at, JSON.stringify(payload ?? {}));
}

/** @param {any} ctx @param {string} ws @param {string} id */
function loadDoc(ctx, ws, id) {
  const row = ctx.prepare('SELECT doc_json FROM initiatives WHERE id = ? AND workspace_uuid = ?').get(id, ws);
  return row ? JSON.parse(row.doc_json) : null;
}

/** @param {any} ctx @param {Record<string, any>} doc */
function saveDoc(ctx, doc) {
  ctx.prepare('UPDATE initiatives SET status = ?, horizon = ?, revision = ?, archived_at = ?, doc_json = ? WHERE id = ?')
    .run(doc.status, doc.horizon, doc.revision, doc.archivedAt || '', JSON.stringify(doc), doc.id);
}

/** @param {any} ctx @param {Record<string, any>} p */
function requireScope(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.actor) || !isKey(p?.now)) refuse('initiative_invalid_scope');
  return /** @type {string} */ (p.workspaceUuid);
}

/** @param {any} ctx @param {string} ws @param {string} id */
function mustExist(ctx, ws, id) {
  const doc = isKey(id) ? loadDoc(ctx, ws, id) : null;
  if (!doc) refuse('initiative_not_found', { id });
  return doc;
}

/** Bumps the initiative revision after a non-field change (relation/link/research) so readers see movement. */
function touch(ctx, doc, now) {
  const next = { ...doc, revision: doc.revision + 1, updatedAt: now };
  saveDoc(ctx, next);
  return next;
}

/** @param {any} ctx @param {Record<string, any>} p */
function opCreate(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!isKey(p.id) || !isKey(p.idempotencyKey) || !isKey(p.digest) || !isObj(p.fields)) refuse('initiative_invalid_create');
  const key = ctx.prepare('SELECT digest, initiative_id FROM initiative_create_keys WHERE workspace_uuid = ? AND idempotency_key = ?').get(ws, p.idempotencyKey);
  if (key) {
    if (key.digest !== p.digest) refuse('initiative_idempotency_mismatch');
    return { row: loadDoc(ctx, ws, key.initiative_id), created: false, revision: wsRevision(ctx, ws) };
  }
  const seq = Number(ctx.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM initiatives').get().n);
  const doc = {
    ...p.fields, id: p.id, workspaceUuid: ws, revision: 1, createdAt: p.now, updatedAt: p.now, archivedAt: '', createdBy: p.actor,
  };
  ctx.prepare('INSERT INTO initiatives (id, workspace_uuid, seq, status, horizon, revision, archived_at, doc_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
    .run(doc.id, ws, seq, doc.status, doc.horizon, '', JSON.stringify(doc));
  ctx.prepare('INSERT INTO initiative_create_keys (workspace_uuid, idempotency_key, digest, initiative_id) VALUES (?, ?, ?, ?)').run(ws, p.idempotencyKey, p.digest, doc.id);
  const revision = bump(ctx, ws);
  journal(ctx, ws, doc.id, 'created', p.actor, 1, p.now, { fields: p.fields });
  return { row: doc, created: true, revision };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opUpdate(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!Number.isSafeInteger(p.expectedRevision) || !isObj(p.patch) || Object.keys(p.patch).length === 0) refuse('initiative_invalid_update');
  const doc = mustExist(ctx, ws, p.id);
  if (doc.revision !== p.expectedRevision) return { row: null, conflict: 'revision', current: doc, revision: wsRevision(ctx, ws) };
  if (doc.archivedAt) return { row: null, conflict: 'archived', current: doc, revision: wsRevision(ctx, ws) };
  const changed = {};
  for (const [k, v] of Object.entries(p.patch)) {
    if (JSON.stringify(doc[k]) !== JSON.stringify(v)) changed[k] = { from: doc[k] ?? null, to: v };
  }
  if (Object.keys(changed).length === 0) return { row: doc, unchanged: true, revision: wsRevision(ctx, ws) };
  const next = { ...doc, ...p.patch, revision: doc.revision + 1, updatedAt: p.now };
  saveDoc(ctx, next);
  const revision = bump(ctx, ws);
  journal(ctx, ws, doc.id, 'updated', p.actor, next.revision, p.now, { changed, reason: typeof p.reason === 'string' ? p.reason.slice(0, 2000) : '' });
  return { row: next, revision };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opArchive(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!Number.isSafeInteger(p.expectedRevision) || typeof p.archived !== 'boolean') refuse('initiative_invalid_archive');
  const doc = mustExist(ctx, ws, p.id);
  if (doc.revision !== p.expectedRevision) return { row: null, conflict: 'revision', current: doc, revision: wsRevision(ctx, ws) };
  if (Boolean(doc.archivedAt) === p.archived) return { row: doc, unchanged: true, revision: wsRevision(ctx, ws) };
  const next = { ...doc, archivedAt: p.archived ? p.now : '', revision: doc.revision + 1, updatedAt: p.now };
  saveDoc(ctx, next);
  const revision = bump(ctx, ws);
  journal(ctx, ws, doc.id, p.archived ? 'archived' : 'unarchived', p.actor, next.revision, p.now, {});
  return { row: next, revision };
}

/** True when `target` already reaches `source` over edges of `type` (adding source -> target would close a cycle). */
function reaches(ctx, type, from, target) {
  const row = ctx.prepare(`WITH RECURSIVE walk(id) AS (
      SELECT ? UNION SELECT r.to_id FROM initiative_relations r JOIN walk w ON r.from_id = w.id WHERE r.type = ?
    ) SELECT 1 AS hit FROM walk WHERE id = ? LIMIT 1`).get(from, type, target);
  return Boolean(row);
}

/** @param {any} ctx @param {Record<string, any>} p */
function opAddRelation(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!RELATION_TYPES.includes(p.type) || !isKey(p.relationId) || !isKey(p.fromId) || !isKey(p.toId)) refuse('initiative_invalid_relation');
  if (p.fromId === p.toId) refuse('initiative_relation_self');
  let from = p.fromId;
  let to = p.toId;
  // alternative_to is symmetric: one canonical record with from < to.
  if (p.type === 'alternative_to' && from > to) [from, to] = [to, from];
  const a = mustExist(ctx, ws, from);
  const b = mustExist(ctx, ws, to);
  if (ACYCLIC_RELATION_TYPES.includes(p.type) && reaches(ctx, p.type, to, from)) refuse('initiative_relation_cycle', { type: p.type });
  const dup = ctx.prepare('SELECT id FROM initiative_relations WHERE type = ? AND from_id = ? AND to_id = ?').get(p.type, from, to);
  if (dup) refuse('initiative_relation_duplicate', { id: dup.id });
  ctx.prepare('INSERT INTO initiative_relations (id, workspace_uuid, type, from_id, to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.relationId, ws, p.type, from, to, p.now);
  touch(ctx, a, p.now);
  touch(ctx, b, p.now);
  const revision = bump(ctx, ws);
  const payload = { relationId: p.relationId, type: p.type, fromId: from, toId: to };
  journal(ctx, ws, from, 'relation_added', p.actor, a.revision + 1, p.now, payload);
  journal(ctx, ws, to, 'relation_added', p.actor, b.revision + 1, p.now, payload);
  return { relation: { id: p.relationId, workspaceUuid: ws, type: p.type, fromId: from, toId: to, createdAt: p.now }, revision };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opRemoveRelation(ctx, p) {
  const ws = requireScope(ctx, p);
  const rel = isKey(p.relationId) ? ctx.prepare('SELECT * FROM initiative_relations WHERE id = ? AND workspace_uuid = ?').get(p.relationId, ws) : null;
  if (!rel) return { removed: false, revision: wsRevision(ctx, ws) };
  ctx.prepare('DELETE FROM initiative_relations WHERE id = ?').run(rel.id);
  for (const id of [rel.from_id, rel.to_id]) {
    const doc = loadDoc(ctx, ws, id);
    if (!doc) continue;
    touch(ctx, doc, p.now);
    journal(ctx, ws, id, 'relation_removed', p.actor, doc.revision + 1, p.now, { relationId: rel.id, type: rel.type });
  }
  return { removed: true, revision: bump(ctx, ws) };
}

/** Inserts a link and its event; shared by addLink and the todo-intent completion. */
function insertLink(ctx, ws, doc, p) {
  const dup = ctx.prepare('SELECT id, snapshot_json, created_at FROM initiative_links WHERE initiative_id = ? AND kind = ? AND target_id = ?').get(doc.id, p.kind, p.targetId);
  if (dup) return { link: { id: dup.id, initiativeId: doc.id, kind: p.kind, targetId: p.targetId, snapshot: JSON.parse(dup.snapshot_json), createdAt: dup.created_at }, created: false };
  ctx.prepare('INSERT INTO initiative_links (id, workspace_uuid, initiative_id, kind, target_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.linkId, ws, doc.id, p.kind, p.targetId, JSON.stringify(p.snapshot ?? {}), p.now);
  const next = touch(ctx, doc, p.now);
  journal(ctx, ws, doc.id, 'link_added', p.actor, next.revision, p.now, { linkId: p.linkId, kind: p.kind, targetId: p.targetId });
  return { link: { id: p.linkId, initiativeId: doc.id, kind: p.kind, targetId: p.targetId, snapshot: p.snapshot ?? {}, createdAt: p.now }, created: true };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opAddLink(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!LINK_KINDS.includes(p.kind) || !isKey(p.targetId) || !isKey(p.linkId) || (p.snapshot !== undefined && !isObj(p.snapshot))) refuse('initiative_invalid_link');
  const doc = mustExist(ctx, ws, p.initiativeId);
  const res = insertLink(ctx, ws, doc, p);
  return { ...res, revision: res.created ? bump(ctx, ws) : wsRevision(ctx, ws) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opRemoveLink(ctx, p) {
  const ws = requireScope(ctx, p);
  const row = isKey(p.linkId) ? ctx.prepare('SELECT * FROM initiative_links WHERE id = ? AND workspace_uuid = ?').get(p.linkId, ws) : null;
  if (!row) return { removed: false, revision: wsRevision(ctx, ws) };
  ctx.prepare('DELETE FROM initiative_links WHERE id = ?').run(row.id);
  const doc = loadDoc(ctx, ws, row.initiative_id);
  if (doc) {
    const next = touch(ctx, doc, p.now);
    journal(ctx, ws, doc.id, 'link_removed', p.actor, next.revision, p.now, { linkId: row.id, kind: row.kind, targetId: row.target_id });
  }
  return { removed: true, revision: bump(ctx, ws) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opAddResearch(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!isKey(p.entryId) || !RESEARCH_KINDS.includes(p.entry?.kind) || !isKey(p.entry?.claim)) refuse('initiative_invalid_research');
  const doc = mustExist(ctx, ws, p.initiativeId);
  let lineageId = p.entryId;
  let version = 1;
  if (p.supersedesId !== undefined) {
    const prior = ctx.prepare('SELECT lineage_id, version, initiative_id FROM initiative_research WHERE id = ? AND workspace_uuid = ?').get(p.supersedesId, ws);
    if (!prior || prior.initiative_id !== doc.id) refuse('initiative_research_not_found');
    const latest = ctx.prepare('SELECT max(version) AS v FROM initiative_research WHERE lineage_id = ?').get(prior.lineage_id);
    if (Number(latest.v) !== Number(prior.version)) refuse('initiative_research_superseded');
    lineageId = prior.lineage_id;
    version = Number(prior.version) + 1;
  }
  const seq = Number(ctx.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM initiative_research').get().n);
  const entry = {
    ...p.entry, id: p.entryId, initiativeId: doc.id, workspaceUuid: ws, lineageId, version,
    initiativeRevision: doc.revision, producer: p.actor, createdAt: p.now,
  };
  ctx.prepare('INSERT INTO initiative_research (id, workspace_uuid, initiative_id, lineage_id, version, seq, doc_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(entry.id, ws, doc.id, lineageId, version, seq, JSON.stringify(entry));
  const next = touch(ctx, doc, p.now);
  journal(ctx, ws, doc.id, 'research_added', p.actor, next.revision, p.now, { entryId: entry.id, kind: entry.kind, version });
  return { entry, revision: bump(ctx, ws) };
}

/** @param {any} row */
function intentOf(row) {
  return row ? {
    workspaceUuid: row.workspace_uuid, operationId: row.operation_id, initiativeId: row.initiative_id, digest: row.digest,
    state: row.state, payload: JSON.parse(row.payload_json), todoId: row.todo_id,
  } : null;
}

/** Durable intent to create a Todo from an initiative; replays must carry the same payload digest. */
function opTodoIntentBegin(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!isKey(p.operationId) || !isKey(p.digest) || !isObj(p.payload)) refuse('initiative_invalid_intent');
  mustExist(ctx, ws, p.initiativeId);
  const prior = ctx.prepare('SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND operation_id = ?').get(ws, p.operationId);
  if (prior) {
    if (prior.digest !== p.digest || prior.initiative_id !== p.initiativeId) refuse('initiative_intent_mismatch');
    return { intent: intentOf(prior), created: false, revision: wsRevision(ctx, ws) };
  }
  ctx.prepare("INSERT INTO initiative_todo_intents (workspace_uuid, operation_id, initiative_id, digest, state, payload_json) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(ws, p.operationId, p.initiativeId, p.digest, JSON.stringify(p.payload));
  const intent = intentOf(ctx.prepare('SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND operation_id = ?').get(ws, p.operationId));
  return { intent, created: true, revision: bump(ctx, ws) };
}

/** Records the created Todo and repairs/creates the link in one transaction. */
function opTodoIntentComplete(ctx, p) {
  const ws = requireScope(ctx, p);
  if (!isKey(p.operationId) || !isKey(p.todoId) || !isKey(p.linkId)) refuse('initiative_invalid_intent');
  const row = ctx.prepare('SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND operation_id = ?').get(ws, p.operationId);
  if (!row) refuse('initiative_intent_missing');
  if (row.state === 'created' && row.todo_id !== p.todoId) refuse('initiative_intent_mismatch');
  const doc = mustExist(ctx, ws, row.initiative_id);
  ctx.prepare("UPDATE initiative_todo_intents SET state = 'created', todo_id = ? WHERE workspace_uuid = ? AND operation_id = ?").run(p.todoId, ws, p.operationId);
  const res = insertLink(ctx, ws, doc, { ...p, kind: 'todo', targetId: p.todoId, snapshot: p.snapshot });
  return {
    intent: intentOf(ctx.prepare('SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND operation_id = ?').get(ws, p.operationId)),
    link: res.link, revision: bump(ctx, ws),
  };
}

const rc = (fn) => withReceipt(fn);
export const commands = Object.freeze({
  [`${PREFIX}create`]: rc(opCreate),
  [`${PREFIX}update`]: rc(opUpdate),
  [`${PREFIX}archive`]: rc(opArchive),
  [`${PREFIX}addRelation`]: rc(opAddRelation),
  [`${PREFIX}removeRelation`]: rc(opRemoveRelation),
  [`${PREFIX}addLink`]: rc(opAddLink),
  [`${PREFIX}removeLink`]: rc(opRemoveLink),
  [`${PREFIX}addResearch`]: rc(opAddResearch),
  [`${PREFIX}todoIntentBegin`]: rc(opTodoIntentBegin),
  [`${PREFIX}todoIntentComplete`]: rc(opTodoIntentComplete),
});

/** @param {string} ws @param {number} revision @param {number} last */
function encodeCursor(ws, revision, last) {
  return Buffer.from(JSON.stringify({ w: ws, r: revision, s: last })).toString('base64url');
}

/** Decodes a cursor and refuses a stale or foreign one with an explicit conflict. */
function decodeCursor(ctx, ws, cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return { last: 0 };
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { refuse('initiative_cursor_invalid'); }
  if (!isObj(parsed) || parsed.w !== ws || !Number.isSafeInteger(parsed.s) || !Number.isSafeInteger(parsed.r)) refuse('initiative_cursor_invalid');
  if (parsed.r !== wsRevision(ctx, ws)) refuse('initiative_cursor_stale', { restart: true });
  return { last: parsed.s };
}

/** @param {unknown} v */
function pageLimit(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryList(ctx, p) {
  if (!isKey(p?.workspaceUuid)) refuse('initiative_invalid_scope');
  const ws = p.workspaceUuid;
  const { last } = decodeCursor(ctx, ws, p.cursor);
  const limit = pageLimit(p.limit);
  const where = ['workspace_uuid = ?', 'seq > ?'];
  const args = [ws, last];
  if (!p.includeArchived) where.push("archived_at = ''");
  if (typeof p.status === 'string') { where.push('status = ?'); args.push(p.status); }
  if (typeof p.horizon === 'string') { where.push('horizon = ?'); args.push(p.horizon); }
  const rows = ctx.prepare(`SELECT seq, doc_json FROM initiatives WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  const revision = wsRevision(ctx, ws);
  const hasMore = rows.length > limit;
  return {
    revision, hasMore, items: page.map((r) => JSON.parse(r.doc_json)),
    nextCursor: hasMore ? encodeCursor(ws, revision, Number(page.at(-1).seq)) : null,
  };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryGet(ctx, p) {
  if (!isKey(p?.workspaceUuid)) refuse('initiative_invalid_scope');
  return { row: isKey(p.id) ? loadDoc(ctx, p.workspaceUuid, p.id) : null, revision: wsRevision(ctx, p.workspaceUuid) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryHistory(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.initiativeId)) refuse('initiative_invalid_scope');
  const ws = p.workspaceUuid;
  const { last } = decodeCursor(ctx, ws, p.cursor);
  const limit = pageLimit(p.limit);
  const rows = ctx.prepare('SELECT * FROM initiative_events WHERE workspace_uuid = ? AND initiative_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(ws, p.initiativeId, last, limit + 1);
  const page = rows.slice(0, limit);
  const revision = wsRevision(ctx, ws);
  const hasMore = rows.length > limit;
  return {
    revision, hasMore,
    items: page.map((r) => ({ seq: Number(r.seq), initiativeId: r.initiative_id, type: r.type, actor: r.actor, revision: Number(r.revision), at: r.at, payload: JSON.parse(r.payload_json) })),
    nextCursor: hasMore ? encodeCursor(ws, revision, Number(page.at(-1).seq)) : null,
  };
}

/** @param {any} r */
const relationOf = (r) => ({ id: r.id, workspaceUuid: r.workspace_uuid, type: r.type, fromId: r.from_id, toId: r.to_id, createdAt: r.created_at });

/** @param {any} ctx @param {Record<string, any>} p */
function queryRelations(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.initiativeId)) refuse('initiative_invalid_scope');
  const rows = ctx.prepare('SELECT * FROM initiative_relations WHERE workspace_uuid = ? AND (from_id = ? OR to_id = ?) ORDER BY created_at, id').all(p.workspaceUuid, p.initiativeId, p.initiativeId);
  return { items: rows.map(relationOf), revision: wsRevision(ctx, p.workspaceUuid) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryLinks(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.initiativeId)) refuse('initiative_invalid_scope');
  const rows = ctx.prepare('SELECT * FROM initiative_links WHERE workspace_uuid = ? AND initiative_id = ? ORDER BY created_at, id').all(p.workspaceUuid, p.initiativeId);
  return {
    items: rows.map((r) => ({ id: r.id, initiativeId: r.initiative_id, kind: r.kind, targetId: r.target_id, snapshot: JSON.parse(r.snapshot_json), createdAt: r.created_at })),
    revision: wsRevision(ctx, p.workspaceUuid),
  };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryResearch(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.initiativeId)) refuse('initiative_invalid_scope');
  const rows = ctx.prepare('SELECT doc_json FROM initiative_research WHERE workspace_uuid = ? AND initiative_id = ? ORDER BY seq').all(p.workspaceUuid, p.initiativeId);
  return { items: rows.map((r) => JSON.parse(r.doc_json)), revision: wsRevision(ctx, p.workspaceUuid) };
}

/** Bounded slice of the workspace graph: explicit truncation instead of silent clipping. */
function queryGraphSlice(ctx, p) {
  if (!isKey(p?.workspaceUuid)) refuse('initiative_invalid_scope');
  const ws = p.workspaceUuid;
  const { last } = decodeCursor(ctx, ws, p.cursor);
  const maxNodes = Math.min(Number(p.limit) > 0 ? Number(p.limit) : GRAPH_MAX_NODES, GRAPH_MAX_NODES);
  const rows = ctx.prepare("SELECT seq, doc_json FROM initiatives WHERE workspace_uuid = ? AND seq > ? AND archived_at = '' ORDER BY seq LIMIT ?").all(ws, last, maxNodes + 1);
  const page = rows.slice(0, maxNodes);
  const ids = new Set(page.map((r) => JSON.parse(r.doc_json).id));
  const allEdges = ctx.prepare('SELECT * FROM initiative_relations WHERE workspace_uuid = ? ORDER BY created_at, id').all(ws)
    .filter((r) => ids.has(r.from_id) && ids.has(r.to_id));
  const edges = allEdges.slice(0, GRAPH_MAX_EDGES);
  const revision = wsRevision(ctx, ws);
  const hasMore = rows.length > maxNodes;
  return {
    revision, hasMore, truncated: hasMore || allEdges.length > edges.length, skippedEdges: allEdges.length - edges.length,
    nodes: page.map((r) => JSON.parse(r.doc_json)), edges: edges.map(relationOf),
    nextCursor: hasMore ? encodeCursor(ws, revision, Number(page.at(-1).seq)) : null,
  };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryTodoIntent(ctx, p) {
  if (!isKey(p?.workspaceUuid) || !isKey(p?.operationId)) refuse('initiative_invalid_scope');
  return { intent: intentOf(ctx.prepare('SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND operation_id = ?').get(p.workspaceUuid, p.operationId)) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryPendingIntents(ctx, p) {
  if (!isKey(p?.workspaceUuid)) refuse('initiative_invalid_scope');
  return { items: ctx.prepare("SELECT * FROM initiative_todo_intents WHERE workspace_uuid = ? AND state = 'pending'").all(p.workspaceUuid).map(intentOf) };
}

/** @param {any} ctx */
function queryRevision(ctx) {
  return { revision: Number(ctx.prepare('SELECT revision FROM initiative_meta WHERE id = 1').get().revision) };
}

/** The store file must be bound to the generation the runtime expects. */
function queryVerifyDataset(ctx, p) {
  if (!p || typeof p.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(p.datasetGeneration)) refuse('initiative_dataset_invalid');
  const row = ctx.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  if (!row) refuse('initiative_store_unbound');
  if (row.dataset_generation !== p.datasetGeneration) refuse('initiative_generation_mismatch', { bound: row.dataset_generation });
  return { datasetGeneration: row.dataset_generation };
}

export const queries = Object.freeze({
  ...RECEIPT_QUERIES,
  [`${PREFIX}list`]: queryList,
  [`${PREFIX}get`]: queryGet,
  [`${PREFIX}history`]: queryHistory,
  [`${PREFIX}relations`]: queryRelations,
  [`${PREFIX}links`]: queryLinks,
  [`${PREFIX}research`]: queryResearch,
  [`${PREFIX}graphSlice`]: queryGraphSlice,
  [`${PREFIX}todoIntent`]: queryTodoIntent,
  [`${PREFIX}pendingIntents`]: queryPendingIntents,
  [`${PREFIX}revision`]: queryRevision,
  [`${PREFIX}verifyDataset`]: queryVerifyDataset,
});

const WRITE_OPS = ['create', 'update', 'archive', 'addRelation', 'removeRelation', 'addLink', 'removeLink', 'addResearch', 'todoIntentBegin', 'todoIntentComplete'];
const READ_OPS = ['list', 'get', 'history', 'relations', 'links', 'research', 'graphSlice', 'todoIntent', 'pendingIntents', 'revision', 'verifyDataset'];

/**
 * Promise facade over a started storage worker host. Every mutation needs a caller-owned `commandId`.
 *
 * @param {{ host: any, datasetGeneration: string, writeGate?: unknown }} options
 */
export function createInitiativesStore({ host, datasetGeneration, writeGate } = /** @type {any} */ ({})) {
  if (!host || typeof host.query !== 'function') throw new TypeError('Initiatives store needs a worker host');
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) {
    throw new TypeError('Initiatives store needs a dataset generation');
  }
  const gate = writeGate ?? host.writeGate;
  const write = async (operation, args) => {
    const { commandId, priority, deadlineMs, signal, error, ...payload } = args;
    assertWriteAllowed(gate);
    const reply = await executeCommand(host, /** @type {any} */ ({ datasetGeneration, commandId, name: PREFIX + operation, payload, priority, deadlineMs, signal, error, writeGate: gate }));
    return reply.result;
  };
  const facade = {};
  for (const op of WRITE_OPS) facade[op] = (args) => write(op, args);
  for (const op of READ_OPS) facade[op] = (args = {}) => host.query(PREFIX + op, args);
  facade.resolveUnknown = (args) => {
    const { commandId, priority, deadlineMs, signal, error, operation, ...payload } = args;
    return resolveUnknown(host, { datasetGeneration, commandId, name: PREFIX + operation, payload, error });
  };
  return Object.freeze(facade);
}
