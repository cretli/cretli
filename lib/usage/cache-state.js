/**
 * Per-chat prompt-cache state and TTL-aware warm/cold estimation.
 *
 * Providers give a prompt cache a limited idle lifetime. Knowing whether the
 * previous turn's prefix is still likely cached lets the UI and the cost
 * insights explain why a turn was expensive: a cold first turn after a pause
 * pays the full input price, a warm one pays the cache-read rate.
 *
 * Scope boundaries:
 * - This module is in-memory and best-effort. It never persists tokens, prompt
 *   content or secrets, and it is safe to call from a hot usage path.
 * - It is bounded: the number of tracked chats is capped and the
 *   least-recently-used entry is evicted first.
 * - `sdk-context-advisory.js` was checked first: it owns context-window fill
 *   heuristics and cache-aware input subtraction
 *   (`estimateEffectiveUsageInputTokens`, `findLastUsageEventPayload`) but has
 *   no prompt-cache TTL logic, so no duplication is introduced here.
 */

import { getContextRestartForChat, onContextInvalidation } from './context-restarts.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Warm/cold/unknown vocabulary used by `estimateCacheState`. */
export const CACHE_STATE = Object.freeze({
  WARM: 'warm',
  COLD: 'cold',
  UNKNOWN: 'unknown',
});

/** Stable reasons so callers can group and test estimates without parsing text. */
export const CACHE_STATE_REASON = Object.freeze({
  WITHIN_TTL: 'within_ttl',
  TTL_EXPIRED: 'ttl_expired',
  CONTEXT_EPOCH_CHANGED: 'context_epoch_changed',
  SESSION_RESTARTED: 'session_restarted',
  NO_CACHED_TURN: 'no_cached_turn',
  UNKNOWN_HARNESS: 'unknown_harness',
  UNKNOWN_TTL: 'unknown_ttl',
});

/** Bounded so a long-lived server never grows the map without limit. */
export const CACHE_STATE_LIMITS = Object.freeze({
  maxTrackedChats: 500,
});

/**
 * A pause at least this long before a zero-cache-read turn is treated as a
 * likely real miss. It is deliberately short: the event exists to calibrate the
 * real provider TTL from observed misses, not to be an authoritative TTL.
 */
export const DEFAULT_CACHE_MISS_PAUSE_MS = 5 * MINUTE_MS;

/**
 * Per-harness TTL table.
 *
 * The TTL is NOT a single provider constant:
 * - Anthropic (claude, and Anthropic-style codebuddy) defaults to a 5 minute
 *   cache TTL with an optional 1 hour tier; a cache hit refreshes the TTL.
 * - OpenAI (codex and OpenAI-compatible rows) uses `prompt_cache_retention`:
 *   `in_memory` keeps an idle entry for roughly 5-10 minutes (1 hour maximum)
 *   and does not refresh on a hit, while selected models can request 24 hours.
 * - qwen/DashScope resets a 5 minute TTL on every hit and has no 1 hour tier.
 * - deepseek, sdk (Cursor), opencode, openrouter and voice have automatic
 *   caches with no documented idle TTL, so `ttlKnown` stays false rather than
 *   inventing a number. An unknown TTL is reported as `unknown`, never warm.
 *
 * All durations are named parameters (`defaultTtlMs`, `extendedTtlMs`,
 * `maxTtlMs`) instead of scattered magic numbers.
 */
export const CACHE_TTL_TABLE = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    provider: 'anthropic',
    ttlKnown: true,
    defaultTtlMs: 5 * MINUTE_MS,
    extendedTtlMs: 1 * HOUR_MS,
    refreshOnHit: true,
    source: 'Anthropic prompt caching: 5 min default TTL, optional 1 h tier; a hit refreshes the TTL.',
  }),
  codebuddy: Object.freeze({
    harness: 'codebuddy',
    provider: 'anthropic',
    ttlKnown: true,
    defaultTtlMs: 5 * MINUTE_MS,
    extendedTtlMs: 1 * HOUR_MS,
    refreshOnHit: true,
    source: 'CodeBuddy is Anthropic-style automatic caching; 5 min is the documented default tier.',
  }),
  qwen: Object.freeze({
    harness: 'qwen',
    provider: 'dashscope',
    ttlKnown: true,
    defaultTtlMs: 5 * MINUTE_MS,
    extendedTtlMs: null,
    refreshOnHit: true,
    source: 'DashScope explicit context cache: 5 min TTL reset on every hit, no 1 h tier.',
  }),
  codex: Object.freeze({
    harness: 'codex',
    provider: 'openai',
    ttlKnown: true,
    defaultTtlMs: 5 * MINUTE_MS,
    maxTtlMs: 1 * HOUR_MS,
    extendedTtlMs: 24 * HOUR_MS,
    refreshOnHit: false,
    source:
      'OpenAI prompt_cache_retention: in_memory idles out around 5-10 min (1 h maximum) and is not refreshed by a hit; selected models can request 24 h. 5 min is the conservative default.',
  }),
  deepseek: Object.freeze({
    harness: 'deepseek',
    provider: 'deepseek',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'DeepSeek automatic disk cache lasts hours to days with no controls; exact idle TTL is unknown.',
  }),
  sdk: Object.freeze({
    harness: 'sdk',
    provider: 'cursor',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'Cursor SDK automatic caching; no documented idle TTL.',
  }),
  opencode: Object.freeze({
    harness: 'opencode',
    provider: 'opencode',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'OpenCode delegates caching to the upstream provider; idle TTL is unknown.',
  }),
  openrouter: Object.freeze({
    harness: 'openrouter',
    provider: 'openrouter',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'OpenRouter cache retention depends on the upstream provider; idle TTL is unknown.',
  }),
  mistral: Object.freeze({
    harness: 'mistral',
    provider: 'mistral',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'Mistral automatic caching; no documented idle TTL.',
  }),
  voice: Object.freeze({
    harness: 'voice',
    provider: 'openai',
    ttlKnown: false,
    defaultTtlMs: null,
    extendedTtlMs: null,
    refreshOnHit: false,
    source: 'Realtime voice cache behavior is not documented; treated as unknown.',
  }),
});

/**
 * Harness/provider spellings that map onto a table row. Providers only appear
 * when the caller passes a provider without a harness id.
 */
const CACHE_TTL_ALIASES = Object.freeze({
  anthropic: 'claude',
  openai: 'codex',
  dashscope: 'qwen',
  alibaba: 'qwen',
  cursor: 'sdk',
});

/**
 * @typedef {{
 *   chatId: string,
 *   harness: string,
 *   model: string,
 *   lastTurnAt: number|null,
 *   lastCachedTurnAt: number|null,
 *   lastCachedInputTokens: number,
 *   lastCacheWriteTokens: number,
 *   lastContextEpoch: number|null,
 *   missLoggedForPause: boolean,
 *   invalidatedAt: number|null,
 *   invalidatedReason: string|null,
 *   turns: number,
 * }} CacheStateEntry
 */

/** @type {Map<string, CacheStateEntry>} */
const chats = new Map();

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveNow(value, fallback = Date.now()) {
  const parsed = finiteNumber(value);
  return parsed == null ? fallback : parsed;
}

/**
 * @param {unknown} chatId
 * @returns {string}
 */
function normalizeChatId(chatId) {
  return text(chatId) || 'unknown';
}

/**
 * Resolves a harness id (or provider when no harness is known) to a TTL row id.
 *
 * @param {unknown} harness
 * @param {unknown} [provider]
 * @returns {string}
 */
function normalizeHarnessId(harness, provider) {
  const raw = text(harness).toLowerCase();
  if (CACHE_TTL_TABLE[raw]) return raw;
  if (CACHE_TTL_ALIASES[raw]) return CACHE_TTL_ALIASES[raw];
  const providerId = text(provider).toLowerCase();
  if (CACHE_TTL_ALIASES[providerId]) return CACHE_TTL_ALIASES[providerId];
  if (CACHE_TTL_TABLE[providerId]) return providerId;
  return raw;
}

/**
 * Resolves the TTL descriptor for a harness/model combination.
 *
 * `retention: 'extended'` selects the long tier when the provider has one
 * (Anthropic 1 h, OpenAI 24 h). An unknown TTL returns `{ known: false }` so
 * callers can stay conservative instead of assuming a number.
 *
 * @param {{ harness?: unknown, model?: unknown, provider?: unknown, retention?: unknown }} [input]
 * @returns {{
 *   harness: string,
 *   provider: string|null,
 *   model: string,
 *   known: boolean,
 *   ttlMs: number|null,
 *   defaultTtlMs: number|null,
 *   extendedTtlMs: number|null,
 *   maxTtlMs: number|null,
 *   refreshOnHit: boolean,
 *   reasonUnknown: string|null,
 *   source: string|null,
 * }}
 */
export function resolveCacheTtl(input = {}) {
  const id = normalizeHarnessId(input.harness, input.provider);
  const model = text(input.model);
  const entry = CACHE_TTL_TABLE[id];
  if (!entry) {
    return {
      harness: id || 'unknown',
      provider: null,
      model,
      known: false,
      ttlMs: null,
      defaultTtlMs: null,
      extendedTtlMs: null,
      maxTtlMs: null,
      refreshOnHit: false,
      reasonUnknown: CACHE_STATE_REASON.UNKNOWN_HARNESS,
      source: null,
    };
  }
  const extended = text(input.retention).toLowerCase() === 'extended';
  const ttlMs = entry.ttlKnown
    ? (extended && entry.extendedTtlMs != null ? entry.extendedTtlMs : entry.defaultTtlMs)
    : null;
  const known = entry.ttlKnown === true && Number.isFinite(ttlMs) && ttlMs > 0;
  return {
    harness: entry.harness,
    provider: entry.provider ?? null,
    model,
    known,
    ttlMs: known ? ttlMs : null,
    defaultTtlMs: entry.defaultTtlMs ?? null,
    extendedTtlMs: entry.extendedTtlMs ?? null,
    maxTtlMs: entry.maxTtlMs ?? null,
    refreshOnHit: entry.refreshOnHit === true,
    reasonUnknown: known ? null : CACHE_STATE_REASON.UNKNOWN_TTL,
    source: entry.source ?? null,
  };
}

/**
 * Re-inserts an entry at the LRU tail and enforces the tracked-chat cap.
 *
 * @param {string} chatId
 * @param {CacheStateEntry} entry
 * @returns {void}
 */
function touchEntry(chatId, entry) {
  chats.delete(chatId);
  chats.set(chatId, entry);
  while (chats.size > CACHE_STATE_LIMITS.maxTrackedChats) {
    const oldest = chats.keys().next().value;
    if (oldest === undefined) break;
    chats.delete(oldest);
  }
}

/**
 * @param {string} chatId
 * @returns {CacheStateEntry}
 */
function createEntry(chatId) {
  return {
    chatId,
    harness: '',
    model: '',
    lastTurnAt: null,
    lastCachedTurnAt: null,
    lastCachedInputTokens: 0,
    lastCacheWriteTokens: 0,
    lastContextEpoch: null,
    missLoggedForPause: false,
    invalidatedAt: null,
    invalidatedReason: null,
    turns: 0,
  };
}

/**
 * One compact console line, mirroring `context-restarts.js#logContextRestart`.
 * Suppressed in isolated test runs so suites stay quiet. Carries no prompt
 * content, only harness/model and the observed pause length.
 *
 * @param {{
 *   chatId: string,
 *   harness: string,
 *   model: string,
 *   pauseMinutes: number,
 *   ttlMs: number|null,
 *   at: number,
 * }} event
 * @returns {void}
 */
function logCacheMiss(event) {
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  console.info('[cache-state]', JSON.stringify({ event: 'cache_miss_after_pause', ...event }));
}

/**
 * Marks a chat's cache as invalid after a restart or compaction. Only an
 * already-tracked chat is mutated so a restart storm cannot grow the map.
 *
 * The cached counters are cleared, but `lastCachedTurnAt` is kept so age and
 * the `session_restarted` reason remain explainable; a later real cache hit
 * clears the invalidation.
 *
 * @param {{ chatId?: unknown, at?: unknown, reason?: unknown, harness?: unknown }} [input]
 * @returns {boolean} true when an existing entry was invalidated
 */
export function invalidateCacheState(input = {}) {
  const chatId = normalizeChatId(input.chatId);
  const entry = chats.get(chatId);
  if (!entry) return false;
  entry.invalidatedAt = resolveNow(input.at);
  entry.invalidatedReason = text(input.reason) || 'context_reset';
  if (input.harness && !entry.harness) entry.harness = text(input.harness);
  entry.lastCachedInputTokens = 0;
  entry.lastCacheWriteTokens = 0;
  entry.missLoggedForPause = false;
  touchEntry(chatId, entry);
  return true;
}

// A recorded restart or a compaction epoch bump invalidates the per-chat cache,
// so the next turn's cost is explained instead of silently attributed to it.
onContextInvalidation((event) => {
  invalidateCacheState(event);
});

/**
 * Records one turn's cache observation and, when the first turn after a
 * meaningful pause reads no cache, logs a calibration event once per pause.
 *
 * `lastTurnAt` is always advanced; `lastCachedTurnAt` and the cached counters
 * only advance on a real cache read (`cachedInput > 0`). A cache write alone is
 * not a hit, so it only updates `lastCacheWriteTokens` when there is also a read.
 *
 * @param {{
 *   chatId?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   tokens?: { cachedInput?: unknown, cacheRead?: unknown, cacheWrite?: unknown, cacheWriteTokens?: unknown } | null,
 *   contextEpoch?: unknown,
 *   now?: unknown,
 *   missPauseMs?: unknown,
 * }} [input]
 * @returns {{ chatId: string, cachedInput: number, cacheWrite: number, pauseMs: number|null, missLogged: boolean } | null}
 */
export function noteHarnessCacheState(input = {}) {
  const chatId = text(input.chatId);
  if (!chatId) return null;
  const now = resolveNow(input.now);
  const cachedInput = toCount(input.tokens?.cachedInput ?? input.tokens?.cacheRead);
  const cacheWrite = toCount(input.tokens?.cacheWrite ?? input.tokens?.cacheWriteTokens);
  const harness = text(input.harness);
  const model = text(input.model);
  let entry = chats.get(chatId);
  if (!entry) entry = createEntry(chatId);
  const previousTurnAt = entry.lastTurnAt;
  const pauseMs = previousTurnAt == null ? null : Math.max(0, now - previousTurnAt);
  if (harness) entry.harness = harness;
  if (model) entry.model = model;
  entry.lastTurnAt = now;
  entry.turns += 1;
  let missLogged = false;
  if (cachedInput > 0) {
    entry.lastCachedTurnAt = now;
    entry.lastCachedInputTokens = cachedInput;
    entry.lastCacheWriteTokens = cacheWrite;
    const epoch = finiteNumber(input.contextEpoch);
    if (epoch != null) entry.lastContextEpoch = epoch;
    entry.missLoggedForPause = false;
    // A fresh hit proves the provider cache is alive again after an invalidation.
    entry.invalidatedAt = null;
    entry.invalidatedReason = null;
  } else if (previousTurnAt != null && entry.lastCachedTurnAt != null && !entry.missLoggedForPause) {
    const missPauseMs = toCount(input.missPauseMs) || DEFAULT_CACHE_MISS_PAUSE_MS;
    const ttl = resolveCacheTtl({ harness: harness || entry.harness, model: model || entry.model });
    // "after a pause" means past the provider TTL or past the shorter
    // calibration threshold, whichever hits first.
    const thresholdMs = ttl.known ? Math.min(ttl.ttlMs, missPauseMs) : missPauseMs;
    if (pauseMs >= thresholdMs) {
      entry.missLoggedForPause = true;
      missLogged = true;
      logCacheMiss({
        chatId,
        harness: harness || entry.harness || 'unknown',
        model: model || entry.model || '',
        pauseMinutes: Number((pauseMs / MINUTE_MS).toFixed(2)),
        ttlMs: ttl.ttlMs,
        at: now,
      });
    }
  }
  touchEntry(chatId, entry);
  return { chatId, cachedInput, cacheWrite, pauseMs, missLogged };
}

/**
 * @param {CacheStateEntry|null} entry
 * @param {string} chatId
 * @returns {Record<string, unknown>|null}
 */
function snapshotEntry(entry, chatId) {
  if (!entry) return null;
  return {
    chatId,
    harness: entry.harness || null,
    model: entry.model || null,
    lastTurnAt: entry.lastTurnAt,
    lastCachedTurnAt: entry.lastCachedTurnAt,
    lastCachedInputTokens: entry.lastCachedInputTokens,
    lastCacheWriteTokens: entry.lastCacheWriteTokens,
    lastContextEpoch: entry.lastContextEpoch,
    invalidatedAt: entry.invalidatedAt,
    invalidatedReason: entry.invalidatedReason,
    turns: entry.turns,
  };
}

/**
 * @param {unknown} chatId
 * @returns {Record<string, unknown>|null}
 */
export function getCacheStateForChat(chatId) {
  const id = normalizeChatId(chatId);
  return snapshotEntry(chats.get(id), id);
}

/**
 * Estimates whether the chat's previous prefix is still cached.
 *
 * Warm only when the last cached turn is within the resolved TTL AND the room's
 * context epoch has not changed AND no restart/compaction was recorded after
 * that turn. Everything that cannot be established returns `unknown` rather
 * than a fabricated warm/cold verdict.
 *
 * @param {unknown} chatId
 * @param {{
 *   now?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   provider?: unknown,
 *   retention?: unknown,
 *   contextEpoch?: unknown,
 * }} [options]
 * @returns {{
 *   chatId: string,
 *   state: 'warm'|'cold'|'unknown',
 *   reason: string,
 *   ttlMs: number|null,
 *   ttlKnown: boolean,
 *   refreshOnHit: boolean,
 *   ageMs: number|null,
 *   ageMinutes: number|null,
 *   harness: string,
 *   model: string,
 *   lastCachedTurnAt: number|null,
 *   lastCachedInputTokens: number,
 *   lastCacheWriteTokens: number,
 *   lastContextEpoch: number|null,
 *   expiresInMs?: number,
 *   invalidationReason?: string,
 * }}
 */
export function estimateCacheState(chatId, options = {}) {
  const id = normalizeChatId(chatId);
  const now = resolveNow(options.now);
  const entry = chats.get(id);
  const harness = text(options.harness) || entry?.harness || '';
  const model = text(options.model) || entry?.model || '';
  const ttl = resolveCacheTtl({
    harness,
    model,
    provider: options.provider,
    retention: options.retention,
  });
  if (!entry || entry.lastCachedTurnAt == null) {
    return {
      chatId: id,
      state: CACHE_STATE.UNKNOWN,
      reason: CACHE_STATE_REASON.NO_CACHED_TURN,
      ttlMs: ttl.ttlMs,
      ttlKnown: ttl.known,
      refreshOnHit: ttl.refreshOnHit,
      ageMs: null,
      ageMinutes: null,
      harness,
      model,
      lastCachedTurnAt: null,
      lastCachedInputTokens: 0,
      lastCacheWriteTokens: 0,
      lastContextEpoch: null,
    };
  }
  const ageMs = Math.max(0, now - entry.lastCachedTurnAt);
  const base = {
    chatId: id,
    ttlMs: ttl.ttlMs,
    ttlKnown: ttl.known,
    refreshOnHit: ttl.refreshOnHit,
    ageMs,
    ageMinutes: Number((ageMs / MINUTE_MS).toFixed(2)),
    harness: harness || entry.harness,
    model: model || entry.model,
    lastCachedTurnAt: entry.lastCachedTurnAt,
    lastCachedInputTokens: entry.lastCachedInputTokens,
    lastCacheWriteTokens: entry.lastCacheWriteTokens,
    lastContextEpoch: entry.lastContextEpoch,
  };
  if (!ttl.known) {
    return {
      ...base,
      state: CACHE_STATE.UNKNOWN,
      reason: ttl.reasonUnknown || CACHE_STATE_REASON.UNKNOWN_TTL,
    };
  }
  const currentEpoch = finiteNumber(options.contextEpoch);
  if (
    currentEpoch != null
    && entry.lastContextEpoch != null
    && currentEpoch !== entry.lastContextEpoch
  ) {
    return { ...base, state: CACHE_STATE.COLD, reason: CACHE_STATE_REASON.CONTEXT_EPOCH_CHANGED };
  }
  if (entry.invalidatedAt != null && entry.invalidatedAt >= entry.lastCachedTurnAt) {
    return {
      ...base,
      state: CACHE_STATE.COLD,
      reason: CACHE_STATE_REASON.SESSION_RESTARTED,
      invalidationReason: entry.invalidatedReason || undefined,
    };
  }
  const restart = getContextRestartForChat(id);
  if (restart && restart.events.some((event) => Number(event.at) > entry.lastCachedTurnAt)) {
    return { ...base, state: CACHE_STATE.COLD, reason: CACHE_STATE_REASON.SESSION_RESTARTED };
  }
  if (ageMs > ttl.ttlMs) {
    return { ...base, state: CACHE_STATE.COLD, reason: CACHE_STATE_REASON.TTL_EXPIRED };
  }
  return {
    ...base,
    state: CACHE_STATE.WARM,
    reason: CACHE_STATE_REASON.WITHIN_TTL,
    expiresInMs: Math.max(0, ttl.ttlMs - ageMs),
  };
}

/**
 * Test-only reset. Never called from production paths.
 *
 * @returns {void}
 */
export function resetCacheStateForTests() {
  chats.clear();
}
