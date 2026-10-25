/**
 * Pure (DOM-free) measurement helpers for the sidebar rebuild / presence-frame
 * baseline. Every emitter here is opt-in through the existing `uiFreezeTrace`
 * mechanism — nothing is allocated or counted when the trace flag is off, and
 * every view callsite wraps its call in `if (isUiFreezeTraceActive())`.
 *
 * WHY A LEAF MODULE: the view files (`sidebarView.js`, `chat.js`,
 * `chatListLiveSync.js`, `chatTransport.js`) pull the whole browser graph and
 * cannot be imported under `node` tests. All aggregation / diffing therefore
 * lives here so it is unit-testable; the views only feed data in under the flag.
 *
 * ── SCENARIO (baseline is a MANUAL step; this file only INSTRUMENTS) ─────────
 * Run each case on desktop AND mobile-edge (backgroundWsMax=0 is scenario
 * context, not code to write), watching the Logs panel "freeze" filter:
 *   1. Open `?uiFreezeDiag=1` (or set localStorage `cretli-ui-freeze-diag=1`).
 *   2. Keep 3–5 chats connected in parallel; Workspace Watcher in `observe`.
 *   3. Let the sidebar sit idle for ~60s, then toggle a couple of groups.
 * Fill this table from the emitted `sidebar:snapshot` events (and the existing
 * `uiFreezeHttp` GET lines for the /api/chats column):
 *
 *   | metryka                     | desktop | mobile-edge |
 *   |-----------------------------|---------|-------------|
 *   | pełne przebudowy / min      |         |             |
 *   | mediana czasu render (ms)   |         |             |
 *   | GET /api/chats / min        |         |             |
 *   | ramki presence / min        |         |             |
 *   | ramki chatsChanged / min    |         |             |
 *   | % duplikatów presence (seq) |         |             |
 *
 * Sub-task 8 re-uses this same instrumentation to collect the numbers.
 */

import { isUiFreezeTraceActive, traceUiFreeze } from '../../lib/uiFreezeTrace.js';

/** Named signature segments — diffed as whole values, never split on '||'. */
export const SEGMENT_KEYS = ['layout', 'structure', 'status', 'group', 'watcher'];

const SAMPLE_CAP = 256;

/**
 * Monotonic millisecond clock for duration deltas (perf.now with Date.now
 * fallback). Rate windows use the wall clock instead so their buckets line up
 * with real seconds.
 * @returns {number}
 */
export function monoNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Which named signature segments changed between two renders. Operates on the
 * {layout, structure, status, group, watcher} parts object — NOT the '||'-joined
 * string, because segment values (structureSig especially) legitimately contain
 * '||' and would be sliced incorrectly.
 * @param {Record<string, string> | null | undefined} prev
 * @param {Record<string, string> | null | undefined} next
 * @returns {string[]} changed segment names (in SEGMENT_KEYS order)
 */
export function diffSignatureSegments(prev, next) {
  const changed = [];
  for (const key of SEGMENT_KEYS) {
    const before = prev ? prev[key] : undefined;
    const after = next ? next[key] : undefined;
    if (before !== after) changed.push(key);
  }
  return changed;
}

/**
 * Tumbling 1-second rate counters keyed by an arbitrary label (e.g. 'notifySidebar',
 * 'presence:watchers', 'chatsChanged:title'). The window rotates on access when the
 * wall clock crosses into a new epoch.
 * @param {() => number} [nowFn] wall clock
 * @param {number} [windowMs]
 */
export function createRateWindow(nowFn = () => Date.now(), windowMs = 1000) {
  let epoch = null;
  /** @type {Map<string, number>} */
  let counts = new Map();

  function epochOf(at) {
    return Math.floor(at / windowMs);
  }

  function rotate(now) {
    const e = epochOf(now);
    if (e !== epoch) {
      epoch = e;
      counts = new Map();
    }
    return e;
  }

  return {
    windowMs,
    /**
     * @param {string} key
     * @param {number} [at]
     * @param {number} [by]
     * @returns {number} running count for this key in the current window
     */
    observe(key, at, by = 1) {
      const now = at == null ? nowFn() : at;
      rotate(now);
      const next = (counts.get(key) || 0) + by;
      counts.set(key, next);
      return next;
    },
    /**
     * @param {string} key
     * @param {number} [at]
     * @returns {number}
     */
    perSec(key, at) {
      const now = at == null ? nowFn() : at;
      rotate(now);
      return counts.get(key) || 0;
    },
    /** @param {number} [at] @returns {Record<string, number>} */
    snapshot(at) {
      const now = at == null ? nowFn() : at;
      rotate(now);
      /** @type {Record<string, number>} */
      const out = {};
      for (const [k, v] of counts) out[k] = v;
      return out;
    },
    /** Read the current (not-yet-rotated) bucket without triggering a rotate. */
    peek() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const [k, v] of counts) out[k] = v;
      return { epoch, counts: out };
    },
    reset() {
      epoch = null;
      counts = new Map();
    },
  };
}

/**
 * Counts duplicate `seq` frame deliveries — the same seq arriving again, which
 * (in the multi-chat case) means it landed on more than one chat-list socket.
 * Never throws on gaps / non-numeric seq (a resume replay jumps seq values).
 * @param {{ maxRecent?: number }} [options]
 */
export function createSeqDupMeter(options = {}) {
  const maxRecent = Number.isSafeInteger(options.maxRecent) && options.maxRecent > 0
    ? options.maxRecent
    : 64;
  /** @type {Map<string, Set<string>>} seq -> set of socket ids that carried it */
  const recent = new Map();
  let frames = 0;
  let duplicates = 0;
  let crossSocket = 0;

  function keyOf(seq) {
    if (typeof seq === 'number') return Number.isFinite(seq) ? `n:${seq}` : null;
    if (typeof seq === 'string' && seq) return `s:${seq}`;
    return null;
  }

  return {
    /**
     * @param {number | string | null | undefined} seq
     * @param {string | number} [socketId] optional per-connection discriminator
     * @returns {{ isDuplicate: boolean, crossSocket: boolean }}
     */
    observe(seq, socketId) {
      frames += 1;
      const key = keyOf(seq);
      if (key === null) return { isDuplicate: false, crossSocket: false };
      const sock = socketId == null ? '' : String(socketId);
      let seen = recent.get(key);
      if (seen) {
        duplicates += 1;
        let isCross = false;
        if (sock && !seen.has(sock)) {
          isCross = true;
          crossSocket += 1;
          seen.add(sock);
        }
        return { isDuplicate: true, crossSocket: isCross };
      }
      seen = new Set();
      if (sock) seen.add(sock);
      recent.set(key, seen);
      if (recent.size > maxRecent) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
      return { isDuplicate: false, crossSocket: false };
    },
    snapshot() {
      const denom = frames || 1;
      return {
        frames,
        duplicates,
        crossSocket,
        dupPct: Math.round((duplicates / denom) * 1000) / 10,
      };
    },
    reset() {
      recent.clear();
      frames = 0;
      duplicates = 0;
      crossSocket = 0;
    },
  };
}

/**
 * @param {number[]} values
 * @param {number} [q] 0..1 quantile
 * @returns {number}
 */
export function quantile(values, q = 0.5) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return Math.round(sorted[idx]);
}

const EMPTY_WINDOW = () => ({
  sig: [],
  inner: [],
  wire: [],
});

/**
 * The `agentPresence` frame has no `reason` field (only `chatsChanged` does), so
 * its per-reason split uses the frame's own class as the bucket: an initial
 * snapshot vs a live states delta vs a watcher-badge frame. Pure (no DOM), so it
 * is unit-testable.
 * @param {Record<string, unknown> | null | undefined} msg
 * @returns {string}
 */
export function presenceFrameReason(msg) {
  if (!msg || typeof msg !== 'object') return 'unknown';
  if (msg.snapshot === true) return 'snapshot';
  if (Array.isArray(msg.watchers) && msg.watchers.length > 0) return 'watchers';
  if (Array.isArray(msg.cleared) && msg.cleared.length > 0) return 'cleared';
  return 'states';
}

/**
 * Aggregates the per-callsite observations and emits them two ways: a granular
 * traceUiFreeze point for the enumerated render measurements (requirement 2), and
 * ONE `snapshot` rollup per closed 1-second window (rates + dup % + medians) for
 * the throughput columns. All state is created lazily, only after the first
 * observation taken while `active()` is true — so an inactive meter allocates
 * nothing.
 * @param {{
 *   now?: () => number,
 *   trace?: (category: string, event: string, payload?: object) => void,
 *   active?: () => boolean,
 *   windowMs?: number,
 *   category?: string,
 * }} [options]
 */
export function createUiFreezeMetrics(options = {}) {
  const nowFn = options.now || (() => Date.now());
  const trace = options.trace || (() => {});
  const active = options.active || (() => true);
  const windowMs = options.windowMs || 1000;
  const category = options.category || 'sidebar';

  /** @type {ReturnType<typeof createRateWindow> | null} */
  let rate = null;
  /** @type {ReturnType<typeof createSeqDupMeter> | null} */
  let seqDup = null;
  let built = false;
  let curEpoch = null;
  let renderTotal = 0;
  let rebuildTotal = 0;
  let rowsMax = 0;
  /** @type {{ sig: number[], inner: number[], wire: number[] }} */
  let samples = EMPTY_WINDOW();
  const patch = { allCalls: 0, allRows: 0, dirtyCalls: 0, dirtyRows: 0 };

  function build() {
    if (built) return;
    built = true;
    rate = createRateWindow(nowFn, windowMs);
    seqDup = createSeqDupMeter();
    curEpoch = Math.floor(nowFn() / windowMs);
  }

  function pushSample(list, value) {
    list.push(value);
    if (list.length > SAMPLE_CAP) list.shift();
  }

  function emitWindowSnapshot(epochForCounts) {
    if (!rate || !seqDup) return;
    const peeked = rate.peek();
    const dup = seqDup.snapshot();
    trace(category, 'snapshot', {
      windowMs,
      epoch: epochForCounts,
      perSec: peeked.counts,
      renders: { total: renderTotal, rebuilds: rebuildTotal, rowsMax },
      renderMedianMs: {
        signature: quantile(samples.sig, 0.5),
        innerHtml: quantile(samples.inner, 0.5),
        wire: quantile(samples.wire, 0.5),
        p95Signature: quantile(samples.sig, 0.95),
      },
      patch,
      presenceDup: dup,
    });
  }

  /** Advances the tumbling window; emits the just-closed one if it rolled. */
  function touch() {
    if (!active()) return false;
    build();
    const e = Math.floor(nowFn() / windowMs);
    if (curEpoch !== null && e !== curEpoch) {
      emitWindowSnapshot(curEpoch);
      renderTotal = 0;
      rebuildTotal = 0;
      rowsMax = 0;
      samples = EMPTY_WINDOW();
      patch.allCalls = 0;
      patch.allRows = 0;
      patch.dirtyCalls = 0;
      patch.dirtyRows = 0;
      rate.reset();
      seqDup.reset();
      curEpoch = e;
    }
    return true;
  }

  return {
    /** @returns {boolean} whether the inactive guard short-circuited everything */
    allocated() {
      return built;
    },
    /**
     * Requirement 2: the enumerated render points (changed flag, changed segments,
     * signature / innerHTML / wire timings, row count). Emitted granularly AND
     * folded into the window rollup.
     * @param {{
     *   changed: boolean,
     *   changedSegments?: string[],
     *   sigMs: number,
     *   innerMs?: number,
     *   wireMs?: number,
     *   rows?: number,
     *   rebuilt?: boolean,
     * }} r
     */
    recordSidebarRender(r) {
      if (!touch() || !rate) return;
      const rebuilt = r.rebuilt === true;
      renderTotal += 1;
      if (rebuilt) rebuildTotal += 1;
      const rows = typeof r.rows === 'number' ? r.rows : 0;
      if (rows > rowsMax) rowsMax = rows;
      pushSample(samples.sig, r.sigMs);
      if (typeof r.innerMs === 'number') pushSample(samples.inner, r.innerMs);
      if (typeof r.wireMs === 'number') pushSample(samples.wire, r.wireMs);
      rate.observe('render');
      if (rebuilt) rate.observe('render-rebuild');
      trace(category, rebuilt ? 'render-rebuild' : 'render-skip', {
        changed: r.changed === true,
        changedSegments: r.changedSegments || [],
        sigMs: Math.round(r.sigMs),
        innerMs: Math.round(r.innerMs || 0),
        wireMs: Math.round(r.wireMs || 0),
        rows,
      });
    },
    /** Requirement 3a: notifySidebar() calls per second. */
    recordNotifySidebar() {
      if (!touch() || !rate) return;
      rate.observe('notifySidebar');
    },
    /** Requirement 3b: rows rewritten in updateSidebarChatStates (patchAll vs per-dirty). */
    recordSidebarPatch({ patchAll, rows }) {
      if (!touch() || !rate) return;
      const n = typeof rows === 'number' ? rows : 0;
      rate.observe(patchAll ? 'patchAll' : 'perDirty');
      if (patchAll) {
        patch.allCalls += 1;
        patch.allRows += n;
      } else {
        patch.dirtyCalls += 1;
        patch.dirtyRows += n;
      }
      trace(category, 'sidebar-patch', { patchAll: patchAll === true, rows: n });
    },
    /** Requirement 4a + 4c: agentPresence frames/sec split by reason, plus seq duplicates. */
    recordPresenceFrame({ reason, seq, socketId }) {
      if (!touch() || !rate || !seqDup) return;
      const bucket = 'presence:' + (reason || 'none');
      rate.observe(bucket);
      rate.observe('presence');
      const dup = seqDup.observe(seq, socketId);
      if (dup.isDuplicate) {
        rate.observe('presenceDup:' + (reason || 'none'));
        trace(category, 'presence-dup', { reason: reason || 'none', seq, crossSocket: dup.crossSocket });
      }
    },
    /** Requirement 4b: chatsChanged frames/sec split by reason. */
    recordChatsChangedFrame({ reason }) {
      if (!touch() || !rate) return;
      rate.observe('chatsChanged:' + (reason || 'none'));
      rate.observe('chatsChanged');
      trace(category, 'chats-changed', { reason: reason || 'none' });
    },
    /** Force-emit the current (unclosed) window — used by the 60s scenario wrap-up. */
    flush() {
      if (!built) return;
      emitWindowSnapshot(curEpoch);
    },
  };
}

/** @type {ReturnType<typeof createUiFreezeMetrics> | null} */
let shared = null;

/**
 * Shared meter so every view (sidebar / chat / transport / live-sync) folds into
 * ONE aggregated snapshot. Returns null when the trace flag is off — callers must
 * still guard at their own callsite (requirement 5), this is defense in depth.
 * @returns {ReturnType<typeof createUiFreezeMetrics> | null}
 */
export function getUiFreezeMetrics() {
  if (!isUiFreezeTraceActive()) return null;
  if (!shared) {
    shared = createUiFreezeMetrics({
      trace: (category, event, payload) => traceUiFreeze(category, event, payload),
      active: isUiFreezeTraceActive,
    });
  }
  return shared;
}
