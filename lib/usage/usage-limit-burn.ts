/**
 * Limit-burn attribution: for every usage-limit hit, which chats or delegations
 * consumed the harness's fresh tokens in the window just before it.
 *
 * Plan limits are enforced per account and rolling window, so the culprits are
 * all same-harness consumers inside the look-back, not only the run that was
 * rejected. Retry storms are collapsed: hits of one harness|model closer than
 * `clusterGapMs` count as a single hit. No I/O.
 */

import { summarizeUsageGroup } from './usage-top.ts';

export const LIMIT_BURN_DEFAULT_LOOKBACK_MS = 5 * 60 * 60 * 1000;
export const LIMIT_BURN_CLUSTER_GAP_MS = 10 * 60 * 1000;
export const LIMIT_BURN_DEFAULT_TOP = 5;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Index of the first entry with `ms > bound` in a list sorted by `ms`.
 *
 * @param {Array<{ ms: number }>} list
 * @param {number} bound
 * @returns {number}
 */
function firstAfter(list: Array<{ ms: number }>, bound: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ms > bound) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * @param {Record<string, any>[]} events
 * @param {number} clusterGapMs
 * @returns {Array<{ harness: string, model: string, atMs: number, hits: number }>}
 */
export function clusterLimitHits(events, clusterGapMs = LIMIT_BURN_CLUSTER_GAP_MS) {
  const hits = events
    .filter((e) => e && e.eventType === 'run' && e.outcome === 'limit')
    .map((e) => ({ harness: text(e.harness) || 'other', model: text(e.model) || 'unknown', atMs: Date.parse(text(e.at)) }))
    .filter((h) => Number.isFinite(h.atMs))
    .sort((a, b) => a.atMs - b.atMs);
  const clusters = [];
  const last = new Map();
  for (const hit of hits) {
    const key = `${hit.harness}|${hit.model}`;
    const prev = last.get(key);
    if (prev && hit.atMs - prev.lastMs <= clusterGapMs) {
      prev.cluster.hits += 1;
      prev.lastMs = hit.atMs;
      continue;
    }
    const cluster = { ...hit, hits: 1 };
    clusters.push(cluster);
    last.set(key, { cluster, lastMs: hit.atMs });
  }
  return clusters;
}

/**
 * @param {{
 *   events: Record<string, any>[],
 *   lookbackMs?: number,
 *   top?: number,
 *   labels?: Map<string, string>,
 * }} input
 * @returns {{ lookbackMs: number, clusters: number, rawHits: number, recent: Record<string, any>[], culprits: Record<string, any>[] }}
 */
export function attributeLimitBurn(input: Partial<{ events: Record<string, any>[], lookbackMs?: number, top?: number, labels?: Map<string, string> }> = {}) {
  const events = Array.isArray(input.events) ? input.events.filter((e) => e && typeof e === 'object') : [];
  const lookbackMs = Number.isFinite(input.lookbackMs) && input.lookbackMs > 0 ? input.lookbackMs : LIMIT_BURN_DEFAULT_LOOKBACK_MS;
  const top = Number.isInteger(input.top) && input.top > 0 ? input.top : LIMIT_BURN_DEFAULT_TOP;
  const clusters = clusterLimitHits(events);
  // Parse each event once and index it per harness by time, so every cluster
  // slices its look-back window instead of rescanning the whole ledger.
  const byHarness = new Map();
  for (const e of events) {
    if (e.eventType === 'run') continue;
    const ms = Date.parse(text(e.at));
    if (!Number.isFinite(ms)) continue;
    const harness = text(e.harness) || 'other';
    (byHarness.get(harness) || byHarness.set(harness, []).get(harness)).push({ ms, e });
  }
  for (const list of byHarness.values()) list.sort((a, b) => a.ms - b.ms);
  const overall = new Map();
  const recent = clusters.map((cluster) => {
    const list = byHarness.get(cluster.harness) || [];
    const inWindow = list
      .slice(firstAfter(list, cluster.atMs - lookbackMs), firstAfter(list, cluster.atMs))
      .map((entry) => entry.e);
    const byChat = new Map();
    for (const e of inWindow) {
      const key = text(e.chatId) || '(no chat)';
      (byChat.get(key) || byChat.set(key, []).get(key)).push(e);
    }
    const total = summarizeUsageGroup(inWindow).fresh;
    const culprits = [...byChat]
      .map(([chatId, list]) => ({ chatId, label: input.labels?.get(chatId) || null, fresh: summarizeUsageGroup(list).fresh }))
      .sort((a, b) => b.fresh - a.fresh);
    for (const c of culprits) {
      const agg = overall.get(`${cluster.harness}|${c.chatId}`) || { harness: cluster.harness, chatId: c.chatId, label: c.label, fresh: 0, hitsBlamed: 0 };
      agg.fresh += c.fresh;
      agg.hitsBlamed += 1;
      overall.set(`${cluster.harness}|${c.chatId}`, agg);
    }
    return {
      at: new Date(cluster.atMs).toISOString(),
      harness: cluster.harness,
      model: cluster.model,
      hits: cluster.hits,
      freshInLookback: total,
      topChats: culprits.slice(0, 3).map((c) => ({ ...c, share: total > 0 ? Number((c.fresh / total).toFixed(4)) : null })),
    };
  });
  return {
    lookbackMs,
    clusters: clusters.length,
    rawHits: clusters.reduce((sum, c) => sum + c.hits, 0),
    recent: recent.slice(-20).reverse(),
    culprits: [...overall.values()].sort((a, b) => b.fresh - a.fresh).slice(0, top),
  };
}
