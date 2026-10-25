// Worker thread for the stall watchdog. Watches a heartbeat counter written by
// the main thread; on a stale heartbeat it profiles the main thread through the
// inspector and posts a summary back. See stall-watchdog.js for the contract.
import { parentPort, workerData } from 'node:worker_threads';
import inspector from 'node:inspector';
import { summarizeProfile } from './cpu-profile-summary.js';
import { createCooldownGate } from './stall-watchdog.js';

const { sab, thresholdMs, profileMs, cooldownMs, checkMs, repoRoot } = workerData;
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

async function onStall(reason, stalledForMs) {
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
  if (m?.type === 'trigger') void onStall(m.reason || 'probe', m.stalledForMs || 0);
});

setInterval(() => {
  const now = Date.now();
  const cur = Atomics.load(beat, 0);
  if (cur !== lastBeat) {
    lastBeat = cur;
    lastChange = now;
    return;
  }
  const stale = now - lastChange;
  if (stale > thresholdMs) {
    void onStall('heartbeat', stale);
    return;
  }

}, checkMs);

post({ type: 'ready' });
