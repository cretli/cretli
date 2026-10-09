/**
 * Durable last-good cache for the OpenRouter endpoint model catalog + pricing.
 *
 * This module owns storage and the purely local read path only. The single HTTP
 * client stays in `./openrouter-models.js` (S1 of the stage-3 leaf): this file
 * never calls `fetch`. Stage 4 (`model_pick`) reads prices from here with a
 * synchronous, network-free getter; it must never trigger a refresh.
 *
 * ## Pricing semantics (endpoint catalog, not a provider/subscription price)
 * Values come from OpenRouter's `GET /api/v1/models` catalog, where `pricing`
 * holds USD-per-token strings. They are the **endpoint** price for an
 * `api_metered` key: not a direct provider API price and not a subscription
 * charge. Every value therefore carries `source`/`source_version`,
 * `fetched_at`/`observed_at`, `kind`, `source_class` and an attribution note.
 *
 * Counts are exact: `getOpenRouterEndpointPricing` matches the OpenRouter model
 * id case-sensitively with no substring/prefix/fuzzy join.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

/** File under the data directory holding the last good catalog copy. */
export const OPENROUTER_PRICING_CACHE_FILE_NAME = 'openrouter-models-pricing.json';

/** Version of the persisted cache payload. */
export const OPENROUTER_PRICING_CACHE_SCHEMA_VERSION = 'openrouter-pricing-cache-2026-10-08';

/** Source id used by stage-1 scoring facts (see docs/model-scoring-facts.md). */
export const OPENROUTER_PRICING_SOURCE = 'openrouter-catalog';

/** Stage-1 source class: an endpoint catalog estimate, never an invoice. */
export const OPENROUTER_PRICING_SOURCE_CLASS = 'endpoint_catalog';

/** Version of the OpenRouter payload shape this cache understands. */
export const OPENROUTER_PRICING_SOURCE_VERSION = 'openrouter-model-pricing-2026-10-08';

/** Stage-1 fact kind for a catalog price: an estimate of the endpoint price. */
export const OPENROUTER_PRICING_KIND = 'estimate';

/** OpenRouter route prices are pay-per-use, so they are `api_metered`. */
export const OPENROUTER_PRICING_BILLING_CLASS = 'api_metered';

/** Metric/unit of a catalog price value. */
export const OPENROUTER_PRICING_METRIC = 'usd';

/**
 * Human- and UI-readable attribution required by every displayed price value.
 * Also states the endpoint-vs-provider/subscription distinction (S5).
 */
export const OPENROUTER_PRICING_ATTRIBUTION =
  'OpenRouter endpoint catalog prices (USD per token) from GET /api/v1/models. '
  + 'These are endpoint prices for a metered API key, not a direct provider API '
  + 'price and not a subscription charge.';

/**
 * In-memory copy of the last good catalog. `memoryFilePath` records which
 * data-dir it came from so two data dirs cannot silently share one entry.
 *
 * @type {{
 *   schema_version: string,
 *   source: string,
 *   source_class: string,
 *   source_version: string,
 *   kind: string,
 *   metric: string,
 *   billing_class: string,
 *   attribution: string,
 *   fetched_at: string,
 *   observed_at: string,
 *   stored_at_ms: number,
 *   models: Array<{ id: string, name: string, pricing: object|null }>,
 * } | null}
 */
let memoryEntry = null;

/** @type {string} */
let memoryFilePath = '';

/**
 * @param {{ id?: unknown, name?: unknown, pricing?: unknown }} row
 * @returns {{ id: string, name: string, pricing: object|null } | null}
 */
function normalizeModelRow(row) {
  if (!row || typeof row.id !== 'string' || row.id.length === 0) return null;
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
    pricing: normalizeOpenRouterPricing(row.pricing),
  };
}

/**
 * Preserve the full pricing object exactly as published (JSON-safe clone), so
 * unknown fields are not dropped by this cache.
 *
 * @param {unknown} pricing
 * @returns {object|null}
 */
export function normalizeOpenRouterPricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(pricing));
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

/**
 * @param {Array<{ id: string, name: string, pricing?: object|null }>} models
 * @returns {Array<{ id: string, name: string, pricing: object|null }>}
 */
function normalizeModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((row) => normalizeModelRow(row))
    .filter((row) => row !== null);
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function resolveCacheFilePath(options = {}) {
  const dataDir = String(options.dataDir || '').trim();
  return dataDir
    ? path.join(dataDir, OPENROUTER_PRICING_CACHE_FILE_NAME)
    : resolveDataPath(OPENROUTER_PRICING_CACHE_FILE_NAME);
}

/**
 * @param {number} at
 * @returns {string}
 */
function toIso(at) {
  return new Date(at).toISOString();
}

/**
 * Build a cache entry without touching disk.
 *
 * @param {Array<{ id: string, name: string, pricing?: object|null }>} models
 * @param {{ now?: number }} [options]
 * @returns {NonNullable<typeof memoryEntry>}
 */
export function buildOpenRouterPricingCacheEntry(models, options = {}) {
  const rawNow = Number(options.now);
  const at = Number.isFinite(rawNow) ? rawNow : Date.now();
  const fetchedAt = toIso(at);
  return {
    schema_version: OPENROUTER_PRICING_CACHE_SCHEMA_VERSION,
    source: OPENROUTER_PRICING_SOURCE,
    source_class: OPENROUTER_PRICING_SOURCE_CLASS,
    source_version: OPENROUTER_PRICING_SOURCE_VERSION,
    kind: OPENROUTER_PRICING_KIND,
    metric: OPENROUTER_PRICING_METRIC,
    billing_class: OPENROUTER_PRICING_BILLING_CLASS,
    attribution: OPENROUTER_PRICING_ATTRIBUTION,
    fetched_at: fetchedAt,
    observed_at: fetchedAt,
    stored_at_ms: at,
    models: normalizeModels(models),
  };
}

/**
 * Read a persisted entry, tolerating a missing or corrupt file.
 *
 * @param {string} filePath
 * @returns {NonNullable<typeof memoryEntry> | null}
 */
function loadEntryFromDisk(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const models = normalizeModels(parsed.models);
  if (models.length === 0) return null;
  const fetchedAt = typeof parsed.fetched_at === 'string' && Number.isFinite(Date.parse(parsed.fetched_at))
    ? parsed.fetched_at
    : null;
  const storedAt = Number.isFinite(Number(parsed.stored_at_ms))
    ? Number(parsed.stored_at_ms)
    : (fetchedAt ? Date.parse(fetchedAt) : Date.now());
  return {
    schema_version: String(parsed.schema_version || OPENROUTER_PRICING_CACHE_SCHEMA_VERSION),
    source: String(parsed.source || OPENROUTER_PRICING_SOURCE),
    source_class: String(parsed.source_class || OPENROUTER_PRICING_SOURCE_CLASS),
    source_version: String(parsed.source_version || OPENROUTER_PRICING_SOURCE_VERSION),
    kind: String(parsed.kind || OPENROUTER_PRICING_KIND),
    metric: String(parsed.metric || OPENROUTER_PRICING_METRIC),
    billing_class: String(parsed.billing_class || OPENROUTER_PRICING_BILLING_CLASS),
    attribution: String(parsed.attribution || OPENROUTER_PRICING_ATTRIBUTION),
    fetched_at: fetchedAt || toIso(storedAt),
    observed_at: typeof parsed.observed_at === 'string' ? parsed.observed_at : (fetchedAt || toIso(storedAt)),
    stored_at_ms: storedAt,
    models,
  };
}

/**
 * In-memory entry only; never touches disk. Used to tell a real TTL cache hit
 * (in memory) from a first load of the persisted last-good copy.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {NonNullable<typeof memoryEntry> | null}
 */
export function peekOpenRouterPricingCache(options = {}) {
  if (!memoryEntry) return null;
  const filePath = resolveCacheFilePath(options);
  if (memoryFilePath && memoryFilePath !== filePath) return null;
  return memoryEntry;
}

/**
 * Synchronous read: memory first, then the persisted copy. Never fetches.
 *
 * @param {{ dataDir?: string, reload?: boolean }} [options]
 * @returns {NonNullable<typeof memoryEntry> | null}
 */
export function readOpenRouterPricingCache(options = {}) {
  const filePath = resolveCacheFilePath(options);
  if (options.reload !== true && memoryEntry && memoryFilePath === filePath) {
    return memoryEntry;
  }
  memoryEntry = loadEntryFromDisk(filePath);
  memoryFilePath = filePath;
  return memoryEntry;
}

/**
 * Persist a good live catalog and update memory. Synchronous.
 *
 * @param {Array<{ id: string, name: string, pricing?: object|null }>} models
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {NonNullable<typeof memoryEntry> | null} entry, or null for an empty list
 */
export function writeOpenRouterPricingCache(models, options = {}) {
  const entry = buildOpenRouterPricingCacheEntry(models, options);
  if (entry.models.length === 0) return null;
  const filePath = resolveCacheFilePath(options);
  try {
    writeJsonAtomic(filePath, entry);
  } catch (err) {
    // A read-only data dir must not lose the in-memory entry or fail a listing.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[openrouter-pricing-cache] persist failed:', message);
  }
  memoryEntry = entry;
  memoryFilePath = filePath;
  return entry;
}

/**
 * Drop the in-memory copy. The persisted file is left intact so a restart (or a
 * later read) can still serve the last good catalog offline.
 *
 * @returns {void}
 */
export function resetOpenRouterPricingCacheMemory() {
  memoryEntry = null;
  memoryFilePath = '';
}

/**
 * @param {NonNullable<typeof memoryEntry>} entry
 * @returns {object}
 */
function provenanceOf(entry) {
  return {
    source: entry.source,
    source_class: entry.source_class,
    source_version: entry.source_version,
    kind: entry.kind,
    metric: entry.metric,
    billing_class: entry.billing_class,
    attribution: entry.attribution,
    fetched_at: entry.fetched_at,
    observed_at: entry.observed_at,
    stale_after_ms: entry.stored_at_ms,
  };
}

/**
 * Exact, case-sensitive OpenRouter model id lookup. Purely local and
 * synchronous: no network, no await, no substring/heuristic join.
 *
 * @param {unknown} exactModelId
 * @param {{ dataDir?: string }} [options]
 * @returns {{
 *   modelId: string,
 *   name: string,
 *   pricing: object|null,
 *   source: string,
 *   source_class: string,
 *   source_version: string,
 *   kind: string,
 *   metric: string,
 *   billing_class: string,
 *   attribution: string,
 *   fetched_at: string,
 *   observed_at: string,
 * } | null}
 */
export function getOpenRouterEndpointPricing(exactModelId, options = {}) {
  const id = String(exactModelId ?? '');
  if (!id) return null;
  const entry = readOpenRouterPricingCache(options);
  if (!entry) return null;
  const row = entry.models.find((model) => model.id === id);
  if (!row) return null;
  return {
    modelId: row.id,
    name: row.name,
    pricing: row.pricing,
    ...provenanceOf(entry),
  };
}

/**
 * All cached pricing rows with provenance. Synchronous and network-free.
 *
 * @param {{ dataDir?: string }} [options]
 * @returns {Array<object>}
 */
export function listOpenRouterPricingModels(options = {}) {
  const entry = readOpenRouterPricingCache(options);
  if (!entry) return [];
  return entry.models.map((row) => ({
    modelId: row.id,
    name: row.name,
    pricing: row.pricing,
    ...provenanceOf(entry),
  }));
}
