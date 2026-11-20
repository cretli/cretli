#!/usr/bin/env node
/**
 * Offline tool: move `leafMaterial` of done todos into the content-addressed store
 * (`<dataDir>/todo-material/`), or move it back inline (`--inline-back`, the rollback path).
 * Design: docs/todo-scalable-architecture.md sections 3.5 and 4 (phase 0b).
 *
 *   node scripts/externalize-todo-material.js --data-dir <dir>                 dry run (default, writes nothing)
 *   node scripts/externalize-todo-material.js --data-dir <dir> --apply --confirm-backup <backup-dir>
 *   node scripts/externalize-todo-material.js --data-dir <dir> --apply --inline-back --confirm-backup <backup-dir>
 *
 * `--confirm-backup` points to an existing directory holding a copy of `todos/` (either `<dir>/todos/*.json`
 * or the json files directly) whose per-file sha256 matches the live files. The server must be stopped.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { assertWritersStopped } from '../lib/backup/offline/managed-files.js';
import { withWorkspaceWatchersFileLock } from '../lib/persist/workspace-watchers-persist.js';
import { replaceOwnFileDurable } from '../lib/storage/history-migration-fs.js';
import { getTodoMaterialStore, isTodoMaterialRef } from '../lib/todo-material-store.js';

const DOC_RE = /^[0-9a-f]{64}\.json$/;

export class ExternalizeRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ExternalizeRefusal';
    this.code = code;
  }
}

/** @param {string | Buffer} bytes */
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** @param {unknown} value @returns {string} key-sorted JSON, stable across property order */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {unknown} material @returns {boolean} */
const isInlineMaterial = (material) => Boolean(material) && typeof material === 'object' && !Array.isArray(material) && !isTodoMaterialRef(material);

/**
 * @param {string[]} argv
 * @returns {{ dataDir: string, apply: boolean, inlineBack: boolean, confirmBackup: string, json: boolean }}
 */
export function parseArgs(argv) {
  const out = { dataDir: '', apply: false, inlineBack: false, confirmBackup: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--inline-back') out.inlineBack = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--data-dir') out.dataDir = String(argv[++i] || '');
    else if (arg === '--confirm-backup') out.confirmBackup = String(argv[++i] || '');
    else throw new ExternalizeRefusal('usage', `Unknown argument: ${arg}`);
  }
  out.dataDir = path.resolve(out.dataDir || resolveDataPath());
  return out;
}

/**
 * @param {string} dataDir
 * @returns {Array<{ name: string, file: string, text: string, doc: any }>}
 */
function readDocuments(dataDir) {
  const dir = path.join(dataDir, 'todos');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => DOC_RE.test(n)).sort().map((name) => {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    let doc;
    try { doc = JSON.parse(text); } catch { throw new ExternalizeRefusal('document_invalid', `${name} is not valid JSON`); }
    if (!doc || !Array.isArray(doc.items)) throw new ExternalizeRefusal('document_invalid', `${name} has no items array`);
    return { name, file, text, doc };
  });
}

/**
 * Dry-run report: what would move and how it will be verified.
 *
 * @param {string} dataDir
 * @param {{ inlineBack?: boolean }} [options]
 */
export function planExternalization(dataDir, options = {}) {
  const workspaces = readDocuments(dataDir).map(({ name, text, doc }) => {
    let candidates = 0;
    let bytes = 0;
    let references = 0;
    for (const item of doc.items) {
      if (options.inlineBack) {
        if (isTodoMaterialRef(item?.leafMaterial)) { references += 1; bytes += item.leafMaterial.bytes || 0; }
      } else if (item?.status === 'done' && isInlineMaterial(item.leafMaterial)) {
        candidates += 1;
        bytes += Buffer.byteLength(JSON.stringify(item.leafMaterial));
      } else if (isTodoMaterialRef(item?.leafMaterial)) {
        references += 1;
      }
    }
    return { workspace: name.slice(0, -5), items: doc.items.length, documentBytes: Buffer.byteLength(text), candidates, references, bytesToMove: bytes };
  });
  return {
    mode: options.inlineBack ? 'inline-back' : 'externalize',
    workspaces,
    totals: {
      items: workspaces.reduce((n, w) => n + w.items, 0),
      candidates: workspaces.reduce((n, w) => n + (options.inlineBack ? w.references : w.candidates), 0),
      bytesToMove: workspaces.reduce((n, w) => n + w.bytesToMove, 0),
    },
    verificationPlan: [
      'refuse unless --confirm-backup holds a todos/ copy whose per-file sha256 matches the live files',
      'refuse while the server or any known writer is active',
      options.inlineBack
        ? 'read every reference back (hash verified) and rewrite the document with inline material'
        : 'publish content (pin, fsync, rename, fsync dir) before rewriting each document, then consume the pins',
      'after writing, re-read each document and compare the canonical hash of the fully hydrated document with the original',
      'verify reference closure: every $ref has an intact file',
    ],
  };
}

/**
 * @param {string} dataDir
 * @param {string} backupDir
 * @param {Array<{ name: string, text: string }>} docs
 */
function assertBackupMatches(dataDir, backupDir, docs) {
  if (!backupDir) throw new ExternalizeRefusal('backup_required', '--apply requires --confirm-backup <dir>');
  const root = path.resolve(backupDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ExternalizeRefusal('backup_missing', 'The confirmed backup directory does not exist');
  if (root === path.resolve(dataDir) || root === path.join(path.resolve(dataDir), 'todos')) {
    throw new ExternalizeRefusal('backup_is_live', 'The backup must be a separate copy, not the live data');
  }
  const base = fs.existsSync(path.join(root, 'todos')) ? path.join(root, 'todos') : root;
  for (const { name, text } of docs) {
    const copy = path.join(base, name);
    if (!fs.existsSync(copy)) throw new ExternalizeRefusal('backup_mismatch', `The backup has no copy of ${name}`);
    if (sha256(fs.readFileSync(copy)) !== sha256(text)) throw new ExternalizeRefusal('backup_mismatch', `The backup copy of ${name} differs from the live file`);
  }
}

/**
 * @param {{ name: string, file: string, doc: any, text: string }} entry
 * @param {boolean} inlineBack
 * @param {ReturnType<typeof getTodoMaterialStore>} store
 * @returns {{ moved: number, bytes: number }}
 */
function rewriteDocument(entry, inlineBack, store) {
  const { doc, file, name } = entry;
  /** @type {any[]} */
  const published = [];
  let moved = 0;
  let bytes = 0;
  const items = doc.items.map((/** @type {any} */ item) => {
    if (inlineBack) {
      if (!isTodoMaterialRef(item?.leafMaterial)) return item;
      moved += 1;
      bytes += item.leafMaterial.bytes || 0;
      return { ...item, leafMaterial: store.read(item.leafMaterial) };
    }
    if (item?.status !== 'done' || !isInlineMaterial(item.leafMaterial)) return item;
    const ref = store.publish(item.leafMaterial);
    published.push(ref);
    moved += 1;
    bytes += ref.bytes;
    return { ...item, leafMaterial: ref };
  });
  if (!moved) return { moved, bytes };
  const next = { ...doc, items };
  // Pins are validated, the document is replaced durably and the pins are released inside the store fence.
  store.commit(published, () => replaceOwnFileDurable(file, JSON.stringify(next)));
  // Verification: the fully hydrated document must equal the original one.
  const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
  /** @param {any} document */
  const hydrate = (document) => ({ ...document, items: document.items.map((/** @type {any} */ item) => (isTodoMaterialRef(item?.leafMaterial) ? { ...item, leafMaterial: store.read(item.leafMaterial) } : item)) });
  if (sha256(canonical(hydrate(reread))) !== sha256(canonical(hydrate(doc)))) {
    throw new ExternalizeRefusal('verify_failed', `Canonical hash mismatch after rewriting ${name}; restore it from the confirmed backup`);
  }
  return { moved, bytes };
}

/**
 * @param {{ dataDir: string, confirmBackup?: string, inlineBack?: boolean }} options
 */
export function applyExternalization(options) {
  const { dataDir } = options;
  assertWritersStopped(dataDir);
  const initial = readDocuments(dataDir);
  assertBackupMatches(dataDir, options.confirmBackup || '', initial);
  const store = getTodoMaterialStore(dataDir);
  return withWorkspaceWatchersFileLock(() => {
    // Re-read under the lock: the backup check above must describe exactly what is rewritten.
    const docs = readDocuments(dataDir);
    assertBackupMatches(dataDir, options.confirmBackup || '', docs);
    const results = docs.map((entry) => ({ workspace: entry.name.slice(0, -5), ...rewriteDocument(entry, Boolean(options.inlineBack), store) }));
    return { results, moved: results.reduce((n, r) => n + r.moved, 0), bytes: results.reduce((n, r) => n + r.bytes, 0) };
  }, { dataDir });
}

/**
 * @param {string[]} argv
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const log = io.log || ((line) => console.log(line));
  const error = io.error || ((line) => console.error(line));
  try {
    const args = parseArgs(argv);
    if (!args.apply) {
      const plan = planExternalization(args.dataDir, { inlineBack: args.inlineBack });
      if (args.json) log(JSON.stringify(plan, null, 2));
      else {
        log(`DRY RUN (${plan.mode}) - nothing is written. Data dir: ${args.dataDir}`);
        for (const w of plan.workspaces) log(`  ${w.workspace}: ${w.items} items, ${w.candidates} to move, ${w.references} already external, ${w.bytesToMove} bytes`);
        log(`Total: ${plan.totals.candidates} items, ${plan.totals.bytesToMove} bytes would move.`);
        log('Verification plan:');
        for (const line of plan.verificationPlan) log(`  - ${line}`);
        log('Re-run with --apply --confirm-backup <dir> to execute.');
      }
      return 0;
    }
    const result = applyExternalization(args);
    log(args.json ? JSON.stringify(result, null, 2) : `Applied: ${result.moved} items, ${result.bytes} bytes.`);
    return 0;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code || 'error';
    error(`REFUSED [${code}]: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
