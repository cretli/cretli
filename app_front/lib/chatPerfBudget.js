/**
 * Opt-in chat performance budgets for UI freeze diag.
 * Callers skip every entry point when the flag is off, so this module
 * allocates nothing on the steady path. Thresholds are starting points
 * for a phone trace — they do not change rendering or polling.
 */

export const MARKDOWN_FLUSH_BUDGET_MS = 32;
export const MARKDOWN_CHARS_BUDGET = 20000;
export const HISTORY_BUDGET_MS = 100;
export const HISTORY_SYNC_CARDS_BUDGET = 40;
export const STREAM_CHILDREN_BUDGET = 160;
export const HTTP_BURST_COUNT = 8;
export const HTTP_BURST_WINDOW_MS = 2000;
export const HTTP_SLOW_MS = 800;
export const LONG_TASK_RESUME_MS = 50;
export const LONG_TASK_IDLE_MS = 200;

const RECENT_SPAN_CAP = 32;
const REPEAT_REPORT_MS = 2000;
const RENDER_KINDS = new Set([
  'markdown.flush',
  'history.replay',
  'history.prepend',
  'stream.children',
]);
const REPEAT_CODES = new Set([
  'markdown.flush',
  'history.replay',
  'history.prepend',
  'stream.children',
  'ws.replayBatch',
]);

/**
 * @typedef {object} BudgetViolation
 * @property {string} code
 * @property {string} message
 * @property {Record<string, unknown>} fields
 */

/**
 * @typedef {object} HttpLedgerEntry
 * @property {number} at
 * @property {string} method
 * @property {string} path
 * @property {number} elapsedMs
 * @property {number} status
 */

/**
 * @returns {number}
 */
export function monoNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Path only — query strings would split one endpoint into many buckets.
 * @param {string} url
 * @returns {string}
 */
export function normalizeApiPath(url) {
  const raw = String(url || '');
  if (!raw) return '/';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      return new URL(raw).pathname || '/';
    } catch {
      // Fall through to the query split.
    }
  }
  const withoutHash = raw.split('#')[0];
  return withoutHash.split('?')[0] || '/';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} fields
 * @returns {BudgetViolation}
 */
function violation(code, message, fields) {
  return { code, message, fields };
}

/**
 * Pure budget check. Returns every broken threshold for this sample.
 * @param {Record<string, unknown> | null | undefined} sample
 * @returns {BudgetViolation[]}
 */
export function evaluateBudget(sample) {
  if (!sample || typeof sample !== 'object') return [];
  /** @type {BudgetViolation[]} */
  const violations = [];
  const kind = String(sample.kind || '');
  const durationMs = asNumber(sample.durationMs);
  const chars = asNumber(sample.chars);
  const cards = asNumber(sample.cards);
  const events = asNumber(sample.events);
  const children = asNumber(sample.children);
  if (kind === 'markdown.flush' && (durationMs > MARKDOWN_FLUSH_BUDGET_MS || chars > MARKDOWN_CHARS_BUDGET)) {
    violations.push(violation(
      'markdown.flush',
      `markdown.flush ${Math.round(durationMs)}ms chars=${chars} children=${children}`,
      { durationMs: Math.round(durationMs), chars, children },
    ));
  }
  if ((kind === 'history.replay' || kind === 'history.prepend')
    && (durationMs > HISTORY_BUDGET_MS || cards > HISTORY_SYNC_CARDS_BUDGET)) {
    violations.push(violation(
      kind,
      `${kind} ${Math.round(durationMs)}ms cards=${cards} children=${children}`,
      { durationMs: Math.round(durationMs), cards, children },
    ));
  }
  if (kind === 'ws.replayBatch' && (durationMs > HISTORY_BUDGET_MS || events > HISTORY_SYNC_CARDS_BUDGET)) {
    violations.push(violation(
      'ws.replayBatch',
      `ws.replayBatch ${Math.round(durationMs)}ms events=${events}`,
      { durationMs: Math.round(durationMs), events },
    ));
  }
  if (RENDER_KINDS.has(kind) && children > STREAM_CHILDREN_BUDGET) {
    violations.push(violation(
      'stream.children',
      `stream.children ${children}`,
      { children },
    ));
  }
  if (kind === 'longtask') {
    const inResumeWindow = sample.inResumeWindow === true;
    const limit = inResumeWindow ? LONG_TASK_RESUME_MS : LONG_TASK_IDLE_MS;
    if (durationMs >= limit) {
      const span = String(sample.span || 'idle');
      violations.push(violation(
        'longtask',
        `longtask ${Math.round(durationMs)}ms span=${span}`,
        { durationMs: Math.round(durationMs), span, inResumeWindow },
      ));
    }
  }
  if (kind === 'http.slow' && durationMs > HTTP_SLOW_MS) {
    const method = String(sample.method || 'GET');
    const path = String(sample.path || '');
    violations.push(violation(
      'http.slow',
      `http.slow ${method} ${path} ${Math.round(durationMs)}ms`,
      { method, path, elapsedMs: Math.round(durationMs), status: asNumber(sample.status) },
    ));
  }
  if (kind === 'http.burst' && asNumber(sample.httpCount) > HTTP_BURST_COUNT) {
    const count = asNumber(sample.httpCount);
    const windowMs = asNumber(sample.httpWindowMs) || HTTP_BURST_WINDOW_MS;
    const seconds = Math.max(1, Math.round(windowMs / 1000));
    const slowestLabel = String(sample.slowestLabel || 'none');
    const slowestMs = Math.round(asNumber(sample.slowestMs));
    violations.push(violation(
      'http.burst',
      `http-burst ${count}/${seconds}s slowest=${slowestLabel} ${slowestMs}ms`,
      { httpCount: count, httpWindowMs: windowMs, slowestLabel, slowestMs },
    ));
  }
  return violations;
}

/**
 * Sliding window of completed /api/ calls.
 * @param {{ now?: () => number, windowMs?: number }} [options]
 */
export function createRequestLedger(options = {}) {
  const nowFn = options.now || (() => Date.now());
  const windowMs = options.windowMs || HTTP_BURST_WINDOW_MS;
  /** @type {HttpLedgerEntry[]} */
  let entries = [];
  let burstOpen = false;

  /**
   * @param {number} at
   */
  function prune(at) {
    const cutoff = at - windowMs;
    entries = entries.filter((entry) => entry.at > cutoff);
  }

  /**
   * @param {HttpLedgerEntry[]} rows
   * @returns {HttpLedgerEntry | null}
   */
  function slowestOf(rows) {
    let best = null;
    for (const entry of rows) {
      if (!best || entry.elapsedMs > best.elapsedMs) best = entry;
    }
    return best;
  }

  return {
    windowMs,
    /**
     * @param {{ at?: number, method?: string, path?: string, elapsedMs?: number, status?: number }} sample
     * @returns {{ count: number, violations: BudgetViolation[], slowest: HttpLedgerEntry | null }}
     */
    record(sample) {
      const at = sample?.at == null ? nowFn() : asNumber(sample.at);
      prune(at);
      if (entries.length <= HTTP_BURST_COUNT) burstOpen = false;
      /** @type {HttpLedgerEntry} */
      const entry = {
        at,
        method: String(sample?.method || 'GET').toUpperCase(),
        path: normalizeApiPath(sample?.path || ''),
        elapsedMs: Math.round(asNumber(sample?.elapsedMs)),
        status: asNumber(sample?.status),
      };
      entries.push(entry);
      /** @type {BudgetViolation[]} */
      const violations = [];
      const slow = evaluateBudget({
        kind: 'http.slow',
        durationMs: entry.elapsedMs,
        method: entry.method,
        path: entry.path,
        status: entry.status,
      });
      violations.push(...slow);
      if (entries.length > HTTP_BURST_COUNT && !burstOpen) {
        burstOpen = true;
        const slowest = slowestOf(entries);
        const burst = evaluateBudget({
          kind: 'http.burst',
          httpCount: entries.length,
          httpWindowMs: windowMs,
          slowestLabel: slowest ? `${slowest.method} ${slowest.path}` : 'none',
          slowestMs: slowest ? slowest.elapsedMs : 0,
        });
        violations.push(...burst);
      }
      return { count: entries.length, violations, slowest: slowestOf(entries) };
    },
    reset() {
      entries = [];
      burstOpen = false;
    },
  };
}

/** @type {Array<{ name: string, fields: Record<string, unknown>, startedAt: number }>} */
const openSpans = [];
/** @type {Array<{ name: string, startedAt: number, endedAt: number }>} */
const recentSpans = [];
/** @type {{ name: string, endedAt: number } | null} */
let lastClosedSpan = null;
/** @type {((violation: BudgetViolation) => void) | null} */
let reporter = null;
/** @type {Map<string, number>} */
const lastReportAt = new Map();
const httpLedger = createRequestLedger();

/**
 * @param {(violation: BudgetViolation) => void} fn
 */
export function setChatPerfReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null;
}

/**
 * @param {BudgetViolation} item
 * @param {number} [now]
 */
function reportViolation(item, now = Date.now()) {
  if (REPEAT_CODES.has(item.code)) {
    const previous = lastReportAt.get(item.code) || 0;
    if (now - previous < REPEAT_REPORT_MS) return;
    lastReportAt.set(item.code, now);
  }
  if (reporter) reporter(item);
}

/**
 * @param {Record<string, unknown>} sample
 * @param {number} [now]
 * @returns {BudgetViolation[]}
 */
export function observeSample(sample, now = Date.now()) {
  const violations = evaluateBudget(sample);
  for (const item of violations) reportViolation(item, now);
  return violations;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [fields]
 */
export function beginSpan(name, fields = {}) {
  const span = {
    name: String(name || 'span'),
    fields: fields && typeof fields === 'object' ? fields : {},
    startedAt: monoNow(),
  };
  openSpans.push(span);
  return span;
}

/**
 * @returns {{ name: string, startedAt: number, endedAt: number, durationMs: number, fields: Record<string, unknown> } | null}
 */
export function endSpan() {
  const span = openSpans.pop();
  if (!span) return null;
  const endedAt = monoNow();
  const closed = {
    name: span.name,
    startedAt: span.startedAt,
    endedAt,
    durationMs: endedAt - span.startedAt,
    fields: span.fields,
  };
  lastClosedSpan = closed;
  recentSpans.push(closed);
  if (recentSpans.length > RECENT_SPAN_CAP) recentSpans.shift();
  return closed;
}

/**
 * @returns {string}
 */
export function currentSpanName() {
  if (openSpans.length === 0) return 'idle';
  return openSpans[openSpans.length - 1].name;
}

/**
 * Span that overlapped a long-task interval (performance.now clock).
 * Prefers a still-open span, otherwise the most recently closed overlap.
 * @param {number} startMs
 * @param {number} durationMs
 * @returns {string}
 */
export function spanDuring(startMs, durationMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) return currentSpanName();
  const endMs = startMs + Math.max(0, durationMs);
  /** @type {{ name: string, startedAt: number } | null} */
  let best = null;
  for (const span of openSpans) {
    if (span.startedAt > endMs) continue;
    if (!best || span.startedAt >= best.startedAt) best = span;
  }
  for (const span of recentSpans) {
    if (span.startedAt > endMs || span.endedAt < startMs) continue;
    if (!best || span.startedAt >= best.startedAt) best = span;
  }
  return best ? best.name : 'idle';
}

/**
 * Span still open, or the one that closed within `withinMs` (a stall often
 * ends the span before the timer tick runs).
 * @param {number} [withinMs]
 * @returns {string}
 */
export function recentSpanName(withinMs = 0) {
  if (openSpans.length > 0) return openSpans[openSpans.length - 1].name;
  if (!lastClosedSpan) return 'idle';
  if (monoNow() - lastClosedSpan.endedAt <= Math.max(0, withinMs)) return lastClosedSpan.name;
  return 'idle';
}

/**
 * Times `fn` while diag is on. Callers must not call this when the flag is off.
 * @template T
 * @param {string} kind
 * @param {Record<string, unknown>} fields
 * @param {() => T} fn
 * @param {() => Record<string, unknown>} [after]
 * @returns {T}
 */
export function measureSpan(kind, fields, fn, after) {
  beginSpan(kind, fields);
  const startedAt = monoNow();
  try {
    return fn();
  } finally {
    endSpan();
    const extra = typeof after === 'function' ? after() || {} : {};
    observeSample({
      ...(fields || {}),
      ...extra,
      kind,
      durationMs: monoNow() - startedAt,
    });
  }
}

/**
 * @param {{ at?: number, method?: string, path?: string, elapsedMs?: number, status?: number }} sample
 */
export function recordHttpSample(sample) {
  const result = httpLedger.record(sample);
  for (const item of result.violations) reportViolation(item);
  return result;
}

/**
 * Clears span and ledger state. Tests only.
 */
export function resetChatPerfBudget() {
  openSpans.length = 0;
  recentSpans.length = 0;
  lastClosedSpan = null;
  lastReportAt.clear();
  httpLedger.reset();
  reporter = null;
}
