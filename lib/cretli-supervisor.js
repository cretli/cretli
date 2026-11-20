import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { redactText } from './browser/redaction.js';

// Knobs use CRETLI_SUPERVISOR_<UPPER_SNAKE_CASE>, e.g. PROBE_INTERVAL_MS.
// Every timing knob uses milliseconds except the two event-count limits.
/** @typedef {{ probeIntervalMs: number, probeTimeoutMs: number, graceMs: number,
 * failureLimit: number, stopTimeoutMs: number, hangStopTimeoutMs: number,
 * backoffMs: number, maxBackoffMs: number, stableMs: number, crashLimit: number,
 * crashWindowMs: number, bootLimitMs: number, blockedLimitMs: number,
 * killLoopLimit: number, killLoopWindowMs: number }} SupervisorConfig */
/** @typedef {{ lastCrash?: { at: string, reason: string }, crashLoopAt?: string,
 * crashLoopReason?: string, logTail?: string, safeMode?: boolean, safeModeAt?: string,
 * safeModeReason?: string, enabled?: boolean }} SupervisorHistory */
/** @type {Readonly<SupervisorConfig>} */
export const SUPERVISOR_DEFAULTS = Object.freeze({
  probeIntervalMs: 15_000, probeTimeoutMs: 10_000, graceMs: 120_000,
  failureLimit: 3, stopTimeoutMs: 40_000, hangStopTimeoutMs: 10_000,
  backoffMs: 1_000, maxBackoffMs: 60_000, stableMs: 300_000,
  crashLimit: 5, crashWindowMs: 600_000,
  // Boot with visible progress may outlive graceMs up to bootLimitMs; a blocked loop whose
  // watchdog worker still beats is tolerated for blockedLimitMs since the last good probe.
  bootLimitMs: 1_200_000, blockedLimitMs: 600_000,
  // This many health kills inside the window switch the next start to safe mode.
  killLoopLimit: 3, killLoopWindowMs: 900_000,
});

export function supervisorConfig(env = {}) {
  return /** @type {SupervisorConfig} */ (Object.fromEntries(Object.entries(SUPERVISOR_DEFAULTS).map(([key, fallback]) => {
    const name = `CRETLI_SUPERVISOR_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const value = Number(env[name]);
    return [key, Number.isSafeInteger(value) && value > 0 ? value : fallback];
  })));
}

export function loadSupervisorEnv(root, env) {
  const read = (name) => {
    try { return parseEnv(fs.readFileSync(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  const dotenv = read('.env');
  const result = { ...read('.cretli-sdk.env'), ...env };
  // The supervisor only needs routing and storage settings from .env.
  for (const key of ['PORT', 'USE_HTTPS', 'CRETLI_DATA_DIR']) {
    if (result[key] === undefined && dotenv[key] !== undefined) result[key] = dotenv[key];
  }
  return result;
}

/** Pure transition ownership; all effects and time come from the caller. */
export function createSupervisor({ spawn, fetch, clock, writeState, finish, tail = () => '', progress = () => null,
  pid = process.pid, config = SUPERVISOR_DEFAULTS, history = /** @type {SupervisorHistory} */ ({}) }) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) history = {};
  const cfg = { ...SUPERVISOR_DEFAULTS, ...config };
  let child = null, generation = 0, startedAt = 0, lastTick = 0, failures = 0;
  let probeController = null;
  let intent = null, stopTimer = null, retryTimer = null, pending = false;
  let events = [], backoff = cfg.backoffMs;
  let kills = [], everHealthy = false, lastGood = 0, lastProgress = null;
  const state = { state: 'starting', pid, childPid: null, crashCount: 0,
    controlVersion: 1, startedAt: new Date(clock.now()).toISOString(), enabled: history.enabled !== false,
    lastCrash: history.lastCrash || null, crashLoopAt: history.crashLoopAt || null,
    crashLoopReason: history.crashLoopReason || null, logTail: history.logTail || '',
    // `busy` is "boot" or "blocked" while the child makes progress but HTTP does not answer.
    busy: null, safeMode: history.safeMode === true, safeModeAt: history.safeModeAt || null,
    safeModeReason: history.safeModeReason || null };
  const save = () => {
    try { writeState({ ...state }); }
    catch (error) {
      // Persistence is diagnostic: a full disk must not orphan the child.
      console.error('[cretli-supervisor] State write failed:', error?.code || 'unknown error');
    }
  };
  const safeProgress = () => { try { return progress(); } catch { return null; } };
  const clear = () => {
    clock.clearTimeout(stopTimer); clock.clearTimeout(retryTimer);
    stopTimer = retryTimer = null;
  };
  function done() { clear(); state.state = 'stopped'; state.childPid = null; save(); finish(0); }
  function start() {
    clear(); intent = null; failures = 0; pending = false; lastTick = startedAt = lastGood = clock.now();
    everHealthy = false; state.busy = null; lastProgress = safeProgress();
    state.state = 'running';
    const current = ++generation;
    try { child = spawn({ safeMode: state.safeMode }); }
    catch { exited(null, 'spawn_error'); return; }
    state.childPid = child.pid ?? null;
    let closed = false;
    const close = (code, signal) => {
      if (closed || current !== generation) return;
      closed = true; exited(code, signal);
    };
    child.once('error', () => close(null, 'spawn_error'));
    child.once('close', close);
    save();
  }

  function crash(reason) {
    const now = clock.now();
    events = events.filter((at) => now - at < cfg.crashWindowMs);
    events.push(now); state.crashCount = events.length;
    state.lastCrash = { at: new Date(now).toISOString(), reason };
    if (events.length >= cfg.crashLimit) {
      state.state = 'crash_loop'; state.crashLoopAt = new Date(now).toISOString();
      state.crashLoopReason = reason; state.logTail = tail(); save(); return;
    }
    state.state = 'backoff'; save();
    retryTimer = clock.setTimeout(start, backoff);
    backoff = Math.min(cfg.maxBackoffMs, backoff * 2);
  }
  /** Repeated health kills mean killing is the problem: next start runs in safe mode and is not probed to death. */
  function recordKill() {
    const now = clock.now();
    kills = kills.filter((at) => now - at < cfg.killLoopWindowMs); kills.push(now);
    if (kills.length >= cfg.killLoopLimit && !state.safeMode) {
      state.safeMode = true; state.safeModeAt = new Date(now).toISOString();
      state.safeModeReason = `health_kill_loop:${kills.length}`;
    }
  }
  function exited(code, signal) {
    if (clock.now() - startedAt >= cfg.stableMs) backoff = cfg.backoffMs;
    probeController?.abort(); probeController = null;
    clock.clearTimeout(stopTimer); stopTimer = null; child = null; pending = false;
    generation++; state.childPid = null;
    if (intent === 'stop') return done();
    if (intent === 'restart') return start();
    if (!state.enabled) { state.state = 'stopped'; save(); return; }
    if (intent === 'hang') recordKill();
    const reason = intent === 'hang' ? 'health_probe_failed' : `child_exit:${signal || code}`;
    intent = null; crash(reason);
  }
  function terminate(kind) {
    probeController?.abort(); probeController = null;
    intent = kind; state.state = kind === 'stop' ? 'stopping' : 'restarting'; save();
    const target = child;
    stopTimer = clock.setTimeout(() => { if (child === target) target.kill('SIGKILL'); },
      kind === 'hang' ? cfg.hangStopTimeoutMs : cfg.stopTimeoutMs);
    target.kill('SIGTERM');
  }
  function signal(name) {
    if (state.state === 'stopped') return;
    if (name === 'SIGTERM' || name === 'SIGINT') {
      if (!child) return done();
      if (intent) { intent = 'stop'; state.state = 'stopping'; save(); return; }
      return terminate('stop');
    }
    if (name !== 'SIGUSR2' || intent) return;
    if (child) return terminate('restart');
    if (state.state === 'crash_loop') { events = []; kills = []; state.crashCount = 0; backoff = cfg.backoffMs; }
    start();
  }
  async function tick() {
    if (!child || intent || !state.enabled) return;
    const now = clock.now();
    if (now - lastTick > 2 * cfg.probeIntervalMs) {
      failures = 0; lastTick = now; probeController?.abort(); probeController = null; pending = false; return;
    }
    lastTick = now;
    if (now - startedAt < cfg.graceMs || pending) return;
    const current = generation; pending = true;
    const controller = new AbortController(); probeController = controller;
    let ok = false;
    try { ok = (await fetch({ signal: controller.signal })).ok; } catch { /* A failed request is a failed probe. */ }
    if (current !== generation || intent || controller.signal.aborted) return;
    probeController = null; pending = false;
    if (ok) {
      failures = 0; everHealthy = true; lastGood = now; state.busy = null;
      // A child that stayed healthy long enough leaves safe mode for its next start.
      if (state.safeMode && now - startedAt >= cfg.stableMs) {
        state.safeMode = false; state.safeModeAt = null; state.safeModeReason = null; kills = []; save();
      }
      return;
    }
    // Progress (boot phase lines or a beating watchdog worker) separates "busy" from "dead".
    const token = safeProgress();
    const moved = token !== null && token !== lastProgress; lastProgress = token;
    const t = clock.now();
    const limit = everHealthy ? cfg.blockedLimitMs - (t - lastGood) : cfg.bootLimitMs - (t - startedAt);
    if (moved && limit > 0) {
      failures = 0; const busy = everHealthy ? 'blocked' : 'boot';
      if (state.busy !== busy) { state.busy = busy; save(); }
      return;
    }
    // In safe mode there is nothing lighter to retry with: stop the kill cycle and keep waiting
    // while the process is alive, unless it stopped making progress for the full limit.
    failures += 1;
    if (state.safeMode && limit > 0) return;
    if (failures >= cfg.failureLimit) terminate('hang');
  }
  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean' || enabled === state.enabled || intent) return;
    state.enabled = enabled;
    probeController?.abort(); probeController = null; pending = false; failures = 0;
    lastTick = lastGood = clock.now(); lastProgress = safeProgress(); state.busy = null;
    if (!enabled) { clock.clearTimeout(retryTimer); retryTimer = null; }
    save();
    if (enabled && !child && state.state !== 'stopping') start();
  }
  return { start, signal, tick, setEnabled, snapshot: () => ({ ...state }) };
}

/**
 * Progress token for the engine: the newest `[boot] phase=` log line plus the watchdog worker
 * heartbeat (written by the worker thread, so it keeps beating while the main loop is blocked).
 */
export function supervisorProgress({ logPath, heartbeatPath }) {
  let beat = '', phase = '';
  try { beat = String(JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')).at ?? ''); } catch { /* absent until the worker starts */ }
  try {
    const lines = supervisorLogTail(logPath).split('\n').filter((line) => line.includes('[boot] phase='));
    phase = lines.at(-1) || '';
  } catch { /* log is optional */ }
  return `${phase}|${beat}`;
}

export function processAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function processCommand(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim(); }
}

function isSupervisorProcess(pid, alive, command) {
  return alive(pid) && command(pid).includes('cretli-supervisor');
}

export function requestRestart(lockPath, { read = () => fs.readFileSync(lockPath, 'utf8'),
  alive = processAlive, command = processCommand, kill = process.kill } = {}) {
  let pid;
  try { pid = Number(read().trim()); }
  catch (error) { return error.code === 'ENOENT' ? 3 : 4; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return 4;
  try { if (!isSupervisorProcess(pid, alive, command)) return 3; }
  catch { return alive(pid) ? 4 : 3; }
  try { kill(pid, 'SIGUSR2'); return 0; } catch { return 4; }
}

export const SUPERVISOR_RECLAIM_STALE_MS = 30_000;

export function acquireSupervisorLock(lockPath, pid = process.pid, alive = processAlive, command = processCommand) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const create = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, String(pid)); } finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock recovery so a contender cannot remove a new lock.
    const guard = `${lockPath}.reclaim`;
    let fd;
    try { fd = fs.openSync(guard, 'wx', 0o600); }
    catch (guardError) {
      if (guardError.code !== 'EEXIST') throw guardError;
      const stat = fs.statSync(guard);
      if (Date.now() - stat.mtimeMs <= SUPERVISOR_RECLAIM_STALE_MS) throw guardError;
      // A recovery interrupted by a crash must not block future boot attempts.
      fs.unlinkSync(guard);
      fd = fs.openSync(guard, 'wx', 0o600);
    }
    const guardIdentity = fs.fstatSync(fd);
    try {
      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      const invalidOwner = !Number.isSafeInteger(owner) || owner <= 0;
      // An interrupted PID write is stale only after a contender has had time to finish.
      const freshInvalidOwner = invalidOwner
        && Date.now() - fs.statSync(lockPath).mtimeMs <= SUPERVISOR_RECLAIM_STALE_MS;
      if (freshInvalidOwner || (!invalidOwner && owner !== pid && isSupervisorProcess(owner, alive, command))) {
        throw new Error('Supervisor lock already owned or unreadable');
      }
      fs.unlinkSync(lockPath); create();
    } finally {
      fs.closeSync(fd);
      try {
        const current = fs.statSync(guard);
        if (current.ino === guardIdentity.ino && current.dev === guardIdentity.dev) fs.unlinkSync(guard);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('[cretli-supervisor] Reclaim cleanup failed:', cleanupError.code);
      }
    }
  }
  return () => {
    try {
      if (fs.readFileSync(lockPath, 'utf8').trim() === String(pid)) fs.unlinkSync(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

export function atomicSupervisorState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export function supervisorLogTail(file, env = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(8192, size));
    fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    let text = bytes.toString('utf8');
    // Redact literal environment values as well as recognizable credentials.
    const values = Object.entries(env).filter(([key, value]) => typeof value === 'string'
      && value.length > 0 && (value.length >= 4 || /secret|token|key|password|credential|cookie/i.test(key)))
      .map(([, value]) => value).sort((a, b) => b.length - a.length);
    for (const value of values) {
      text = text.replaceAll(value, '[redacted]');
    }
    return redactText(text).slice(-4096);
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** TLS relaxation is confined to this fixed loopback request; no redirects. */
export function probeSupervisorHealth({ port, useHttps, timeoutMs, signal = undefined }) {
  return new Promise((resolve) => {
    const request = (useHttps ? https : http).get({ hostname: '127.0.0.1', port,
      path: '/api/health', signal, ...(useHttps ? { rejectUnauthorized: false } : {}) }, (response) => {
      response.resume(); resolve({ ok: response.statusCode >= 200 && response.statusCode < 300 });
      request.destroy();
    });
    const timer = setTimeout(() => request.destroy(new Error('Probe timeout')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', () => resolve({ ok: false }));
  });
}
