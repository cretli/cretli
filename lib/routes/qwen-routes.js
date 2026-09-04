/**
 * Qwen Code HTTP routes — health and model catalog.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getQwenApiKeyMetaForClient, resolveQwenBaseUrl, resolveQwenEndpoint } from '../qwen/qwen-api-key.js';
import { isQwenCliFound, resolveQwenCli } from '../qwen/qwen-cli.js';
import { isQwenSdkAvailable } from '../qwen/qwen-sdk.js';
import {
  listQwenModels,
  resolveDefaultQwenModel,
} from '../qwen/qwen-models.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerQwenRoutes(app) {
  app.get('/api/qwen/status', async (_req, res) => {
    try {
      const sdkAvailable = await isQwenSdkAvailable();
      const cliFound = isQwenCliFound();
      const keyMeta = getQwenApiKeyMetaForClient();
      const ready = sdkAvailable && keyMeta.qwenApiKeyEffective;
      return res.json({
        ok: true,
        ready,
        sdkAvailable,
        cliFound,
        cliPath: resolveQwenCli(),
        endpoint: resolveQwenEndpoint(),
        baseUrl: resolveQwenBaseUrl(),
        defaultModel: resolveDefaultQwenModel(),
        ...keyMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/qwen/models', async (_req, res) => {
    try {
      const listed = await listQwenModels();
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().qwenChatEnabledModels);
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
