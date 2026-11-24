import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLifecycle, BackendStatus } from '../desktop/lib/lifecycle.js';
import { createExternalBackend, createManagedBackend } from '../desktop/lib/backend.js';
import { buildTrayMenu } from '../desktop/lib/tray.js';

/** Manual timers: tests fire them explicitly. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer: (fn) => (pending.set(++id, fn), id),
    clearTimer: (t) => pending.delete(t),
    async flush() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) await fn();
    },
    size: () => pending.size
  };
}

const settle = () => new Promise((r) => setImmediate(r));

function fakeWindow() {
  const w = new EventEmitter();
  Object.assign(w, {
    visible: true, destroyed: false, shown: 0, reloads: 0, scripts: 0,
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    isMinimized: () => false,
    hide() { w.visible = false; },
    show() { w.visible = true; w.shown += 1; },
    focus() {},
    destroy() { w.destroyed = true; },
    webContents: {
      reload() { w.reloads += 1; },
      executeJavaScript() { w.scripts += 1; return Promise.resolve(); }
    }
  });
  return w;
}

function fakeApp({ lock = true } = {}) {
  const app = new EventEmitter();
  Object.assign(app, { exits: [], quits: 0, requestSingleInstanceLock: () => lock, quit() { app.quits += 1; }, exit(c) { app.exits.push(c); } });
  return app;
}

function fakeBackend({ kind = 'external', up = true } = {}) {
  const b = { kind, up, starts: 0, stops: 0, exitCb: null };
  b.start = async () => { b.starts += 1; if (kind === 'managed') b.up = true; };
  b.stop = async () => { b.stops += 1; };
  b.check = async () => b.up;
  b.onExit = (cb) => { b.exitCb = cb; };
  return b;
}

function setup(opts = {}) {
  const timers = fakeTimers();
  const app = fakeApp(opts);
  const windows = [];
  const trayEvents = [];
  const power = new EventEmitter();
  const backend = opts.backend ?? fakeBackend(opts);
  const notes = [];
  const lc = createLifecycle({
    app, powerMonitor: power, backend,
    createWindow: () => { const w = fakeWindow(); windows.push(w); return w; },
    createTray: (cfg) => { trayEvents.push({ cfg }); return { setStatus: (s) => trayEvents.push({ s }), destroy: () => trayEvents.push({ destroyed: true }) }; },
    notify: (n) => notes.push(n),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, restartDelayMs: 0
  });
  return { lc, app, windows, trayEvents, power, backend, timers, notes };
}

test('closing the window hides it and leaves the backend running', async () => {
  const { lc, windows, backend, app } = setup();
  await lc.start();
  let prevented = false;
  windows[0].emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(windows[0].visible, false);
  assert.equal(backend.stops, 0);
  assert.deepEqual(app.exits, []);
});

test('showing again reuses the window and does not start a second backend', async () => {
  const { lc, windows, backend } = setup();
  await lc.start();
  windows[0].emit('close', { preventDefault() {} });
  lc.showWindow();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].visible, true);
  assert.equal(backend.starts, 1);
  assert.equal(windows[0].scripts, 1, 'show nudges the client to refresh');
});

test('a destroyed window is recreated on show', async () => {
  const { lc, windows } = setup();
  await lc.start();
  windows[0].destroyed = true;
  lc.showWindow();
  assert.equal(windows.length, 2);
});

test('second instance focuses the first and never starts a backend', async () => {
  const s = setup({ lock: false });
  assert.equal(await s.lc.start(), false);
  assert.equal(s.backend.starts, 0);
  assert.equal(s.app.quits, 1);
  const s2 = setup();
  await s2.lc.start();
  s2.windows[0].hide();
  s2.app.emit('second-instance');
  assert.equal(s2.windows[0].visible, true);
});

test('Quit with an external backend never stops it, and exits once', async () => {
  const { lc, backend, app, trayEvents, windows } = setup();
  await lc.start();
  await Promise.all([lc.quit(), lc.quit()]);
  assert.equal(backend.stops, 1); // adapter.stop() is called but external stop is a no-op
  assert.deepEqual(app.exits, [0]);
  assert.ok(trayEvents.some((e) => e.destroyed));
  assert.equal(windows[0].destroyed, true);
});

test('window close during quit is not intercepted', async () => {
  const { lc, windows } = setup();
  await lc.start();
  const q = lc.quit();
  let prevented = false;
  windows[0].emit('close', { preventDefault: () => { prevented = true; } });
  await q;
  assert.equal(prevented, false);
});

test('before-quit is routed through the controlled stop', async () => {
  const { lc, app, backend } = setup();
  await lc.start();
  let prevented = false;
  app.emit('before-quit', { preventDefault: () => { prevented = true; } });
  await lc.quit();
  assert.equal(prevented, true);
  assert.equal(backend.stops, 1);
  assert.deepEqual(app.exits, [0]);
});

test('external backend going down and back up reloads a visible window', async () => {
  const { lc, windows, backend } = setup();
  await lc.start();
  backend.up = false;
  await lc.checkHealth();
  assert.equal(lc.getStatus(), BackendStatus.DOWN);
  backend.up = true;
  await lc.checkHealth();
  assert.equal(lc.getStatus(), BackendStatus.UP);
  assert.equal(windows[0].reloads, 1);
});

test('hidden window reloads on next show after recovery', async () => {
  const { lc, windows, backend } = setup();
  await lc.start();
  windows[0].emit('close', { preventDefault() {} });
  backend.up = false; await lc.checkHealth();
  backend.up = true; await lc.checkHealth();
  assert.equal(windows[0].reloads, 0);
  lc.showWindow();
  assert.equal(windows[0].reloads, 1);
});

test('managed backend crash restarts it and recovers', async () => {
  const backend = fakeBackend({ kind: 'managed' });
  const { lc, notes } = setup({ backend });
  await lc.start();
  backend.up = false;
  backend.exitCb({ code: 1, signal: null });
  await settle();
  assert.equal(backend.starts, 2);
  assert.equal(lc.getStatus(), BackendStatus.UP);
  assert.equal(notes.length, 0);
});

test('managed backend that keeps crashing ends DOWN after maxRestarts', async () => {
  const backend = fakeBackend({ kind: 'managed' });
  backend.start = async () => { backend.starts += 1; backend.up = false; };
  const { lc, notes } = setup({ backend });
  await lc.start();
  for (let i = 0; i < 5; i += 1) { backend.exitCb({ code: 1 }); await settle(); }
  assert.equal(lc.getStatus(), BackendStatus.DOWN);
  assert.equal(backend.starts, 1 + 3);
  assert.ok(notes.some((n) => n.type === 'backend-down'));
});

test('backend start failure keeps the app alive in DOWN state', async () => {
  const backend = fakeBackend();
  backend.start = async () => { throw new Error('boom'); };
  const { lc, windows } = setup({ backend });
  await lc.start();
  assert.equal(lc.getStatus(), BackendStatus.DOWN);
  assert.equal(windows.length, 1);
});

test('resume re-checks the backend and reloads the visible window', async () => {
  const { lc, power, windows, timers } = setup();
  await lc.start();
  power.emit('suspend');
  power.emit('resume');
  await timers.flush(); // resume timer (and health tick)
  assert.ok(windows[0].reloads >= 1);
});

test('health polling stops after quit', async () => {
  const { lc, timers } = setup();
  await lc.start();
  assert.equal(timers.size(), 1);
  await lc.quit();
  assert.equal(timers.size(), 0);
});

test('managed adapter: start is idempotent, stop terminates only its child', async () => {
  const spawned = [];
  const spawn = () => {
    const p = new EventEmitter();
    p.signals = [];
    p.kill = (sig) => { p.signals.push(sig); if (sig === 'SIGTERM') setImmediate(() => p.emit('exit', 0, null)); };
    spawned.push(p);
    return p;
  };
  const b = createManagedBackend({ spawn, command: 'node', killTree: (p, { force }) => p.kill(force ? 'SIGKILL' : 'SIGTERM') });
  b.start(); b.start();
  assert.equal(spawned.length, 1);
  assert.equal(b.owned, true);
  const exits = [];
  b.onExit((e) => exits.push(e));
  await b.stop();
  assert.deepEqual(spawned[0].signals, ['SIGTERM', 'SIGKILL']); // graceful, then final tree sweep
  assert.equal(b.owned, false);
  assert.deepEqual(exits, [], 'controlled stop is not reported as a crash');
});

test('managed adapter reports unexpected exits and escalates to SIGKILL', async () => {
  let proc;
  const spawn = () => { proc = new EventEmitter(); proc.signals = []; proc.kill = (s) => proc.signals.push(s); return proc; };
  const timers = fakeTimers();
  const b = createManagedBackend({ spawn, command: 'x', killTree: (p, { force }) => p.kill(force ? 'SIGKILL' : 'SIGTERM'), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  b.start();
  const exits = [];
  b.onExit((e) => exits.push(e));
  proc.emit('exit', 9, null);
  assert.deepEqual(exits, [{ code: 9, signal: null }]);
  b.start();
  const stopped = b.stop();
  await settle();
  await timers.flush(); // kill timeout fires
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  proc.emit('exit', null, 'SIGKILL');
  await stopped;
});

test('external adapter stop is a no-op and check maps fetch outcome', async () => {
  const ok = createExternalBackend({ url: 'http://127.0.0.1:3011', fetchImpl: async () => ({ status: 401 }) });
  const bad = createExternalBackend({ url: 'http://127.0.0.1:3011', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(ok.owned, false);
  assert.equal(await ok.check(), true);
  assert.equal(await bad.check(), false);
  await ok.stop();
});

test('tray menu offers Show window and explicit Quit', () => {
  const calls = [];
  const menu = buildTrayMenu({ onShow: () => calls.push('show'), onQuit: () => calls.push('quit'), status: 'down' });
  const clickable = menu.filter((i) => i.click);
  assert.deepEqual(clickable.map((i) => i.label), ['Show window', 'Quit']);
  clickable.forEach((i) => i.click());
  assert.deepEqual(calls, ['show', 'quit']);
  assert.match(menu[1].label, /not responding/);
});

test('managed stop kills the tree: graceful, forced escalation, final sweep', async () => {
  let proc;
  const spawn = () => { proc = new EventEmitter(); proc.pid = 42; return proc; };
  const calls = [];
  const timers = fakeTimers();
  const b = createManagedBackend({ spawn, command: 'x', killTree: (p, o) => calls.push([p.pid, o.force]), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  b.start();
  const stopped = b.stop();
  assert.deepEqual(calls, [[42, false]]);
  await settle();
  await timers.flush(); // graceful timeout -> forced tree kill
  await settle();
  assert.deepEqual(calls, [[42, false], [42, true]]);
  proc.emit('exit', null, 'SIGKILL');
  await stopped;
  assert.equal(calls.at(-1)[1], true, 'descendants swept after leader exit');
  assert.equal(b.owned, false);
});

test('managed stop resolves after the forced kill never produces an exit', async () => {
  const spawn = () => Object.assign(new EventEmitter(), { pid: 7 });
  const timers = fakeTimers();
  const b = createManagedBackend({ spawn, command: 'x', killTree() {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  b.start();
  const stopped = b.stop();
  await settle();
  await timers.flush(); // escalate
  await settle();
  await timers.flush(); // final give-up timer
  await stopped;
  assert.equal(b.owned, false);
});

test('managed stop resolves on a spawn error without exit', async () => {
  let proc;
  const spawn = () => { proc = Object.assign(new EventEmitter(), { pid: 1 }); return proc; };
  const exits = [];
  const b = createManagedBackend({ spawn, command: 'nope', killTree() {} });
  b.onExit((e) => exits.push(e));
  b.start();
  const stopped = b.stop();
  proc.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
  await stopped;
  assert.equal(b.owned, false);
  assert.deepEqual(exits, []);
});

test('managed stop resolves when killTree throws', async () => {
  const spawn = () => Object.assign(new EventEmitter(), { pid: 1 });
  const b = createManagedBackend({ spawn, command: 'x', killTree() { throw new Error('EPERM'); } });
  b.start();
  await b.stop();
  assert.equal(b.owned, false);
});

test('repeated before-quit events are all prevented while stop() is pending', async () => {
  const backend = fakeBackend();
  let release;
  backend.stop = () => new Promise((r) => { release = r; });
  const { lc, app } = setup({ backend });
  await lc.start();
  const flags = [];
  for (let i = 0; i < 2; i += 1) app.emit('before-quit', { preventDefault: () => flags.push(true) });
  assert.deepEqual(flags, [true, true]);
  assert.deepEqual(app.exits, []);
  release();
  await lc.quit();
  assert.deepEqual(app.exits, [0]);
});

// Windows: taskkill is spawned through an injected function; proc.kill() must never run first.
function winSetup({ killerBehavior = 'exit' } = {}) {
  let proc;
  const spawn = () => { proc = Object.assign(new EventEmitter(), { pid: 99, killed: 0, kill() { this.killed += 1; } }); return proc; };
  const taskkills = [];
  const spawnTaskkill = (cmd, args) => {
    const k = new EventEmitter();
    taskkills.push({ cmd, args, k });
    if (killerBehavior === 'error') setImmediate(() => k.emit('error', new Error('ENOENT')));
    return k;
  };
  const timers = fakeTimers();
  const b = createManagedBackend({ spawn, command: 'x', platform: 'win32', spawnTaskkill, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { b, taskkills, timers, getProc: () => proc };
}

test('win32 stop: graceful taskkill /T first, no proc.kill, then /T /F after the grace timeout', async () => {
  const { b, taskkills, timers, getProc } = winSetup();
  b.start();
  const stopped = b.stop();
  await settle();
  assert.equal(taskkills.length, 1);
  assert.deepEqual([taskkills[0].cmd, taskkills[0].args], ['taskkill', ['/pid', '99', '/T']]);
  assert.equal(getProc().killed, 0);
  taskkills[0].k.emit('exit', 0); // graceful taskkill completed, parent still alive
  await settle();
  assert.equal(taskkills.length, 1, 'forced kill waits for the grace timeout');
  await timers.flush(); // grace timeout (kill helper timers were cleared)
  await settle();
  assert.equal(taskkills.length, 2);
  assert.deepEqual(taskkills[1].args, ['/pid', '99', '/T', '/F']);
  assert.equal(getProc().killed, 0);
  getProc().emit('exit', 1, null);
  taskkills[1].k.emit('exit', 0);
  await stopped;
  assert.equal(b.owned, false);
});

test('win32 stop awaits taskkill completion before resolving', async () => {
  const { b, taskkills, getProc } = winSetup();
  b.start();
  let resolved = false;
  const stopped = b.stop().then(() => { resolved = true; });
  await settle();
  getProc().emit('exit', 1, null); // parent gone, but taskkill still running
  await settle();
  assert.equal(resolved, false);
  taskkills[0].k.emit('exit', 0);
  await stopped;
  assert.equal(resolved, true);
});

test('win32 stop still resolves when taskkill errors', async () => {
  const { b, taskkills, timers } = winSetup({ killerBehavior: 'error' });
  b.start();
  const stopped = b.stop();
  for (let i = 0; i < 4; i += 1) { await settle(); await timers.flush(); } // grace, forced attempt, final wait
  await stopped;
  assert.equal(b.owned, false);
  assert.ok(taskkills.length >= 1);
});
