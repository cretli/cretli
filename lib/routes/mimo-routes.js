/** HTTP routes for the Xiaomi MiMo harness. */

import { getMimoApiKeyMetaForClient } from '../mimo/mimo-api-key.js';
import { listMimoModels, resolveDefaultMimoModel } from '../mimo/mimo-models.js';

/**
 * @param {import('express').Express} app
 */
export function registerMimoRoutes(app) {
  app.get('/api/mimo/status', (_req, res) => {
    const keyMeta = getMimoApiKeyMetaForClient();
    return res.json({
      ok: true,
      ready: !!keyMeta.mimoApiKeyEffective,
      defaultModel: resolveDefaultMimoModel(),
      ...keyMeta,
    });
  });
  app.get('/api/mimo/models', async (_req, res) => {
    const payload = await listMimoModels();
    return res.json({
      ok: true,
      models: payload.models,
      catalog: payload.catalog,
      chatEnabledModels: payload.catalog.map((row) => row.value),
      defaultModel: payload.defaultModel,
      modelsSource: payload.modelsSource,
    });
  });
}
