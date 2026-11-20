/**
 * Light entry of the Qwen plugin: backend (status, model catalog, settings),
 * MCP adapter, auto-title provider and the version-table row. Must not import
 * room-kernel or the providers module; the runtime lives in heavy.js.
 */

import { getEffectiveQwenApiKey, resolveQwenBaseUrl } from './qwen-api-key.js';
import { getQwenCliFromEnv, getQwenCliFromSettings, resolveQwenCli } from './qwen-cli.js';
import { isQwenSdkAvailable } from './qwen-sdk.js';
import { listFallbackQwenModels, listQwenModels, remapQwenModelId, resolveDefaultQwenModel } from './qwen-models.js';
import * as qwenSettings from './qwen-settings.js';
import { qwenMcpAdapter } from './qwen-adapter.js';

/**
 * The Qwen SDK ships its own CLI, so an installed package is the bundled case;
 * only an explicit override points at a binary Cretli does not own.
 *
 * @returns {{ source: string, bin: string }}
 */
function resolveQwenCliSource() {
  if (getQwenCliFromEnv()) return { source: 'env', bin: resolveQwenCli() };
  if (getQwenCliFromSettings()) return { source: 'settings', bin: resolveQwenCli() };
  return { source: 'bundled', bin: '' };
}

export default {
  backend: {
    id: 'qwen',
    settings: qwenSettings,
    enabledModelsKey: 'qwenChatEnabledModels',
    credentialsReadySync: () => !!getEffectiveQwenApiKey(),
    offlineCatalog: () => ({ entries: listFallbackQwenModels(), source: 'fallback' }),
    async status() {
      const available = await isQwenSdkAvailable();
      return { available, configured: available && !!getEffectiveQwenApiKey() };
    },
    refreshModels: (/** @type {Record<string, unknown>} */ deps) => {
      const list = typeof deps?.listQwenModels === 'function' ? deps.listQwenModels : listQwenModels;
      return list({ refresh: true });
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: qwenMcpAdapter,
  // One-shot chat title generation over the OpenAI-compatible endpoint.
  titleProvider: {
    id: 'qwen',
    label: 'Qwen',
    insertBefore: 'codex',
    defaultModel: () => resolveDefaultQwenModel(),
    fallbackModels: () => listFallbackQwenModels(),
    hasCredentials: () => !!getEffectiveQwenApiKey(),
    baseUrl: () => resolveQwenBaseUrl(),
    apiKey: () => getEffectiveQwenApiKey(),
    remapModel: remapQwenModelId,
  },
  versions: {
    insertBefore: 'claude',
    cliSource: resolveQwenCliSource,
    spec: {
      harness: 'qwen',
      channel: 'npm',
      packages: [
        { name: '@qwen-code/sdk', role: 'sdk+cli', cli: true, bin: 'qwen' },
      ],
    },
  },
};
