// Worker thread for the stall watchdog. Watches a heartbeat counter written by
// the main thread; on a stale heartbeat it profiles the main thread through the
// inspector and posts a summary back. See stall-watchdog.js for the contract.
import { parentPort, workerData } from 'node:worker_threads';
import inspector from 'node:inspector';
import fs from 'node:fs';
import { summarizeProfile } from './cpu-profile-summary.js';
import { createCooldownGate } from './stall-watchdog.js';

const { sab, thresholdMs, profileMs, cooldownMs, checkMs, repoRoot, heartbeatFile } = workerData;
const beat = new Int32Array(sab, 0, 1);
const gate = createCooldownGate({ cooldownMs, now: () => Date.now() });

let lastBeat = Atomics.load(beat, 0);
let lastChange = Date.now();
let busy = false;

function post(msg) {
  parentPort.postMessage(msg);
}

function profileMain() {
  return new Promise((resolve, reject) => {
    const session = new inspector.Session();
    try {
      session.connectToMainThread();
    } catch (e) {
      reject(e);
      return;
    }
    const done = (err, result) => {
      try {
        session.disconnect();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(result);
    };
    session.post('Profiler.enable', (e1) => {
      if (e1) return done(e1);
      session.post('Profiler.start', (e2) => {
        if (e2) return done(e2);
        setTimeout(() => {
          session.post('Profiler.stop', (e3, res) => done(e3, res?.profile));
        }, profileMs);
      });
    });
  });
}

/** Stalls longer than this always get a fresh profile, even inside the cooldown window. */
// Overridable through workerData for tests.
const LONG_STALL_MS = workerData.longStallMs ?? 10000;

/** Heartbeat stall in progress: one report is posted when the main thread is free again. */
let stall = null;

function maybePost(s) {
  // Only post once the stall has ended: the report must carry the real total duration.
  if (s.posted || s.busy || !s.summary || s.endedMs == null) return;
  s.posted = true;
  post({
    type: 'stall',
    reason: s.reason,
    // Real blocked->unblocked time.
    stalledForMs: s.endedMs,
    summary: s.summary,
    profileMs,
    detectedAt: s.detectedAt,
    profiledLong: s.longDone,
  });
}

async function profileInto(s, force) {
  if (s.busy || busy || (!force && !gate.tryEnter())) return false;
  busy = true;
  s.busy = true;
  try {
    const profile = await profileMain();
    s.summary = summarizeProfile(profile, { repoRoot });
    s.detectedAt = new Date().toISOString();
  } catch (error) {
    post({ type: 'error', reason: s.reason, stalledForMs: s.endedMs ?? 0, message: String(error?.message || error) });
  } finally {
    busy = false;
    s.busy = false;
  }
  maybePost(s);
  return true;
}

/** Probe-triggered report: the probe supplies the duration, so post right after profiling. */
async function onTrigger(reason, stalledForMs) {
  if (busy || !gate.tryEnter()) return;
  busy = true;
  try {
    const profile = await profileMain();
    const summary = summarizeProfile(profile, { repoRoot });
    post({ type: 'stall', reason, stalledForMs, summary, profileMs, detectedAt: new Date().toISOString() });
  } catch (error) {
    post({ type: 'error', reason, stalledForMs, message: String(error?.message || error) });
  } finally {
    busy = false;
  }
}

parentPort.on('message', (m) => {
  if (m?.type === 'trigger') void onTrigger(m.reason || 'probe', m.stalledForMs || 0);
});

let lastWrite = 0;
/** Worker-side liveness for the supervisor: keeps beating while the main loop is blocked. */
function writeHeartbeat(now, cur) {
  if (!heartbeatFile || now - lastWrite < 2000) return;
  lastWrite = now;
  try {
    fs.writeFileSync(heartbeatFile, JSON.stringify({ at: now, tasks: cur, mainStalledMs: now - lastChange }));
  } catch { /* diagnostic only */ }
}

setInterval(() => {
  const now = Date.now();
  const cur = Atomics.load(beat, 0);
  writeHeartbeat(now, cur);
  if (cur !== lastBeat) {
    if (stall) {
      // Main thread is back: now the full duration of the stall is known.
      stall.endedMs = now - lastChange;
      maybePost(stall);
      stall = null;
    }
    lastBeat = cur;
    lastChange = now;
    return;
  }
  const stale = now - lastChange;
  if (stale <= thresholdMs) return;
  if (!stall) {
    stall = { reason: 'heartbeat', startedAt: lastChange, summary: null, busy: false, posted: false, longDone: false };
    void profileInto(stall, false);
    return;
  }
  if (stale > LONG_STALL_MS && !stall.longDone && !stall.busy && !busy) {
    // A long stall replaces the early (possibly cooldown-suppressed) profile with a later one.
    stall.longDone = true;
    void profileInto(stall, true);
  }
}, checkMs);

post({ type: 'ready' });
