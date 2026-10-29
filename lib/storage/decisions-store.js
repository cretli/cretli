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
const SOURCE_STATUSES = new Set(['pending', 'deciding']);

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

/** @param {any} ctx @param {Record<string, any>} p */
function opCreate(ctx, p) {
  const row = p?.row;
  if (!row || !isKey(row.id) || !isKey(row.workspaceFolder) || !isKey(row.dedupeKey) || !isKey(row.subject?.updatedAt)
    || row.status !== 'pending' || row.revision !== 1) refuse('decision_invalid_row');
  const prior = ctx.prepare('SELECT doc_json FROM decisions WHERE dedupe_key = ? AND subject_updated_at = ? ORDER BY seq DESC LIMIT 1')
    .get(row.dedupeKey, row.subject.updatedAt);
  if (prior) return { row: JSON.parse(prior.doc_json), created: false, revision: readRevision(ctx) };
  // A new subject revision supersedes older pending cards of the same gate.
  for (const old of ctx.prepare("SELECT doc_json FROM decisions WHERE dedupe_key = ? AND status = 'pending'").all(row.dedupeKey)) {
    const doc = JSON.parse(old.doc_json);
    writeDoc(ctx, { ...doc, status: 'stale', revision: doc.revision + 1 });
  }
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
  const next = { ...doc, ...details, id: doc.id, status: p.status, revision: doc.revision + 1 };
  writeDoc(ctx, next);
  return { row: next, revision: bumpRevision(ctx) };
}

const dedupe = (fn) => withReceipt(fn);
export const commands = Object.freeze({
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
