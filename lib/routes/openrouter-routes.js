/**
 * OpenRouter HTTP routes — model catalog and configuration status.
 */

import { getEffectiveOpenRouterApiKey, getOpenRouterApiKeyMetaForClient, getOpenRouterRequestHeaders } from '../openrouter/openrouter-api-key.js';
import { listHarnesses } from '../agent-harness/registry.js';
import { normalizeChatEnabledModels } from '../model-catalog.js';
import { loadSettings } from '../persist/settings.js';

const MODELS_CACHE_TTL_MS = 15 * 60 * 1000;
/** @type {{ at: number, models: Array<{ id: string, name?: string }> } | null} */
let modelsCache = null;

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

  app.get('/api/openrouter/models', async (_req, res) => {
    try {
      if (!getEffectiveOpenRouterApiKey()) {
        return res.json({
          ok: false,
          error: 'Missing OpenRouter API key',
        });
      }
      const now = Date.now();
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().openrouterChatEnabledModels);
      if (modelsCache && now - modelsCache.at < MODELS_CACHE_TTL_MS) {
        return res.json({ ok: true, models: modelsCache.models, cached: true, chatEnabledModels });
      }
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: getOpenRouterRequestHeaders(),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return res.status(502).json({ ok: false, error: text || `HTTP ${response.status}` });
      }
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const models = rows
        .filter((row) => row && typeof row.id === 'string')
        .map((row) => ({
          id: row.id,
          name: typeof row.name === 'string' ? row.name : row.id,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      modelsCache = { at: now, models };
      return res.json({ ok: true, models, chatEnabledModels });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
