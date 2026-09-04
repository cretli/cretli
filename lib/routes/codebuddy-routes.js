/**
 * CodeBuddy HTTP routes — health and model catalog from the Tencent CLI/SDK.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getCodeBuddyApiKeyMetaForClient } from '../codebuddy/codebuddy-api-key.js';
import { isCodeBuddyCliFound, resolveCodeBuddyCli } from '../codebuddy/codebuddy-cli.js';
import { isCodeBuddySdkAvailable } from '../codebuddy/codebuddy-sdk.js';
import {
  listCodeBuddyModels,
  resolveDefaultCodeBuddyModel,
} from '../codebuddy/codebuddy-models.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerCodeBuddyRoutes(app) {
  app.get('/api/codebuddy/status', async (_req, res) => {
    try {
      const sdkAvailable = await isCodeBuddySdkAvailable();
      const cliFound = isCodeBuddyCliFound();
      const keyMeta = getCodeBuddyApiKeyMetaForClient();
      const ready = sdkAvailable && cliFound && keyMeta.codebuddyApiKeyEffective;
      return res.json({
        ok: true,
        ready,
        sdkAvailable,
        cliFound,
        cliPath: resolveCodeBuddyCli(),
        defaultModel: resolveDefaultCodeBuddyModel(),
        ...keyMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/codebuddy/models', async (req, res) => {
    try {
      const refresh = String(req.query.refresh || '') === '1';
      const listed = await listCodeBuddyModels({ refresh });
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().codebuddyChatEnabledModels);
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
