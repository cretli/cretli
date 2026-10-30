/**
 * Performance budget (docs/perf-budgets-baseline.json): chat list page (50) and chat metadata
 * write on the JSON backend at 50 000 synthetic chats. Regression guard, not a target:
 * threshold = min(baseline * 1.2, absolute ceiling). Targets of stage 3 live in
 * tests/perf-budget-pending.test.js.
 *
 * Regenerate the baseline (operator/leaf review only; refuses to encode a value above a ceiling):
 *   CRETLI_PERF_BASELINE_WRITE=1 node tests/perf-budget-chats-baseline.test.js
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  PERF_SEED, CEILINGS, RUNS, mulberry32, medianOfRuns, startEventLoopMonitor, eventLoopResolutionMs,
  validateBaselineEntry, readBaseline, thresholdMs, writeBaselineEntry, baselinePath,
} from './helpers/perf-budget.js';

const CHATS = 50_000;
const SAMPLES = 20;
const WRITE = process.env.CRETLI_PERF_BASELINE_WRITE === '1';
const { saveChats, updateChat } = await import('../lib/persist/chats-persist.js');
const { readChatCatalog } = await import('../lib/chat-catalog.js');

function buildChats(count, rand) {
  const transports = ['sdk', 'opencode', 'claude', 'codex', 'qwen', 'deepseek'];
  return Array.from({ length: count }, (_, i) => ({
    id: `chat-${String(i).padStart(6, '0')}`,
    title: `Fixture chat ${i}`,
    cursorSessionId: `session-${i}`,
    workspaceFolder: `/work/ws-${i % 24}`,
    model: 'fixture/model',
    agentTransport: transports[Math.floor(rand() * transports.length)],
    createdAt: new Date(1.7e12 + i * 60000).toISOString(),
    archived: rand() < 0.4,
  }));
}

const dataFile = path.join(process.env.CRETLI_DATA_DIR, 'chats.json');
const scope = { workspaceFolder: '', workspaceFile: '', widgetInstallationId: '' };
const monitor = startEventLoopMonitor();

// Each run rewrites the fixture, so the first page sample of a run is a cold read.
const page = await medianOfRuns(() => {
  saveChats(buildChats(CHATS, mulberry32(PERF_SEED)));
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = performance.now();
    const result = readChatCatalog().page({ scope, archived: 'tree', limit: 50, cursor: '' });
    samples.push(performance.now() - t);
    assert.equal(result.items.length, 50);
  }
  return samples;
});

let bytesWritten = 0;
const write = await medianOfRuns(() => {
  saveChats(buildChats(CHATS, mulberry32(PERF_SEED)));
  const rand = mulberry32(PERF_SEED + 1);
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const id = `chat-${String(Math.floor(rand() * CHATS)).padStart(6, '0')}`;
    const t = performance.now();
    const chat = updateChat(id, { title: `Renamed ${i}` });
    samples.push(performance.now() - t);
    assert.equal(chat.title, `Renamed ${i}`);
  }
  // The JSON backend rewrites the whole document for one change.
  bytesWritten = fs.statSync(dataFile).size;
  return samples;
});
const eld = monitor.stop();
assert.equal(eld.monitorResolutionMs, eventLoopResolutionMs());

const measured = {
  'chat-list-page-50': page,
  'chat-metadata-write': { ...write, bytesWritten },
};
console.log('perf-budget-chats', JSON.stringify({ chats: CHATS, runs: RUNS, eventLoopDelayMs: eld, measured }));

if (WRITE) {
  for (const [operation, m] of Object.entries(measured)) {
    assert.ok(m.p95Ms <= CEILINGS[operation].p95Ms,
      `FINDING: measured ${operation} p95 ${m.p95Ms} ms exceeds the ${CEILINGS[operation].p95Ms} ms ceiling; not encoded as a baseline`);
    const entry = {
      operation, backend: 'json', chats: CHATS, seed: PERF_SEED, node: process.version, samples: m.n * m.runs,
      p50Ms: m.p50Ms, p95Ms: m.p95Ms, p99Ms: m.p99Ms,
      ...(m.bytesWritten !== undefined ? { bytesWritten: m.bytesWritten } : {}),
      eventLoopResolutionMs: eld.monitorResolutionMs, capturedAt: new Date().toISOString(),
    };
    writeBaselineEntry(entry, {
      schemaVersion: 1,
      description: 'Measured baseline for the performance-budget regression tests (tests/perf-budget-chats-baseline.test.js). Synthetic fixtures, median of 3 runs, event loop sampled at 1 ms. Threshold in CI = min(p95Ms * 1.2, absolute ceiling).',
      schema: {
        operation: 'string, e.g. chat-list-page-50 | chat-metadata-write',
        backend: "string, storage backend the number was measured on ('json')",
        chats: 'number of synthetic chats in the fixture',
        seed: 'PRNG seed of the fixture',
        node: 'process.version at capture time',
        samples: 'total samples behind the quantiles (per-run n * 3 runs; quantiles are the median across runs)',
        p50Ms: 'median latency, ms', p95Ms: '95th percentile, ms', p99Ms: '99th percentile, ms',
        bytesWritten: 'optional: bytes of the document rewritten per change',
        eventLoopResolutionMs: 'monitorEventLoopDelay resolution during capture; must be <= 1',
        capturedAt: 'ISO timestamp',
      },
    });
  }
  console.log(`baseline written to ${baselinePath}`);
}

// --- Regression guard against the repository baseline. ---
const baseline = readBaseline();
assert.ok(Array.isArray(baseline.entries), 'perf-budgets-baseline.json: entries[] missing');
for (const [operation, m] of Object.entries(measured)) {
  const entry = baseline.entries.find((e) => e.operation === operation && e.backend === 'json' && e.chats === CHATS);
  assert.ok(entry, `baseline entry missing: ${operation} / json / ${CHATS} chats`);
  assert.deepEqual(validateBaselineEntry(entry), [], `baseline entry schema: ${operation}`);
  const ceiling = CEILINGS[operation].p95Ms;
  assert.ok(entry.p95Ms <= ceiling,
    `FINDING: baseline ${operation} p95 ${entry.p95Ms} ms is above the absolute ceiling ${ceiling} ms; fix the code, do not raise the baseline`);
  const limit = thresholdMs(entry.p95Ms, ceiling);
  assert.ok(m.p95Ms <= limit,
    `${operation} p95 ${m.p95Ms} ms (n=${m.n}x${m.runs}) exceeds threshold ${limit.toFixed(1)} ms = min(baseline ${entry.p95Ms} * 1.2, ceiling ${ceiling})`);
}
console.log('perf-budget-chats-baseline ok');
