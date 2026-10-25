// Event-loop stall watchdog.
//
// A worker thread (see stall-watchdog-worker.js) watches a heartbeat counter in a
// SharedArrayBuffer that the main thread bumps from an unref'd timer. When the
// counter is stale for more than `thresholdMs` (or an injected probe, e.g. a
// /login HTTP check, times out or fails), the worker attaches to the main thread
// via inspector.Session.connectToMainThread, records a CPU profile for
// `profileMs`, summarizes it (preferring frames under lib/) and posts it back.
// The main thread handles the report once its loop is free again: it derives a
// signature, dedupes (registry + findTodoBySignature), creates an `idea` todo and
// calls notify(). Normal-operation cost on the main thread: one counter
// increment per `heartbeatMs`.
//
// Server integration contract:
// Construct with repoRoot and a durable registryPath; start after listen().
// An optional HTTP probe can complement the worker heartbeat.
// createTodo must persist an idea todo from { title, body, idempotencyKey };
// findTodoBySignature must search persisted todos for the stall-signature marker.
// notify must deliver the supplied outcome to the notification service.
// Call start() once dependencies are ready and stop() on server shutdown.
// The server must supply these adapters; this module does not wire itself in.
// Injected registries must implement synchronous has/reserve/release/add methods;
// reservations are transient, while add records a successfully persisted todo.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSignature, buildTodoBody } from './cpu-profile-summary.js';
import { createMemoryRegistry, createFileRegistry } from './stall-registry.js';

export { summarizeProfile, computeSignature, buildTodoBody } from './cpu-profile-summary.js';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stall-watchdog-worker.js');

/** Allows one profile per cooldown window; also used to cap in-flight profiles. */
export function createCooldownGate({ cooldownMs = 600000, now = Date.now } = {}) {
  let last = -Infinity;
  return {
    tryEnter() {
      const t = now();
      if (t - last < cooldownMs) return false;
      last = t;
      return true;
    },
  };
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** HTTP health check; rejects on timeout, transport errors, or non-success status. */
export function createHttpProbe({ url, timeoutMs = 3000 }) {
  return async ({ signal } = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
}

/**
 * @param {{
 *   thresholdMs?: number, profileMs?: number, cooldownMs?: number,
 *   heartbeatMs?: number, checkMs?: number, probeIntervalMs?: number,
 *   probeTimeoutMs?: number, repoRoot?: string, probe?: Function,
 *   createTodo?: Function, findTodoBySignature?: Function, notify?: Function,
 *   registry?: ReturnType<typeof createMemoryRegistry>, registryPath?: string,
 *   logger?: Pick<Console, 'warn'>, now?: () => Date,
 *   createWorker?: (options: import('node:worker_threads').WorkerOptions) => Worker,
 * }} [options]
 */
export function createStallWatchdog({
  thresholdMs = 5000,
  profileMs = 5000,
  cooldownMs = 600000,
  heartbeatMs = 1000,
  checkMs,
  probeIntervalMs = 30000,
  probeTimeoutMs = 10000,
  repoRoot = '',
  probe,
  createTodo,
  findTodoBySignature,
  notify,
  registry,
  registryPath,
  logger = console,
  now = () => new Date(),
  createWorker = (options) => new Worker(WORKER_FILE, options),
} = {}) {
  const reg = registry || (registryPath ? createFileRegistry(registryPath) : createMemoryRegistry());
  const state = {
    running: false,
    supported: true,
    stalls: 0,
    todosCreated: 0,
    deduped: 0,
    errors: 0,
    lastStallAt: null,
    lastSignature: null,
  };
  let run = null;

  /** Main-thread handling of a worker report. Exported for tests via getState-free access. */
  async function handleReport(msg) {
    if (msg.type === 'error') {
      state.errors += 1;
      logger.warn?.(`[stall-watchdog] profile failed: ${msg.message}`);
      return null;
    }
    const { summary, stalledForMs, reason, profileMs: pm, detectedAt } = msg;
    const signature = computeSignature(summary);
    state.stalls += 1;
    state.lastStallAt = detectedAt || now().toISOString();
    state.lastSignature = signature;
    let outcome = 'created';
    let reserved = false;
    try {
      if (!reg.reserve(signature)) {
        outcome = 'deduped';
      } else {
        reserved = true;
        if (findTodoBySignature && (await findTodoBySignature(signature))) {
          reg.add(signature, { at: detectedAt || state.lastStallAt, existing: true });
          reserved = false;
          outcome = 'deduped';
        } else if (typeof createTodo === 'function') {
          const body = buildTodoBody({ summary, signature, stalledForMs, reason, profileMs: pm, detectedAt });
          const top = summary.lib[0] || summary.top[0];
          await createTodo({
            title: `Event-loop stall: ${top ? `${top.functionName} (${top.file})` : 'unknown'}`,
            body,
            idempotencyKey: `stall-${signature}-${isoDay(now())}`,
          });
          reg.add(signature, { at: detectedAt || state.lastStallAt });
          reserved = false;
          state.todosCreated += 1;
        } else {
          outcome = 'no-createTodo';
        }
      }
      if (outcome === 'deduped') state.deduped += 1;
      await notify?.({ signature, outcome, reason, stalledForMs, summary, detectedAt: state.lastStallAt });
    } catch (error) {
      outcome = 'failed';
      state.errors += 1;
      logger.warn?.(`[stall-watchdog] report handling failed: ${error?.message || error}`);
    }
    if (reserved) reg.release(signature);
    return { signature, outcome };
  }

  function cleanup(current) {
    clearInterval(current.hbTimer);
    clearInterval(current.probeTimer);
    current.cancelProbe?.();
    if (run === current) {
      run = null;
      state.running = false;
    }
  }

  function start() {
    if (run) return false;
    const sab = new SharedArrayBuffer(4);
    const beat = new Int32Array(sab);
    const current = { worker: null, hbTimer: null, probeTimer: null, cancelProbe: null };
    try {
      current.worker = createWorker({
        execArgv: [], // Do not inherit flags such as --input-type or --inspect.
        workerData: {
          sab, thresholdMs, profileMs, cooldownMs, repoRoot,
          checkMs: checkMs || Math.max(50, Math.min(1000, Math.floor(thresholdMs / 4))),
        },
      });
    } catch (error) {
      state.supported = false;
      logger.warn?.(`[stall-watchdog] cannot start worker: ${error?.message || error}`);
      return false;
    }
    run = current;
    state.supported = true;
    const w = current.worker;
    w.unref();
    w.on('message', (m) => {
      if (run === current && (m?.type === 'stall' || m?.type === 'error')) void handleReport(m);
    });
    w.on('error', (e) => {
      if (run !== current) return;
      state.errors += 1;
      logger.warn?.(`[stall-watchdog] worker error: ${e?.message || e}`);
      cleanup(current);
      void w.terminate();
    });
    w.on('exit', (code) => {
      if (run !== current) return;
      if (code !== 0) {
        state.errors += 1;
        logger.warn?.(`[stall-watchdog] worker exited: ${code}`);
      }
      cleanup(current);
    });
    current.hbTimer = setInterval(() => Atomics.add(beat, 0, 1), heartbeatMs);
    current.hbTimer.unref();
    if (typeof probe === 'function') {
      current.probeTimer = setInterval(async () => {
        if (current.cancelProbe) return;
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`probe exceeded ${probeTimeoutMs} ms`);
            error.code = 'PROBE_TIMEOUT';
            reject(error);
            controller.abort(error);
          }, probeTimeoutMs);
          timer.unref();
          current.cancelProbe = () => {
            clearTimeout(timer);
            reject(new Error('watchdog stopped'));
            controller.abort();
          };
        });
        try {
          await Promise.race([Promise.resolve().then(() => probe({ signal: controller.signal })), deadline]);
        } catch (error) {
          if (run === current) {
            w.postMessage({
              type: 'trigger',
              reason: error?.code === 'PROBE_TIMEOUT' ? 'probe-timeout' : `probe-failed: ${error?.message || error}`,
              stalledForMs: error?.code === 'PROBE_TIMEOUT' ? probeTimeoutMs : 0,
            });
          }
        } finally {
          clearTimeout(timer);
          current.cancelProbe = null;
        }
      }, probeIntervalMs);
      current.probeTimer.unref();
    }
    state.running = true;
    return true;
  }

  function stop() {
    if (!run) return;
    const current = run;
    cleanup(current);
    void current.worker.terminate();
  }

  return { start, stop, getState: () => ({ ...state }), handleReport };
}
