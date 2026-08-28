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
 * @param {string} model
 * @param {string} provider
 * @returns {typeof TOKEN_RATES['gpt-realtime']|null}
 */
function resolveTokenRates(model, provider) {
  const raw = String(model || '').toLowerCase();
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
  if (UNPRICED_PROVIDERS.has(event.provider)) return { ...event, usd: null };
  const tokens = event.tokens || {};
  const tokenRates = resolveTokenRates(event.model, event.provider);
  const hasTokenQty =
    (tokens.textInput || 0) +
      (tokens.textOutput || 0) +
      (tokens.audioInput || 0) +
      (tokens.audioOutput || 0) +
      (tokens.cachedInput || 0) +
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
        tokens.audioInput * tokenRates.audioInput +
        tokens.textOutput * tokenRates.textOutput +
        tokens.audioOutput * tokenRates.audioOutput) /
      1_000_000;
  }
  if (chars > 0) usd += (chars * resolveCharRate(event.model, event.provider)) / 1_000_000;
  if (seconds > 0) usd += (seconds / 60) * resolveMinuteRate(event.model, event.provider);
  return { ...event, usd: Number(usd.toFixed(6)) };
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
