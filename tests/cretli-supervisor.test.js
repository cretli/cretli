import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createSupervisor, supervisorConfig, SUPERVISOR_DEFAULTS, loadSupervisorEnv,
  requestRestart, requestStop, acquireSupervisorLock, atomicSupervisorState, supervisorLogTail,
  probeSupervisorHealth, processAlive, processCommand, SUPERVISOR_RECLAIM_STALE_MS } from '../lib/cretli-supervisor.js';

function harness(config = {}, history = {}) {
  let now = 1_000_000, sequence = 0, ok = true;
  const timers = new Map(), children = [], snapshots = [], exits = [];
  const clock = { now: () => now,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id) };
  const engine = createSupervisor({ config, history, clock, pid: 123,
    spawn: () => { const child = new EventEmitter(); child.pid = children.length + 100;
      child.signals = []; child.kill = (signal) => child.signals.push(signal); children.push(child); return child; },
    fetch: async () => { if (ok instanceof Error) throw ok; return { ok }; },
    tail: () => 'safe tail', writeState: (s) => snapshots.push(s), finish: (code) => exits.push(code) });
  const advance = (ms) => {
    const end = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = end;
  };
  return { engine, children, exits, snapshots, advance, sleep: (ms) => { now += ms; },
    fail: () => { ok = false; }, healthy: () => { ok = true; }, reject: () => { ok = new Error('timeout'); },
    close: (code = 0, signal = null) => children.at(-1).emit('close', code, signal) };
}

test('all unrequested exits, including zero and wrapper errors, count and back off', () => {
  for (const [code, signal] of [[0, null], [1, null], [null, 'SIGKILL'], [null, 'SIGTERM']]) {
    const h = harness(); h.engine.start(); h.close(code, signal);
    assert.equal(h.engine.snapshot().state, 'backoff'); assert.equal(h.engine.snapshot().crashCount, 1);
    h.advance(999); assert.equal(h.children.length, 1); h.advance(1); assert.equal(h.children.length, 2);
  }
  const h = harness(); h.engine.start(); h.children[0].emit('error', new Error('spawn'));
  h.close(1); assert.equal(h.engine.snapshot().crashCount, 1);
});

test('stop/SIGINT, requested restart, duplicate request and escalation', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGUSR2']) {
    const h = harness(); h.engine.start(); h.engine.signal(signal); h.engine.signal('SIGUSR2');
    assert.deepEqual(h.children[0].signals, ['SIGTERM']);
    h.advance(39_999); assert.deepEqual(h.children[0].signals, ['SIGTERM']);
    h.advance(1); assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']);
    h.close(null, 'SIGKILL');
    assert.equal(h.engine.snapshot().crashCount, 0);
    assert.equal(h.children.length, signal === 'SIGUSR2' ? 2 : 1);
    assert.deepEqual(h.exits, signal === 'SIGUSR2' ? [] : [0]);
  }
  const h = harness(); h.engine.start(); h.engine.signal('SIGUSR2'); h.engine.signal('SIGTERM'); h.close();
  assert.deepEqual(h.exits, [0]); assert.equal(h.children.length, 1);
});

test('SIGTERM during backoff stops immediately and cancels retry', () => {
  const h = harness(); h.engine.start(); h.close(); h.engine.signal('SIGTERM'); h.advance(100_000);
  assert.deepEqual(h.exits, [0]); assert.equal(h.children.length, 1);
});

test('backoff doubles, caps, and resets after stable runtime', () => {
  const h = harness({ crashLimit: 100 }); h.engine.start();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    h.close(); const count = h.children.length; h.advance(delay - 1); assert.equal(h.children.length, count);
    h.advance(1); assert.equal(h.children.length, count + 1);
  }
  h.advance(300_000); h.close(); const count = h.children.length; h.advance(1000); assert.equal(h.children.length, count + 1);
});

test('fifth crash idles, retains history, SIGUSR2 resets count, stop exits', () => {
  const h = harness(); h.engine.start();
  for (let n = 0; n < 5; n++) { h.close(); if (n < 4) h.advance(1000 * 2 ** n); }
  const state = h.engine.snapshot(); assert.equal(state.state, 'crash_loop'); assert.equal(state.crashCount, 5);
  assert.ok(state.crashLoopAt); assert.equal(state.logTail, 'safe tail');
  h.advance(1_000_000); assert.equal(h.children.length, 5);
  h.engine.signal('SIGUSR2'); assert.equal(h.children.length, 6); assert.equal(h.engine.snapshot().crashCount, 0);
  assert.equal(h.engine.snapshot().crashLoopAt, state.crashLoopAt);
  const reboot = harness({}, state); reboot.engine.start(); assert.equal(reboot.engine.snapshot().crashCount, 0);
  assert.equal(reboot.engine.snapshot().crashLoopAt, state.crashLoopAt);
  const stopped = harness({ crashLimit: 1 }); stopped.engine.start(); stopped.close(); stopped.engine.signal('SIGTERM');
  assert.deepEqual(stopped.exits, [0]);
});

test('crash window excludes old events', () => {
  const h = harness(); h.engine.start(); h.close(); h.advance(601_000); h.close();
  assert.equal(h.engine.snapshot().crashCount, 1);
});

test('probe grace, consecutive failures, success reset, sleep reset, hang timeout', async () => {
  const h = harness(); h.fail(); h.engine.start();
  const tick = async (ms = 15_000) => { h.advance(ms); await h.engine.tick(); };
  for (let n = 0; n < 7; n++) await tick();
  assert.deepEqual(h.children[0].signals, []);
  await tick(); await tick(); h.healthy(); await tick(); h.fail(); await tick(); await tick();
  h.sleep(31_000); await h.engine.tick();
  await tick(); await tick(); assert.deepEqual(h.children[0].signals, []);
  h.reject(); await tick(); assert.deepEqual(h.children[0].signals, ['SIGTERM']);
  h.advance(9999); assert.equal(h.children[0].signals.length, 1); h.advance(1);
  assert.deepEqual(h.children[0].signals, ['SIGTERM', 'SIGKILL']); h.close(null, 'SIGKILL');
  assert.equal(h.engine.snapshot().lastCrash.reason, 'health_probe_failed');
  assert.equal(h.engine.snapshot().crashCount, 1); h.advance(1000); assert.equal(h.children.length, 2);
});

test('hang loop can be retried; stale probe cannot terminate replacement', async () => {
  const h = harness({ graceMs: 1, failureLimit: 1, crashLimit: 1 }); h.engine.start(); h.fail();
  h.advance(15_000); await h.engine.tick(); h.close();
  assert.equal(h.engine.snapshot().state, 'crash_loop'); h.engine.signal('SIGUSR2'); assert.equal(h.children.length, 2);
  let resolveProbe; let child; const clock = { now: () => 100, setTimeout: () => 1, clearTimeout() {} };
  const e = createSupervisor({ clock, config: { graceMs: 1 }, fetch: () => new Promise((r) => { resolveProbe = r; }),
    spawn: () => { child = new EventEmitter(); child.pid = 1; child.kill = () => {}; return child; }, writeState() {}, finish() {} });
  e.start(); clock.now = () => 200; const probe = e.tick(); e.signal('SIGUSR2'); child.emit('close', 0);
  resolveProbe({ ok: false }); await probe; assert.equal(e.snapshot().state, 'running');
});

test('configuration, restricted dotenv precedence, SDK env, state and redacted bounded tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-unit-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3100\nUSE_HTTPS=0\nCRETLI_DATA_DIR=custom\nNODE_ENV=production\nSECRET=do-not-load\n');
    fs.writeFileSync(path.join(dir, '.cretli-sdk.env'), 'CURSOR_API_KEY=sdk-secret\nOTHER=value\n');
    const env = loadSupervisorEnv(dir, {});
    assert.equal(env.PORT, '3100'); assert.equal(env.USE_HTTPS, '0'); assert.equal(env.CRETLI_DATA_DIR, 'custom');
    assert.equal(env.NODE_ENV, undefined); assert.equal(env.SECRET, undefined); assert.equal(env.CURSOR_API_KEY, 'sdk-secret');
    assert.equal(loadSupervisorEnv(dir, { PORT: '3200', CURSOR_API_KEY: 'process' }).PORT, '3200');
    assert.equal(loadSupervisorEnv(dir, { CURSOR_API_KEY: 'process' }).CURSOR_API_KEY, 'process');
    for (const [key, fallback] of Object.entries(SUPERVISOR_DEFAULTS)) {
      const name = `CRETLI_SUPERVISOR_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
      assert.equal(supervisorConfig({ [name]: '7' })[key], 7);
      assert.equal(supervisorConfig({ [name]: '-1' })[key], fallback);
    }
    const file = path.join(dir, 'state.json'); atomicSupervisorState(file, { state: 'running' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { state: 'running' });
    assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
    const log = path.join(dir, 'log'); fs.writeFileSync(log, 'x'.repeat(12_000) + '\nsdk-secret\ntoken=private-token');
    fs.appendFileSync(log, '\nabc');
    const tail = supervisorLogTail(log, { ...env, SECRET: 'abc' });
    assert.ok(!tail.includes('abc')); assert.ok(tail.length <= 4096); assert.ok(!tail.includes('sdk-secret'));
    assert.equal(supervisorLogTail(path.join(dir, 'missing')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exclusive lock, dead owner recovery and request-restart codes without unsafe signals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-lock-')); const lock = path.join(dir, 'supervisor.lock');
  try {
    assert.equal(requestRestart(lock), 3);
    const release = acquireSupervisorLock(lock, 42);
    assert.throws(() => acquireSupervisorLock(lock, 43, () => true, () => 'node cretli-supervisor.mjs'), /owned/);
    assert.equal(fs.readFileSync(lock, 'utf8'), '42'); release();
    fs.writeFileSync(lock, '999999999'); const recovered = acquireSupervisorLock(lock); recovered();
    let signals = 0;
    const deps = { read: () => '42', alive: () => true, command: () => 'node cretli-supervisor.mjs', kill: () => { signals++; } };
    assert.equal(requestRestart(lock, deps), 0); assert.equal(signals, 1);
    assert.equal(requestRestart(lock, { ...deps, alive: () => false }), 3);
    assert.equal(requestRestart(lock, { ...deps, command: () => 'other-app' }), 3); assert.equal(signals, 1);
    assert.equal(requestRestart(lock, { ...deps, read: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }), 4);
    assert.equal(requestRestart(lock, { ...deps, read: () => 'invalid' }), 4);
    assert.equal(requestRestart(lock, { ...deps, command: () => { throw new Error(); } }), 4);
    assert.equal(requestRestart(lock, { ...deps, kill: () => { throw new Error(); } }), 4);
    // requestStop shares the validation and exit codes but delivers SIGTERM.
    const sent = [];
    const stopDeps = { ...deps, kill: (pid, signal) => { sent.push([pid, signal]); } };
    assert.equal(requestStop(lock, stopDeps), 0); assert.deepEqual(sent, [[42, 'SIGTERM']]);
    assert.equal(requestRestart(lock, stopDeps), 0); assert.deepEqual(sent.at(-1), [42, 'SIGUSR2']);
    sent.length = 0;
    assert.equal(requestStop(lock, { ...stopDeps, alive: () => false }), 3);
    assert.equal(requestStop(lock, { ...stopDeps, command: () => 'other-app' }), 3); assert.deepEqual(sent, []);
    assert.equal(requestStop(lock, { ...stopDeps, read: () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }), 4);
    assert.equal(requestStop(lock, { ...stopDeps, read: () => 'invalid' }), 4);
    assert.equal(requestStop(lock, { ...stopDeps, command: () => { throw new Error(); } }), 4);
    assert.equal(requestStop(lock, { ...stopDeps, kill: () => { throw new Error(); } }), 4);
    assert.equal(requestStop(path.join(dir, 'missing.lock')), 3); assert.deepEqual(sent, []);
    assert.equal(processAlive(-1), false); assert.equal(processAlive(42, () => { throw { code: 'ESRCH' }; }), false);
    assert.equal(processAlive(42, () => { throw { code: 'EPERM' }; }), true);
    assert.ok(processCommand(process.pid).includes('node'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loopback probe checks status and times out a hanging HTTP response', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/health'); if (mode === 'hang') return;
    res.writeHead(mode === 'ok' ? 200 : 503); res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const options = { port: server.address().port, useHttps: false, timeoutMs: 30 };
  try {
    assert.equal((await probeSupervisorHealth(options)).ok, true); mode = 'error';
    assert.equal((await probeSupervisorHealth(options)).ok, false); mode = 'hang';
    assert.equal((await probeSupervisorHealth(options)).ok, false);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});


test('self-signed TLS is accepted by the loopback probe without changing HTTPS defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-tls-'));
  let server;
  try {
    const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', timeout: 5000 });
    assert.equal(generated.status, 0);
    let redirect = false;
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
      res.writeHead(redirect ? 302 : 200, redirect ? { Location: 'https://example.invalid/' } : {}); res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    assert.equal((await probeSupervisorHealth({ port, useHttps: true, timeoutMs: 1000 })).ok, true);
    redirect = true;
    assert.equal((await probeSupervisorHealth({ port, useHttps: true, timeoutMs: 1000 })).ok, false);
    const rejected = await new Promise((resolve) => {
      const req = https.get({ hostname: '127.0.0.1', port, agent: false }, () => resolve(false));
      req.on('error', () => resolve(true));
    });
    assert.equal(rejected, true);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop and sleep abort outstanding probes, ignoring their late results', async () => {
  for (const action of ['stop', 'sleep']) {
    let now = 0, child, probeSignal, resolveProbe;
    const e = createSupervisor({ config: { graceMs: 1, failureLimit: 1 },
      clock: { now: () => now, setTimeout: () => 1, clearTimeout() {} },
      fetch: ({ signal }) => { probeSignal = signal; return new Promise((r) => { resolveProbe = r; }); },
      spawn: () => { child = new EventEmitter(); child.pid = 1; child.kill = () => {}; return child; },
      writeState() {}, finish() {} });
    e.start(); now = 15_000; const pending = e.tick();
    if (action === 'stop') e.signal('SIGTERM');
    else { now += 31_000; await e.tick(); }
    assert.equal(probeSignal.aborted, true); resolveProbe({ ok: false }); await pending;
    assert.equal(e.snapshot().state, action === 'stop' ? 'stopping' : 'running');
  }
});

test('synchronous spawn failure is a counted crash', () => {
  let state;
  const e = createSupervisor({ clock: { now: () => 1, setTimeout: () => 1, clearTimeout() {} },
    spawn: () => { throw new Error('wrapper unavailable'); }, fetch: async () => ({ ok: true }),
    writeState: (s) => { state = s; }, finish() {} });
  e.start(); assert.equal(state.state, 'backoff'); assert.equal(state.crashCount, 1);
  assert.equal(state.lastCrash.reason, 'child_exit:spawn_error');
});


test('stable runtime resets backoff even when it ends with a planned restart', () => {
  const h = harness(); h.engine.start(); h.close(); h.advance(1000);
  h.advance(300_000); h.engine.signal('SIGUSR2'); h.close();
  h.close(); const count = h.children.length; h.advance(1000);
  assert.equal(h.children.length, count + 1);
});


test('lock reclaims foreign and own PIDs but rejects live supervisors and unreadable commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-owner-'));
  const lock = path.join(dir, 'supervisor.lock');
  try {
    fs.writeFileSync(lock, '42');
    const foreign = acquireSupervisorLock(lock, 43, () => true, () => 'node other-app.mjs');
    assert.equal(fs.readFileSync(lock, 'utf8'), '43'); foreign();
    fs.writeFileSync(lock, '43');
    const own = acquireSupervisorLock(lock, 43, () => true, () => { throw new Error('must not inspect our command'); });
    assert.equal(fs.readFileSync(lock, 'utf8'), '43'); own();
    fs.writeFileSync(lock, '42');
    assert.throws(() => acquireSupervisorLock(lock, 43, () => true, () => 'node cretli-supervisor.mjs'), /owned/);
    assert.equal(fs.readFileSync(lock, 'utf8'), '42');
    assert.throws(() => acquireSupervisorLock(lock, 43, () => true, () => { throw new Error('command unreadable'); }), /command unreadable/);
    assert.equal(fs.readFileSync(lock, 'utf8'), '42');
    assert.equal(fs.existsSync(`${lock}.reclaim`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('old reclaim guard expires while a recent guard stays exclusive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-reclaim-'));
  const lock = path.join(dir, 'supervisor.lock'), guard = `${lock}.reclaim`;
  try {
    fs.writeFileSync(lock, '42'); fs.writeFileSync(guard, '');
    assert.throws(() => acquireSupervisorLock(lock, 43, () => false), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(lock, 'utf8'), '42');
    const old = new Date(Date.now() - SUPERVISOR_RECLAIM_STALE_MS - 1000);
    fs.utimesSync(guard, old, old);
    const release = acquireSupervisorLock(lock, 43, () => false);
    assert.equal(fs.readFileSync(lock, 'utf8'), '43'); assert.equal(fs.existsSync(guard), false); release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing lock does not make release throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-release-'));
  const lock = path.join(dir, 'supervisor.lock');
  try {
    const release = acquireSupervisorLock(lock); fs.unlinkSync(lock);
    assert.doesNotThrow(release); assert.doesNotThrow(release);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-object history is ignored', () => {
  for (const history of [null, false, 42, 'invalid', []]) {
    const h = harness({}, history); h.engine.start();
    assert.equal(h.engine.snapshot().lastCrash, null);
    assert.equal(h.engine.snapshot().crashLoopAt, null);
    assert.equal(h.engine.snapshot().state, 'running');
  }
});

test('state persistence errors log and preserve event, timer and shutdown supervision', () => {
  const originalError = console.error, errors = [], children = [], finished = [];
  let retry, writes = 0;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const e = createSupervisor({ clock: { now: () => 1, setTimeout: (fn) => { retry = fn; return 1; }, clearTimeout() {} },
      spawn: () => { const child = new EventEmitter(); child.pid = children.length + 100;
        child.kill = () => {}; children.push(child); return child; }, fetch: async () => ({ ok: true }),
      writeState: () => { writes++; throw Object.assign(new Error('private detail'), { code: 'ENOSPC' }); },
      finish: (code) => finished.push(code) });
    assert.doesNotThrow(() => e.start());
    assert.doesNotThrow(() => children[0].emit('close', 1));
    assert.equal(e.snapshot().state, 'backoff'); assert.equal(e.snapshot().crashCount, 1);
    assert.doesNotThrow(() => retry()); assert.equal(children.length, 2);
    assert.doesNotThrow(() => e.signal('SIGTERM'));
    assert.doesNotThrow(() => children[1].emit('close', 0));
    assert.deepEqual(finished, [0]); assert.equal(e.snapshot().state, 'stopped');
    assert.equal(errors.length, writes); assert.ok(errors.every((line) => line.includes('State write failed: ENOSPC')));
    assert.ok(errors.every((line) => !line.includes('private detail')));
  } finally { console.error = originalError; }
});


test('R1A1-F1: old incomplete locks recover; fresh locks, live owners and I/O errors stay protected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-incomplete-'));
  const lock = path.join(dir, 'supervisor.lock');
  const ageLock = () => {
    const old = new Date(Date.now() - SUPERVISOR_RECLAIM_STALE_MS - 1000);
    fs.utimesSync(lock, old, old);
  };
  try {
    for (const content of ['', 'truncated-pid']) {
      fs.writeFileSync(lock, content); ageLock();
      assert.equal(requestRestart(lock), 4);
      const release = acquireSupervisorLock(lock, 43, () => { throw new Error('must not probe invalid PID'); });
      assert.equal(fs.readFileSync(lock, 'utf8'), '43'); release();
    }
    for (const content of ['', 'truncated-pid']) {
      fs.writeFileSync(lock, content);
      assert.throws(() => acquireSupervisorLock(lock, 43), /owned or unreadable/);
      assert.equal(fs.readFileSync(lock, 'utf8'), content);
      assert.equal(requestRestart(lock), 4);
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, '42'); ageLock();
    assert.throws(() => acquireSupervisorLock(lock, 43, () => true, () => 'node cretli-supervisor.mjs'), /owned/);
    assert.equal(fs.readFileSync(lock, 'utf8'), '42'); fs.unlinkSync(lock);
    fs.mkdirSync(lock); ageLock();
    assert.throws(() => acquireSupervisorLock(lock, 43), { code: 'EISDIR' });
    assert.ok(fs.statSync(lock).isDirectory());
    assert.equal(fs.existsSync(`${lock}.reclaim`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
