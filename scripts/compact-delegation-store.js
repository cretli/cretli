#!/usr/bin/env node
/**
 * Compact the delegation store with the production retention pass
 * (`lib/delegation-retention.js`): archive finished, fully delivered jobs
 * (report cut to 2000 characters, task text cleared, verdict kept) and trim
 * old delivered mailbox bodies to a preview (body hash kept for replay).
 * Rows are never deleted.
 *
 * Usage:
 *   node scripts/compact-delegation-store.js [--data-dir DIR] [--dry-run | --apply]
 *     [--trim-after-days N] [--json]
 *
 * `--dry-run` is the default: it reads the store, prints what would change and
 * writes nothing. It runs the pass on a temporary copy of the store files, so
 * the real files are only read (no -wal/-shm, no mtime change). On the SQLite
 * backend it refuses an older schema file, because opening that file would
 * upgrade it. `--apply` needs the server stopped: it takes the exclusive
 * delegation owner lock (a live server holds it, so the run is refused), copies
 * the store files to `<data-dir>/backups/delegation-compact-<stamp>/`, runs
 * the pass and prints the size report. Keep the backup until you have checked
 * the result; restoring it (server stopped) is the rollback.
 *
 * The backend follows `CRETLI_DELEGATION_STORE` exactly like the server.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE_FILES = Object.freeze([
  'delegations.json',
  'delegation-mailbox.json',
  'delegations.sqlite',
  'delegations.sqlite-wal',
  'delegations.sqlite-shm',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string[]} argv
 * @returns {{ dataDir: string, apply: boolean, trimAfterMs: number, json: boolean }}
 */
function parseArgs(argv) {
  const out = { dataDir: '', apply: false, trimAfterMs: 0, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--data-dir') out.dataDir = String(argv[++i] || '');
    else if (arg === '--trim-after-days') out.trimAfterMs = Number(argv[++i]) * DAY_MS;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.trimAfterMs && !(out.trimAfterMs > 0)) throw new Error('--trim-after-days must be a positive number');
  return out;
}

/**
 * @param {string} dataDir
 * @returns {Record<string, number>}
 */
function readStoreSizes(dataDir) {
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const name of STORE_FILES) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) sizes[name] = fs.statSync(file).size;
  }
  return sizes;
}

/**
 * @param {string} dataDir
 * @returns {string} backup directory
 */
function backupStore(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dataDir, 'backups', `delegation-compact-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of STORE_FILES) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, name));
  }
  return dir;
}

/**
 * Opening an older SQLite file upgrades its schema, so a dry run refuses it
 * instead of changing the store (possibly under a live server).
 */
async function assertDryRunLeavesStoreUntouched() {
  const { getDelegationStoreBackend } = await import('../lib/persist/delegation-store-backend.js');
  if (getDelegationStoreBackend() !== 'sqlite') return;
  const { probeDelegationSqliteSchemaVersion } = await import('../lib/persist/delegation-sqlite.js');
  const { DELEGATION_SQLITE_SCHEMA_VERSION } = await import('../lib/persist/delegation-schema.js');
  const version = probeDelegationSqliteSchemaVersion();
  if (version > 0 && version < DELEGATION_SQLITE_SCHEMA_VERSION) {
    throw new Error(`delegations.sqlite is schema ${version}; opening it upgrades it to ${DELEGATION_SQLITE_SCHEMA_VERSION}. `
      + 'Stop the server and run with --apply (it backs the store up first).');
  }
}

/**
 * Data dir the server would use, resolved like `lib/runtime-paths.js` without
 * importing it (its value is fixed at import time).
 *
 * @param {string} dataDirArg
 * @returns {string}
 */
function resolveSourceDataDir(dataDirArg) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // `--data-dir` is relative to the cwd (shell convention); the env value is
  // relative to the project root, like `lib/runtime-paths.js`.
  if (dataDirArg) return path.resolve(dataDirArg);
  const configured = String(process.env.CRETLI_DATA_DIR || process.env.CURSOR_REMOTE_DATA_DIR || '').trim();
  return configured ? path.resolve(projectRoot, configured) : path.join(projectRoot, 'data');
}

/**
 * Copy the store files into a fresh temp dir so a dry run can open them for
 * writing (WAL, migrations) without touching the real files. `todos/` is
 * copied too: the retention pass reads leaf status from it, so without it every
 * leaf looks open and the plan would differ from `--apply`.
 *
 * @param {string} sourceDir
 * @param {string} tmp existing temp dir
 */
function copyStoreToTemp(sourceDir, tmp) {
  for (const name of STORE_FILES) {
    const file = path.join(sourceDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, name));
  }
  const todos = path.join(sourceDir, 'todos');
  if (fs.existsSync(todos)) fs.cpSync(todos, path.join(tmp, 'todos'), { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolveSourceDataDir(args.dataDir);
  // Every persist module resolves its paths at import time, so the data dir
  // must be in the environment before the first import below. A dry run points
  // it at a temp copy and reports the real directory.
  const tempDir = args.apply ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-dry-'));
  try {
    if (tempDir) copyStoreToTemp(sourceDir, tempDir);
    process.env.CRETLI_DATA_DIR = tempDir || sourceDir;
    await run(args, sourceDir);
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} sourceDir
 */
async function run(args, sourceDir) {
  const { acquireDelegationOwnerLock, releaseDelegationOwnerLock } = await import('../lib/delegation-owner-lock.js');
  const { applyDelegationRetention } = await import('../lib/delegation-retention.js');
  const dataDir = sourceDir;
  const before = readStoreSizes(dataDir);
  const options = args.trimAfterMs ? { trimAfterMs: args.trimAfterMs } : {};
  /** @type {Record<string, unknown>} */
  let report;
  if (!args.apply) {
    await assertDryRunLeavesStoreUntouched();
    report = { mode: 'dry-run', dataDir, sizes: before, ...applyDelegationRetention({ ...options, dryRun: true }) };
  } else {
    acquireDelegationOwnerLock();
    try {
      const backupDir = backupStore(dataDir);
      const result = applyDelegationRetention(options);
      report = { mode: 'apply', dataDir, backupDir, before, after: readStoreSizes(dataDir), ...result };
    } finally {
      releaseDelegationOwnerLock();
    }
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(report)) {
    console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
