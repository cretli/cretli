import * as api from '../../core/api/index.js';
import {
  catalogFromModelsPayload,
  countCatalogEnabledModels,
} from '../../../lib/model-catalog.js';

/**
 * @typedef {{ enabled: number, total: number }} HarnessModelUsage
 */

/**
 * @param {Record<string, HarnessModelUsage>|null|undefined} usage
 * @param {string} harnessId
 * @returns {HarnessModelUsage}
 */
export function readHarnessModelUsage(usage, harnessId) {
  const row = usage && typeof usage === 'object' ? usage[harnessId] : null;
  const enabled = Number(row?.enabled);
  const total = Number(row?.total);
  return {
    enabled: Number.isFinite(enabled) && enabled > 0 ? Math.round(enabled) : 0,
    total: Number.isFinite(total) && total > 0 ? Math.round(total) : 0,
  };
}

/**
 * @param {PromiseSettledResult<object>} result
 * @returns {object|null}
 */
function readSettledPayload(result) {
  if (result.status !== 'fulfilled') return null;
  const value = result.value;
  if (!value || value.ok === false) return null;
  return value;
}

/**
 * @param {object|null|undefined} settings
 * @returns {Promise<Record<string, HarnessModelUsage>>}
 */
export async function loadHarnessModelUsage(settings) {
  const folder = typeof settings?.workspaceFolder === 'string' ? settings.workspaceFolder.trim() : '';
  const settled = await Promise.allSettled([
    api.getAgentSdkStatus(),
    api.getOpenRouterModels(),
    api.getOpenCodeModels(folder ? { workspaceFolder: folder } : {}),
    api.getCodeBuddyModels(),
    api.getDeepSeekModels(),
    api.getQwenModels(),
    api.getCodexModels(),
  ]);
  const sdk = readSettledPayload(settled[0]);
  const openrouter = readSettledPayload(settled[1]);
  const opencode = readSettledPayload(settled[2]);
  const codebuddy = readSettledPayload(settled[3]);
  const deepseek = readSettledPayload(settled[4]);
  const qwen = readSettledPayload(settled[5]);
  const codex = readSettledPayload(settled[6]);
  return {
    sdk: countCatalogEnabledModels(catalogFromModelsPayload(sdk), settings?.chatEnabledModels),
    openrouter: countCatalogEnabledModels(
      catalogFromModelsPayload(openrouter),
      settings?.openrouterChatEnabledModels,
    ),
    opencode: countCatalogEnabledModels(
      catalogFromModelsPayload(opencode),
      settings?.opencodeChatEnabledModels,
    ),
    codebuddy: countCatalogEnabledModels(
      catalogFromModelsPayload(codebuddy),
      settings?.codebuddyChatEnabledModels,
    ),
    deepseek: countCatalogEnabledModels(
      catalogFromModelsPayload(deepseek),
      settings?.deepseekChatEnabledModels,
    ),
    qwen: countCatalogEnabledModels(catalogFromModelsPayload(qwen), settings?.qwenChatEnabledModels),
    codex: countCatalogEnabledModels(catalogFromModelsPayload(codex), settings?.codexChatEnabledModels),
  };
}
