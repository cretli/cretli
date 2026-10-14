/**
 * Registry of external benchmark data sources (plan v10 §2.5, audit 2026-10-14).
 *
 * Automatic fetch is intentionally disabled: operators import bounded snapshots
 * after a separate terms-verification step, or trigger one explicit keyed API
 * fetch for a source marked `manualFetchSupported`. Benchmark data only ever
 * reaches the model_pick SHADOW explanation (`lib/model-pick-benchmark.js`);
 * nothing here changes the selection.
 *
 * Each real source carries the audit result: `licenseStatus`, `licenseNotes`,
 * `termsCheckedAt`, `officialTermsUrl`, and `scrapingAllowed` (never true).
 */

/** @typedef {'allowed_api_only' | 'prohibited_automated' | 'unverified' | 'not_applicable'} BenchmarkLicenseStatus */

/** Date the provider terms were audited against the official pages. */
export const BENCHMARK_TERMS_AUDITED_AT = '2026-10-14';

/** Attribution string required by the Artificial Analysis free API terms. */
export const ARTIFICIAL_ANALYSIS_ATTRIBUTION = 'Benchmark data: Artificial Analysis (https://artificialanalysis.ai/)';

/** @typedef {'healthy' | 'offline' | 'disabled' | 'unknown'} BenchmarkSourceHealth */

/** @typedef {'none' | 'provider_api_key' | 'usage_metered'} BenchmarkOutgoingMetadata */

/** @typedef {'not_applicable' | 'disabled' | 'never_attempted'} BenchmarkNetworkAttemptStatus */

/**
 * Built-in source definitions (fictional example providers only).
 * @type {ReadonlyArray<object>}
 */
export const BENCHMARK_BUILTIN_SOURCES = Object.freeze([
  Object.freeze({
    id: 'local-fixture',
    fictional: true,
    provider: 'Cretli fixture',
    officialTermsUrl: 'https://example.com/benchmark-fixture-terms',
    endpointPurpose: 'Local fictional rows for UI and import tests only',
    fetchEnabled: false,
    networkAttemptStatus: 'not_applicable',
    outgoingMetadata: 'none',
    cacheTtlMs: 0,
    keyRequired: false,
    pricingNote: 'No cost — fixture data only',
    defaultEnabled: true,
    licenseStatus: 'not_applicable',
    mappingDimensions: Object.freeze(['release', 'base', 'effort']),
  }),
  Object.freeze({
    id: 'example-index',
    provider: 'Example Index',
    officialTermsUrl: 'https://example.com/benchmark-api/terms',
    endpointPurpose: 'Public model capability index (import-only in this release)',
    fetchEnabled: false,
    networkAttemptStatus: 'not_applicable',
    outgoingMetadata: 'none',
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    keyRequired: false,
    pricingNote: 'Free read tier; automated fetch not enabled yet',
    defaultEnabled: false,
    licenseStatus: 'not_applicable',
    mappingDimensions: Object.freeze(['release', 'base', 'effort']),
  }),
  Object.freeze({
    id: 'artificial-analysis',
    provider: 'Artificial Analysis',
    officialTermsUrl: 'https://artificialanalysis.ai/terms-of-use',
    apiReferenceUrl: 'https://artificialanalysis.ai/api-reference',
    apiEndpoint: 'https://artificialanalysis.ai/api/v2/data/llms/models',
    endpointPurpose: 'Official free API: model intelligence/coding indices (one explicit operator-triggered request per fetch)',
    // Automatic/scheduled fetch stays off; `manualFetchSupported` allows one
    // keyed operator-triggered request through the official API only.
    fetchEnabled: false,
    manualFetchSupported: true,
    networkAttemptStatus: 'never_attempted',
    outgoingMetadata: 'provider_api_key',
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    keyRequired: true,
    keyHeader: 'x-api-key',
    dailyRequestLimit: 1000,
    attributionRequired: true,
    attribution: ARTIFICIAL_ANALYSIS_ATTRIBUTION,
    scrapingAllowed: false,
    licenseStatus: 'allowed_api_only',
    termsCheckedAt: BENCHMARK_TERMS_AUDITED_AT,
    licenseNotes: 'Site Terms of Use forbid scraping and automated queries of the website. The separate free API '
      + '(key in the x-api-key header, 1,000 requests/day, HTTP 429 when exceeded) requires attribution wherever '
      + 'data is shown, forbids client-side key use, and expects cached responses. Commercial use is governed by '
      + 'their Terms/Data Platform Terms and a separate commercial API. Allowed ONLY through the official API with '
      + 'a key; never scrape the site.',
    pricingNote: 'Free API tier; commercial use needs their separate commercial API',
    defaultEnabled: false,
    mappingDimensions: Object.freeze(['release', 'base', 'effort']),
  }),
  Object.freeze({
    id: 'arena-ai',
    provider: 'Arena (LMArena)',
    officialTermsUrl: 'https://help.arena.ai/articles/5629909088-terms-of-use',
    endpointPurpose: 'Display-only manual reference; no automated ingestion',
    fetchEnabled: false,
    manualFetchSupported: false,
    networkAttemptStatus: 'disabled',
    outgoingMetadata: 'none',
    cacheTtlMs: 0,
    keyRequired: false,
    attributionRequired: false,
    scrapingAllowed: false,
    licenseStatus: 'prohibited_automated',
    termsCheckedAt: BENCHMARK_TERMS_AUDITED_AT,
    licenseNotes: 'Terms prohibit automated scraping, extraction and download and forbid redistribution; no public '
      + 'dataset access is stated. Not allowed for automated ingestion; listed as a display-only manual reference.',
    pricingNote: 'Not applicable',
    defaultEnabled: false,
    mappingDimensions: Object.freeze([]),
  }),
  Object.freeze({
    id: 'aider-leaderboard',
    provider: 'Aider leaderboards',
    officialTermsUrl: 'https://aider.chat/docs/leaderboards/',
    endpointPurpose: 'Unverified; no ingestion until the data licence and a machine-readable path are confirmed',
    fetchEnabled: false,
    manualFetchSupported: false,
    networkAttemptStatus: 'disabled',
    outgoingMetadata: 'none',
    cacheTtlMs: 0,
    keyRequired: false,
    attributionRequired: false,
    scrapingAllowed: false,
    licenseStatus: 'unverified',
    termsCheckedAt: BENCHMARK_TERMS_AUDITED_AT,
    licenseNotes: 'The repository is Apache-2.0, but the licence of the leaderboard DATA and a machine-readable '
      + 'access path are not confirmed on the page. Registered as unverified and disabled; no ingestion.',
    pricingNote: 'Not applicable',
    defaultEnabled: false,
    mappingDimensions: Object.freeze([]),
  }),
]);

/**
 * Sources whose data may be used by the shadow layer. Everything else
 * (prohibited, unverified, fixtures) is excluded regardless of snapshots.
 *
 * @param {unknown} source
 * @returns {boolean}
 */
export function isBenchmarkSourceUsableForShadow(source) {
  const row = /** @type {Record<string, unknown> | null} */ (source && typeof source === 'object' ? source : null);
  return Boolean(row) && row.licenseStatus === 'allowed_api_only' && row.scrapingAllowed === false;
}

/** Local deployment mode: no outbound benchmark traffic. */
export const BENCHMARK_LOCAL_MODE = Object.freeze({
  fetchEnabled: false,
  networkAttemptStatus: 'not_applicable',
  outgoingMetadata: 'none',
});

/**
 * @param {string} sourceId
 * @returns {object | null}
 */
export function findBuiltinBenchmarkSource(sourceId) {
  const id = String(sourceId || '').trim();
  if (!id) return null;
  return BENCHMARK_BUILTIN_SOURCES.find((row) => row.id === id) || null;
}

/**
 * Merge persisted operator preferences onto built-in registry rows.
 *
 * @param {{ sourcePreferences?: Record<string, { enabled?: boolean }> }} [persisted]
 * @param {{ now?: number }} [options]
 * @returns {object[]}
 */
export function buildBenchmarkSourceRegistryView(persisted = {}, options = {}) {
  const prefs = persisted.sourcePreferences && typeof persisted.sourcePreferences === 'object'
    ? persisted.sourcePreferences
    : {};
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return BENCHMARK_BUILTIN_SOURCES.map((builtin) => {
    const pref = prefs[builtin.id];
    const enabled = typeof pref?.enabled === 'boolean' ? pref.enabled : builtin.defaultEnabled;
    const health = enabled ? 'unknown' : 'disabled';
    return {
      ...builtin,
      enabled,
      health,
      lastAttemptAt: null,
      lastSuccessAt: null,
      localMode: BENCHMARK_LOCAL_MODE,
      registryAt: new Date(now).toISOString(),
    };
  });
}
