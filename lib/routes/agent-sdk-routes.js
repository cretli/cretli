import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import { loadCursorSdk } from '../sdk/cursor-sdk.js';
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
        const { Cursor } = await loadCursorSdk();
        const apiKey = getEffectiveCursorApiKey();
        const sdkRows = await Cursor.models.list(apiKey ? { apiKey } : undefined);
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
