/**
 * Light entry of the CodeBuddy plugin: backend (status, model catalog,
 * settings), MCP adapter and the version-table row. Must not import room-kernel
 * or the providers module; the runtime lives in heavy.js.
 */

import { getEffectiveCodeBuddyApiKey } from './codebuddy-api-key.js';
import {
  getCodeBuddyCliFromEnv,
  getCodeBuddyCliFromSettings,
  isCodeBuddyCliFound,
  resolveBundledCodeBuddyCli,
  resolveCodeBuddyCli,
} from './codebuddy-cli.js';
import { isCodeBuddySdkAvailable } from './codebuddy-sdk.js';
import {
  listCodeBuddyModels,
  listFallbackCodeBuddyModels,
  resolveCodeBuddyEnabledModels,
} from './codebuddy-models.js';
import * as codebuddySettings from './codebuddy-settings.js';
import { codebuddyMcpAdapter } from './codebuddy-adapter.js';

/**
 * @returns {{ source: string, bin: string }}
 */
function resolveCodeBuddyCliSource() {
  if (getCodeBuddyCliFromEnv()) return { source: 'env', bin: resolveCodeBuddyCli() };
  if (getCodeBuddyCliFromSettings()) return { source: 'settings', bin: resolveCodeBuddyCli() };
  if (resolveBundledCodeBuddyCli()) return { source: 'bundled', bin: resolveCodeBuddyCli() };
  if (isCodeBuddyCliFound()) return { source: 'path', bin: resolveCodeBuddyCli() };
  return { source: 'missing', bin: '' };
}

export default {
  backend: {
    id: 'codebuddy',
    settings: codebuddySettings,
    enabledModelsKey: 'codebuddyChatEnabledModels',
    normalizeEnabledModels: resolveCodeBuddyEnabledModels,
    credentialsReadySync: () => isCodeBuddyCliFound() && !!getEffectiveCodeBuddyApiKey(),
    offlineCatalog: () => ({ entries: listFallbackCodeBuddyModels(), source: 'fallback' }),
    async status() {
      const available = (await isCodeBuddySdkAvailable()) && isCodeBuddyCliFound();
      return { available, configured: available && !!getEffectiveCodeBuddyApiKey() };
    },
    refreshModels: (/** @type {Record<string, unknown>} */ deps) => {
      const list = typeof deps?.listCodeBuddyModels === 'function' ? deps.listCodeBuddyModels : listCodeBuddyModels;
      return list({ refresh: true });
    },
    refreshIsNetworkInference: false,
  },
  mcpAdapter: codebuddyMcpAdapter,
  versions: {
    insertBefore: 'codex',
    cliSource: resolveCodeBuddyCliSource,
    spec: {
      harness: 'codebuddy',
      channel: 'npm',
      packages: [
        { name: '@tencent-ai/agent-sdk', role: 'sdk+cli', cli: true, bin: 'codebuddy' },
      ],
    },
  },
};
