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
const { createAppsService, resolveConfinedCwd } = await import('../lib/apps/service.js');
const { createAppsMonitorJob } = await import('../lib/apps/runtime.js');
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
  assert.equal(ss(), 1);
  await runner.runNow('apps_monitor');
  assert.equal(ss(), 2);
  runner.stop();
});

test('monitor job is disabled until the service is configured, and interval comes from env', () => {
  assert.equal(createAppsMonitorJob({ getService: () => null }).isEnabled(), false);
  assert.equal(monitor.resolveMonitorIntervalMs({ CRETLI_APPS_MONITOR_INTERVAL_MS: '20000' }), 20000);
  assert.equal(monitor.resolveMonitorIntervalMs({ CRETLI_APPS_MONITOR_INTERVAL_MS: '5' }), monitor.MIN_MONITOR_INTERVAL_MS);
  assert.equal(monitor.resolveMonitorIntervalMs({}), monitor.DEFAULT_MONITOR_INTERVAL_MS);
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
  for (const cwd of ['/etc', '../outside', 'a/../../outside', '..', 'C:\\x']) {
    assert.equal(doc(null, { command: 'x', cwd }).ok, false, cwd);
  }
  assert.equal(doc(null, { command: 'x', cwd: 'sub/dir' }).ok, true);
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
