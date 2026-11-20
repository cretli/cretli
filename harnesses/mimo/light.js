/**
 * Light entry of the MiMo plugin: backend (status, model catalog, settings) and
 * MCP adapter. Needs the OpenCode plugin (`dependsOn`): the MiMo constants it
 * reuses live there. Must not import room-kernel or the providers module; the
 * runtime lives in heavy.js.
 */

import { catalogEntriesFromModelIds, mergeModelCatalogEntries } from '../../lib/model-catalog.js';
import { getEffectiveMimoApiKey } from './mimo-api-key.js';
import { listFallbackMimoModels, listMimoModels } from './mimo-models.js';
import * as mimoSettings from './mimo-settings.js';
import { mimoMcpAdapter } from './mimo-adapter.js';

export default {
  backend: {
    id: 'mimo',
    insertBefore: 'codex',
    settings: mimoSettings,
    enabledModelsKey: 'mimoChatEnabledModels',
    credentialsReadySync: () => !!getEffectiveMimoApiKey(),
    // Static rows plus the Settings favorites they lack, so enabled models list before any snapshot.
    offlineCatalog: (/** @type {string[]} */ enabled) => ({
      entries: mergeModelCatalogEntries(listFallbackMimoModels(), catalogEntriesFromModelIds(enabled)),
      source: enabled.length > 0 ? 'settings' : 'fallback',
    }),
    async status() {
      return { available: true, configured: !!getEffectiveMimoApiKey() };
    },
    refreshModels: async () => {
      const payload = await listMimoModels({ refresh: true });
      return { catalog: payload.catalog, modelsSource: payload.modelsSource };
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: mimoMcpAdapter,
};
