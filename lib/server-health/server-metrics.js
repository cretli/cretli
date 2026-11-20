// In-process server metrics without the inspector: event-loop delay
// (monitorEventLoopDelay), event-loop utilization, GC activity (PerformanceObserver
// 'gc') and heapUsed, sampled on a timer and summarized over rolling 1/5/15 min
// windows. Cost on the main thread: one timer tick per `sampleMs` plus the GC callbacks.
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

const NS_PER_MS = 1e6;
export const METRICS_WINDOWS_MIN = Object.freeze([1, 5, 15]);
export const METRICS_SAMPLE_MS = 10_000;

const round1 = (value) => Math.round(value * 10) / 10;
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * @param {{
 *   sampleMs?: number, windowsMin?: readonly number[], now?: () => number,
 *   histogram?: { enable?: () => void, disable?: () => void, reset: () => void, percentile: (p: number) => number, max: number },
 *   eventLoopUtilization?: (prev?: any) => { utilization: number, idle: number, active: number },
 *   heapUsed?: () => number,
 *   observeGc?: (onGc: (entry: { duration: number }) => void) => (() => void),
 * }} [options]
 */
export function createServerMetrics({
  sampleMs = METRICS_SAMPLE_MS,
  windowsMin = METRICS_WINDOWS_MIN,
  now = Date.now,
  histogram = monitorEventLoopDelay({ resolution: 20 }),
  eventLoopUtilization = (prev) => performance.eventLoopUtilization(prev),
  heapUsed = () => process.memoryUsage().heapUsed,
  observeGc = defaultObserveGc,
} = {}) {
  const retentionMs = Math.max(...windowsMin) * 60_000;
  /** @type {Array<Record<string, number>>} */
  let samples = [];
  let gcCount = 0;
  let gcMs = 0;
  let lastElu = null;
  let lastHeap = null;
  let lastSampleAt = null;
  let timer = null;
  let stopGc = null;

  /** Close the current sampling interval; exported as `sample` for tests. */
  function sample() {
    const t = now();
    const elu = eventLoopUtilization(lastElu || undefined);
    // eventLoopUtilization(prev) is the delta since `prev`; keep the absolute reading for the next call.
    lastElu = eventLoopUtilization();
    const heap = heapUsed();
    const spanMs = lastSampleAt == null ? sampleMs : Math.max(1, t - lastSampleAt);
    const row = {
      t,
      spanMs,
      p50: histogram.percentile(50) / NS_PER_MS,
      p99: histogram.percentile(99) / NS_PER_MS,
      max: histogram.max / NS_PER_MS,
      elu: elu.utilization,
      gcCount,
      gcMs,
      // Approximation: heap growth between samples; reclaimed memory is not visible here.
      allocBytes: lastHeap == null ? 0 : Math.max(0, heap - lastHeap),
      heapUsed: heap,
    };
    histogram.reset();
    gcCount = 0;
    gcMs = 0;
    lastHeap = heap;
    lastSampleAt = t;
    samples.push(row);
    const cutoff = t - retentionMs;
    if (samples[0].t < cutoff) samples = samples.filter((s) => s.t >= cutoff);
    return row;
  }

  function summarizeWindow(minutes, at) {
    const rows = samples.filter((s) => s.t > at - minutes * 60_000);
    if (!rows.length) return { minutes, samples: 0 };
    const spanMs = rows.reduce((sum, r) => sum + r.spanMs, 0);
    const sorted = rows.map((r) => r.p50).sort((a, b) => a - b);
    const gcTotalMs = rows.reduce((sum, r) => sum + r.gcMs, 0);
    return {
      minutes,
      samples: rows.length,
      eventLoopDelayMs: {
        // p50 is the median of per-interval medians; p99 is the worst interval p99 (conservative).
        p50: round1(sorted[Math.floor(sorted.length / 2)]),
        p99: round1(Math.max(...rows.map((r) => r.p99))),
        max: round1(Math.max(...rows.map((r) => r.max))),
      },
      elu: round3(rows.reduce((sum, r) => sum + r.elu * r.spanMs, 0) / spanMs),
      gc: {
        count: rows.reduce((sum, r) => sum + r.gcCount, 0),
        totalMs: round1(gcTotalMs),
        // Share of wall-clock spent in GC pauses.
        busyRatio: round3(gcTotalMs / spanMs),
      },
      allocRateBytesPerSec: Math.round(rows.reduce((sum, r) => sum + r.allocBytes, 0) / (spanMs / 1000)),
      heapUsedBytes: { last: rows[rows.length - 1].heapUsed, max: Math.max(...rows.map((r) => r.heapUsed)) },
    };
  }

  function snapshot() {
    const at = now();
    return {
      sampleMs,
      sampledAt: samples.length ? samples[samples.length - 1].t : 0,
      heapUsedBytes: heapUsed(),
      windows: Object.fromEntries(windowsMin.map((m) => [`${m}m`, summarizeWindow(m, at)])),
    };
  }

  function start() {
    if (timer) return false;
    histogram.enable?.();
    histogram.reset();
    lastElu = eventLoopUtilization();
    lastHeap = heapUsed();
    lastSampleAt = now();
    stopGc = observeGc((entry) => {
      gcCount += 1;
      gcMs += Number(entry.duration) || 0;
    });
    timer = setInterval(sample, sampleMs);
    timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    stopGc?.();
    stopGc = null;
    histogram.disable?.();
  }

  return { start, stop, sample, snapshot };
}

function defaultObserveGc(onGc) {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onGc(entry);
    });
    observer.observe({ entryTypes: ['gc'] });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

/** @type {ReturnType<typeof createServerMetrics> | null} */
let shared = null;

/** Process-wide collector; started on first use. */
export function getServerMetrics() {
  if (!shared) {
    shared = createServerMetrics();
    shared.start();
  }
  return shared;
}

/** Snapshot that never throws: diagnostics must not break health endpoints. */
export function readServerMetrics() {
  try {
    return getServerMetrics().snapshot();
  } catch {
    return null;
  }
}
