/**
 * Light entry of the OpenRouter chat plugin: backend (status, model catalog,
 * settings), MCP adapter and the version-table row. Must not import room-kernel
 * or the providers module; the runtime lives in heavy.js.
 *
 * The OpenRouter client (API key, model list, pricing cache, SSE streaming) is
 * core infrastructure in lib/providers/openrouter and keeps working when this
 * plugin is disabled.
 */

import { getEffectiveOpenRouterApiKey } from '../../lib/providers/openrouter/openrouter-api-key.ts';
import { listOpenRouterModels } from '../../lib/providers/openrouter/openrouter-models.ts';
import * as openrouterSettings from './openrouter-settings.js';
import { openrouterMcpAdapter } from './openrouter-adapter.js';

export default {
  backend: {
    id: 'openrouter',
    // Settings patches apply in list order: the OpenCode key patch must run after this one.
    insertBefore: 'opencode',
    settings: openrouterSettings,
    enabledModelsKey: 'openrouterChatEnabledModels',
    credentialsReadySync: () => !!getEffectiveOpenRouterApiKey(),
    offlineCatalog: null,
    async status() {
      return { available: true, configured: !!getEffectiveOpenRouterApiKey() };
    },
    refreshModels: (/** @type {Record<string, unknown>} */ deps) => {
      const list = typeof deps?.listOpenRouterModels === 'function' ? deps.listOpenRouterModels : listOpenRouterModels;
      return list({ refresh: true });
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: openrouterMcpAdapter,
  // API-only harness: no npm package to track, just the channel row.
  versions: {
    insertBefore: 'mistral',
    spec: {
      harness: 'openrouter',
      channel: 'api',
      apiOnly: true,
      packages: [],
    },
  },
};
