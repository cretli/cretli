/**
 * One fresh-process sample of the A1 layout experiment
 * (scripts/storage-layout-experiment.mjs). Usage: `node child.mjs <mode> <dir>`.
 * Module loading happens before the first timestamp and is excluded; a fresh
 * process means SQLite per-connection state and JIT are cold while the OS page
 * cache stays warm (no cold-disk claim). Prints exactly one JSON line on
 * success. On ANY failure (corrupt store, FK violation, barrier failure) it
 * prints a `{ ok: false, stage, ... }` line, exits 3 and never emits a ready
 * marker or a cold page, mirroring the worker's "no READY/ACK" contract.
 *
 * Modes:
 *  - `reopen`: A1 definition = production openStorageDb (read-only
 *    integrity_check + foreign_key_check, WAL + FULL, migrations) + production
 *    TRUNCATE barrier + one cold `history.readLatest` page, as one total.
 *  - `e2e`: production worker host start (thread spawn, handler import, open,
 *    barrier, ready) + first cold page; phases from the worker `ready` message.
 *  - `components`: the individual open steps with the same primitives (checks
 *    run in full on a read-only connection with the production mmap window).
 *  - `json`: JSON cold load (read + parse every chat file) for the denominator.
 * Env `CRETLI_LAYOUT_BARRIER_FAULT=1` (test seam of this script only) makes the
 * barrier see a busy checkpoint result.
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStorageDb, runWalTruncateBarrier, DEFAULT_STORAGE_DB_FILENAME as DB } from '../lib/storage/db-lifecycle.js';
import { CORE_MIGRATIONS, applyMigrations, inspectSchemaVersions, readHeaderSchemaVersion } from '../lib/storage/migrations.js';
import { createGuardedConnection } from '../lib/storage/handler-sql-guard.js';
import { queries, createChatHistoryStore } from '../lib/storage/chat-history-store.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { HANDLERS_PATH, pageRequest } from './storage-layout-lib.mjs';

const MAPPED_BYTES = 256 * 1024 * 1024; // mirrors READONLY_CHECK_MMAP_BYTES (not exported)
const [mode, dir] = process.argv.slice(2);
const now = () => performance.now();
const GENERATION = 'medium';

function fail(stage, error, extra = {}) {
  console.log(JSON.stringify({ ok: false, stage, error: String(error?.code || error?.message || error), ...extra }));
  process.exit(3);
}

function coldReadLatest(handle) {
  const ctx = createGuardedConnection(handle.db, (sql) => handle.db.prepare(sql));
  handle.db.exec('PRAGMA query_only = ON');
  handle.db.exec('BEGIN');
  try {
    return queries['history.readLatest'](ctx, pageRequest(GENERATION));
  } finally {
    handle.db.exec('ROLLBACK');
    handle.db.exec('PRAGMA query_only = OFF');
  }
}

/** Effective pragmas and full re-verification AFTER the timed section (evidence only). */
function describeAndVerify(db) {
  const pragma = (p) => db.prepare(`PRAGMA ${p}`).get()[p];
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  return {
    effective: {
      page_size: Number(pragma('page_size')), page_count: Number(pragma('page_count')), freelist_count: Number(pragma('freelist_count')),
      journal_mode: String(pragma('journal_mode')), synchronous: Number(pragma('synchronous')), foreign_keys: Number(pragma('foreign_keys')),
      mmap_size: Number(pragma('mmap_size')), cache_size: Number(pragma('cache_size')), wal_autocheckpoint: Number(pragma('wal_autocheckpoint')),
    },
    verify: { integrityOk: integrity.length === 1 && integrity[0].integrity_check === 'ok', foreignKeyViolations: fk.length },
  };
}

function barrier(db) {
  if (process.env.CRETLI_LAYOUT_BARRIER_FAULT === '1') {
    return runWalTruncateBarrier(/** @type {any} */ ({ prepare: () => ({ get: () => ({ busy: 1, log: 1, checkpointed: 0 }) }) }));
  }
  return runWalTruncateBarrier(db);
}

const walBytes = () => { try { return fs.statSync(path.join(dir, `${DB}-wal`)).size; } catch { return 0; } };

if (mode === 'reopen') {
  const walBefore = walBytes();
  let handle;
  const t0 = now();
  try { handle = openStorageDb({ dir }); } catch (e) { fail('open', e); }
  const t1 = now();
  let f29;
  try { f29 = barrier(handle.db); } catch (e) { fail('barrier', e); }
  const t2 = now();
  const page = coldReadLatest(handle);
  const t3 = now();
  const { effective, verify } = describeAndVerify(handle.db);
  handle.close();
  console.log(JSON.stringify({ ok: true, mode, openMs: t1 - t0, barrierMs: t2 - t1, coldReadMs: t3 - t2, totalMs: t3 - t0, coldPageEvents: page.events.length, f29, walBytesBefore: walBefore, ...effectiveWrap(effective), verify }));
} else if (mode === 'e2e') {
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const t0 = now();
  try { await host.start(); } catch (e) { fail('ready', e); }
  const startMs = now() - t0;
  const phases = host.getMetrics().lastStart;
  const store = createChatHistoryStore({ host });
  const t1 = now();
  const page = await store.readLatest(pageRequest(GENERATION));
  const coldReadMs = now() - t1;
  await host.close();
  const db = new DatabaseSync(path.join(dir, DB), { readOnly: true });
  let described;
  try { described = describeAndVerify(db); } finally { db.close(); }
  console.log(JSON.stringify({ ok: true, mode, startMs, coldReadMs, totalMs: startMs + coldReadMs, phases, coldPageEvents: page.events.length, ...effectiveWrap(described.effective), verify: described.verify }));
} else if (mode === 'components') {
  const out = { ok: true, mode };
  const file = path.join(dir, DB);
  let t = now();
  try {
    const ro = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    ro.exec(`PRAGMA mmap_size = ${MAPPED_BYTES}`);
    out.roOpenMs = now() - t; t = now();
    ro.prepare('PRAGMA application_id').all();
    readHeaderSchemaVersion(ro);
    inspectSchemaVersions(ro, CORE_MIGRATIONS);
    out.peeksMs = now() - t; t = now();
    const integrity = ro.prepare('PRAGMA integrity_check').all();
    out.integrityMs = now() - t; t = now();
    const fk = ro.prepare('PRAGMA foreign_key_check').all();
    out.foreignKeyMs = now() - t; t = now();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || fk.length > 0) fail('checks', 'integrity or foreign key violation');
    ro.close();
    out.roCloseMs = now() - t; t = now();
    const db = new DatabaseSync(file, { timeout: 5000 });
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    out.rwOpenMs = now() - t; t = now();
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
    out.walPragmaMs = now() - t; t = now();
    applyMigrations(db, { migrations: CORE_MIGRATIONS });
    out.migrationsMs = now() - t; t = now();
    out.f29 = barrier(db);
    out.barrierMs = now() - t;
    out.componentsTotalMs = out.roOpenMs + out.peeksMs + out.integrityMs + out.foreignKeyMs + out.roCloseMs + out.rwOpenMs + out.walPragmaMs + out.migrationsMs + out.barrierMs;
    db.close();
  } catch (e) { fail('components', e); }
  console.log(JSON.stringify(out));
} else if (mode === 'json') {
  const t0 = now();
  let events = 0;
  let files = 0;
  for (const name of fs.readdirSync(dir)) { events += JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).events.length; files += 1; }
  console.log(JSON.stringify({ ok: true, mode, coldLoadMs: now() - t0, events, files }));
} else {
  fail('args', `unknown mode ${mode}`);
}

function effectiveWrap(effective) { return { effective }; }
