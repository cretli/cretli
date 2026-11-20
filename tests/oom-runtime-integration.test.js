/**
 * Runtime integration for OOM diagnostics:
 * - server boot writes the durable identity the external monitor reads;
 * - the monitor turns a dead boot identity plus journal evidence into a marker;
 * - `GET /api/diagnostics/server` exposes the markers without failing when the
 *   marker file (or its reader) is unavailable.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { registerHealthRoutes } from '../lib/routes/health-routes.js';
import { parseMeminfo, runMemoryMonitorOnce } from '../lib/memory-monitor.js';
import {
  bootOomDiagnostics,
  parseTerminationEvidence,
  readMemoryLedger,
  readOomMarkers,
  readServerRuntimeMarker,
  writeOomMarker,
} from '../lib/oom-diagnostics.js';

function createTempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-oom-runtime-'));
}

function meminfo() {
  return parseMeminfo([
    'MemTotal:       24576000 kB',
    'MemAvailable:   15000000 kB',
    'SwapTotal:       8388608 kB',
    'SwapFree:        8388608 kB',
  ].join('\n') + '\n');
}

test('the marker written at boot is read by the monitor and turned into a durable OOM marker', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const startedAt = String(1_800_000_000_000 - 3_600_000);
  const boot = bootOomDiagnostics({
    dataDir,
    serverPid: 4321,
    startedAt,
    instanceToken: 'instance-token',
  });
  assert.equal(boot.markerCount, 0);
  assert.equal(readServerRuntimeMarker(dataDir).pid, 4321);

  // The server was SIGKILLed: the runtime marker stays, no clean shutdown
  // marker exists, and the journal names the pid.
  const result = runMemoryMonitorOnce({
    dataDir,
    host: meminfo(),
    processes: [],
    registry: {},
    probes: {
      isProcessAlive: () => false,
      getProcessStartTime: () => '',
    },
    earlyoom: { available: true, cursor: 'c1', entries: [], warning: '' },
    terminationJournal: {
      available: true,
      cursor: 'c2',
      warning: '',
      entries: parseTerminationEvidence(`${new Date(1_800_000_000_000).toISOString()} kernel: Out of memory: Killed process 4321 (node)`),
    },
    now: 1_800_000_000_000,
  });
  assert.equal(result.terminationMarkers.length, 1);
  assert.deepEqual(
    [result.terminationMarkers[0].target, result.terminationMarkers[0].pid, result.terminationMarkers[0].confidence],
    ['server', 4321, 'confirmed'],
  );

  const [marker] = readOomMarkers(dataDir);
  assert.deepEqual([marker.writer, marker.observer, marker.target, marker.source], ['external-observer', 'memory-monitor', 'server', 'kernel']);
  assert.ok(readMemoryLedger(dataDir).length >= 1, 'the same run appends a ledger sample');
});

test('a fast restart keeps the superseded server identity for the monitor', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const oldStart = String(1_800_000_000_000 - 3_600_000);
  const newStart = String(1_800_000_000_000 - 1_800_000);
  bootOomDiagnostics({ dataDir, serverPid: 5001, startedAt: oldStart, instanceToken: 'old' });
  // The new process starts before any monitor run: it must not erase the
  // evidence that the previous server identity is gone.
  bootOomDiagnostics({ dataDir, serverPid: 5002, startedAt: newStart, instanceToken: 'new' });
  const runtime = readServerRuntimeMarker(dataDir);
  assert.deepEqual([runtime.pid, runtime.previous.pid, runtime.previous.startedAt], [5002, 5001, oldStart]);

  const result = runMemoryMonitorOnce({
    dataDir,
    host: meminfo(),
    processes: [],
    registry: {},
    probes: {
      isProcessAlive: (pid) => pid === 5002,
      getProcessStartTime: (pid) => (pid === 5002 ? newStart : ''),
    },
    earlyoom: { available: true, cursor: 'c1', entries: [], warning: '' },
    terminationJournal: {
      available: true,
      cursor: 'c2',
      warning: '',
      entries: parseTerminationEvidence(`${new Date(1_800_000_000_000).toISOString()} kernel: Out of memory: Killed process 5001 (node)`),
    },
    now: 1_800_000_000_000,
  });
  assert.equal(result.termination.serverAlive, true);
  assert.equal(result.terminationMarkers.length, 1);
  assert.deepEqual(
    [result.terminationMarkers[0].pid, result.terminationMarkers[0].confidence, result.terminationMarkers[0].serverPid],
    [5001, 'confirmed', 5002],
  );
  assert.equal(readOomMarkers(dataDir)[0].target, 'server');
});

test('diagnostics endpoint exposes OOM markers and degrades to an empty list', () => {
  const routes = new Map();
  const app = { get: (route, handler) => routes.set(route, handler) };
  const res = () => ({
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  });
  const baseCtx = {
    serverInstanceToken: 'test',
    serverStartedAt: 1,
    serverDiagnostics: { snapshot: () => ({ event: 'current' }), readRecent: () => [] },
    readMonitorAlerts: () => [],
  };

  registerHealthRoutes(app, {
    ...baseCtx,
    readOomMarkers: (limit) => [{ target: 'server', pid: 1, confidence: 'confirmed', limit }],
  });
  const withMarkers = res();
  routes.get('/api/diagnostics/server')({ query: {} }, withMarkers);
  assert.equal(withMarkers.statusCode, 200);
  assert.deepEqual(withMarkers.body.oomMarkers, [{ target: 'server', pid: 1, confidence: 'confirmed', limit: 100 }]);
  assert.deepEqual(withMarkers.body.monitorAlerts, []);

  const throwing = new Map();
  const app2 = { get: (route, handler) => throwing.set(route, handler) };
  registerHealthRoutes(app2, {
    ...baseCtx,
    readOomMarkers: () => {
      throw new Error('marker file unavailable');
    },
  });
  const degraded = res();
  throwing.get('/api/diagnostics/server')({ query: {} }, degraded);
  assert.equal(degraded.statusCode, 200);
  assert.deepEqual(degraded.body.oomMarkers, []);
});

test('the diagnostics route reads markers from the data directory when wired through ctx', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeOomMarker(dataDir, { target: 'executor', pid: 77, cause: 'oom-kill', source: 'cgroup', confidence: 'probable' });

  const routes = new Map();
  const app = { get: (route, handler) => routes.set(route, handler) };
  const ctx = {
    serverInstanceToken: 'test',
    serverStartedAt: 1,
    serverDiagnostics: { snapshot: () => ({}), readRecent: () => [] },
    readMonitorAlerts: () => [],
    readOomMarkers: (limit) => readOomMarkers(dataDir, limit),
  };
  registerHealthRoutes(app, ctx);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  routes.get('/api/diagnostics/server')({ query: { limit: '25' } }, res);
  assert.equal(res.body.oomMarkers.length, 1);
  assert.equal(res.body.oomMarkers[0].confidence, 'probable');
  assert.equal(res.body.oomMarkers[0].pid, 77);
});

test('the monitor never requires a runtime marker file to exist', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  // A machine where only the monitor runs (no server yet): no files, no crash.
  writeFileSync(path.join(dataDir, 'placeholder'), '');
  const result = runMemoryMonitorOnce({
    dataDir,
    host: meminfo(),
    processes: [],
    registry: {},
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '' },
    earlyoom: { available: true, cursor: '', entries: [], warning: '' },
    write: false,
  });
  assert.equal(result.terminationMarkers.length, 0);
  assert.equal(result.termination.serverAlive, false);
  assert.ok(Number.isFinite(result.memory.executorCount));
  assert.equal(result.memory.executorCount, 0);
});
