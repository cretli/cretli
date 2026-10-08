/**
 * Pure helpers for the experimental CDP `Page.startScreencast` live view.
 *
 * Everything here is free of sockets, Playwright objects and wall-clock
 * defaults: the session manager and the `/ws-browser` handler wire these
 * together, while the tests drive them with an injected clock and a fake CDP
 * session. Two decisions live in this file on purpose:
 *
 * - the mode gate, so an unknown or tampered value fails closed to `off` and
 *   the existing pull path stays untouched, and
 * - the unacked-frame window with drop/collapse and fps/quality adaptation, so
 *   a slow panel degrades the stream instead of growing the queue.
 */

import { BROWSER_LIMITS } from './constants.js';

/** Modes the flag accepts. Anything else resolves to `off`. */
export const SCREENCAST_MODES = Object.freeze(['off', 'experimental']);

/**
 * Fail-closed normalization: the flag comes from a constant, an env var or a
 * client-supplied capability field, and none of them may silently turn into a
 * streaming mode because of a typo.
 * @param {unknown} value
 * @returns {'off' | 'experimental'}
 */
export function normalizeScreencastMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'experimental' ? 'experimental' : 'off';
}

/**
 * @param {'off' | 'experimental'} mode
 * @returns {boolean}
 */
export function isExperimentalMode(mode) {
  return normalizeScreencastMode(mode) === 'experimental';
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value, min, max, fallback) {
  const base = Number.isFinite(Number(value)) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, Math.round(base)));
}

/**
 * `Page.startScreencast` has no fps parameter, only `everyNthFrame`, so a
 * target rate is expressed against the compositor cadence. Clamped to at least
 * one so a requested rate above the cadence never becomes `0` (which Chromium
 * rejects) and never exceeds a sane bound.
 * @param {number} fps
 * @param {Record<string, any>} [limits]
 * @returns {number}
 */
export function screencastEveryNthFrame(fps, limits = BROWSER_LIMITS) {
  const compositorFps = positive(limits.SCREENCAST_COMPOSITOR_FPS, 30);
  const targetFps = positive(fps, positive(limits.SCREENCAST_DEFAULT_FPS, 3));
  const nth = Math.round(compositorFps / targetFps);
  return Math.min(Math.max(1, nth), 30);
}

/**
 * Builds the CDP `Page.startScreencast` payload. `maxWidth`/`maxHeight` are the
 * viewport the frame must fit so the panel can map a screenshot pixel onto a CSS
 * pixel exactly like the pull path does.
 * @param {{ width?: number, height?: number, quality?: number, everyNthFrame?: number }} [input]
 * @param {Record<string, any>} [limits]
 * @returns {Record<string, any>}
 */
export function buildStartScreencastParams(input = {}, limits = BROWSER_LIMITS) {
  const minQuality = positive(limits.SCREENCAST_MIN_QUALITY, 30);
  const maxQuality = positive(limits.SCREENCAST_MAX_QUALITY, 90);
  const params = {
    format: 'jpeg',
    quality: clampInteger(
      input.quality,
      minQuality,
      maxQuality,
      positive(limits.SCREENCAST_DEFAULT_QUALITY, 60),
    ),
    everyNthFrame: Math.max(1, Math.round(positive(input.everyNthFrame, 10))),
  };
  // An unknown viewport must leave the bounds out entirely: clamping a missing
  // size to the minimum would ask Chromium for a 1-pixel-wide frame.
  const maxWidth = positive(limits.MAX_VIEWPORT?.width, 4096);
  const maxHeight = positive(limits.MAX_VIEWPORT?.height, 4096);
  const width = Number(input.width);
  const height = Number(input.height);
  if (Number.isFinite(width) && width > 0) params.maxWidth = Math.min(Math.round(width), maxWidth);
  if (Number.isFinite(height) && height > 0) params.maxHeight = Math.min(Math.round(height), maxHeight);
  return params;
}

/**
 * The one JSON control message that announces a binary frame. The blob rides on
 * the next WS frame with no header of its own, so `byteLength` is what lets the
 * client prove the pair belongs together.
 * @param {{
 *   seq: number,
 *   browserTabId?: string,
 *   frameIndex?: number,
 *   byteLength?: number,
 *   width?: number,
 *   height?: number,
 *   capturedAt?: number|null,
 *   sentAt?: number,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildScreencastFrameHeader(input = {}) {
  return {
    type: 'screencast-frame',
    seq: Number(input.seq) || 0,
    browserTabId: String(input.browserTabId || ''),
    frameIndex: Number.isFinite(Number(input.frameIndex)) ? Number(input.frameIndex) : null,
    format: 'jpeg',
    mimeType: 'image/jpeg',
    byteLength: Number.isFinite(Number(input.byteLength)) ? Number(input.byteLength) : null,
    width: Number.isFinite(Number(input.width)) ? Number(input.width) : null,
    height: Number.isFinite(Number(input.height)) ? Number(input.height) : null,
    capturedAt: Number.isFinite(Number(input.capturedAt)) ? Number(input.capturedAt) : null,
    sentAt: Number.isFinite(Number(input.sentAt)) ? Number(input.sentAt) : null,
  };
}

/**
 * Pairs one binary WS frame with the control message that announced it.
 * Returns `null` when there is nothing to pair, or when the size disagrees with
 * the header: a caller treats that as a protocol break, which is also a
 * documented trigger for falling back to the pull path.
 * @param {Record<string, any>|null} header
 * @param {number} byteLength
 * @returns {{ seq: number, byteLength: number, header: Record<string, any> }|null}
 */
export function pairScreencastFrame(header, byteLength) {
  const seq = Number(header?.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const size = Number(byteLength);
  if (!Number.isFinite(size) || size <= 0) return null;
  const expected = Number(header?.byteLength);
  if (Number.isInteger(expected) && expected !== size) return null;
  return { seq, byteLength: size, header };
}

/**
 * Decodes one `Page.screencastFrame` event payload.
 * CDP delivers base64 JPEG plus `metadata.timestamp` in **seconds**; the
 * timestamp is only trusted once it lands in a plausible window around the
 * server clock, because a skewed capture stamp would poison the latency metric.
 * @param {any} frame
 * @param {() => number} now
 * @param {Record<string, any>} [limits]
 * @returns {{ frameIndex: number|null, bytes: Uint8Array, byteLength: number, capturedAt: number|null, oversized: boolean }}
 */
export function decodeScreencastFrame(frame, now, limits = BROWSER_LIMITS) {
  const raw = String(frame?.data ?? '');
  const bytes = Buffer.from(raw, 'base64');
  const seconds = Number(frame?.metadata?.timestamp);
  const at = now();
  const candidate = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  // A capture stamp may not be in the future and not older than the stall bound;
  // anything outside that is dropped so the metric falls back to server timing.
  const plausible = candidate !== null
    && candidate <= at + 1000
    && at - candidate <= positive(limits.SCREENCAST_STALL_TIMEOUT_MS, 4000) * 10;
  return {
    frameIndex: Number.isFinite(Number(frame?.frameIndex)) ? Number(frame.frameIndex) : null,
    bytes,
    byteLength: bytes.length,
    capturedAt: plausible ? candidate : null,
    oversized: bytes.length > positive(limits.SCREENCAST_MAX_FRAME_BYTES, 1.2 * 1024 * 1024),
  };
}

/**
 * Unacked-frame window with drop/collapse and rate adaptation for one tab.
 *
 * Contract the caller relies on:
 * - `admit()` either returns a slot to send, or collapses the oldest in-flight
 *   frame and reports it so the caller can answer Chromium for it immediately;
 *   the window never grows past `maxUnacked`.
 * - every admitted frame must be resolved exactly once, either by `resolve(seq)`
 *   (client acknowledged) or by the collapse the caller was handed. That is what
 *   keeps `Page.screencastFrameAck` balanced with the frames Chromium sent.
 *
 * @param {{ now?: () => number, limits?: Record<string, any> }} [options]
 */
export function createScreencastGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const limits = options.limits || BROWSER_LIMITS;
  const maxUnacked = Math.max(1, Math.round(positive(limits.SCREENCAST_MAX_UNACKED_FRAMES, 1)));
  const windowSize = Math.max(2, Math.round(positive(limits.SCREENCAST_ADAPT_WINDOW, 12)));
  const dropRatioLimit = positive(limits.SCREENCAST_ADAPT_DROP_RATIO, 0.34);
  const upWindows = Math.max(1, Math.round(positive(limits.SCREENCAST_ADAPT_UP_WINDOWS, 2)));
  const restartMinMs = positive(limits.SCREENCAST_RESTART_MIN_MS, 2000);
  const minFps = Math.max(1, Math.round(positive(limits.SCREENCAST_MIN_FPS, 1)));
  const maxFps = Math.max(minFps, Math.round(positive(limits.SCREENCAST_MAX_FPS, 5)));
  const minQuality = positive(limits.SCREENCAST_MIN_QUALITY, 30);
  const maxQuality = Math.max(minQuality, positive(limits.SCREENCAST_MAX_QUALITY, 90));

  /** @type {Map<number, { frameIndex: number|null, sentAt: number }>} */
  const pending = new Map();
  let seq = 0;
  /** @type {boolean[]} one entry per admitted frame: true when it collapsed another. */
  const history = [];
  let cleanWindows = 0;
  let fps = clampInteger(limits.SCREENCAST_DEFAULT_FPS, minFps, maxFps, 3);
  let quality = clampInteger(limits.SCREENCAST_DEFAULT_QUALITY, minQuality, maxQuality, 60);
  // `null` means "never restarted": the first adaptation must not wait out the
  // throttle, which is only there to keep a flapping rate from re-issuing
  // `Page.startScreencast` over and over.
  let lastRestartAt = null;
  let droppedTotal = 0;
  let sentTotal = 0;

  function target() {
    return { fps, quality, everyNthFrame: screencastEveryNthFrame(fps, limits) };
  }

  /**
   * A full window is the signal: step the rate down once per closed window, and
   * climb back toward the caps only after enough consecutive clean windows.
   */
  function evaluateWindow() {
    if (history.length < windowSize) return false;
    const dropped = history.reduce((sum, hit) => sum + (hit ? 1 : 0), 0);
    history.length = 0;
    const ratio = dropped / windowSize;
    if (ratio >= dropRatioLimit) {
      cleanWindows = 0;
      const nextFps = Math.max(minFps, fps - 1);
      const nextQuality = Math.max(minQuality, quality - 10);
      if (nextFps === fps && nextQuality === quality) return false;
      fps = nextFps;
      quality = nextQuality;
      return true;
    }
    if (fps === maxFps && quality === maxQuality) {
      cleanWindows = 0;
      return false;
    }
    cleanWindows += 1;
    if (cleanWindows < upWindows) return false;
    cleanWindows = 0;
    fps = Math.min(maxFps, fps + 1);
    quality = Math.min(maxQuality, quality + 10);
    return true;
  }

  return {
    get maxUnacked() {
      return maxUnacked;
    },
    get limits() {
      return limits;
    },
    target,
    pendingCount: () => pending.size,
    pendingSeqs: () => [...pending.keys()],
    getTotals: () => ({ sent: sentTotal, dropped: droppedTotal }),
    /**
     * Reserves a slot for a new frame.
     * @param {{ frameIndex?: number|null }} frame
     * @returns {{ seq: number, frameIndex: number|null, collapsed: Array<{ seq: number, frameIndex: number|null }> }}
     */
    admit(frame = {}) {
      /** @type {Array<{ seq: number, frameIndex: number|null }>} */
      const collapsed = [];
      while (pending.size >= maxUnacked && pending.size > 0) {
        // Insertion order in a Map is the frame order, so the first entry is the
        // oldest unacknowledged frame — the one a live preview may drop.
        const oldest = pending.entries().next().value;
        pending.delete(oldest[0]);
        collapsed.push({ seq: oldest[0], frameIndex: oldest[1].frameIndex });
        droppedTotal += 1;
      }
      seq += 1;
      const at = now();
      pending.set(seq, { frameIndex: frame?.frameIndex ?? null, sentAt: at });
      sentTotal += 1;
      history.push(collapsed.length > 0);
      evaluateWindow();
      return { seq, frameIndex: frame?.frameIndex ?? null, collapsed };
    },
    /**
     * @param {number} ackSeq
     * @returns {{ seq: number, frameIndex: number|null, sentAt: number }|null}
     */
    resolve(ackSeq) {
      const key = Number(ackSeq);
      const entry = pending.get(key);
      if (!entry) return null;
      pending.delete(key);
      return { seq: key, frameIndex: entry.frameIndex, sentAt: entry.sentAt };
    },
    /** Drains the window, reporting each unresolved frame for its CDP ack. */
    drain() {
      const unresolved = [...pending.entries()].map(([key, entry]) => ({
        seq: key,
        frameIndex: entry.frameIndex,
      }));
      pending.clear();
      return unresolved;
    },
    /** True once the rate target moved and a restart is allowed by the throttle. */
    needsRestart(applied) {
      const next = target();
      if (applied && Number(applied.everyNthFrame) === next.everyNthFrame
        && Number(applied.quality) === next.quality) return false;
      if (lastRestartAt === null) return true;
      return now() - lastRestartAt >= restartMinMs;
    },
    markRestart() {
      lastRestartAt = now();
      return target();
    },
  };
}
