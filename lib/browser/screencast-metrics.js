/**
 * Measurements for the experimental screencast live view.
 *
 * R6 of the streaming plan is the reason this is a separate module: a
 * zero-initialized accumulator that returns `0` for a dimension nobody measured
 * is indistinguishable from "measured, and it is idle", so every getter here
 * resolves to `null` until a real sample lands. The clock and the resource
 * sampler are injected, which is what makes the fps and latency maths testable
 * without waiting for a timer.
 */

import { BROWSER_LIMITS } from './constants.js';

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Host-process sampler. Returns `null` when the runtime cannot answer (browser
 * or worker context) rather than a zeroed sample, so the snapshot keeps saying
 * "not measured".
 * @returns {{ cpuMicros: number|null, rssBytes: number|null, pid: number|null }|null}
 */
export function defaultResourceSampler() {
  if (typeof process === 'undefined') return null;
  const cpu = typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;
  const mem = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;
  if (!cpu && !mem) return null;
  return {
    cpuMicros: cpu ? Number(cpu.user || 0) + Number(cpu.system || 0) : null,
    rssBytes: mem && Number.isFinite(mem.rss) ? mem.rss : null,
    pid: Number.isFinite(process.pid) ? process.pid : null,
  };
}

/**
 * @param {{
 *   now?: () => number,
 *   limits?: Record<string, any>,
 *   sampleResource?: () => any,
 *   windowMs?: number,
 *   maxLatencyMs?: number,
 * }} [options]
 */
export function createScreencastMetrics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limits = options.limits || BROWSER_LIMITS;
  const sampleResource = typeof options.sampleResource === 'function'
    ? options.sampleResource
    : (options.sampleResource === null ? null : defaultResourceSampler);
  const windowMs = positive(options.windowMs, 2000);
  // A latency above the stall bound is a clock problem, not a real measurement.
  const maxLatencyMs = positive(options.maxLatencyMs,
    positive(limits.SCREENCAST_STALL_TIMEOUT_MS, 4000) * 4);

  /** @type {Array<{ seq: number, sentAt: number, capturedAt: number|null }>} */
  const sent = [];
  /** @type {number[]} */
  const latencies = [];
  /** @type {number[]} capture stamps of frames that actually arrived. */
  const arrivals = [];
  let dropped = 0;
  let acked = 0;
  let startedAt = null;
  let lastFrameAt = null;
  let lastLatencyMs = null;
  /** @type {{ cpuPercent: number|null, rssBytes: number|null, pid: number|null }} */
  const host = { cpuPercent: null, rssBytes: null, pid: null };
  let lastSample = null;
  let lastSampleAt = null;
  /** @type {{ usedBytes: number|null, totalBytes: number|null, at: number|null }} */
  const heap = { usedBytes: null, totalBytes: null, at: null };
  let browserPid = null;

  function applyResourceSample(at) {
    if (!sampleResource) return;
    let sample = null;
    try {
      sample = sampleResource();
    } catch {
      sample = null;
    }
    if (!sample) return;
    host.rssBytes = Number.isFinite(sample.rssBytes) ? sample.rssBytes : null;
    host.pid = Number.isFinite(sample.pid) ? sample.pid : null;
    const cpuMicros = Number(sample.cpuMicros);
    const wallDeltaMs = Number.isFinite(lastSampleAt) ? at - lastSampleAt : 0;
    if (Number.isFinite(cpuMicros) && lastSample && wallDeltaMs > 0
      && Number.isFinite(lastSample.cpuMicros)) {
      const cpuDeltaUs = cpuMicros - lastSample.cpuMicros;
      // Guard against a wrapped or reset counter, which would otherwise report a
      // huge negative or absurd utilization percentage.
      if (cpuDeltaUs >= 0) {
        host.cpuPercent = Math.max(0, Math.round((cpuDeltaUs / (wallDeltaMs * 1000)) * 1000) / 10);
      }
    }
    lastSample = { cpuMicros: Number.isFinite(cpuMicros) ? cpuMicros : null };
    lastSampleAt = at;
  }

  /**
   * @param {number} at
   * @returns {number|null}
   */
  function computeFps(at) {
    while (arrivals.length && at - arrivals[0] > windowMs) arrivals.shift();
    if (arrivals.length < 2) return null;
    const span = (arrivals[arrivals.length - 1] - arrivals[0]) / 1000;
    if (!(span > 0)) return null;
    return Math.round(((arrivals.length - 1) / span) * 100) / 100;
  }

  return {
    /** Marks the beginning of a stream so a later snapshot can age it. */
    noteStarted() {
      startedAt = now();
      return startedAt;
    },
    /**
     * @param {{ seq: number, capturedAt?: number|null }} frame
     */
    noteFrameSent(frame = {}) {
      const at = now();
      const seq = Number(frame.seq);
      if (!Number.isInteger(seq)) return null;
      const capturedAt = Number.isFinite(Number(frame.capturedAt)) ? Number(frame.capturedAt) : null;
      sent.push({ seq, sentAt: at, capturedAt });
      while (sent.length > 256) sent.shift();
      lastFrameAt = at;
      arrivals.push(at);
      while (arrivals.length > 512 || (arrivals.length > 1 && at - arrivals[0] > windowMs * 4)) {
        arrivals.shift();
      }
      applyResourceSample(at);
      return at;
    },
    noteFrameDropped() {
      dropped += 1;
    },
    /**
     * Latency is capture → client acknowledgement. Without a credible capture
     * stamp the in-server span (send → ack) is used and labelled as such by the
     * caller; a stamp that yields a nonsensical span records nothing.
     * @param {{ seq: number }} ack
     * @returns {number|null} the latency that was recorded, if any
     */
    noteFrameAcked(ack = {}) {
      const at = now();
      const seq = Number(ack.seq);
      const index = Number.isInteger(seq) ? sent.findIndex((row) => row.seq === seq) : -1;
      if (index === -1) return null;
      const [frame] = sent.splice(index, 1);
      acked += 1;
      const origin = frame.capturedAt ?? frame.sentAt;
      const latency = at - origin;
      if (!Number.isFinite(latency) || latency < 0 || latency > maxLatencyMs) return null;
      lastLatencyMs = latency;
      latencies.push(latency);
      while (latencies.length > 64) latencies.shift();
      return latency;
    },
    /** @param {{ usedSize?: number, totalSize?: number }} [usage] */
    noteHeapUsage(usage = {}) {
      const used = Number(usage.usedSize);
      const total = Number(usage.totalSize);
      if (!Number.isFinite(used) || used < 0) return false;
      heap.usedBytes = used;
      heap.totalBytes = Number.isFinite(total) && total > 0 ? total : null;
      heap.at = now();
      return true;
    },
    /** @param {number|null} pid */
    noteBrowserPid(pid) {
      browserPid = Number.isFinite(Number(pid)) ? Number(pid) : null;
    },
    /** Frames per second over the measurement window, or null when unmeasured. */
    fps(at = now()) {
      return computeFps(at);
    },
    /** Builds the reportable snapshot; every dimension is null until measured. */
    snapshot(at = now()) {
      const sorted = [...latencies].sort((a, b) => a - b);
      const avg = sorted.length
        ? Math.round((sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length) * 10) / 10
        : null;
      const p95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : null;
      return {
        fps: this.fps(at),
        avgLatencyMs: avg,
        p95LatencyMs: p95,
        lastLatencyMs: lastLatencyMs,
        framesSent: sent.length + acked,
        framesInFlight: sent.length,
        framesAcked: acked,
        framesDropped: dropped,
        startedAt,
        lastFrameAt,
        lastFrameAgeMs: lastFrameAt === null ? null : Math.max(0, at - lastFrameAt),
        hostProcess: {
          cpuPercent: host.cpuPercent,
          rssBytes: host.rssBytes,
          pid: host.pid,
        },
        tabHeap: {
          usedBytes: heap.usedBytes,
          totalBytes: heap.totalBytes,
          at: heap.at,
        },
        browserPid,
      };
    },
    reset() {
      sent.length = 0;
      latencies.length = 0;
      arrivals.length = 0;
      dropped = 0;
      acked = 0;
      startedAt = null;
      lastFrameAt = null;
      lastLatencyMs = null;
      host.cpuPercent = null;
      host.rssBytes = null;
      host.pid = null;
      lastSample = null;
      lastSampleAt = null;
      heap.usedBytes = null;
      heap.totalBytes = null;
      heap.at = null;
      browserPid = null;
    },
  };
}
