/**
 * Regressions for the R17 review findings (OOM evidence, executor accounting,
 * launch gate). Each test names the finding it pins down.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { __resetChildProcessRegistryForTest, installChildProcessSpawnTracking, killChildProcessTree, trackChildProcess } from '../lib/child-process-registry.js';
import { resetExecutorLaunchGateForTest } from '../lib/executor-launch-gate.js';
import { loadOptionalProcessLifecycles } from '../lib/agent-harness/optional-process-lifecycles.ts';
import { newestJournalCursor, parseMeminfo, readEarlyoomJournal, readTerminationJournal, runMemoryMonitorOnce } from '../lib/memory-monitor.js';
import { makeTempDir } from './helpers/temp-dir.js';
import {
  appendChildExitEvent, appendMemoryLedger, bootOomDiagnostics, classifyExit, detectUnexpectedTerminations, evidenceMatchesTarget,
  isCoveredByCleanShutdown,
  parseTerminationEvidence, readChildExitEvents, readCleanShutdownMarker, readMemoryLedger, readOomMarkers, writeOomMarker,
  recordCleanShutdown, shouldRecordCleanShutdown, terminationTargetKey,
} from '../lib/oom-diagnostics.js';

// The OpenCode process monitor is a plugin hook; register it the way the monitor CLI does.
await loadOptionalProcessLifecycles();

const tmp = () => makeTempDir('cretli-r17-');
const NOW = 1_800_000_000_000;
// R17-F3: a pid match is only `confirmed` when the journal line timestamp falls
// inside the recorded process lifetime, so fixtures record an explicit epoch-ms
// start and prefix evidence lines with `short-iso` times.
const START = String(NOW - 3_600_000);
const startOf = (offsetMs = 0) => String(NOW - 3_600_000 + offsetMs);
const at = (ms = NOW) => new Date(ms).toISOString();
const host = () => parseMeminfo('MemTotal: 24576000 kB\nMemAvailable: 15000000 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n');
const OPENCODE = { 'port-1': { instanceKey: 'chat-1', opencodePid: 555, opencodeStartedAt: START, serverPid: 1, updatedAt: '' } };
const quietEarlyoom = { available: true, cursor: 'c', entries: [], warning: '' };

function run(dir, extra = {}) {
  return runMemoryMonitorOnce({
    dataDir: dir, host: host(), processes: [], registry: {}, earlyoom: quietEarlyoom, now: NOW,
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '', readProcessRss: () => 1024 * 1024 },
    ...extra,
  });
}

test('R1A1-F1: managed OpenCode is measured once and its death is detected', () => {
  const dir = tmp();
  const alive = { isProcessAlive: (pid) => pid === 555, getProcessStartTime: () => START, readProcessRss: () => 2 * 1024 * 1024 };
  const first = run(dir, {
    registry: OPENCODE, probes: alive,
    // The same pid also in child-processes.json must not be counted twice.
    executorRegistry: { 555: { pid: 555, type: 'child', label: 'dup', startedAt: START } },
  });
  assert.equal(first.memory.executorCount, 1);
  assert.equal(first.memory.executorsRssBytes, 2 * 1024 * 1024);
  assert.equal(readMemoryLedger(dir).at(-1).executors[0].pid, 555);

  const second = run(dir, {
    registry: OPENCODE, previousState: first.state, now: NOW + 60_000,
    terminationJournal: { available: true, cursor: 'j', warning: '', entries: parseTerminationEvidence(`${at()} kernel: Out of memory: Killed process 555 (opencode)`) },
  });
  assert.deepEqual(second.terminationMarkers.map((m) => [m.target, m.pid, m.type, m.confidence]), [['executor', 555, 'opencode-serve', 'confirmed']]);
});

test('R1A1-F2: an executor SIGKILLed between samples leaves a durable exit event the monitor reports', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 777, startedAt: '42', type: 'claude', label: 'claude -p', signal: 'SIGKILL', code: null }, NOW - 1000);
  assert.equal(readChildExitEvents(dir).length, 1);
  const result = run(dir);
  assert.deepEqual(result.terminationMarkers.map((m) => [m.pid, m.cause, m.source, m.confidence]), [[777, 'sigkill', 'exit-status', 'probable']]);
  const again = run(dir, { previousState: result.state, now: NOW + 60_000 });
  assert.equal(again.terminationMarkers.length, 0, 'reported once');
  for (let i = 0; i < 130; i += 1) appendChildExitEvent(dir, { pid: 1000 + i, signal: 'SIGKILL' });
  assert.ok(readChildExitEvents(dir).length <= 100, 'event log is bounded');
});

test('R1A1-F2: the child registry writes the event on an unexpected SIGKILL exit but not on a deliberate kill', async () => {
  const dir = process.env.CRETLI_DATA_DIR;
  __resetChildProcessRegistryForTest();
  fs.rmSync(path.join(dir, 'child-exit-events.json'), { force: true });
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  trackChildProcess(child, { type: 'claude', label: 'fake' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // An external kill by PID (not `child.kill`, which marks the handle as
  // server-signalled) is what the exit-event log exists to observe.
  process.kill(child.pid, 'SIGKILL');
  await exited;
  const events = readChildExitEvents(dir);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].pid, events[0].signal, events[0].type], [child.pid, 'SIGKILL', 'claude']);
  const deliberate = childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  trackChildProcess(deliberate, { type: 'claude', label: 'fake' });
  const deliberateExit = new Promise((resolve) => deliberate.once('exit', resolve));
  killChildProcessTree(deliberate.pid, 'SIGKILL');
  await deliberateExit;
  assert.equal(readChildExitEvents(dir).length, 1, 'a kill issued by the server is not an unexpected death');
  __resetChildProcessRegistryForTest();
});

test('R17-AUD-F3: the self-signalled pid memory expires after the 60 s TTL', async (t) => {
  const dir = process.env.CRETLI_DATA_DIR;
  __resetChildProcessRegistryForTest();
  fs.rmSync(path.join(dir, 'child-exit-events.json'), { force: true });
  const spawnSleeper = () => childProcess.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  // Children are spawned before the clock is mocked so only Date is faked.
  const beforeTtl = spawnSleeper();
  const afterTtl = spawnSleeper();
  trackChildProcess(beforeTtl, { type: 'claude', label: 'before-ttl' });
  trackChildProcess(afterTtl, { type: 'claude', label: 'after-ttl' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const beforeExit = new Promise((resolve) => beforeTtl.once('exit', resolve));
    killChildProcessTree(beforeTtl.pid, 'SIGKILL');
    t.mock.timers.tick(59_999);
    await beforeExit;
    assert.equal(readChildExitEvents(dir).length, 0, 'just below the TTL the deliberate kill is still recognised');

    const afterExit = new Promise((resolve) => afterTtl.once('exit', resolve));
    killChildProcessTree(afterTtl.pid, 'SIGKILL');
    t.mock.timers.tick(60_001);
    await afterExit;
    const events = readChildExitEvents(dir);
    assert.equal(events.length, 1, 'after the TTL the stale self-signal no longer hides an unexpected SIGKILL');
    assert.equal(events[0].pid, afterTtl.pid);
  } finally {
    t.mock.timers.reset();
    try { beforeTtl.kill('SIGKILL'); } catch { /* already gone */ }
    try { afterTtl.kill('SIGKILL'); } catch { /* already gone */ }
    __resetChildProcessRegistryForTest();
    fs.rmSync(path.join(dir, 'child-exit-events.json'), { force: true });
  }
});

test('R1A1-F3: earlyoom kill lines feed the termination classifier', () => {
  const dir = tmp();
  const start = String(Date.parse('2026-10-01T00:00:00Z'));
  const alive = { isProcessAlive: (pid) => pid === 888, getProcessStartTime: () => start, readProcessRss: () => 1 };
  const first = run(dir, { probes: alive, executorRegistry: { 888: { pid: 888, type: 'codex', startedAt: start } } });
  const second = run(dir, {
    previousState: first.state, now: NOW + 60_000,
    earlyoom: { available: true, cursor: 'c2', warning: '', entries: [{ timestamp: '2026-10-09T14:00:00+0200', message: 'earlyoom[1]: sending SIGKILL to process 888 "node": badness 9' }] },
  });
  assert.deepEqual(second.terminationMarkers.map((m) => [m.pid, m.source, m.confidence]), [[888, 'earlyoom', 'confirmed']]);
});

test('R1A1-F4: a failed marker write is not acknowledged and is retried', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 901, startedAt: '1', type: 'claude', signal: 'SIGKILL' }, NOW - 1000);
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile); // appending to a directory fails
  const failed = run(dir);
  assert.ok(failed.warnings.some((w) => /Could not persist an OOM marker/.test(w)));
  assert.ok(!failed.state.termination.reported.includes(terminationTargetKey({ target: 'executor', pid: 901, startedAt: '1' })));
  assert.equal(failed.state.termination.pending.length, 1);
  fs.rmdirSync(markerFile);
  const retried = run(dir, { previousState: failed.state, now: NOW + 60_000 });
  assert.equal(readOomMarkers(dir).filter((m) => m.pid === 901).length, 1);
  assert.equal(retried.state.termination.pending.length, 0);
  assert.ok(retried.state.termination.reported.includes(terminationTargetKey({ target: 'executor', pid: 901, startedAt: '1' })));
});

test('R1A1-F5: systemd-oomd evidence for an unrelated cgroup does not match; the target cgroup does', () => {
  const foreign = parseTerminationEvidence('systemd-oomd[1]: Killed /user.slice/user-1000.slice/app.slice/firefox.scope due to memory pressure');
  const own = parseTerminationEvidence('systemd-oomd[1]: Killed /system.slice/cretli.service due to memory pressure');
  const scope = { targetUnits: ['cretli.service'], targetCgroups: ['/system.slice/cretli.service'] };
  assert.equal(classifyExit({ pid: 5, evidence: foreign, ...scope }).cause, 'unknown');
  assert.equal(classifyExit({ pid: 5, evidence: own, ...scope }).confidence, 'probable');
  const none = detectUnexpectedTerminations({ previousServers: [{ pid: 5, startedAt: '1' }], evidence: foreign, ...scope });
  assert.equal(none.targets[0].cause, 'unknown');
  assert.deepEqual(none.targets[0].evidence, []);
  const parentSlice = parseTerminationEvidence('systemd-oomd[1]: Killed /system.slice due to memory pressure');
  assert.equal(classifyExit({ pid: 5, evidence: parentSlice, ...scope }).cause, 'oom-kill');
  // Pidless evidence must not turn an ordinary vanished executor into a kill.
  const executor = detectUnexpectedTerminations({
    previousExecutors: [{ pid: 9, startedAt: '1' }], evidence: foreign, ...scope,
    cgroupBefore: { events: { oom_kill: 0 } }, cgroupAfter: { events: { oom_kill: 1 } },
  });
  assert.equal(executor.targets.length, 0);
});

test('R1A1-F6: fatal / server-error exits do not record a clean shutdown', () => {
  assert.equal(shouldRecordCleanShutdown({ signal: 'SIGTERM' }), true);
  assert.equal(shouldRecordCleanShutdown({ signal: 'SIGINT', exitCode: null }), true);
  assert.equal(shouldRecordCleanShutdown({ signal: 'server-error', exitCode: 1 }), false);
  assert.equal(shouldRecordCleanShutdown({ signal: 'uncaughtException', exitCode: 1 }), false);
  assert.equal(shouldRecordCleanShutdown({ signal: 'SIGTERM', exitCode: 1 }), false);
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /shouldRecordCleanShutdown\(\{ signal, exitCode: forcedExitCode \}\)/, 'server.js gates the marker on the exit reason');
});

test('R1A2-F1: an ESM named `spawn` import is gated by the pre-flight', async (context) => {
  const original = childProcess.spawn;
  context.after(() => { __resetChildProcessRegistryForTest(); childProcess.spawn = original; resetExecutorLaunchGateForTest(); });
  const dir = tmp();
  const file = path.join(dir, 'esm-importer.mjs');
  fs.writeFileSync(file, "import { spawn } from 'node:child_process';\nexport const start = () => spawn('claude', ['--version']);\n");
  const mod = await import(pathToFileURL(file).href); // imported BEFORE the hook is installed
  resetExecutorLaunchGateForTest({ enabled: true, readHostMemory: () => ({ totalBytes: 100, availableBytes: 1 }) });
  installChildProcessSpawnTracking();
  assert.throws(() => mod.start(), (error) => error.code === 'EXECUTOR_LAUNCH_DENIED');
});

test('R1A2-F3: journal cursor merge picks the newest cursor and truncation is reported', () => {
  assert.equal(newestJournalCursor(['s=a;i=1;t=5;x=1', 's=a;i=9;t=ff;x=1', 's=a;i=3;t=10;x=1']), 's=a;i=9;t=ff;x=1');
  const lines = Array.from({ length: 300 }, (_, i) => `2026-10-09T14:00:00+0200 host kernel: noise ${i}`).join('\n');
  const journal = readTerminationJournal({ execFile: () => `${lines}\n-- cursor: s=a;t=1` });
  assert.match(journal.warning, /tail limit/);
});

test('R1A2-F4: an unknown marker is enriched when evidence arrives in a later run', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 321, startedAt: '5', type: 'claude', signal: 'SIGKILL' }, NOW - 1000);
  // No SIGKILL-exit event class on the server path: use a stale registry entry (unknown cause).
  const stale = { 321: { pid: 321, type: 'claude', startedAt: '5' } };
  const first = run(dir, { exitEvents: [], executorRegistry: stale, terminationJournal: { available: true, cursor: '', warning: '', entries: [] } });
  assert.equal(first.terminationMarkers[0].cause, 'unknown');
  const second = run(dir, {
    exitEvents: [], executorRegistry: stale, previousState: first.state, now: NOW + 60_000,
    terminationJournal: { available: true, cursor: '', warning: '', entries: parseTerminationEvidence('kernel: Out of memory: Killed process 321 (node)') },
  });
  assert.equal(second.terminationMarkers.length, 1);
  assert.deepEqual([second.terminationMarkers[0].cause, second.terminationMarkers[0].enrichesEarlierUnknown], ['oom-kill', true]);
  const third = run(dir, { exitEvents: [], executorRegistry: stale, previousState: second.state, now: NOW + 120_000 });
  assert.equal(third.terminationMarkers.length, 0);
});

test('R5-F1: a SIGKILL-only marker is enriched when OOM evidence arrives in a later run', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 654, startedAt: '7', type: 'claude', signal: 'SIGKILL' }, NOW - 1000);
  const events = readChildExitEvents(dir);
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: '', warning: '', entries: [] } });
  assert.equal(first.terminationMarkers[0].cause, 'sigkill');
  const repeat = run(dir, { exitEvents: events, previousState: first.state, now: NOW + 30_000, terminationJournal: { available: true, cursor: '', warning: '', entries: [] } });
  assert.equal(repeat.terminationMarkers.length, 0, 'an unchanged weak classification is not re-emitted');
  const second = run(dir, {
    exitEvents: events, previousState: repeat.state, now: NOW + 60_000,
    terminationJournal: { available: true, cursor: '', warning: '', entries: parseTerminationEvidence('kernel: Out of memory: Killed process 654 (node)') },
  });
  assert.deepEqual([second.terminationMarkers.length, second.terminationMarkers[0]?.cause], [1, 'oom-kill']);
  const third = run(dir, { exitEvents: events, previousState: second.state, now: NOW + 120_000 });
  assert.equal(third.terminationMarkers.length, 0);
  assert.deepEqual(readOomMarkers(dir).filter((m) => m.pid === 654).map((m) => m.cause), ['sigkill', 'oom-kill'], 'promotion appends after the sigkill row');
});

test('R5-F2: a torn tail line does not swallow the next marker', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'oom-markers.jsonl'), '{"torn');
  writeOomMarker(dir, { target: 'executor', pid: 777, startedAt: '1', type: 'claude', cause: 'oom-kill', source: 'journal', confidence: 'confirmed', basis: 'x' }, NOW);
  assert.ok(readOomMarkers(dir).some((m) => m.pid === 777));
  fs.writeFileSync(path.join(dir, 'memory-ledger.jsonl'), '{"torn');
  appendMemoryLedger(dir, { hostTotalBytes: 1, hostAvailableBytes: 1, server: null, executors: [] }, NOW);
  assert.equal(readMemoryLedger(dir).length, 1, 'ledger sample survives a torn tail');
});

test('R1A2-F5: a fast restart chain keeps every superseded identity', () => {
  const dir = tmp();
  const A = startOf(0);
  const B = startOf(1000);
  const C = startOf(2000);
  bootOomDiagnostics({ dataDir: dir, serverPid: 11, startedAt: A });
  bootOomDiagnostics({ dataDir: dir, serverPid: 12, startedAt: B });
  bootOomDiagnostics({ dataDir: dir, serverPid: 13, startedAt: C });
  // A (11) crashed, B (12) shut down cleanly, C (13) booted before any monitor run.
  recordCleanShutdown({ dataDir: dir, serverPid: 12, startedAt: B, signal: 'SIGTERM' });
  const result = run(dir, {
    probes: { isProcessAlive: (pid) => pid === 13, getProcessStartTime: () => C, readProcessRss: () => 1 },
    terminationJournal: { available: true, cursor: '', warning: '', entries: parseTerminationEvidence(`${at()} kernel: Out of memory: Killed process 11 (node)`) },
  });
  assert.deepEqual(result.terminationMarkers.map((m) => [m.target, m.pid, m.confidence]), [['server', 11, 'confirmed']]);
  // Two clean exits in a row stay clean.
  recordCleanShutdown({ dataDir: dir, serverPid: 13, startedAt: C, signal: 'SIGTERM' });
  const marker = readCleanShutdownMarker(dir);
  assert.ok(isCoveredByCleanShutdown(marker, { pid: 12, startedAt: B }));
  assert.ok(isCoveredByCleanShutdown(marker, { pid: 13, startedAt: C }));
  assert.ok(!isCoveredByCleanShutdown(marker, { pid: 11, startedAt: A }));
});

test('R1A2-F6: user-scope units are queried with --user-unit and an unavailable user journal is not a warning', () => {
  const calls = [];
  const journal = readTerminationJournal({
    execFile: (_cmd, args) => {
      calls.push(args);
      if (args.includes('--user-unit')) throw new Error('No journal files were found.');
      return '-- cursor: s=a;t=1';
    },
  });
  assert.ok(calls.some((a) => a.includes('--user-unit') && a.includes('cretli.service')));
  assert.equal(journal.available, true);
  assert.equal(journal.warning, '');
});

test('R1A1-F2: 21+ SIGKILL exit events are all eventually marker\'d (no 20-cap starvation)', () => {
  const dir = tmp();
  for (let i = 0; i < 25; i += 1) {
    appendChildExitEvent(dir, { pid: 2000 + i, startedAt: `s${i}`, type: 'claude', label: 'claude', signal: 'SIGKILL', code: null }, NOW - 1000);
  }
  const events = readChildExitEvents(dir);
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: '', warning: '', entries: [] } });
  assert.equal(first.terminationMarkers.length, 25, 'durable SIGKILL exit classification is staged beyond the per-run evidence-free cap');
  const second = run(dir, {
    exitEvents: readChildExitEvents(dir), previousState: first.state, now: NOW + 60_000,
    terminationJournal: { available: true, cursor: '', warning: '', entries: [] },
  });
  assert.equal(second.terminationMarkers.length, 0, 'already acknowledged exit targets are not re-emitted');
  const all = readOomMarkers(dir);
  assert.equal(all.length, 25, 'every event eventually received a marker');
  assert.equal(new Set(all.map((m) => m.pid)).size, 25, 'no event was starved by the acknowledged backlog');
});

test('R17 F2: systemd SIGKILL exit evidence is durable classified work beyond the nominal batch', () => {
  const events = Array.from({ length: 25 }, (_, i) => ({ pid: 25000 + i, startedAt: `systemd-${i}`, signal: 'SIGKILL' }));
  const evidence = parseTerminationEvidence(Array(25).fill("systemd[1]: cretli.service: Main process exited, code=killed, status=9/KILL").join('\n'));
  const result = detectUnexpectedTerminations({ exitEvents: events, evidence, targetUnits: ['cretli.service'] });
  assert.equal(result.targets.length, 25);
  assert.ok(result.targets.every((target) => target.source === 'systemd' && target.confidence === 'probable'));
  assert.equal(result.overflowCount, 0);
});

test('R1A1-F2: unknown rechecks never consume new-work capacity in either mixed order', () => {
  const unknown = Array.from({ length: 20 }, (_, i) => ({
    pid: 8000 + i, startedAt: `u${i}`, signal: 'SIGKILL', type: 'node',
  }));
  const fresh = Array.from({ length: 5 }, (_, i) => ({
    pid: 9000 + i, startedAt: `n${i}`, signal: 'SIGKILL', type: 'node',
  }));
  const unknownKeys = unknown.map((target) => terminationTargetKey({ target: 'executor', ...target }));
  for (const exitEvents of [unknown.concat(fresh), fresh.concat(unknown)]) {
    const makeInput = { unknownKeys, exitEvents, evidence: [] };
    const result = detectUnexpectedTerminations(makeInput);
    assert.deepEqual(result.targets.map((target) => target.pid).sort((a, b) => a - b), [
      ...unknown.map((target) => target.pid), ...fresh.map((target) => target.pid),
    ].sort((a, b) => a - b));
  }
});

test('R1A1-F2: journal evidence survives a full deferred batch after the cursor advances', () => {
  const dir = tmp();
  const events = [];
  const lines = [];
  for (let i = 0; i < 25; i += 1) {
    const pid = 3000 + i;
    events.push({ pid, startedAt: startOf(-i * 1000), type: 'claude', signal: 'SIGKILL' });
    lines.push(`${at()} kernel: Out of memory: Killed process ${pid} (claude)`);
  }
  const first = run(dir, {
    exitEvents: events,
    terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: parseTerminationEvidence(lines.join('\n')) },
  });
  assert.equal(first.terminationMarkers.length, 25);
  assert.equal(new Set(first.terminationMarkers.map((marker) => marker.pid)).size, 25);
  assert.ok(first.terminationMarkers.every((marker) => marker.cause === 'oom-kill' && marker.confidence === 'confirmed'));
  const second = run(dir, {
    exitEvents: events,
    previousState: first.state,
    now: NOW + 60_000,
    terminationJournal: { available: true, cursor: 'j=2', warning: '', entries: [] },
  });
  assert.equal(second.terminationMarkers.length, 0);
  assert.equal(readOomMarkers(dir).length, 25);
  assert.ok(readOomMarkers(dir).every((marker) => marker.cause === 'oom-kill' && marker.confidence === 'confirmed'));
});

test('R1A1-F2: failed writes retain every proof-backed marker until retry acknowledgement', () => {
  const dir = tmp();
  const events = [];
  const lines = [];
  for (let i = 0; i < 25; i += 1) {
    const pid = 4000 + i;
    events.push({ pid, startedAt: startOf(-i * 1000), type: 'claude', signal: 'SIGKILL' });
    lines.push(`${at()} kernel: Out of memory: Killed process ${pid} (claude)`);
  }
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const failed = run(dir, {
    exitEvents: events,
    terminationJournal: { available: true, cursor: 'j=proof', warning: '', entries: parseTerminationEvidence(lines.join('\n')) },
  });
  assert.equal(failed.terminationMarkers.length, 25);
  assert.equal(failed.state.termination.pending.length, 25, 'all consumed proof must remain in the durable retry outbox');
  assert.equal(failed.state.termination.reported.length, 0, 'failed markers are never acknowledged');
  fs.rmdirSync(markerFile);
  const retried = run(dir, {
    exitEvents: events,
    previousState: failed.state,
    now: NOW + 60_000,
    terminationJournal: { available: true, cursor: 'j=empty', warning: '', entries: [] },
  });
  assert.equal(retried.state.termination.pending.length, 0);
  const markers = readOomMarkers(dir);
  assert.equal(markers.length, 25);
  assert.equal(new Set(markers.map((marker) => marker.pid)).size, 25, 'retry writes each event exactly once');
  assert.ok(markers.every((marker) => marker.cause === 'oom-kill' && marker.confidence === 'confirmed'));
});

test('R17-AUD-F2: OOM proof read during a weak-marker retry is classified before the cursor advances', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 901, startedAt: START, type: 'claude', label: 'retried', signal: 'SIGKILL' }, NOW - 1000);
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile); // appending to a directory fails
  const failed = run(dir, { terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] } });
  assert.equal(failed.state.termination.pending.length, 1);
  assert.deepEqual([failed.state.termination.pending[0].cause, failed.state.termination.pending[0].source], ['sigkill', 'exit-status']);
  assert.equal(failed.state.termination.pending[0].endMs, NOW - 1000, 'the marker carries the end of the instance lifetime');
  assert.equal(failed.state.termination.cursor, 'j=1');
  fs.rmdirSync(markerFile);
  // The retry run reads real kernel proof for the very target it retries. The
  // line falls INSIDE the recorded lifetime (`exitedAt`), so the delayed read
  // legitimately strengthens the weak marker.
  const retried = run(dir, {
    previousState: failed.state,
    now: NOW + 60_000,
    terminationJournal: {
      available: true,
      cursor: 'j=2',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW - 5000)} host kernel: Out of memory: Killed process 901 (node)`),
    },
  });
  assert.equal(retried.terminationMarkers.length, 1, 'the stronger re-read is classified in this run');
  assert.deepEqual([retried.terminationMarkers[0].cause, retried.terminationMarkers[0].source, retried.terminationMarkers[0].confidence], ['oom-kill', 'kernel', 'confirmed']);
  assert.equal(retried.state.termination.pending.length, 0);
  assert.equal(retried.state.termination.cursor, 'j=2');
  // The source no longer returns the line: without the fix the cursor advance
  // would leave only the weak sigkill marker behind.
  const later = run(dir, {
    previousState: retried.state,
    now: NOW + 120_000,
    terminationJournal: { available: true, cursor: 'j=3', warning: '', entries: [] },
  });
  assert.equal(later.state.termination.pending.length, 0);
  const forTarget = readOomMarkers(dir, 200).filter((marker) => marker.pid === 901);
  assert.deepEqual([forTarget.at(-1).cause, forTarget.at(-1).source, forTarget.at(-1).confidence], ['oom-kill', 'kernel', 'confirmed'], 'the OOM proof survives source loss');
});

test('R17-R2-REG1: OOM proof read after the instance ended is never attributed to it', () => {
  const dir = tmp();
  appendChildExitEvent(dir, { pid: 901, startedAt: START, type: 'claude', label: 'retried', signal: 'SIGKILL' }, NOW - 1000);
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const failed = run(dir, { terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] } });
  assert.equal(failed.state.termination.pending.length, 1);
  fs.rmdirSync(markerFile);
  // The retry sees a kernel OOM line for the same pid, but 31 s after the
  // instance had already exited: it belongs to a later pid owner.
  const retried = run(dir, {
    previousState: failed.state,
    now: NOW + 60_000,
    terminationJournal: {
      available: true,
      cursor: 'j=2',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW + 30_000)} host kernel: Out of memory: Killed process 901 (node)`),
    },
  });
  assert.equal(retried.terminationMarkers.length, 0, 'post-mortem evidence does not enrich the dead instance');
  const oldMarker = readOomMarkers(dir, 200).filter((marker) => marker.pid === 901 && marker.startedAt === START).at(-1);
  assert.deepEqual([oldMarker.cause, oldMarker.confidence], ['sigkill', 'probable'], 'the marker stays weak');
  // A later kill of ANOTHER instance that reused the same pid must not rewrite
  // the verdict of the first one.
  appendChildExitEvent(dir, { pid: 901, startedAt: '2', type: 'claude', label: 'reused', signal: 'SIGKILL' }, NOW + 60_000);
  const reused = run(dir, {
    previousState: retried.state,
    now: NOW + 120_000,
    terminationJournal: {
      available: true,
      cursor: 'j=3',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW + 45_000)} host kernel: Out of memory: Killed process 901 (node)`),
    },
  });
  assert.deepEqual(
    reused.terminationMarkers.map((marker) => [marker.pid, marker.startedAt]),
    [[901, '2']],
    'the reused pid is its own termination target',
  );
  const reusedMarker = readOomMarkers(dir, 200).filter((marker) => marker.pid === 901 && marker.startedAt === '2').at(-1);
  assert.deepEqual([reusedMarker.cause, reusedMarker.confidence], ['oom-kill', 'confirmed'], 'the new pid owner is classified on its own lifetime');
  const oldAfterReuse = readOomMarkers(dir, 200).filter((marker) => marker.pid === 901 && marker.startedAt === START).at(-1);
  assert.deepEqual([oldAfterReuse.cause, oldAfterReuse.confidence], ['sigkill', 'probable'], 'the old instance keeps its weak marker');
});

test('R17-R2-REG1: an exit event that closes the lifetime outranks a boundary-less retry candidate', () => {
  const evidence = parseTerminationEvidence(`${at(NOW + 30_000)} kernel: Out of memory: Killed process 901 (node)`);
  // The retried marker knows no end of life, the exit event does; the pid then
  // belongs to a later owner, so the kill line must not classify the retry.
  const result = detectUnexpectedTerminations({
    previousExecutors: [{ pid: 901, startedAt: START, type: 'claude' }],
    exitEvents: [{ pid: 901, startedAt: START, type: 'claude', signal: 'SIGKILL', exitedAt: new Date(NOW - 1000).toISOString() }],
    evidence,
    targetUnits: [],
    targetCgroups: [],
  });
  assert.equal(result.targets.length, 1);
  assert.deepEqual([result.targets[0].cause, result.targets[0].confidence, result.targets[0].endMs], ['sigkill', 'probable', NOW - 1000]);
  assert.deepEqual(result.targets[0].evidence, [], 'the post-mortem line is not cited for the dead instance');
});

test('R17-AUD-F2: OOM proof read while a staged weak marker waits replaces it before the cursor advances', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const events = Array.from({ length: 131 }, (_, i) => ({
    pid: 11000 + i, startedAt: `staged-${i}`, type: 'claude', signal: 'SIGKILL',
  }));
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] } });
  assert.equal(first.state.termination.pending.length, 130);
  assert.equal(first.state.termination.overflow.length, 1, 'the 131st classified record is staged');
  assert.equal(first.state.termination.overflow[0].cause, 'sigkill');
  assert.equal(first.state.termination.cursor, 'j=1', 'a staged weak marker does not pin the cursor');
  fs.rmdirSync(markerFile);
  const target = events[130];
  const retried = run(dir, {
    exitEvents: events,
    previousState: first.state,
    now: NOW + 60_000,
    terminationJournal: {
      available: true,
      cursor: 'j=2',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW + 30_000)} host kernel: Out of memory: Killed process ${target.pid} (node)`),
    },
  });
  // R8A1-R17AUDF2: the drained outbox frees write slots, so the enrichment is
  // persisted in this run instead of waiting in the deferred backlog.
  assert.equal(retried.state.termination.overflow.length, 0, 'the staged weak record is replaced by a durable proof');
  assert.deepEqual(
    retried.state.termination.overflow.filter((marker) => marker.pid === target.pid),
    [],
    'no weak staged copy of the enriched target survives',
  );
  const proof = readOomMarkers(dir, 200).filter((marker) => marker.pid === target.pid).at(-1);
  assert.deepEqual([proof.cause, proof.source, proof.confidence], ['oom-kill', 'kernel', 'confirmed'], 'the stronger re-read replaces the weak marker durably');
  assert.equal(retried.state.termination.cursor, 'j=2', 'a persisted enrichment lets the cursor advance');
  const later = run(dir, {
    exitEvents: events,
    previousState: retried.state,
    now: NOW + 120_000,
    terminationJournal: { available: true, cursor: 'j=3', warning: '', entries: [] },
  });
  assert.equal(later.state.termination.overflow.length, 0, 'the staged proof drains after the source is silent');
  const forTarget = readOomMarkers(dir, 200).filter((marker) => marker.pid === target.pid);
  assert.deepEqual([forTarget.at(-1).cause, forTarget.at(-1).source], ['oom-kill', 'kernel'], 'the OOM proof survives source loss');
});

test('R8A1-R17AUDF2: a stronger re-read survives a full retry outbox and a full staged backlog', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  // 390 SIGKILL exit events: the 130-slot retry outbox fills up and the rest is
  // staged as classified work.
  const events = Array.from({ length: 390 }, (_, i) => ({
    pid: 20000 + i, startedAt: startOf(i * 10), type: 'claude', signal: 'SIGKILL',
  }));
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] } });
  assert.equal(first.state.termination.pending.length, 130);
  assert.equal(first.state.termination.overflow.length, 130);
  // A second batch fills the staged backlog to its bound while the outbox stays full.
  const second = run(dir, {
    exitEvents: events,
    previousState: first.state,
    now: NOW + 30_000,
    terminationJournal: { available: true, cursor: 'j=2', warning: '', entries: [] },
  });
  assert.equal(second.state.termination.pending.length, 130);
  assert.equal(second.state.termination.overflow.length, 260);
  fs.rmdirSync(markerFile);
  // Real OOM proof for one target whose weak marker is still pending. The
  // drained outbox frees 130 write slots, so the enrichment and part of the
  // staged backlog are persisted in this run instead of evicting an earlier
  // staged record to make room for the stronger proof (R8A1-R17AUDF2).
  const target = events[0];
  const enriched = run(dir, {
    exitEvents: events,
    previousState: second.state,
    now: NOW + 60_000,
    terminationJournal: {
      available: true,
      cursor: 'j=3',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW + 30_000)} host kernel: Out of memory: Killed process ${target.pid} (node)`),
    },
  });
  assert.ok(enriched.terminationMarkers.some((marker) => marker.pid === target.pid && marker.cause === 'oom-kill'), 'the stronger proof is classified');
  const durableTarget = readOomMarkers(dir, 500).filter((marker) => marker.pid === target.pid && marker.startedAt === target.startedAt).at(-1);
  assert.deepEqual(
    [durableTarget.cause, durableTarget.source, durableTarget.confidence],
    ['oom-kill', 'kernel', 'confirmed'],
    'the freed slots persist the stronger proof immediately',
  );
  assert.equal(enriched.state.termination.overflow.length, 131, 'only the undrained staged records stay deferred');
  assert.equal(enriched.state.termination.cursor, 'j=3', 'a persisted enrichment lets the cursor advance');
  // Every one of the 390 classified identities is durable or still staged: no
  // earlier staged record may be evicted to make room for the enrichment.
  const identity = (marker) => `${marker.pid}:${marker.startedAt}`;
  const retained = new Set([
    ...readOomMarkers(dir, 500).map(identity),
    ...enriched.state.termination.overflow.map(identity),
    ...enriched.state.termination.pending.map(identity),
  ]);
  assert.equal(retained.size, 390, 'no staged identity is evicted for the enrichment');
  // The source goes silent: the durable marker must not stay weak.
  const drained = run(dir, {
    exitEvents: events,
    previousState: enriched.state,
    now: NOW + 120_000,
    terminationJournal: { available: true, cursor: 'j=4', warning: '', entries: [] },
  });
  // The remaining unclassified targets drain in bounded batches.
  let drainedAgain = drained;
  for (let i = 0; i < 4 && drainedAgain.state.termination.overflow.length > 0; i += 1) {
    drainedAgain = run(dir, {
      exitEvents: events,
      previousState: drainedAgain.state,
      now: NOW + 180_000 + i * 60_000,
      terminationJournal: { available: true, cursor: `j=5-${i}`, warning: '', entries: [] },
    });
  }
  const forTarget = readOomMarkers(dir, 500).filter((marker) => marker.pid === target.pid && marker.startedAt === target.startedAt).at(-1);
  assert.deepEqual(
    [forTarget.cause, forTarget.source, forTarget.confidence],
    ['oom-kill', 'kernel', 'confirmed'],
    'the stronger marker is durable after the evidence source is silent',
  );
  assert.equal(drainedAgain.state.termination.overflow.length, 0, 'the backlog drains after the proof is written');
  assert.equal(readOomMarkers(dir, 500).length >= 390, true, 'every classified identity is durable after the drain');
});

test('R3A1-R1A1F2: empty cursor overflow retains the real kernel since window across restart', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const stale = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [5000 + i, { pid: 5000 + i, startedAt: startOf(-i * 1000) }]));
  const pending = run(dir, { executorRegistry: stale, terminationJournal: { available: true, cursor: '', entries: [] } });
  const events = Array.from({ length: 100 }, (_, i) => ({ pid: 6000 + i, startedAt: startOf(-i * 1000), signal: 'SIGKILL' }));
  const more = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [7000 + i, { pid: 7000 + i, startedAt: startOf(-i * 1000) }]));
  const proofAt = NOW + 30_000;
  const lines = [...events.map((e) => e.pid), ...Object.values(more).map((e) => e.pid)]
    .map((pid) => `${new Date(proofAt).toISOString()} kernel: Out of memory: Killed process ${pid} (node)`);
  const calls = [];
  const execFile = (_command, args) => {
    calls.push(args);
    const since = args[args.indexOf('--since') + 1];
    const visible = args.includes('-k') && (!args.includes('--since') || Date.parse(since) <= proofAt) ? lines : [];
    return `${visible.join('\n')}\n-- cursor: j=proof`;
  };
  const monitor = (now) => run(dir, {
    now, executorRegistry: { ...stale, ...more }, exitEvents: events,
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '', readProcessRss: () => 1,
      readTerminationJournal: (args) => readTerminationJournal({ ...args, execFile }) },
  });
  const overflow = monitor(NOW + 60_000);
  assert.equal(overflow.termination.overflowCount, 10);
  assert.equal(overflow.state.lastRunAt, new Date(NOW + 60_000).toISOString(), 'classified proof is durably staged before advancing the since window');
  fs.rmdirSync(markerFile);
  monitor(NOW + 120_000);
  const drained = monitor(NOW + 180_000);
  assert.equal(drained.termination.overflowCount, 0);
  assert.equal(readOomMarkers(dir, 200).length, 140);
  assert.ok(readOomMarkers(dir, 200).filter((m) => m.pid >= 6000).every((m) => m.confidence === 'confirmed'));
  assert.ok(calls.some((args) => args.includes('--since') && args.includes(pending.state.lastRunAt)));
});

test('R3A1-R1A1F2: earlyoom cursor remains at the source checkpoint on overflow', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const stale = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [8000 + i, { pid: 8000 + i, startedAt: startOf(-i * 1000) }]));
  run(dir, { executorRegistry: stale });
  const events = Array.from({ length: 100 }, (_, i) => ({ pid: 9000 + i, startedAt: startOf(-i * 1000), signal: 'SIGKILL' }));
  const more = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [10000 + i, { pid: 10000 + i, startedAt: startOf(-i * 1000) }]));
  const lines = [...events.map((e) => e.pid), ...Object.values(more).map((e) => e.pid)]
    .map((pid) => `${new Date(NOW + 30_000).toISOString()} host earlyoom[1]: sending SIGKILL to process ${pid} "node": badness 9`);
  const calls = [];
  const execFile = (_command, args) => {
    calls.push(args);
    return `${args.includes('--after-cursor=c') ? lines.join('\n') : ''}\n-- cursor: proof`;
  };
  const monitor = (now) => run(dir, { now, earlyoom: undefined, executorRegistry: { ...stale, ...more }, exitEvents: events,
    terminationJournal: { available: true, cursor: '', entries: [] },
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '', readProcessRss: () => 1,
      readEarlyoomJournal: (args) => readEarlyoomJournal({ ...args, execFile }) } });
  const overflow = monitor(NOW + 60_000);
  assert.equal(overflow.termination.overflowCount, 10);
  assert.equal(overflow.state.earlyoom.cursor, 'proof', 'classified earlyoom proof is staged before advancing its cursor');
  fs.rmdirSync(markerFile);
  monitor(NOW + 120_000);
  monitor(NOW + 180_000);
  assert.equal(readOomMarkers(dir, 200).length, 140);
  assert.ok(readOomMarkers(dir, 200).filter((m) => m.pid >= 9000).every((m) => m.source === 'earlyoom' && m.confidence === 'confirmed'));
  assert.ok(calls.some((args) => args.includes('--after-cursor=c')));
});

test('R3A1-R1A1F2: one cgroup oom_kill delta classifies all 25 stale targets', () => {
  const dir = tmp();
  const stale = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [11000 + i, { pid: 11000 + i, startedAt: `s${i}` }]));
  let oomKill = 0;
  const options = { serverRuntime: { pid: 42, startedAt: 'server' },
    probes: { isProcessAlive: (pid) => pid === 42, getProcessStartTime: () => 'server', readProcessRss: () => 1,
      readProcessCgroup: () => ({ memoryDir: '/sys/fs/cgroup/system.slice/cretli.service' }),
      readCgroupMemory: () => ({ available: true, events: { oom_kill: oomKill } }) },
    terminationJournal: { available: true, cursor: '', entries: [] } };
  run(dir, { ...options, executorRegistry: {} });
  oomKill = 1;
  const first = run(dir, { ...options, executorRegistry: stale, now: NOW + 60_000 });
  assert.equal(first.terminationMarkers.length, 25);
  assert.ok(first.terminationMarkers.every((m) => m.source === 'cgroup' && m.confidence === 'probable'));
  assert.equal(first.state.cgroup.events.oom_kill, 1);
  const next = run(dir, { ...options, executorRegistry: stale, now: NOW + 120_000 });
  assert.equal(next.terminationMarkers.length, 0);
  assert.equal(readOomMarkers(dir).length, 25);
});

test('R17 F2: classified kernel proofs survive write failure, restart, source loss, and bounded drain', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const events = Array.from({ length: 150 }, (_, i) => ({ pid: 15000 + i, startedAt: startOf(-i * 1000), type: 'claude', signal: 'SIGKILL' }));
  const proofTime = NOW + 30_000;
  const lines = events.map((event) => `${new Date(proofTime).toISOString()} host kernel: Out of memory: Killed process ${event.pid} (claude)`);
  const calls = [];
  let sourceAvailable = true;
  const execFile = (_command, args) => {
    calls.push(args);
    if (!sourceAvailable) throw Object.assign(new Error('journal unavailable'), { code: 'ENOENT' });
    const cursor = args.find((arg) => arg.startsWith('--after-cursor='));
    const since = args.indexOf('--since') >= 0 ? Date.parse(args[args.indexOf('--since') + 1]) : 0;
    return `${args.includes('-k') && (!since || since <= proofTime) && (!cursor || cursor === '--after-cursor=') ? lines.join('\n') : ''}\n-- cursor: j=kernel-proof`;
  };
  const runMonitor = (now) => run(dir, { now, exitEvents: events,
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '', readProcessRss: () => 1,
      readTerminationJournal: (args) => readTerminationJournal({ ...args, execFile }) } });
  const failed = runMonitor(NOW + 60_000);
  assert.equal(failed.state.termination.pending.length, 130);
  assert.equal(failed.state.termination.overflow.length, 20);
  assert.ok(failed.state.termination.overflow.every((marker) => marker.cause === 'oom-kill' && marker.source === 'kernel' && marker.confidence === 'confirmed'));
  assert.equal(failed.state.termination.cursor, 'j=kernel-proof');
  fs.rmdirSync(markerFile);
  sourceAvailable = false;
  const retry = runMonitor(NOW + 120_000);
  assert.equal(retry.state.termination.pending.length, 0);
  assert.equal(retry.state.termination.overflow.length, 0, 'the drained outbox frees slots so the classified records persist in the same run');
  runMonitor(NOW + 180_000);
  const drained = runMonitor(NOW + 240_000);
  const markers = readOomMarkers(dir, 200);
  assert.equal(drained.state.termination.overflow.length, 0);
  assert.equal(markers.length, 150);
  assert.equal(new Set(markers.map((marker) => marker.pid)).size, 150);
  assert.ok(markers.every((marker) => marker.cause === 'oom-kill' && marker.source === 'kernel' && marker.confidence === 'confirmed'));
  assert.ok(calls.some((args) => args.some((arg) => arg.startsWith('--after-cursor='))));
});

test('R17 F2: classified earlyoom proofs survive write failure, restart, source loss, and bounded drain', () => {
  const dir = tmp();
  run(dir, { now: NOW, earlyoom: { available: true, cursor: 'c', entries: [], warning: '' } });
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const events = Array.from({ length: 150 }, (_, i) => ({ pid: 16000 + i, startedAt: startOf(-i * 1000), type: 'claude', signal: 'SIGKILL' }));
  const lines = events.map((event) => `${new Date(NOW + 30_000).toISOString()} host earlyoom[1]: sending SIGKILL to process ${event.pid} "claude": badness 9`);
  let sourceAvailable = true;
  const execFile = (_command, args) => {
    if (!sourceAvailable) throw Object.assign(new Error('journal unavailable'), { code: 'ENOENT' });
    return `${args.includes('--after-cursor=c') ? lines.join('\n') : ''}\n-- cursor: c=earlyoom-proof`;
  };
  const runMonitor = (now) => run(dir, { now, earlyoom: undefined, exitEvents: events,
    terminationJournal: { available: true, cursor: '', entries: [] },
    probes: { isProcessAlive: () => false, getProcessStartTime: () => '', readProcessRss: () => 1,
      readEarlyoomJournal: (args) => readEarlyoomJournal({ ...args, execFile }) } });
  const failed = runMonitor(NOW + 60_000);
  assert.equal(failed.state.termination.pending.length, 130);
  assert.equal(failed.state.termination.overflow.length, 20);
  assert.ok(failed.state.termination.overflow.every((marker) => marker.cause === 'oom-kill' && marker.source === 'earlyoom' && marker.confidence === 'confirmed'));
  assert.equal(failed.state.earlyoom.cursor, 'c=earlyoom-proof');
  fs.rmdirSync(markerFile);
  sourceAvailable = false;
  runMonitor(NOW + 120_000);
  runMonitor(NOW + 180_000);
  const drained = runMonitor(NOW + 240_000);
  const markers = readOomMarkers(dir, 200);
  assert.equal(drained.state.termination.overflow.length, 0);
  assert.equal(markers.length, 150);
  assert.equal(new Set(markers.map((marker) => marker.pid)).size, 150);
  assert.ok(markers.every((marker) => marker.cause === 'oom-kill' && marker.source === 'earlyoom' && marker.confidence === 'confirmed'));
});

test('R17 F2: classified backlog saturation is bounded and pins unclassified source work', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const events = Array.from({ length: 400 }, (_, i) => ({ pid: 17000 + i, startedAt: `saturated-${i}`, signal: 'SIGKILL' }));
  const evidence = parseTerminationEvidence(events.map((event) => `kernel: Out of memory: Killed process ${event.pid} (node)`).join('\n'));
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: 'j=saturated', entries: evidence } });
  assert.equal(first.state.termination.pending.length, 130);
  assert.equal(first.state.termination.overflow.length, 130);
  assert.equal(first.termination.overflowCount, 270);
  assert.equal(first.state.termination.cursor, '', 'the cursor stays pinned while source work has not been classified');
  const repeated = run(dir, { now: NOW + 60_000, exitEvents: events, previousState: first.state,
    terminationJournal: { available: true, cursor: 'j=saturated-next', entries: evidence } });
  assert.equal(repeated.state.termination.overflow.length, 260, 'the classified backlog never exceeds its explicit bound');
  assert.equal(repeated.termination.overflowCount, 270);
  assert.equal(repeated.state.termination.cursor, '');
  assert.ok(repeated.warnings.some((warning) => /staging reached its 260-record bound/.test(warning)));
});

test('R1A1-F2: mixed pending unknown, new work, and overflow drain without evidence loss', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const stale = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [5000 + i, {
    pid: 5000 + i, startedAt: `unknown-${i}`, type: 'claude',
  }]));
  const pendingUnknown = run(dir, {
    executorRegistry: stale,
    terminationJournal: { available: true, cursor: 'j=before', warning: '', entries: [] },
  });
  assert.equal(pendingUnknown.state.termination.pending.length, 20);

  const proofEvents = [];
  const proofLines = [];
  for (let i = 0; i < 100; i += 1) {
    const pid = 6000 + i;
    proofEvents.push({ pid, startedAt: startOf(-i * 1000), type: 'codex', signal: 'SIGKILL' });
    proofLines.push(`${at(NOW + 60_000)} kernel: Out of memory: Killed process ${pid} (node)`);
  }
  const proofStale = Object.fromEntries(Array.from({ length: 20 }, (_, i) => {
    const pid = 7000 + i;
    proofLines.push(`${at(NOW + 60_000)} kernel: Out of memory: Killed process ${pid} (node)`);
    return [pid, { pid, startedAt: startOf(-i * 1000), type: 'codex' }];
  }));
  const mixedRegistry = { ...stale, ...proofStale };
  const overflowed = run(dir, {
    executorRegistry: mixedRegistry,
    exitEvents: proofEvents,
    previousState: pendingUnknown.state,
    now: NOW + 60_000,
    terminationJournal: {
      available: true,
      cursor: 'j=proof-consumed',
      warning: '',
      entries: parseTerminationEvidence(proofLines.join('\n')),
    },
  });
  assert.equal(overflowed.state.termination.pending.length, 130, 'the documented bounded outbox is filled, not truncated');
  assert.equal(overflowed.state.termination.cursor, 'j=proof-consumed', 'staged classifications durably accept the consumed cursor');
  assert.equal(overflowed.termination.overflowCount, 10);
  assert.ok(overflowed.warnings.some((warning) => /classified backlog contains 10\/260 durable record/.test(warning)));

  fs.rmdirSync(markerFile);
  const retried = run(dir, {
    executorRegistry: mixedRegistry,
    exitEvents: proofEvents,
    previousState: overflowed.state,
    now: NOW + 120_000,
    terminationJournal: { available: true, cursor: 'j=proof-retry', warning: '', entries: parseTerminationEvidence(proofLines.join('\n')) },
  });
  assert.equal(retried.state.termination.pending.length, 0, 'one bounded retry pass drains the complete outbox');
  assert.equal(retried.state.termination.cursor, 'j=proof-retry', 'staged proof remains durable while the source cursor advances');
  assert.equal(readOomMarkers(dir, 200).length, 140, 'freed outbox slots also persist the staged overflow');

  const drained = run(dir, {
    executorRegistry: mixedRegistry,
    exitEvents: proofEvents,
    previousState: retried.state,
    now: NOW + 180_000,
    terminationJournal: { available: true, cursor: 'j=final', warning: '', entries: parseTerminationEvidence(proofLines.join('\n')) },
  });
  assert.equal(drained.termination.overflowCount, 0);
  assert.equal(drained.state.termination.cursor, 'j=final');
  const markers = readOomMarkers(dir, 200);
  assert.equal(markers.length, 140);
  assert.equal(new Set(markers.map((marker) => `${marker.pid}:${marker.startedAt}`)).size, 140, 'all mixed targets are written once');
  const proofs = markers.filter((marker) => marker.pid >= 6000);
  assert.equal(proofs.length, 120);
  assert.ok(proofs.every((marker) => marker.cause === 'oom-kill' && marker.confidence === 'confirmed'));
});

test('R1A1-F5/R1A2-F2: a unit basename shared across cgroup scopes must not match the wrong scope', () => {
  const userScope = parseTerminationEvidence('systemd-oomd[1]: Killed /user.slice/user-1001.slice/user@1001.service/app.slice/cretli.service due to memory pressure');
  const ownScope = parseTerminationEvidence('systemd-oomd[1]: Killed /system.slice/cretli.service due to memory pressure');
  const scope = { targetUnits: ['cretli.service'], targetCgroups: ['/system.slice/cretli.service'] };
  // Same `cretli.service` basename, but the kill happened under /user.slice: the
  // basename coincidence must not attribute it to the system-scope target.
  assert.equal(evidenceMatchesTarget(userScope[0], scope), false, 'user-scope cretli.service must not match the system-scope target');
  assert.equal(classifyExit({ pid: 5, evidence: userScope, ...scope }).cause, 'unknown');
  // The genuine system-scope kill still matches (full cgroup path takes precedence).
  assert.equal(evidenceMatchesTarget(ownScope[0], scope), true);
  assert.equal(classifyExit({ pid: 5, evidence: ownScope, ...scope }).confidence, 'probable');
  // End-to-end: a vanished executor is not wrongly attributed to a foreign-scope kill.
  const result = detectUnexpectedTerminations({
    previousExecutors: [{ pid: 9, startedAt: '1' }],
    evidence: userScope,
    ...scope,
    cgroupBefore: { events: { oom_kill: 0 } },
    cgroupAfter: { events: { oom_kill: 1 } },
  });
  assert.equal(result.targets.length, 0);
});

test('R1A2-F4: a failed unknown marker retry is still re-enriched when evidence arrives later', () => {
  const dir = tmp();
  const stale = { 321: { pid: 321, type: 'claude', startedAt: '5' } };
  // Force the marker write to fail (a directory cannot be appended to).
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const failed = run(dir, {
    exitEvents: [], executorRegistry: stale,
    terminationJournal: { available: true, cursor: '', warning: '', entries: [] },
  });
  assert.ok(failed.warnings.some((w) => /Could not persist an OOM marker/.test(w)));
  assert.equal(failed.state.termination.pending.length, 1, 'the unknown marker is queued for retry');
  assert.equal(failed.state.termination.unknown.length, 0, 'a failed write never reached the unknown window');
  fs.rmdirSync(markerFile);
  // Retry run: the pending unknown marker now persists and must re-enter the
  // unknown window so later evidence can still upgrade it.
  const retried = run(dir, {
    exitEvents: [], executorRegistry: stale, previousState: failed.state, now: NOW + 60_000,
    terminationJournal: { available: true, cursor: '', warning: '', entries: [] },
  });
  assert.equal(readOomMarkers(dir).filter((m) => m.pid === 321).length, 1, 'the unknown marker was persisted on retry');
  assert.equal(retried.state.termination.pending.length, 0);
  assert.ok(retried.state.termination.unknown.some((row) => row.key === terminationTargetKey({ target: 'executor', pid: 321, startedAt: '5' })), 'the retried unknown stays re-examinable');
  // Later run with evidence upgrades the previously-unknown marker.
  const enriched = run(dir, {
    exitEvents: [], executorRegistry: stale, previousState: retried.state, now: NOW + 120_000,
    terminationJournal: { available: true, cursor: '', warning: '', entries: parseTerminationEvidence('kernel: Out of memory: Killed process 321 (node)') },
  });
  assert.equal(enriched.terminationMarkers.length, 1);
  assert.deepEqual([enriched.terminationMarkers[0].cause, enriched.terminationMarkers[0].enrichesEarlierUnknown], ['oom-kill', true]);
});

test('R6A1-F1: a child tracked by the spawn hook and explicitly records exactly one exit event', async () => {
  const dir = process.env.CRETLI_DATA_DIR;
  const eventsFile = path.join(dir, 'child-exit-events.json');
  fs.rmSync(eventsFile, { force: true });
  __resetChildProcessRegistryForTest();
  installChildProcessSpawnTracking();
  try {
    // `bash -lc` is classified as a tool-shell, so the patched spawn tracks it;
    // the two explicit calls are what used to attach a second `exit` listener.
    const deliberate = childProcess.spawn('bash', ['-lc', 'sleep 30'], { stdio: 'ignore' });
    trackChildProcess(deliberate, { type: 'tool-shell', label: 'sleep 30' });
    trackChildProcess(deliberate, { type: 'tool-shell', label: 'sleep 30' });
    const deliberateExit = new Promise((resolve) => deliberate.once('exit', resolve));
    killChildProcessTree(deliberate.pid, 'SIGKILL');
    await deliberateExit;
    assert.equal(readChildExitEvents(dir).length, 0, 'a server-ordered SIGKILL is never recorded as unexpected');

    const unexpected = childProcess.spawn('bash', ['-lc', 'sleep 30'], { stdio: 'ignore' });
    trackChildProcess(unexpected, { type: 'tool-shell', label: 'sleep 30' });
    trackChildProcess(unexpected, { type: 'tool-shell', label: 'sleep 30' });
    const unexpectedExit = new Promise((resolve) => unexpected.once('exit', resolve));
    // An external kill (not `killChildProcessTree`) is a genuine surprise.
    process.kill(unexpected.pid, 'SIGKILL');
    await unexpectedExit;
    const events = readChildExitEvents(dir);
    assert.equal(events.length, 1, 'one exit per handle, not one per track call');
    assert.deepEqual([events[0].pid, events[0].signal], [unexpected.pid, 'SIGKILL']);

    // A direct handle kill is also server-ordered (`handle.killed`), even though
    // it bypasses killChildProcessTree.
    const handledKill = childProcess.spawn('bash', ['-lc', 'sleep 30'], { stdio: 'ignore' });
    trackChildProcess(handledKill, { type: 'tool-shell', label: 'sleep 30' });
    trackChildProcess(handledKill, { type: 'tool-shell', label: 'sleep 30' });
    const handledKillExit = new Promise((resolve) => handledKill.once('exit', resolve));
    handledKill.kill('SIGKILL');
    await handledKillExit;
    assert.equal(readChildExitEvents(dir).length, 1, 'a handle-level SIGKILL is not an unexpected death');
  } finally {
    __resetChildProcessRegistryForTest();
    fs.rmSync(path.join(dir, 'child-exit-events.json'), { force: true });
  }
});

test('R5-F1 residual: a full 25-marker SIGKILL batch stays re-examinable for later OOM evidence', () => {
  const dir = tmp();
  const events = Array.from({ length: 25 }, (_, i) => ({
    pid: 2500 + i, startedAt: startOf(-i * 1000), type: 'claude', signal: 'SIGKILL',
  }));
  const first = run(dir, { exitEvents: events, terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] } });
  assert.equal(first.terminationMarkers.length, 25);
  assert.equal(first.state.termination.unknown.length, 25, 'every SIGKILL marker of the batch stays in the re-examination window');
  const proof = parseTerminationEvidence(Array.from({ length: 25 }, (_, i) => (
    `${at(NOW + 60_000)} kernel: Out of memory: Killed process ${2500 + i} (claude)`
  )).join('\n'));
  const second = run(dir, {
    exitEvents: events,
    previousState: first.state,
    now: NOW + 60_000,
    terminationJournal: { available: true, cursor: 'j=2', warning: '', entries: proof },
  });
  assert.equal(second.terminationMarkers.length, 25, 'no member of the batch is skipped by the old 20-entry window');
  assert.ok(second.terminationMarkers.every((marker) => marker.cause === 'oom-kill'
    && marker.confidence === 'confirmed' && marker.enrichesEarlierUnknown === true));
  const markers = readOomMarkers(dir, 200);
  assert.equal(markers.length, 50);
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(markers.filter((marker) => marker.pid === 2500 + i).map((marker) => marker.cause), ['sigkill', 'oom-kill']);
  }
});

test('R17-F3: a kill line older than the process start cannot mark a recycled pid', () => {
  const startedAt = String(Date.parse('2026-10-09T13:00:00Z'));
  const staleLine = '2026-10-09T12:00:00Z kernel: Out of memory: Killed process 4242 (node)';
  const freshLine = '2026-10-09T13:30:00Z kernel: Out of memory: Killed process 4242 (node)';
  const stale = parseTerminationEvidence(staleLine);
  const fresh = parseTerminationEvidence(freshLine);
  assert.deepEqual([stale[0].at, fresh[0].at], [Date.parse('2026-10-09T12:00:00Z'), Date.parse('2026-10-09T13:30:00Z')]);
  const staleResult = classifyExit({ pid: 4242, startedAt, evidence: stale });
  assert.deepEqual([staleResult.cause, staleResult.confidence], ['unknown', 'unknown'], 'a line from the previous pid owner is discarded');
  const freshResult = classifyExit({ pid: 4242, startedAt, evidence: fresh });
  assert.deepEqual([freshResult.cause, freshResult.confidence], ['oom-kill', 'confirmed'], 'a line inside the lifetime is confirmed');

  // A mixed stream keeps the usable line and never cites the stale one.
  const detection = detectUnexpectedTerminations({
    previousServer: { pid: 4242, startedAt },
    observedServer: { pid: 4242, alive: false },
    evidence: [...stale, ...fresh],
  });
  assert.deepEqual([detection.targets[0].cause, detection.targets[0].confidence], ['oom-kill', 'confirmed']);
  assert.deepEqual(detection.targets[0].evidence, [freshLine], 'basis cites only the line inside the process lifetime');
  const staleOnly = detectUnexpectedTerminations({
    previousServer: { pid: 4242, startedAt },
    observedServer: { pid: 4242, alive: false },
    evidence: stale,
  });
  assert.equal(staleOnly.targets[0].cause, 'unknown');
  assert.deepEqual(staleOnly.targets[0].evidence, []);

  // A pid match without a comparable time is never `confirmed`.
  const noTimestamp = parseTerminationEvidence('kernel: Out of memory: Killed process 4242 (node)');
  assert.equal(classifyExit({ pid: 4242, startedAt, evidence: noTimestamp }).confidence, 'probable');
  assert.equal(classifyExit({ pid: 4242, evidence: fresh }).confidence, 'probable');
});

test('R6A1-F6: application text quoting a kernel OOM is not kernel evidence', () => {
  const line = '2026-10-09T14:00:00Z host cretli[123]: kernel: Out of memory: Killed process 4242 (node)';
  assert.deepEqual(parseTerminationEvidence(line), []);
});

test('R6A3-N2: last observation is not process end, but exitedAt is', () => {
  const startedAt = String(Date.parse('2026-10-09T13:00:00Z'));
  const betweenObservations = parseTerminationEvidence('2026-10-09T13:00:30Z kernel: Out of memory: Killed process 4242 (node)');
  const result = classifyExit({
    pid: 4242,
    startedAt,
    lastSeenAt: '2026-10-09T13:00:00Z',
    evidence: betweenObservations,
  });
  assert.deepEqual([result.cause, result.confidence], ['oom-kill', 'confirmed']);
  const detection = detectUnexpectedTerminations({
    previousServer: { pid: 4242, startedAt, lastSeenAt: '2026-10-09T13:00:00Z' },
    observedServer: { pid: 4242, alive: false },
    evidence: betweenObservations,
  });
  assert.deepEqual([detection.targets[0].cause, detection.targets[0].confidence], ['oom-kill', 'confirmed']);

  const exitedAt = String(Date.parse('2026-10-09T13:00:20Z'));
  const afterExit = parseTerminationEvidence('2026-10-09T14:00:00Z kernel: Out of memory: Killed process 4242 (node)');
  const afterExitResult = classifyExit({ pid: 4242, startedAt, exitedAt, evidence: afterExit });
  assert.deepEqual([afterExitResult.cause, afterExitResult.confidence], ['unknown', 'unknown']);
  const afterExitDetection = detectUnexpectedTerminations({
    previousServer: { pid: 4242, startedAt, exitedAt },
    observedServer: { pid: 4242, alive: false },
    evidence: afterExit,
  });
  assert.deepEqual([afterExitDetection.targets[0].cause, afterExitDetection.targets[0].confidence], ['unknown', 'unknown']);
  assert.deepEqual(afterExitDetection.targets[0].evidence, []);
});

test('R7-F1: a whole-second journal line covers an OOM that fired in the same second as the start', () => {
  // journalctl -o short-iso prints whole seconds: the line names the interval
  // [13:00:00.000, 13:00:00.999], not the instant 13:00:00.000.
  const atSecond = Date.parse('2026-10-09T13:00:00Z');
  const line = '2026-10-09T13:00:00Z kernel: Out of memory: Killed process 4243 (node)';
  const evidence = parseTerminationEvidence(line);
  assert.deepEqual([evidence[0].at, evidence[0].atEnd], [atSecond, atSecond + 999], 'a whole-second stamp labels the whole second');
  assert.deepEqual(evidence[0].line, line);

  // The process started 500 ms into that second: the real OOM is inside its
  // lifetime, so the line must not be discarded as a previous pid owner.
  const lateStart = String(Date.parse('2026-10-09T13:00:00.500Z'));
  const accepted = classifyExit({ pid: 4243, startedAt: lateStart, evidence });
  assert.deepEqual([accepted.cause, accepted.source, accepted.confidence], ['oom-kill', 'kernel', 'confirmed']);
  const detection = detectUnexpectedTerminations({
    previousServer: { pid: 4243, startedAt: lateStart },
    observedServer: { pid: 4243, alive: false },
    evidence,
  });
  assert.deepEqual(detection.targets[0].evidence, [line], 'evidenceLinesFor applies the same interval rule');
  assert.equal(detection.targets[0].confidence, 'confirmed');

  // A line from 5 s before the start still belongs to a previous pid owner.
  const recycledStart = String(Date.parse('2026-10-09T13:00:05.500Z'));
  assert.deepEqual(
    [classifyExit({ pid: 4243, startedAt: recycledStart, evidence }).cause,
      detectUnexpectedTerminations({
        previousServer: { pid: 4243, startedAt: recycledStart },
        observedServer: { pid: 4243, alive: false },
        evidence,
      }).targets[0].evidence],
    ['unknown', []],
    'PID reuse is still rejected: only sub-precision skew is tolerated',
  );
  // A start that lands exactly on the printed second is covered as well.
  assert.equal(classifyExit({ pid: 4243, startedAt: String(atSecond), evidence }).confidence, 'confirmed');
  // A fractional timestamp keeps its real precision (1 ms for three digits),
  // so it cannot stretch a line forward over a later start.
  const fractional = parseTerminationEvidence('2026-10-09T13:00:00.500Z kernel: Out of memory: Killed process 4243 (node)');
  assert.equal(fractional[0].atEnd, Date.parse('2026-10-09T13:00:00.500Z'));
  assert.equal(classifyExit({ pid: 4243, startedAt: String(Date.parse('2026-10-09T13:00:00.501Z')), evidence: fractional }).cause, 'unknown');
});

test('R6A1-F4: the monitor --json output carries the same termination, memory and ledger fields as the text report', () => {
  const dir = tmp();
  const env = {
    ...process.env,
    // Keep the exit code 0 regardless of the host's real memory/process state.
    CRETLI_MEMORY_MONITOR_MEM_CRITICAL_MB: '0',
    CRETLI_MEMORY_MONITOR_MEM_WARN_MB: '0',
    CRETLI_MEMORY_MONITOR_MAX_OPENCODE: '1000',
    CRETLI_MEMORY_MONITOR_SWAP_USED_RATIO: '1',
    CRETLI_MEMORY_MONITOR_SWAP_GROWTH_MB: '999999',
  };
  const script = fileURLToPath(new URL('../scripts/memory-orphan-monitor.js', import.meta.url));
  let stdout;
  try {
    stdout = childProcess.execFileSync(process.execPath, [
      script, '--json', '--dry-run', '--data-dir', dir,
    ], { encoding: 'utf8', env, timeout: 60_000 });
  } catch (error) {
    // The monitor exits 1 while any threshold is exceeded on this host (for
    // example duplicate webpack watchers); its JSON payload is still complete.
    assert.equal(error.status, 1, `unexpected monitor failure: ${error.stderr || error.message}`);
    stdout = String(error.stdout || '');
  }
  const payload = JSON.parse(stdout);
  for (const key of ['termination', 'terminationMarkers', 'memory', 'ledgerPath']) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `--json output must include ${key}`);
  }
  assert.equal(payload.ledgerPath, path.join(dir, 'memory-ledger.jsonl'));
  assert.ok(Array.isArray(payload.terminationMarkers));
  assert.equal(typeof payload.termination.detected, 'number');
  assert.equal(typeof payload.memory.executorCount, 'number');
  // The pre-existing shape is unchanged.
  for (const key of ['at', 'exitCode', 'evaluation', 'alerts', 'statePath', 'warnings']) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `--json must keep ${key}`);
  }
});

test('R8C1-R17R2REG1: a boundary learned during retry is stored even without a stronger classification', () => {
  const dir = tmp();
  const markerFile = path.join(dir, 'oom-markers.jsonl');
  fs.mkdirSync(markerFile);
  const exitedAt = at(NOW - 5_000);
  const first = run(dir, {
    exitEvents: [{ pid: 31000, startedAt: startOf(), type: 'claude', signal: 'SIGKILL' }],
    terminationJournal: { available: true, cursor: 'j=1', warning: '', entries: [] },
  });
  assert.equal(first.state.termination.pending.length, 1);
  const pendingBefore = first.state.termination.pending[0];
  assert.ok(!pendingBefore.endMs && !pendingBefore.exitedAt, 'the first marker carries no lifetime boundary');
  // Retry (write still fails): the exit event now knows when the instance died.
  const second = run(dir, {
    exitEvents: [{ pid: 31000, startedAt: startOf(), type: 'claude', signal: 'SIGKILL', exitedAt }],
    previousState: first.state,
    now: NOW + 60_000,
    terminationJournal: { available: true, cursor: 'j=2', warning: '', entries: [] },
  });
  const all = [...second.state.termination.pending, ...second.state.termination.overflow];
  assert.equal(all.length, 1);
  assert.equal(all[0].cause, pendingBefore.cause, 'cause is not rewritten');
  assert.ok(Number.isFinite(Number(all[0].endMs)) && Number(all[0].endMs) > 0, 'the learned end of life is kept');
  // A later retry has no exit event, but the same PID now has OOM evidence
  // after the stored lifetime boundary. The old instance must remain weak.
  const third = run(dir, {
    previousState: second.state,
    now: NOW + 120_000,
    terminationJournal: {
      available: true,
      cursor: 'j=3',
      warning: '',
      entries: parseTerminationEvidence(`${at(NOW + 30_000)} host kernel: Out of memory: Killed process 31000 (node)`),
    },
  });
  const retried = [...third.state.termination.pending, ...third.state.termination.overflow];
  assert.equal(retried.length, 1);
  assert.deepEqual([retried[0].cause, retried[0].confidence], [pendingBefore.cause, pendingBefore.confidence]);
  assert.equal(Number(retried[0].endMs), NOW - 5_000, 'the learned boundary survives a retry without the exit event');
});

test('R17-S3: an event created between per-source journal reads is not lost', () => {
  // Fake journal with a global clock. A kernel OOM line lands after -k was read
  // but before -u is read, so -u's cursor is newer than the event: a shared
  // "newest" cursor would skip it on the next run.
  const journal = { k: [], u: [] };
  let clock = 0;
  let injected = false;
  const fake = (_cmd, args) => {
    const stream = args.includes('-k') ? 'k' : args.includes('--user-unit') ? 'U' : 'u';
    if (stream === 'U') throw new Error('No journal files were found.');
    if (stream === 'u' && !injected) {
      injected = true;
      clock += 1;
      journal.k.push({ at: clock, text: '2026-10-09T14:00:05+0200 host kernel: Out of memory: Killed process 4242 (node)' });
    }
    clock += 1;
    const after = args.find((a) => a.startsWith('--after-cursor='));
    const from = after ? Number(/t=(\d+);/.exec(after)[1]) : 0;
    const rows = journal[stream].filter((r) => r.at > from);
    return `${rows.map((r) => r.text).join('\n')}\n-- cursor: s=a;t=${clock};x=1`;
  };
  const first = readTerminationJournal({ execFile: fake });
  assert.match(first.cursor, /^multi:/, 'diverging sources keep separate cursors');
  const second = readTerminationJournal({ execFile: fake, afterCursor: first.cursor });
  const kills = [...first.entries, ...second.entries].filter((e) => /Killed process 4242/.test(e.line));
  assert.equal(kills.length, 1, 'the in-between kernel event is read exactly once');
});

test('R17-S3: bounded-tail truncation is reported per read and the cursor stays per source', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `2026-10-09T14:00:00+0200 host kernel: noise ${i}`).join('\n');
  const journal = readTerminationJournal({
    execFile: (_cmd, args) => {
      if (args.includes('--user-unit')) throw new Error('No journal files were found.');
      return args.includes('-k') ? `${lines}\n-- cursor: s=a;t=1;k1` : '-- cursor: s=a;t=2;u2';
    },
  });
  assert.match(journal.warning, /300-line tail limit/);
  assert.equal(journal.cursor, 'multi:k=s=a;t=1;k1|u=s=a;t=2;u2');
});
