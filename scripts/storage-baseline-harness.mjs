#!/usr/bin/env node
/**
 * A1 storage baseline harness — synthetic workloads comparing:
 *   (a) JSON full-document rewrite (current chat-history pattern)
 *   (b) incremental SQLite on the main thread (WAL + synchronous=FULL)
 *   (c) incremental SQLite in a worker thread (same pragmas)
 *
 * Output: JSON report under data/storage-baseline/ or CRETLI_BASELINE_OUT.
 * Does not touch live installation data when CRETLI_DATA_DIR is unset (uses temp dir).
 *
 * Measurement rules (fair-comparison contract, see docs/storage-baseline.md):
 *   - Deterministic workloads: seeded PRNG (CRETLI_BASELINE_SEED, default fixed).
 *   - bytesWritten: actual bytes landing on disk — JSON variant sums statSync
 *     sizes of every rewritten file; SQLite variants measure the on-disk delta
 *     of bench.sqlite + -wal + -shm from just after schema creation to just
 *     after the final FULL checkpoint.
 *   - checkpointSamples are reported separately and never mixed into
 *     commitSamples.
 *   - queueAgeMs (worker variant): wall-clock wait between the parent
 *     enqueueing a task (Date.now()) and the worker thread starting it.
 *   - startupReplayMs: close + reopen (or full cold read for JSON) plus the
 *     first cold page query.
 *   - cpuUsageMs: ONE process-wide process.cpuUsage() delta over the variant
 *     window. That counter covers every thread even when read from a worker, so
 *     the worker variant's number already includes its worker thread; there is no
 *     honest per-thread split available from this API and none is reported.
 *   - memory: process RSS/heap. The process is shared by all variants of a run, so
 *     rssAtStartMb of a variant equals rssMb of the previous one; read rssDeltaMb as
 *     a process-level proxy, not an isolated per-variant footprint.
 *
 * @see docs/storage-baseline.md
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_WORKLOADS = ['small', 'medium', 'growing', 'mixed'];
const WORKLOADS = (process.env.CRETLI_BASELINE_WORKLOADS || ALL_WORKLOADS.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter((name) => ALL_WORKLOADS.includes(name));
const DEFAULT_SEED = 20261013;
const SEED = Number.parseInt(process.env.CRETLI_BASELINE_SEED || '', 10) || DEFAULT_SEED;
const VARIANTS = ['json-cache', 'sqlite-main', 'sqlite-worker'];
/** When not `0`, json-cache fsyncs each chat file after rename (durability parity with SQLite FULL). */
const JSON_FSYNC = process.env.CRETLI_BASELINE_JSON_FSYNC !== '0';
const CHECKPOINT_EVERY_ROUNDS = Math.max(
  1,
  Number.parseInt(process.env.CRETLI_BASELINE_CHECKPOINT_EVERY || '10', 10) || 10
);
const WORKER_BURST_INSERTS = Math.max(
  50,
  Number.parseInt(process.env.CRETLI_BASELINE_BURST_N || '200', 10) || 200
);
/** Per-reply ceiling for the concurrent burst probe; a missed reply must fail loudly, not hang. */
const BURST_REPLY_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.CRETLI_BASELINE_BURST_TIMEOUT_MS || '120000', 10) || 120000
);
/**
 * Sampling resolution of the event-loop delay monitor. A healthy loop reports a mean
 * close to this floor, so it must stay well below the gates.md p99 budget (25 ms) or
 * every variant fails on the sampling interval instead of on a real stall.
 */
const EVENT_LOOP_RESOLUTION_MS = Math.max(
  1,
  Number.parseInt(process.env.CRETLI_BASELINE_ELD_RESOLUTION_MS || '1', 10) || 1
);
const MERGE_IN = process.env.CRETLI_BASELINE_MERGE_IN || '';

/**
 * Yield so monitorEventLoopDelay can observe delay between synchronous ops.
 * @returns {Promise<void>}
 */
function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Deterministic PRNG (mulberry32) so every variant sees the same workload.
 * @param {number} seed
 */
function createRng(seed) {
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
 * Deterministic UUID-shaped id from the seeded rng.
 * @param {() => number} rng
 */
function rngUuid(rng) {
  const hex = (len) =>
    Array.from({ length: len }, () => Math.floor(rng() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * @param {number[]} samplesMs
 * @returns {{ p50: number, p95: number, p99: number, max: number, n: number }}
 */
function percentileStats(samplesMs) {
  const sorted = [...samplesMs].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0, n: 0 };
  }
  const pick = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * n) - 1))];
  return {
    p50: Number(pick(0.5).toFixed(3)),
    p95: Number(pick(0.95).toFixed(3)),
    p99: Number(pick(0.99).toFixed(3)),
    max: Number(sorted[n - 1].toFixed(3)),
    n,
  };
}

/**
 * @param {string} name
 * @returns {{ chats: number, eventsPerChat: number, appendRounds: number, readRatio: number }}
 */
function workloadShape(name) {
  if (name === 'small') {
    return { chats: 10, eventsPerChat: 50, appendRounds: 1, readRatio: 0.2 };
  }
  if (name === 'medium') {
    return { chats: 100, eventsPerChat: 200, appendRounds: 1, readRatio: 0.25 };
  }
  if (name === 'growing') {
    return { chats: 20, eventsPerChat: 50, appendRounds: 40, readRatio: 0.15 };
  }
  return { chats: 50, eventsPerChat: 120, appendRounds: 3, readRatio: 0.4 };
}

/**
 * Sum of on-disk sizes of a SQLite database triple (db + wal + shm).
 * @param {string} dbPath
 * @returns {number} bytes (missing sidecar files count as 0)
 */
function sqliteFilesSize(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      /* sidecar not present */
    }
  }
  return total;
}

/**
 * @param {string} dir
 */
function openBenchDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'bench.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=FULL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_events (
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (chat_id, seq)
    );
  `);
  const insert = db.prepare(
    'INSERT INTO chat_events (chat_id, seq, payload) VALUES (?, ?, ?)'
  );
  const selectOne = db.prepare(
    'SELECT payload FROM chat_events WHERE chat_id = ? AND seq = ?'
  );
  const selectPage = db.prepare(
    'SELECT seq, payload FROM chat_events WHERE chat_id = ? ORDER BY seq DESC LIMIT 50'
  );
  return { db, dbPath, insert, selectOne, selectPage };
}

/**
 * @param {string} jsonDir
 * @param {string} chatId
 * @returns {object}
 */
function loadJsonChat(jsonDir, chatId) {
  const file = path.join(jsonDir, `${chatId}.json`);
  if (!fs.existsSync(file)) {
    return { v: 1, chatId, headSeq: 0, events: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} jsonDir
 * @param {object} doc
 * @returns {number} bytes actually written to disk (post-rename statSync)
 */
function saveJsonChat(jsonDir, doc) {
  const file = path.join(jsonDir, `${doc.chatId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
  fs.renameSync(tmp, file);
  if (JSON_FSYNC) {
    const fd = fs.openSync(file, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  return fs.statSync(file).size;
}

/**
 * Send a message to the worker and wait for the matching reply.
 * @param {Worker} worker
 * @param {object} msg
 * @param {(msg: object) => boolean} predicate
 * @param {number} [timeoutMs] when > 0, reject instead of waiting forever for a reply
 * @returns {Promise<object>}
 */
function workerCall(worker, msg, predicate, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    function detach() {
      worker.off('message', onMessage);
      if (timer) clearTimeout(timer);
      timer = null;
    }
    function onMessage(reply) {
      if (!predicate(reply)) return;
      detach();
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply);
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        detach();
        reject(
          new Error(
            `worker reply timeout after ${timeoutMs} ms (op=${String(msg?.op)} seq=${String(msg?.seq)})`
          )
        );
      }, timeoutMs);
    }
    worker.on('message', onMessage);
    worker.postMessage(msg);
  });
}

/**
 * @param {'json-cache' | 'sqlite-main' | 'sqlite-worker'} variant
 * @param {string} workDir
 * @param {ReturnType<typeof workloadShape>} shape
 * @param {() => number} rng
 * @returns {Promise<object>}
 */
async function runVariant(variant, workDir, shape, rng) {
  const commitSamples = [];
  const querySamples = [];
  const checkpointSamples = [];
  const queueAgeSamples = [];
  const loopMonitor = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  loopMonitor.enable();
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
  const rssAtStartMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
  const cpuStart = process.cpuUsage();
  let bytesWritten = 0;
  const jsonDir = path.join(workDir, 'chat-history');
  fs.mkdirSync(jsonDir, { recursive: true });
  const chatIds = Array.from({ length: shape.chats }, () => rngUuid(rng));
  const sqliteMain = variant === 'sqlite-main' ? openBenchDb(path.join(workDir, 'main')) : null;
  /** @type {Worker | null} */
  let worker = null;
  if (variant === 'sqlite-worker') {
    const workerPath = path.join(PROJECT_ROOT, 'scripts', 'storage-baseline-worker.mjs');
    worker = new Worker(workerPath, {
      workerData: { dbPath: path.join(workDir, 'worker', 'bench.sqlite') },
    });
    await new Promise((resolve, reject) => {
      worker.once('message', (msg) => (msg?.ready ? resolve() : reject(new Error('worker init'))));
      worker.once('error', reject);
    });
  }
  // Baseline on-disk size for the SQLite byte accounting (after schema, before data).
  const sqliteBytesBase =
    variant === 'sqlite-main'
      ? sqliteFilesSize(sqliteMain.dbPath)
      : variant === 'sqlite-worker'
        ? sqliteFilesSize(path.join(workDir, 'worker', 'bench.sqlite'))
        : 0;
  const startedAt = performance.now();
  let seqByChat = new Map(chatIds.map((id) => [id, 0]));
  for (let round = 0; round < shape.appendRounds; round += 1) {
    for (const chatId of chatIds) {
      for (let i = 0; i < shape.eventsPerChat; i += 1) {
        const seq = (seqByChat.get(chatId) || 0) + 1;
        seqByChat.set(chatId, seq);
        // Deterministic payload with realistic size jitter from the seeded rng.
        const filler = 'x'.repeat(40 + Math.floor(rng() * 120));
        const payload = JSON.stringify({ seq, text: `event-${seq}-${filler}`, at: 1760000000000 + seq });
        const t0 = performance.now();
        if (variant === 'json-cache') {
          const doc = loadJsonChat(jsonDir, chatId);
          doc.headSeq = seq;
          doc.events.push({ seq, rec: payload });
          bytesWritten += saveJsonChat(jsonDir, doc);
        } else if (variant === 'sqlite-main' && sqliteMain) {
          sqliteMain.insert.run(chatId, seq, payload);
        } else if (variant === 'sqlite-worker' && worker) {
          const reply = await workerCall(
            worker,
            { op: 'insert', chatId, seq, payload, enqueuedAt: Date.now() },
            (msg) => msg?.id === chatId && msg?.seq === seq
          );
          if (Number.isFinite(reply.queueWaitMs)) queueAgeSamples.push(reply.queueWaitMs);
        }
        commitSamples.push(performance.now() - t0);
        if (rng() < shape.readRatio) {
          const q0 = performance.now();
          if (variant === 'json-cache') {
            const doc = loadJsonChat(jsonDir, chatId);
            const tail = doc.events.slice(-50);
            void tail.length;
          } else if (variant === 'sqlite-main' && sqliteMain) {
            sqliteMain.selectPage.all(chatId);
          } else if (variant === 'sqlite-worker' && worker) {
            await workerCall(
              worker,
              { op: 'selectPage', chatId, enqueuedAt: Date.now() },
              (msg) => msg?.op === 'selectPage' && msg?.chatId === chatId
            );
          }
          querySamples.push(performance.now() - q0);
        }
        await yieldEventLoop();
      }
    }
    if (
      variant === 'sqlite-main' &&
      sqliteMain &&
      shape.appendRounds > 1 &&
      (round + 1) % CHECKPOINT_EVERY_ROUNDS === 0
    ) {
      const cp0 = performance.now();
      sqliteMain.db.exec('PRAGMA wal_checkpoint(FULL);');
      checkpointSamples.push(performance.now() - cp0);
    }
    if (
      variant === 'sqlite-worker' &&
      worker &&
      shape.appendRounds > 1 &&
      (round + 1) % CHECKPOINT_EVERY_ROUNDS === 0
    ) {
      const cp0 = performance.now();
      await workerCall(worker, { op: 'checkpoint' }, (msg) => msg?.op === 'checkpoint');
      checkpointSamples.push(performance.now() - cp0);
    }
  }
  // Final FULL checkpoint — measured separately from commit samples.
  if (variant === 'sqlite-main' && sqliteMain) {
    const cp0 = performance.now();
    sqliteMain.db.exec('PRAGMA wal_checkpoint(FULL);');
    checkpointSamples.push(performance.now() - cp0);
  }
  if (variant === 'sqlite-worker' && worker) {
    const cp0 = performance.now();
    await workerCall(worker, { op: 'checkpoint' }, (msg) => msg?.op === 'checkpoint');
    checkpointSamples.push(performance.now() - cp0);
  }
  /** @type {number[]} */
  const queueBurstAgeSamples = [];
  if (variant === 'sqlite-worker' && worker) {
    const burstChat = chatIds[0];
    const burstSeqStart = (seqByChat.get(burstChat) || 0) + 1;
    // One listener per in-flight call: raise the cap so the concurrent burst does
    // not trip MaxListenersExceededWarning.
    worker.setMaxListeners(WORKER_BURST_INSERTS + 16);
    /** @type {Promise<object>[]} */
    const burstWaits = [];
    for (let b = 0; b < WORKER_BURST_INSERTS; b += 1) {
      // Per-iteration const: the predicate must capture this call's own seq. A shared
      // mutable counter would leave every pending reply unmatched and hang the burst.
      const burstSeq = burstSeqStart + b;
      const payload = JSON.stringify({ seq: burstSeq, burst: true, text: 'x'.repeat(80) });
      const enqueuedAt = Date.now();
      burstWaits.push(
        workerCall(
          worker,
          { op: 'insert', chatId: burstChat, seq: burstSeq, payload, enqueuedAt },
          (msg) => msg?.id === burstChat && msg?.seq === burstSeq,
          BURST_REPLY_TIMEOUT_MS
        ).then((reply) => {
          if (Number.isFinite(reply.queueWaitMs)) queueBurstAgeSamples.push(reply.queueWaitMs);
        })
      );
    }
    await Promise.all(burstWaits);
    seqByChat.set(burstChat, burstSeqStart + WORKER_BURST_INSERTS - 1);
  }
  // Fair bytesWritten for SQLite: on-disk delta after the final checkpoint.
  let sqliteBytesFinal = 0;
  if (variant === 'sqlite-main' && sqliteMain) {
    sqliteBytesFinal = sqliteFilesSize(sqliteMain.dbPath);
  } else if (variant === 'sqlite-worker') {
    sqliteBytesFinal = sqliteFilesSize(path.join(workDir, 'worker', 'bench.sqlite'));
  }
  if (variant !== 'json-cache') {
    bytesWritten = Math.max(0, sqliteBytesFinal - sqliteBytesBase);
  }
  // Startup / replay sample: close (or ignore cache) and cold-read the dataset.
  const replay = { reopenMs: 0, coldReadMs: 0 };
  const replayChat = chatIds[0];
  if (variant === 'json-cache') {
    const r0 = performance.now();
    for (const chatId of chatIds) {
      loadJsonChat(jsonDir, chatId);
    }
    replay.coldReadMs = Number((performance.now() - r0).toFixed(3));
    replay.reopenMs = 0;
  } else if (variant === 'sqlite-main' && sqliteMain) {
    sqliteMain.db.close();
    const r0 = performance.now();
    const reopened = openBenchDb(path.join(workDir, 'main'));
    replay.reopenMs = Number((performance.now() - r0).toFixed(3));
    const r1 = performance.now();
    reopened.selectPage.all(replayChat);
    replay.coldReadMs = Number((performance.now() - r1).toFixed(3));
    reopened.db.close();
  } else if (variant === 'sqlite-worker' && worker) {
    const reply = await workerCall(worker, { op: 'reopen' }, (msg) => msg?.op === 'reopen');
    replay.reopenMs = Number(reply.reopenMs || 0);
    const r1 = performance.now();
    await workerCall(
      worker,
      { op: 'selectPage', chatId: replayChat, enqueuedAt: Date.now() },
      (msg) => msg?.op === 'selectPage' && msg?.chatId === replayChat
    );
    replay.coldReadMs = Number((performance.now() - r1).toFixed(3));
  }
  loopMonitor.disable();
  const elapsedMs = performance.now() - startedAt;
  // process.cpuUsage() is PROCESS-WIDE on Linux even when called inside a worker
  // thread (verified: a fresh worker reads the main thread's accumulated CPU, and a
  // main-thread delta taken while only the worker burns CPU still reports that burn).
  // So the delta below already contains the worker's CPU. The worker returns its own
  // delta over the same window purely as a cross-check; it must never be added.
  let workerWindowTotalMs = null;
  if (worker) {
    const stats = await workerCall(worker, { op: 'stats' }, (msg) => msg?.op === 'stats');
    workerWindowTotalMs = Number(Number(stats.cpuDeltaTotalMs || 0).toFixed(1));
    await worker.terminate();
  }
  const cpuDelta = process.cpuUsage(cpuStart);
  const mem = process.memoryUsage();
  const cpuUserMs = Number((cpuDelta.user / 1000).toFixed(1));
  const cpuSystemMs = Number((cpuDelta.system / 1000).toFixed(1));
  const cpuTotalMs = Number((cpuUserMs + cpuSystemMs).toFixed(1));
  const rssAtEndMb = Number((mem.rss / (1024 * 1024)).toFixed(2));
  const jsonDurability = JSON_FSYNC
    ? 'FULL (rename + fsync per chat file)'
    : 'rename-only (not comparable to SQLite FULL)';
  return {
    variant,
    durationMs: Math.round(elapsedMs),
    commitLatencyMs: percentileStats(commitSamples),
    queryLatencyMs: percentileStats(querySamples),
    checkpointLatencyMs: percentileStats(checkpointSamples),
    queueAgeMs: variant === 'sqlite-worker' ? percentileStats(queueAgeSamples) : null,
    queueBurstAgeMs:
      variant === 'sqlite-worker' ? percentileStats(queueBurstAgeSamples) : null,
    eventLoopDelayMs: {
      monitorResolutionMs: EVENT_LOOP_RESOLUTION_MS,
      mean: Number((loopMonitor.mean / 1e6).toFixed(3)),
      p99: Number((loopMonitor.percentile(99) / 1e6).toFixed(3)),
      max: Number((loopMonitor.max / 1e6).toFixed(3)),
    },
    bytesWritten,
    bytesWrittenMethod:
      variant === 'json-cache'
        ? 'sum of statSync sizes of every rewritten chat file'
        : 'on-disk delta of bench.sqlite + -wal + -shm across the final FULL checkpoint',
    startupReplayMs: replay,
    cpuUsageMs: {
      scope: 'process-wide delta over the variant window (all threads; not a per-thread split)',
      userMs: cpuUserMs,
      systemMs: cpuSystemMs,
      totalMs: cpuTotalMs,
      // Same process-wide counter, read from the worker over its own lifetime.
      // Cross-check only — never additive with totalMs.
      workerWindowTotalMs,
    },
    memory: {
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
      rssMb: rssAtEndMb,
      rssAtStartMb,
      rssDeltaMb: Number((rssAtEndMb - rssAtStartMb).toFixed(2)),
    },
    durability:
      variant === 'json-cache'
        ? jsonDurability
        : 'FULL (WAL + synchronous=FULL)',
  };
}

/**
 * Merge workload blocks from a prior report into the current one.
 * @param {object} report
 * @param {string} mergePath
 */
function mergePriorWorkloads(report, mergePath) {
  if (!mergePath || !fs.existsSync(mergePath)) return;
  const prior = JSON.parse(fs.readFileSync(mergePath, 'utf8'));
  const mergedNames = new Set(report.workloadsRun || []);
  for (const [name, block] of Object.entries(prior.workloads || {})) {
    if (mergedNames.has(name)) continue;
    report.workloads[name] = block;
    mergedNames.add(name);
  }
  report.workloadsRun = [...mergedNames];
  report.mergedFrom = path.basename(mergePath);
  report.notes.push(
    `Merged workloads from ${path.basename(mergePath)}: ${Object.keys(prior.workloads || {}).join(', ')}.`
  );
}

async function main() {
  const nodeVersion = process.version;
  let bundledSqlite = 'unknown';
  try {
    const probe = new DatabaseSync(':memory:');
    bundledSqlite = String(probe.prepare('SELECT sqlite_version() AS v').get()?.v || 'unknown');
    probe.close();
  } catch {
    bundledSqlite = 'unavailable';
  }
  const outRoot =
    process.env.CRETLI_BASELINE_OUT ||
    path.join(process.env.CRETLI_DATA_DIR || os.tmpdir(), 'storage-baseline');
  await mkdir(outRoot, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'cretli-baseline-'));
  /** @type {object} */
  const report = {
    runId,
    startedAt: new Date().toISOString(),
    nodeVersion,
    bundledSqlite,
    seed: SEED,
    workloadsRun: WORKLOADS,
    projectRoot: PROJECT_ROOT,
    workRoot,
    workloads: {},
    notes: [
      'Synthetic chat-event append pattern; not a full Cretli server simulation.',
      'json-cache variant models chat-history-persist full-document rewrite.',
      'Workloads are deterministic: same seed produces the same ids, payloads and read pattern for every variant.',
      'bytesWritten is measured on disk (file sizes), not estimated from payload lengths.',
      'checkpointSamples are reported separately and never mixed into commitSamples.',
      'Compare against docs/storage-gates.md before go/no-go.',
      `json-cache fsync=${JSON_FSYNC}; event-loop yields between ops; periodic checkpoints every ${CHECKPOINT_EVERY_ROUNDS} rounds when appendRounds>1.`,
      `Worker burst queue-age probe: ${WORKER_BURST_INSERTS} concurrent inserts after main workload.`,
      `eventLoopDelayMs sampled at resolution=${EVENT_LOOP_RESOLUTION_MS} ms; a healthy loop reports a mean near that floor, so read p99/max against it.`,
      'cpuUsageMs is ONE process-wide delta over the variant window: process.cpuUsage() counts every thread even when read from a worker, so workerThread CPU is already included and must not be added again (workerWindowTotalMs is a cross-check only).',
      'memory is process-level and cumulative across variants of a run (all variants share one process), so rssDeltaMb is a proxy, not an isolated per-variant footprint.',
      'The burst probe runs after the final FULL checkpoint; its rows land in the worker WAL and are included in that variant\'s on-disk bytesWritten delta.',
    ],
  };
  for (const workload of WORKLOADS) {
    const shape = workloadShape(workload);
    report.workloads[workload] = { shape, variants: {} };
    for (const variant of VARIANTS) {
      const variantDir = path.join(workRoot, workload, variant);
      await mkdir(variantDir, { recursive: true });
      process.stdout.write(`\n==> ${workload} / ${variant}\n`);
      // Fresh rng per workload so every variant sees an identical stream.
      const rng = createRng(SEED + workload.length * 7919);
      report.workloads[workload].variants[variant] = await runVariant(
        /** @type {'json-cache' | 'sqlite-main' | 'sqlite-worker'} */ (variant),
        variantDir,
        shape,
        rng
      );
    }
  }
  if (MERGE_IN) {
    mergePriorWorkloads(report, path.isAbsolute(MERGE_IN) ? MERGE_IN : path.join(PROJECT_ROOT, MERGE_IN));
  }
  report.finishedAt = new Date().toISOString();
  report.reportHash = createHash('sha256').update(JSON.stringify(report.workloads)).digest('hex');
  const outFile = path.join(outRoot, `baseline-${runId}.json`);
  await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(workRoot, { recursive: true, force: true });
  console.log(`\nWrote ${outFile}`);
  console.log(`reportHash=${report.reportHash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
