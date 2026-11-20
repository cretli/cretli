/**
 * Light entry of the DeepSeek plugin: backend (status, model catalog,
 * settings), MCP adapter, auto-title provider, version-table row and the
 * billing / credit-ledger / usage-limit hooks. Must not import room-kernel or
 * the providers module; the runtime lives in heavy.js.
 */

import { getEffectiveDeepSeekApiKey } from './deepseek-api-key.js';
import { resolveDeepSeekLimitBinding } from './deepseek-balance.js';
import {
  getDeepSeekCliFromEnv,
  getDeepSeekCliFromSettings,
  isDeepSeekCliFound,
  resolveBundledDeepSeekCli,
  resolveDeepSeekCli,
} from './deepseek-cli.js';
import { isDeepSeekSdkAvailable } from './deepseek-sdk.js';
import { listDeepSeekModels, listFallbackDeepSeekModels } from './deepseek-models.js';
import { DEEPSEEK_MODELS_URL, normalizeDeepSeekChatEnabledModels, remapDeepSeekModelId } from './deepseek-model-ids.js';
import * as deepseekSettings from './deepseek-settings.js';
import { deepseekMcpAdapter } from './deepseek-adapter.js';
import { onDeepSeekTopupPosted, registerDeepSeekLedgerRoutes } from './deepseek-ledger.js';

/**
 * @returns {{ source: string, bin: string }}
 */
function resolveDeepSeekCliSource() {
  if (getDeepSeekCliFromEnv()) return { source: 'env', bin: resolveDeepSeekCli() };
  if (getDeepSeekCliFromSettings()) return { source: 'settings', bin: resolveDeepSeekCli() };
  if (resolveBundledDeepSeekCli()) return { source: 'bundled', bin: resolveDeepSeekCli() };
  if (isDeepSeekCliFound()) return { source: 'path', bin: resolveDeepSeekCli() };
  return { source: 'missing', bin: '' };
}

export default {
  backend: {
    id: 'deepseek',
    settings: deepseekSettings,
    enabledModelsKey: 'deepseekChatEnabledModels',
    normalizeEnabledModels: normalizeDeepSeekChatEnabledModels,
    credentialsReadySync: () => isDeepSeekCliFound() && !!getEffectiveDeepSeekApiKey(),
    offlineCatalog: () => ({ entries: listFallbackDeepSeekModels(), source: 'fallback' }),
    async status() {
      const available = (await isDeepSeekSdkAvailable()) && isDeepSeekCliFound();
      return { available, configured: available && !!getEffectiveDeepSeekApiKey() };
    },
    refreshModels: (/** @type {Record<string, unknown>} */ deps) => {
      const list = typeof deps?.listDeepSeekModels === 'function' ? deps.listDeepSeekModels : listDeepSeekModels;
      return list({ refresh: true });
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: deepseekMcpAdapter,
  // One-shot chat title generation over the OpenAI-compatible endpoint.
  titleProvider: {
    id: 'deepseek',
    label: 'DeepSeek',
    insertBefore: 'codex',
    defaultModel: () => remapDeepSeekModelId('deepseek-flash'),
    fallbackModels: () => listFallbackDeepSeekModels(),
    hasCredentials: () => !!getEffectiveDeepSeekApiKey(),
    baseUrl: () => new URL(DEEPSEEK_MODELS_URL).origin,
    apiKey: () => getEffectiveDeepSeekApiKey(),
    remapModel: remapDeepSeekModelId,
  },
  versions: {
    insertBefore: 'codex',
    cliSource: resolveDeepSeekCliSource,
    spec: {
      harness: 'deepseek',
      channel: 'npm',
      packages: [
        { name: '@deepseek-ai/dsh-sdk-client', role: 'sdk' },
        { name: '@deepseek-ai/dsh', role: 'cli', cli: true, bin: 'dsh' },
      ],
    },
  },
  // Bind a balance lockout to the current DeepSeek billing account.
  limitBinding: resolveDeepSeekLimitBinding,
  billingCredential: {
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    profileKey: 'default',
    credential: () => getEffectiveDeepSeekApiKey(),
  },
  creditLedger: {
    registerRoutes: registerDeepSeekLedgerRoutes,
    onTopupPosted: onDeepSeekTopupPosted,
  },
};
