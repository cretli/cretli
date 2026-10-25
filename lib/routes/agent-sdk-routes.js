import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.ts';
import { loadCursorSdk } from '../sdk/cursor-sdk.ts';
import { loadSettings } from '../persist/settings.js';
import {
  enrichCatalogEntryLabels,
  expandSdkModelsToCatalog,
  FALLBACK_AGENT_MODELS,
  mergeModelCatalogEntries,
  normalizeChatEnabledModels,
  toLegacyModelOptions,
} from '../model-catalog.js';
import { enrichCatalogEntryMetaList } from '../model-catalog-meta.js';

/** The SDK model list is a network call (seconds); keep it this long. */
const SDK_MODELS_TTL_MS = 5 * 60_000;
/** @type {{ key: string, at: number, rows: unknown[] } | null} */
let sdkModelsCache = null;
/** @type {{ key: string, promise: Promise<unknown[]> } | null} */
let sdkModelsInFlight = null;

/** Test-only: forget the cached SDK model list. */
export function resetAgentSdkModelsCache() {
  sdkModelsCache = null;
  sdkModelsInFlight = null;
}

/**
 * SDK model rows for `apiKey`: a fresh cached list is returned as is, a stale one is
 * returned while one shared refresh runs, and concurrent callers share one request.
 *
 * @param {string} apiKey
 * @param {(apiKey: string) => Promise<unknown[]>} fetchRows
 * @param {number} [now]
 * @returns {Promise<unknown[]>}
 */
export function getCachedSdkModelRows(apiKey, fetchRows, now = Date.now()) {
  const key = String(apiKey || '');
  const refresh = () => {
    if (sdkModelsInFlight?.key === key) return sdkModelsInFlight.promise;
    const promise = fetchRows(key).then((rows) => {
      const list = Array.isArray(rows) ? rows : [];
      sdkModelsCache = { key, at: Date.now(), rows: list };
      return list;
    }).finally(() => {
      if (sdkModelsInFlight?.promise === promise) sdkModelsInFlight = null;
    });
    sdkModelsInFlight = { key, promise };
    return promise;
  };
  if (sdkModelsCache?.key === key) {
    if (now - sdkModelsCache.at >= SDK_MODELS_TTL_MS) refresh().catch(() => {});
    return Promise.resolve(sdkModelsCache.rows);
  }
  return refresh();
}

/**
 * @param {import('express').Express} app
 */
export function registerAgentSdkRoutes(app) {
  /** Whether SDK chats can be created + model catalog for the configured API key. */
  app.get('/api/agent-sdk', async (_req, res) => {
    const ready = !!getEffectiveCursorApiKey();
    const defaultModel = process.env.CURSOR_SDK_DEFAULT_MODEL || 'composer-2';
    /** @type {import('../model-catalog.js').ModelCatalogEntry[]} */
    let catalog = mergeModelCatalogEntries(FALLBACK_AGENT_MODELS, []);
    let modelsSource = 'fallback';
    let modelsWarning = '';
    if (ready) {
      try {
        const apiKey = getEffectiveCursorApiKey();
        const sdkRows = await getCachedSdkModelRows(apiKey, async (key) => {
          const { Cursor } = await loadCursorSdk();
          return Cursor.models.list(key ? { apiKey: key } : undefined);
        });
        const sdkCatalog = expandSdkModelsToCatalog(Array.isArray(sdkRows) ? sdkRows : []);
        if (sdkCatalog.length > 0) {
          catalog = mergeModelCatalogEntries(sdkCatalog, FALLBACK_AGENT_MODELS);
          modelsSource = 'sdk';
        }
      } catch (err) {
        modelsWarning = err?.message ? String(err.message) : String(err);
      }
    }
    catalog = mergeModelCatalogEntries(catalog, [{
      value: defaultModel,
      label: defaultModel,
      modelId: defaultModel,
      group: defaultModel,
    }]);
    catalog = enrichCatalogEntryLabels(catalog);
    catalog = enrichCatalogEntryMetaList(catalog);
    const settings = loadSettings();
    const chatEnabledModels = normalizeChatEnabledModels(settings.chatEnabledModels);
    return res.json({
      ok: true,
      ready,
      defaultModel,
      models: toLegacyModelOptions(catalog),
      catalog,
      chatEnabledModels,
      modelsSource,
      modelsWarning,
    });
  });
}
