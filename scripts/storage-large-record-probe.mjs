#!/usr/bin/env node
/**
 * Large-record probe (history migration, large-record leaf). Synthetic data in an OS
 * temporary directory only; never reads or writes the live data tree.
 *
 *   node scripts/storage-large-record-probe.mjs [--rounds 7] [--out /tmp/large-probe.json]
 *
 * For each size it measures the full adapter write (durable pending entry -> fragments
 * -> finalize -> read-back), the read paths, the bytes of every worker response and the
 * main-thread event-loop delay, then repeats the write while 8 small appends run
 * concurrently to show what a large write costs the regular traffic. It is a probe, not
 * a gate: the four production workloads are NOT re-run here (stage 2b, when callers exist).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { createChatHistoryStore, HISTORY_GROUP_MAX_MEMBER_BYTES, HISTORY_MAX_LARGE_RECORD_BYTES, HISTORY_MAX_RECORD_BYTES } from '../lib/storage/chat-history-store.js';
import { createChatHistoryAdapter } from '../lib/persist/chat-history-adapter.js';
import { createSqliteHistoryBackend } from '../lib/persist/chat-history-backend-sqlite.js';
import { createHistoryPendingBuffer } from '../lib/persist/history-pending-buffer.js';
import { HISTORY_HANDLERS_PATH } from '../lib/persist/chat-history-runtime.js';
import { toWireJson } from '../lib/storage/worker-wire.js';

const GENERATION = 'gen-large-probe';
const WIDEST = Number.MAX_SAFE_INTEGER - 1;
const args = process.argv.slice(2);
const argOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROUNDS = Number.parseInt(argOf('--rounds', '7'), 10);
const OUT = argOf('--out', '');
const SIZES = [['256KiB+1', HISTORY_MAX_RECORD_BYTES + 1], ['1MiB', 1024 * 1024], ['2686612B', 2686612], ['3MiB cap', HISTORY_MAX_LARGE_RECORD_BYTES]];

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))].toFixed(2));
};
const summary = (values) => ({ n: values.length, min: percentile(values, 0), p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) });

/** Record whose store-measured size (widest clientSeq) is exactly `target`; text varies per call so nothing dedupes. */
function record(target, salt) {
  const measure = (text) => toWireJson({ kind: 'localUser', text, clientSeq: WIDEST }).bytes;
  const unit = `probe ${salt} zażółć 🙂 "q" \\ `;
  const base = measure('');
  const per = (measure(unit.repeat(50)) - base) / 50;
  let text = unit.repeat(Math.max(0, Math.floor((target - base) / per) - 1));
  text += 'x'.repeat(target - measure(text));
  return { kind: 'localUser', text };
}

async function main() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cretli-large-probe-'));
  const dbDir = path.join(root, 'db');
  fs.mkdirSync(dbDir);
  const host = createStorageWorkerHost({ dbDir, handlersPath: HISTORY_HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
  await host.start();
  const committer = createGroupCommitter({ host, maxMemberBytes: HISTORY_GROUP_MAX_MEMBER_BYTES });
  const store = createChatHistoryStore({ host, groupCommitter: committer });
  const pendingBuffer = createHistoryPendingBuffer({ dir: path.join(root, 'pending') });
  await pendingBuffer.open();
  const backend = createSqliteHistoryBackend({ store, datasetGeneration: GENERATION, pendingBuffer });
  const adapter = createChatHistoryAdapter({ backend, kind: 'sqlite' });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  const chat = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const results = [];
  let chatNo = 1;
  try {
    for (const [label, target] of SIZES) {
      const writeMs = [];
      const idleReadMs = [];
      const responseBytes = [];
      const loopMax = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = chat(chatNo);
        chatNo += 1;
        const rec = record(target, `${label}-${round}`);
        loop.reset();
        loop.enable();
        const started = performance.now();
        const outcome = await adapter.appendChatHistoryEvents(id, '', [{ rec }]);
        writeMs.push(performance.now() - started);
        loop.disable();
        loopMax.push(loop.max / 1e6);
        if (!outcome.ok) throw new Error('append failed');
        const readStarted = performance.now();
        const page = await store.readPage({ datasetGeneration: GENERATION, chatId: id, chatEpoch: 'any', anyEpoch: true, limit: 10 });
        idleReadMs.push(performance.now() - readStarted);
        responseBytes.push(toWireJson(page).bytes);
      }
      results.push({
        size: label, recordBytes: target,
        fragments: Math.ceil(target / (32 * 1024)),
        writeMs: summary(writeMs), readMs: summary(idleReadMs), responseBytes: summary(responseBytes),
        mainThreadLoopDelayMaxMs: summary(loopMax),
      });
    }
    // Contention: one large write while small appends run on other chats.
    const contention = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const small = [];
      const noise = Array.from({ length: 8 }, (_, lane) => (async () => {
        for (let i = 0; i < 12; i += 1) {
          const started = performance.now();
          await adapter.appendChatHistoryEvents(chat(900 + lane), '', [{ rec: { kind: 'localUser', text: `small ${round}-${lane}-${i}` } }]);
          small.push(performance.now() - started);
        }
      })());
      const started = performance.now();
      const large = adapter.appendChatHistoryEvents(chat(chatNo), '', [{ rec: record(2686612, `contend-${round}`) }]);
      chatNo += 1;
      await large;
      const largeMs = performance.now() - started;
      await Promise.all(noise);
      contention.push({ largeMs, smallP95: percentile(small, 95), smallMax: percentile(small, 100) });
    }
    const baseline = [];
    for (let i = 0; i < 96; i += 1) {
      const started = performance.now();
      await adapter.appendChatHistoryEvents(chat(950), '', [{ rec: { kind: 'localUser', text: `quiet ${i}` } }]);
      baseline.push(performance.now() - started);
    }
    const report = {
      schema: 'cretli-large-record-probe-v1', node: process.version, rounds: ROUNDS, synthetic: true,
      limits: {
        maxLargeRecordBytes: HISTORY_MAX_LARGE_RECORD_BYTES, regularRecordBytes: HISTORY_MAX_RECORD_BYTES, fragmentRawBytes: 32 * 1024,
        regularCommandBytes: 64 * 1024, workerResultBytes: 4 * 1024 * 1024, groupBatchBytes: 256 * 1024,
      },
      sizes: results,
      contention: {
        largeWriteMs: summary(contention.map((row) => row.largeMs)),
        smallAppendP95DuringLargeMs: summary(contention.map((row) => row.smallP95)),
        smallAppendMaxDuringLargeMs: summary(contention.map((row) => row.smallMax)),
        smallAppendQuietMs: summary(baseline),
      },
      pendingAfter: pendingBuffer.stats(),
      hostMetrics: { queue: host.getMetrics().queue, executeMs: host.getMetrics().executeMs, requestMs: host.getMetrics().requestMs, counters: host.getMetrics().counters },
      note: 'Informational probe on this machine; the four production workloads are re-run in stage 2b.',
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (OUT) fs.writeFileSync(OUT, text);
    process.stdout.write(text);
  } finally {
    await committer.close().catch(() => {});
    await host.close({ timeoutMs: 2000 }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
