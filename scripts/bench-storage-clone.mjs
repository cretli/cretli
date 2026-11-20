#!/usr/bin/env node
/**
 * Structured-clone cost of the storage worker channel, measured with `host.getChannelStats()`.
 *
 *   node scripts/bench-storage-clone.mjs [--cycles 5] [--readers 8] [--events 200] [--period-ms 5000] [--json]
 *
 * Runs the same synthetic chat-history workload twice against a throw-away database:
 *   before: full per-event columns (`lean: false`) and readers that cannot share a round trip
 *           (each read carries a distinct deadline, which disables coalescing);
 *   after:  lean events (`lean: true`) and identical concurrent readers (coalesced by the host).
 * Each cycle appends a few events, then fires `readers` identical concurrent reads of every list-style
 * query. Bytes are the UTF-16 length of the JSON crossing postMessage (both directions). MB/min assumes one
 * cycle per `--period-ms` (default 5 s, a typical UI poll cadence) rather than the burst's wall time, which
 * would only measure how fast the worker drains a synthetic burst. The workload is synthetic: treat the
 * numbers as a relative before/after comparison, not as production traffic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createChatHistoryStore } from '../lib/storage/chat-history-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const TARGET_MB_PER_MIN = 200;
const HANDLERS_PATH = fileURLToPath(new URL('../tests/fixtures/storage-chat-history-handlers.js', import.meta.url));
const NAMESPACE = Object.freeze({ datasetGeneration: 'generation-1', chatId: 'bench-chat', chatEpoch: 'epoch-1' });
const PRODUCER = 'bench-producer';

/** @param {string} name @param {number} fallback */
function intArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** @param {Record<string, any>} stats @returns {number} total bytes in both directions */
function totalBytes(stats) {
  let sum = 0;
  for (const v of Object.values(stats)) sum += v.sentBytes + v.receivedBytes;
  return sum;
}

/** @param {boolean} after @param {{cycles:number, readers:number, events:number, periodMs:number}} cfg */
async function runScenario(after, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-bench-clone-'));
  const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, faultInjection: true, writeGate: WRITE_GATE_TEST_EXEMPTION });
  try {
    await host.start();
    const store = createChatHistoryStore({ host });
    const text = 'x'.repeat(600);
    let clientSeq = 0;
    const appendBatch = async (n) => {
      const events = [];
      for (let i = 0; i < n; i += 1) {
        clientSeq += 1;
        events.push({ clientSeq, rec: { kind: 'localUser', text: `${text}${clientSeq}` } });
      }
      await store.appendEvents({ ...NAMESPACE, producerId: PRODUCER, commandId: `seed-${clientSeq}`, events });
    };
    for (let i = 0; i < cfg.events; i += 50) await appendBatch(50);
    const perCycle = [];
    for (let c = 0; c < cfg.cycles; c += 1) {
      await appendBatch(5);
      const baseBytes = totalBytes(host.getChannelStats());
      const startedAt = performance.now();
      const reads = [];
      for (let r = 0; r < cfg.readers; r += 1) {
        // Distinct deadlines keep the "before" readers from sharing a round trip; "after" readers are identical.
        const opts = after ? {} : { deadlineMs: 600000 + r };
        const lean = after;
        reads.push(
          host.query('history.readLatest', { ...NAMESPACE, anyEpoch: true, limit: 80, lean }, opts),
          host.query('history.readPage', { ...NAMESPACE, anyEpoch: true, afterSeq: 0, limit: 200, lean }, opts),
          host.query('history.readUsage', { ...NAMESPACE, anyEpoch: true }, opts),
        );
      }
      await Promise.all(reads);
      const ms = performance.now() - startedAt;
      const bytes = totalBytes(host.getChannelStats()) - baseBytes;
      perCycle.push({ cycle: c + 1, mb: bytes / 1048576, ms });
    }
    const coalesced = Object.values(host.getChannelStats()).reduce((n, v) => n + v.coalesced, 0);
    const mb = perCycle.reduce((n, p) => n + p.mb, 0);
    return { perCycle, coalesced, totalMb: mb, mbPerMin: (mb / cfg.cycles) * (60000 / cfg.periodMs) };
  } finally {
    await host.close({ timeoutMs: 2000 }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cfg = { cycles: intArg('cycles', 5), readers: intArg('readers', 8), events: intArg('events', 200), periodMs: intArg('period-ms', 5000) };
const before = await runScenario(false, cfg);
const afterRun = await runScenario(true, cfg);
const result = { config: cfg, targetMbPerMin: TARGET_MB_PER_MIN, before, after: afterRun, afterMeetsTarget: afterRun.mbPerMin < TARGET_MB_PER_MIN };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const fmt = (r) => `${r.totalMb.toFixed(2)} MB over ${cfg.cycles} cycles, ${(r.totalMb / cfg.cycles).toFixed(2)} MB/cycle, ${r.mbPerMin.toFixed(0)} MB/min @ ${cfg.periodMs}ms cycles, coalesced ${r.coalesced}`;
  console.log(`before: ${fmt(before)}`);
  console.log(`after:  ${fmt(afterRun)}`);
  console.log(`target < ${TARGET_MB_PER_MIN} MB/min: ${result.afterMeetsTarget ? 'met' : 'NOT met'}`);
}
