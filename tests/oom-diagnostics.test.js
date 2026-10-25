import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendMemoryLedger, applyCgroupMemoryLimit, bootOomDiagnostics, readEffectiveHostMemory,
  OOM_BOOT_WARNING_MAX_AGE_MS, classifyExit, detectUnexpectedTerminations, evaluateMemoryGuard,
  measureMemory, parseCgroupMemoryEvents, parseJournalLineTimestamp, parseJournalLineTimestampRange, parseProcCgroup,
  parseTerminationEvidence, preflightExecutorStart,
  readCleanShutdownMarker, readCgroupMemory, readHostMemory, readMemoryLedger, readOomMarkers, readProcessCgroup,
  readServerRuntimeMarker, recordCleanShutdown, resolveProcessStartMs, terminationTargetKey, writeCleanShutdownMarker,
  writeOomMarker, writeServerRuntimeMarker,
} from '../lib/oom-diagnostics.js';

const GB = 1024 ** 3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-oom-'));
// R17-F3: evidence is only `confirmed` when its journal timestamp can be placed
// inside the recorded lifetime of the target instance, so fixtures use an
// explicit start time and `short-iso` line prefixes.
const START_MS = Date.parse('2026-10-09T13:00:00Z');
const START = String(START_MS);
const KILL_LINE = '2026-10-09T14:00:00Z kernel: Out of memory: Killed process 4242 (node)';

test('parses kernel, earlyoom and systemd evidence with confidence', () => {
  const ev = parseTerminationEvidence([
    '2026-10-09T14:00:00+0200 kernel: Out of memory: Killed process 4242 (node) total-vm:1kB',
    '2026-10-09T14:00:01+0200 earlyoom[1]: sending SIGTERM to process 77 "node": badness 9',
    "2026-10-09T14:00:02+0200 systemd[1]: cretli.service: Failed with result 'oom-kill'.",
    '2026-10-09T14:00:03+0200 systemd[1]: cretli.service: Main process exited, code=killed, status=9/KILL',
  ].join('\n'));
  assert.deepEqual(ev.map((e) => [e.source, e.pid, e.confidence, e.at !== null]), [
    ['kernel', 4242, 'confirmed', true], ['earlyoom', 77, 'confirmed', true], ['systemd', null, 'confirmed', true], ['systemd', null, 'probable', true],
  ]);
  // A line without a journal timestamp keeps `at: null` (the statement itself is
  // still a kill) but cannot be confirmed for a specific process instance.
  const plain = parseTerminationEvidence('kernel: Out of memory: Killed process 4242 (node)');
  assert.equal(plain[0].at, null);
  assert.deepEqual([plain[0].source, plain[0].confidence], ['kernel', 'confirmed']);
});

test('requires an external journal origin for OOM evidence', () => {
  const applicationLine = '2026-10-09T14:00:00Z cretli[123]: Out of memory: Killed process 4242 (node)';
  assert.deepEqual(parseTerminationEvidence(applicationLine), [], 'application log text is not kernel evidence');
  const kernel = parseTerminationEvidence('2026-10-09T14:00:00Z kernel: Out of memory: Killed process 4242 (node)');
  assert.deepEqual([kernel[0].source, kernel[0].confidence], ['kernel', 'confirmed']);
});

test('R17-AUD-F1: an application line quoting a SIGKILL exit is not systemd evidence', () => {
  const applicationLine = '2026-10-09T14:00:00Z cretli[123]: Main process exited, code=killed, status=9/KILL';
  assert.deepEqual(parseTerminationEvidence(applicationLine), [], 'application log text is not supervisor evidence');
  assert.equal(classifyExit({ pid: 123, startedAt: START, evidence: parseTerminationEvidence(applicationLine) }).cause, 'unknown');
  // The quote must not promote a recorded exit to a durable systemd marker.
  const detected = detectUnexpectedTerminations({
    exitEvents: [{ pid: 123, startedAt: START, signal: 'SIGKILL', type: 'claude', label: 'quoted' }],
    evidence: parseTerminationEvidence(applicationLine),
  });
  assert.deepEqual([detected.targets[0].source, detected.targets[0].confidence], ['exit-status', 'probable'], 'the quote never becomes the supervisor basis');
  // A real systemd journal header still proves the supervisor saw SIGKILL.
  const supervisor = parseTerminationEvidence('2026-10-09T14:00:00Z host systemd[1]: cretli.service: Main process exited, code=killed, status=9/KILL');
  assert.deepEqual(supervisor.map((entry) => [entry.source, entry.kind, entry.confidence]), [['systemd', 'sigkill-exit', 'probable']]);
  const classified = classifyExit({ pid: 123, startedAt: START, evidence: supervisor });
  assert.deepEqual([classified.cause, classified.source, classified.confidence], ['sigkill', 'systemd', 'probable']);
});

test('R7-F1: a short-iso timestamp names an interval, not a point', () => {
  const whole = parseJournalLineTimestampRange('2026-10-09T14:00:00Z kernel: Out of memory: Killed process 1 (node)');
  assert.deepEqual([whole.at, whole.atEnd, whole.precisionMs], [
    Date.parse('2026-10-09T14:00:00Z'), Date.parse('2026-10-09T14:00:00.999Z'), 1000,
  ]);
  // One fractional digit is 100 ms wide; Date truncates the interval start.
  const tenth = parseJournalLineTimestampRange('2026-10-09T14:00:00.5Z systemd[1]: x');
  assert.deepEqual([tenth.at, tenth.atEnd, tenth.precisionMs], [
    Date.parse('2026-10-09T14:00:00.500Z'), Date.parse('2026-10-09T14:00:00.599Z'), 100,
  ]);
  assert.equal(parseJournalLineTimestampRange('no timestamp'), null);
  // The plain helper keeps its old contract: the earliest instant.
  assert.equal(parseJournalLineTimestamp('2026-10-09T14:00:00Z x'), Date.parse('2026-10-09T14:00:00Z'));
  assert.equal(parseJournalLineTimestamp('no timestamp'), null);
});

test('resolveProcessStartMs converts /proc start ticks with an injected boot time (R6A3-N1)', () => {
  const bootTimeMs = 1791958809000;
  const expected = 1791958810180;
  // /proc/<pid>/stat field 22 is in 100 Hz clock ticks: 118 ticks = 1180 ms.
  assert.equal(resolveProcessStartMs('118', bootTimeMs), expected);
  assert.equal(new Date(expected).toISOString(), '2026-10-14T06:20:10.180Z');
  assert.equal(resolveProcessStartMs('2026-10-14T06:20:10.180Z'), expected, 'ISO input is used as-is');
  assert.equal(resolveProcessStartMs(String(expected)), expected, 'epoch-ms input is used as-is');
  assert.equal(resolveProcessStartMs('118', 0), null, 'a tick count without a usable boot time cannot be placed');
  assert.equal(resolveProcessStartMs('0', bootTimeMs), null);
});

test('classifyExit: pid match confirmed, pid-less probable, no evidence unknown', () => {
  const ev = parseTerminationEvidence(KILL_LINE);
  assert.equal(classifyExit({ pid: 4242, startedAt: START, evidence: ev }).confidence, 'confirmed');
  // R17-F3: a bare pid match is not proof when the line or the start time is
  // unknown; only a time-correlated match may be `confirmed`.
  assert.equal(classifyExit({ pid: 4242, evidence: ev }).confidence, 'probable', 'no startedAt => cannot be confirmed');
  assert.equal(classifyExit({ pid: 4242, startedAt: START, evidence: parseTerminationEvidence('kernel: Out of memory: Killed process 4242 (node)') }).confidence, 'probable', 'no line timestamp => cannot be confirmed');
  assert.equal(classifyExit({ pid: 1, evidence: ev }).cause, 'unknown');
  const unit = parseTerminationEvidence("2026-10-09T14:00:00Z systemd[1]: cretli.service: Failed with result 'oom-kill'.");
  assert.equal(classifyExit({ pid: 1, startedAt: START, evidence: unit, targetUnits: ['cretli.service'] }).confidence, 'probable');
  assert.equal(classifyExit({ pid: 1, evidence: unit }).cause, 'unknown', 'pidless evidence without a target unit proves nothing');
  assert.deepEqual(classifyExit({ pid: 1 }).confidence, 'unknown');
  assert.equal(classifyExit({ cleanShutdown: true }).cause, 'clean-shutdown');
});

test('cgroup oom_kill delta is probable evidence; sigkill alone is not OOM', () => {
  const events = parseCgroupMemoryEvents('low 0\noom 2\noom_kill 3\n');
  assert.equal(events.oom_kill, 3);
  const r = classifyExit({ pid: 9, cgroupBefore: { events: { oom_kill: 1 } }, cgroupAfter: { events } });
  assert.deepEqual([r.cause, r.source, r.confidence], ['oom-kill', 'cgroup', 'probable']);
  // SIGKILL exit evidence only counts from the systemd supervisor header.
  const k = classifyExit({ pid: 9, evidence: parseTerminationEvidence('systemd[1]: cretli.service: Main process exited, code=killed, status=9/KILL') });
  assert.equal(k.cause, 'sigkill');
});

test('readCgroupMemory tolerates missing files and max', () => {
  const files = { '/c/memory.events': 'oom_kill 2\n', '/c/memory.current': '100\n', '/c/memory.max': 'max\n' };
  const r = readCgroupMemory('/c', (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; });
  assert.deepEqual([r.events.oom_kill, r.currentBytes, r.maxBytes], [2, 100, null]);
  assert.equal(readCgroupMemory('/x', () => { throw new Error('no'); }).available, false);
});

test('marker is durable, written by an external observer, and survives torn lines', () => {
  const dir = tmp();
  writeOomMarker(dir, { target: 'executor', pid: 4242, ...classifyExit({ pid: 4242, startedAt: START, evidence: parseTerminationEvidence(KILL_LINE) }) });
  fs.appendFileSync(path.join(dir, 'oom-markers.jsonl'), '{torn');
  const [m] = readOomMarkers(dir);
  assert.deepEqual([m.writer, m.source, m.confidence, m.pid], ['external-observer', 'kernel', 'confirmed', 4242]);
  writeOomMarker(dir, { pid: 4242, target: 'executor', cause: 'sigkill', source: 'exit-status', confidence: 'probable' });
  assert.equal(readOomMarkers(dir).filter((marker) => marker.pid === 4242).length, 1, 'a crash retry cannot append a weaker duplicate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('marker dominance accounts for cause and evidence, not only the confidence label', () => {
  const sigkill = { target: 'executor', pid: 31, startedAt: '1', cause: 'sigkill', source: 'exit-status', confidence: 'probable' };
  const oom = { target: 'executor', pid: 31, startedAt: '1', cause: 'oom-kill', source: 'cgroup', confidence: 'probable' };
  // SIGKILL -> OOM: the OOM proof is recorded over the bare signal.
  let dir = tmp();
  writeOomMarker(dir, sigkill);
  const upgraded = writeOomMarker(dir, oom);
  assert.equal(upgraded.cause, 'oom-kill');
  assert.deepEqual(readOomMarkers(dir).map((m) => m.cause), ['sigkill', 'oom-kill']);
  // Old state replayed after the append: the OOM marker stays, nothing new is appended.
  assert.equal(writeOomMarker(dir, sigkill).cause, 'oom-kill');
  assert.equal(writeOomMarker(dir, oom).cause, 'oom-kill');
  assert.equal(readOomMarkers(dir).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
  // OOM -> SIGKILL: the weaker signal does not displace OOM evidence.
  dir = tmp();
  writeOomMarker(dir, oom);
  assert.equal(writeOomMarker(dir, sigkill).cause, 'oom-kill');
  assert.equal(readOomMarkers(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  // Same classification retry stays deduplicated; confirmed still beats probable.
  dir = tmp();
  writeOomMarker(dir, sigkill);
  writeOomMarker(dir, sigkill);
  assert.equal(readOomMarkers(dir).length, 1);
  writeOomMarker(dir, { ...oom, source: 'kernel', confidence: 'confirmed' });
  assert.equal(writeOomMarker(dir, oom).confidence, 'confirmed');
  assert.equal(readOomMarkers(dir).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('measureMemory sums server + executors and reports unreadable ones', () => {
  const rss = { 1: 100, 2: 40, 3: 60 };
  const r = measureMemory({ serverPid: 1, executors: [{ pid: 2, type: 'pty' }, { pid: 3 }, { pid: 4 }], readRss: (p) => rss[p] ?? null });
  assert.deepEqual([r.serverRssBytes, r.executorsRssBytes, r.executorCount, r.unreadable], [100, 100, 3, 1]);
});

test('ledger persists samples', () => {
  const dir = tmp();
  appendMemoryLedger(dir, { hostTotalBytes: 8 * GB, hostAvailableBytes: GB, serverRssBytes: 5, executorsRssBytes: 7, executorCount: 2 }, 0);
  const [row] = readMemoryLedger(dir);
  assert.deepEqual([row.serverRssBytes, row.executorsRssBytes, row.at], [5, 7, '1970-01-01T00:00:00.000Z']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('guard levels and preflight', () => {
  assert.equal(evaluateMemoryGuard({ hostTotalBytes: 10 * GB, hostAvailableBytes: 5 * GB }).level, 'ok');
  assert.equal(evaluateMemoryGuard({ hostTotalBytes: 10 * GB, hostAvailableBytes: 1 * GB }).level, 'warn');
  assert.equal(evaluateMemoryGuard({ hostTotalBytes: 10 * GB, hostAvailableBytes: 0.5 * GB }).level, 'critical');
  assert.equal(evaluateMemoryGuard({}).level, 'unknown');
  assert.equal(preflightExecutorStart({ hostTotalBytes: 10 * GB, hostAvailableBytes: 0.5 * GB }).allowed, false);
  assert.equal(preflightExecutorStart({ hostTotalBytes: 10 * GB, hostAvailableBytes: 0.9 * GB }).allowed, false);
  assert.equal(preflightExecutorStart({ hostTotalBytes: 10 * GB, hostAvailableBytes: 5 * GB }).allowed, true);
  assert.equal(preflightExecutorStart({}).allowed, true);
});

test('reads host memory and cgroup v2 paths from injectable files', () => {
  const meminfo = 'MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n';
  assert.deepEqual(readHostMemory(() => meminfo), { totalBytes: 16_000_000 * 1024, availableBytes: 4_000_000 * 1024 });
  const missing = readHostMemory(() => { throw new Error('ENOENT'); });
  assert.deepEqual(missing, { totalBytes: null, availableBytes: null }, 'unknown memory is never guessed from free memory');

  const unified = parseProcCgroup('0::/user.slice/user-1000.slice/cretli.service\n');
  assert.deepEqual([unified.version, unified.path, unified.memoryDir], [2, '/user.slice/user-1000.slice/cretli.service', '/sys/fs/cgroup/user.slice/user-1000.slice/cretli.service']);
  const v1 = parseProcCgroup('11:memory:/docker/abc\n1:name=systemd:/x\n');
  assert.deepEqual([v1.version, v1.memoryDir], [1, null]);
  assert.equal(parseProcCgroup(''), null);
  const processCgroup = readProcessCgroup(42, () => '0::/a/b\n');
  assert.equal(processCgroup.memoryDir, '/sys/fs/cgroup/a/b');
  assert.equal(readProcessCgroup(42, () => { throw new Error('gone'); }), null);
});

test('server runtime and clean shutdown markers are durable and instance-scoped', () => {
  const dir = tmp();
  writeServerRuntimeMarker(dir, { pid: 4242, startedAt: '500', instanceToken: 'tok' }, 0);
  const runtime = readServerRuntimeMarker(dir);
  assert.deepEqual([runtime.pid, runtime.startedAt, runtime.instanceToken, runtime.bootAt], [4242, '500', 'tok', '1970-01-01T00:00:00.000Z']);

  writeCleanShutdownMarker(dir, { pid: 4242, startedAt: '500', signal: 'SIGTERM' }, 1000);
  const shutdown = readCleanShutdownMarker(dir);
  assert.deepEqual([shutdown.pid, shutdown.startedAt, shutdown.signal, shutdown.shutdownAt], [4242, '500', 'SIGTERM', '1970-01-01T00:00:01.000Z']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boot wiring records markers from a previous run and clean shutdown', () => {
  const dir = tmp();
  writeOomMarker(dir, { target: 'server', pid: 9, cause: 'oom-kill', source: 'kernel', confidence: 'confirmed' });
  writeServerRuntimeMarker(dir, { pid: 4000, startedAt: '800', instanceToken: 'previous' });
  const recorded = [];
  const summary = bootOomDiagnostics({
    dataDir: dir,
    serverPid: 5000,
    startedAt: '900',
    instanceToken: 'instance',
    diagnostics: { record: (event, details) => recorded.push({ event, details }) },
    now: 0,
  });
  assert.equal(summary.markerCount, 1);
  assert.equal(summary.lastMarker.confidence, 'confirmed');
  const runtime = readServerRuntimeMarker(dir);
  assert.equal(runtime.pid, 5000);
  assert.deepEqual([runtime.previous.pid, runtime.previous.startedAt], [4000, '800'], 'the superseded identity survives the overwrite');
  assert.deepEqual(recorded.map((row) => row.event), ['oom-diagnostics-boot']);
  assert.equal(recorded[0].details.markerCount, 1);

  recordCleanShutdown({ dataDir: dir, serverPid: 5000, startedAt: '900', signal: 'SIGTERM', diagnostics: { record: (event) => recorded.push({ event }) }, now: 0 });
  assert.equal(readCleanShutdownMarker(dir).signal, 'SIGTERM');
  assert.equal(recorded[1].event, 'oom-diagnostics-clean-shutdown');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R17-AUD-F3: a reboot with an unchanged last marker does not repeat the OOM warning', () => {
  const dir = tmp();
  const marker = { target: 'server', pid: 9, cause: 'oom-kill', source: 'kernel', confidence: 'confirmed', recordedAt: '1970-01-01T00:00:01.000Z' };
  writeOomMarker(dir, marker, 1000);
  const first = bootOomDiagnostics({ dataDir: dir, serverPid: 4000, startedAt: '800', now: 2000 });
  assert.equal(first.hasNewMarker, true, 'the first boot announces the durable marker');
  const reboot = bootOomDiagnostics({ dataDir: dir, serverPid: 5000, startedAt: '900', now: 3000 });
  assert.equal(reboot.markerCount, 1);
  assert.equal(reboot.hasNewMarker, false, 'the same marker is not announced again after a restart');
  writeOomMarker(dir, { target: 'executor', pid: 10, cause: 'oom-kill', source: 'kernel', confidence: 'confirmed' }, 4000);
  const withNew = bootOomDiagnostics({ dataDir: dir, serverPid: 6000, startedAt: '1000', now: 5000 });
  assert.equal(withNew.markerCount, 2);
  assert.equal(withNew.hasNewMarker, true, 'a genuinely new marker triggers the warning');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detects a dead server from identity and classifies it from evidence only', () => {
  const previousServer = { pid: 700, startedAt: START };
  const cleanForOtherInstance = { pid: 700, startedAt: '999' };
  const unknown = detectUnexpectedTerminations({ previousServer, observedServer: { pid: 700, alive: false } });
  assert.equal(unknown.targets.length, 1);
  assert.deepEqual([unknown.targets[0].target, unknown.targets[0].cause, unknown.targets[0].confidence], ['server', 'unknown', 'unknown']);
  assert.equal(terminationTargetKey(unknown.targets[0]), `server:700:${START}`);

  const clean = detectUnexpectedTerminations({ previousServer, cleanShutdown: { pid: 700, startedAt: START }, observedServer: { pid: 700, alive: false } });
  assert.equal(clean.targets.length, 0, 'a matching clean shutdown marker suppresses the marker');

  const staleClean = detectUnexpectedTerminations({ previousServer, cleanShutdown: cleanForOtherInstance, observedServer: { pid: 700, alive: false } });
  assert.equal(staleClean.targets.length, 1, 'a marker from another server instance does not hide a later death');

  const killed = detectUnexpectedTerminations({
    previousServer,
    observedServer: { pid: 700, alive: false },
    evidence: parseTerminationEvidence('2026-10-09T14:00:00Z kernel: Out of memory: Killed process 700 (node)'),
  });
  assert.deepEqual([killed.targets[0].cause, killed.targets[0].source, killed.targets[0].confidence], ['oom-kill', 'kernel', 'confirmed']);

  const alive = detectUnexpectedTerminations({ previousServer, observedServer: { pid: 700, startedAt: START, alive: true } });
  assert.equal(alive.targets.length, 0);
});

test('executor termination is reported for stale entries and evidence-matched vanished children only', () => {
  const evidence = parseTerminationEvidence('2026-10-09T14:00:00Z kernel: Out of memory: Killed process 802 (node)');
  const result = detectUnexpectedTerminations({
    previousExecutors: [
      { pid: 802, startedAt: START, type: 'agent-run' },
      { pid: 803, startedAt: 'b', type: 'task-run' },
    ],
    liveExecutors: [],
    staleExecutors: [{ pid: 801, startedAt: 'c', type: 'tool-shell', label: 'bash' }],
    evidence,
  });
  const byPid = new Map(result.targets.map((row) => [row.pid, row]));
  assert.equal(byPid.get(801).cause, 'unknown', 'a stale registry entry is unexpected even without evidence');
  assert.equal(byPid.get(802).confidence, 'confirmed', 'evidence names this executor pid');
  assert.equal(byPid.has(803), false, 'a normally finished executor is not marked');
});

test('cgroup oom_kill delta makes an unproven termination probable', () => {
  const result = detectUnexpectedTerminations({
    previousServer: { pid: 900, startedAt: 'x' },
    observedServer: { pid: 900, alive: false },
    cgroupBefore: { events: { oom_kill: 1 } },
    cgroupAfter: { events: { oom_kill: 2 } },
  });
  assert.deepEqual([result.targets[0].cause, result.targets[0].source, result.targets[0].confidence], ['oom-kill', 'cgroup', 'probable']);
  assert.equal(result.cgroupDelta, true);
});

test('ledger records unreadable executors explicitly', () => {
  const dir = tmp();
  appendMemoryLedger(dir, {
    hostTotalBytes: 8 * GB,
    hostAvailableBytes: GB,
    serverPid: 10,
    serverRssBytes: 100,
    executorsRssBytes: 50,
    executorCount: 2,
    unreadable: 1,
    executors: [
      { pid: 11, type: 'agent-run', label: 'agent', rssBytes: 50 },
      { pid: 12, type: 'task-run', label: 'task', rssBytes: null },
    ],
  }, 0);
  const [row] = readMemoryLedger(dir);
  assert.deepEqual([row.serverPid, row.executorCount, row.unreadable], [10, 2, 1]);
  assert.equal(row.executors[1].pid, 12);
  assert.equal(row.executors[1].rssBytes, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F5: the boot summary skips stale markers and announces a fresh one exactly once', () => {
  const dir = tmp();
  const now = Date.parse('2026-10-09T12:00:00Z');
  const old = (pid) => ({ target: 'server', pid, cause: 'oom-kill', source: 'kernel', confidence: 'confirmed' });
  writeOomMarker(dir, old(1), now - OOM_BOOT_WARNING_MAX_AGE_MS - 60_000);
  writeOomMarker(dir, old(2), now - OOM_BOOT_WARNING_MAX_AGE_MS - 30_000);
  const restart = bootOomDiagnostics({ dataDir: dir, serverPid: 10, startedAt: '1', now });
  assert.equal(restart.markerCount, 2);
  assert.equal(restart.hasNewMarker, false, 'two old markers produce no warning');
  writeOomMarker(dir, old(3), now - 1000);
  const fresh = bootOomDiagnostics({ dataDir: dir, serverPid: 11, startedAt: '2', now });
  assert.equal(fresh.hasNewMarker, true, 'a fresh marker warns');
  const again = bootOomDiagnostics({ dataDir: dir, serverPid: 12, startedAt: '3', now: now + 1000 });
  assert.equal(again.hasNewMarker, false, 'and only once');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F6: server text quoting kernel/earlyoom evidence is not confirmed without a stream-appropriate source', () => {
  const unitStream = [
    '2026-10-09T14:00:00+0200 host cretli[5]: kernel: Out of memory: Killed process 4242 (node)',
    '2026-10-09T14:00:01+0200 host cretli[5]: first line of a multi-line message',
    'kernel: Out of memory: Killed process 4242 (node)',
    'earlyoom[1]: sending SIGTERM to process 4242 "node"',
  ].join('\n');
  // Unfiltered parsing reads the headerless continuation lines, so the unit
  // stream must be parsed with its own filter.
  assert.ok(parseTerminationEvidence(unitStream).length > 0);
  const filtered = parseTerminationEvidence(unitStream, { sources: ['systemd', 'systemd-oomd'], requireTimestamp: true });
  assert.deepEqual(filtered, [], 'the unit stream yields no kernel/earlyoom evidence');
  const kernelOnly = parseTerminationEvidence(unitStream, { sources: ['kernel'], requireTimestamp: true });
  assert.deepEqual(kernelOnly, [], 'a headerless or app-owned line is never kernel evidence');
  const real = parseTerminationEvidence(KILL_LINE, { sources: ['kernel'], requireTimestamp: true });
  assert.equal(real.length, 1);
  assert.equal(real[0].confidence, 'confirmed');
});

test('F7: the executor reserve scales to RAM so a 4 GiB host in the ok band is allowed', () => {
  const small = { hostTotalBytes: 4 * GB, hostAvailableBytes: 0.7 * GB }; // 17.5% => ok band
  assert.equal(evaluateMemoryGuard(small).level, 'ok');
  assert.equal(preflightExecutorStart(small).allowed, true);
  const warnBand = { hostTotalBytes: 4 * GB, hostAvailableBytes: 0.5 * GB }; // 12.5% => warn band, headroom 5.5%
  assert.equal(evaluateMemoryGuard(warnBand).level, 'warn');
  assert.equal(preflightExecutorStart(warnBand).allowed, true);
  assert.equal(preflightExecutorStart({ hostTotalBytes: 4 * GB, hostAvailableBytes: 0.3 * GB }).allowed, false, 'below the scaled reserve still refuses');
  // A large host keeps the configured 512 MiB upper bound.
  assert.equal(preflightExecutorStart({ hostTotalBytes: 64 * GB, hostAvailableBytes: 4.6 * GB }).allowed, false);
});

test('F7: the guard honors the cgroup memory limit', () => {
  const files = {
    '/proc/meminfo': `MemTotal: ${16 * 1024 * 1024} kB\nMemAvailable: ${12 * 1024 * 1024} kB\n`,
    '/proc/self/cgroup': '0::/system.slice/cretli.service\n',
    '/sys/fs/cgroup/system.slice/cretli.service/memory.max': String(2 * GB),
    '/sys/fs/cgroup/system.slice/cretli.service/memory.current': String(1.9 * GB),
    '/sys/fs/cgroup/system.slice/cretli.service/memory.events': 'oom_kill 0\n',
    '/sys/fs/cgroup/system.slice/memory.max': 'max',
  };
  const readFile = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };
  const host = readEffectiveHostMemory({ readFile });
  assert.equal(host.totalBytes, 2 * GB);
  assert.ok(Math.abs(host.availableBytes - 0.1 * GB) < 1024);
  assert.equal(preflightExecutorStart({ hostTotalBytes: host.totalBytes, hostAvailableBytes: host.availableBytes }).allowed, false);
  // No cgroup files: the host numbers pass through unchanged.
  const noCgroup = applyCgroupMemoryLimit({ totalBytes: 8 * GB, availableBytes: 4 * GB }, { readFile: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(noCgroup, { totalBytes: 8 * GB, availableBytes: 4 * GB });
});
