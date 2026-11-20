import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createSupervisor } from '../lib/cretli-supervisor.js';
import { readSupervisorStatus } from '../lib/autostart/supervisor-status.js';

// Simulated slow boot / blocked loop; no real data, timers or processes.
function sim(config = {}) {
  let now = 1_000_000, token = 0, ok = false;
  const children = [], spawnArgs = [], saved = [];
  const clock = { now: () => now, setTimeout: () => 1, clearTimeout() {} };
  const engine = createSupervisor({ clock, pid: 1, config: { graceMs: 1000, probeIntervalMs: 1000,
    failureLimit: 2, bootLimitMs: 60_000, blockedLimitMs: 30_000, ...config },
  spawn: (arg) => { spawnArgs.push(arg); const c = new EventEmitter(); c.pid = 50 + children.length;
    c.signals = []; c.kill = (s) => c.signals.push(s); children.push(c); return c; },
  fetch: async () => ({ ok }), progress: () => token,
  writeState: (s) => saved.push(s), finish() {} });
  const step = async (ms, { beat = false } = {}) => { now += ms; if (beat) token += 1; await engine.tick(); };
  return { engine, children, spawnArgs, saved, step, healthy: (v) => { ok = v; } };
}

test('slow boot with progress is not killed before bootLimitMs, then is', async () => {
  const s = sim(); s.engine.start();
  for (let i = 0; i < 30; i += 1) await s.step(1500, { beat: true });
  assert.deepEqual(s.children[0].signals, []); assert.equal(s.engine.snapshot().busy, 'boot');
  for (let i = 0; i < 20; i += 1) await s.step(1500, { beat: true });
  assert.deepEqual(s.children[0].signals, ['SIGTERM']);
});

test('dead process without progress is killed after failureLimit probes', async () => {
  const s = sim(); s.engine.start();
  await s.step(1500); await s.step(1500); await s.step(1500);
  assert.deepEqual(s.children[0].signals, ['SIGTERM']);
});

test('blocked loop with a beating watchdog is tolerated, then killed past blockedLimitMs', async () => {
  const s = sim(); s.engine.start(); s.healthy(true); await s.step(1500);
  s.healthy(false);
  for (let i = 0; i < 10; i += 1) await s.step(1500, { beat: true });
  assert.equal(s.engine.snapshot().busy, 'blocked'); assert.deepEqual(s.children[0].signals, []);
  for (let i = 0; i < 15; i += 1) await s.step(1500, { beat: true });
  assert.deepEqual(s.children[0].signals, ['SIGTERM']);
});

test('three health kills in the window start the next child in safe mode and stop killing', async () => {
  const s = sim({ backoffMs: 1 }); s.engine.start();
  for (let n = 0; n < 3; n += 1) {
    const child = s.children.at(-1);
    await s.step(1500); await s.step(1500); await s.step(1500);
    assert.deepEqual(child.signals, ['SIGTERM']); child.emit('close', null, 'SIGTERM');
    if (n < 2) { s.engine.signal('SIGUSR2'); }
  }
  const snap = s.engine.snapshot();
  assert.equal(snap.safeMode, true); assert.match(snap.safeModeReason, /^health_kill_loop:3$/);
  assert.equal(s.engine.snapshot().crashCount, 3);
});

test('safe mode child is spawned with safeMode and is not killed for silent HTTP', async () => {
  const s = sim({ bootLimitMs: 60_000 });
  const h = { safeMode: true, safeModeAt: new Date().toISOString(), safeModeReason: 'health_kill_loop:3' };
  const e = createSupervisor({ clock: { now: () => 1, setTimeout: () => 1, clearTimeout() {} }, history: h,
    spawn: (arg) => { s.spawnArgs.push(arg); return Object.assign(new EventEmitter(), { pid: 9, kill() {} }); },
    fetch: async () => ({ ok: false }), writeState() {}, finish() {} });
  e.start(); assert.deepEqual(s.spawnArgs.at(-1), { safeMode: true });
});

test('status exposes safe mode alert and busy state only for known values', () => {
  const fs = require_fs();
  const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/sup-status-`);
  const file = `${dir}/s.json`;
  fs.writeFileSync(file, JSON.stringify({ state: 'running', pid: 1, childPid: 2, busy: 'boot', safeMode: true,
    safeModeAt: '2026-11-04T10:00:00Z', safeModeReason: 'health_kill_loop:3' }));
  const st = readSupervisorStatus({ statePath: file, env: {}, ppid: 1 });
  assert.equal(st.safeMode, true); assert.equal(st.busy, 'boot'); assert.equal(st.safeModeReason, 'health_kill_loop:3');
  fs.writeFileSync(file, JSON.stringify({ state: 'running', busy: 'x', safeModeReason: 'free text' }));
  const bad = readSupervisorStatus({ statePath: file, env: {}, ppid: 1 });
  assert.equal(bad.busy, null); assert.equal(bad.safeModeReason, null); assert.equal(bad.safeMode, false);
  fs.rmSync(dir, { recursive: true });
});
function require_fs() { return globalThis.process.getBuiltinModule('node:fs'); }
