import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-apps-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = path.join(temp, 'data');
const { loadAppsFile, saveAppsFile, validateAppsDocument } = await import('../lib/apps/schema.js');
const { buildSuggestions, parseComposePort } = await import('../lib/apps/suggestions.js');
const monitor = await import('../lib/apps/monitor.js');
const { createAppsStateStore } = await import('../lib/apps/state-store.js');
const { createAppsService, processRunsInWorkspace, resolveConfinedCwd } = await import('../lib/apps/service.js');
const { createAppsMonitorJob, createAppsAutoStartJob } = await import('../lib/apps/runtime.js');
const { createTaskLauncher } = await import('../lib/apps/task-launcher.js');
const { createPeriodicJobRunner } = await import('../lib/periodic-job-runner.js');

function workspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(temp, 'ws-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const myApp = { id: 'my-app', name: 'My app', start: { command: 'npm', args: ['run', 'dev'] }, ports: [{ port: 5173, bind: '127.0.0.1', role: 'http', healthPath: '/' }], exposure: 'local' };

test('schema: valid file loads with defaults; missing file is an empty registry', () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, ports: [{ port: 5173 }] }] } });
  const loaded = loadAppsFile(dir);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.apps[0].ports, [{ port: 5173, bind: '127.0.0.1', role: 'other' }]);
  assert.deepEqual(loadAppsFile(workspace()), { ok: true, exists: false, apps: [] });
});

test('schema: broken or invalid files return readable errors and never throw', () => {
  assert.match(loadAppsFile(workspace({ '.cretli/apps.json': '{ not json' })).errors[0], /not valid JSON/);
  assert.match(loadAppsFile(workspace({ '.cretli/apps.json': '[]' })).errors[0], /JSON object/);
  const bad = validateAppsDocument({ apps: [
    { id: 'a', name: 'A', start: { taskLabel: 'x', command: 'y' }, ports: [] },
    { id: 'b b', name: '', start: {}, ports: [{ port: 70000 }], exposure: 'wan' },
    { ...myApp }, { ...myApp, name: 'dup' },
  ] });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  assert.match(text, /apps\[0\]\.start needs exactly one/);
  assert.match(text, /apps\[1\]\.id/);
  assert.match(text, /apps\[1\]\.ports\[0\]\.port/);
  assert.match(text, /apps\[1\]\.exposure/);
  assert.match(text, /used twice/);
});

test('schema: saveAppsFile validates before writing and round-trips', () => {
  const dir = workspace();
  const refused = saveAppsFile(dir, [{ id: '!' }]);
  assert.equal(refused.ok, false);
  assert.equal(fs.existsSync(path.join(dir, '.cretli', 'apps.json')), false);
  assert.equal(saveAppsFile(dir, [myApp]).ok, true);
  assert.equal(loadAppsFile(dir).apps[0].id, 'my-app');
});

test('PID to task run mapping follows the process tree and rejects foreign pids', () => {
  const parents = new Map([[300, 200], [200, 100], [100, 1], [999, 1]]);
  const parentOf = (pid) => parents.get(pid) ?? null;
  assert.equal(monitor.belongsToProcessTree(300, 100, parentOf), true);
  assert.equal(monitor.belongsToProcessTree(100, 100, parentOf), true);
  assert.equal(monitor.belongsToProcessTree(999, 100, parentOf), false);
  assert.equal(monitor.belongsToProcessTree(null, 100, parentOf), false);
  assert.equal(monitor.belongsToProcessTree(300, null, parentOf), false);
  const app = { ...myApp, ports: [{ port: 5173, bind: '127.0.0.1', role: 'http' }, { port: 5174, bind: '127.0.0.1', role: 'api' }] };
  const listeners = [
    { address: '127.0.0.1', port: 5173, pid: 300, command: 'node' },
    { address: '0.0.0.0', port: 5174, pid: 999, command: 'python' },
  ];
  const ports = monitor.classifyAppPorts(app, listeners, { rootPid: 100, parentOf });
  assert.deepEqual(ports.map((p) => p.ownedBy), ['app', 'foreign']);
  assert.deepEqual(ports[1].warnings, ['exposure-local-but-wildcard']);
});

test('port conflict and orphan detection', () => {
  const listeners = [
    { address: '127.0.0.1', port: 5173, pid: 10, command: 'vite' },
    { address: '0.0.0.0', port: 9000, pid: 11, command: 'python3' },
    { address: '::', port: 9001, pid: process.pid, command: 'node' },
    { address: '127.0.0.1', port: 9002, pid: null, command: null },
  ];
  assert.deepEqual(monitor.detectPortConflicts(myApp, listeners), [{ port: 5173, address: '127.0.0.1', pid: 10, command: 'vite' }]);
  assert.deepEqual(monitor.detectPortConflicts({ ports: [{ port: 1 }] }, listeners), []);
  const orphans = monitor.findOrphans(listeners, [myApp]);
  assert.deepEqual(orphans.map((o) => o.port), [9000, 9002]);
  assert.equal(orphans[0].killHint, 'kill 11');
  assert.equal(orphans[1].killHint, null);
});

test('suggestions come from tasks, package.json scripts and compose ports, and write nothing', () => {
  const dir = workspace({
    '.vscode/tasks.json': { tasks: [{ label: 'Serve docs', type: 'shell', command: 'npm run docs' }] },
    'package.json': { scripts: { dev: 'vite', build: 'vite build', start: 'node .' } },
    'docker-compose.yml': 'services:\n  web:\n    ports:\n      - "8080:80"\n      - "127.0.0.1:8443:443/tcp"\n      - "9000"\n  worker:\n    image: x\n',
    'compose.override.yaml': 'services:\n  db:\n    ports:\n      - target: 5432\n        published: 15432\n',
  });
  const before = fs.readdirSync(dir).sort();
  const result = buildSuggestions(dir, [{ id: 'npm-start' }]);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  const by = (source) => result.filter((s) => s.source === source).map((s) => s.app);
  assert.deepEqual(by('task').map((a) => a.start), [{ taskLabel: 'Serve docs' }]);
  assert.deepEqual(by('package.json').map((a) => a.id), ['npm-dev', 'npm-start-2']); // id clash gets a suffix
  const web = by('compose').find((a) => a.id === 'compose-web');
  assert.deepEqual(web.ports.map((p) => [p.port, p.bind]), [[8080, '0.0.0.0'], [8443, '127.0.0.1']]);
  assert.equal(by('compose').find((a) => a.id === 'compose-db').ports[0].port, 15432);
  assert.equal(by('compose').some((a) => a.id === 'compose-worker'), false);
  assert.equal(validateAppsDocument({ apps: result.map((s) => s.app) }).ok, true);
  assert.deepEqual(parseComposePort('[::1]:3000:3000'), { port: 3000, bind: '::1' });
});

function makeService(overrides = {}) {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, autoStart: true }] } });
  const taskRuns = new Map();
  const notes = [];
  const events = [];
  let ssCalls = 0;
  const service = createAppsService({
    getWorkspaceDir: () => dir,
    taskRuns,
    launchTask: (spec, hooks) => {
      const runId = `run-${taskRuns.size + 1}`;
      taskRuns.set(runId, { pty: { pid: 100 }, clients: new Set(), taskLabel: spec.label, cwd: dir });
      service.__hooks = hooks;
      return { runId, pid: 100 };
    },
    snapshot: async () => { ssCalls += 1; return { ok: true, listeners: overrides.listeners || [] }; },
    state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
    broadcast: (e) => events.push(e),
    notify: (n) => notes.push(n),
    parentOf: () => null,
    isAlive: () => false,
    ...overrides,
  });
  return { service, dir, taskRuns, notes, events, ss: () => ssCalls };
}

test('start refuses a port held by a foreign process and starts nothing', async () => {
  const { service, taskRuns } = makeService({ listeners: [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }] });
  const result = await service.start('my-app');
  assert.equal(result.error, 'port-in-use');
  assert.equal(result.status, 409);
  assert.equal(result.conflicts[0].pid, 4242);
  assert.equal(taskRuns.size, 0);
});

test('takeover ends only the confirmed in-workspace listener, then starts the app', async () => {
  const listeners = [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }];
  const signals = [];
  const { service, taskRuns } = makeService({
    snapshot: async () => ({ ok: true, listeners: [...listeners] }),
    runsInWorkspace: () => true,
    signal: (pid, sig) => { signals.push([pid, sig]); listeners.length = 0; },
    sleep: async () => {},
  });
  const stale = await service.takeover('my-app', { pids: [1] });
  assert.equal(stale.error, 'takeover-stale');
  assert.deepEqual(signals, []);
  const done = await service.takeover('my-app', { pids: [4242] });
  assert.equal(done.ok, true);
  assert.deepEqual(signals, [[4242, 'SIGTERM']]);
  assert.equal(taskRuns.size, 1);
});

test('takeover refuses a process outside the workspace and an app with no pid confirmed', async () => {
  const signals = [];
  const { service, taskRuns } = makeService({
    listeners: [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }],
    runsInWorkspace: () => false,
    signal: (pid) => signals.push(pid),
  });
  const outside = await service.takeover('my-app', { pids: [4242] });
  assert.equal(outside.error, 'takeover-outside-workspace');
  assert.equal(outside.status, 403);
  assert.equal(outside.killHint, 'kill 4242');
  assert.equal((await service.takeover('my-app', {})).error, 'takeover-stale');
  assert.deepEqual(signals, []);
  assert.equal(taskRuns.size, 0);
});

test('takeover reports a process that keeps the port and never escalates', async () => {
  const signals = [];
  const { service, taskRuns } = makeService({
    listeners: [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }],
    runsInWorkspace: () => true,
    signal: (pid, sig) => signals.push(sig),
    sleep: async () => {},
  });
  const result = await service.takeover('my-app', { pids: [4242] });
  assert.equal(result.error, 'takeover-timeout');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(taskRuns.size, 0);
});

test('processRunsInWorkspace reads the real cwd and treats an unknown pid as outside', () => {
  assert.equal(processRunsInWorkspace(process.cwd(), process.pid), true);
  assert.equal(processRunsInWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'apps-elsewhere-')), process.pid), false);
  assert.equal(processRunsInWorkspace(process.cwd(), 2 ** 30), false);
});

test('an autoStart app whose run dies raises one notification and an error history entry', async () => {
  const { service, taskRuns, notes, events } = makeService();
  const started = await service.start('my-app');
  assert.equal(started.ok, true);
  taskRuns.delete(started.runId); // run vanished without a stop through the service
  await service.refresh();
  await service.refresh();
  assert.equal(notes.length, 1);
  assert.match(notes[0].fingerprint, /apps:died:.*my-app/);
  const status = await service.status();
  assert.equal(status.apps[0].status, 'exited');
  assert.equal(status.apps[0].errors.length, 1);
  assert.ok(events.some((e) => e.type === 'appsChanged' && e.reason === 'exited'));
});

test('a deliberate stop does not notify', async () => {
  const { service, notes } = makeService();
  await service.start('my-app');
  assert.equal((await service.stop('my-app')).ok, true);
  await service.refresh();
  assert.equal(notes.length, 0);
  assert.equal((await service.stop('my-app')).error, 'app-not-running');
});

test('monitoring runs at most one ss per tick and honors the configured interval', async () => {
  const { service, ss } = makeService();
  await service.status(); // A viewer keeps the monitor active.
  const before = ss();
  const intervals = [];
  const fakeTimers = {
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    clearIntervalFn() {},
    setTimeoutFn: (fn) => { fn(); return { unref() {} }; },
    clearTimeoutFn() {},
  };
  const runner = createPeriodicJobRunner(fakeTimers);
  const job = createAppsMonitorJob({ intervalMs: 7000, getService: () => service });
  runner.register(job);
  runner.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 7000);
  await runner.runNow('apps_monitor');
  assert.equal(ss(), before + 1);
  await runner.runNow('apps_monitor');
  assert.equal(ss(), before + 2);
  runner.stop();
});

test('monitor job is disabled until the service is configured, and interval comes from env', () => {
  assert.equal(createAppsMonitorJob({ getService: () => null }).isEnabled(), false);
  assert.equal(monitor.resolveMonitorIntervalMs({ CRETLI_APPS_MONITOR_INTERVAL_MS: '20000' }), 20000);
  assert.equal(monitor.resolveMonitorIntervalMs({ CRETLI_APPS_MONITOR_INTERVAL_MS: '5' }), monitor.MIN_MONITOR_INTERVAL_MS);
  assert.equal(monitor.resolveMonitorIntervalMs({}), monitor.DEFAULT_MONITOR_INTERVAL_MS);
});

test('task dependencies run in order and the app starts only after successful exits', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const taskRuns = new Map();
  const specs = [];
  const state = createAppsStateStore({ file: path.join(dir, 'state.json') });
  let service;
  service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state, snapshot: async () => ({ ok: true, listeners: [] }),
    loadTasksForWorkspace: () => ({ tasks: [
      { label: 'prepare', command: 'prepare', cwd: dir, dependsOn: ['generate'] },
      { label: 'generate', command: 'generate', cwd: dir },
      { label: 'serve', command: 'serve', cwd: dir, dependsOn: 'prepare' },
    ] }),
    launchTask: (spec, hooks) => {
      specs.push(spec.label);
      const id = `r${specs.length}`;
      taskRuns.set(id, {});
      if (spec.label === 'generate') setImmediate(() => hooks.onExit({ runId: id, exitCode: 0 }));
      else if (spec.label === 'prepare') setImmediate(() => hooks.onExit({ runId: id, exitCode: 0 }));
      return { runId: id, pid: 42 };
    },
  });
  const result = await service.start('my-app');
  assert.equal(result.ok, true);
  assert.deepEqual(specs, ['generate', 'prepare', 'serve']);
});

test('dependency errors and concurrent start/restart/stop are handled safely', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const taskRuns = new Map();
  let hooks;
  let launches = 0;
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
    snapshot: async () => ({ ok: true, listeners: [] }),
    loadTasksForWorkspace: () => ({ tasks: [{ label: 'serve', command: 'serve', cwd: dir, dependsOn: 'missing' }] }),
    launchTask: () => { launches += 1; return { runId: 'r', pid: 1 }; },
  });
  assert.equal((await service.start('my-app')).error, 'task-dependency-invalid');
  assert.equal(launches, 0);

  const dir2 = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const runs2 = new Map();
  const service2 = createAppsService({
    getWorkspaceDir: () => dir2, taskRuns: runs2, state: createAppsStateStore({ file: path.join(dir2, 'state.json') }),
    snapshot: async () => ({ ok: true, listeners: [] }), dependencyTimeoutMs: 1000,
    loadTasksForWorkspace: () => ({ tasks: [{ label: 'prep', command: 'prep', cwd: dir2 }, { label: 'serve', command: 'serve', cwd: dir2, dependsOn: 'prep' }] }),
    launchTask: (spec, h) => { launches += 1; hooks = h; runs2.set('dep', {}); return { runId: 'dep', pid: 1 }; },
  });
  const pending = service2.start('my-app');
  while (!hooks) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service2.start('my-app')).error, 'app-starting');
  assert.equal((await service2.restart('my-app')).error, 'app-starting');
  assert.equal((await service2.stop('my-app')).ok, true);
  assert.equal((await pending).error, 'app-start-cancelled');
});

test('dependency cycles and non-zero exits fail before the app task launches', async () => {
  const make = (tasks) => {
    const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
    const taskRuns = new Map();
    const launches = [];
    const service = createAppsService({
      getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
      snapshot: async () => ({ ok: true, listeners: [] }), loadTasksForWorkspace: () => ({ tasks }),
      launchTask: (spec, hooks) => {
        launches.push(spec.label);
        setImmediate(() => hooks.onExit({ runId: spec.label, exitCode: spec.label === 'prep' ? 2 : 0 }));
        return { runId: spec.label, pid: 12 };
      },
    });
    return { service, launches, dir };
  };
  const cycle = make([
    { label: 'serve', command: 'serve', cwd: '.', dependsOn: 'prep' },
    { label: 'prep', command: 'prep', cwd: '.', dependsOn: 'serve' },
  ]);
  assert.equal((await cycle.service.start('my-app')).error, 'task-dependency-invalid');
  assert.deepEqual(cycle.launches, []);

  const failed = make([
    { label: 'serve', command: 'serve', cwd: '.', dependsOn: 'prep' },
    { label: 'prep', command: 'prep', cwd: '.', dependsOn: [] },
  ]);
  const result = await failed.service.start('my-app');
  assert.equal(result.error, 'task-dependency-failed');
  assert.equal(result.label, 'prep');
  assert.deepEqual(failed.launches, ['prep']);
});

test('dependency timeout kills the active dependency run', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const taskRuns = new Map();
  let killed = false;
  let appLaunch = false;
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
    snapshot: async () => ({ ok: true, listeners: [] }), dependencyTimeoutMs: 5,
    loadTasksForWorkspace: () => ({ tasks: [{ label: 'prep', command: 'prep', cwd: dir }, { label: 'serve', command: 'serve', cwd: dir, dependsOn: 'prep' }] }),
    launchTask: (spec) => {
      if (spec.label === 'serve') appLaunch = true;
      else taskRuns.set('dep', { pty: { kill: () => { killed = true; } }, clients: new Set() });
      return { runId: spec.label === 'serve' ? 'app' : 'dep', pid: 1 };
    },
  });
  const result = await service.start('my-app');
  assert.equal(result.error, 'task-dependency-timeout');
  assert.equal(killed, true);
  assert.equal(appLaunch, false);
});

test('stale persisted starting state is normalized after service recreation', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const stateFile = path.join(dir, 'state.json');
  createAppsStateStore({ file: stateFile }).patch(dir, 'my-app', { status: 'starting', lastChangeAt: new Date().toISOString() });
  const taskRuns = new Map();
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: stateFile }),
    snapshot: async () => ({ ok: true, listeners: [] }),
    loadTasksForWorkspace: () => ({ tasks: [
      { label: 'prepare', command: 'prepare', cwd: dir },
      { label: 'serve', command: 'serve', cwd: dir, dependsOn: 'prepare' },
    ] }),
    launchTask: (spec, hooks) => {
      if (spec.label === 'prepare') {
        setImmediate(() => hooks.onExit({ runId: 'prepare-run', exitCode: 0 }));
        return { runId: 'prepare-run', pid: 20 };
      }
      taskRuns.set('app-run', { pty: { pid: 21 }, clients: new Set() });
      return { runId: 'app-run', pid: 21 };
    },
  });
  assert.equal((await service.status()).apps[0].status, 'stopped');
  const recovered = await service.start('my-app');
  assert.equal(recovered.ok, true);
  assert.equal(taskRuns.has(recovered.runId), true);
});

test('autoStart boot job is detached, sequential, one-shot, and continues after failures', async () => {
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = {
    list: () => ({ apps: [
      { id: 'a', autoStart: true, start: {} }, { id: 'external', autoStart: true, start: { external: true } },
      { id: 'b', autoStart: true, start: {} },
    ] }),
    status: async () => ({ apps: [] }),
    start: async (id) => { calls.push(id); if (id === 'a') await blocked; return id === 'b' ? { ok: false, error: 'port-in-use' } : { ok: true }; },
  };
  const job = createAppsAutoStartJob({ getService: () => service, canAcceptNewRun: () => true });
  assert.equal(job.run(), null);
  assert.equal(job.run(), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['a']);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['a', 'b']);
});

test('autoStart waits for update gate and gives up at its bound', async () => {
  let now = 0;
  let open = false;
  let starts = 0;
  const service = { list: () => ({ apps: [{ id: 'app', autoStart: true, start: {} }] }), status: async () => ({ apps: [] }), start: async () => { starts += 1; return { ok: true }; } };
  const job = createAppsAutoStartJob({
    getService: () => service, canAcceptNewRun: () => open, now: () => now, pollMs: 5, maxWaitMs: 20,
    sleep: async (ms) => { now += ms; if (now >= 10) open = true; },
  });
  job.run();
  for (let i = 0; i < 10 && starts === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  let timeoutNow = 0;
  const logs = [];
  const closedJob = createAppsAutoStartJob({
    getService: () => service, canAcceptNewRun: () => false, now: () => timeoutNow, pollMs: 5, maxWaitMs: 10,
    sleep: async (ms) => { timeoutNow += ms; }, log: (event) => logs.push(event),
  });
  closedJob.run();
  for (let i = 0; i < 10 && !logs.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.deepEqual(logs, ['apps-auto-start-gate-timeout']);
});

test('task launcher forwards the PTY exit code to its onExit hook', () => {
  let ptyExit;
  let observed;
  const launcher = createTaskLauncher({
    taskRuns: new Map(), buildInteractivePtyEnv: () => ({}), randomSessionId: () => 'run',
    spawnPty: () => ({ pid: 7, onData: () => {}, onExit: (fn) => { ptyExit = fn; }, kill() {} }),
  });
  launcher({ label: 'build', type: 'shell', command: 'build', cwd: '.', workspaceDir: '.' }, { onExit: (info) => { observed = info; } });
  ptyExit({ exitCode: 23 });
  assert.deepEqual(observed, { runId: 'run', exitCode: 23 });
});

test('listener snapshotter issues exactly one ss command', async () => {
  const calls = [];
  const snap = monitor.createListenerSnapshotter({
    run: async (file, args) => { calls.push([file, ...args]); return 'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=7,fd=19))\n'; },
    owners: async () => {},
  });
  const result = await snap();
  assert.deepEqual(calls, [['ss', '-ltnpH']]);
  assert.deepEqual(result.listeners, [{ address: '127.0.0.1', port: 5173, pid: 7, command: 'node' }]);
  const failing = await monitor.createListenerSnapshotter({ run: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } })();
  assert.equal(failing.ok, false);
});

test('schema rejects non-IP binds, unsafe health paths and cwd that escapes the workspace', () => {
  const doc = (port, start) => validateAppsDocument({ apps: [{ id: 'a', name: 'A', start: start || { command: 'x' }, ports: port ? [port] : [] }] });
  for (const bind of ['evil.example.com', '169.254.169.254.nip.io', 'a b', '']) {
    assert.equal(doc({ port: 80, bind }).ok, false, bind);
  }
  for (const bind of ['127.0.0.1', '0.0.0.0', '::', '::1', '[::1]', 'localhost', '*', '192.0.2.5']) {
    assert.equal(doc({ port: 80, bind }).ok, true, bind);
  }
  for (const healthPath of ['//evil.example.com/x', 'http://evil.example.com', '/a b', '/a\r\nHost: x', '/a\\b', '/a#b', 'health']) {
    assert.equal(doc({ port: 80, healthPath }).ok, false, JSON.stringify(healthPath));
  }
  assert.equal(doc({ port: 80, healthPath: '/healthz?x=1' }).ok, true);
  for (const cwd of ['../outside', 'a/../../outside', '..', 'C:\\x']) {
    assert.equal(doc(null, { command: 'x', cwd }).ok, false, cwd);
  }
  assert.equal(doc(null, { command: 'x', cwd: 'sub/dir' }).ok, true);
  // Absolute paths pass the lexical check; the launch confines them to the workspace and its worktrees.
  assert.equal(doc(null, { command: 'x', cwd: '/srv/sibling-worktree' }).ok, true);
});

test('health probe only targets loopback or local-interface addresses', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { status: 200, body: null }; };
  const local = () => new Set(['192.0.2.7']);
  const run = (bind, path = '/h') => monitor.probeHealth({ bind, port: 8080, path, fetchFn, localAddresses: local });
  assert.equal((await run('0.0.0.0')).code, 200);
  assert.equal((await run('::')).code, 200);
  assert.equal((await run('127.0.0.5')).code, 200);
  assert.equal((await run('192.0.2.7')).code, 200);
  assert.deepEqual(urls, ['http://127.0.0.1:8080/h', 'http://[::1]:8080/h', 'http://127.0.0.5:8080/h', 'http://192.0.2.7:8080/h']);
  urls.length = 0;
  assert.equal((await run('203.0.113.9')).skipped, 'non-local-address');
  assert.equal((await run('evil.example.com')).skipped, 'bind-not-an-ip');
  assert.equal((await run('127.0.0.1', '//evil.example.com/')).skipped, 'invalid-health-path');
  assert.equal((await run('127.0.0.1', '/a\r\nX: y')).skipped, 'invalid-health-path');
  assert.deepEqual(urls, []);
});

test('launch-time cwd confinement resolves symlinks and rejects escapes', () => {
  const root = workspace({ 'sub/.keep': '' });
  const outside = workspace();
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.equal(resolveConfinedCwd(root, undefined), fs.realpathSync(root));
  assert.equal(resolveConfinedCwd(root, 'sub'), fs.realpathSync(path.join(root, 'sub')));
  assert.equal(resolveConfinedCwd(root, '..'), null);
  assert.equal(resolveConfinedCwd(root, outside), null);
  assert.equal(resolveConfinedCwd(root, 'link'), null);
  assert.equal(resolveConfinedCwd(root, 'missing'), null);
});

test('cwd confinement accepts a listed sibling worktree but nothing else', async () => {
  const root = workspace();
  const sibling = workspace({ 'app/.keep': '' });
  const stranger = workspace();
  assert.equal(resolveConfinedCwd(root, sibling), null);
  assert.equal(resolveConfinedCwd(root, path.join(sibling, 'app'), [sibling]), fs.realpathSync(path.join(sibling, 'app')));
  assert.equal(resolveConfinedCwd(root, stranger, [sibling]), null);

  const { service, dir, taskRuns } = makeService({ listWorktreeRoots: () => [sibling] });
  fs.writeFileSync(path.join(dir, '.cretli', 'apps.json'), JSON.stringify({ apps: [
    { ...myApp, ports: [], start: { command: 'x', cwd: sibling } },
    { ...myApp, id: 'stranger', ports: [], start: { command: 'x', cwd: stranger } },
  ] }));
  assert.equal((await service.start('stranger')).error, 'invalid-cwd');
  assert.equal((await service.start(myApp.id)).ok, true);
  assert.equal(taskRuns.size, 1);
});

test('start refuses a command cwd that escapes the workspace even if the file was edited by hand', async () => {
  const { service, dir, taskRuns } = makeService();
  const outside = workspace();
  fs.writeFileSync(path.join(dir, '.cretli', 'apps.json'), JSON.stringify({ apps: [{ ...myApp, ports: [], start: { command: 'x', cwd: 'sub' } }] }));
  fs.symlinkSync(outside, path.join(dir, 'sub'));
  const result = await service.start('my-app');
  assert.equal(result.error, 'invalid-cwd');
  assert.equal(taskRuns.size, 0);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('an idle monitor takes no snapshot', async () => {
  const { service, ss } = makeService();
  await service.monitorTick();
  assert.equal(ss(), 0);
});

test('status and start follow the requested workspace, not the shared cwd', async () => {
  const { service } = makeService();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-other-'));
  try {
    assert.equal(service.add({ id: 'other-app', name: 'Other', start: { command: 'true' }, ports: [] }, { dir: other }).ok, true);
    assert.deepEqual((await service.status({ dir: other, refresh: true })).apps.map((a) => a.id), ['other-app']);
    assert.equal((await service.status({ refresh: true })).apps.some((a) => a.id === 'other-app'), false);
    assert.equal((await service.start('other-app')).error, 'app-not-found');
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('concurrent refreshes share one snapshot', async () => {
  const { service, ss } = makeService();
  await Promise.all([service.refresh(), service.refresh(), service.status({ refresh: true })]);
  assert.equal(ss(), 1);
});

test('remove drops a stopped app and refuses a running one', async () => {
  const { service } = makeService();
  assert.equal(service.add({ id: 'gone', name: 'Gone', start: { command: 'true' }, ports: [] }).ok, true);
  assert.equal(service.remove('missing').status, 404);
  assert.equal(service.remove('gone').ok, true);
  assert.equal(service.list().apps.some((a) => a.id === 'gone'), false);
});

const externalApp = { id: 'site', name: 'Site', start: { external: true }, ports: [{ port: 8090, bind: '0.0.0.0', role: 'http' }], exposure: 'lan' };

test('schema: an external app needs a port and no way to start it', () => {
  assert.equal(validateAppsDocument({ apps: [externalApp] }).ok, true);
  assert.equal(validateAppsDocument({ apps: [{ ...externalApp, ports: [] }] }).ok, false);
  assert.equal(validateAppsDocument({ apps: [{ ...externalApp, start: { external: true, command: 'nginx' } }] }).ok, false);
  assert.equal(validateAppsDocument({ apps: [{ ...externalApp, start: { external: false } }] }).ok, false);
});

test('external app: its listener is expected, status follows the port, start and stop are refused', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [externalApp] } });
  let listeners = [{ address: '0.0.0.0', port: 8090, pid: 42, command: 'nginx' }];
  let launched = 0;
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns: new Map(),
    launchTask: () => { launched += 1; return { runId: 'r', pid: 1 }; },
    snapshot: async () => ({ ok: true, listeners }),
    state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
  });
  const up = await service.status({ refresh: true });
  assert.equal(up.apps[0].external, true);
  assert.equal(up.apps[0].status, 'running');
  assert.equal(up.apps[0].ports[0].ownedBy, 'external');
  assert.equal((await service.start('site')).error, 'app-external');
  assert.equal((await service.stop('site')).error, 'app-external');
  assert.equal((await service.restart('site')).error, 'app-external');
  assert.equal(launched, 0);
  listeners = [];
  assert.equal((await service.status({ refresh: true })).apps[0].status, 'stopped');
});

test('concurrent starts cannot both pass when the second snapshot resolves late (F3)', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp }] } });
  const taskRuns = new Map();
  const resolvers = [];
  let launches = 0;
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
    snapshot: () => new Promise((resolve) => resolvers.push(() => resolve({ ok: true, listeners: [] }))),
    launchTask: () => { launches += 1; taskRuns.set(`r${launches}`, { pty: { pid: 5 }, clients: new Set() }); return { runId: `r${launches}`, pid: 5 }; },
  });
  const first = service.start('my-app');
  const second = service.start('my-app');
  assert.equal((await second).error, 'app-starting');
  resolvers.forEach((resolve) => resolve());
  assert.equal((await first).ok, true);
  assert.equal(launches, 1);
  // The lock is released afterwards, so a further start reports the live run.
  assert.equal((await service.start('my-app')).error, 'app-already-running');
});

test('removing an app while it is starting is refused and nothing is launched afterwards (F2)', async () => {
  const dir = workspace({ '.cretli/apps.json': { apps: [{ ...myApp, start: { taskLabel: 'serve' } }] } });
  const taskRuns = new Map();
  let depHooks;
  let appLaunches = 0;
  const service = createAppsService({
    getWorkspaceDir: () => dir, taskRuns, state: createAppsStateStore({ file: path.join(dir, 'state.json') }),
    snapshot: async () => ({ ok: true, listeners: [] }),
    loadTasksForWorkspace: () => ({ tasks: [{ label: 'prep', command: 'prep', cwd: dir }, { label: 'serve', command: 'serve', cwd: dir, dependsOn: 'prep' }] }),
    launchTask: (spec, hooks) => {
      if (spec.label === 'serve') { appLaunches += 1; return { runId: 'app', pid: 2 }; }
      depHooks = hooks;
      taskRuns.set('dep', { pty: { kill() {} }, clients: new Set() });
      return { runId: 'dep', pid: 1 };
    },
  });
  const starting = service.start('my-app');
  for (let i = 0; i < 5 && !depHooks; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(depHooks, 'dependency is running');
  const removed = service.remove('my-app');
  assert.equal(removed.ok, false);
  assert.equal(removed.error, 'app-starting');
  assert.equal(loadAppsFile(dir).apps.length, 1);
  depHooks.onExit({ runId: 'dep', exitCode: 0 });
  assert.equal((await starting).ok, true);
  assert.equal(appLaunches, 1);
});

/** Injected process tree for the ancestor walk: child -> parent, with per-pid comm/workspace overrides. */
function treeService({ parents, comms = {}, outside = [], tracked = [], listenerPid = 4242, selfPid = 9000, signals = [] }) {
  const listeners = [{ address: '127.0.0.1', port: 5173, pid: listenerPid, command: 'node' }];
  return makeService({
    snapshot: async () => ({ ok: true, listeners: [...listeners] }),
    parentOf: (pid) => (pid in parents ? parents[pid] : (pid === selfPid ? 1 : null)),
    readComm: (pid) => (pid in comms ? comms[pid] : 'node'),
    readCommand: (pid) => `cmd-${pid}`,
    isTracked: (pid) => tracked.includes(pid),
    selfPid,
    runsInWorkspace: (dir, pid) => !outside.includes(pid),
    signal: (pid, sig) => { signals.push([pid, sig]); listeners.length = 0; },
    sleep: async () => {},
  });
}
const foreignAncestors = async (service) => {
  const status = await service.status({ refresh: true });
  return status.apps[0].ports[0].listener.ancestors;
};

test('ancestor walk collects the old watcher parents, nearest first', async () => {
  const { service } = treeService({ parents: { 4242: 4000, 4000: 3000, 3000: 2000 }, comms: { 2000: 'bash' } });
  assert.deepEqual(await foreignAncestors(service), [{ pid: 4000, command: 'cmd-4000' }, { pid: 3000, command: 'cmd-3000' }]);
});

test('ancestor walk stops at each guard and excludes the stopping parent', async () => {
  const base = { 4242: 4000, 4000: 3000, 3000: 2000 };
  const cases = [
    ['outside workspace', { parents: base, outside: [3000] }, [4000]],
    ['PID 1', { parents: { 4242: 4000, 4000: 1 } }, [4000]],
    ['cretli itself', { parents: { ...base, 2000: 1 }, selfPid: 3000 }, [4000]],
    ['ancestor of cretli', { parents: { ...base, 9000: 3000, 2000: 1 } }, [4000]],
    ['tracked process', { parents: base, tracked: [3000] }, [4000]],
    ['sh', { parents: base, comms: { 3000: 'sh' } }, [4000]],
    ['dash', { parents: base, comms: { 3000: 'dash' } }, [4000]],
    ['login zsh', { parents: base, comms: { 3000: '-zsh' } }, [4000]],
    ['fish', { parents: base, comms: { 3000: 'fish' } }, [4000]],
    ['unreadable comm', { parents: base, comms: { 3000: null } }, [4000]],
    ['null parent', { parents: { 4242: 4000 } }, [4000]],
    ['cycle', { parents: { 4242: 4000, 4000: 3000, 3000: 4000 } }, [4000, 3000]],
  ];
  for (const [name, input, expected] of cases) {
    const { service } = treeService(input);
    assert.deepEqual((await foreignAncestors(service)).map((a) => a.pid), expected, name);
  }
});

test('ancestor walk is capped at 64 levels', async () => {
  const parents = {};
  for (let pid = 4242; pid < 4242 + 100; pid += 1) parents[pid] = pid + 1;
  const { service } = treeService({ parents });
  assert.equal((await foreignAncestors(service)).length, 64);
});

test('ancestors are computed only for foreign-owned ports (none without a listener)', async () => {
  const listener = { address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' };
  const parentOf = (pid) => ({ 4242: 4000, 9000: 1 })[pid] ?? null;
  const common = { snapshot: async () => ({ ok: true, listeners: [listener] }), parentOf, readComm: () => 'node', isTracked: () => false, runsInWorkspace: () => true, selfPid: 9000 };
  const foreign = await makeService(common).service.status({ refresh: true });
  assert.equal(foreign.apps[0].ports[0].ownedBy, 'foreign');
  assert.deepEqual(foreign.apps[0].ports[0].listener.ancestors.map((a) => a.pid), [4000]);
  // An external app's listener is expected, not foreign: no walk.
  const extDir = workspace({ '.cretli/apps.json': { apps: [externalApp] } });
  const ext = createAppsService({
    getWorkspaceDir: () => extDir, taskRuns: new Map(), launchTask: () => ({ runId: 'r', pid: 1 }),
    snapshot: async () => ({ ok: true, listeners: [{ address: '0.0.0.0', port: 8090, pid: 42, command: 'nginx' }] }),
    state: createAppsStateStore({ file: path.join(extDir, 'state.json') }),
    parentOf: () => { throw new Error('walk must not run'); },
  });
  const extStatus = await ext.status({ refresh: true });
  assert.equal(extStatus.apps[0].ports[0].ownedBy, 'external');
  assert.equal('ancestors' in extStatus.apps[0].ports[0].listener, false);
  const idle = await makeService({ listeners: [] }).service.status({ refresh: true });
  assert.equal(idle.apps[0].ports[0].listener, null);
});

test('takeover needs the exact set (listener + ancestors) in both directions and signals ancestors first, once each', async () => {
  const signals = [];
  const parents = { 4242: 4000, 4000: 3000 };
  const { service, taskRuns } = treeService({ parents, comms: { 3000: 'bash' }, signals });
  // Listener only: the ancestor is missing.
  assert.equal((await service.takeover('my-app', { pids: [4242] })).error, 'takeover-stale');
  // Extra PID.
  assert.equal((await service.takeover('my-app', { pids: [4242, 4000, 3000] })).error, 'takeover-stale');
  assert.deepEqual(signals, []);
  const done = await service.takeover('my-app', { pids: [4242, 4000] });
  assert.equal(done.ok, true);
  assert.deepEqual(signals, [[4000, 'SIGTERM'], [4242, 'SIGTERM']]);
  assert.equal(taskRuns.size, 1);
});

test('takeover re-checks the workspace of every pid before any signal', async () => {
  const signals = [];
  // The ancestor walk sees 4000 inside the workspace; the later per-pid check does not.
  const seen = new Set();
  const { service } = makeService({
    snapshot: async () => ({ ok: true, listeners: [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }] }),
    parentOf: (pid) => ({ 4242: 4000, 9000: 1 })[pid] ?? null,
    readComm: () => 'node', isTracked: () => false, selfPid: 9000,
    runsInWorkspace: (dir, pid) => { const first = !seen.has(pid); seen.add(pid); return pid !== 4000 || first; },
    signal: (pid) => signals.push(pid),
  });
  const result = await service.takeover('my-app', { pids: [4242, 4000] });
  assert.equal(result.error, 'takeover-outside-workspace');
  assert.equal(result.killHint, 'kill 4000 4242');
  assert.deepEqual(signals, []);
});

test('an incomplete Cretli protection chain yields no ancestors and no signal (fail closed)', async () => {
  const signals = [];
  // Cretli 9000 -> 8000 -> 7000, listener 4242 -> 7000; the parent read of 9000 is unavailable.
  const { service } = treeService({ parents: { 9000: null, 8000: 7000, 4242: 7000, 7000: 1 }, signals });
  assert.deepEqual(await foreignAncestors(service), []);
  assert.equal((await service.takeover('my-app', { pids: [4242, 7000] })).error, 'takeover-stale');
  assert.deepEqual(signals, []);
  // The same tree with a readable chain protects 7000 as Cretli's ancestor.
  const ok = treeService({ parents: { 9000: 8000, 8000: 7000, 7000: 1, 4242: 7000 } });
  assert.deepEqual(await foreignAncestors(ok.service), []);
});

test('takeover treats ESRCH as already gone per PID and still starts; other errors fail', async () => {
  const listeners = [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }];
  const signals = [];
  const { service, taskRuns } = makeService({
    snapshot: async () => ({ ok: true, listeners: [...listeners] }),
    parentOf: (pid) => ({ 4242: 4000, 9000: 1 })[pid] ?? null,
    readComm: () => 'node', isTracked: () => false, selfPid: 9000, runsInWorkspace: () => true,
    signal: (pid) => {
      signals.push(pid);
      if (pid === 4000) { listeners.length = 0; return; }
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
    sleep: async () => {},
  });
  const done = await service.takeover('my-app', { pids: [4242, 4000] });
  assert.equal(done.ok, true);
  assert.deepEqual(signals, [4000, 4242]);
  assert.equal(taskRuns.size, 1);

  const denied = makeService({
    snapshot: async () => ({ ok: true, listeners: [{ address: '127.0.0.1', port: 5173, pid: 4242, command: 'node' }] }),
    parentOf: () => null, runsInWorkspace: () => true,
    signal: () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); },
  });
  assert.equal((await denied.service.takeover('my-app', { pids: [4242] })).error, 'takeover-failed');
});
