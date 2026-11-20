import { catalogEntriesFromModelIds, mergeModelCatalogEntries } from '../../lib/model-catalog.js';
import { isAntigravityCliFound, listAntigravityModels } from './antigravity-config.js';
import * as settings from './antigravity-settings.js';

export default {
  backend: {
    id: 'antigravity', settings, enabledModelsKey: 'antigravityChatEnabledModels',
    credentialsReadySync: () => isAntigravityCliFound(),
    offlineCatalog: (enabled) => ({ entries: mergeModelCatalogEntries(catalogEntriesFromModelIds(['default']), catalogEntriesFromModelIds(enabled)), source: 'settings' }),
    async status() {
      const available = isAntigravityCliFound();
      // Authentication is checked by ACP on session creation; never inspect credential stores.
      return { available, configured: available };
    },
    refreshModels: () => listAntigravityModels(), refreshIsNetworkInference: false,
  },
  mcpAdapter: { harness: 'antigravity', transports: ['stdio', 'http'], liveUpdate: false, callControl: 'bridge', unsupportedFeature: '' },
};
