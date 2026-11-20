import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { enumerateManaged, isSqliteMain } from './offline/managed-files.js';

const HOURLY_MS = 60 * 60 * 1000;
const DAILY_MS = 24 * HOURLY_MS;
let activeStatus = { lastSuccessAt: null, lastError: null };
export function getAutoBackupStatus() { return { ...activeStatus }; }

/** JSON files larger than this are not parsed for a record count (a main-thread parse per backup). */
const RECORD_COUNT_MAX_BYTES = 5 * 1024 * 1024;
/** Backups that keep their SQLite copies; older ones keep only the JSON state. */
const SQLITE_COPIES_KEPT = 2;

function recordCount(rel, file) {
  if (!rel.endsWith('.json')) return null;
  try { if (fs.statSync(file).size > RECORD_COUNT_MAX_BYTES) return null; } catch { return null; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed.length;
    for (const key of ['chats', 'items', 'todos', 'events', 'entries']) if (Array.isArray(parsed?.[key])) return parsed[key].length;
  } catch {}
  return null;
}

export async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createAutoBackup({ dataDir, now = new Date(), includeSqlite = false }) {
  const root = path.join(dataDir, 'backups', 'auto');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const partial = path.join(root, `.${timestamp}.tmp`);
  const target = path.join(root, timestamp);
  fs.mkdirSync(partial, { mode: 0o700 });
  const entries = [];
  const errors = [];
  try {
    for (const { rel } of enumerateManaged(dataDir).files.filter(({ rel }) => !/(?:-wal|-shm|-journal)$/.test(rel))) {
      const src = path.join(dataDir, rel);
      if (isSqliteMain(rel) && !includeSqlite) continue;
      if (isSqliteMain(rel) && !hasRoomFor(src, root)) {
        errors.push({ path: rel, message: 'not enough free disk space for the SQLite copy' });
        continue;
      }
      const dest = path.join(partial, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      let sqliteMetadata = null;
      try {
      if (isSqliteMain(rel)) {
        sqliteMetadata = await backupSqliteInWorker(src, dest);
      } else {
        await fs.promises.copyFile(src, dest);
      }
      fs.chmodSync(dest, 0o600);
      entries.push({ path: rel, size: sqliteMetadata?.size ?? fs.statSync(dest).size, sha256: sqliteMetadata?.sha256 ?? await sha256(dest), records: recordCount(rel, dest) });
      } catch (error) {
        if (!isSqliteMain(rel)) throw error;
        fs.rmSync(dest, { force: true });
        errors.push({ path: rel, message: String(error?.message || error) });
      }
    }
    const manifest = { format: 'cretli-auto-backup/1', createdAt: now.toISOString(), entries, errors };
    const mf = path.join(partial, 'manifest.json');
    fs.writeFileSync(mf, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(partial, target);
    pruneAutoBackups(root, now.getTime());
    pruneSqliteCopies(root);
    return { path: target, manifest, errors };
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/** Free space for a copy of `file` with a 2x margin. */
function hasRoomFor(file, dir) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize) > fs.statSync(file).size * 2;
  } catch {
    return false;
  }
}

/** Drop SQLite copies from all but the newest SQLITE_COPIES_KEPT backups that have them (multi-GB each). */
function pruneSqliteCopies(root) {
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name).sort().reverse();
  let withSqlite = 0;
  for (const name of dirs) {
    const dir = path.join(root, name);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
    const sqlite = (manifest.entries || []).filter((entry) => isSqliteMain(entry.path));
    if (!sqlite.length || sqlite.every((entry) => !fs.existsSync(path.join(dir, entry.path)))) continue;
    withSqlite += 1;
    if (withSqlite <= SQLITE_COPIES_KEPT) continue;
    for (const entry of sqlite) fs.rmSync(path.join(dir, entry.path), { force: true });
  }
}

function backupSqliteInWorker(source, destination) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./auto-backup-sqlite-worker.js', import.meta.url), { workerData: { source, destination } });
    worker.once('message', (message) => message.ok ? resolve(message) : reject(new Error(message.error)));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`SQLite backup worker exited with ${code}`)); });
  });
}

export function pruneAutoBackups(root, now = Date.now()) {
  const rows = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, time: Date.parse(d.name.replace(/-(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z')) || fs.statSync(path.join(root, d.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  const keep = new Set();
  const buckets = new Map();
  for (const row of rows) {
    const age = Math.max(0, now - row.time);
    const group = age < DAILY_MS ? 'hour' : age < 7 * DAILY_MS ? 'day' : age < 28 * DAILY_MS ? 'week' : 'expired';
    if (group === 'expired') continue;
    const limit = group === 'hour' ? 24 : group === 'day' ? 7 : 4;
    const n = buckets.get(group) || 0;
    if (n < limit) { keep.add(row.name); buckets.set(group, n + 1); }
  }
  for (const row of rows) if (!keep.has(row.name)) fs.rmSync(path.join(root, row.name), { recursive: true, force: true });
  return rows.length - keep.size;
}

/** Time of the newest backup that still holds SQLite copies (survives restarts), or 0. */
export function lastSqliteBackupAt(dataDir) {
  const root = path.join(dataDir, 'backups', 'auto');
  let newest = 0;
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, d.name, 'manifest.json'), 'utf8'));
        if (!(manifest.entries || []).some((entry) => isSqliteMain(entry.path))) continue;
        newest = Math.max(newest, Date.parse(manifest.createdAt) || 0);
      } catch { /* an unreadable backup does not count */ }
    }
  } catch { /* no backups yet */ }
  return newest;
}

/** First run after start: restarts are frequent, so a boot never starts a multi-GB copy at once. */
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

export function startAutoBackupService({ dataDir, logger = console, setIntervalFn = setInterval, setTimeoutFn = setTimeout, firstRunDelayMs = FIRST_RUN_DELAY_MS }) {
  let lastSuccessAt = null;
  let lastError = null;
  let lastSqliteAt = lastSqliteBackupAt(dataDir);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const includeSqlite = Date.now() - lastSqliteAt >= DAILY_MS;
      const result = await createAutoBackup({ dataDir, includeSqlite });
      if (includeSqlite) lastSqliteAt = Date.now();
      lastSuccessAt = new Date().toISOString();
      lastError = result.errors.length ? result.errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ') : null;
    } catch (error) {
      lastError = String(error?.message || error);
      logger.error?.('[backup] automatic backup failed:', lastError);
    } finally { activeStatus = { lastSuccessAt, lastError }; running = false; }
  };
  const first = setTimeoutFn(() => { void run(); }, firstRunDelayMs);
  first.unref?.();
  const timer = setIntervalFn(run, HOURLY_MS);
  timer.unref?.();
  return { run, stop: () => { clearTimeout(first); clearInterval(timer); }, status: () => ({ lastSuccessAt, lastError }) };
}
