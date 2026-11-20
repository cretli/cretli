#!/usr/bin/env node
/**
 * Harness baseline for history replay lifecycle (task 0.1).
 * Not a Chrome Performance trace — Node-only simulation with real lifecycle modules.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { runHistoryReplayAsyncTail } from '../app_front/lib/chatHistoryReplayAsyncLoop.js';
import {
  createChatHistoryReplayLifecycle,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import {
  currentSpanName,
  resetChatPerfBudget,
} from '../app_front/lib/chatPerfBudget.js';
import { __resetUiFreezeCountersForTest } from '../app_front/lib/uiFreezeCounters.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(projectRoot, 'tests/fixtures/synthetic-history-replay-records.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const records = fixture.records;

/** @param {boolean} diagOn */
async function runScenario(diagOn) {
  resetChatPerfBudget();
  __resetUiFreezeCountersForTest();
  const lifecycle = createChatHistoryReplayLifecycle({ active: () => diagOn });
  const wallStart = performance.now();
  const run = lifecycle.beginReplay({
    source: 'local',
    totalRecords: records.length,
    syncHead: HISTORY_REPLAY_SYNC_HEAD,
    instant: false,
  });
  for (let index = 0; index < run.syncHead; index += 1) {
    void records[index];
  }
  lifecycle.noteSyncApplied(run.generation, run.syncHead);
  await runHistoryReplayAsyncTail({
    records,
    startIndex: run.syncHead,
    replayGeneration: run.generation,
    lifecycle,
    scheduleFrame: (cb) => setTimeout(cb, 0),
    applyHistoryRecord: (row) => {
      const message = row && typeof row === 'object' && 'message' in row ? String(row.message) : '';
      if (message.length > 1000) {
        let checksum = 0;
        for (let index = 0; index < message.length; index += 4096) {
          checksum += message.charCodeAt(index);
        }
        void checksum;
      }
    },
    finalizeTail: () => {},
    getAppliedMeta: () => ({ applied: records.length, children: records.length }),
  });
  const wallMs = performance.now() - wallStart;
  return {
    diagOn,
    wallMs,
    spanIdle: currentSpanName() === 'idle',
    activeAsyncLoops: lifecycle.getActiveAsyncLoops(),
  };
}

/** @param {boolean} diagOn @param {number} repeats */
async function medianWallMs(diagOn, repeats = 5) {
  /** @type {number[]} */
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const row = await runScenario(diagOn);
    samples.push(row.wallMs);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const diagOnMs = await medianWallMs(true);
const diagOffMs = await medianWallMs(false);
const overheadMs = Math.max(0, diagOnMs - diagOffMs);
const overheadPct = diagOffMs > 0 ? (overheadMs / diagOffMs) * 100 : 0;

const lines = [];
lines.push('## Harness baseline (Node, synthetic fixture)');
lines.push('');
lines.push(`Fixture: \`${path.relative(projectRoot, fixturePath)}\`, records=${records.length},`);
lines.push(`large record bytes≈${Buffer.byteLength(String(records[Math.floor(records.length / 2)]?.message || ''), 'utf8')}.`);
lines.push(`Viewport: n/a (harness — **not** Chrome Performance trace).`);
lines.push('');
lines.push('| Metric | Value |');
lines.push('| --- | ---: |');
lines.push(`| Median full async replay wall ms (diag **on**) | ${Math.round(diagOnMs * 100) / 100} |`);
lines.push(`| Median full async replay wall ms (diag **off**) | ${Math.round(diagOffMs * 100) / 100} |`);
lines.push(`| Diagnostic overhead (median delta) | ${Math.round(overheadMs * 100) / 100} ms (${Math.round(overheadPct * 10) / 10}%) |`);
lines.push(`| syncHead | ${HISTORY_REPLAY_SYNC_HEAD} |`);
lines.push('');
lines.push('Captured via `node scripts/measure-history-replay-lifecycle-baseline.mjs`.');

process.stdout.write(`${lines.join('\n')}\n`);
