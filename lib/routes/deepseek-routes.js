/**
 * DeepSeek Harness HTTP routes — health and model catalog.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getDeepSeekApiKeyMetaForClient } from '../deepseek/deepseek-api-key.js';
import { isDeepSeekCliFound, resolveDeepSeekCli } from '../deepseek/deepseek-cli.js';
import { isDeepSeekSdkAvailable } from '../deepseek/deepseek-sdk.js';
import {
  listDeepSeekModels,
  resolveDefaultDeepSeekModel,
} from '../deepseek/deepseek-models.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerDeepSeekRoutes(app) {
  app.get('/api/deepseek/status', async (_req, res) => {
    try {
      const sdkAvailable = await isDeepSeekSdkAvailable();
      const cliFound = isDeepSeekCliFound();
      const keyMeta = getDeepSeekApiKeyMetaForClient();
      const ready = sdkAvailable && cliFound && keyMeta.deepseekApiKeyEffective;
      return res.json({
        ok: true,
        ready,
        sdkAvailable,
        cliFound,
        cliPath: resolveDeepSeekCli(),
        defaultModel: resolveDefaultDeepSeekModel(),
        ...keyMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/deepseek/models', async (_req, res) => {
    try {
      const listed = await listDeepSeekModels();
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().deepseekChatEnabledModels);
      return res.json({
        ok: true,
        models: listed.models,
        catalog: listed.catalog,
        chatEnabledModels,
        defaultModel: listed.defaultModel,
        modelsSource: listed.modelsSource,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
