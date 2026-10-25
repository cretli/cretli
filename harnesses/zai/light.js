/**
 * Light entry of the Z.AI SDK plugin: backend (status, model catalog, settings)
 * and MCP adapter. Needs the OpenCode plugin (`dependsOn`): the Z.AI provider key
 * helpers it reuses live there. Must not import room-kernel or the providers
 * module; the runtime lives in heavy.js.
 */

import { catalogEntriesFromModelIds, mergeModelCatalogEntries } from '../../lib/model-catalog.js';
import { getEffectiveZaiSdkApiKey } from './zai-api-key.js';
import { isZaiSdkAvailable } from './zai-sdk-runtime.js';
import { listZaiModels } from './zai-models.js';
import * as zaiSettings from './zai-settings.js';
import { zaiMcpAdapter } from './zai-adapter.js';

export default {
  backend: {
    id: 'zai',
    insertBefore: 'codex',
    settings: zaiSettings,
    enabledModelsKey: 'zaiChatEnabledModels',
    credentialsReadySync: () => !!getEffectiveZaiSdkApiKey(),
    // Static rows plus the Settings favorites they lack, so enabled models list before any snapshot.
    offlineCatalog: (/** @type {string[]} */ enabled) => ({
      entries: mergeModelCatalogEntries(listZaiModels(), catalogEntriesFromModelIds(enabled)),
      source: enabled.length > 0 ? 'settings' : 'fallback',
    }),
    async status() {
      const available = isZaiSdkAvailable();
      return { available, configured: available && !!getEffectiveZaiSdkApiKey() };
    },
    refreshModels: async () => ({ catalog: listZaiModels(), modelsSource: 'fallback' }),
    refreshIsNetworkInference: false,
  },
  mcpAdapter: zaiMcpAdapter,
};
