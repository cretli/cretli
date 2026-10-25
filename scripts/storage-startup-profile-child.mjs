/**
 * Child process of scripts/storage-startup-profile.mjs: one cold-process
 * measurement. Usage: `node child.mjs <dir> <mode> [mmapBytes]`. Modes:
 * `setup` (leave a PRE-CHECKPOINTED -wal behind: the file exists with frames but
 * every frame was already checkpointed, so there is no pending replay; the
 * process exits without close), `components` (times each open component using
 * the same primitives as openStorageDb; `mmapBytes` is applied to the read-only
 * check connection and the EFFECTIVE value read back is reported; the checks
 * themselves always run in full), `full` (times production openStorageDb +
 * barrier end to end). Prints one JSON object.
 */
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openStorageDb, runWalTruncateBarrier, DEFAULT_STORAGE_DB_FILENAME as DB } from '../lib/storage/db-lifecycle.js';
import { CORE_MIGRATIONS, applyMigrations, inspectSchemaVersions, readHeaderSchemaVersion } from '../lib/storage/migrations.js';

const [dir, mode, mmapArg] = process.argv.slice(2);
const file = path.join(dir, DB);
const now = () => performance.now();
if (mode === 'setup') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = FULL');
  const id = db.prepare('PRAGMA application_id').get().application_id;
  db.exec(`PRAGMA application_id = ${id}`);
  const cp = db.prepare('PRAGMA wal_checkpoint(FULL)').get();
  // log === checkpointed proves no frame is left to replay on the next open.
  console.log(JSON.stringify({ walFramesLog: cp.log, walFramesCheckpointed: cp.checkpointed, walBusy: cp.busy }));
  process.exit(0); // no close: the WAL file stays on disk
}
const out = {};
if (mode === 'components') {
  const mmapBytes = Number(mmapArg ?? 0);
  if (!Number.isInteger(mmapBytes) || mmapBytes < 0) throw new Error(`invalid mmapBytes: ${mmapArg}`);
  let t = now();
  const ro = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  ro.exec(`PRAGMA mmap_size = ${mmapBytes}`); // included in roOpenMs, as in openStorageDb
  out.roOpenMs = now() - t;
  out.effectiveMmapSize = Number(ro.prepare('PRAGMA mmap_size').get().mmap_size);
  out.sqliteVersion = ro.prepare('select sqlite_version() v').get().v;
  t = now();
  ro.prepare('PRAGMA application_id').all();
  readHeaderSchemaVersion(ro);
  inspectSchemaVersions(ro, CORE_MIGRATIONS);
  out.peeksMs = now() - t; t = now();
  ro.prepare('PRAGMA integrity_check').all();
  out.integrityMs = now() - t; t = now();
  ro.prepare('PRAGMA foreign_key_check').all();
  out.foreignKeyMs = now() - t; t = now();
  ro.close();
  out.roCloseMs = now() - t; t = now();
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
  out.rwOpenMs = now() - t; t = now();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
  out.walPragmaMs = now() - t; t = now();
  applyMigrations(db, { migrations: CORE_MIGRATIONS });
  out.migrationsMs = now() - t; t = now();
  runWalTruncateBarrier(db);
  out.barrierMs = now() - t;
  out.componentsTotalMs = out.roOpenMs + out.peeksMs + out.integrityMs + out.foreignKeyMs + out.roCloseMs + out.rwOpenMs + out.walPragmaMs + out.migrationsMs + out.barrierMs;
  db.close();
} else {
  let t = now();
  const h = openStorageDb({ dir });
  out.fullOpenMs = now() - t; t = now();
  runWalTruncateBarrier(h.db);
  out.fullBarrierMs = now() - t;
  out.fullTotalMs = out.fullOpenMs + out.fullBarrierMs;
  h.close();
}
console.log(JSON.stringify(out));
