/**
 * `cost_proxy` for `model_pick` (plan v10 §2.2, shadow only).
 *
 * A relative cost index in RCU (USD-equivalent per 1M tokens) for each
 * candidate: `(tokens_in * rate_in + tokens_out * rate_out) / 1e6`. It is a
 * separate fact from metered USD (`api_metered`), is journaled with its
 * `basis` and `tokenSource`, and never influences selection.
 *
 * Rates: an exact `estimateTokenRates` hit (`basis: rate`), else the operator's
 * `TIER_RATE_TABLE` for the base cost tier (`basis: tier_table`), else
 * `empty`. Effort is counted once, in the token volume only.
 * Tokens: median of history per (model, role, level) with n >= 5, else the
 * median per (model, role) with n >= 5 (still `history`), else the median per
 * role, else a configured constant.
 */

import { estimateTokenRates } from './usage/usage-rates.js';
import { resolveHarnessProvider } from './usage/harness-usage.ts';
import { resolveBaseCostTier } from './model-catalog-meta.js';
import { decodeModelValue } from './model-catalog.js';
import { normalizeEffortParam } from './model-effort.js';
import { resolveDataPath } from './runtime-paths.js';
import { COST_PROXY_UNIT, normalizeCostProxy } from './model-pick-cost-proxy-record.js';
import fs from 'node:fs';

export { COST_PROXY_UNIT } from './model-pick-cost-proxy-record.js';

/** Minimum samples for a (model, role, level) median before falling back. */
export const COST_PROXY_MIN_HISTORY_N = 5;

/** Quality bars from the plan (L2b acceptance). */
export const COST_PROXY_HISTORY_SHARE_TARGET = 0.6;
export const COST_PROXY_CALIBRATION_ERROR_MAX = 0.25;
export const COST_PROXY_CALIBRATION_MIN_N = 5;

/** Weight of output vs input in the blended per-million figure (in:out 1:3). */
const BLEND_IN = 1;
const BLEND_OUT = 3;

/**
 * Default RCU per 1M tokens by base cost tier. Calibrated on models with a
 * real list rate: tier 1 ~ claude-haiku-5-5 (0.1/0.5), tier 2 ~ deepseek/mini
 * class, tier 3 ~ claude-sonnet (3/15), tier 4 ~ claude-opus-4-5 (5/25, the
 * current Opus rate, not the legacy 15/75), tier 5 ~ legacy flagship (15/75).
 * Operators override it in `data/model-role-profiles.json` under `costProxy`.
 */
export const TIER_RATE_TABLE = Object.freeze({
  1: Object.freeze({ input: 0.1, output: 0.5 }),
  2: Object.freeze({ input: 0.3, output: 1.2 }),
  3: Object.freeze({ input: 3, output: 15 }),
  4: Object.freeze({ input: 5, output: 25 }),
  5: Object.freeze({ input: 15, output: 75 }),
});

/** Token volume used when there is no history at all. */
export const DEFAULT_CONSTANT_TOKENS = Object.freeze({
  plan: Object.freeze({ input: 12000, output: 3000 }),
  implement: Object.freeze({ input: 40000, output: 8000 }),
  fix: Object.freeze({ input: 30000, output: 6000 }),
  review: Object.freeze({ input: 25000, output: 2500 }),
});

/** Applied to role/constant token volumes only (history is per full variant id). */
export const DEFAULT_EFFORT_TOKEN_MULTIPLIER = Object.freeze({
  none: 1, low: 1, medium: 1.15, high: 1.4, xhigh: 1.8, max: 2.2,
});

/**
 * @typedef {{
 *   tierRateTable: Record<string, { input: number, output: number }>,
 *   constantTokens: Record<string, { input: number, output: number }>,
 *   effortTokenMultiplier: Record<string, number>,
 * }} CostProxyConfig
 */

/**
 * A delegation row as the token-sample collector reads it.
 *
 * @typedef {object} ModelPickCostProxyRow
 * @property {{
 *   tokens_in?: unknown, tokens_out?: unknown,
 *   tokens_out_per_sec?: unknown, tool_calls_n?: unknown, files_changed?: unknown,
 * } | null} [metrics]
 * @property {{ transport?: string, model?: string }} [executor]
 * @property {{ level?: string }} [complexity]
 * @property {string} [complexityLevel]
 */

/**
 * One cost-proxy estimate, either fresh from {@link estimateCostProxy} or a
 * persisted journal entry (which keeps no `rates`/`rateSource`).
 *
 * @typedef {object} ModelPickCostProxyEntry
 * @property {string} candidateId
 * @property {string} [unit]
 * @property {number | null} value
 * @property {string} basis
 * @property {string} tokenSource
 * @property {number | null} tier
 * @property {{ input: number, output: number } | null} [rates]
 * @property {string} [rateSource]
 * @property {{ input: number, output: number }} [tokens]
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Merge an operator `costProxy` block over the defaults; invalid numbers are
 * ignored so a typo never produces a zero or NaN rate.
 *
 * @param {unknown} [raw]
 * @returns {CostProxyConfig}
 */
export function normalizeCostProxyConfig(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  /** @type {CostProxyConfig} */
  const out = {
    tierRateTable: { ...TIER_RATE_TABLE },
    constantTokens: { ...DEFAULT_CONSTANT_TOKENS },
    effortTokenMultiplier: { ...DEFAULT_EFFORT_TOKEN_MULTIPLIER },
  };
  const table = src.tierRateTable && typeof src.tierRateTable === 'object' ? src.tierRateTable : {};
  for (const tier of Object.keys(out.tierRateTable)) {
    const input = positive(table[tier]?.input);
    const output = positive(table[tier]?.output);
    if (input != null && output != null) out.tierRateTable[tier] = { input, output };
  }
  const tokens = src.constantTokens && typeof src.constantTokens === 'object' ? src.constantTokens : {};
  for (const role of Object.keys(out.constantTokens)) {
    const input = positive(tokens[role]?.input);
    const output = positive(tokens[role]?.output);
    if (input != null && output != null) out.constantTokens[role] = { input, output };
  }
  const multipliers = src.effortTokenMultiplier && typeof src.effortTokenMultiplier === 'object'
    ? src.effortTokenMultiplier
    : {};
  for (const level of Object.keys(out.effortTokenMultiplier)) {
    const m = positive(multipliers[level]);
    if (m != null) out.effortTokenMultiplier[level] = m;
  }
  return out;
}

/**
 * @param {{ filePath?: string }} [input]
 * @returns {CostProxyConfig}
 */
export function loadCostProxyConfig(input = {}) {
  const filePath = String(input.filePath || '').trim() || resolveDataPath('model-role-profiles.json');
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeCostProxyConfig(doc?.costProxy);
  } catch {
    return normalizeCostProxyConfig(null);
  }
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
 * @param {string} role
 * @returns {string}
 */
function tokenRole(role) {
  const r = String(role || '').trim().toLowerCase();
  // `fix` runs are persisted as implement jobs and share their volume.
  return r === 'fix' ? 'implement' : r;
}

/**
 * Build token medians from delegation rows. Rows carry `metrics.tokens_in/out`
 * (`lib/delegation-metrics.js`); a level is read from `complexity.level` when a
 * row has one. Only the lengths needed by the lookup are stored.
 *
 * Three buckets are returned: the exact `(model, role, level)`, a coarser
 * `(model, role)` that works even when no level was persisted, and the all-role
 * median. The exact bucket is preferred, then the model-role one, so the
 * history source stays reachable for rows written before a level was journaled.
 *
 * @param {Record<string, any>[]} rows
 * @param {(row: Record<string, any>) => string} roleOfRow
 * @returns {{
 *   byModelRoleLevel: Map<string, { input: number[], output: number[] }>,
 *   byModelRole: Map<string, { input: number[], output: number[] }>,
 *   byRole: Map<string, { input: number[], output: number[] }>,
 * }}
 */
export function collectTokenSamples(rows, roleOfRow) {
  const byModelRoleLevel = new Map();
  const byModelRole = new Map();
  const byRole = new Map();
  const push = (map, key, tin, tout) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { input: [], output: [] };
      map.set(key, bucket);
    }
    bucket.input.push(tin);
    bucket.output.push(tout);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : null;
    if (!metrics) continue;
    const tin = Number(metrics.tokens_in);
    const tout = Number(metrics.tokens_out);
    if (metrics.tokens_in == null || metrics.tokens_out == null) continue;
    if (!Number.isFinite(tin) || !Number.isFinite(tout) || tin < 0 || tout < 0) continue;
    const role = tokenRole(roleOfRow(row));
    if (!role) continue;
    const model = String(row?.executor?.model || '').trim().toLowerCase();
    const level = String(row?.complexity?.level || row?.complexityLevel || '').trim().toLowerCase();
    push(byRole, role, tin, tout);
    if (model) {
      push(byModelRole, `${model}|${role}`, tin, tout);
      if (level) push(byModelRoleLevel, `${model}|${role}|${level}`, tin, tout);
    }
  }
  return { byModelRoleLevel, byModelRole, byRole };
}

/**
 * Resolve the token volume for one candidate. A (model, role, level) median is
 * `history`; without an exact level the (model, role) median is still `history`
 * (so the target stays reachable when no level was persisted); the all-role
 * median is `role`; otherwise the configured constant.
 *
 * @param {{ model: string, role: string, level: string }} key
 * @param {ReturnType<typeof collectTokenSamples>} samples
 * @param {CostProxyConfig} config
 * @returns {{ input: number, output: number, tokenSource: 'history' | 'role' | 'constant' }}
 */
export function resolveTokenVolume(key, samples, config) {
  const role = tokenRole(key.role);
  const model = String(key.model || '').trim().toLowerCase();
  const level = String(key.level || '').trim().toLowerCase();
  const exact = samples.byModelRoleLevel?.get(`${model}|${role}|${level}`);
  if (exact && exact.input.length >= COST_PROXY_MIN_HISTORY_N) {
    return { input: median(exact.input) ?? 0, output: median(exact.output) ?? 0, tokenSource: 'history' };
  }
  const perModelRole = samples.byModelRole?.get(`${model}|${role}`);
  if (model && perModelRole && perModelRole.input.length >= COST_PROXY_MIN_HISTORY_N) {
    return { input: median(perModelRole.input) ?? 0, output: median(perModelRole.output) ?? 0, tokenSource: 'history' };
  }
  const perRole = samples.byRole?.get(role);
  if (perRole && perRole.input.length >= COST_PROXY_MIN_HISTORY_N) {
    return { input: median(perRole.input) ?? 0, output: median(perRole.output) ?? 0, tokenSource: 'role' };
  }
  const fallback = config.constantTokens[role] || DEFAULT_CONSTANT_TOKENS.implement;
  return { input: fallback.input, output: fallback.output, tokenSource: 'constant' };
}

/**
 * Cost proxy for one candidate.
 *
 * @param {{
 *   harness?: string,
 *   model?: string,
 *   role?: string,
 *   level?: string,
 *   samples: ReturnType<typeof collectTokenSamples>,
 *   config?: CostProxyConfig,
 *   openrouterPricingFor?: (model: string) => { prompt?: unknown, completion?: unknown } | null,
 * }} input
 * @returns {{
 *   candidateId: string,
 *   unit: 'rcu',
 *   value: number | null,
 *   basis: 'rate' | 'tier_table' | 'empty',
 *   tokenSource: 'history' | 'role' | 'constant',
 *   tier: number | null,
 *   rates: { input: number, output: number } | null,
 *   rateSource: string,
 *   tokens: { input: number, output: number },
 * }}
 */
export function estimateCostProxy(input) {
  const config = input.config || normalizeCostProxyConfig(null);
  const harness = String(input.harness || '').trim().toLowerCase();
  const fullModel = String(input.model || '').trim();
  const decoded = decodeModelValue(fullModel);
  const baseModel = String(decoded.modelId || fullModel).trim();
  const provider = resolveHarnessProvider(harness);
  const role = String(input.role || '').trim().toLowerCase();
  const level = String(input.level || '').trim().toLowerCase();
  const volume = resolveTokenVolume({ model: fullModel, role, level }, input.samples, config);
  let tokensIn = volume.input;
  let tokensOut = volume.output;
  if (volume.tokenSource !== 'history') {
    // Effort is only counted here, in the volume, never in the rate or tier.
    const effort = normalizeEffortParam(decoded.params).level;
    const factor = config.effortTokenMultiplier[effort] ?? 1;
    tokensIn *= factor;
    tokensOut *= factor;
  }
  const candidateId = harness && fullModel ? `${harness}/${fullModel}` : '';
  const pricing = typeof input.openrouterPricingFor === 'function' && provider === 'openrouter'
    ? input.openrouterPricingFor(baseModel)
    : null;
  const exact = estimateTokenRates(baseModel, provider, { openrouterPricing: pricing });
  const tier = baseModel ? resolveBaseCostTier(baseModel) : 0;
  /** @type {{ input: number, output: number } | null} */
  let rates = null;
  /** @type {'rate' | 'tier_table' | 'empty'} */
  let basis = 'empty';
  let rateSource = '';
  if (exact) {
    rates = { input: exact.textInput, output: exact.textOutput };
    basis = 'rate';
    rateSource = exact.source;
  } else if (tier > 0 && config.tierRateTable[String(tier)]) {
    rates = config.tierRateTable[String(tier)];
    basis = 'tier_table';
    rateSource = 'tier_table';
  }
  const value = rates ? (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000 : null;
  return {
    candidateId,
    unit: COST_PROXY_UNIT,
    value,
    basis,
    tokenSource: volume.tokenSource,
    tier: tier > 0 ? tier : null,
    rates,
    rateSource,
    tokens: { input: tokensIn, output: tokensOut },
  };
}

/**
 * Cost-proxy block for a pick response and decision log: the selected pair
 * first, then the audit candidates, bounded.
 *
 * @param {{
 *   pickResult?: any,
 *   role?: string,
 *   level?: string,
 *   rows: ModelPickCostProxyRow[],
 *   roleOfRow: (row: ModelPickCostProxyRow) => string,
 *   config?: CostProxyConfig,
 *   openrouterPricingFor?: (model: string) => any,
 * }} input
 * @returns {ReturnType<typeof normalizeCostProxy>}
 */
export function buildCostProxyForPick(input) {
  const pickResult = input.pickResult || {};
  const samples = collectTokenSamples(input.rows, input.roleOfRow);
  const config = input.config || normalizeCostProxyConfig(null);
  const seen = new Set();
  const entries = [];
  const rowsIn = [
    ...(pickResult.pick ? [pickResult.pick] : []),
    ...(Array.isArray(pickResult.picks) ? pickResult.picks.slice(0, 1) : []),
    ...(Array.isArray(pickResult.candidates) ? pickResult.candidates : []),
  ];
  for (const row of rowsIn) {
    const harness = String(row?.harness || '').trim().toLowerCase();
    const model = String(row?.model || '').trim();
    if (!harness || !model || seen.has(`${harness}/${model}`)) continue;
    seen.add(`${harness}/${model}`);
    entries.push(estimateCostProxy({
      harness, model, role: input.role, level: input.level, samples, config,
      openrouterPricingFor: input.openrouterPricingFor,
    }));
  }
  // The selected entry is the explicit `pick` (or `picks[0]`), never simply the
  // first audit candidate: a pick result without a usable primary pair must mark
  // no selection instead of mislabelling an alternate as chosen.
  const selectedRow = pickResult.pick && pickResult.pick.harness && pickResult.pick.model
    ? pickResult.pick
    : (Array.isArray(pickResult.picks) ? pickResult.picks[0] : null);
  const selectedHarness = String(selectedRow?.harness || '').trim().toLowerCase();
  const selectedModel = String(selectedRow?.model || '').trim();
  const selected = selectedHarness && selectedModel
    ? entries.find((entry) => entry.candidateId === `${selectedHarness}/${selectedModel}`) || null
    : null;
  return normalizeCostProxy({
    level: input.level,
    selected,
    candidates: entries,
  });
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

/**
 * Leave-one-out error of the tier table: for each model that has a real rate,
 * the tier is predicted from the *other* rated models of that tier (blended
 * 1:3 in:out) and compared with the model's own blended rate. A tier with no
 * other rated model cannot be checked and is skipped. With fewer than
 * `COST_PROXY_CALIBRATION_MIN_N` checkable models the result is `undetermined`.
 *
 * @param {Array<{ model: string, tier: number, rates: { input: number, output: number } }>} rated
 * @returns {{ n: number, meanAbsError: number | null, withinTarget: number | null, undetermined: boolean }}
 */
export function leaveOneOutCalibrationError(rated) {
  const blend = (r) => (BLEND_IN * r.input + BLEND_OUT * r.output) / (BLEND_IN + BLEND_OUT);
  const errors = [];
  for (const row of rated) {
    const others = rated.filter((o) => o.tier === row.tier && o.model !== row.model);
    if (others.length === 0) continue;
    const predicted = median(others.map((o) => blend(o.rates)));
    const actual = blend(row.rates);
    if (predicted == null || !(actual > 0)) continue;
    errors.push(Math.abs(predicted - actual) / actual);
  }
  if (errors.length < COST_PROXY_CALIBRATION_MIN_N) {
    return { n: errors.length, meanAbsError: null, withinTarget: null, undetermined: true };
  }
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  return {
    n: errors.length,
    meanAbsError: round(mean),
    withinTarget: round(errors.filter((e) => e <= COST_PROXY_CALIBRATION_ERROR_MAX).length / errors.length),
    undetermined: false,
  };
}

/**
 * Error of the configured tier table on a held-out set (models priced by the
 * OpenRouter catalog), n >= 5 or `undetermined`.
 *
 * @param {Array<{ model: string, tier: number, rates: { input: number, output: number } }>} holdout
 * @param {CostProxyConfig} config
 * @returns {{ n: number, meanAbsError: number | null, undetermined: boolean }}
 */
export function holdoutCalibrationError(holdout, config) {
  const errors = [];
  for (const row of holdout) {
    const table = config.tierRateTable[String(row.tier)];
    if (!table) continue;
    const blend = (r) => (BLEND_IN * r.input + BLEND_OUT * r.output) / (BLEND_IN + BLEND_OUT);
    const actual = blend(row.rates);
    if (!(actual > 0)) continue;
    errors.push(Math.abs(blend(table) - actual) / actual);
  }
  if (errors.length < COST_PROXY_CALIBRATION_MIN_N) return { n: errors.length, meanAbsError: null, undetermined: true };
  return {
    n: errors.length,
    meanAbsError: round(errors.reduce((a, b) => a + b, 0) / errors.length),
    undetermined: false,
  };
}

/**
 * Proxy quality report over estimates (one per picked candidate).
 *
 * @param {{
 *   estimates: ModelPickCostProxyEntry[],
 *   config?: CostProxyConfig,
 * }} input
 * @returns {Record<string, any>}
 */
export function buildCostProxyQualityReport(input) {
  const estimates = Array.isArray(input.estimates) ? input.estimates : [];
  const config = input.config || normalizeCostProxyConfig(null);
  const n = estimates.length;
  const share = (count) => (n > 0 ? round(count / n) : null);
  const rate = estimates.filter((e) => e.basis === 'rate');
  const historyShare = share(estimates.filter((e) => e.tokenSource === 'history').length);
  // One row per model so repeated picks do not weigh one model several times.
  /** @type {Map<string, any>} */
  const ratedByModel = new Map();
  for (const e of rate) {
    if (e.rates && e.tier != null && !ratedByModel.has(e.candidateId)) {
      ratedByModel.set(e.candidateId, { model: e.candidateId, tier: e.tier, rates: e.rates, source: e.rateSource });
    }
  }
  const rated = [...ratedByModel.values()];
  return {
    unit: COST_PROXY_UNIT,
    n,
    basisRateShare: share(rate.length),
    basisTierTableShare: share(estimates.filter((e) => e.basis === 'tier_table').length),
    emptyShare: share(estimates.filter((e) => e.basis === 'empty').length),
    tokenSourceHistoryShare: historyShare,
    historyShareTarget: COST_PROXY_HISTORY_SHARE_TARGET,
    historyShareMet: historyShare == null ? null : historyShare >= COST_PROXY_HISTORY_SHARE_TARGET,
    leaveOneOut: leaveOneOutCalibrationError(rated),
    holdout: holdoutCalibrationError(rated.filter((r) => r.source === 'openrouter_pricing'), config),
    calibrationErrorMax: COST_PROXY_CALIBRATION_ERROR_MAX,
  };
}

/**
 * @typedef {object} ModelPickCostProxyQualityReport
 * @property {string} unit
 * @property {number} n
 * @property {number | null} basisRateShare
 * @property {number | null} basisTierTableShare
 * @property {number | null} emptyShare
 * @property {number | null} tokenSourceHistoryShare
 * @property {number} historyShareTarget
 * @property {boolean | null} historyShareMet
 * @property {ReturnType<typeof leaveOneOutCalibrationError>} leaveOneOut
 * @property {ReturnType<typeof holdoutCalibrationError>} holdout
 * @property {number} calibrationErrorMax
 */

/**
 * Recover the exact rate of a persisted `basis: rate` entry. The journal keeps
 * only the closed `{ candidateId, value, basis, tokenSource, tier }` shape, so
 * the calibration half of the report would otherwise be `undetermined`; the
 * rate is deterministic and network-free, so resolving it again from the
 * candidate id is enough to measure the tier table against the known rates.
 *
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
function hydrateRateEntry(entry) {
  if (!entry || entry.rates || entry.basis !== 'rate') return entry;
  const candidateId = String(entry.candidateId || '');
  const slash = candidateId.indexOf('/');
  if (slash <= 0) return entry;
  const harness = candidateId.slice(0, slash);
  const fullModel = candidateId.slice(slash + 1);
  const baseModel = String(decodeModelValue(fullModel).modelId || fullModel).trim();
  if (!baseModel) return entry;
  const exact = estimateTokenRates(baseModel, resolveHarnessProvider(harness));
  if (!exact) return entry;
  return {
    ...entry,
    rates: { input: exact.textInput, output: exact.textOutput },
    rateSource: exact.source,
  };
}

/**
 * Proxy-quality report over persisted model-pick records (task F2). Every
 * record's `costProxy.candidates` is read (falling back to `costProxy.selected`
 * when no candidates were stored) and normalized estimate objects are fed to
 * {@link buildCostProxyQualityReport}. Records/blocks without a `costProxy` are
 * skipped, so the sample is exactly the persisted proxy estimates and the
 * `tokenSource=history` / leave-one-out targets become measurable from the
 * journal.
 *
 * @param {Record<string, Record<string, any>> | Record<string, any>[] | null | undefined} records
 * @param {{ config?: CostProxyConfig }} [options]
 * @returns {ReturnType<typeof buildCostProxyQualityReport>}
 */
export function buildCostProxyQualityReportFromRecords(records, options = {}) {
  const list = Array.isArray(records)
    ? records
    : Object.values(records && typeof records === 'object' ? records : {});
  /** @type {ModelPickCostProxyEntry[]} */
  const estimates = [];
  for (const record of list) {
    const block = normalizeCostProxy(record?.costProxy);
    if (!block) continue;
    const entries = block.candidates.length > 0
      ? block.candidates
      : (block.selected ? [block.selected] : []);
    for (const entry of entries) estimates.push(/** @type {ModelPickCostProxyEntry} */ (hydrateRateEntry(entry)));
  }
  return buildCostProxyQualityReport({ estimates, config: options.config });
}
