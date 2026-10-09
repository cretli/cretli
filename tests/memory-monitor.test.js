import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  applyAlertEpisodes,
  buildTopProcesses,
  createMemoryMonitorProbes,
  evaluateMemoryMonitor,
  evaluateSwapPressure,
  findDuplicateWebpackWatchers,
  formatMemoryMonitorReport,
  getMemoryMonitorAlertPath,
  parseEarlyoomJournal,
  parseMeminfo,
  parsePsOutput,
  readEarlyoomJournal,
  readMemoryMonitorAlerts,
  readMemoryMonitorState,
  resolveMemoryMonitorConfig,
  resolveWebpackConfigBaseDir,
  runMemoryMonitorOnce,
} from '../lib/memory-monitor.js';
import { publishMemoryMonitorAlerts, selectPublishableAlerts } from '../lib/notifications/memory-monitor-producer.js';
import { listNotifications, validatePublishInput } from '../lib/notifications/notification-store.js';

const MiB = 1024 ** 2;

function createTempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'cretli-memory-monitor-'));
}

function meminfoFixture({ totalMiB = 24576, availableMiB = 14000, swapTotalMiB = 8192, swapFreeMiB = 8192 } = {}) {
  return [
    `MemTotal:       ${totalMiB * 1024} kB`,
    `MemAvailable:   ${availableMiB * 1024} kB`,
    `SwapTotal:      ${swapTotalMiB * 1024} kB`,
    `SwapFree:       ${swapFreeMiB * 1024} kB`,
  ].join('\n') + '\n';
}

function psFixture(rows) {
  return `${rows.map((row) => `  ${row.pid}  ${row.ppid}  ${row.rssKb ?? 1000} ${row.args}`).join('\n')}\n`;
}

function processesFrom(rows, startTimes = {}) {
  return parsePsOutput(psFixture(rows), { startTimes });
}

function probes({ alive = [], startTimes = {}, findListeningPid } = {}) {
  return {
    isProcessAlive: (pid) => alive.includes(pid),
    getProcessStartTime: (pid) => String(startTimes[pid] ?? ''),
    ...(findListeningPid ? { findListeningPid } : {}),
  };
}

function ownerEntry(overrides = {}) {
  return {
    instanceKey: 'opencode-fixture',
    opencodePid: 0,
    opencodeStartedAt: '',
    serverPid: 0,
    serverStartedAt: '',
    serverInstanceToken: '',
    updatedAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    now: 1_800_000_000_000,
    config: { ...resolveMemoryMonitorConfig({}) },
    host: parseMeminfo(meminfoFixture()),
    processes: [],
    registry: {},
    previousState: {},
    earlyoom: { available: true, cursor: '', entries: [], warning: '' },
    probes: probes(),
    ...overrides,
  };
}

// --- fixtures: memory and swap ------------------------------------------------

test('parses /proc/meminfo fixtures and skips swap on a machine without swap', () => {
  const parsed = parseMeminfo(meminfoFixture({ swapTotalMiB: 0, swapFreeMiB: 0 }));
  assert.equal(parsed.totalBytes, 24576 * MiB);
  assert.equal(parsed.swapTotalBytes, 0);
  const evaluation = evaluateMemoryMonitor(baseInput({
    host: parsed,
    previousState: { lastSwapUsedBytes: 0, lastSwapAt: new Date(1_800_000_000_000).toISOString() },
  }));
  assert.equal(evaluation.swap, null);
  assert.equal(evaluation.triggered.includes('swap-pressure'), false);
});

test('alarms on the critical memory threshold before earlyoom would kill', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    host: parseMeminfo(meminfoFixture({ availableMiB: 3900 })),
  }));
  assert.deepEqual(evaluation.triggered, ['memory-critical']);
  const alert = evaluation.episodeAlerts.find((row) => row.type === 'memory-critical');
  assert.equal(alert.severity, 'error');
  assert.match(alert.message, /3900 MiB/);
  assert.equal(evaluation.episodeAlerts.some((row) => row.type === 'memory-warning'), false);
});

test('uses the warning threshold between warn and critical, and stays quiet above warn', () => {
  const warning = evaluateMemoryMonitor(baseInput({ host: parseMeminfo(meminfoFixture({ availableMiB: 5000 })) }));
  assert.deepEqual(warning.triggered, ['memory-warning']);
  const quiet = evaluateMemoryMonitor(baseInput({ host: parseMeminfo(meminfoFixture({ availableMiB: 12000 })) }));
  assert.deepEqual(quiet.triggered, []);
  assert.equal(quiet.thresholdExceeded, false);
});

test('alarms on swap over half or on fast swap growth', () => {
  const half = evaluateMemoryMonitor(baseInput({
    host: parseMeminfo(meminfoFixture({ swapTotalMiB: 8192, swapFreeMiB: 4000 })),
  }));
  assert.ok(half.triggered.includes('swap-pressure'));

  const grewFast = evaluateMemoryMonitor(baseInput({
    host: parseMeminfo(meminfoFixture({ swapTotalMiB: 8192, swapFreeMiB: 6500 })),
    previousState: { lastSwapUsedBytes: 200 * MiB, lastSwapAt: new Date(1_800_000_000_000 - 60_000).toISOString() },
  }));
  const swapAlert = grewFast.episodeAlerts.find((row) => row.type === 'swap-pressure');
  assert.ok(swapAlert);
  assert.equal(swapAlert.details.grewFast, true);
});

test('evaluateSwapPressure ignores a slow small rise', () => {
  const swap = evaluateSwapPressure({
    host: { swapTotalBytes: 8192 * MiB, swapFreeBytes: 7900 * MiB },
    previousState: { lastSwapUsedBytes: 200 * MiB, lastSwapAt: new Date(1_800_000_000_000 - 60_000).toISOString() },
    config: resolveMemoryMonitorConfig({}),
    now: 1_800_000_000_000,
  });
  assert.equal(swap, null);
});

// --- orphans, wrappers, foreign processes ------------------------------------

test('detects an OpenCode orphan re-parented to Relay (PPID is not 1)', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    registry: {
      5296: ownerEntry({
        instanceKey: 'session:cretli:abc',
        opencodePid: 2222,
        opencodeStartedAt: '5000',
        serverPid: 4444,
        serverStartedAt: '1000',
      }),
    },
    processes: processesFrom(
      [{ pid: 2222, ppid: 838, rssKb: 400_000, args: 'opencode serve --hostname=127.0.0.1 --port=5296' }],
      { 2222: '5000' },
    ),
    // The recorded owner server (4444) is dead; Relay (838) is not the criterion.
    probes: probes({ alive: [838], startTimes: { 838: '10' } }),
  }));
  assert.equal(evaluation.orphaned.length, 1);
  assert.equal(evaluation.orphaned[0].pid, 2222);
  assert.equal(evaluation.orphaned[0].ppid, 838);
  const alert = evaluation.episodeAlerts.find((row) => row.type === 'opencode-orphan');
  assert.ok(alert);
  assert.equal(alert.details.orphaned[0].ppid, 838);
  assert.equal(alert.details.orphaned[0].serverPid, 4444);
});

test('does not call a managed OpenCode an orphan when it runs under an npm/sh wrapper', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    registry: {
      5296: ownerEntry({
        opencodePid: 2222,
        opencodeStartedAt: '5000',
        serverPid: 5000,
        serverStartedAt: '1000',
      }),
    },
    processes: processesFrom(
      [
        { pid: 300, ppid: 1, rssKb: 5000, args: 'npm exec opencode' },
        { pid: 2222, ppid: 300, rssKb: 400_000, args: 'opencode serve --hostname=127.0.0.1 --port=5296' },
      ],
      { 2222: '5000', 5000: '1000' },
    ),
    probes: probes({ alive: [5000, 300, 2222], startTimes: { 5000: '1000' } }),
  }));
  assert.equal(evaluation.orphaned.length, 0);
  assert.equal(evaluation.managed.count, 1);
  assert.equal(evaluation.episodeAlerts.some((row) => row.type === 'opencode-orphan'), false);
});

test('reports OpenCode serve processes outside the registry as foreign without an orphan alarm', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    registry: {},
    processes: processesFrom([
      { pid: 9999, ppid: 838, rssKb: 300_000, args: 'opencode serve --hostname=127.0.0.1 --port=4177' },
    ]),
    probes: probes({ alive: [838] }),
  }));
  assert.equal(evaluation.foreign.length, 1);
  assert.equal(evaluation.foreign[0].pid, 9999);
  assert.equal(evaluation.orphaned.length, 0);
  assert.equal(evaluation.episodeAlerts.some((row) => row.type === 'opencode-orphan'), false);
});

test('maps a legacy registry entry to its live listener instead of calling it foreign', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    registry: { 4146: 'session:/tmp/cretli/legacy' },
    processes: processesFrom([
      { pid: 777, ppid: 838, rssKb: 300_000, args: 'opencode serve --hostname=127.0.0.1 --port=4146' },
    ]),
    probes: probes({ alive: [838], findListeningPid: (port) => (port === 4146 ? 777 : 0) }),
  }));
  assert.equal(evaluation.managed.count, 1);
  assert.equal(evaluation.foreign.length, 0);
  assert.equal(evaluation.orphaned.length, 0);
});

test('alarms only above the high total OpenCode count, not on normal one-per-chat usage', () => {
  const normal = evaluateMemoryMonitor(baseInput({
    processes: processesFrom([
      { pid: 1001, ppid: 838, rssKb: 300_000, args: 'opencode serve --port=4101' },
    ]),
  }));
  assert.equal(normal.triggered.includes('opencode-count-high'), false);

  const many = evaluateMemoryMonitor(baseInput({
    processes: processesFrom(Array.from({ length: 11 }, (_, index) => ({
      pid: 2000 + index,
      ppid: 838,
      rssKb: 100_000,
      args: `opencode serve --port=${4200 + index}`,
    }))),
  }));
  assert.equal(many.opencodeTotal, 11);
  assert.ok(many.triggered.includes('opencode-count-high'));
});

// --- webpack watchers ---------------------------------------------------------

test('detects duplicate webpack watchers by project + config realpath', () => {
  const processes = processesFrom([
    { pid: 4001, ppid: 1, rssKb: 500_000, args: 'node webpack-cli-watch.mjs --config /work/app/app_front/webpack.dev.js' },
    { pid: 4002, ppid: 1, rssKb: 500_000, args: 'node webpack-cli-watch.mjs --config /work/app/app_front/webpack.dev.js' },
    { pid: 4003, ppid: 1, rssKb: 400_000, args: 'node webpack-cli-watch.mjs --config /work/other/app_front/webpack.dev.js' },
  ]);
  const groups = findDuplicateWebpackWatchers(processes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].configRealpath, '/work/app/app_front/webpack.dev.js');
  assert.deepEqual(groups[0].processes.map((row) => row.pid), [4001, 4002]);
});

test('keeps watchers from different checkouts apart for a relative --config', (context) => {
  const root = createTempDirectory();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const createCheckout = (name) => {
    const scriptsDir = path.join(root, name, 'app_front', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, 'webpack-cli-watch.mjs'), '// fixture\n');
    writeFileSync(path.join(root, name, 'app_front', 'webpack.dev.js'), 'module.exports = {};\n');
    return path.join(scriptsDir, 'webpack-cli-watch.mjs');
  };
  const scriptA = createCheckout('checkoutA');
  const scriptB = createCheckout('checkoutB');
  // The real spawn uses `node scripts/webpack-cli-watch.mjs --config webpack.dev.js`
  // from `<checkout>/app_front`, so the script path anchors the relative config.
  assert.equal(
    resolveWebpackConfigBaseDir(`node ${scriptA} --config webpack.dev.js`),
    path.join(root, 'checkoutA', 'app_front'),
  );
  const processes = processesFrom([
    { pid: 910001, ppid: 1, rssKb: 500_000, args: `node ${scriptA} --config webpack.dev.js` },
    { pid: 910002, ppid: 1, rssKb: 500_000, args: `node ${scriptA} --config webpack.dev.js` },
    { pid: 910003, ppid: 1, rssKb: 400_000, args: `node ${scriptB} --config webpack.dev.js` },
    { pid: 910004, ppid: 1, rssKb: 400_000, args: `node ${scriptB} --config webpack.dev.js` },
  ]);
  // Fake PIDs have no /proc/<pid>/cwd; the script path is the fallback anchor.
  // The old monitor-CWD resolution put all four into ONE group; the process
  // resolution keeps the two checkouts in their own group.
  const groups = findDuplicateWebpackWatchers(processes, { readProcessCwd: () => '' });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].configRealpath, realpathSync(path.join(root, 'checkoutA', 'app_front', 'webpack.dev.js')));
  assert.deepEqual(groups[0].processes.map((row) => row.pid), [910001, 910002]);
  assert.equal(groups[1].configRealpath, realpathSync(path.join(root, 'checkoutB', 'app_front', 'webpack.dev.js')));
  assert.deepEqual(groups[1].processes.map((row) => row.pid), [910003, 910004]);
});

test('resolves a relative --config against /proc CWD so it matches an absolute config', () => {
  const processes = processesFrom([
    { pid: 910014, ppid: 1, rssKb: 1000, args: 'node /work/app/app_front/scripts/webpack-cli-watch.mjs --config webpack.dev.js' },
    { pid: 910015, ppid: 1, rssKb: 1000, args: 'node /work/app/app_front/scripts/webpack-cli-watch.mjs --config /work/app/app_front/webpack.dev.js' },
  ]);
  const groups = findDuplicateWebpackWatchers(processes, {
    readProcessCwd: (pid) => (pid === 910014 ? '/work/app/app_front' : ''),
    realpath: (value) => value,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].configRealpath, '/work/app/app_front/webpack.dev.js');
  assert.deepEqual(groups[0].processes.map((row) => row.pid), [910014, 910015]);
});

// --- earlyoom journal ---------------------------------------------------------

test('parses earlyoom kill events and the journald cursor', () => {
  const text = [
    '2026-10-09T15:00:00+0200 host earlyoom[500]: sending SIGTERM to process 1234',
    '2026-10-09T15:00:01+0200 host earlyoom[500]: mem avail: 2300 of 24576 MiB',
    '2026-10-09T15:00:55+0200 host earlyoom[500]: escalating to SIGKILL for pid 1234',
    '-- cursor: s=abc;i=42;b=deadbeef;m=1;t=2;x=3',
  ].join('\n');
  const parsed = parseEarlyoomJournal(text);
  assert.equal(parsed.cursor, 's=abc;i=42;b=deadbeef;m=1;t=2;x=3');
  assert.equal(parsed.entries.length, 2);
  assert.match(parsed.entries[0].message, /sending SIGTERM/);
  assert.match(parsed.entries[1].message, /escalating to SIGKILL/);
});

test('treats a missing journalctl as a warning, not an error', () => {
  const journal = readEarlyoomJournal({
    execFile: () => {
      const error = new Error('spawn journalctl ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(journal.available, false);
  assert.match(journal.warning, /journalctl is not installed/);

  const evaluation = evaluateMemoryMonitor(baseInput({
    earlyoom: journal,
  }));
  assert.equal(evaluation.warnings.length, 1);
  assert.equal(evaluation.eventAlerts.length, 0);
  assert.equal(evaluation.thresholdExceeded, false);
  assert.doesNotThrow(() => formatMemoryMonitorReport({
    at: evaluation.at,
    config: resolveMemoryMonitorConfig({}),
    warnings: evaluation.warnings,
    alerts: [],
    written: 0,
    skipped: 0,
    alertFilePath: null,
    statePath: '/tmp/state.json',
    evaluation,
  }));
});

test('turns new earlyoom events into discrete event alerts', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    earlyoom: {
      available: true,
      cursor: 'cursor-1',
      warning: '',
      entries: [
        { timestamp: '2026-10-09T15:00:00+0200', message: 'sending SIGKILL to process 999' },
      ],
    },
  }));
  assert.equal(evaluation.eventAlerts.length, 1);
  assert.equal(evaluation.eventAlerts[0].type, 'earlyoom-kill');
  assert.equal(evaluation.thresholdExceeded, true);
});

test('an earlyoom kill alert carries the top processes like threshold alerts', () => {
  const evaluation = evaluateMemoryMonitor(baseInput({
    processes: processesFrom(
      [{ pid: 4242, ppid: 1, rssKb: 900_000, args: 'node heavy.js' }],
      { 4242: '77' },
    ),
    earlyoom: {
      available: true,
      cursor: 'cursor-1',
      warning: '',
      entries: [{ timestamp: '2026-10-09T15:00:00+0200', message: 'sending SIGKILL to process 999' }],
    },
  }));
  assert.equal(evaluation.eventAlerts.length, 1);
  const topProcesses = evaluation.eventAlerts[0].details.topProcesses;
  assert.equal(topProcesses.length, 1);
  assert.equal(topProcesses[0].pid, 4242);
});

test('a long earlyoom message stays within the store fingerprint limit and publishes', async (context) => {
  const dataDir = createTempDirectory();
  const storePath = path.join(dataDir, 'notification-center.json');
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  // 500+ characters would push the old `timestamp:message` fingerprint past the
  // 512-character limit enforced by `validatePublishInput`.
  const longMessage = `sending SIGKILL to process 999 ${'x'.repeat(900)}`;
  const previousState = {
    version: 1,
    lastRunAt: new Date(1_800_000_000_000 - 60_000).toISOString(),
    episodes: {},
    earlyoom: { cursor: 'cursor-0', seen: [] },
  };
  const result = runMemoryMonitorOnce({
    dataDir,
    host: parseMeminfo(meminfoFixture()),
    processes: [],
    registry: {},
    probes: probes(),
    previousState,
    earlyoom: {
      available: true,
      cursor: 'cursor-1',
      warning: '',
      entries: [{ timestamp: '2026-10-09T15:00:00+0200', message: longMessage }],
    },
  });
  assert.equal(result.alerts.length, 1);
  const alert = result.alerts[0];
  assert.equal(alert.type, 'earlyoom-kill');
  assert.ok(alert.fingerprint.length <= 512, `fingerprint must fit the limit, got ${alert.fingerprint.length}`);
  assert.equal(validatePublishInput({
    category: 'system',
    severity: 'error',
    title: alert.title,
    body: alert.message,
    actionUrl: '',
    fingerprint: alert.fingerprint,
  }).ok, true);

  const published = await publishMemoryMonitorAlerts({ dataDir, storePath, broadcast: false });
  assert.equal(published.published, 1);
  assert.equal(published.invalid, 0);
  const listed = listNotifications({}, { storePath });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].fingerprint, alert.fingerprint);
});

test('logs and counts an alarm whose fingerprint the notification store rejects', async (context) => {
  const dataDir = createTempDirectory();
  const storePath = path.join(dataDir, 'notification-center.json');
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const filePath = getMemoryMonitorAlertPath(dataDir, Date.now());
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(filePath, `${JSON.stringify({
    at: new Date().toISOString(),
    event: 'memory-monitor-alert',
    alert: true,
    severity: 'error',
    type: 'earlyoom-kill',
    title: 'earlyoom killed a process',
    message: 'x',
    fingerprint: `memory-monitor:earlyoom-kill:legacy:${'x'.repeat(600)}`,
    details: {},
  })}\n`);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const result = await publishMemoryMonitorAlerts({ dataDir, storePath, broadcast: false });
    assert.equal(result.published, 0);
    assert.equal(result.invalid, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /memory-monitor alert skipped/);
});

test('collapses repeated episode alerts to the newest per type and keeps discrete events', () => {
  const rows = [
    { alert: true, type: 'memory-critical', fingerprint: 'memory-monitor:memory-critical#episode:3' },
    { alert: true, type: 'memory-critical', fingerprint: 'memory-monitor:memory-critical#episode:2' },
    { alert: true, type: 'swap-pressure', fingerprint: 'memory-monitor:swap-pressure#episode:1' },
    { alert: true, type: 'earlyoom-kill', fingerprint: 'memory-monitor:earlyoom-kill:a:1' },
    { alert: true, type: 'earlyoom-kill', fingerprint: 'memory-monitor:earlyoom-kill:a:2' },
    { alert: false, type: 'memory-critical-recovered', fingerprint: 'memory-monitor:memory-critical:recovered:x' },
  ];
  assert.deepEqual(selectPublishableAlerts(rows).map((row) => row.fingerprint), [
    'memory-monitor:memory-critical#episode:3',
    'memory-monitor:swap-pressure#episode:1',
    'memory-monitor:earlyoom-kill:a:1',
    'memory-monitor:earlyoom-kill:a:2',
  ]);
});

test('the first run records the earlyoom cursor without alarming on history', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const result = runMemoryMonitorOnce({
    dataDir,
    host: parseMeminfo(meminfoFixture()),
    processes: [],
    registry: {},
    probes: probes(),
    earlyoom: {
      available: true,
      cursor: 'cursor-9',
      warning: '',
      entries: [{ timestamp: '2026-10-09T14:00:00+0200', message: 'sending SIGKILL to process 1' }],
    },
  });
  assert.equal(result.alerts.length, 0);
  assert.match(result.warnings.join(' '), /baseline/);
  assert.equal(readMemoryMonitorState(dataDir).earlyoom.cursor, 'cursor-9');
});

test('does not re-alarm the same earlyoom event after a cursor rotation', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const event = { timestamp: '2026-10-09T15:00:00+0200', message: 'sending SIGKILL to process 999' };
  const previousState = {
    version: 1,
    lastRunAt: new Date(1_800_000_000_000 - 60_000).toISOString(),
    episodes: {},
    earlyoom: { cursor: 'cursor-0', seen: [] },
  };
  const common = {
    dataDir,
    host: parseMeminfo(meminfoFixture()),
    processes: [],
    registry: {},
    probes: probes(),
  };
  const first = runMemoryMonitorOnce({
    ...common,
    previousState,
    earlyoom: { available: true, cursor: 'cursor-1', warning: '', entries: [event] },
  });
  assert.equal(first.alerts.length, 1);

  const second = runMemoryMonitorOnce({
    ...common,
    earlyoom: { available: true, cursor: 'cursor-2', warning: 'journal cursor was stale', entries: [event] },
  });
  assert.equal(second.alerts.length, 0, 'the same journal line must not alarm twice');
});

// --- episode dedupe -----------------------------------------------------------

test('emits one alarm per episode and re-emits only after recovery or the repeat window', () => {
  const alert = { type: 'memory-critical', severity: 'error', title: 'low', message: 'low', fingerprintBase: 'memory-monitor:memory-critical' };
  const first = applyAlertEpisodes({ alerts: [alert], previousEpisodes: {}, nowMs: 1_000_000, repeatMs: 30 * 60 * 1000 });
  assert.equal(first.emitted.length, 1);
  assert.equal(first.emitted[0].fingerprint, 'memory-monitor:memory-critical#episode:1');

  const second = applyAlertEpisodes({ alerts: [alert], previousEpisodes: first.episodes, nowMs: 1_060_000, repeatMs: 30 * 60 * 1000 });
  assert.equal(second.emitted.length, 0);
  assert.deepEqual(second.recovered, []);

  const afterWindow = applyAlertEpisodes({ alerts: [alert], previousEpisodes: first.episodes, nowMs: 1_000_000 + 30 * 60 * 1000, repeatMs: 30 * 60 * 1000 });
  assert.equal(afterWindow.emitted.length, 1);
  assert.equal(afterWindow.emitted[0].fingerprint, 'memory-monitor:memory-critical#episode:2');

  const recovery = applyAlertEpisodes({ alerts: [], previousEpisodes: afterWindow.episodes, nowMs: 1_000_000 + 31 * 60 * 1000, repeatMs: 30 * 60 * 1000 });
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.episodes['memory-critical'].active, false);

  const newEpisode = applyAlertEpisodes({ alerts: [alert], previousEpisodes: recovery.episodes, nowMs: 1_000_000 + 32 * 60 * 1000, repeatMs: 30 * 60 * 1000 });
  assert.equal(newEpisode.emitted.length, 1);
  assert.equal(newEpisode.emitted[0].fingerprint, 'memory-monitor:memory-critical#episode:3');
});

// --- end-to-end run and persistence ------------------------------------------

test('runMemoryMonitorOnce writes one alert per episode, exits non-zero, and stays quiet on a repeat', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const common = {
    dataDir,
    config: resolveMemoryMonitorConfig({}),
    host: parseMeminfo(meminfoFixture({ availableMiB: 3000 })),
    processes: [],
    registry: {},
    earlyoom: { available: true, cursor: 'cursor-1', entries: [], warning: '' },
    probes: probes(),
  };

  const first = runMemoryMonitorOnce({ ...common, now: 1_800_000_000_000 });
  assert.equal(first.exitCode, 1);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].type, 'memory-critical');
  assert.equal(first.written, 1);

  const second = runMemoryMonitorOnce({ ...common, now: 1_800_000_060_000 });
  assert.equal(second.exitCode, 1, 'the threshold is still exceeded');
  assert.equal(second.alerts.length, 0, 'the same episode must not duplicate the alarm');
  assert.equal(second.suppressedEpisodeAlerts, 1);

  const filePath = getMemoryMonitorAlertPath(dataDir, 1_800_000_000_000);
  const lines = readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].alert, true);
  assert.equal(lines[0].type, 'memory-critical');

  const state = readMemoryMonitorState(dataDir);
  assert.equal(state.episodes['memory-critical'].active, true);
  assert.equal(state.episodes['memory-critical'].episode, 1);

  const recent = readMemoryMonitorAlerts({ dataDir, limit: 10, now: 1_800_000_060_000 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].fingerprint, 'memory-monitor:memory-critical#episode:1');
});

test('runMemoryMonitorOnce records a recovery line after the threshold clears', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const low = {
    dataDir,
    config: resolveMemoryMonitorConfig({}),
    host: parseMeminfo(meminfoFixture({ availableMiB: 3000 })),
    processes: [],
    registry: {},
    earlyoom: { available: false, cursor: '', entries: [], warning: 'journalctl is not installed' },
    probes: probes(),
  };
  const first = runMemoryMonitorOnce({ ...low, now: 1_800_000_000_000 });
  assert.equal(first.alerts.length, 1);

  const healthy = runMemoryMonitorOnce({
    ...low,
    host: parseMeminfo(meminfoFixture({ availableMiB: 12000 })),
    now: 1_800_000_060_000,
  });
  assert.equal(healthy.alerts.length, 0);
  assert.equal(healthy.recovered.length, 1);
  assert.equal(healthy.written, 1, 'the recovery line is persisted');
  const recent = readMemoryMonitorAlerts({ dataDir, limit: 10, now: 1_800_000_060_000 });
  assert.ok(recent.some((row) => row.event === 'memory-monitor-recovered' && row.alert === false));
  assert.ok(recent.some((row) => row.event === 'memory-monitor-alert' && row.alert === true));
});

test('config thresholds are overridable through the environment', () => {
  const config = resolveMemoryMonitorConfig({
    CRETLI_MEMORY_MONITOR_MEM_CRITICAL_MB: '2048',
    CRETLI_MEMORY_MONITOR_MEM_WARN_MB: '3072',
    CRETLI_MEMORY_MONITOR_MAX_OPENCODE: '25',
    CRETLI_MEMORY_MONITOR_ALERT_REPEAT_MS: '60000',
  });
  assert.equal(config.memoryCriticalBytes, 2048 * MiB);
  assert.equal(config.memoryWarnBytes, 3072 * MiB);
  assert.equal(config.maxOpenCodeProcesses, 25);
  assert.equal(config.alertRepeatMs, 60_000);
});

test('buildTopProcesses keeps the ten largest with PPID and start time', () => {
  const processes = processesFrom(Array.from({ length: 12 }, (_, index) => ({
    pid: 100 + index,
    ppid: 10 + index,
    rssKb: (index + 1) * 1000,
    args: `proc-${index}`,
  })), Object.fromEntries(Array.from({ length: 12 }, (_, index) => [100 + index, String(5000 + index)])));
  const top = buildTopProcesses(processes, 10);
  assert.equal(top.length, 10);
  assert.equal(top[0].pid, 111);
  assert.equal(top[0].ppid, 21);
  assert.equal(top[0].startTime, '5011');
});

// --- server visibility after a dead server -----------------------------------

test('an alarm written while the server was dead becomes a notification after start and is not duplicated', async (context) => {
  const dataDir = createTempDirectory();
  const storePath = path.join(dataDir, 'notification-center.json');
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));

  // Written while the server was down (real Date.now() so the reader window
  // includes today's file, exactly as a fresh server start would see it).
  runMemoryMonitorOnce({
    dataDir,
    config: resolveMemoryMonitorConfig({}),
    host: parseMeminfo(meminfoFixture({ availableMiB: 2500 })),
    processes: [],
    registry: {},
    earlyoom: { available: true, cursor: 'cursor-1', entries: [], warning: '' },
    probes: probes(),
  });

  const first = await publishMemoryMonitorAlerts({ dataDir, storePath, broadcast: false });
  assert.equal(first.published, 1);
  const second = await publishMemoryMonitorAlerts({ dataDir, storePath, broadcast: false });
  assert.equal(second.published, 0, 'the notification store dedupes by fingerprint');

  const listed = listNotifications({}, { storePath });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].category, 'system');
  assert.equal(listed.items[0].severity, 'error');
  assert.equal(listed.items[0].fingerprint, 'memory-monitor:memory-critical#episode:1');
});

test('runMemoryMonitorOnce reads the injected OpenCode registry path', (context) => {
  const dataDir = createTempDirectory();
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const registryPath = path.join(dataDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ 60001: 'session:/fixture/legacy' }));
  const result = runMemoryMonitorOnce({
    dataDir,
    registryPath,
    host: parseMeminfo(meminfoFixture()),
    processes: [],
    probes: probes(),
    earlyoom: { available: true, cursor: 'cursor-1', entries: [], warning: '' },
    write: false,
  });
  assert.deepEqual(result.evaluation.stale, [{ port: 60001, pid: 0, reason: 'legacy-entry-without-live-listener' }]);
});

// --- fixtures keep the real probes importable ---------------------------------

test('real probes expose the injectable surface without touching the machine', () => {
  const realProbes = createMemoryMonitorProbes();
  assert.equal(typeof realProbes.readHostMemory, 'function');
  assert.equal(typeof realProbes.readProcessSnapshot, 'function');
  assert.equal(typeof realProbes.readEarlyoomJournal, 'function');
  assert.equal(typeof realProbes.isProcessAlive, 'function');
  assert.equal(typeof realProbes.findListeningPid, 'function');
});
