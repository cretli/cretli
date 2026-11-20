/**
 * MCP resource invariants (observation only; nothing here closes a connection).
 *
 * Child processes of the server are grouped by program name and compared with
 * the number of live connection owners. A detector turns a short series of
 * samples into alarms:
 *   - threshold: too many children, too much RSS, or ownerless pool entries
 *     persisting over the whole window;
 *   - growth: children grow over K samples while live owners do not;
 *   - rss-growth: the child count is constant but total RSS keeps rising.
 * Measuring is platform dependent; an unsupported platform yields `unknown`
 * and never an alarm or an exception.
 */
import { execFile, execFileSync } from 'node:child_process';
import { snapshotPoolEntries } from '../mcp/mcp-runtime.js';
import { classifyOwner, listLiveOwners } from '../mcp/mcp-owner-registry.js';

export const MCP_INVARIANT_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  window: 5,
  maxChildren: 40,
  maxRssKb: 2 * 1024 * 1024,
  rssGrowthKb: 100 * 1024,
  rssGrowthRatio: 0.2,
});

const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin']);

/**
 * @param {string} psOutput `ps -eo pid=,ppid=,rss=,comm=` rows
 * @param {number} rootPid
 * @returns {{ children: number, rssKb: number, byProgram: Record<string, { count: number, rssKb: number }> }}
 */
export function summarizeChildren(psOutput, rootPid) {
  /** @type {Map<number, { pid: number, rss: number, name: string }[]>} */
  const byParent = new Map();
  for (const line of String(psOutput || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid)?.push({ pid: Number(m[1]), rss: Number(m[3]), name: m[4].trim() });
  }
  const byProgram = /** @type {Record<string, { count: number, rssKb: number }>} */ ({});
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  let children = 0;
  let rssKb = 0;
  while (queue.length) {
    for (const child of byParent.get(/** @type {number} */ (queue.shift())) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const row = byProgram[child.name] || (byProgram[child.name] = { count: 0, rssKb: 0 });
      row.count += 1;
      row.rssKb += child.rss;
      children += 1;
      rssKb += child.rss;
      queue.push(child.pid);
    }
  }
  return { children, rssKb, byProgram };
}

/**
 * @param {{ platform?: string, rootPid?: number, exec?: (cmd: string, args: string[]) => string }} [options]
 * @returns {{ state: 'ok', children: number, rssKb: number, byProgram: Record<string, { count: number, rssKb: number }> } | { state: 'unknown', reason: string }}
 */
export function measureProcessGroup(options = {}) {
  const platform = options.platform || process.platform;
  if (!SUPPORTED_PLATFORMS.has(platform)) return { state: 'unknown', reason: 'unsupported-platform' };
  const exec = options.exec || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }));
  try {
    const out = exec('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
    return { state: 'ok', ...summarizeChildren(out, options.rootPid || process.pid) };
  } catch {
    return { state: 'unknown', reason: 'measure-failed' };
  }
}

/**
 * Same as measureProcessGroup but runs `ps` off the event loop. The periodic
 * observer uses this: a synchronous `ps` on a loaded host blocks every request.
 *
 * @param {{ platform?: string, rootPid?: number }} [options]
 * @returns {Promise<ReturnType<typeof measureProcessGroup>>}
 */
export function measureProcessGroupAsync(options = {}) {
  const platform = options.platform || process.platform;
  if (!SUPPORTED_PLATFORMS.has(platform)) return Promise.resolve({ state: 'unknown', reason: 'unsupported-platform' });
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ state: 'unknown', reason: 'measure-failed' });
      try {
        resolve({ state: 'ok', ...summarizeChildren(String(out), options.rootPid || process.pid) });
      } catch {
        resolve({ state: 'unknown', reason: 'measure-failed' });
      }
    });
  });
}

/**
 * @typedef {{ at: number, children: number, rssKb: number, owners: number, ownerless: number }} InvariantSample
 */

/**
 * @param {InvariantSample[]} samples oldest first
 * @param {Partial<typeof MCP_INVARIANT_DEFAULTS>} [config]
 * @returns {{ kind: 'threshold' | 'ownerless' | 'growth' | 'rss-growth', message: string }[]}
 */
export function detectMcpInvariantAlarms(samples, config = {}) {
  const cfg = { ...MCP_INVARIANT_DEFAULTS, ...config };
  const alarms = [];
  const last = samples[samples.length - 1];
  if (!last) return alarms;
  if (last.children > cfg.maxChildren || last.rssKb > cfg.maxRssKb) {
    alarms.push({ kind: 'threshold', message: `child processes ${last.children}, rss ${Math.round(last.rssKb / 1024)} MiB over limit` });
  }
  const win = samples.slice(-cfg.window);
  if (win.length < cfg.window) return alarms;
  const first = win[0];
  if (win.every((s) => s.ownerless > 0)) {
    alarms.push({ kind: 'ownerless', message: `${last.ownerless} pooled connection(s) without a live owner for ${win.length} samples` });
  }
  const nonDecreasing = (key) => win.every((s, i) => i === 0 || s[key] >= win[i - 1][key]);
  if (nonDecreasing('children') && last.children > first.children && last.owners <= first.owners) {
    alarms.push({ kind: 'growth', message: `child processes ${first.children} -> ${last.children} while live owners ${first.owners} -> ${last.owners}` });
  }
  if (
    win.every((s) => s.children === first.children) &&
    nonDecreasing('rssKb') &&
    last.rssKb - first.rssKb >= cfg.rssGrowthKb &&
    last.rssKb >= first.rssKb * (1 + cfg.rssGrowthRatio)
  ) {
    alarms.push({ kind: 'rss-growth', message: `rss ${Math.round(first.rssKb / 1024)} -> ${Math.round(last.rssKb / 1024)} MiB with constant child count` });
  }
  return alarms;
}

/**
 * Periodic observer. Keeps the latest report in memory for the authorized API.
 *
 * @param {{ env?: NodeJS.ProcessEnv, measure?: typeof measureProcessGroup, onAlarm?: (alarm: { kind: string, message: string }) => void }} [options]
 */
export function createMcpResourceObserver(options = {}) {
  const env = options.env || process.env;
  const measure = options.measure || measureProcessGroup;
  const num = (key, fallback) => {
    const n = Number(env[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const config = {
    ...MCP_INVARIANT_DEFAULTS,
    window: Math.floor(num('CRETLI_MCP_OBSERVER_WINDOW', MCP_INVARIANT_DEFAULTS.window)),
    maxChildren: num('CRETLI_MCP_OBSERVER_MAX_CHILDREN', MCP_INVARIANT_DEFAULTS.maxChildren),
  };
  /** @type {InvariantSample[]} */
  const samples = [];
  let report = /** @type {Record<string, any>} */ ({ state: 'unknown', reason: 'not-sampled', alarms: [] });
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const alarmed = new Set();

  /**
   * @param {number} [now]
   * @param {ReturnType<typeof measureProcessGroup>} [measured] a pre-taken measurement (the timer measures asynchronously)
   */
  function sample(now = Date.now(), measured) {
    const proc = measured || measure();
    const owners = listLiveOwners();
    const pool = snapshotPoolEntries();
    const states = pool.map((entry) => classifyOwner(entry, owners));
    const ownerless = states.filter((s) => s === 'ownerless').length;
    const unknownOwners = states.filter((s) => s === 'unknown').length;
    if (proc.state !== 'ok') {
      report = { state: 'unknown', reason: proc.reason, at: now, alarms: [], pool: { entries: pool.length, ownerless, unknownOwners } };
      return report;
    }
    samples.push({ at: now, children: proc.children, rssKb: proc.rssKb, owners: owners.length, ownerless });
    if (samples.length > config.window * 2) samples.splice(0, samples.length - config.window * 2);
    const alarms = detectMcpInvariantAlarms(samples, /** @type {any} */ (config));
    report = {
      state: 'ok',
      at: now,
      alarms,
      children: proc.children,
      rssKb: proc.rssKb,
      byProgram: proc.byProgram,
      owners: owners.length,
      pool: { entries: pool.length, ownerless, unknownOwners },
    };
    for (const alarm of alarms) {
      if (alarmed.has(alarm.kind)) continue;
      alarmed.add(alarm.kind);
      options.onAlarm?.(alarm);
    }
    for (const kind of [...alarmed]) if (!alarms.some((a) => a.kind === kind)) alarmed.delete(kind);
    return report;
  }

  function start() {
    if (timer || env.CRETLI_MCP_OBSERVER === '0') return false;
    timer = setInterval(() => {
      // An injected `measure` (tests) stays synchronous; the real one runs `ps` asynchronously.
      if (options.measure) {
        try { sample(); } catch { /* observation must never break the server */ }
        return;
      }
      void measureProcessGroupAsync().then((measured) => {
        try { sample(Date.now(), measured); } catch { /* observation must never break the server */ }
      });
    }, num('CRETLI_MCP_OBSERVER_MS', MCP_INVARIANT_DEFAULTS.intervalMs));
    timer.unref?.();
    return true;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return {
    sample,
    start,
    stop,
    getReport: () => report,
    /** Bare flag for the public health payload. `unknown` is never an alarm. */
    hasAlarm: () => report.state === 'ok' && report.alarms.length > 0,
  };
}
