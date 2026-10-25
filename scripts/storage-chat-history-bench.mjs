#!/usr/bin/env node
/**
 * A3a / A1 chat-history benchmark. Uses synthetic records and OS temporary
 * directories only (never the live data tree).
 *
 *   CRETLI_BENCH_OUT=/tmp/chat-bench-a1-complete.json \
 *   CRETLI_BENCH_MD=docs/storage-a3a-validation-report.md \
 *   node scripts/storage-chat-history-bench.mjs
 *
 * Environment: CRETLI_BASELINE_SEED (default 20261013, same as the A1 harness),
 * CRETLI_BENCH_WORKLOADS (comma list), CRETLI_BENCH_SCALE (divide each workload
 * for a smoke run; a scaled run can never be PASS), CRETLI_BENCH_OUT,
 * CRETLI_BENCH_MD.
 *
 * Every gate row carries n / method / budget / status (PASS | FAIL |
 * UNVERIFIED). Missing or too few samples are UNVERIFIED, never PASS. Startup is
 * reported two ways and the two are not interchangeable:
 *  - `startupReplay` (A1 frozen method, docs/storage-baseline.md): the storage
 *    thread already exists; it closes and reopens through the production
 *    `openStorageDb()` + durability barrier, then reads one cold page. Thread
 *    spawn is excluded. The clean close checkpoints the WAL, so the same budget
 *    is also evaluated with the WAL-present, barrier-inclusive cost taken from
 *    the real worker's ready phases (`walPresentReplayMedianMs`).
 *  - `endToEndStart` (diagnostic, not gated): a fresh host spawns a worker
 *    thread that imports the registry, opens, runs the barrier and reports
 *    ready, plus the first cold page. Per-phase timings come from the
 *    production worker's `ready` message (`host.getMetrics().lastStart`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatHistoryStore, HISTORY_RETENTION_LIMIT } from '../lib/storage/chat-history-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { DEFAULT_STORAGE_DB_FILENAME as DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { gate } from './storage-bench-gate.mjs';

const HANDLERS_PATH = fileURLToPath(new URL('../lib/storage/chat-history-store.js', import.meta.url));
const BENCH_THREAD_URL = new URL('./storage-bench-thread.mjs', import.meta.url);
const EVENT_LOOP_RESOLUTION_MS = 1;
const CONCURRENCY = 64;
const BURST_EVENTS = 200;
const SEED = Number.parseInt(process.env.CRETLI_BASELINE_SEED || '', 10) || 20261013;
const SCALE = Math.max(1, Number.parseInt(process.env.CRETLI_BENCH_SCALE || '1', 10) || 1);
/** FULL checkpoint sample schedule: batch % 8 === 3 idle, batch % 8 === 7 contended. */
const CHECKPOINT_PERIOD = 8;
const IDLE_CHECKPOINT_PHASE = 3;
const CONTENDED_CHECKPOINT_PHASE = 7;
const STARTUP_SAMPLES = 5;
const MIN_LATENCY_SAMPLES = 100;
const MIN_CHECKPOINT_SAMPLES = 30;
const CONTENTION_PROBE_MIN = 30;
const PRIORITY_CLASSES = Object.freeze(['stop', 'claim', 'intent']);
/** A1 workload shapes (docs/storage-baseline.md / scripts/storage-baseline-harness.mjs). */
const ALL_WORKLOADS = Object.freeze([
  { name: 'small', chats: 10, eventsPerChat: 50, appendRounds: 1, readRatio: 0.2 },
  { name: 'medium', chats: 100, eventsPerChat: 200, appendRounds: 1, readRatio: 0.25 },
  { name: 'growing', chats: 20, eventsPerChat: 50, appendRounds: 40, readRatio: 0.15 },
  { name: 'mixed', chats: 50, eventsPerChat: 120, appendRounds: 3, readRatio: 0.4 },
]);
const REQUESTED = (process.env.CRETLI_BENCH_WORKLOADS || ALL_WORKLOADS.map((w) => w.name).join(',')).split(',').map((v) => v.trim());
const WORKLOADS = ALL_WORKLOADS
  .filter((w) => REQUESTED.includes(w.name))
  .map((w) => (SCALE === 1 ? w : { ...w, eventsPerChat: Math.max(2, Math.floor(w.eventsPerChat / SCALE)), appendRounds: Math.max(1, Math.floor(w.appendRounds / SCALE)) }));

/** @param {number} value @returns {number} */
function round(value) {
  return Number(value.toFixed(3));
}

/** @param {number[]} samples @returns {{ n: number, p50: number, p95: number, p99: number, max: number }} */
function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] || 0;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(at(1)) };
}

/** @param {number[]} values @returns {number} */
function median(values) {
  return summarize(values).p50;
}

/** @param {number} seed @returns {() => number} mulberry32 */
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
 * Deterministic event stream of one workload: per round every chat receives
 * `eventsPerChat` events round-robin; text length comes from the seeded PRNG so
 * the worker and JSON variants see byte-identical records.
 * @param {{ chats: number, eventsPerChat: number, appendRounds: number }} shape
 */
function createStream(shape) {
  const perRound = shape.chats * shape.eventsPerChat;
  const total = perRound * shape.appendRounds;
  const rng = createRng(SEED ^ (shape.chats * 7919 + shape.eventsPerChat));
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

/** @returns {number | null} */
function readPhysicalWriteBytes() {
  try {
    const match = /^write_bytes:\s*(\d+)$/m.exec(fs.readFileSync('/proc/self/io', 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** @param {number | null} before @returns {number | null} */
function physicalWriteDelta(before) {
  const after = readPhysicalWriteBytes();
  return before === null || after === null ? null : after - before;
}

/** @param {string} dir @returns {number} */
function sqliteFilesSize(dir) {
  return ['', '-wal', '-shm'].reduce((total, suffix) => {
    try {
      return total + fs.statSync(path.join(dir, `${DB_FILENAME}${suffix}`)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return total;
    }
  }, 0);
}

/** @param {string} source @param {string} target */
function copyStoreFiles(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const suffix of ['', '-wal']) {
    try {
      fs.copyFileSync(path.join(source, `${DB_FILENAME}${suffix}`), path.join(target, `${DB_FILENAME}${suffix}`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Bench-only FULL checkpointer in its own thread (scripts/storage-bench-thread.mjs)
 * so a checkpoint never blocks the benchmark's event loop and can overlap the
 * storage worker's writes.
 * @param {string} dir
 */
function createCheckpointer(dir) {
  const thread = new Worker(BENCH_THREAD_URL, { workerData: { role: 'checkpointer', dir } });
  const pending = new Map();
  let nextId = 1;
  let closing = null;
  thread.on('message', (msg) => {
    if (msg.type !== 'checkpointed') return;
    pending.get(msg.id)?.({ ms: msg.ms, busy: msg.busy });
    pending.delete(msg.id);
  });
  return {
    /** @returns {Promise<{ ms: number, busy: number }>} */
    request() {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        thread.postMessage({ type: 'checkpoint', id });
      });
    },
    close() {
      if (!closing) {
        closing = new Promise((resolve) => thread.once('exit', resolve));
        thread.postMessage({ type: 'stop' });
      }
      return closing;
    },
  };
}

/** @param {number} index @param {number} chats @param {object} stream */
function appendOne(store, generation, event, index, extra = {}) {
  return store.appendEvents({
    datasetGeneration: generation,
    chatEpoch: 'epoch-1',
    chatId: event.chatId,
    producerId: 'bench-producer-1',
    commandId: `bench:${generation}:${index}`,
    events: [{ clientSeq: event.clientSeq, rec: event.rec }],
    ...extra,
  });
}

/** @param {string} generation @param {string} chatId */
function pageRequest(generation, chatId = 'bench-chat-0') {
  return { datasetGeneration: generation, chatEpoch: 'epoch-1', chatId, limit: 50 };
}

/**
 * Frozen A1 startup/replay: reopen inside an EXISTING thread (spawn excluded),
 * production openStorageDb + durability barrier, then one cold page.
 * @param {string} snapshot @param {string} root @param {string} name @param {number} sample
 */
async function measureReopenInThread(snapshot, root, name, sample) {
  const dir = path.join(root, `reopen-${name}-${sample}`);
  copyStoreFiles(snapshot, dir);
  const thread = new Worker(BENCH_THREAD_URL, { workerData: { role: 'reopen', dir } });
  try {
    const result = await new Promise((resolve, reject) => {
      thread.once('error', reject);
      thread.on('message', (msg) => msg.type === 'measured' && resolve(msg));
      // The thread opens its initial handle first; the message queues behind it.
      thread.postMessage({ type: 'measure', payload: pageRequest(name) });
    });
    return {
      closeMs: result.closeMs,
      openMs: result.openMs,
      barrierMs: result.barrierMs,
      coldReadMs: result.coldReadMs,
      integrityCheckMs: result.integrityCheckMs,
      foreignKeyCheckMs: result.foreignKeyCheckMs,
      reopenMs: result.openMs + result.barrierMs,
      totalMs: result.openMs + result.barrierMs + result.coldReadMs,
    };
  } finally {
    await thread.terminate();
  }
}

/**
 * Full host start on a quiescent copy (WAL as left by the run): spawn + import
 * + open + integrity + barrier + ready, then the first cold page.
 * @param {string} snapshot @param {string} root @param {string} name @param {number} sample
 */
async function measureEndToEndStart(snapshot, root, name, sample) {
  const dir = path.join(root, `e2e-${name}-${sample}`);
  copyStoreFiles(snapshot, dir);
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const started = performance.now();
  await host.start();
  const startMs = performance.now() - started;
  try {
    const phases = host.getMetrics().lastStart;
    const store = createChatHistoryStore({ host });
    const coldStarted = performance.now();
    await store.readLatest(pageRequest(name));
    const coldReadMs = performance.now() - coldStarted;
    return { startMs, coldReadMs, totalMs: startMs + coldReadMs, phases };
  } finally {
    await host.close();
  }
}

/** @param {Array<Record<string, number>>} samples @param {string[]} keys */
function medianOf(samples, keys) {
  return Object.fromEntries(keys.map((key) => [key, round(median(samples.map((sample) => sample[key])))]));
}

/** @param {object} workload @param {string} root */
async function measureWorker(workload, root) {
  const stream = createStream(workload);
  const dir = path.join(root, `worker-${workload.name}`);
  fs.mkdirSync(dir);
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const committer = createGroupCommitter({ host });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  const readRng = createRng(SEED + 1);
  const appendSamples = [];
  const readSamples = [];
  const idleCheckpoints = [];
  const contendedCheckpoints = [];
  let checkpointBusy = 0;
  await host.start();
  const checkpointer = createCheckpointer(dir);
  const initialBytes = sqliteFilesSize(dir);
  const initialPhysicalBytes = readPhysicalWriteBytes();
  const readsPerBatch = Math.round(workload.readRatio * CONCURRENCY);
  const monitor = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  try {
    monitor.enable();
    const started = performance.now();
    for (let offset = 0, batch = 0; offset < stream.total; offset += CONCURRENCY, batch += 1) {
      const contended = batch % CHECKPOINT_PERIOD === CONTENDED_CHECKPOINT_PHASE ? checkpointer.request() : null;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stream.total - offset) }, async (_, member) => {
        const submitted = performance.now();
        await appendOne(store, workload.name, stream.at(offset + member), offset + member);
        appendSamples.push(performance.now() - submitted);
      }));
      if (contended) {
        const sample = await contended;
        contendedCheckpoints.push(sample.ms);
        checkpointBusy += sample.busy;
      }
      const written = Math.min(workload.chats, offset + CONCURRENCY);
      for (let read = 0; read < readsPerBatch; read += 1) {
        const submitted = performance.now();
        await store.readLatest(pageRequest(workload.name, `bench-chat-${Math.floor(readRng() * written)}`));
        readSamples.push(performance.now() - submitted);
      }
      if (batch % CHECKPOINT_PERIOD === IDLE_CHECKPOINT_PHASE) {
        const sample = await checkpointer.request();
        idleCheckpoints.push(sample.ms);
        checkpointBusy += sample.busy;
      }
    }
    await committer.flush();
    const elapsedMs = performance.now() - started;
    monitor.disable();
    const steady = host.getMetrics();
    const passiveStarted = performance.now();
    const passive = await host.control('checkpoint');
    const passiveMs = performance.now() - passiveStarted;
    const finalFull = await checkpointer.request();
    if (finalFull.busy !== 0) throw new Error('final FULL checkpoint was busy');
    const bytesWritten = Math.max(0, sqliteFilesSize(dir) - initialBytes);
    const physicalWriteBytes = physicalWriteDelta(initialPhysicalBytes);
    const snapshot = path.join(root, `snapshot-${workload.name}`);
    copyStoreFiles(dir, snapshot);
    const groupMetrics = committer.getMetrics();
    await checkpointer.close();
    await committer.close();
    await host.close();
    const reopenSamples = [];
    const endToEndSamples = [];
    for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) reopenSamples.push(await measureReopenInThread(snapshot, root, workload.name, sample));
    for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) endToEndSamples.push(await measureEndToEndStart(snapshot, root, workload.name, sample));
    return {
      durability: 'WAL + synchronous=FULL; receipts and mutations in the same transaction; unconditional TRUNCATE barrier on every worker start',
      events: stream.total,
      appendCalls: stream.total,
      concurrency: CONCURRENCY,
      elapsedMs: round(elapsedMs),
      appendLatencyMs: summarize(appendSamples),
      queryLatencyMs: summarize(readSamples),
      readsPerBatch,
      eventLoopDelayMs: {
        n: monitor.count,
        monitorResolutionMs: EVENT_LOOP_RESOLUTION_MS,
        mean: round(monitor.mean / 1e6),
        p99: round(monitor.percentile(99) / 1e6),
        max: round(monitor.max / 1e6),
      },
      queueAgeMs: steady.queue.queueAgeMs,
      workerRequestMs: steady.requestMs,
      workerExecuteMs: steady.executeMs,
      groupCommit: groupMetrics,
      checkpointPassive: { wallMs: round(passiveMs), ...passive },
      fullCheckpointIdleMs: summarize(idleCheckpoints),
      fullCheckpointContendedMs: summarize(contendedCheckpoints),
      fullCheckpointBusyResults: checkpointBusy,
      startupReplay: {
        method: 'A1 frozen, clean-close variant: close then reopen in an existing thread (spawn excluded) = production openStorageDb (read-only integrity_check/foreign_key_check, WAL+FULL, migrations) + production TRUNCATE barrier, then one cold page; warm OS page cache; closeMs excluded as in the baseline. The clean close already checkpointed the WAL, so the barrier is nearly free here; integrityCheckMs/foreignKeyCheckMs are warm post-hoc attribution of the checks inside openMs',
        samples: reopenSamples.map((sample) => Object.fromEntries(Object.entries(sample).map(([key, value]) => [key, round(value)]))),
        median: medianOf(reopenSamples, ['closeMs', 'openMs', 'barrierMs', 'integrityCheckMs', 'foreignKeyCheckMs', 'reopenMs', 'coldReadMs', 'totalMs']),
      },
      endToEndStart: {
        method: 'fresh host.start() on a quiescent copy of db+wal (WAL as left after the final FULL checkpoint): thread spawn + handler import + open/integrity + barrier + ready, then one cold page; warm OS page cache',
        samples: endToEndSamples.map((sample) => ({
          startMs: round(sample.startMs), coldReadMs: round(sample.coldReadMs), totalMs: round(sample.totalMs),
          registryMs: round(sample.phases.registryMs), openMs: round(sample.phases.openMs), barrierMs: round(sample.phases.barrierMs),
          threadOverheadMs: round(sample.phases.threadOverheadMs),
        })),
        walPresentReplayMethod: 'spawn excluded, WAL present: worker-reported openMs + barrierMs (real WAL recovery, fsync and TRUNCATE checkpoint) + cold page; this is the barrier-inclusive restart cost without thread creation',
        walPresentReplayMedianMs: round(median(endToEndSamples.map((s) => s.phases.openMs + s.phases.barrierMs + s.coldReadMs))),
        median: {
          startMs: round(median(endToEndSamples.map((s) => s.startMs))),
          coldReadMs: round(median(endToEndSamples.map((s) => s.coldReadMs))),
          totalMs: round(median(endToEndSamples.map((s) => s.totalMs))),
          registryMs: round(median(endToEndSamples.map((s) => s.phases.registryMs))),
          openMs: round(median(endToEndSamples.map((s) => s.phases.openMs))),
          barrierMs: round(median(endToEndSamples.map((s) => s.phases.barrierMs))),
          threadOverheadMs: round(median(endToEndSamples.map((s) => s.phases.threadOverheadMs))),
        },
      },
      bytesWritten,
      bytesWrittenPer1000Events: round(bytesWritten * 1000 / stream.total),
      bytesWrittenMethod: 'A1 frozen: db + wal + shm file-size delta from just after schema creation to just after the final FULL checkpoint; growth proxy, not physical I/O',
      physicalWriteBytes,
      physicalWriteBytesMethod: 'diagnostic only: Linux /proc/self/io write_bytes delta, process-wide, includes the checkpointer thread; null where unavailable',
      hostCounters: steady.counters,
    };
  } finally {
    monitor.disable();
    await checkpointer.close().catch(() => {});
    await committer.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

/** @param {string} file @param {object} document @returns {number} */
function rewriteJsonDurably(file, document) {
  const temporary = `${file}.tmp`;
  const descriptor = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(descriptor, JSON.stringify(document, null, 2));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directoryDescriptor = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  return fs.statSync(file).size;
}

/** @param {object} workload @param {string} root */
async function measureJson(workload, root) {
  const stream = createStream(workload);
  const dir = path.join(root, `json-${workload.name}`);
  fs.mkdirSync(dir);
  const documents = new Map();
  const samples = [];
  const initialPhysicalBytes = readPhysicalWriteBytes();
  let bytesWritten = 0;
  for (let index = 0; index < stream.total; index += 1) {
    const event = stream.at(index);
    const document = documents.get(event.chatId) || { v: 1, chatId: event.chatId, headSeq: 0, events: [] };
    const started = performance.now();
    document.headSeq += 1;
    document.events.push({ seq: document.headSeq, rec: { ...event.rec, clientSeq: event.clientSeq } });
    if (document.events.length > HISTORY_RETENTION_LIMIT) document.events.splice(0, document.events.length - HISTORY_RETENTION_LIMIT);
    bytesWritten += rewriteJsonDurably(path.join(dir, `${event.chatId}.json`), document);
    samples.push(performance.now() - started);
    documents.set(event.chatId, document);
    if (index % CONCURRENCY === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const physicalWriteBytes = physicalWriteDelta(initialPhysicalBytes);
  const coldLoads = [];
  let coldEvents = 0;
  for (let sample = 0; sample < STARTUP_SAMPLES; sample += 1) {
    const coldStarted = performance.now();
    coldEvents = 0;
    for (const name of fs.readdirSync(dir)) coldEvents += JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).events.length;
    coldLoads.push(performance.now() - coldStarted);
  }
  return {
    coldLoadMs: { n: coldLoads.length, median: round(median(coldLoads)), samples: coldLoads.map(round) },
    coldLoadEvents: coldEvents,
    durability: 'temp write + file fsync + rename + directory fsync per append call (stronger than the legacy adapter)',
    events: stream.total,
    appendLatencyMs: summarize(samples),
    bytesWritten,
    bytesWrittenPer1000Events: round(bytesWritten * 1000 / stream.total),
    bytesWrittenMethod: 'A1 frozen: sum of stat sizes of every rewritten JSON file, pretty-printed like legacy history, retention-capped',
    physicalWriteBytes,
    physicalWriteBytesMethod: 'diagnostic only: Linux /proc/self/io write_bytes delta, process-wide; null where unavailable',
    scope: 'same synthetic append calls; no receipts/producer tombstones in the JSON baseline',
  };
}

/** @param {string} root */
async function measureBurst(root) {
  const dir = path.join(root, 'burst');
  fs.mkdirSync(dir);
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const store = createChatHistoryStore({ host });
  await host.start();
  try {
    const stream = createStream({ chats: 1, eventsPerChat: BURST_EVENTS, appendRounds: 1 });
    await Promise.all(Array.from({ length: BURST_EVENTS }, (_, index) => appendOne(store, 'burst', stream.at(index), index)));
    const metrics = host.getMetrics();
    return { events: BURST_EVENTS, grouping: 'none; 200 simultaneous receipt commands', queueAgeMs: metrics.queue.queueAgeMs, requestMs: metrics.requestMs, hostCounters: metrics.counters };
  } finally {
    await host.close();
  }
}

/**
 * Bounded priority probe on the REAL host + group committer. The Stop / claim /
 * intent callers are not migrated, so the probe is a PROXY: a history append
 * submitted with the `stop` / `claim` / `intent` storage priority on a control
 * chat, while the mixed-shape normal stream runs at concurrency 64.
 * @param {string} root
 */
async function measureContention(root) {
  const shape = ALL_WORKLOADS.find((w) => w.name === 'mixed');
  const scaled = { ...shape, eventsPerChat: Math.max(2, Math.floor(shape.eventsPerChat / SCALE)), appendRounds: 1 };
  const stream = createStream(scaled);
  const dir = path.join(root, 'contention');
  fs.mkdirSync(dir);
  const host = createStorageWorkerHost({ dbDir: dir, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  const committer = createGroupCommitter({ host });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  await host.start();
  const sequence = new Map(PRIORITY_CLASSES.map((name) => [name, 0]));
  /** @param {string} priority @returns {Promise<number>} submit-to-ack ms */
  const probe = async (priority) => {
    const seq = sequence.get(priority) + 1;
    sequence.set(priority, seq);
    const submitted = performance.now();
    await store.appendEvents({
      datasetGeneration: 'contention', chatEpoch: 'epoch-1', chatId: 'control-chat', producerId: `probe-${priority}`,
      commandId: `probe:${priority}:${seq}`, priority, events: [{ clientSeq: seq, rec: { kind: 'localUser', text: `probe ${priority} ${seq}` } }],
    });
    return performance.now() - submitted;
  };
  try {
    const idle = Object.fromEntries(PRIORITY_CLASSES.map((name) => [name, []]));
    for (let index = 0; index < CONTENTION_PROBE_MIN; index += 1) for (const name of PRIORITY_CLASSES) idle[name].push(await probe(name));
    const loaded = Object.fromEntries(PRIORITY_CLASSES.map((name) => [name, []]));
    const normal = [];
    const probes = [];
    for (let offset = 0, batch = 0; offset < stream.total; offset += CONCURRENCY, batch += 1) {
      const members = Array.from({ length: Math.min(CONCURRENCY, stream.total - offset) }, async (_, member) => {
        const submitted = performance.now();
        await appendOne(store, 'contention', stream.at(offset + member), offset + member);
        normal.push(performance.now() - submitted);
      });
      if (batch % 2 === 1) {
        await new Promise((resolve) => setImmediate(resolve));
        for (const name of PRIORITY_CLASSES) probes.push(probe(name).then((ms) => loaded[name].push(ms)));
      }
      await Promise.all(members);
    }
    await Promise.all(probes);
    await committer.flush();
    return {
      shape: scaled,
      proxy: 'history appendEvents with storage priority stop/claim/intent on a control chat; real Stop/claim/intent callers are not migrated',
      idleProbeMs: Object.fromEntries(PRIORITY_CLASSES.map((name) => [name, summarize(idle[name])])),
      underStreamProbeMs: Object.fromEntries(PRIORITY_CLASSES.map((name) => [name, summarize(loaded[name])])),
      normalAppendMs: summarize(normal),
      groupCommit: committer.getMetrics(),
      queue: host.getMetrics().queue,
    };
  } finally {
    await committer.close().catch(() => {});
    await host.close().catch(() => {});
  }
}


/** Budgets are the frozen docs/storage-gates.md values; they are never changed here. */
function evaluateGates(results, burst, contention) {
  const rows = [];
  for (const [name, entry] of Object.entries(results)) {
    const w = entry.worker;
    const primaryInteractive = name === 'mixed';
    const add = (id, metric, budget, n, actual, minN, method, extra = {}) => rows.push(gate({
      id, metric, workload: name, primary: primaryInteractive, n, minN, budget, actual, method, ...extra,
    }));
    add('handlerP95Ms', 'API handler (append ack) p95', 120, w.appendLatencyMs.n, w.appendLatencyMs.p95, MIN_LATENCY_SAMPLES, 'durable caller promise, submit to ack');
    add('handlerP99Ms', 'API handler (append ack) p99', 250, w.appendLatencyMs.n, w.appendLatencyMs.p99, MIN_LATENCY_SAMPLES, 'durable caller promise, submit to ack');
    add('workerRequestP95Ms', 'Worker queue wait + execute p95', 80, w.workerRequestMs.n, w.workerRequestMs.p95, MIN_LATENCY_SAMPLES, 'host requestMs per dispatched group/read');
    add('workerRequestP99Ms', 'Worker queue wait + execute p99', 180, w.workerRequestMs.n, w.workerRequestMs.p99, MIN_LATENCY_SAMPLES, 'host requestMs per dispatched group/read');
    add('pageQueryP95Ms', 'History page query p95', 40, w.queryLatencyMs.n, w.queryLatencyMs.p95, MIN_LATENCY_SAMPLES, 'readLatest(limit 50), sequential, interleaved with appends');
    add('pageQueryP99Ms', 'History page query p99', 90, w.queryLatencyMs.n, w.queryLatencyMs.p99, MIN_LATENCY_SAMPLES, 'readLatest(limit 50), sequential, interleaved with appends');
    add('eventLoopP99Ms', 'Event loop delay p99', 25, w.eventLoopDelayMs.n, w.eventLoopDelayMs.p99, MIN_LATENCY_SAMPLES, 'monitorEventLoopDelay at 1 ms resolution');
    add('eventLoopMaxMs', 'Event loop delay max', 100, w.eventLoopDelayMs.n, w.eventLoopDelayMs.max, MIN_LATENCY_SAMPLES, 'monitorEventLoopDelay at 1 ms resolution');
    add('steadyQueueP95Ms', 'Persist queue age p95 (steady)', 200, w.queueAgeMs.n, w.queueAgeMs.p95, MIN_LATENCY_SAMPLES, 'host queue age during the measured workload');
    add('fullCheckpointIdleP99Ms', 'FULL checkpoint p99 (idle)', 500, w.fullCheckpointIdleMs.n, w.fullCheckpointIdleMs.p99, MIN_CHECKPOINT_SAMPLES,
      'side-connection wal_checkpoint(FULL) in a bench thread, worker idle between batches', { note: 'p99 of a small n is close to max' });
    add('fullCheckpointContendedP99Ms', 'FULL checkpoint p99 (contended)', 500, w.fullCheckpointContendedMs.n, w.fullCheckpointContendedMs.p99, MIN_CHECKPOINT_SAMPLES,
      'same checkpointer fired while a 64-call append batch is in flight; waits for the writer under busy_timeout=5000', { note: 'p99 of a small n is close to max' });
  }
  rows.push(gate({
    id: 'burstQueueMaxMs', metric: 'Persist queue age max under burst', workload: 'burst', primary: true, n: burst.queueAgeMs.n ?? BURST_EVENTS, minN: BURST_EVENTS,
    budget: 2000, actual: burst.queueAgeMs.max, method: '200 simultaneous ungrouped receipt commands',
  }));
  const medium = results.medium;
  rows.push(gate({
    id: 'ioPercentOfJson', metric: 'Bytes written vs JSON (% of rewrite bytes)', workload: 'medium', primary: true, n: medium?.worker.events ?? null, minN: 1, budget: 25,
    actual: medium ? round(100 * medium.worker.bytesWritten / medium.json.bytesWritten) : null,
    method: 'A1 frozen: db+wal+shm file growth across the final FULL checkpoint vs summed JSON rewrite bytes (growth proxy; physical I/O is diagnostic only)',
  }));
  for (const [name, entry] of Object.entries(results)) {
    const budget = round(2 * entry.json.coldLoadMs.median);
    rows.push(gate({
      id: 'startupReplayCleanClose', metric: 'Startup replay, frozen A1 method (clean close, reopen in existing thread, cold page) vs 2x JSON cold load', workload: name, primary: name === 'medium',
      n: entry.worker.startupReplay.samples.length, minN: STARTUP_SAMPLES, budget,
      actual: entry.worker.startupReplay.median.totalMs,
      method: 'median of fresh-copy samples; budget = 2x median JSON cold load of all chat files; WAL checkpointed by the preceding close, so the barrier is nearly free',
    }));
    rows.push(gate({
      id: 'startupReplayWalPresent', metric: 'Startup replay with WAL present and the full barrier (spawn excluded) vs 2x JSON cold load', workload: name, primary: name === 'medium',
      n: entry.worker.endToEndStart.samples.length, minN: STARTUP_SAMPLES, budget,
      actual: entry.worker.endToEndStart.walPresentReplayMedianMs,
      method: 'median over real host starts of worker-reported open + barrier plus the cold page; includes WAL recovery, fsync and TRUNCATE checkpoint cost, excludes thread spawn and handler import',
    }));
  }
  for (const name of PRIORITY_CLASSES) {
    const summary = contention.underStreamProbeMs[name];
    rows.push(gate({
      id: `priorityMaxMs.${name}`, metric: `Priority '${name}' (proxy) max ack under history stream`, workload: 'contention', primary: true, n: summary.n,
      minN: CONTENTION_PROBE_MIN, budget: 500, actual: summary.max, method: 'history append submitted with this storage priority while the mixed stream runs; PROXY for the unmigrated callers',
    }));
  }
  const present = Object.keys(results);
  rows.push({
    id: 'workloadCoverage', metric: 'All four A1 workloads measured at full A1 shape', workload: 'all', primary: true, n: present.length, minN: ALL_WORKLOADS.length,
    budget: null, actual: null, method: 'small, medium, growing, mixed all present and CRETLI_BENCH_SCALE=1',
    status: present.length === ALL_WORKLOADS.length && SCALE === 1 ? 'PASS' : 'UNVERIFIED',
  });
  return rows;
}

/** @param {Array<{ primary: boolean, status: string }>} rows */
function overallStatus(rows) {
  const primary = rows.filter((row) => row.primary);
  if (primary.some((row) => row.status === 'FAIL')) return 'FAIL';
  if (primary.some((row) => row.status === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'PASS';
}

/** @param {object} report @returns {string} */
function renderMarkdown(report) {
  const lines = [
    '# A3a chat-history validation report (A1 gates)',
    '',
    `Generated by \`node scripts/storage-chat-history-bench.mjs\` on synthetic temp data (seed ${report.seed}). `
      + 'This is a single run on one machine and filesystem; it is not production rollout approval and migrates no production caller or data.',
    '',
    `**Overall: ${report.status}** (${report.statusExplanation})`,
    '',
    `Runtime: Node ${report.nodeVersion}, SQLite ${report.bundledSqlite}, ${report.platform}/${report.architecture}, ${report.cpuModel}.`,
    '',
    '## Gates (primary rows decide the overall status)',
    '',
    '| Gate | Workload | Primary | n | Actual | Budget | Status |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
    ...report.gates.map((row) => `| ${row.id} | ${row.workload} | ${row.primary ? 'yes' : 'no'} | ${row.n ?? '-'} | ${row.actual ?? '-'} | ${row.budget ?? '-'} | ${row.status} |`),
    '',
    'Non-primary rows apply the mixed/medium budgets to the other workloads for coverage only (the frozen gates define them on mixed and medium). '
      + 'Methods per gate are in the machine report (`gates[].method`). p99 of a small n is close to the max; `minN` rules make too few samples `UNVERIFIED`.',
    '',
    '## Startup: two separate numbers',
    '',
    '`startupReplay` is the frozen A1 method (close, then reopen in an existing thread via production `openStorageDb` + TRUNCATE barrier, then one cold page; thread spawn excluded); the clean close already checkpointed the WAL, so its barrier is nearly free. '
      + '`WAL-present replay` is the barrier-inclusive restart cost without thread creation (worker-reported open + barrier + cold page of real host starts) and is also gated against 2x JSON cold load. '
      + '`endToEndStart` (spawn, handler import, open + integrity, barrier, ready, cold page) is a diagnostic with no frozen budget. Medians in ms:',
    '',
    '| Workload | JSON cold load | 2x budget | A1 open | of which integrity + FK check (warm) | A1 barrier | A1 cold page | A1 clean-close total | WAL-present replay | E2E thread overhead | E2E open | E2E barrier | E2E total |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.workloads).map(([name, entry]) => {
      const a = entry.worker.startupReplay.median;
      const e = entry.worker.endToEndStart.median;
      return `| ${name} | ${entry.json.coldLoadMs.median} | ${round(2 * entry.json.coldLoadMs.median)} | ${a.openMs} | ${round(a.integrityCheckMs + a.foreignKeyCheckMs)} | ${a.barrierMs} | ${a.coldReadMs} | ${a.totalMs} | ${entry.worker.endToEndStart.walPresentReplayMedianMs} | ${e.threadOverheadMs} | ${e.openMs} | ${e.barrierMs} | ${e.totalMs} |`;
    }),
    '',
    '## Contention (Stop / claim / intent proxy)',
    '',
    `${report.contention.proxy}.`,
    '',
    '| Class | idle n | idle max ms | under stream n | p95 ms | p99 ms | max ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...PRIORITY_CLASSES.map((name) => {
      const idle = report.contention.idleProbeMs[name];
      const loaded = report.contention.underStreamProbeMs[name];
      return `| ${name} | ${idle.n} | ${idle.max} | ${loaded.n} | ${loaded.p95} | ${loaded.p99} | ${loaded.max} |`;
    }),
    '',
    '## I/O diagnostics',
    '',
    '| Workload | SQLite growth bytes (A1 method) | JSON rewrite bytes | Growth % of JSON | Physical write bytes SQLite (diagnostic) | Physical JSON (diagnostic) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.workloads).map(([name, entry]) => `| ${name} | ${entry.worker.bytesWritten} | ${entry.json.bytesWritten} | ${round(100 * entry.worker.bytesWritten / entry.json.bytesWritten)} | ${entry.worker.physicalWriteBytes ?? 'n/a'} | ${entry.json.physicalWriteBytes ?? 'n/a'} |`),
    '',
    'File growth is the frozen A1 gate method. Linux `write_bytes` is a process-wide block-I/O diagnostic (includes the checkpointer thread) and is never substituted for the gate.',
    '',
    '## Limitations',
    '',
    ...report.limitations.map((line) => `- ${line}`),
    '',
    '## Reproduce',
    '',
    '```bash',
    'CRETLI_BENCH_OUT=/tmp/chat-bench-a1-complete.json \\',
    'CRETLI_BENCH_MD=docs/storage-a3a-validation-report.md \\',
    'node scripts/storage-chat-history-bench.mjs',
    '```',
    '',
    'Set `CRETLI_BENCH_SCALE=10` for a smoke run (never PASS) and `CRETLI_BENCH_WORKLOADS=small,mixed` to subset. '
      + 'Results depend on disk fsync speed; re-run on the same machine class before comparing.',
    '',
  ];
  return lines.join('\n');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chat-history-bench-'));
try {
  const results = {};
  for (const workload of WORKLOADS) {
    console.error(`[bench] ${workload.name}: worker`);
    const worker = await measureWorker(workload, root);
    console.error(`[bench] ${workload.name}: json`);
    const json = await measureJson(workload, root);
    results[workload.name] = { shape: workload, worker, json };
  }
  console.error('[bench] burst');
  const burst = await measureBurst(root);
  console.error('[bench] contention');
  const contention = await measureContention(root);
  const gates = evaluateGates(results, burst, contention);
  const status = overallStatus(gates);
  const report = {
    benchmark: 'A3a chat-history library, A1 gates',
    nodeVersion: process.version,
    bundledSqlite: process.versions.sqlite || 'unknown',
    platform: process.platform,
    architecture: process.arch,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    generatedAt: new Date().toISOString(),
    seed: SEED,
    scale: SCALE,
    warmup: 'none; cold freshly created stores, startup excluded from append samples',
    tempDirectoriesOnly: true,
    workloads: results,
    burst,
    contention,
    gates,
    status,
    statusExplanation: 'any primary FAIL => FAIL; else any primary UNVERIFIED => UNVERIFIED; else PASS',
    limitations: [
      'One run on one machine/filesystem; PASS would not be production rollout approval and no production caller or data is migrated.',
      'Budgets are the frozen docs/storage-gates.md values and are not changed here.',
      'Group commit requests carry up to 64 append calls; worker request/queue timings are per dispatched group or read, append latency is per durable caller promise.',
      'JSON rewrites once per append call with stronger fsync durability than the active legacy adapter; the worker also persists receipts and dedupe; max history retention (2000 per chat) applies to both.',
      'The A1 startup gate follows the frozen method (existing thread, spawn excluded) but uses the production open path, so it also pays integrity_check, foreign_key_check and the unconditional TRUNCATE barrier that the frozen baseline (plain open, no checks) did not; end-to-end start adds thread spawn and handler import. Both are reported, neither lowers a budget.',
      'Startup samples run with a warm OS page cache on copies of db+wal; a cold-disk restart is not measured.',
      'The Stop/claim/intent probe is a proxy (history appends submitted with those storage priorities); the real callers are not migrated.',
      'FULL checkpoint p99 is taken from a small number of samples per workload (idle: worker idle between batches; contended: fired while a batch is in flight) on a side connection, not from the worker.',
      'File growth is the frozen A1 I/O gate; Linux write_bytes is a process-wide diagnostic and never replaces it. No power-loss simulation or concurrent backups.',
    ],
  };
  if (process.env.CRETLI_BENCH_OUT) fs.writeFileSync(process.env.CRETLI_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
  else console.log(JSON.stringify(report, null, 2));
  if (process.env.CRETLI_BENCH_MD) fs.writeFileSync(process.env.CRETLI_BENCH_MD, renderMarkdown(report));
  console.error(`[bench] overall ${status}`);
  if (status === 'FAIL') process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
