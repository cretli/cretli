/**
 * Offline migration of `store.todos` between the legacy JSON documents and the SQLite store
 * (ADR docs/storage-todos-worker-decision.md, section 5; runbook docs/storage-pre-cutover-runbook.md).
 *
 * Forward (`planTodosMigration` / `applyTodosMigration`)
 * - run with every Cretli writer stopped; the source files are only READ (they are made read-only
 *   after the marker is published, never rewritten or deleted);
 * - plan = manifest (SHA-256 and logical counts per `todos/<key>.json`) + plan hash; apply needs it
 *   back (`confirmPlanHash`), imports into a NEW staging store, verifies it from a fresh connection
 *   (totals, per-workspace counts, IDs, parent/sibling_index, per-item field sets incl. unknown
 *   fields, canonical hash of every exported document), re-hashes the sources, closes the store
 *   cleanly, publishes it and only then writes the backend marker;
 * - anything failing before the marker leaves the legacy JSON authoritative and no marker.
 *
 * Rollback (`exportTodosRollback`, `verifyTodosRollbackExport`, `activateTodosRollback`)
 * - after the first durable ACK of the SQLite backend (a command receipt, or documents that differ from
 *   the imported ones) the original JSON files are STALE: restoring them would silently lose writes.
 *   `assertTodosRollbackSource` therefore rejects a plain JSON directory as rollback source and accepts
 *   only a fresh logical export whose manifest fingerprints the current store;
 * - the export holds strict legacy documents plus `rollback-control/` (manifest, receipts, fencing
 *   high-water mark). Plain legacy code knows nothing of receipts or fencing, so the marker
 *   `legacy-rollback` pins the manifest hash and the legacy runtime refuses to start on anything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStorageDb } from './db-lifecycle.js';
import { bindDatasetGeneration } from './dataset-binding.js';
import { DATASET_GENERATION_PATTERN } from './command-receipts.js';
import { offlineHandlers } from './todos-store.js';
import {
  PARTIAL_MARKER_FILE, discardOwnPartial, fsyncDirectory, hashFile, lstatOrNull, openImmutableDatabase, publishDirectory,
  replaceOwnFileDurable, writeFileExclusiveDurable,
} from './history-migration-fs.js';
import {
  readTodosBackendMarker, TODOS_SQLITE_FILE, TodosBackendError, writeTodosBackendMarker,
} from '../persist/todos-backend-marker.js';

export const TODOS_PLAN_SCHEMA = 'cretli-todos-migration-plan-v1';
export const TODOS_ROLLBACK_SCHEMA = 'cretli-todos-rollback-manifest-v1';
export const TODOS_ROLLBACK_CONTROL_DIR = 'rollback-control';
export const TODOS_ROLLBACK_MANIFEST_FILE = 'manifest.json';
const SOURCE_FILE_RE = /^[0-9a-f]{64}\.json$/;
const WATCHER_JOURNAL = 'watcher-todo-command.journal.json';

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] @returns {never} */
function refuse(code, message, details) {
  throw new TodosBackendError(code, message, details);
}

/** @param {unknown} v @returns {unknown} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(/** @type {any} */ (v)[k])]));
  return v;
}

/** Stable text of a JSON value, independent of object key order. @param {unknown} v @returns {string} */
export function canonicalText(v) {
  return JSON.stringify(sortKeys(v));
}

/** @param {string | Buffer} text @returns {string} */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of a set of documents `{ [workspaceKey]: document }`, key order independent. @param {Record<string, unknown>} docs */
export function canonicalDocsHash(docs) {
  return sha256(canonicalText(docs));
}

/**
 * Parse one legacy document strictly: a JSON object with an `items` array of objects with a string `id`.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseSourceDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse('todos_source_invalid', 'A todos document is not valid JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.items)) {
    return refuse('todos_source_invalid', 'A todos document needs an items array');
  }
  const ids = new Set();
  for (const item of doc.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || item.id.trim() === '') {
      return refuse('todos_source_invalid', 'A todos document holds an item without a string id');
    }
    if (ids.has(item.id)) return refuse('todos_source_invalid', 'A todos document holds a duplicate item id', { id: item.id });
    ids.add(item.id);
  }
  return doc;
}

/**
 * @param {string} dataDir
 * @param {{ minQuietMs?: number, now?: () => number }} [options]
 */
function readSourceManifest(dataDir, options = {}) {
  const dir = path.join(path.resolve(dataDir), 'todos');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const now = (options.now ?? Date.now)();
  const minQuietMs = options.minQuietMs ?? 5000;
  /** @type {Array<{ key: string, sha256: string, bytes: number, items: number, idempotencyKeys: number }>} */
  const files = [];
  /** @type {Record<string, Record<string, any>>} */
  const docs = {};
  const skipped = [];
  for (const name of names) {
    if (!SOURCE_FILE_RE.test(name)) { skipped.push(name); continue; }
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    if (minQuietMs > 0 && now - stat.mtimeMs < minQuietMs) refuse('todos_source_not_quiet', 'A todos document was written recently; stop every writer first', { file: name });
    const text = fs.readFileSync(filePath, 'utf8');
    const doc = parseSourceDocument(text);
    const key = name.slice(0, -'.json'.length);
    docs[key] = doc;
    files.push({
      key, sha256: sha256(text), bytes: Buffer.byteLength(text), items: doc.items.length,
      idempotencyKeys: doc.idempotency && typeof doc.idempotency === 'object' ? Object.keys(doc.idempotency).length : 0,
    });
  }
  if (fs.existsSync(path.join(path.resolve(dataDir), WATCHER_JOURNAL)) || fs.existsSync(path.join(path.resolve(dataDir), WATCHER_JOURNAL.replace('.json', '')))) {
    refuse('todos_source_journal_pending', 'An unfinished watcher/todo command journal exists; start the legacy server once to recover it');
  }
  const totals = { files: files.length, items: files.reduce((n, f) => n + f.items, 0), bytes: files.reduce((n, f) => n + f.bytes, 0) };
  const manifestHash = sha256(canonicalText({ files, totals }));
  return { files, docs, totals, manifestHash, skipped, canonicalHash: canonicalDocsHash(docs) };
}

/**
 * @param {{ dataDir: string, datasetGeneration: string, minQuietMs?: number, now?: () => number }} options
 */
export function planTodosMigration(options) {
  if (typeof options.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(options.datasetGeneration)) {
    refuse('todos_generation_invalid', 'A dataset generation is required');
  }
  const marker = readTodosBackendMarker(options.dataDir);
  if (marker.backend !== 'legacy') refuse('todos_already_migrated', 'The todos backend marker already selects another backend', { backend: marker.backend });
  const target = path.join(path.resolve(options.dataDir), TODOS_SQLITE_FILE);
  if (lstatOrNull(target)) refuse('todos_store_exists', 'A todos store file already exists; it is never overwritten');
  const source = readSourceManifest(options.dataDir, options);
  const planHash = sha256(canonicalText({ schema: TODOS_PLAN_SCHEMA, generation: options.datasetGeneration, manifest: source.manifestHash }));
  return {
    schema: TODOS_PLAN_SCHEMA, ok: true, datasetGeneration: options.datasetGeneration, planHash,
    manifestHash: source.manifestHash, files: source.files, totals: source.totals, skipped: source.skipped, canonicalHash: source.canonicalHash,
  };
}

/**
 * Verify a (closed) store against the source documents. Throws on the first mismatch.
 *
 * @param {string} dbPath
 * @param {Record<string, Record<string, any>>} docs
 * @returns {{ workspaces: number, items: number, canonicalHash: string }}
 */
export function verifyTodosStoreAgainstDocs(dbPath, docs) {
  const db = openImmutableDatabase(dbPath);
  try {
    const ctx = { prepare: (sql) => db.prepare(sql) };
    const stored = offlineHandlers.workspaces(ctx).workspaces;
    const keys = Object.keys(docs).sort();
    if (stored.map((w) => w.workspaceKey).join('|') !== keys.join('|')) refuse('todos_verify_workspaces', 'The workspace set differs from the source');
    let items = 0;
    /** @type {Record<string, any>} */
    const exported = {};
    for (const key of keys) {
      const src = docs[key];
      const count = stored.find((w) => w.workspaceKey === key)?.count;
      if (count !== src.items.length) refuse('todos_verify_count', 'Per-workspace item count differs', { key, expected: src.items.length, actual: count });
      const out = offlineHandlers.exportDocument(ctx, { workspaceKey: key });
      if (!out) refuse('todos_verify_missing', 'A workspace document is missing', { key });
      const outIds = out.items.map((i) => i.id);
      if (outIds.join('\u0000') !== src.items.map((i) => i.id).join('\u0000')) refuse('todos_verify_ids', 'Item IDs or order differ', { key });
      out.items.forEach((item, i) => {
        const s = src.items[i];
        if (item.parentId !== s.parentId || item.siblingIndex !== s.siblingIndex) refuse('todos_verify_tree', 'parent/sibling_index differ', { key, id: s.id });
        if (Object.keys(item).sort().join(',') !== Object.keys(s).sort().join(',')) refuse('todos_verify_fields', 'Item field set (unknown fields) differs', { key, id: s.id });
      });
      if (canonicalText(out) !== canonicalText(src)) refuse('todos_verify_hash', 'Canonical document hash differs after export', { key });
      exported[key] = out;
      items += out.items.length;
    }
    return { workspaces: keys.length, items, canonicalHash: canonicalDocsHash(exported) };
  } finally {
    db.close();
  }
}

/**
 * Import into a new staging store, verify, publish and select the sqlite backend.
 *
 * @param {{ dataDir: string, datasetGeneration: string, confirmPlanHash: string, minQuietMs?: number, now?: () => number, afterImport?: () => void, beforePublish?: () => void }} options
 */
export function applyTodosMigration(options) {
  const dataDir = path.resolve(options.dataDir);
  const plan = planTodosMigration(options);
  if (options.confirmPlanHash !== plan.planHash) refuse('todos_plan_mismatch', 'The confirmed plan hash does not match the current sources; re-run the plan');
  const source = readSourceManifest(dataDir, options);
  const partial = path.join(dataDir, 'todos-migration.partial');
  discardOwnPartial(partial);
  fs.mkdirSync(partial, { mode: 0o700 });
  writeFileExclusiveDurable(path.join(partial, PARTIAL_MARKER_FILE), JSON.stringify({ tool: 'todos-migration', planHash: plan.planHash }));
  const handle = openStorageDb({ dir: partial, filename: TODOS_SQLITE_FILE, create: true });
  try {
    bindDatasetGeneration(handle.db, options.datasetGeneration);
    const ctx = { prepare: (sql) => handle.db.prepare(sql) };
    handle.db.exec('BEGIN IMMEDIATE');
    try {
      for (const key of Object.keys(source.docs).sort()) offlineHandlers.importDocument(ctx, { workspaceKey: key, doc: source.docs[key] });
      handle.db.exec('COMMIT');
    } catch (error) {
      handle.db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    handle.close();
  }
  const stagedStore = path.join(partial, TODOS_SQLITE_FILE);
  const verification = verifyTodosStoreAgainstDocs(stagedStore, source.docs);
  // The sources must be exactly what the plan hashed: a writer that ran meanwhile voids the migration.
  options.afterImport?.();
  const again = readSourceManifest(dataDir, { ...options, minQuietMs: 0 });
  if (again.manifestHash !== source.manifestHash) refuse('todos_source_changed', 'The todos documents changed while the migration ran; nothing was published');
  options.beforePublish?.();
  const target = path.join(dataDir, TODOS_SQLITE_FILE);
  if (lstatOrNull(target)) refuse('todos_store_exists', 'A todos store file appeared while the tool was running; nothing was overwritten');
  fs.renameSync(stagedStore, target);
  fsyncDirectory(dataDir);
  discardOwnPartial(partial);
  const marker = writeTodosBackendMarker(dataDir, {
    backend: 'sqlite', datasetGeneration: options.datasetGeneration, storeFile: TODOS_SQLITE_FILE,
    sourceManifestHash: source.manifestHash, importedDocsHash: verification.canonicalHash,
  }, { expectedRevision: 0 });
  // Legacy JSON stays as a read-only record of the pre-cutover state.
  for (const file of source.files) fs.chmodSync(path.join(dataDir, 'todos', `${file.key}.json`), 0o444);
  return { planHash: plan.planHash, manifestHash: source.manifestHash, totals: source.totals, verification, marker };
}

/**
 * Receipts and documents of a store: its "durable ACK" fingerprint.
 *
 * @param {string} dbPath
 */
export function readTodosStoreFingerprint(dbPath) {
  const db = openImmutableDatabase(dbPath);
  try {
    const ctx = { prepare: (sql) => db.prepare(sql) };
    const docs = {};
    for (const w of offlineHandlers.workspaces(ctx).workspaces) docs[w.workspaceKey] = offlineHandlers.exportDocument(ctx, { workspaceKey: w.workspaceKey });
    const receipts = db.prepare('SELECT dataset_generation, command_id, request_digest, result_json, created_at FROM command_receipts ORDER BY dataset_generation, command_id').all()
      .map((r) => ({ ...r }));
    const fence = Number(db.prepare('SELECT hwm FROM storage_fencing WHERE id = 1').get()?.hwm ?? 0);
    const binding = db.prepare('SELECT dataset_generation FROM storage_dataset_binding WHERE id = 1').get();
    return { docs, receipts, fence, datasetGeneration: binding ? String(binding.dataset_generation) : null, docsHash: canonicalDocsHash(docs), receiptsHash: sha256(canonicalText(receipts)) };
  } finally {
    db.close();
  }
}

/**
 * Write a fresh logical export of the SQLite store: legacy documents + `rollback-control/`.
 * The store file is hashed before and after; a change aborts (`todos_store_changed_during_export`).
 *
 * @param {{ dataDir: string, outDir: string }} options
 */
export function exportTodosRollback(options) {
  const dataDir = path.resolve(options.dataDir);
  const marker = readTodosBackendMarker(dataDir);
  if (marker.backend !== 'sqlite') refuse('todos_rollback_not_sqlite', 'Only a sqlite todos backend has anything to export');
  const dbPath = path.join(dataDir, marker.storeFile ?? TODOS_SQLITE_FILE);
  const out = path.resolve(options.outDir);
  if (lstatOrNull(out)) refuse('todos_output_exists', 'The output path exists; nothing was overwritten');
  const before = hashFile(dbPath);
  const fingerprint = readTodosStoreFingerprint(dbPath);
  const partial = `${out}.partial`;
  discardOwnPartial(partial);
  fs.mkdirSync(path.join(partial, 'todos'), { recursive: true, mode: 0o700 });
  writeFileExclusiveDurable(path.join(partial, PARTIAL_MARKER_FILE), JSON.stringify({ tool: 'todos-rollback' }));
  const files = [];
  for (const key of Object.keys(fingerprint.docs).sort()) {
    const text = JSON.stringify(fingerprint.docs[key]);
    writeFileExclusiveDurable(path.join(partial, 'todos', `${key}.json`), text);
    files.push({ key, sha256: sha256(text), bytes: Buffer.byteLength(text), items: fingerprint.docs[key].items.length });
  }
  const control = path.join(partial, TODOS_ROLLBACK_CONTROL_DIR);
  fs.mkdirSync(control);
  writeFileExclusiveDurable(path.join(control, 'receipts.json'), JSON.stringify(fingerprint.receipts));
  const after = hashFile(dbPath);
  if (after.sha256 !== before.sha256) refuse('todos_store_changed_during_export', 'The store changed while it was exported; quiesce every writer and retry');
  const manifest = {
    schema: TODOS_ROLLBACK_SCHEMA, datasetGeneration: fingerprint.datasetGeneration, files,
    totals: { files: files.length, items: files.reduce((n, f) => n + f.items, 0) },
    docsHash: fingerprint.docsHash, receiptsHash: fingerprint.receiptsHash, receiptCount: fingerprint.receipts.length,
    fenceHighWater: fingerprint.fence, storeSha256: before.sha256, markerRevision: marker.revision,
    plainLegacyBinaryCompatible: false,
    requiredControlActions: ['keep the sqlite store and receipts read-only', 'start only the sidecar-aware legacy runtime', 'do not point an older binary at these documents without the marker'],
  };
  writeFileExclusiveDurable(path.join(control, TODOS_ROLLBACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  fs.rmSync(path.join(partial, PARTIAL_MARKER_FILE));
  publishDirectory(partial, out);
  return { outDir: out, manifestHash: sha256(JSON.stringify(manifest, null, 2)), manifest };
}

/** @param {string} dir @returns {{ manifest: Record<string, any>, manifestHash: string }} */
function readExportManifest(dir) {
  const file = path.join(path.resolve(dir), TODOS_ROLLBACK_CONTROL_DIR, TODOS_ROLLBACK_MANIFEST_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return refuse('todos_rollback_source_stale', 'The directory is not a rollback export (no rollback-control manifest); an old JSON backup cannot be a rollback source once the sqlite backend accepted writes');
  }
  const manifest = JSON.parse(text);
  if (manifest.schema !== TODOS_ROLLBACK_SCHEMA) refuse('todos_rollback_source_invalid', 'Unknown rollback manifest schema');
  return { manifest, manifestHash: sha256(text) };
}

/**
 * Check the files of an export against its manifest (and optionally against the current store).
 *
 * @param {{ exportDir: string, dataDir?: string }} options
 */
export function verifyTodosRollbackExport(options) {
  const dir = path.resolve(options.exportDir);
  const { manifest, manifestHash } = readExportManifest(dir);
  const docs = {};
  for (const file of manifest.files) {
    const text = fs.readFileSync(path.join(dir, 'todos', `${file.key}.json`), 'utf8');
    if (sha256(text) !== file.sha256) refuse('todos_rollback_export_corrupt', 'An export document does not match its manifest hash', { key: file.key });
    docs[file.key] = JSON.parse(text);
  }
  let receipts;
  try {
    receipts = JSON.parse(fs.readFileSync(path.join(dir, TODOS_ROLLBACK_CONTROL_DIR, 'receipts.json'), 'utf8'));
  } catch {
    return refuse('todos_rollback_export_corrupt', 'The export sidecar receipts cannot be read');
  }
  if (sha256(canonicalText(receipts)) !== manifest.receiptsHash || receipts.length !== manifest.receiptCount) {
    refuse('todos_rollback_export_corrupt', 'The export receipts do not match the manifest');
  }
  const present = fs.readdirSync(path.join(dir, 'todos')).filter((n) => SOURCE_FILE_RE.test(n)).length;
  if (present !== manifest.files.length) refuse('todos_rollback_export_corrupt', 'The export holds documents the manifest does not list');
  if (canonicalDocsHash(docs) !== manifest.docsHash) refuse('todos_rollback_export_corrupt', 'The export documents do not match the canonical hash');
  if (options.dataDir) {
    const marker = readTodosBackendMarker(options.dataDir);
    if (marker.backend === 'sqlite') {
      const fp = readTodosStoreFingerprint(path.join(path.resolve(options.dataDir), marker.storeFile ?? TODOS_SQLITE_FILE));
      if (fp.docsHash !== manifest.docsHash || fp.receiptsHash !== manifest.receiptsHash || fp.fence !== manifest.fenceHighWater) {
        refuse('todos_rollback_export_stale', 'The store accepted writes after this export was made; export again');
      }
    }
  }
  return { manifestHash, manifest, totals: manifest.totals, receipts };
}

export const TODOS_ROLLBACK_STATE_FILE = 'todos-rollback-state.json';
export const TODOS_ROLLBACK_STATE_SCHEMA = 'cretli-todos-rollback-state-v1';

/** @param {string} dataDir @returns {string} */
export function rollbackStatePath(dataDir) {
  return path.join(path.resolve(dataDir), TODOS_ROLLBACK_STATE_FILE);
}

/**
 * Hash every live `todos/<key>.json`.
 *
 * @param {string} dataDir
 * @returns {Record<string, string>} key -> sha256
 */
export function hashLiveTodoFiles(dataDir) {
  const dir = path.join(path.resolve(dataDir), 'todos');
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (SOURCE_FILE_RE.test(name)) out[name.slice(0, -5)] = sha256(fs.readFileSync(path.join(dir, name)));
  }
  return out;
}

/**
 * Committed state of the rollback legacy runtime: the manifest it started from, the live document
 * hashes, the fencing high-water mark and the receipt ledger (export receipts + later commands).
 *
 * @param {string} dataDir
 * @returns {Record<string, any>}
 */
export function readRollbackState(dataDir) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(rollbackStatePath(dataDir), 'utf8'));
  } catch {
    return refuse('todos_rollback_state_missing', 'The rollback runtime state file is missing or unreadable; fail closed');
  }
  if (!state || state.schema !== TODOS_ROLLBACK_STATE_SCHEMA || !Number.isSafeInteger(state.fence) || !state.files || !state.receipts) {
    refuse('todos_rollback_state_invalid', 'The rollback runtime state file is inconsistent');
  }
  return state;
}

/** @param {string} dataDir @param {Record<string, any>} state */
export function writeRollbackState(dataDir, state) {
  replaceOwnFileDurable(rollbackStatePath(dataDir), JSON.stringify(state));
}

/**
 * Is `sourceDir` an acceptable rollback source for the current dataDir?
 * Before any durable ACK of the sqlite backend the original JSON still equals the store; afterwards only a
 * fresh export does.
 *
 * @param {{ dataDir: string, sourceDir: string }} options sourceDir: a directory holding `todos/*.json`, or an export
 * @returns {{ acceptable: true, kind: 'original-json' | 'fresh-export' }}
 */
export function assertTodosRollbackSource(options) {
  const dataDir = path.resolve(options.dataDir);
  const marker = readTodosBackendMarker(dataDir);
  if (marker.backend !== 'sqlite') refuse('todos_rollback_not_sqlite', 'The sqlite backend is not selected');
  const fp = readTodosStoreFingerprint(path.join(dataDir, marker.storeFile ?? TODOS_SQLITE_FILE));
  const acked = fp.receipts.length > 0 || fp.docsHash !== marker.importedDocsHash;
  const hasManifest = lstatOrNull(path.join(path.resolve(options.sourceDir), TODOS_ROLLBACK_CONTROL_DIR, TODOS_ROLLBACK_MANIFEST_FILE));
  if (hasManifest) {
    verifyTodosRollbackExport({ exportDir: options.sourceDir, dataDir });
    return { acceptable: true, kind: 'fresh-export' };
  }
  if (acked) {
    refuse('todos_rollback_source_stale', 'The sqlite backend accepted durable writes; an old JSON backup would lose them. Export the store with the rollback tool.', { receipts: fp.receipts.length });
  }
  const manifest = readSourceManifest(options.sourceDir, { minQuietMs: 0 });
  if (manifest.manifestHash !== marker.sourceManifestHash) refuse('todos_rollback_source_stale', 'The JSON sources differ from the manifest recorded at the migration');
  return { acceptable: true, kind: 'original-json' };
}

/**
 * Replace the JSON documents with a verified export and select the sidecar-honouring legacy runtime.
 * The previous `todos/` directory is preserved next to it, never deleted.
 *
 * @param {{ dataDir: string, exportDir: string, now?: () => number }} options
 */
export function activateTodosRollback(options) {
  const dataDir = path.resolve(options.dataDir);
  const marker = readTodosBackendMarker(dataDir);
  if (marker.backend !== 'sqlite') refuse('todos_rollback_not_sqlite', 'The sqlite backend is not selected');
  const verified = verifyTodosRollbackExport({ exportDir: options.exportDir, dataDir });
  const exportDir = path.resolve(options.exportDir);
  const todosDir = path.join(dataDir, 'todos');
  const kept = `${todosDir}.pre-rollback-${(options.now ?? Date.now)()}`;
  if (lstatOrNull(todosDir)) fs.renameSync(todosDir, kept);
  fs.mkdirSync(todosDir, { recursive: true });
  for (const file of verified.manifest.files) {
    replaceOwnFileDurable(path.join(todosDir, `${file.key}.json`), fs.readFileSync(path.join(exportDir, 'todos', `${file.key}.json`), 'utf8'));
  }
  /** @type {Record<string, { requestDigest: string, resultJson: string }>} */
  const receipts = {};
  for (const r of verified.receipts) receipts[`${r.dataset_generation}\u0000${r.command_id}`] = { requestDigest: r.request_digest, resultJson: r.result_json };
  // The sidecar becomes live state BEFORE the marker is published: a runtime never starts without it.
  writeRollbackState(dataDir, {
    schema: TODOS_ROLLBACK_STATE_SCHEMA, manifestHash: verified.manifestHash, datasetGeneration: marker.datasetGeneration,
    fence: verified.manifest.fenceHighWater, files: hashLiveTodoFiles(dataDir), receipts,
  });
  const next = writeTodosBackendMarker(dataDir, {
    backend: 'legacy-rollback', exportManifestHash: verified.manifestHash, exportDir, datasetGeneration: marker.datasetGeneration,
  }, { expectedRevision: marker.revision });
  return { marker: next, preservedDirectory: kept, manifestHash: verified.manifestHash };
}

/**
 * Startup check of the `legacy-rollback` marker: the export it pins must verify (manifest hash,
 * documents, receipts), the runtime state must belong to that manifest, and every live document must
 * hash exactly as the last committed state recorded. Anything else fails closed.
 *
 * @param {string} dataDir
 * @param {{ exportManifestHash: string | null, exportDir: string | null }} marker
 * @returns {Record<string, any>} the runtime state
 */
export function assertRollbackExportMatchesMarker(dataDir, marker) {
  const verified = verifyTodosRollbackExport({ exportDir: /** @type {string} */ (marker.exportDir) });
  if (verified.manifestHash !== marker.exportManifestHash) refuse('todos_rollback_export_mismatch', 'The rollback export does not match the manifest hash pinned by the marker');
  const state = readRollbackState(dataDir);
  if (state.manifestHash !== marker.exportManifestHash) refuse('todos_rollback_state_invalid', 'The rollback runtime state belongs to another export');
  if (state.fence < verified.manifest.fenceHighWater) refuse('todos_rollback_state_invalid', 'The fencing high-water mark went backwards');
  const live = hashLiveTodoFiles(dataDir);
  const keys = new Set([...Object.keys(live), ...Object.keys(state.files)]);
  for (const key of keys) {
    if (live[key] === undefined) refuse('todos_rollback_export_mismatch', 'A rollback document is missing from todos/', { key });
    if (live[key] !== state.files[key]) refuse('todos_rollback_export_mismatch', 'A live todos document differs from the last committed rollback state', { key });
  }
  return state;
}
