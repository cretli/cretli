/**
 * Mistral Harness HTTP routes — health and model catalog.
 * GET /api/harnesses is registered in openrouter-routes.js.
 */

import { getMistralApiKeyMetaForClient } from '../mistral/mistral-api-key.js';
import { isMistralSdkAvailable } from '../mistral/mistral-sdk.js';
import {
  getMistralChatEnabledModels,
  listMistralModels,
  resolveDefaultMistralModel,
} from '../mistral/mistral-models.js';

/**
 * @param {import('express').Express} app
 */
export function registerMistralRoutes(app) {
  app.get('/api/mistral/status', async (_req, res) => {
    try {
      const sdkAvailable = await isMistralSdkAvailable();
      const keyMeta = getMistralApiKeyMetaForClient();
      return res.json({
        ok: true,
        ready: sdkAvailable && keyMeta.mistralApiKeyEffective,
        sdkAvailable,
        defaultModel: resolveDefaultMistralModel(),
        ...keyMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/mistral/models', async (_req, res) => {
    try {
      const listed = await listMistralModels();
      return res.json({
        ok: true,
        models: listed.models,
        catalog: listed.catalog,
        chatEnabledModels: getMistralChatEnabledModels(),
        defaultModel: listed.defaultModel,
        modelsSource: listed.modelsSource,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
