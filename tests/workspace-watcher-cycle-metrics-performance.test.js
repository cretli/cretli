import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { performance } from 'node:perf_hooks';
import * as metrics from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const at = new Date(now).toISOString();

function seed(dataDir, count) {
  const records = {};
  for (let i = 0; i < count; i++) {
    const cycleId = `cycle-${i}`;
    records[cycleId] = metrics.normalizeWorkspaceWatcherCycleMetric({
      cycleId, startedAt: at, closedAt: at, todoIds: ['todo'],
      todoOutcomes: [{ todoId: 'todo', outcome: 'completed' }],
      usage: { cycleId, orchestrator: { own: { tokens: { input: 100 }, runs: ['run'] } } },
      attribution: { roundsByLeaf: { todo: { round: 2, source: 'durable' } }, children: [{ leafId: 'todo', role: 'implement' }] },
    });
  }
  fs.writeFileSync(path.join(dataDir, 'workspace-watcher-cycles.json'), JSON.stringify({ records }));
}

function workload(dataDir, iteration, durations = []) {
  const call = (fn, input) => {
    const start = performance.now();
    fn(input);
    durations.push(performance.now() - start);
  };
  const cycleId = `new-${iteration}`;
  const input = { dataDir, cycleId, now };
  call(metrics.loadWorkspaceWatcherCycleMetrics, input);
  call(() => metrics.getWorkspaceWatcherCycleMetric('cycle-0', input), input);
  call(metrics.getWorkspaceWatcherCycleMetricsStatus, input);
  call(metrics.beginWorkspaceWatcherCycleMetric, input);
  call(metrics.beginWorkspaceWatcherCycleMetric, input);
  call(metrics.stampWorkspaceWatcherCycleMetricRequest, { ...input, requestedModel: 'example' });
  call(metrics.markWorkspaceWatcherCycleMetricRunning, { ...input, orchestratorRunId: 'run' });
  call(metrics.finalizeWorkspaceWatcherCycleMetric, input);
  call(metrics.finalizeWorkspaceWatcherCycleMetric, input);
  call(metrics.persistWorkspaceWatcherCycleUsage, { ...input, usage: { cycleId }, finalized: true });
  call(metrics.persistWorkspaceWatcherCycleUsage, { ...input, usage: { cycleId }, finalized: true });
}

test('synthetic cycle history workload timings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cycle-perf-'));
  try {
    for (const count of [0, 20, 2000]) {
      const dataDir = path.join(root, String(count));
      fs.mkdirSync(dataDir);
      seed(dataDir, count);
      metrics.loadWorkspaceWatcherCycleMetrics({ dataDir });
      workload(dataDir, 'warmup');
      const samples = [];
      const durations = [];
      const cpu = process.cpuUsage();
      const heap = process.memoryUsage().heapUsed;
      for (let i = 0; i < 9; i++) {
        const start = performance.now();
        workload(dataDir, i, durations);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      t.diagnostic(JSON.stringify({ node: process.version, count, medianMs: samples[4], maxMs: samples.at(-1), maxCallMs: Math.max(...durations), cpu: process.cpuUsage(cpu), heapDelta: process.memoryUsage().heapUsed - heap }));
    }
  } finally {
    metrics.resetWorkspaceWatcherCycleMetricsPersistence();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('warm reads and one-record mutations do not normalize retained history', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cycle-scaling-'));
  const session = new Session();
  session.connect();
  try {
    for (const count of [20, 2000]) {
      metrics.resetWorkspaceWatcherCycleMetricsPersistence();
      seed(dataDir, count);
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      metrics.loadWorkspaceWatcherCycleMetrics({ dataDir });
      const cold = await session.post('Profiler.takePreciseCoverage');
      metrics.loadWorkspaceWatcherCycleMetrics({ dataDir });
      metrics.getWorkspaceWatcherCycleMetric('cycle-0', { dataDir });
      metrics.getWorkspaceWatcherCycleMetricsStatus({ dataDir });
      const reads = await session.post('Profiler.takePreciseCoverage');
      metrics.beginWorkspaceWatcherCycleMetric({ dataDir, cycleId: 'one', now });
      metrics.markWorkspaceWatcherCycleMetricRunning({ dataDir, cycleId: 'one', now });
      const writes = await session.post('Profiler.takePreciseCoverage');
      const calls = (result) => result.result
        .filter((script) => script.url.endsWith('/lib/persist/workspace-watcher-cycle-metrics-persist.js'))
        .flatMap((script) => script.functions)
        .filter((fn) => fn.functionName === 'normalizeWorkspaceWatcherCycleMetric')
        .reduce((sum, fn) => sum + fn.ranges[0].count, 0);
      assert.equal(calls(cold), count, `one normalization per disk record at ${count} records`);
      assert.equal(calls(reads), 0, `warm reads at ${count} records`);
      assert.equal(calls(writes), 2, `one normalization per changed record at ${count} records`);
      await session.post('Profiler.stopPreciseCoverage');
    }
  } finally {
    session.disconnect();
    metrics.resetWorkspaceWatcherCycleMetricsPersistence();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
