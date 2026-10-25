import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { createServerDiagnostics } from '../lib/server-diagnostics.js';
import { timeScoutPhase } from '../lib/workspace-watcher-scout-phases.js';
import {
  getScoutPassPhaseStats,
  resetScoutPassPhaseStats,
  runWorkspaceWatcherScoutPass,
} from '../lib/workspace-watcher-scout.js';

function fixture(rowCount = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-phases-'));
  for (let i = 0; i < rowCount; i += 1) {
    const cwd = path.join(root, `ws-${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    upsertWorkspaceWatcher(cwd, { mode: 'off', policy: { scoutEnabled: false } }, { dataDir: root });
  }
  return root;
}

const run = (dataDir) => runWorkspaceWatcherScoutPass({ dataDir, deps: { listDelegationsForController: () => [] } });

test('phase stats count every pass and reset clears them', async () => {
  const dataDir = fixture(3);
  resetScoutPassPhaseStats();
  for (let i = 0; i < 4; i += 1) await run(dataDir);
  const stats = getScoutPassPhaseStats();
  assert.equal(stats.passes, 4);
  const byPhase = (phase) => stats.rows.filter((row) => row.phase === phase).reduce((n, row) => n + row.count, 0);
  assert.equal(byPhase('loadWorkspaceWatchers'), 4);
  assert.equal(byPhase('reconcileScoutScans'), 12);
  assert.equal(byPhase('expireStaleActiveScoutScan'), 12);
  assert.equal(byPhase('sweepClosedWorkspaceWatcherCycles'), 4);
  resetScoutPassPhaseStats();
  assert.deepEqual(getScoutPassPhaseStats(), { passes: 0, rows: [] });
});

test('diagnostics flush records a bounded, path-free scout-pass-phases event', async (context) => {
  const dataDir = fixture(3);
  const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-phases-diag-'));
  const recorder = createServerDiagnostics({ dataDir: diagDir, serverInstanceToken: 't', serverStartedAt: Date.now() });
  context.after(() => fs.rmSync(diagDir, { recursive: true, force: true }));
  resetScoutPassPhaseStats();
  assert.equal(recorder.flushScoutPassPhases(), null, 'nothing to record when no pass ran');
  await run(dataDir);
  const entry = recorder.flushScoutPassPhases();
  assert.equal(entry.event, 'scout-pass-phases');
  const payload = entry.details.scoutPassPhases;
  assert.equal(payload.passes, 1);
  assert.ok(payload.rows.length > 0 && payload.rows.length <= 30);
  const text = JSON.stringify(payload);
  assert.equal(text.includes(dataDir), false, 'no filesystem path in the event');
  for (const row of payload.rows) assert.match(row.workspace, /^[0-9a-f]{0,8}$/);
  assert.equal(getScoutPassPhaseStats().passes, 0, 'flush resets the aggregates');
});

test('instrumentation overhead stays small (median of 20 passes)', async () => {
  const dataDir = fixture(8);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timePass = async () => {
    const t0 = process.hrtime.bigint();
    await run(dataDir);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  await timePass();
  const samples = [];
  for (let i = 0; i < 20; i += 1) samples.push(await timePass());
  // A pass makes ~4 timed calls per row plus 2; measure the wrapper itself.
  const calls = 4 * 8 + 2;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) for (let j = 0; j < calls; j += 1) timeScoutPhase('noop', '/x', () => 0);
  const readMs = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  resetScoutPassPhaseStats();
  assert.ok(readMs < median(samples) * 0.05, `instrumentation ${readMs}ms vs pass ${median(samples)}ms`);
});
