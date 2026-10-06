/**
 * Approximate USD rates for the usage ledger. Not an invoice.
 * Token rates: USD per million. Longest model-prefix wins.
 */

const TOKEN_RATES = {
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
  const raw = String(model || '').toLowerCase();
  if (isOpus45Plus(raw)) return TOKEN_RATES['claude-opus-4-5'];
  let bestPrefix = '';
  /** @type {typeof TOKEN_RATES['gpt-realtime']|null} */
  let bestRates = null;
  for (const [prefix, rates] of Object.entries(TOKEN_RATES)) {
    if (raw.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestRates = rates;
    }
  }
  if (bestRates) return bestRates;
  if (provider === 'google') return TOKEN_RATES.gemini;
  if (provider === 'openrouter') return OPENROUTER_FALLBACK;
  if (provider === 'openai') return TOKEN_RATES['gpt-realtime'];
  return null;
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
 * @param {object} event
 * @returns {object}
 */
export function priceUsage(event) {
  if (!event || typeof event !== 'object') return { usd: null };
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
    return { ...event, usd: Number(reported.toFixed(6)), estimated: false };
  }
  const tokens = event.tokens || {};
  const tokenRates = resolveTokenRates(event.model, event.provider);
  const ratesEstimated = tokenRates?.estimated === true;
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
    return { ...event, usd: null };
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
  if (chars > 0) usd += (chars * resolveCharRate(event.model, event.provider)) / 1_000_000;
  if (seconds > 0) usd += (seconds / 60) * resolveMinuteRate(event.model, event.provider);
  return {
    ...event,
    usd: Number(usd.toFixed(6)),
    estimated: event.estimated === true || ratesEstimated,
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
