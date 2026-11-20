/**
 * Child process of tests/storage-chats-write-bytes.test.js. Runs under the LD_PRELOAD write meter.
 * argv: <dir> <N> <scenario list as JSON>. Prints one JSON line with the window marker names it produced.
 *
 * Isolation: one writer, no other connection, autocheckpoint off. The seed and a finished
 * wal_checkpoint(TRUNCATE) happen before the window; the window is one full transaction followed by a forced
 * wal_checkpoint(FULL) that must report busy=0 and move every WAL frame, so the whole checkpoint cost is
 * attributed to that one change (raw definition).
 *
 * `batch:<kind>` / `batch:named` scenarios implement the amortized definition (ADR 2.2): every change commits in
 * its own transaction (markers `bw_<kind>_<i>` cover the commit, i.e. the WAL bytes), then one forced
 * wal_checkpoint(FULL) moves the whole batch (marker `bck_<kind>`); the checkpoint share of one change is that
 * window divided by the batch size.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openStorageDb } from '../../lib/storage/db-lifecycle.js';
import { offlineHandlers as h } from '../../lib/storage/chats-store.js';

const [dir, nArg, scenariosArg] = process.argv.slice(2);
const n = Number(nArg);
const scenarios = JSON.parse(scenariosArg);
const handle = openStorageDb({ dir, filename: 'chats.sqlite', create: true });
const db = handle.db;
db.exec('PRAGMA wal_autocheckpoint = 0');
const ctx = { prepare: (sql) => db.prepare(sql) };
const marker = (name) => fs.writeFileSync(path.join(dir, name), 'm');

const pad = (i) => String(i).padStart(6, '0');
/** Deterministic pseudo-random order so timestamps are unique and not inserted chronologically (like real activity). */
let lcg = 12345;
const rand = () => { lcg = (lcg * 1103515245 + 12345) % 2147483648; return lcg / 2147483648; };
const BASE = Date.parse('2025-01-01T00:00:00.000Z');
const stamp = () => new Date(BASE + Math.floor(rand() * 400 * 86400000)).toISOString();
const NEW_BASE = Date.parse('2026-09-01T00:00:00.000Z');
/** Records measured per kind (a p95 over these distinct old rows). */
const SAMPLES = 20;
const KINDS = {
  global: {},
  folder: { workspaceFolder: '/work/ws-1' },
  folderFile: { workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-1/f-1.js' },
  widget: { workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-1/f-1.js', widgetInstallationId: 'inst-1', widgetPageSessionId: 'page-1' },
};
function seed() {
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < n; i += 200) {
    const chats = [];
    for (let j = i; j < Math.min(n, i + 200); j += 1) {
      chats.push({
        id: `c${pad(j)}`, title: `Chat ${j}`, createdAt: stamp(), updatedAt: stamp(), workspaceFolder: `/work/ws-${j % 7}`,
        workspaceFile: `/work/ws-${j % 7}/f-${j % 5}.js`, widgetInstallationId: `inst-${j % 3}`, widgetPageSessionId: `page-${j % 2}`,
        model: 'm-1', sdkMode: 'agent', ...(j % 9 === 0 ? { archivedAt: '2026-03-01T00:00:00.000Z' } : {}),
      });
    }
    h.importBatch(ctx, { chats });
  }
  // Measured chats (p95-sized details body); every kind gets SAMPLES distinct old rows.
  for (const [kind, fields] of Object.entries(KINDS)) {
    const chats = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      chats.push({ id: `m-${kind}-${i}`, title: `m ${kind}`, createdAt: stamp(), updatedAt: stamp(), ...fields, model: 'm-1', summaries: ['s'.repeat(1500)] });
    }
    h.importBatch(ctx, { chats });
  }
  h.add(ctx, { chat: { id: 'solo', title: 'solo', createdAt: stamp(), updatedAt: stamp(), workspaceFolder: '/work/solo' } });
  db.exec('COMMIT');
}

function checkpoint(mode) {
  const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
  if (Number(r.busy) !== 0 || (mode !== 'PASSIVE' && Number(r.log) !== Number(r.checkpointed))) {
    throw new Error(`checkpoint ${mode} incomplete: ${JSON.stringify(r)}`);
  }
}

const at = (i) => new Date(NEW_BASE + i * 1000 + 1).toISOString();
/** scenario name: `<kind>:<i>` activity change of the i-th sample, or a named single operation. */
const named = {
  title: () => h.update(ctx, { id: 'm-widget-0', set: { title: 'renamed' } }),
  archive: () => h.archive(ctx, { ids: ['m-widget-1'], archivedAt: '2026-09-09T00:00:00.000Z' }),
  newBucket: () => h.update(ctx, { id: 'm-widget-2', set: { workspaceFolder: '/work/brand-new-bucket' } }),
  zeroBucket: () => h.remove(ctx, { id: 'solo' }),
  add: () => h.add(ctx, { chat: { id: 'added', title: 'added', createdAt: at(1), workspaceFolder: '/work/ws-1', workspaceFile: '/work/ws-1/f-1.js', widgetInstallationId: 'inst-1', widgetPageSessionId: 'page-1' } }),
};
function operationFor(name) {
  const [kind, index] = name.split(':');
  if (index !== undefined) return () => h.update(ctx, { id: `m-${kind}-${index}`, set: { updatedAt: at(Number(index)) } });
  return named[name];
}

seed();
checkpoint('TRUNCATE');
if (scenarios.includes('control')) {
  // Known writes for the harness self-check: two overwrites of one offset and one short tail.
  const fd = fs.openSync(path.join(dir, 'control.bin'), 'w');
  marker('control-start');
  fs.writeSync(fd, Buffer.alloc(1000, 1), 0, 1000, 0);
  fs.writeSync(fd, Buffer.alloc(1000, 2), 0, 1000, 0);
  fs.writeSync(fd, Buffer.alloc(37, 3), 0, 37, 1000);
  marker('control-end');
  fs.closeSync(fd);
}
function batchOps(kind) {
  if (kind === 'named') return Object.keys(named).map((k) => [k, named[k]]);
  // Distinct timestamps keep every update a real index move even when raw scenarios ran earlier in this process.
  return Array.from({ length: SAMPLES }, (_, i) => [`${i}`, () => h.update(ctx, { id: `m-${kind}-${i}`, set: { updatedAt: at(i + 500) } })]);
}
function runBatch(kind) {
  const ops = batchOps(kind);
  for (const [label, op] of ops) {
    marker(`bw_${kind}_${label}-start`);
    db.exec('BEGIN IMMEDIATE');
    op();
    db.exec('COMMIT');
    marker(`bw_${kind}_${label}-end`);
  }
  marker(`bck_${kind}-start`);
  checkpoint('FULL');
  marker(`bck_${kind}-end`);
  checkpoint('TRUNCATE');
}
for (const name of scenarios.filter((s) => s !== 'control')) {
  if (name.startsWith('batch:')) { runBatch(name.slice(6)); continue; }
  marker(`${name.replace(':', '_')}-start`);
  db.exec('BEGIN IMMEDIATE');
  operationFor(name)();
  db.exec('COMMIT');
  checkpoint('FULL');
  marker(`${name.replace(':', '_')}-end`);
  checkpoint('TRUNCATE');
}
handle.close();
console.log(JSON.stringify({ ok: true }));
