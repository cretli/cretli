/**
 * Priced statistics per (model, role, level) — plan v10 §2.5-2.6.
 *
 * Display/statistics only: nothing here is read by the selection. Inputs are
 * injected (delegation rows, pick records, usage events, benchmark snapshots)
 * so the module is pure and network-free.
 *
 * Money rules (docs/model-scoring-facts.md §3, §11):
 * - USD (`unit: 'usd'`, `is_money: true`) only for `api_metered` pairs and only
 *   from a measured usage-ledger cost or an exact list/catalog rate.
 * - Everything else (subscription, local, unknown billing, tier-table rates)
 *   is the RCU cost proxy (`unit: 'rcu'`, `is_money: false`) and is labelled a
 *   proxy; it is never presented as money.
 * - Each price / cost carries `source` and `captured_at`.
 */

import { decodeModelValue } from './model-catalog.js';
import { billingClassOfCandidate } from './model-pick-billing-class.js';
import { buildBenchmarkShadowIndex, scoreCandidateBenchmark } from './model-pick-benchmark.js';
import { COMPLEXITY_LEVELS } from './model-pick-complexity.js';
import {
  collectTokenSamples,
  estimateCostProxy,
  normalizeCostProxyConfig,
} from './model-pick-cost-proxy.js';
import {
  baseModelOfRow,
  delegationPersistedRole,
  isInfraDelegationOutcome,
  rowExecutor,
} from './model-pick-history.js';
import { parseDelegationVerdict } from './delegation-verdict.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { delegationController } from './delegation-control.js';
import { resolveHarnessProvider } from './usage/harness-usage.ts';
import { TOKEN_RATES_CAPTURED_AT } from './usage/usage-rates.js';
import { ARTIFICIAL_ANALYSIS_ATTRIBUTION } from './benchmark-source-registry.js';

export const PRICED_STATS_SCHEMA_VERSION = 'model-priced-stats-2026-10-14';

/** Level used when a delegation has no persisted complexity. */
export const PRICED_STATS_UNKNOWN_LEVEL = 'unknown';

export const PRICED_STATS_LEVELS = Object.freeze([...COMPLEXITY_LEVELS, PRICED_STATS_UNKNOWN_LEVEL]);

/** Credit required by the Artificial Analysis free API terms. */
export const PRICED_STATS_ATTRIBUTION = Object.freeze({
  text: ARTIFICIAL_ANALYSIS_ATTRIBUTION,
  url: 'https://artificialanalysis.ai/',
});

/**
 * Delegation row fields read here, on top of the shared history row.
 *
 * @typedef {import('./model-pick-history.js').ModelPickHistoryRow & {
 *   pickId?: string,
 *   complexity?: { level?: string },
 *   complexityLevel?: string,
 *   controllerChatId?: unknown,
 *   parentChatId?: unknown,
 *   metrics?: { tokens_in?: number, tokens_out?: number } | null,
 *   attempt?: number,
 *   retryCount?: number,
 *   warnings?: unknown,
 *   modelWarnings?: unknown,
 * }} ModelPickPricedStatsRow
 */

/**
 * @typedef {object} ModelPickPricedStatsPick Persisted pick record fields read here.
 * @property {string} [id]
 * @property {{ level?: string }} [complexity]
 */

/**
 * @typedef {object} ModelPickPricedStatsUsageEvent
 * @property {string} [delegationId]
 * @property {number | null} [usd]
 * @property {boolean} [estimated]
 * @property {string} [eventType]
 * @property {string} [at]
 */

/**
 * @typedef {object} ModelPickPricedStatsPrice
 * @property {string} unit
 * @property {boolean} is_money
 * @property {number | null} input
 * @property {number | null} output
 * @property {string} source
 * @property {string | null} captured_at
 * @property {string} basis
 * @property {boolean} estimated
 * @property {string} billing_class
 */

/**
 * @typedef {object} ModelPickPricedStatsBenchmarkBlock
 * @property {string} status
 * @property {number | null} benchmark_score
 * @property {string | null} source
 * @property {string | null} captured_at
 * @property {boolean} stale
 * @property {string | null} attribution
 */

/**
 * @typedef {object} ModelPickPricedStatsCostPerPass
 * @property {number | null} value
 * @property {string} unit
 * @property {boolean} is_money
 * @property {string} source
 * @property {string | null} captured_at
 * @property {string} basis
 * @property {string} [token_source]
 * @property {number} n_cost_rows
 * @property {number} n_pass
 */

/**
 * @typedef {object} ModelPickPricedStatsLevelRow
 * @property {string} harness
 * @property {string} model
 * @property {string} role
 * @property {string} level
 * @property {string} billing_class
 * @property {number} n
 * @property {number | null} usable_rate
 * @property {number | null} infra_fail_rate
 * @property {number | null} completion_rate
 * @property {number} decided
 * @property {number} passes
 * @property {number | null} median_min
 * @property {number | null} median_tokens_in
 * @property {number | null} median_tokens_out
 * @property {number} retries
 * @property {number} model_downgraded
 * @property {number} effort_unavailable
 * @property {{ measured_usd: object | null, cost_proxy: object }} cost
 * @property {ModelPickPricedStatsCostPerPass | null} cost_per_pass
 * @property {ModelPickPricedStatsPrice} price_per_1m
 * @property {ModelPickPricedStatsBenchmarkBlock} benchmark
 */

/**
 * @typedef {object} ModelPickPricedStatsModelRole
 * @property {string} harness
 * @property {string} model
 * @property {string} role
 * @property {string} billing_class
 * @property {ModelPickPricedStatsCostPerPass | null} cost_per_pass
 * @property {ModelPickPricedStatsPrice} price_per_1m
 * @property {ModelPickPricedStatsBenchmarkBlock} benchmark
 */

const MAX_GROUPS = 400;
const PRICE_SOURCE_LABEL = Object.freeze({
  openrouter_pricing: 'openrouter_pricing',
  token_rates: 'token_rates',
});

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseTime(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * @param {number | null} value
 * @param {number} [digits]
 * @returns {number | null}
 */
function round(value, digits = 4) {
  return value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Complexity level of one delegation: the persisted pick record first, then a
 * level carried on the row itself; `unknown` otherwise.
 *
 * @param {Record<string, any>} row
 * @param {Map<string, Record<string, any>>} picksById
 * @returns {string}
 */
export function levelOfDelegation(row, picksById) {
  const pickId = String(row?.pickId || '').trim();
  const fromPick = pickId ? String(picksById.get(pickId)?.complexity?.level || '').trim().toLowerCase() : '';
  const fromRow = String(row?.complexity?.level || row?.complexityLevel || '').trim().toLowerCase();
  const level = fromPick || fromRow;
  return COMPLEXITY_LEVELS.includes(level) ? level : PRICED_STATS_UNKNOWN_LEVEL;
}

/**
 * Per-million price of one pair, with provenance and money labelling.
 *
 * @param {{
 *   harness: string,
 *   model: string,
 *   role?: string,
 *   billingClass?: string,
 *   samples?: ReturnType<typeof collectTokenSamples>,
 *   config?: ReturnType<typeof normalizeCostProxyConfig>,
 *   openrouterPricingFor?: (model: string) => any,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildPricePer1m(input) {
  const harness = String(input.harness || '').trim().toLowerCase();
  const fullModel = String(input.model || '').trim();
  const billingClass = input.billingClass
    || billingClassOfCandidate({ harness }, { provider: resolveHarnessProvider(harness) });
  const samples = input.samples || { byModelRoleLevel: new Map(), byModelRole: new Map(), byRole: new Map() };
  const baseModel = String(decodeModelValue(fullModel).modelId || fullModel).trim();
  const pricing = typeof input.openrouterPricingFor === 'function'
    && resolveHarnessProvider(harness) === 'openrouter'
    ? input.openrouterPricingFor(baseModel)
    : null;
  const estimate = estimateCostProxy({
    harness,
    model: fullModel,
    role: input.role || 'implement',
    level: PRICED_STATS_UNKNOWN_LEVEL,
    samples,
    config: input.config,
    openrouterPricingFor: input.openrouterPricingFor,
  });
  if (!estimate.rates) {
    return {
      unit: 'rcu',
      is_money: false,
      input: null,
      output: null,
      source: 'none',
      captured_at: null,
      basis: 'empty',
      estimated: false,
      billing_class: billingClass,
    };
  }
  const exactSource = estimate.basis === 'rate' ? String(estimate.rateSource || '') : '';
  const isMoney = billingClass === 'api_metered' && estimate.basis === 'rate';
  let capturedAt = null;
  if (exactSource === 'openrouter_pricing') capturedAt = pricing?.fetched_at || pricing?.observed_at || null;
  else if (exactSource === 'token_rates') capturedAt = TOKEN_RATES_CAPTURED_AT;
  return {
    unit: isMoney ? 'usd' : 'rcu',
    is_money: isMoney,
    input: round(estimate.rates.input),
    output: round(estimate.rates.output),
    source: PRICE_SOURCE_LABEL[exactSource] || (estimate.basis === 'tier_table' ? 'tier_table' : exactSource),
    captured_at: capturedAt,
    basis: estimate.basis,
    // The static table marks vendor list prices that may change as estimates.
    estimated: estimate.basis !== 'rate' || exactSource === 'token_rates',
    billing_class: billingClass,
  };
}

/**
 * Pass flags per delegation id (see docs/model-pick-decisions.md "Priced
 * statistics"). implement: every review of its cycle PASSes; review: a parsed
 * PASS/FAIL verdict on a non-infra job; plan: completed non-infra job with a
 * report. A job with no judgement yet is neither pass nor fail (`decided`
 * false) and stays out of the cost_per_pass denominator.
 *
 * @param {Record<string, any>[]} rows terminal, in-window rows
 * @returns {Map<string, { pass: boolean, decided: boolean }>}
 */
function resolvePassFlags(rows) {
  /** @type {Map<string, { pass: boolean, decided: boolean }>} */
  const flags = new Map();
  /** @type {Map<string, Record<string, any>[]>} */
  const byChat = new Map();
  for (const row of rows) {
    const role = delegationPersistedRole(row);
    const infra = isInfraDelegationOutcome(row, role);
    const completed = String(row?.status || '').trim().toLowerCase() === 'completed';
    if (role === 'plan') {
      flags.set(row.id, { pass: !infra && completed && Boolean(String(row?.report || '').trim()), decided: !infra });
    } else if (role === 'review') {
      const verdict = parseDelegationVerdict(String(row?.report || ''));
      const judged = !infra && (verdict === 'PASS' || verdict === 'FAIL');
      flags.set(row.id, { pass: judged && verdict === 'PASS', decided: judged });
    }
    if (role === 'implement' || role === 'review') {
      const chat = String(delegationController(row) || '').trim();
      if (!chat) continue;
      if (!byChat.has(chat)) byChat.set(chat, []);
      byChat.get(chat).push(row);
    }
  }
  for (const chatRows of byChat.values()) {
    const ordered = chatRows
      .map((row) => ({ row, at: parseTime(row?.createdAt || row?.startedAt), role: delegationPersistedRole(row) }))
      .sort((a, b) => (a.at - b.at) || (a.role === 'implement' ? -1 : 1));
    /** @type {{ id: string, infra: boolean } | null} */
    let open = null;
    /** @type {string[]} */
    let verdicts = [];
    const close = () => {
      if (!open) return;
      if (!open.infra) {
        const decided = verdicts.length > 0;
        flags.set(open.id, { decided, pass: decided && verdicts.every((v) => v === 'PASS') });
      } else {
        flags.set(open.id, { decided: false, pass: false });
      }
      open = null;
      verdicts = [];
    };
    for (const { row, role } of ordered) {
      if (role === 'implement') {
        close();
        open = { id: row.id, infra: isInfraDelegationOutcome(row, 'implement') };
        continue;
      }
      if (!open || isInfraDelegationOutcome(row, 'review')) continue;
      const verdict = parseDelegationVerdict(String(row?.report || ''));
      if (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'BLOCKED') verdicts.push(verdict);
    }
    close();
  }
  return flags;
}

/**
 * Measured USD per delegation from usage events: only finite, non-estimated
 * `usd` values of events that name the delegation.
 *
 * @param {Record<string, any>[]} events
 * @returns {Map<string, { usd: number, at: string }>}
 */
function measuredUsdByDelegation(events) {
  /** @type {Map<string, { usd: number, at: string }>} */
  const out = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const id = String(event?.delegationId || '').trim();
    const usd = Number(event?.usd);
    if (!id || event?.usd == null || !Number.isFinite(usd) || usd < 0 || event?.estimated === true) continue;
    if (event?.eventType === 'run') continue;
    const prev = out.get(id) || { usd: 0, at: '' };
    prev.usd += usd;
    if (String(event?.at || '') > prev.at) prev.at = String(event.at);
    out.set(id, prev);
  }
  return out;
}

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
function buildBenchmarkBlock(input) {
  const { index, harness, model, role } = input;
  if (!index) return { status: 'no_source', benchmark_score: null, source: null, captured_at: null, stale: false, attribution: null };
  const scored = scoreCandidateBenchmark({ candidate: { harness, model }, role, index });
  const source = index.find((entry) => entry.sourceId === scored.source) || null;
  const attribution = source?.attribution || '';
  return {
    status: scored.status,
    benchmark_score: scored.benchmark_score,
    source: scored.source,
    captured_at: scored.captured_at,
    stale: scored.stale === true,
    attribution: attribution || null,
  };
}

/**
 * @param {{
 *   rows?: ModelPickPricedStatsRow[],
 *   picks?: ModelPickPricedStatsPick[],
 *   usageEvents?: ModelPickPricedStatsUsageEvent[],
 *   snapshots?: import('./model-pick-benchmark.js').ModelPickBenchmarkSnapshot[],
 *   sourcePreferences?: Record<string, { enabled?: boolean }>,
 *   openrouterPricingFor?: (model: string) => any,
 *   costProxyConfig?: object,
 *   now?: number,
 *   windowMs?: number,
 * }} input
 * @returns {{
 *   schema_version: string,
 *   unit_note: string,
 *   attribution: { text: string, url: string },
 *   by_level: ModelPickPricedStatsLevelRow[],
 *   by_model_role: Record<string, ModelPickPricedStatsModelRole>,
 *   truncated: boolean,
 * }}
 */
export function buildPricedModelStats(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : 30 * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const rowsAll = Array.isArray(input.rows) ? input.rows : [];
  const rows = rowsAll.filter((row) => {
    const ts = parseTime(row?.createdAt || row?.startedAt);
    return ts > 0 && ts >= cutoff && isTerminalDelegationStatus(row?.status) && delegationPersistedRole(row);
  });
  const picksById = new Map((Array.isArray(input.picks) ? input.picks : [])
    .map((pick) => [String(pick?.id || ''), pick]));
  const config = normalizeCostProxyConfig(input.costProxyConfig ?? null);
  const samples = collectTokenSamples(rowsAll, (row) => delegationPersistedRole(row));
  const flags = resolvePassFlags(rows);
  const measured = measuredUsdByDelegation(input.usageEvents);
  const index = Array.isArray(input.snapshots) && input.snapshots.length
    ? buildBenchmarkShadowIndex({ snapshots: input.snapshots, sourcePreferences: input.sourcePreferences, now })
    : null;

  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const row of rows) {
    const role = delegationPersistedRole(row);
    const { harness } = rowExecutor(row);
    const model = baseModelOfRow(row);
    if (!harness || !model) continue;
    const level = levelOfDelegation(row, picksById);
    const key = `${harness}/${model}|${role}|${level}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        harness, model, role, level, n: 0, infra: 0, completed: 0, usable: 0,
        decided: 0, passes: 0, durations: [], tokensIn: [], tokensOut: [],
        costUsd: 0, costN: 0, costPass: 0, costDecided: 0, costAt: '', retries: 0,
        downgraded: 0, effortUnavailable: 0,
      };
      groups.set(key, group);
    }
    group.n += 1;
    const infra = isInfraDelegationOutcome(row, role);
    const completed = String(row?.status || '').trim().toLowerCase() === 'completed';
    if (infra) group.infra += 1;
    if (completed) {
      group.completed += 1;
      const start = parseTime(row?.startedAt);
      const end = parseTime(row?.finishedAt);
      if (start > 0 && end >= start) group.durations.push((end - start) / 60000);
    }
    if (!infra && completed && String(row?.report || '').trim()) group.usable += 1;
    const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : null;
    if (metrics) {
      const tin = Number(metrics.tokens_in);
      const tout = Number(metrics.tokens_out);
      if (metrics.tokens_in != null && Number.isFinite(tin) && tin >= 0) group.tokensIn.push(tin);
      if (metrics.tokens_out != null && Number.isFinite(tout) && tout >= 0) group.tokensOut.push(tout);
    }
    const flag = flags.get(row.id);
    if (flag?.decided) group.decided += 1;
    if (flag?.pass) group.passes += 1;
    const cost = measured.get(String(row.id || ''));
    if (cost) {
      group.costUsd += cost.usd;
      group.costN += 1;
      if (flag?.decided) group.costDecided += 1;
      if (flag?.pass) group.costPass += 1;
      if (cost.at > group.costAt) group.costAt = cost.at;
    }
    if (Number(row?.attempt) > 1 || Number(row?.retryCount) > 0) group.retries += 1;
    const warnings = JSON.stringify(row?.warnings || row?.modelWarnings || '');
    if (warnings.includes('model_downgraded')) group.downgraded += 1;
    if (warnings.includes('effort_unavailable')) group.effortUnavailable += 1;
  }

  const sortedKeys = [...groups.keys()].sort();
  const truncated = sortedKeys.length > MAX_GROUPS;
  /** @type {Record<string, any>[]} */
  const byLevel = [];
  /** @type {Record<string, any>} */
  const rollup = {};
  for (const key of sortedKeys.slice(0, MAX_GROUPS)) {
    const g = groups.get(key);
    const billingClass = billingClassOfCandidate({ harness: g.harness }, { provider: resolveHarnessProvider(g.harness) });
    const price = buildPricePer1m({
      harness: g.harness, model: g.model, role: g.role, billingClass, samples, config,
      openrouterPricingFor: input.openrouterPricingFor,
    });
    const proxy = estimateCostProxy({
      harness: g.harness, model: g.model, role: g.role, level: g.level, samples, config,
      openrouterPricingFor: input.openrouterPricingFor,
    });
    const proxyTotal = proxy.value != null && g.decided > 0 ? proxy.value * g.decided : null;
    /** @type {Record<string, any> | null} */
    let costPerPass = null;
    if (billingClass === 'api_metered' && g.costN > 0 && g.costPass > 0) {
      costPerPass = {
        value: round(g.costUsd / g.costPass, 6),
        unit: 'usd',
        is_money: true,
        source: 'usage_ledger',
        captured_at: g.costAt || null,
        basis: 'measured',
        n_cost_rows: g.costN,
        n_pass: g.costPass,
      };
    } else if (proxyTotal != null && g.passes > 0) {
      costPerPass = {
        value: round(proxyTotal / g.passes, 6),
        unit: 'rcu',
        is_money: false,
        source: 'cost_proxy',
        captured_at: price.captured_at,
        basis: proxy.basis,
        token_source: proxy.tokenSource,
        n_cost_rows: g.decided,
        n_pass: g.passes,
      };
    }
    const row = {
      harness: g.harness,
      model: g.model,
      role: g.role,
      level: g.level,
      billing_class: billingClass,
      n: g.n,
      usable_rate: g.n > 0 ? round(g.usable / g.n) : null,
      infra_fail_rate: g.n > 0 ? round(g.infra / g.n) : null,
      completion_rate: g.n > 0 ? round(g.completed / g.n) : null,
      decided: g.decided,
      passes: g.passes,
      median_min: round(median(g.durations), 2),
      median_tokens_in: round(median(g.tokensIn), 0),
      median_tokens_out: round(median(g.tokensOut), 0),
      retries: g.retries,
      model_downgraded: g.downgraded,
      effort_unavailable: g.effortUnavailable,
      cost: {
        measured_usd: billingClass === 'api_metered' && g.costN > 0
          ? { value: round(g.costUsd, 6), unit: 'usd', is_money: true, source: 'usage_ledger', captured_at: g.costAt || null, n: g.costN }
          : null,
        cost_proxy: {
          value: round(proxy.value, 6),
          unit: 'rcu',
          is_money: false,
          basis: proxy.basis,
          token_source: proxy.tokenSource,
        },
      },
      cost_per_pass: costPerPass,
      price_per_1m: price,
      benchmark: buildBenchmarkBlock({ index, harness: g.harness, model: g.model, role: g.role }),
    };
    byLevel.push(row);
    const rk = `${g.harness}/${g.model}|${g.role}`;
    const acc = rollup[rk] || (rollup[rk] = {
      harness: g.harness, model: g.model, role: g.role, billing_class: billingClass, price,
      benchmark: row.benchmark, usd: 0, usdPass: 0, usdN: 0, usdAt: '',
      rcu: 0, rcuPass: 0, rcuDecided: 0, rcuBasis: proxy.basis, rcuSource: proxy.tokenSource,
    });
    if (costPerPass?.unit === 'usd') {
      acc.usd += g.costUsd;
      acc.usdPass += g.costPass;
      acc.usdN += g.costN;
      if (g.costAt > acc.usdAt) acc.usdAt = g.costAt;
    } else if (proxyTotal != null) {
      acc.rcu += proxyTotal;
      acc.rcuPass += g.passes;
      acc.rcuDecided += g.decided;
    }
  }

  /** @type {Record<string, Record<string, any>>} */
  const byModelRole = {};
  for (const [rk, acc] of Object.entries(rollup)) {
    /** @type {ModelPickPricedStatsCostPerPass | null} */
    let costPerPass = null;
    if (acc.usdPass > 0) {
      costPerPass = {
        value: round(acc.usd / acc.usdPass, 6), unit: 'usd', is_money: true, source: 'usage_ledger',
        captured_at: acc.usdAt || null, basis: 'measured', n_cost_rows: acc.usdN, n_pass: acc.usdPass,
      };
    } else if (acc.rcuPass > 0) {
      costPerPass = {
        value: round(acc.rcu / acc.rcuPass, 6), unit: 'rcu', is_money: false, source: 'cost_proxy',
        captured_at: acc.price.captured_at, basis: acc.rcuBasis, token_source: acc.rcuSource,
        n_cost_rows: acc.rcuDecided, n_pass: acc.rcuPass,
      };
    }
    byModelRole[rk] = {
      harness: acc.harness, model: acc.model, role: acc.role, billing_class: acc.billing_class,
      cost_per_pass: costPerPass, price_per_1m: acc.price, benchmark: acc.benchmark,
    };
  }

  return {
    schema_version: PRICED_STATS_SCHEMA_VERSION,
    unit_note: 'usd is money (api_metered only); rcu is a relative cost proxy, never money',
    attribution: PRICED_STATS_ATTRIBUTION,
    by_level: byLevel,
    by_model_role: byModelRole,
    truncated,
  };
}
