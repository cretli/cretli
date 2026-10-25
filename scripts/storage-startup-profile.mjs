#!/usr/bin/env node
/**
 * Startup component profile (A3a follow-up). Builds a synthetic frozen-shape
 * store in an OS temp dir, then times each component of an existing-store open
 * in a FRESH child process per sample so SQLite's per-connection state is cold
 * (the OS page cache stays warm; a cold-disk restart is not measured).
 *
 *   node scripts/storage-startup-profile.mjs [shape] [samples] [out.json]
 *
 * Modes per sample: `componentsUnmapped` / `componentsMapped` (same primitives
 * as openStorageDb, read-only check connection with mmap_size 0 vs 256 MiB; the
 * checks always run in full, only the mmap pragma differs, no production code is
 * toggled) and `full` (production openStorageDb + barrier). Variants: `clean`
 * (no WAL) and `walPrecheckpointed` (a -wal file with frames that were ALL
 * already checkpointed before the process exited without close; it is a lower
 * bound for the barrier, NOT a pending-replay scenario). Results carry
 * provenance (node, sqlite, platform, data shape, effective mmap pragma).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatHistoryStore } from '../lib/storage/chat-history-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME as DB } from '../lib/storage/db-lifecycle.js';

const SHAPES = { small: [10, 50], medium: [100, 200], mixed: [50, 120] };
// Mirrors READONLY_CHECK_MMAP_BYTES in lib/storage/db-lifecycle.js (not exported).
const MAPPED_BYTES = 256 * 1024 * 1024;
const MODES = [
  { key: 'componentsUnmapped', args: ['components', '0'] },
  { key: 'componentsMapped', args: ['components', String(MAPPED_BYTES)] },
  { key: 'full', args: ['full'] },
];
const HANDLERS = fileURLToPath(new URL('../lib/storage/chat-history-store.js', import.meta.url));
const CHILD = fileURLToPath(new URL('./storage-startup-profile-child.mjs', import.meta.url));

const usage = (msg) => { console.error(`${msg}\nusage: storage-startup-profile.mjs [${Object.keys(SHAPES).join('|')}] [samples>=1] [out.json]`); process.exit(2); };
const name = process.argv[2] || 'medium';
if (!Object.hasOwn(SHAPES, name)) usage(`unknown shape: ${name}`);
const samples = Number(process.argv[3] || 9);
if (!Number.isInteger(samples) || samples < 1) usage(`invalid samples: ${process.argv[3]}`);
const outFile = process.argv[4] || `/tmp/a3a-startup-prof/${name}.json`;
const [chats, per] = SHAPES[name];

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const runChild = (args) => {
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`profile child failed (${args.slice(1).join(' ')}): status=${r.status} ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const copyStore = (from, to) => {
  fs.mkdirSync(to);
  for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(path.join(from, DB + sfx))) fs.copyFileSync(path.join(from, DB + sfx), path.join(to, DB + sfx));
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3a-prof-'));
try {
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const host = createStorageWorkerHost({ dbDir: src, handlersPath: HANDLERS, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const committer = createGroupCommitter({ host });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  await host.start();
  let idx = 0;
  for (let e = 0; e < per; e += 1) {
    await Promise.all(Array.from({ length: chats }, (_, c) => store.appendEvents({
      datasetGeneration: name, chatEpoch: 'epoch-1', chatId: `bench-chat-${c}`, producerId: 'p1', commandId: `c:${idx++}`,
      events: [{ clientSeq: e + 1, rec: { kind: 'localUser', text: `Synthetic ${idx} ${'sample text '.repeat(8 + (idx % 17))}` } }],
    })));
  }
  await committer.flush();
  await host.control('checkpoint');
  await host.close();
  const clean = path.join(root, 'clean');
  copyStore(src, clean);
  const results = {
    provenance: {
      node: process.version, platform: `${process.platform}-${process.arch}`, shape: name, chats, eventsPerChat: per,
      note: 'synthetic generated store (temp dir); not the frozen first-run dataset',
      mappedBytesRequested: MAPPED_BYTES, sqliteVersion: null, effectiveMmapSize: {},
      walPrecheckpointed: 'wal file present, all frames checkpointed before exit (no pending replay)',
    },
    samples, bytes: fs.statSync(path.join(clean, DB)).size, variants: {},
  };
  for (const variant of ['clean', 'walPrecheckpointed']) {
    const rows = [];
    const wal = [];
    for (let i = 0; i < samples; i += 1) {
      const dir = path.join(root, `${variant}-${i}`);
      copyStore(clean, dir);
      if (variant === 'walPrecheckpointed') {
        const w = runChild([dir, 'setup']);
        if (!(w.walFramesLog > 0 && w.walFramesLog === w.walFramesCheckpointed)) throw new Error(`WAL not fully checkpointed: ${JSON.stringify(w)}`);
        wal.push(w);
      }
      rows[i] = {};
      for (const { key, args } of MODES) {
        const sub = path.join(root, `${variant}-${key}-${i}`);
        copyStore(dir, sub);
        const parsed = runChild([sub, ...args]);
        if (parsed.sqliteVersion) results.provenance.sqliteVersion = parsed.sqliteVersion;
        if ('effectiveMmapSize' in parsed) results.provenance.effectiveMmapSize[key] = parsed.effectiveMmapSize;
        delete parsed.sqliteVersion; delete parsed.effectiveMmapSize;
        for (const [k, v] of Object.entries(parsed)) {
          if (!Number.isFinite(v)) throw new Error(`non-finite ${key}.${k}: ${v}`);
          rows[i][`${key}.${k}`] = v;
        }
      }
    }
    const stats = Object.fromEntries(Object.keys(rows[0]).map((k) => {
      const vals = rows.map((r) => r[k]);
      return [k, { median: Math.round(med(vals) * 1000) / 1000, min: Math.min(...vals), max: Math.max(...vals) }];
    }));
    results.variants[variant] = { stats, samples: rows, ...(wal.length ? { walSetup: wal } : {}) };
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.provenance), `-> ${outFile}`);
} finally {
  if (process.env.A3A_PROF_KEEP) console.error('kept', root); else fs.rmSync(root, { recursive: true, force: true });
}
