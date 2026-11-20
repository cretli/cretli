/**
 * OpenRouter model catalog (GET /models). Shared by HTTP routes and harness refresh.
 *
 * Stage 3 of the model quality/cost plan (`2584cd05`): this remains the **only**
 * OpenRouter HTTP client (S1). It now preserves the endpoint `pricing` rows
 * (S2), keeps a durable last-good copy via `./openrouter-pricing-cache.ts`
 * (S3/A1), serves it with a stale marker when live returns 429/5xx/timeout/
 * network error/empty list, and never blocks `model_pick` because stage 4 reads
 * prices synchronously from that cache module.
 */

import { getEffectiveOpenRouterApiKey, getOpenRouterRequestHeaders } from './openrouter-api-key.ts';
import {
  normalizeOpenRouterPricing,
  peekOpenRouterPricingCache,
  readOpenRouterPricingCache,
  resetOpenRouterPricingCacheMemory,
  writeOpenRouterPricingCache,
} from './openrouter-pricing-cache.ts';
import type { ModelCatalogEntry } from '../../model-catalog.js';

/** In-memory TTL; after it the last good copy is served while revalidating. */
export const OPENROUTER_MODELS_CACHE_TTL_MS = 15 * 60 * 1000;

/** Hard cap for one live catalog request; a hanging fetch can never block a pick. */
export const OPENROUTER_MODELS_TIMEOUT_MS = 10_000;

export interface OpenRouterModelRow {
  id: string;
  name: string;
  pricing: object|null;
}

export interface ListedOpenRouterModels {
  catalog: ModelCatalogEntry[];
  models: OpenRouterModelRow[];
  modelsSource: 'live' | 'stale' | 'fallback';
  fromCache: boolean;
  warning: string;
  stale: boolean;
  fetchedAt: string|null;
}

type PricingEntry = NonNullable<ReturnType<typeof readOpenRouterPricingCache>>;

interface RevalidateInput {
  lastGoodEntry: ReturnType<typeof readOpenRouterPricingCache>;
  dataDir?: string;
  nowMs: number;
  timeoutMs?: number;
}

/**
 * Drop the in-memory catalog. The persisted last-good copy is intentionally
 * kept so the next process/read can still serve it offline.
 */
export function invalidateOpenRouterModelsCache(): void {
  resetOpenRouterPricingCacheMemory();
}

// Load the persisted last-good catalog at process start (best effort, no
// network), so an offline boot already has prices before the first request.
readOpenRouterPricingCache();

export function catalogFromOpenRouterModels(models: OpenRouterModelRow[]): ModelCatalogEntry[] {
  return models.map((row) => ({
    value: row.id,
    label: row.name || row.id,
    modelId: row.id,
    group: row.id.split('/')[0] || 'openrouter',
    provider: 'openrouter',
  }));
}

/**
 * The one live request. Throws on a non-OK status so the caller can fall back to
 * the last good copy with an explicit reason.
 */
async function listLiveOpenRouterModels(options: { timeoutMs?: number } = {}): Promise<OpenRouterModelRow[]> {
  const apiKey = getEffectiveOpenRouterApiKey();
  if (!apiKey) {
    const err: Error & { code?: string } = new Error('Missing OpenRouter API key');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? requested
    : OPENROUTER_MODELS_TIMEOUT_MS;
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: getOpenRouterRequestHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err: Error & { status?: number } = new Error(`OpenRouter model catalog request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const payload = await response.json() as { data?: unknown } | null;
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row: any) => row && typeof row.id === 'string')
    .map((row: any) => ({
      id: row.id,
      name: typeof row.name === 'string' ? row.name : row.id,
      pricing: normalizeOpenRouterPricing(row.pricing),
    }))
    .sort((a: OpenRouterModelRow, b: OpenRouterModelRow) => a.name.localeCompare(b.name));
}

function responseFromEntry(entry: PricingEntry, flags: { fromCache: boolean, stale: boolean, warning: string }): ListedOpenRouterModels {
  return {
    catalog: catalogFromOpenRouterModels(entry.models),
    models: entry.models,
    modelsSource: flags.stale === true ? 'stale' : 'live',
    fromCache: flags.fromCache === true,
    warning: flags.warning || '',
    stale: flags.stale === true,
    fetchedAt: entry.fetched_at || null,
  };
}

function fallbackResponse(warning: string): ListedOpenRouterModels {
  return {
    catalog: [],
    models: [],
    modelsSource: 'fallback',
    fromCache: false,
    warning: warning || '',
    stale: false,
    fetchedAt: null,
  };
}

async function revalidateLiveCatalog(input: RevalidateInput): Promise<ListedOpenRouterModels> {
  const { lastGoodEntry, dataDir, nowMs, timeoutMs } = input;
  if (!getEffectiveOpenRouterApiKey()) {
    return lastGoodEntry
      ? responseFromEntry(lastGoodEntry, { fromCache: false, stale: true, warning: 'Missing OpenRouter API key' })
      : fallbackResponse('Missing OpenRouter API key');
  }
  try {
    const live = await listLiveOpenRouterModels({ timeoutMs });
    if (live.length > 0) {
      const written = writeOpenRouterPricingCache(live, { dataDir, now: nowMs });
      if (written) {
        return responseFromEntry(written, { fromCache: false, stale: false, warning: '' });
      }
    }
    return lastGoodEntry
      ? responseFromEntry(lastGoodEntry, {
        fromCache: false,
        stale: true,
        warning: 'OpenRouter returned an empty model list',
      })
      : fallbackResponse('OpenRouter returned an empty model list');
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    console.warn('[openrouter-models] live catalog failed:', message);
    return lastGoodEntry
      ? responseFromEntry(lastGoodEntry, { fromCache: false, stale: true, warning: message })
      : fallbackResponse(message);
  }
}

let backgroundRefresh: Promise<ListedOpenRouterModels|null> | null = null;

/**
 * Fire-and-forget revalidation used by stale-while-revalidate. Never rejects and
 * never overlaps itself; a failed refresh leaves the last good copy in place.
 */
function scheduleBackgroundRefresh(input: RevalidateInput): Promise<ListedOpenRouterModels|null> {
  if (backgroundRefresh) return backgroundRefresh;
  const work = (async () => {
    try {
      return await revalidateLiveCatalog(input);
    } catch {
      return null;
    } finally {
      backgroundRefresh = null;
    }
  })();
  backgroundRefresh = work;
  return work;
}

/**
 * Await an in-flight stale-while-revalidate refresh. Test/diagnostic helper: the
 * normal consumers never wait on it.
 */
export function whenOpenRouterModelsRefreshSettles(): Promise<ListedOpenRouterModels|null> {
  return backgroundRefresh ?? Promise.resolve(null);
}

export async function listOpenRouterModels(options: {
  refresh?: boolean,
  dataDir?: string,
  now?: number,
  timeoutMs?: number,
} = {}): Promise<ListedOpenRouterModels> {
  const refresh = options.refresh === true;
  const dataDir = options.dataDir;
  const rawNow = Number(options.now);
  const nowMs = Number.isFinite(rawNow) ? rawNow : Date.now();
  const timeoutMs = options.timeoutMs;

  // An explicit refresh always performs a bounded live attempt, then falls back
  // to the last good copy instead of returning an empty list.
  if (refresh) {
    const lastGood = peekOpenRouterPricingCache({ dataDir }) || readOpenRouterPricingCache({ dataDir });
    return revalidateLiveCatalog({ lastGoodEntry: lastGood, dataDir, nowMs, timeoutMs });
  }

  const memoryEntry = peekOpenRouterPricingCache({ dataDir });
  const memoryFresh = !!memoryEntry && nowMs - memoryEntry.stored_at_ms < OPENROUTER_MODELS_CACHE_TTL_MS;
  if (memoryFresh) {
    return responseFromEntry(memoryEntry, { fromCache: true, stale: false, warning: '' });
  }

  const persisted = memoryEntry || readOpenRouterPricingCache({ dataDir });
  const persistedFresh = !!persisted && nowMs - persisted.stored_at_ms < OPENROUTER_MODELS_CACHE_TTL_MS;
  if (persistedFresh) {
    // First load of the persisted last-good copy in this process: already a copy,
    // but not an in-memory TTL hit, so it is not reported as `fromCache`.
    return responseFromEntry(persisted, { fromCache: false, stale: false, warning: '' });
  }

  if (persisted && persisted.models.length > 0) {
    // Stale-while-revalidate: answer immediately from the last good copy.
    if (!getEffectiveOpenRouterApiKey()) {
      return responseFromEntry(persisted, {
        fromCache: false,
        stale: true,
        warning: 'Missing OpenRouter API key',
      });
    }
    scheduleBackgroundRefresh({ lastGoodEntry: persisted, dataDir, nowMs: Date.now(), timeoutMs });
    return responseFromEntry(persisted, {
      fromCache: false,
      stale: true,
      warning: `Serving the last good OpenRouter model catalog (fetched ${persisted.fetched_at}); refreshing in the background.`,
    });
  }

  return revalidateLiveCatalog({ lastGoodEntry: null, dataDir, nowMs, timeoutMs });
}
