/**
 * Light entry of the Mistral plugin: backend (status, model catalog, settings)
 * and MCP adapter. Must not import room-kernel or the providers module; the
 * runtime lives in heavy.js.
 */

import { catalogEntriesFromModelIds, mergeModelCatalogEntries } from '../../lib/model-catalog.js';
import { getEffectiveMistralApiKey } from './mistral-api-key.js';
import { isMistralSdkAvailable } from './mistral-sdk.js';
import { listFallbackMistralModels, listMistralModels } from './mistral-models.js';
import * as mistralSettings from './mistral-settings.js';
import { mistralMcpAdapter } from './mistral-adapter.js';

export default {
  backend: {
    id: 'mistral',
    settings: mistralSettings,
    enabledModelsKey: 'mistralChatEnabledModels',
    credentialsReadySync: () => !!getEffectiveMistralApiKey(),
    // Favorites come from the live vendor catalog, whose dated/versioned ids
    // are not in the static fallback.
    offlineCatalog: (/** @type {string[]} */ enabled) => ({
      entries: mergeModelCatalogEntries(listFallbackMistralModels(), catalogEntriesFromModelIds(enabled)),
      source: enabled.length > 0 ? 'settings' : 'fallback',
    }),
    async status() {
      const available = await isMistralSdkAvailable();
      return { available, configured: available && !!getEffectiveMistralApiKey() };
    },
    refreshModels: (/** @type {Record<string, unknown>} */ deps) => {
      const list = typeof deps?.listMistralModels === 'function' ? deps.listMistralModels : listMistralModels;
      return list({ refresh: true });
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: mistralMcpAdapter,
};
