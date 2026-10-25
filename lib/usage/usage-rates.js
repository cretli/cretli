/**
 * Approximate USD rates for the usage ledger. Not an invoice.
 * Token rates: USD per million. Longest model-prefix wins.
 */

/**
 * Date the static `TOKEN_RATES` list prices were last reviewed in this
 * repository. Shown next to a price as its `captured_at` so a number never
 * appears without a date; OpenRouter catalog prices carry their own fetch time.
 */
export const TOKEN_RATES_CAPTURED_AT = '2026-09-30';

/**
 * Version label of the static rate table, persisted on every event priced from
 * it (`pricing.ratesVersion`). Bump it together with `TOKEN_RATES_CAPTURED_AT`
 * whenever a rate changes. Stored events keep their own snapshot, so a bump
 * never reprices history.
 */
export const TOKEN_RATES_VERSION = `token_rates@${TOKEN_RATES_CAPTURED_AT}`;

export const TOKEN_RATES = {
  'gpt-realtime-2.1-mini': {
    textInput: 0.6,
    cachedInput: 0.06,
    audioInput: 10,
    textOutput: 2.4,
    audioOutput: 20,
  },
  'gpt-realtime-mini': {
    textInput: 0.6,
    cachedInput: 0.06,
    audioInput: 10,
    textOutput: 2.4,
    audioOutput: 20,
  },
  'gpt-realtime': {
    textInput: 4,
    cachedInput: 0.4,
    audioInput: 32,
    textOutput: 24,
    audioOutput: 64,
  },
  'gpt-4o-realtime': {
    textInput: 5,
    cachedInput: 2.5,
    audioInput: 40,
    textOutput: 20,
    audioOutput: 80,
  },
  gemini: {
    textInput: 0.5,
    cachedInput: 0.5,
    audioInput: 3,
    textOutput: 2,
    audioOutput: 12,
  },
  // DeepSeek API list price (V3.2-Exp, USD per million): cache-miss input
  // $0.28, cache-hit input $0.028, output $0.42. The harness reports DeepSeek
  // cache reads via `cacheReadTokens`, so the cached rate applies. Estimates
  // only — DeepSeek changes list prices and runs promotions.
  deepseek: {
    textInput: 0.28,
    cachedInput: 0.028,
    audioInput: 0,
    textOutput: 0.42,
    audioOutput: 0,
    estimated: true,
  },
  // Anthropic API is billed by key, so these are estimates, not invoices.
  // Opus 4.5+ dropped to $5/$25; Opus 4 and 4.1 stay at $15/$75.
  'claude-opus-4-5': {
    textInput: 5,
    cachedInput: 0.5,
    audioInput: 0,
    textOutput: 25,
    audioOutput: 0,
    estimated: true,
  },
  'claude-opus-4': {
    textInput: 15,
    cachedInput: 1.5,
    audioInput: 0,
    textOutput: 75,
    audioOutput: 0,
    estimated: true,
  },
  'claude-opus': {
    textInput: 15,
    cachedInput: 1.5,
    audioInput: 0,
    textOutput: 75,
    audioOutput: 0,
    estimated: true,
  },
  'claude-sonnet-4': {
    textInput: 3,
    cachedInput: 0.3,
    audioInput: 0,
    textOutput: 15,
    audioOutput: 0,
    estimated: true,
  },
  'claude-sonnet': {
    textInput: 3,
    cachedInput: 0.3,
    audioInput: 0,
    textOutput: 15,
    audioOutput: 0,
    estimated: true,
  },
  // Haiku 5.5 cut list price ~75% vs Haiku 4.5 (prompts up to 100k tokens).
  'claude-haiku-5-5': {
    textInput: 0.1,
    cachedInput: 0.01,
    audioInput: 0,
    textOutput: 0.5,
    audioOutput: 0,
    estimated: true,
  },
  'claude-haiku-4': {
    textInput: 1,
    cachedInput: 0.1,
    audioInput: 0,
    textOutput: 5,
    audioOutput: 0,
    estimated: true,
  },
  'claude-haiku': {
    textInput: 1,
    cachedInput: 0.1,
    audioInput: 0,
    textOutput: 5,
    audioOutput: 0,
    estimated: true,
  },
  'claude-3-5-haiku': {
    textInput: 0.8,
    cachedInput: 0.08,
    audioInput: 0,
    textOutput: 4,
    audioOutput: 0,
    estimated: true,
  },
  'claude-3-5-sonnet': {
    textInput: 3,
    cachedInput: 0.3,
    audioInput: 0,
    textOutput: 15,
    audioOutput: 0,
    estimated: true,
  },
  'claude-3-7-sonnet': {
    textInput: 3,
    cachedInput: 0.3,
    audioInput: 0,
    textOutput: 15,
    audioOutput: 0,
    estimated: true,
  },
  'claude-3-opus': {
    textInput: 15,
    cachedInput: 1.5,
    audioInput: 0,
    textOutput: 75,
    audioOutput: 0,
    estimated: true,
  },
};

const CHAR_RATES_PER_MILLION = {
  'gpt-4o-mini-tts': 15,
  'tts-1-hd': 30,
  'tts-1': 15,
  azure: 16,
};

const MINUTE_RATES = {
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
  azure: 0.0167,
};

const UNPRICED_PROVIDERS = new Set(['cursor']);

const OPENROUTER_FALLBACK = {
  textInput: 0.15,
  cachedInput: 0.075,
  audioInput: 0,
  textOutput: 0.6,
  audioOutput: 0,
};

/**
 * Opus naming is `claude-opus-<major>[-<minor>][-<date>]`. Anything at 4.5 or
 * newer (including a future major) is billed at the lower $5/$25 tier, while
 * bare `claude-opus-4` and `claude-opus-4-1` keep the legacy $15/$75 tier.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isOpus45Plus(raw) {
  const match = /^claude-opus-(\d+)(?:[.-](\d{1,2}))?(?![0-9])/.exec(raw);
  if (!match) return false;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return false;
  if (major !== 4) return major > 4;
  const minor = match[2] == null ? null : Number(match[2]);
  return minor != null && Number.isFinite(minor) && minor >= 5;
}

/**
 * @param {string} model
 * @param {string} provider
 * @returns {typeof TOKEN_RATES['gpt-realtime']|null}
 */
function resolveTokenRates(model, provider) {
  return resolveTokenRatesWithSource(model, provider)?.rates ?? null;
}

/**
 * Like `resolveTokenRates` but also names where the row came from:
 * `token_rates` is a model-prefix match; `provider_fallback` is a generic
 * per-provider row used for a model the table does not know. A fallback is
 * always an estimate and is flagged so it is never mistaken for a firm price.
 *
 * @param {string} model
 * @param {string} provider
 * @returns {{ rates: typeof TOKEN_RATES['gpt-realtime'], source: string, estimated: boolean }|null}
 */
function resolveTokenRatesWithSource(model, provider) {
  const raw = String(model || '').toLowerCase();
  const known = (rates) => ({ rates, source: 'token_rates', estimated: rates.estimated === true });
  const fallback = (rates) => ({ rates, source: 'provider_fallback', estimated: true });
  if (isOpus45Plus(raw)) return known(TOKEN_RATES['claude-opus-4-5']);
  let bestPrefix = '';
  /** @type {typeof TOKEN_RATES['gpt-realtime']|null} */
  let bestRates = null;
  for (const [prefix, rates] of Object.entries(TOKEN_RATES)) {
    if (raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestRates = rates;
    }
  }
  if (bestRates) return known(bestRates);
  if (provider === 'google') return fallback(TOKEN_RATES.gemini);
  if (provider === 'openrouter') return fallback(OPENROUTER_FALLBACK);
  if (provider === 'openai') return fallback(TOKEN_RATES['gpt-realtime']);
  return null;
}

/**
 * Claude Code aliases mapped to the current numbered ids. Kept in sync with
 * `CLAUDE_KNOWN_MODELS` in `lib/claude/claude-models.ts` (a test pins this);
 * it is duplicated because this module is part of the browser bundle and must
 * not import the server-side catalog. `default` is intentionally absent: it
 * names whatever model the CLI picks, so it has no rate of its own.
 */
export const CLAUDE_ALIAS_CURRENT_ID = Object.freeze({
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
});

/**
 * @param {unknown} value
 * @returns {number|null} USD per million tokens, or `null` when not a price
 */
function perMillionFromPerToken(value) {
  const numeric = Number(value);
  if (value == null || value === '' || !Number.isFinite(numeric) || numeric < 0) return null;
  return numeric * 1_000_000;
}

/**
 * Token rates for the cost proxy only (never for billing). Unlike
 * `resolveTokenRates` it answers solely on an exact match and has no provider
 * fallbacks (`OPENROUTER_FALLBACK`, Gemini or realtime rates): an unknown model
 * yields `null` so the caller can use its tier table instead of a made-up rate.
 *
 * - A Claude alias (`opus`/`sonnet`/`haiku`) is first mapped to the current
 *   numbered id and then resolved like that id (including `isOpus45Plus`), so
 *   `opus` and `claude-opus-5-5` get the same rate. `default` has none.
 * - A `::param=value` suffix (effort variant) is ignored.
 * - For provider `openrouter` a catalog `pricing` row (`prompt`/`completion`
 *   in USD per token) is an exact price and wins over a name prefix.
 *
 * @param {string} model
 * @param {string} [provider]
 * @param {{ openrouterPricing?: { prompt?: unknown, completion?: unknown } | null }} [options]
 * @returns {{ textInput: number, textOutput: number, estimated: boolean, source: 'openrouter_pricing' | 'token_rates' } | null}
 */
export function estimateTokenRates(model, provider = '', options = {}) {
  const withoutParams = String(model || '').split('::')[0].trim().toLowerCase();
  if (!withoutParams || withoutParams === 'default' || withoutParams === 'auto') return null;
  if (String(provider || '').toLowerCase() === 'openrouter') {
    const pricing = options?.openrouterPricing;
    const input = perMillionFromPerToken(pricing?.prompt);
    const output = perMillionFromPerToken(pricing?.completion);
    if (input != null && output != null) {
      return { textInput: input, textOutput: output, estimated: false, source: 'openrouter_pricing' };
    }
  }
  const raw = CLAUDE_ALIAS_CURRENT_ID[withoutParams] || withoutParams;
  /** @type {typeof TOKEN_RATES['gpt-realtime']|null} */
  let rates = null;
  if (isOpus45Plus(raw)) {
    rates = TOKEN_RATES['claude-opus-4-5'];
  } else {
    let bestPrefix = '';
    for (const [prefix, row] of Object.entries(TOKEN_RATES)) {
      if (raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        rates = row;
      }
    }
  }
  if (!rates) return null;
  return {
    textInput: rates.textInput,
    textOutput: rates.textOutput,
    estimated: rates.estimated === true,
    source: 'token_rates',
  };
}

/**
 * Read-only tariff lookup for cost-control decisions (keep-alive economics).
 *
 * Returns `null` whenever the price is not a firm table entry: unknown model,
 * an estimated fallback table, the subscription-billed Cursor SDK. Callers must
 * treat `null` as "cost unknown", never as zero.
 *
 * @param {string} model
 * @param {string} [provider]
 * @param {string} [harness]
 * @returns {{ textInput: number, textOutput: number, cachedInput: number, cacheWrite: number|null }|null}
 */
export function lookupFirmTokenRates(model, provider = 'other', harness = '') {
  if (harness === 'sdk' || UNPRICED_PROVIDERS.has(provider)) return null;
  const rates = resolveTokenRates(model, provider);
  if (!rates || rates.estimated === true) return null;
  return {
    textInput: Number(rates.textInput) || 0,
    textOutput: Number(rates.textOutput) || 0,
    cachedInput: Number(rates.cachedInput) || 0,
    cacheWrite: rates.cacheWrite == null ? null : Number(rates.cacheWrite),
  };
}

/**
 * @param {string} model
 * @param {string} provider
 * @returns {number}
 */
function resolveCharRate(model, provider) {
  const raw = String(model || '').toLowerCase();
  let bestPrefix = '';
  let bestRate = 0;
  for (const [prefix, rate] of Object.entries(CHAR_RATES_PER_MILLION)) {
    if (raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestRate = rate;
    }
  }
  if (bestRate) return bestRate;
  return provider === 'azure' ? CHAR_RATES_PER_MILLION.azure : 0;
}

/**
 * @param {string} model
 * @param {string} provider
 * @returns {number}
 */
function resolveMinuteRate(model, provider) {
  const raw = String(model || '').toLowerCase();
  let bestPrefix = '';
  let bestRate = 0;
  for (const [prefix, rate] of Object.entries(MINUTE_RATES)) {
    if (raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestRate = rate;
    }
  }
  if (bestRate) return bestRate;
  return provider === 'azure' ? MINUTE_RATES.azure : 0;
}

/**
 * @param {Record<string, any>} event
 * @returns {Record<string, any>}
 */
export function priceUsage(event) {
  if (!event || typeof event !== 'object') return { usd: null };
  // A stored event keeps the pricing snapshot it was priced with; a caller
  // re-running priceUsage on a fresh event never inherits a stale one.
  if (event.pricing !== undefined) {
    const { pricing: _stale, ...rest } = event;
    return priceUsageFresh(rest);
  }
  return priceUsageFresh(event);
}

/**
 * Snapshot of the per-million rates actually applied to one event.
 *
 * @param {Record<string, any>} rates
 * @returns {Record<string, number>}
 */
function snapshotTokenRates(rates) {
  const out = {};
  for (const key of ['textInput', 'cachedInput', 'cacheWrite', 'audioInput', 'textOutput', 'audioOutput']) {
    const value = rates[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  // Cache writes fall back to the input rate; record the rate really used.
  if (out.cacheWrite === undefined && out.textInput !== undefined) out.cacheWrite = out.textInput;
  return out;
}

/**
 * @param {Record<string, any>} event
 * @returns {Record<string, any>}
 */
function priceUsageFresh(event) {
  const billingClass = String(event.billingClass || '').trim().toLowerCase();
  if (billingClass === 'subscription_quota' || billingClass === 'local') {
    return { ...event, usd: null };
  }
  if (billingClass === 'unknown') {
    const reportedEarly = Number(event.reportedUsd);
    if (!Number.isFinite(reportedEarly) || reportedEarly < 0) {
      return { ...event, usd: null };
    }
  }
  if (event.billingRateTableKey === false) {
    return { ...event, usd: null };
  }
  // The Cursor SDK runs on a subscription regardless of the backing provider.
  if (event.harness === 'sdk' || UNPRICED_PROVIDERS.has(event.provider)) {
    return { ...event, usd: null };
  }
  // Run events carry outcome/latency only, never billable quantities.
  if (event.eventType === 'run') return { ...event, usd: null };
  // Prepaid plans (Claude subscription/plan login) have no marginal USD cost.
  if (event.billingMode === 'subscription') return { ...event, usd: null };
  // A provider-reported actual cost (e.g. Claude `total_cost_usd`) is not an
  // estimate, so it wins over the static table.
  const reported = Number(event.reportedUsd);
  if (Number.isFinite(reported) && reported >= 0) {
    return {
      ...event,
      usd: Number(reported.toFixed(6)),
      estimated: false,
      pricing: { source: 'reported', reportedUsd: Number(reported.toFixed(6)) },
    };
  }
  const tokens = event.tokens || {};
  const resolved = resolveTokenRatesWithSource(event.model, event.provider);
  const tokenRates = resolved?.rates ?? null;
  const ratesEstimated = resolved?.estimated === true;
  const hasTokenQty =
    (tokens.textInput || 0) +
      (tokens.textOutput || 0) +
      (tokens.audioInput || 0) +
      (tokens.audioOutput || 0) +
      (tokens.cachedInput || 0) +
      (tokens.cacheWrite || 0) +
      (tokens.reasoning || 0) >
    0;
  const chars = Number(event.characters) || 0;
  const seconds = Number(event.audioSeconds) || 0;
  if (hasTokenQty && !tokenRates && chars <= 0 && seconds <= 0) {
    // Never guess a rate for an unrecognised model: leave it unpriced and say why.
    return { ...event, usd: null, pricing: { source: 'none', reason: 'unknown_model' } };
  }
  let usd = 0;
  if (tokenRates) {
    usd +=
      (tokens.textInput * tokenRates.textInput +
        (tokens.cachedInput || 0) * tokenRates.cachedInput +
        // Cache writes are billed at the input rate unless a dedicated rate is
        // declared. This keeps the already-detected cache-write bucket priced.
        (tokens.cacheWrite || 0) * (tokenRates.cacheWrite ?? tokenRates.textInput) +
        tokens.audioInput * tokenRates.audioInput +
        tokens.textOutput * tokenRates.textOutput +
        tokens.audioOutput * tokenRates.audioOutput) /
      1_000_000;
  }
  const charRate = chars > 0 ? resolveCharRate(event.model, event.provider) : 0;
  const minuteRate = seconds > 0 ? resolveMinuteRate(event.model, event.provider) : 0;
  if (chars > 0) usd += (chars * charRate) / 1_000_000;
  if (seconds > 0) usd += (seconds / 60) * minuteRate;
  if (hasTokenQty && usd === 0 && !tokenRates) {
    return { ...event, usd: null, pricing: { source: 'none', reason: 'unknown_model' } };
  }
  /** @type {Record<string, unknown>} */
  const pricing = {
    source: tokenRates ? resolved.source : 'token_rates',
    ratesVersion: TOKEN_RATES_VERSION,
    ratesCapturedAt: TOKEN_RATES_CAPTURED_AT,
  };
  if (tokenRates) pricing.rates = snapshotTokenRates(tokenRates);
  if (charRate > 0) pricing.charRatePerMillion = charRate;
  if (minuteRate > 0) pricing.minuteRate = minuteRate;
  return {
    ...event,
    usd: Number(usd.toFixed(6)),
    estimated: event.estimated === true || ratesEstimated,
    pricing,
  };
}

/**
 * @param {number|null|undefined} usd
 * @returns {string}
 */
export function formatUsd(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return '—';
  const value = Number(usd);
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}
