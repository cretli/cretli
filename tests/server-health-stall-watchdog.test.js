import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { createMemoryRegistry, createFileRegistry } from '../lib/server-health/stall-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summarizeProfile,
  computeSignature,
  buildTodoBody,
  signatureMarker,
} from '../lib/server-health/cpu-profile-summary.js';
import { createStallWatchdog, createCooldownGate, createHttpProbe } from '../lib/server-health/stall-watchdog.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function frame(id, functionName, url, line, children = []) {
  return { id, callFrame: { functionName, url, lineNumber: line, columnNumber: 0 }, children };
}

// Synthetic cpuprofile: samples/timeDeltas in microseconds.
function syntheticProfile() {
  const nodes = [
    frame(1, '(root)', '', -1, [2, 3, 4, 5]),
    frame(2, 'hotLib', `file://${repoRoot}/lib/usage/ledger.js`, 9),
    frame(3, 'warmLib', `file://${repoRoot}/lib/report.js`, 19),
    frame(4, 'hotNodeModule', `file://${repoRoot}/node_modules/x/index.js`, 0),
    frame(5, '(idle)', '', -1),
  ];
  const samples = [2, 2, 2, 3, 4, 4, 4, 4, 5, 5];
  return { nodes, samples, timeDeltas: samples.map(() => 1000) };
}

// summarizeProfile: self-time ordering, lib/ section, idle excluded, relative paths.
const summary = summarizeProfile(syntheticProfile(), { repoRoot });
assert.equal(summary.totalMs, 8);
assert.equal(summary.top[0].functionName, 'hotNodeModule');
assert.equal(summary.top[0].selfMs, 4);
assert.deepEqual(summary.lib.map((r) => r.functionName), ['hotLib', 'warmLib']);
assert.equal(summary.lib[0].file, 'lib/usage/ledger.js');
assert.equal(summary.lib[0].line, 10);
assert.equal(summary.lib[0].percent, 37.5);
assert.ok(!summary.top.some((r) => r.functionName === '(idle)'));

// Signature: stable, differs for different lib frames, ignores timing.
const sig = computeSignature(summary);
assert.match(sig, /^[0-9a-f]{12}$/);
assert.equal(computeSignature(summarizeProfile(syntheticProfile(), { repoRoot })), sig);
const other = syntheticProfile();
other.nodes[1].callFrame.functionName = 'otherFn';
assert.notEqual(computeSignature(summarizeProfile(other, { repoRoot })), sig);
const slower = syntheticProfile();
slower.timeDeltas = slower.samples.map(() => 2500);
assert.equal(computeSignature(summarizeProfile(slower, { repoRoot })), sig);

// buildTodoBody contents.
const body = buildTodoBody({ summary, signature: sig, stalledForMs: 6200, reason: 'heartbeat', profileMs: 5000 });
assert.ok(body.includes('lib/usage/ledger.js:10'));
assert.ok(body.includes('hotLib'));
assert.ok(body.includes('6200 ms'));
assert.ok(body.includes(signatureMarker(sig)));

// Cooldown gate.
let t = 0;
const gate = createCooldownGate({ cooldownMs: 1000, now: () => t });
assert.equal(gate.tryEnter(), true);
t = 500;
assert.equal(gate.tryEnter(), false);
t = 1500;
assert.equal(gate.tryEnter(), true);

// Dedupe: the second identical stall creates no todo; findTodoBySignature also dedupes.
const created = [];
const notified = [];
const wd = createStallWatchdog({
  repoRoot,
  createTodo: async (todo) => created.push(todo),
  notify: (p) => notified.push(p),
  now: () => new Date('2026-10-24T10:00:00Z'),
});
const report = { type: 'stall', reason: 'heartbeat', stalledForMs: 6000, summary, profileMs: 5000 };
assert.equal((await wd.handleReport(report)).outcome, 'created');
assert.equal((await wd.handleReport(report)).outcome, 'deduped');
assert.equal(created.length, 1);
assert.equal(created[0].idempotencyKey, `stall-${sig}-2026-10-24`);
assert.ok(created[0].body.includes(signatureMarker(sig)));
assert.deepEqual(notified.map((n) => n.outcome), ['created', 'deduped']);
assert.equal(wd.getState().todosCreated, 1);
assert.equal(wd.getState().deduped, 1);

const created2 = [];
const wd2 = createStallWatchdog({
  createTodo: async (todo) => created2.push(todo),
  findTodoBySignature: async (s) => (s === sig ? { id: 'existing' } : null),
});
assert.equal((await wd2.handleReport(report)).outcome, 'deduped');
assert.equal(created2.length, 0);

class FakeWorker extends EventEmitter {
  constructor(options) {
    super();
    this.beat = new Int32Array(options.workerData.sab);
    this.messages = [];
    this.terminations = 0;
  }
  unref() {}
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminations += 1; return Promise.resolve(0); }
}

function fakeWatchdog(options = {}) {
  const workers = [];
  const watchdog = createStallWatchdog({
    heartbeatMs: 5,
    logger: { warn() {} },
    ...options,
    createWorker: (config) => {
      const worker = new FakeWorker(config);
      workers.push(worker);
      return worker;
    },
  });
  return { watchdog, workers };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await delay(5);
  }
}

await test('registries persist completed signatures and recover from corrupt files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-registry-'));
  const file = path.join(directory, 'registry.json');
  try {
    for (const make of [createMemoryRegistry, () => createFileRegistry(file)]) {
      const registry = make();
      assert.equal(registry.reserve('pending'), true);
      assert.equal(registry.has('pending'), true);
      assert.equal(registry.reserve('pending'), false);
      registry.release('pending');
      assert.equal(registry.has('pending'), false);
      registry.add('completed', { at: '2026-10-24' });
      assert.equal(registry.reserve('completed'), false);
      assert.equal(registry.size(), 1);
    }
    const reopened = createFileRegistry(file);
    assert.equal(reopened.has('completed'), true);
    reopened.reserve('transient');
    assert.equal(createFileRegistry(file).has('transient'), false);
    for (const corrupt of ['{invalid', 'null', '[]', '42', '"text"']) {
      fs.writeFileSync(file, corrupt);
      const recovered = createFileRegistry(file);
      assert.equal(recovered.size(), 0);
      recovered.add('recovered');
      assert.equal(createFileRegistry(file).has('recovered'), true);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

await test('concurrent reports reserve before lookup and creation; failures allow retry', async () => {
  let releaseLookup;
  const lookup = new Promise((resolve) => { releaseLookup = resolve; });
  let creates = 0;
  const registry = createMemoryRegistry();
  const watchdog = createStallWatchdog({
    registry,
    findTodoBySignature: () => lookup,
    createTodo: async () => { creates += 1; },
  });
  const first = watchdog.handleReport(report);
  assert.equal(registry.has(sig), true);
  assert.equal((await watchdog.handleReport(report)).outcome, 'deduped');
  releaseLookup(null);
  await first;
  assert.equal(creates, 1);

  let releaseCreate;
  const creation = new Promise((resolve) => { releaseCreate = resolve; });
  const creating = createStallWatchdog({ createTodo: () => creation });
  const pending = creating.handleReport(report);
  assert.equal((await creating.handleReport(report)).outcome, 'deduped');
  releaseCreate();
  assert.equal((await pending).outcome, 'created');

  let attempts = 0;
  const retry = createStallWatchdog({
    logger: { warn() {} },
    createTodo: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('store unavailable');
    },
  });
  assert.equal((await retry.handleReport(report)).outcome, 'failed');
  assert.equal((await retry.handleReport(report)).outcome, 'created');
  assert.equal(attempts, 2);
  assert.equal(retry.getState().errors, 1);

  let lookups = 0;
  const lookupRetry = createStallWatchdog({
    logger: { warn() {} },
    findTodoBySignature: async () => {
      if (++lookups === 1) throw new Error('lookup unavailable');
      return { id: 'existing' };
    },
  });
  assert.equal((await lookupRetry.handleReport(report)).outcome, 'failed');
  assert.equal((await lookupRetry.handleReport(report)).outcome, 'deduped');
});

await test('probe timeout, rejection and success with a responsive heartbeat', async () => {
  for (const [probe, expected] of [
    [() => new Promise(() => {}), 'probe-timeout'],
    [() => Promise.reject(new Error('offline')), 'probe-failed: offline'],
    [() => { throw new Error('sync failure'); }, 'probe-failed: sync failure'],
    [async () => {}, null],
  ]) {
    const { watchdog, workers } = fakeWatchdog({ probe, probeIntervalMs: 10, probeTimeoutMs: 15 });
    watchdog.start();
    try {
      if (expected) {
        await waitFor(() => workers[0].messages.length > 0);
        assert.equal(workers[0].messages[0].reason, expected);
        assert.ok(Atomics.load(workers[0].beat, 0) > 0);
      } else {
        await delay(60);
        assert.equal(workers[0].messages.length, 0);
      }
    } finally { watchdog.stop(); }
  }
});

await test('worker exit and error clear heartbeat/probe timers and allow restart', async () => {
  for (const event of ['exit', 'error']) {
    let probes = 0;
    const { watchdog, workers } = fakeWatchdog({
      probe: async () => { probes += 1; }, probeIntervalMs: 5,
    });
    assert.equal(watchdog.start(), true);
    assert.equal(watchdog.start(), false);
    await waitFor(() => probes > 0);
    workers[0].emit(event, event === 'exit' ? 1 : new Error('worker crashed'));
    assert.equal(watchdog.getState().running, false);
    const beats = Atomics.load(workers[0].beat, 0);
    const calls = probes;
    await delay(30);
    assert.equal(Atomics.load(workers[0].beat, 0), beats);
    assert.equal(probes, calls);
    assert.equal(watchdog.getState().errors, 1);
    assert.equal(watchdog.start(), true);
    workers[0].emit('exit', 1);
    assert.equal(watchdog.getState().running, true);
    watchdog.stop();
    watchdog.stop();
    assert.equal(workers[1].terminations, 1);
    assert.equal(watchdog.getState().running, false);
  }
});

await test('stop cancels pending probes; late completion cannot affect a restarted worker', async () => {
  let rejectOld;
  let calls = 0;
  let oldSignal;
  const { watchdog, workers } = fakeWatchdog({
    probeIntervalMs: 5, probeTimeoutMs: 40,
    probe: ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        oldSignal = signal;
        return new Promise((_, reject) => { rejectOld = reject; });
      }
      return Promise.resolve();
    },
  });
  watchdog.start();
  await waitFor(() => calls === 1);
  watchdog.stop();
  assert.equal(oldSignal.aborted, true);
  const beats = Atomics.load(workers[0].beat, 0);
  assert.equal(watchdog.start(), true);
  try {
    rejectOld(new Error('late rejection'));
    await delay(70);
    assert.equal(Atomics.load(workers[0].beat, 0), beats);
    assert.ok(calls > 1);
    assert.deepEqual(workers.map((worker) => worker.messages.length), [0, 0]);
  } finally { watchdog.stop(); }
});

await test('HTTP probe checks /login status and aborts a hung request', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/hang') return;
    res.writeHead(req.url === '/login' ? 200 : 503);
    res.end('response');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await createHttpProbe({ url: `${base}/login`, timeoutMs: 1000 })();
    await assert.rejects(createHttpProbe({ url: `${base}/failure`, timeoutMs: 1000 })(), /HTTP 503/);
    await assert.rejects(createHttpProbe({ url: `${base}/hang`, timeoutMs: 30 })(), { name: 'TimeoutError' });
    assert.deepEqual(requests, ['/login', '/failure', '/hang']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('a hung probe triggers a CPU profile and todo through the real worker', async () => {
  const todos = [];
  const notifications = [];
  const warnings = [];
  const watchdog = createStallWatchdog({
    thresholdMs: 5000, heartbeatMs: 10, checkMs: 10,
    probeIntervalMs: 10, probeTimeoutMs: 20, profileMs: 50,
    probe: () => new Promise(() => {}),
    createTodo: async (todo) => { todos.push(todo); },
    notify: (notification) => { notifications.push(notification); },
    logger: { warn: (message) => { warnings.push(message); } },
  });
  assert.equal(watchdog.start(), true);
  try {
    await waitFor(() => notifications.length > 0 || warnings.length > 0);
    assert.deepEqual(warnings, []);
    assert.equal(todos.length, 1);
    assert.match(todos[0].body, /probe-timeout/);
    assert.match(todos[0].body, /20 ms/);
    assert.equal(notifications[0].reason, 'probe-timeout');
  } finally { watchdog.stop(); }
});

// Integration: block the event loop of a real child process.
const childSource = `
import { createStallWatchdog } from ${JSON.stringify(path.join(repoRoot, 'lib/server-health/stall-watchdog.js'))};
const calls = [];
const wd = createStallWatchdog({
  thresholdMs: 300, profileMs: 400, heartbeatMs: 50, checkMs: 50, repoRoot: ${JSON.stringify(repoRoot)},
  logger: { warn: (m) => console.error(m) },
  createTodo: async (todo) => { calls.push(todo); },
});
if (!wd.start()) { console.log(JSON.stringify({ unsupported: true })); process.exit(0); }
setTimeout(() => {
  function spinHot() { const end = Date.now() + 2000; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x; }
  spinHot();
  setTimeout(() => {
    console.log(JSON.stringify({ calls, state: wd.getState() }));
    wd.stop();
    process.exit(0);
  }, 1500);
}, 200);
`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
  encoding: 'utf8',
  timeout: 20000,
});
assert.equal(child.status, 0, child.stderr);
const out = JSON.parse(child.stdout.trim().split('\n').pop());
if (out.unsupported || /connectToMainThread/.test(child.stderr)) {
  console.log('server-health-stall-watchdog: integration skipped (connectToMainThread unsupported)');
} else {
  assert.equal(out.calls.length, 1, child.stderr);
  assert.ok(out.calls[0].title.startsWith('Event-loop stall:'));
  // The hot frame may be reported as `(anonymous)` once V8 inlines the spinner, so match the eval source.
  assert.ok(/spinHot|\[eval1\]/.test(out.calls[0].body), out.calls[0].body);
  assert.match(out.calls[0].idempotencyKey, /^stall-[0-9a-f]{12}-\d{4}-\d{2}-\d{2}$/);
  assert.equal(out.state.stalls, 1);
}

console.log('server-health-stall-watchdog: ok');
