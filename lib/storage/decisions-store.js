/**
 * Decision cards domain of the storage worker (docs/decision-cards.md). Schema:
 * `lib/storage/schema/0008-decisions.js`.
 *
 * Doubles as the worker handler registry (`commands`, `queries`) and, on the main thread, as the
 * Promise facade `createDecisionsStore`. Cards are opaque JSON documents except for the indexed
 * fields (`id`, `workspaceFolder`, `dedupeKey`, `status`, `revision`, `subject.updatedAt`).
 *
 * - Mutations are receipt-wrapped commands (lib/storage/command-receipts.js): at most one
 *   application per `(datasetGeneration, commandId)`, in the same transaction as the receipt.
 * - `decisions.create` is atomic: dedupe lookup, superseding older pending cards of the same gate
 *   and the insert happen in one transaction.
 * - `decisions.change` is a compare-and-swap on the card `revision`; a mismatch changes nothing.
 * - The handlers never stamp time: callers pass `createdAt`/`decidedAt` inside the payload.
 */
import { StorageError } from './errors.js';
import { DATASET_GENERATION_PATTERN, executeCommand, RECEIPT_QUERIES, resolveUnknown, withReceipt } from './command-receipts.js';
import { assertWriteAllowed } from './maintenance-coordinator.js';

const COMMAND_PREFIX = 'decisions.';
const STATUSES = new Set(['pending', 'deciding', 'decided', 'stale', 'expired']);
/** `deciding` is the claim held while a decision's side effect runs; only one caller can win it. */
const SOURCE_STATUSES = new Set(['pending', 'deciding', 'decided']);

/** @param {string} kind @param {Record<string, unknown>} [details] @returns {never} */
function refuse(kind, details = {}) {
  throw new StorageError('conflict', 'Decisions command refused', {
    details: { operation: 'decisions', conflictKind: kind, commitState: 'not_committed', ...details },
  });
}

/** @param {unknown} v @returns {boolean} */
function isKey(v) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= 512;
}

/** @param {any} ctx */
function readRevision(ctx) {
  return Number(ctx.prepare('SELECT revision FROM decision_meta WHERE id = 1').get().revision);
}

/** @param {any} ctx @returns {number} the new store revision */
function bumpRevision(ctx) {
  ctx.prepare('UPDATE decision_meta SET revision = revision + 1 WHERE id = 1').run();
  return readRevision(ctx);
}

/** @param {any} ctx @param {Record<string, any>} doc */
function writeDoc(ctx, doc) {
  ctx.prepare('UPDATE decisions SET status = ?, revision = ?, doc_json = ? WHERE id = ?')
    .run(doc.status, doc.revision, JSON.stringify(doc), doc.id);
}

/** Cap of the append-only event log kept inside one card document (protected events never count). */
const MAX_EVENTS = 200;
/** Proposal/answer snapshots and their idempotency keys are never trimmed by the cap. */
const PROTECTED_EVENT_TYPES = new Set(['proposed', 'answered', 'superseded']);

/** @param {any[]} events @returns {any[]} */
function capEvents(events) {
  const loose = events.filter((e) => !PROTECTED_EVENT_TYPES.has(e.type));
  if (loose.length <= MAX_EVENTS) return events;
  const drop = new Set(loose.slice(0, loose.length - MAX_EVENTS).map((e) => e.seq));
  return events.filter((e) => !drop.has(e.seq));
}

/**
 * Append an idempotent event: a key already present changes nothing. The snapshot is stored as given and
 * never rewritten, so later edits of the card cannot alter what was proposed or answered.
 * @param {Record<string, any>} doc @param {any} event @returns {Record<string, any>}
 */
function withEvent(doc, event) {
  if (!event || !isKey(event.key) || !isKey(event.type)) return doc;
  const events = Array.isArray(doc.events) ? doc.events : [];
  if (events.some((e) => e.key === event.key)) return doc;
  const next = { key: event.key, type: event.type, at: String(event.at || ''), snapshot: event.snapshot ?? null, seq: (events.at(-1)?.seq ?? 0) + 1 };
  return { ...doc, events: capEvents([...events, next]) };
}

const SNAPSHOT_TEXT_CHARS = 120;
const SNAPSHOT_MAX_OPTIONS = 6;

/** @param {unknown} v */
function clipText(v) {
  return typeof v === 'string' && v.length > SNAPSHOT_TEXT_CHARS ? `${v.slice(0, SNAPSHOT_TEXT_CHARS)}…` : v;
}

/**
 * Compact, bounded audit copy of what was proposed: the identity of the question and the choices offered
 * (id + short label), not the card body. Bodies can be large (e.g. doc proposals) and are already stored on
 * the card, so duplicating them here would inflate every card and the pending workspace byte budget.
 * @param {Record<string, any>} row
 */
function proposedSnapshot(row) {
  const options = Array.isArray(row.options)
    ? row.options.slice(0, SNAPSHOT_MAX_OPTIONS).map((o) => ({ id: o?.id, label: clipText(o?.label) }))
    : null;
  return {
    title: clipText(row.title), options, recommended: row.recommended ?? null,
    ...(row.origin ? { origin: row.origin } : {}), ...(row.relations ? { relations: row.relations } : {}),
  };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opCreate(ctx, p) {
  const row = p?.row;
  if (!row || !isKey(row.id) || !isKey(row.workspaceFolder) || !isKey(row.dedupeKey) || !isKey(row.subject?.updatedAt)
    || row.status !== 'pending' || row.revision !== 1) refuse('decision_invalid_row');
  const prior = ctx.prepare('SELECT doc_json FROM decisions WHERE dedupe_key = ? AND subject_updated_at = ? ORDER BY seq DESC LIMIT 1')
    .get(row.dedupeKey, row.subject.updatedAt);
  if (prior) return { row: JSON.parse(prior.doc_json), created: false, revision: readRevision(ctx) };
  // A new subject revision supersedes older cards of the same gate: pending ones go stale, decided ones keep
  // their answer but are marked superseded so it is no longer handed to a cycle.
  const superseded = [];
  let journeyId = row.relations?.journeyId;
  for (const old of ctx.prepare("SELECT doc_json FROM decisions WHERE dedupe_key = ? AND status IN ('pending', 'decided')").all(row.dedupeKey)) {
    const doc = JSON.parse(old.doc_json);
    if (doc.supersededBy || (doc.status === 'decided' && doc.kind !== 'needs_human')) continue;
    const marked = { ...doc, supersededBy: row.id, revision: doc.revision + 1, ...(doc.status === 'pending' ? { status: 'stale' } : {}) };
    writeDoc(ctx, withEvent(marked, { key: 'superseded', type: 'superseded', at: row.createdAt, snapshot: { by: row.id } }));
    superseded.push(doc.id);
    journeyId = doc.relations?.journeyId || journeyId;
  }
  if (superseded.length) row.relations = { ...(row.relations || {}), supersedes: superseded, ...(journeyId ? { journeyId } : {}) };
  Object.assign(row, withEvent(row, { key: 'proposed', type: 'proposed', at: row.createdAt, snapshot: proposedSnapshot(row) }));
  const seq = Number(ctx.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM decisions').get().n);
  ctx.prepare('INSERT INTO decisions (id, workspace_key, dedupe_key, status, revision, subject_updated_at, seq, doc_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.workspaceFolder, row.dedupeKey, row.status, row.revision, row.subject.updatedAt, seq, JSON.stringify(row));
  return { row, created: true, revision: bumpRevision(ctx) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function opChange(ctx, p) {
  if (!isKey(p?.id) || !Number.isSafeInteger(p.expectedRevision) || !STATUSES.has(p.status)) refuse('decision_invalid_change');
  const from = p.fromStatus ?? 'pending';
  if (!SOURCE_STATUSES.has(from)) refuse('decision_invalid_change');
  const found = ctx.prepare('SELECT doc_json FROM decisions WHERE id = ?').get(p.id);
  const doc = found ? JSON.parse(found.doc_json) : null;
  if (!doc || doc.status !== from || doc.revision !== p.expectedRevision) return { row: null, revision: readRevision(ctx) };
  const details = p.details && typeof p.details === 'object' && !Array.isArray(p.details) ? p.details : {};
  const next = withEvent({ ...doc, ...details, id: doc.id, status: p.status, revision: doc.revision + 1 }, p.event);
  writeDoc(ctx, next);
  return { row: next, revision: bumpRevision(ctx) };
}

const CONTINUATION_STATUSES = new Set(['saved', 'applying', 'waiting', 'resumed', 'applied', 'none', 'failed']);

/**
 * Update the continuation record of a decided card (no card status change, no revision bump) and optionally
 * append an event. `expectStatus` makes the update a compare-and-swap on the current continuation status.
 * @param {any} ctx @param {Record<string, any>} p
 */
function opAnnotate(ctx, p) {
  const resume = p?.resumeTodo;
  const link = p?.linkDelegation;
  const delivery = p?.deliveryError;
  if (delivery ? !isKey(delivery.todoId) : link ? !isKey(link.delegationId) : resume ? !isKey(resume.todoId) : (!p?.continuation || typeof p.continuation !== 'object' || !CONTINUATION_STATUSES.has(p.continuation.status))) refuse('decision_invalid_annotation');
  if (!isKey(p?.id)) refuse('decision_invalid_annotation');
  const found = ctx.prepare('SELECT doc_json FROM decisions WHERE id = ?').get(p.id);
  const doc = found ? JSON.parse(found.doc_json) : null;
  if (!doc || doc.status !== 'decided' || !doc.continuation) return { row: null, revision: readRevision(ctx) };
  if (p.expectStatus && doc.continuation.status !== p.expectStatus) return { row: null, revision: readRevision(ctx) };
  // Ownership fence: the claim token of the applier, and for a lease takeover the exact claim generation seen.
  if (p.expectToken && doc.continuation.claimToken !== p.expectToken) return { row: null, revision: readRevision(ctx) };
  if (p.expectApplyingAt && doc.continuation.applyingAt !== p.expectApplyingAt) return { row: null, revision: readRevision(ctx) };
  let patch = p.continuation;
  if (link) {
    // Durable decision -> delegation link; the idempotent event key makes a repeat a no-op.
    patch = { delegationIds: [...new Set([...(doc.continuation.delegationIds || []), link.delegationId])] };
  } else if (delivery) {
    // Per-todo delivery error on a still-`waiting` continuation: the answer stays loadable for retry.
    if (doc.continuation.status !== 'waiting') return { row: null, revision: readRevision(ctx) };
    patch = { deliveryErrors: { ...(doc.continuation.deliveryErrors || {}), [delivery.todoId]: { reason: String(delivery.reason || '').slice(0, 300), at: String(delivery.at || '') } } };
  } else if (resume) {
    // Per-todo tracking inside the transaction: concurrent cycles of different todos cannot lose each other's mark.
    if (doc.continuation.status !== 'waiting') return { row: null, revision: readRevision(ctx) };
    const done = [...new Set([...(doc.continuation.resumedTodoIds || []), resume.todoId])];
    const all = (doc.continuation.todoIds || []).every((id) => done.includes(id));
    const deliveryErrors = { ...(doc.continuation.deliveryErrors || {}) };
    delete deliveryErrors[resume.todoId];
    patch = { resumedTodoIds: done, deliveryErrors, ...(all ? { status: 'resumed', resumedAt: String(resume.at || ''), cycleId: resume.cycleId, chatId: resume.chatId } : {}) };
  }
  const next = withEvent({ ...doc, continuation: { ...doc.continuation, ...patch } }, p.event);
  writeDoc(ctx, next);
  return { row: next, revision: bumpRevision(ctx) };
}

const dedupe = (fn) => withReceipt(fn);
export const commands = Object.freeze({
  [`${COMMAND_PREFIX}annotate`]: dedupe(opAnnotate),
  [`${COMMAND_PREFIX}create`]: dedupe(opCreate),
  [`${COMMAND_PREFIX}change`]: dedupe(opChange),
});

/** @param {any} ctx @param {Record<string, any>} p */
function queryList(ctx, p) {
  if (!isKey(p?.workspaceFolder)) refuse('decision_invalid_workspace');
  const rows = typeof p.status === 'string'
    ? ctx.prepare('SELECT doc_json FROM decisions WHERE workspace_key = ? AND status = ? ORDER BY seq').all(p.workspaceFolder, p.status)
    : ctx.prepare('SELECT doc_json FROM decisions WHERE workspace_key = ? ORDER BY seq').all(p.workspaceFolder);
  return { revision: readRevision(ctx), items: rows.map((r) => JSON.parse(r.doc_json)) };
}

/** @param {any} ctx @param {Record<string, any>} p */
function queryGet(ctx, p) {
  const found = isKey(p?.id) ? ctx.prepare('SELECT doc_json FROM decisions WHERE id = ?').get(p.id) : undefined;
  return { row: found ? JSON.parse(found.doc_json) : null };
}

/** Workspace history (decided or undone cards), newest first, keyset-paginated by `decidedAt|id`. */
function queryHistory(ctx, p) {
  if (!isKey(p?.workspaceFolder)) refuse('decision_invalid_workspace');
  const limit = Math.min(200, Math.max(1, Number.isSafeInteger(p.limit) ? p.limit : 50));
  const all = ctx.prepare('SELECT doc_json FROM decisions WHERE workspace_key = ?').all(p.workspaceFolder).map((r) => JSON.parse(r.doc_json))
    .filter((d) => d.status === 'decided' || d.undone)
    .map((d) => ({ d, key: `${d.decidedAt || ''}|${d.id}` }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
  const cursor = typeof p.cursor === 'string' ? p.cursor : '';
  const rest = cursor ? all.filter((x) => x.key < cursor) : all;
  const page = rest.slice(0, limit);
  return { items: page.map((x) => x.d), nextCursor: rest.length > limit ? page.at(-1).key : null };
}

/** Paginated event history of one card: `cursor` is the last seen `seq`. */
function queryEvents(ctx, p) {
  const found = isKey(p?.id) ? ctx.prepare('SELECT doc_json FROM decisions WHERE id = ?').get(p.id) : undefined;
  if (!found) return { found: false, items: [], nextCursor: null };
  const events = JSON.parse(found.doc_json).events || [];
  const after = Number.isSafeInteger(p.cursor) ? p.cursor : 0;
  const limit = Math.min(100, Math.max(1, Number.isSafeInteger(p.limit) ? p.limit : 50));
  const rest = events.filter((e) => e.seq > after);
  const items = rest.slice(0, limit);
  return { found: true, items, nextCursor: rest.length > limit ? items.at(-1).seq : null };
}

/** @param {any} ctx */
function queryRevision(ctx) {
  return { revision: readRevision(ctx) };
}

/** The store file must be bound to the generation the runtime expects. */
function queryVerifyDataset(ctx, p) {
  if (!p || typeof p.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(p.datasetGeneration)) refuse('decision_dataset_invalid');
  const row = ctx.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
  if (!row) refuse('decision_store_unbound');
  if (row.dataset_generation !== p.datasetGeneration) refuse('decision_generation_mismatch', { bound: row.dataset_generation });
  return { datasetGeneration: row.dataset_generation };
}

export const queries = Object.freeze({
  ...RECEIPT_QUERIES,
  [`${COMMAND_PREFIX}list`]: queryList,
  [`${COMMAND_PREFIX}get`]: queryGet,
  [`${COMMAND_PREFIX}events`]: queryEvents,
  [`${COMMAND_PREFIX}history`]: queryHistory,
  [`${COMMAND_PREFIX}revision`]: queryRevision,
  [`${COMMAND_PREFIX}verifyDataset`]: queryVerifyDataset,
});

/**
 * Promise facade over a started storage worker host. Every mutation needs a caller-owned `commandId`.
 *
 * @param {{ host: any, datasetGeneration: string, writeGate?: unknown }} options
 */
export function createDecisionsStore({ host, datasetGeneration, writeGate } = /** @type {any} */ ({})) {
  if (!host || typeof host.query !== 'function') throw new TypeError('Decisions store needs a worker host');
  if (typeof datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(datasetGeneration)) {
    throw new TypeError('Decisions store needs a dataset generation');
  }
  const gate = writeGate ?? host.writeGate;
  const write = async (operation, args) => {
    const { commandId, priority, deadlineMs, signal, error, ...payload } = args;
    assertWriteAllowed(gate);
    const reply = await executeCommand(host, /** @type {any} */ ({ datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, priority, deadlineMs, signal, error, writeGate: gate }));
    return reply.result;
  };
  const read = (name, args) => host.query(COMMAND_PREFIX + name, args);
  return Object.freeze({
    create: (args) => write('create', args),
    change: (args) => write('change', args),
    annotate: (args) => write('annotate', args),
    events: (args) => read('events', args),
    history: (args) => read('history', args),
    list: (args) => read('list', args),
    get: (args) => read('get', args),
    revision: () => read('revision', {}),
    verifyDataset: (args) => read('verifyDataset', args),
    resolveUnknown: (args) => {
      const { commandId, priority, deadlineMs, signal, error, operation, ...payload } = args;
      return resolveUnknown(host, { datasetGeneration, commandId, name: COMMAND_PREFIX + operation, payload, error });
    },
  });
}
