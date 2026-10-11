/**
 * Display-only registry of external benchmark data sources.
 *
 * Automatic fetch is intentionally disabled in local mode: operators import
 * bounded snapshots after a separate terms-verification step. Nothing here
 * participates in model_pick ranking.
 */

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
    mappingDimensions: Object.freeze(['release', 'base', 'effort']),
  }),
]);

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
