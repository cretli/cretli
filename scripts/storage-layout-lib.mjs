/**
 * Shared helpers of the A1 bounded SQLite physical-layout experiment
 * (scripts/storage-layout-experiment.mjs, docs/storage-a1-layout-experiment.md).
 * Benchmark tooling only: nothing here is imported by the production storage
 * backend, and it never touches a live data tree (OS temp directories only).
 *
 * The page size of a fresh store is chosen by pre-creating the file with
 * `PRAGMA page_size` + WAL before the production worker/`openStorageDb` first
 * opens it; the production code itself is not modified or toggled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatHistoryStore, HISTORY_RETENTION_LIMIT } from '../lib/storage/chat-history-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME as DB } from '../lib/storage/db-lifecycle.js';

export const DB_FILENAME = DB;
export const HANDLERS_PATH = fileURLToPath(new URL('../lib/storage/chat-history-store.js', import.meta.url));
/** A1 bench generator constants (scripts/storage-chat-history-bench.mjs). */
export const SEED = 20261013;
export const CONCURRENCY = 64;
export const MEDIUM_SHAPE = Object.freeze({ chats: 100, eventsPerChat: 200, appendRounds: 1, readRatio: 0.25 });
export { HISTORY_RETENTION_LIMIT };

/**
 * Numeric thresholds, frozen BEFORE any measurement. They are the unchanged
 * docs/storage-gates.md budgets; the experiment runner refuses to run unless
 * the report document contains this object's sha256, so they cannot drift
 * silently between the freeze and the results.
 */
export const FROZEN_THRESHOLDS = Object.freeze({
  apiAppendWallMs: Object.freeze({ p95: 120, p99: 250 }),
  workerQueueWaitPlusExecuteMs: Object.freeze({ p95: 80, p99: 180 }),
  historyPageQueryMs: Object.freeze({ p95: 40, p99: 90 }),
  eventLoopDelayMs: Object.freeze({ p99: 25, max: 100, monitorResolutionMs: 1 }),
  queueAgeMs: Object.freeze({ steadyP95: 200, burstMax: 2000 }),
  bytesWrittenPct: Object.freeze({ maxPercentOfJsonRewriteBytes: 25 }),
  fullCheckpointStallP99Ms: 500,
  startup: Object.freeze({ maxMultipleOfRemeasuredJsonColdLoad: 2, minSamplesPerVariantCase: 15 }),
});
export const thresholdsSha256 = () => crypto.createHash('sha256').update(JSON.stringify(FROZEN_THRESHOLDS)).digest('hex');

/** @param {number} seed @returns {() => number} mulberry32 (verbatim from the A1 bench) */
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic event stream, verbatim logic of the A1 bench `createStream`
 * (tests/storage-layout-experiment.test.js pins the equivalence).
 * @param {{ chats: number, eventsPerChat: number, appendRounds: number }} shape
 */
export function createStream(shape, seed = SEED) {
  const perRound = shape.chats * shape.eventsPerChat;
  const total = perRound * shape.appendRounds;
  const rng = createRng(seed ^ (shape.chats * 7919 + shape.eventsPerChat));
  const repeats = Uint8Array.from({ length: total }, () => 8 + Math.floor(rng() * 17));
  return {
    total,
    at(index) {
      const round_ = Math.floor(index / perRound);
      const inRound = index % perRound;
      return {
        chatId: `bench-chat-${inRound % shape.chats}`,
        clientSeq: round_ * shape.eventsPerChat + Math.floor(inRound / shape.chats) + 1,
        rec: { kind: 'localUser', text: `Synthetic event ${index}. ${'sample text '.repeat(repeats[index])}` },
      };
    },
  };
}

/** Hash of the exact generated input (every event of the stream, in order). */
export function inputHash(shape, seed = SEED) {
  const stream = createStream(shape, seed);
  const h = crypto.createHash('sha256');
  for (let i = 0; i < stream.total; i += 1) h.update(JSON.stringify(stream.at(i))).update('\n');
  return h.digest('hex');
}

/** @param {number[]} values nearest-rank percentile like the A1 bench `summarize` */
export function summarize(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0 || finite.length !== values.length) return { n: finite.length, median: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN, valid: false };
  const s = [...finite].sort((a, b) => a - b);
  const at = (f) => s[Math.max(0, Math.ceil(f * s.length) - 1)];
  const r = (v) => Number(v.toFixed(3));
  return { n: s.length, median: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), min: r(s[0]), max: r(s[s.length - 1]), valid: true };
}

/** Deterministic round-wise shuffle: every round holds each item once in a seeded order. */
export function interleavedOrder(items, rounds, seed = SEED) {
  const rng = createRng(seed ^ 0x5eed);
  const out = [];
  for (let r = 0; r < rounds; r += 1) {
    const round = [...items];
    for (let i = round.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
    for (const item of round) out.push({ round: r, item });
  }
  return out;
}

export function copyStoreFiles(from, to, suffixes = ['', '-wal']) {
  fs.mkdirSync(to, { recursive: true });
  for (const sfx of suffixes) {
    const src = path.join(from, DB + sfx);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(to, DB + sfx));
  }
}

export function sqliteFilesSize(dir) {
  return ['', '-wal', '-shm'].reduce((total, sfx) => {
    try { return total + fs.statSync(path.join(dir, DB + sfx)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; return total; }
  }, 0);
}

/** The compiled-in default page size of this SQLite build (read from a scratch database). */
export function defaultPageSize() {
  const db = new DatabaseSync(':memory:');
  try { return Number(db.prepare('PRAGMA page_size').get().page_size); } finally { db.close(); }
}

/** Unique candidate sizes: a value equal to the baseline default is skipped, never replaced. */
export function candidatePageSizes(baseline, wanted = [8192, 16384]) {
  const seen = new Set([baseline]);
  const out = [];
  for (const v of wanted) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

/** Pre-create an empty WAL store with `page_size` set before any table exists. */
export function precreateStore(dir, pageSize) {
  const db = new DatabaseSync(path.join(dir, DB));
  try {
    db.exec(`PRAGMA page_size = ${pageSize}`);
    db.exec('PRAGMA journal_mode = WAL');
    const eff = Number(db.prepare('PRAGMA page_size').get().page_size);
    if (eff !== pageSize) throw new Error(`page_size ${pageSize} did not take effect (got ${eff})`);
  } finally {
    db.close();
  }
}

/** @returns {{ pageSize: number, pageCount: number, freelistCount: number, journalMode: string, dbstat: object | string }} */
export function readLayout(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const num = (p) => Number(db.prepare(`PRAGMA ${p}`).get()[p]);
    let dbstat;
    try {
      dbstat = Object.fromEntries(db.prepare('SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY name').all().map((r) => [r.name, { bytes: Number(r.bytes), pages: Number(r.pages) }]));
    } catch (e) {
      dbstat = `UNVERIFIED: dbstat unavailable (${e.message})`;
    }
    return { pageSize: num('page_size'), pageCount: num('page_count'), freelistCount: num('freelist_count'), journalMode: String(db.prepare('PRAGMA journal_mode').get().journal_mode), dbstat };
  } finally {
    db.close();
  }
}

/**
 * Deterministic logical export of ALL tables (user tables incl. receipts,
 * dedupe, revisions, relations, schema_version). Rows are ordered by every
 * column; columns named `*_at` hold wall-clock stamps that differ between
 * independent generation runs, so they are replaced by their SQLite type and
 * listed in `maskedColumns` (their NOT NULL / CHECK constraints still hold).
 * Everything else, including payload and result JSON, is compared byte for
 * byte through a per-table sha256. Run it on a scratch copy (a WAL is replayed).
 */
export function logicalExport(dir) {
  const db = new DatabaseSync(path.join(dir, DB));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const out = { tables: {}, maskedColumns: [] };
    const all = crypto.createHash('sha256');
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => String(c.name));
      const sel = cols.map((c) => (c.endsWith('_at') ? `typeof("${c}") AS "${c}"` : `"${c}"`));
      for (const c of cols) if (c.endsWith('_at')) out.maskedColumns.push(`${t}.${c}`);
      const h = crypto.createHash('sha256');
      let rows = 0;
      const stmt = db.prepare(`SELECT ${sel.join(', ')} FROM "${t}" ORDER BY ${cols.map((c) => `"${c}"`).join(', ')}`);
      stmt.setReadBigInts(true);
      for (const row of stmt.iterate()) { h.update(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))).update('\n'); rows += 1; }
      const sha256 = h.digest('hex');
      out.tables[t] = { rows, sha256 };
      all.update(`${t}:${rows}:${sha256}\n`);
    }
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const schemaSha = crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    out.schemaSha256 = schemaSha;
    all.update(schemaSha);
    out.sha256 = all.digest('hex');
    return out;
  } finally {
    db.close();
  }
}

/** Per-table mismatch list of two exports (empty = logically identical). */
export function diffExports(a, b) {
  const diffs = [];
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const n of names) {
    if (a.tables[n]?.sha256 !== b.tables[n]?.sha256 || a.tables[n]?.rows !== b.tables[n]?.rows) diffs.push(n);
  }
  if (a.schemaSha256 !== b.schemaSha256) diffs.push('<schema>');
  return diffs;
}

/** Bytes a JSON-per-chat rewrite store writes for the stream (A1 JSON-baseline method, sizes only). */
export function jsonRewriteBytes(shape) {
  const stream = createStream(shape);
  const docs = new Map();
  let bytes = 0;
  for (let i = 0; i < stream.total; i += 1) {
    const ev = stream.at(i);
    const doc = docs.get(ev.chatId) || { v: 1, chatId: ev.chatId, headSeq: 0, events: [] };
    doc.headSeq += 1;
    doc.events.push({ seq: doc.headSeq, rec: { ...ev.rec, clientSeq: ev.clientSeq } });
    if (doc.events.length > HISTORY_RETENTION_LIMIT) doc.events.splice(0, doc.events.length - HISTORY_RETENTION_LIMIT);
    bytes += Buffer.byteLength(JSON.stringify(doc, null, 2));
    docs.set(ev.chatId, doc);
  }
  return { bytes, perThousandEvents: Number((bytes * 1000 / stream.total).toFixed(3)), documents: docs };
}

/** Write the final JSON documents (what the cold-load measurement reads). */
export function writeJsonStore(dir, documents) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [chatId, doc] of documents) fs.writeFileSync(path.join(dir, `${chatId}.json`), JSON.stringify(doc, null, 2));
}

const pageRequest = (generation, chatId = 'bench-chat-0') => ({ datasetGeneration: generation, chatEpoch: 'epoch-1', chatId, limit: 50 });
export { pageRequest };

function appendOne(store, generation, event, index) {
  return store.appendEvents({
    datasetGeneration: generation, chatEpoch: 'epoch-1', chatId: event.chatId, producerId: 'bench-producer-1',
    commandId: `bench:${generation}:${index}`, events: [{ clientSeq: event.clientSeq, rec: event.rec }],
  });
}

/**
 * Drive the real worker host with the A1 medium stream at concurrency 64 (the
 * bench loop shape without the side checkpointer) and collect screening
 * metrics. `dir` must exist; a page size must already be pre-created.
 */
export async function appendStream(host, committer, store, stream, generation, startIndex = 0, count = stream.total - startIndex, collect = null) {
  for (let offset = 0; offset < count; offset += CONCURRENCY) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count - offset) }, async (_, member) => {
      const index = startIndex + offset + member;
      const submitted = performance.now();
      await appendOne(store, generation, stream.at(index), index);
      collect?.push(performance.now() - submitted);
    }));
  }
}

/** Generate the medium store for one variant and gather screening metrics. */
export async function generateStore({ dir, pageSize, shape = MEDIUM_SHAPE, generation = 'medium' }) {
  fs.mkdirSync(dir, { recursive: true });
  if (pageSize) precreateStore(dir, pageSize);
  const stream = createStream(shape);
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const committer = createGroupCommitter({ host });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  await host.start();
  const monitor = monitorEventLoopDelay({ resolution: FROZEN_THRESHOLDS.eventLoopDelayMs.monitorResolutionMs });
  const append = [];
  const initialBytes = sqliteFilesSize(dir);
  try {
    monitor.enable();
    const started = performance.now();
    await appendStream(host, committer, store, stream, generation, 0, stream.total, append);
    await committer.flush();
    const elapsedMs = performance.now() - started;
    monitor.disable();
    const metrics = host.getMetrics();
    const reads = [];
    const rng = createRng(SEED + 1);
    for (let i = 0; i < 200; i += 1) {
      const t = performance.now();
      await store.readLatest(pageRequest(generation, `bench-chat-${Math.floor(rng() * shape.chats)}`));
      reads.push(performance.now() - t);
    }
    await host.control('checkpoint');
    const side = new DatabaseSync(path.join(dir, DB), { timeout: 5000 });
    let fullMs = NaN;
    let fullBusy = 1;
    try {
      const t = performance.now();
      fullBusy = Number(side.prepare('PRAGMA wal_checkpoint(FULL)').get().busy);
      fullMs = performance.now() - t;
    } finally { side.close(); }
    const bytesWritten = Math.max(0, sqliteFilesSize(dir) - initialBytes);
    const eventLoop = { n: monitor.count, monitorResolutionMs: FROZEN_THRESHOLDS.eventLoopDelayMs.monitorResolutionMs, p99: monitor.percentile(99) / 1e6, max: monitor.max / 1e6 };
    await committer.close();
    await host.close();
    return {
      events: stream.total, elapsedMs, appendLatencyMs: summarize(append), queryLatencyMs: summarize(reads),
      workerRequestMs: metrics.requestMs, workerExecuteMs: metrics.executeMs, queueAgeMs: metrics.queue.queueAgeMs,
      eventLoopDelayMs: eventLoop, fullCheckpoint: { ms: fullMs, busy: fullBusy, n: 1 },
      bytesWritten, bytesWrittenPer1000Events: Number((bytesWritten * 1000 / stream.total).toFixed(3)),
    };
  } finally {
    monitor.disable();
    await committer.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

/** Number of intact WAL frames in a copied `-wal` file, from its size and header page size. */
export function walFrameCount(walFile) {
  let fd;
  try { fd = fs.openSync(walFile, 'r'); } catch (e) { if (e.code === 'ENOENT') return { frames: 0, pageSize: 0 }; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 32) return { frames: 0, pageSize: 0 };
    const header = Buffer.alloc(32);
    fs.readSync(fd, header, 0, 32, 0);
    const pageSize = header.readUInt32BE(8);
    return { frames: Math.floor((size - 32) / (pageSize + 24)), pageSize };
  } finally { fs.closeSync(fd); }
}

const countEvents = (dir) => {
  const db = new DatabaseSync(path.join(dir, DB), { readOnly: false });
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM chat_history_events').get().n); } finally { db.close(); }
};

/**
 * Build the pending-WAL fixture: reopen a clean store with the real host,
 * commit `tailPerChat` more events per chat, then copy db + `-wal` WHILE the
 * host is still open (the copy models a crash after commit/ACK and before any
 * checkpoint of those frames). The copy is NOT checkpointed. Proof, on
 * throw-away copies: events visible with the WAL minus events in the main file
 * alone must be > 0 (a precheckpointed WAL has zero such events and fails).
 */
const EPILOGUE_COMMITS = 20;

export async function buildPendingFixture({ cleanDir, workDir, outDir, shape = MEDIUM_SHAPE, tailPerChat = 5, generation = 'medium' }) {
  copyStoreFiles(cleanDir, workDir);
  const tailShape = { chats: shape.chats, eventsPerChat: shape.eventsPerChat + tailPerChat + 1, appendRounds: 1 };
  const stream = createStream(tailShape);
  // Events of the first `eventsPerChat` rows per chat already exist; append only the tail,
  // whose (chat, clientSeq) pairs are new. Index math follows the round-robin layout.
  const tail = [];
  const epilogue = [];
  for (let i = 0; i < stream.total; i += 1) {
    const ev = stream.at(i);
    if (ev.clientSeq > shape.eventsPerChat + tailPerChat) { if (epilogue.length < EPILOGUE_COMMITS) epilogue.push(i); } else if (ev.clientSeq > shape.eventsPerChat) tail.push(i);
  }
  const host = createStorageWorkerHost({ dbDir: workDir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const committer = createGroupCommitter({ host });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  await host.start();
  try {
    for (let o = 0; o < tail.length; o += CONCURRENCY) {
      await Promise.all(tail.slice(o, o + CONCURRENCY).map((index) => appendOne(store, generation, stream.at(index), index)));
    }
    await committer.flush();
    // The worker's wal_autocheckpoint may have backfilled the WAL during the tail; a few
    // sequential small commits after it land in the (restarted) WAL and stay pending.
    for (const index of epilogue) { await appendOne(store, generation, stream.at(index), index); await committer.flush(); }
    // Quiescent and acknowledged: copy main file first, then the WAL (never the -shm).
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(workDir, DB), path.join(outDir, DB));
    fs.copyFileSync(path.join(workDir, `${DB}-wal`), path.join(outDir, `${DB}-wal`));
  } finally {
    await committer.close().catch(() => {});
    await host.close().catch(() => {});
  }
  const wal = walFrameCount(path.join(outDir, `${DB}-wal`));
  const probeMain = `${outDir}.probe-main`;
  const probeFull = `${outDir}.probe-full`;
  try {
    copyStoreFiles(outDir, probeMain, ['']);
    copyStoreFiles(outDir, probeFull);
    const mainOnlyEvents = countEvents(probeMain);
    const withWalEvents = countEvents(probeFull);
    const pendingEvents = withWalEvents - mainOnlyEvents;
    return {
      method: 'copy of db+wal taken while the real host was open and idle after acknowledged appends; no checkpoint ran on the copy; proof = events visible with the WAL minus events in the main file alone (probe copies)',
      walFrames: wal.frames, walPageSize: wal.pageSize, walBytes: fs.statSync(path.join(outDir, `${DB}-wal`)).size,
      mainOnlyEvents, withWalEvents, pendingEvents, tailEventsAppended: tail.length + epilogue.length, epilogueCommits: epilogue.length,
      proven: wal.frames > 0 && pendingEvents > 0,
    };
  } finally {
    fs.rmSync(probeMain, { recursive: true, force: true });
    fs.rmSync(probeFull, { recursive: true, force: true });
  }
}

/** Environment provenance (no private paths). */
export function environmentInfo(dir) {
  let fsType = 'UNVERIFIED';
  try { fsType = execFileSync('stat', ['-f', '-c', '%T', dir], { encoding: 'utf8' }).trim(); } catch { /* keep UNVERIFIED */ }
  const db = new DatabaseSync(':memory:');
  let sqlite;
  try { sqlite = db.prepare('select sqlite_version() v').get().v; } finally { db.close(); }
  const hashFiles = (files) => crypto.createHash('sha256').update(files.map((f) => fs.readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)))).join('\0')).digest('hex');
  return {
    node: process.version, sqlite, platform: `${process.platform}-${process.arch}`, fsType, defaultPageSize: defaultPageSize(),
    codeRevision: process.env.CRETLI_CODE_REVISION || 'UNVERIFIED (set CRETLI_CODE_REVISION)',
    storageCodeSha256: hashFiles(['lib/storage/db-lifecycle.js', 'lib/storage/migrations.js', 'lib/storage/chat-history-store.js', 'lib/storage/sqlite-worker.js', 'lib/storage/worker-host.js']),
  };
}
