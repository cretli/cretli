/**
 * OpenRouter HTTP routes — model catalog and configuration status.
 */

import { getEffectiveOpenRouterApiKey, getOpenRouterApiKeyMetaForClient } from '../openrouter/openrouter-api-key.js';
import { listOpenRouterModels } from '../openrouter/openrouter-models.js';
import { listHarnesses } from '../agent-harness/registry.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerOpenRouterRoutes(app) {
  app.get('/api/harnesses', (_req, res) => {
    res.json({ ok: true, harnesses: listHarnesses() });
  });

  app.get('/api/openrouter/status', (_req, res) => {
    res.json({
      ok: true,
      ...getOpenRouterApiKeyMetaForClient(),
    });
  });

  app.get('/api/openrouter/models', async (req, res) => {
    try {
      if (!getEffectiveOpenRouterApiKey()) {
        return res.json({
          ok: false,
          error: 'Missing OpenRouter API key',
        });
      }
      const refresh = String(req.query.refresh || '') === '1';
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().openrouterChatEnabledModels);
      const listed = await listOpenRouterModels({ refresh });
      if (listed.models.length === 0 && listed.modelsSource === 'fallback') {
        return res.status(listed.warning ? 502 : 200).json({
          ok: listed.models.length > 0,
          error: listed.warning || undefined,
          models: listed.models,
          chatEnabledModels,
          modelsSource: listed.modelsSource,
        });
      }
      const body = {
        ok: true,
        models: listed.models,
        chatEnabledModels,
        modelsSource: listed.modelsSource,
      };
      if (listed.fromCache) body.cached = true;
      if (listed.stale) body.stale = true;
      if (listed.warning) body.warning = listed.warning;
      if (listed.fetchedAt) body.catalogFetchedAt = listed.fetchedAt;
      return res.json(body);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
