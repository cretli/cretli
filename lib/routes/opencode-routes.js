/**
 * OpenCode HTTP routes — health, provider models.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getOpenCodeApiKeyMetaForClient } from '../opencode/opencode-api-key.js';
import { getOpenCodeZaiApiKeyMetaForClient } from '../opencode/opencode-zai-api-key.js';
import { getOpenCodeMimoApiKeyMetaForClient } from '../opencode/opencode-mimo-api-key.js';
import { loadSettings } from '../persist/settings.js';
import {
  getOpenCodeHealth,
  listOpenCodeModels,
} from '../opencode/opencode-server-manager.js';

/**
 * @param {import('express').Express} app
 * @param {{ workspaceDirForAgent: (workspaceFile?: string | null) => string }} ctx
 */
export function registerOpenCodeRoutes(app, ctx) {
  app.get('/api/opencode/status', async (req, res) => {
    try {
      const workspaceFolder = typeof req.query.workspaceFolder === 'string'
        ? req.query.workspaceFolder.trim()
        : '';
      const folder = workspaceFolder || ctx.workspaceDirForAgent(null);
      const health = await getOpenCodeHealth(folder);
      return res.json({
        ok: health.ok !== false,
        opencodeReady: health.opencodeReady === true,
        healthy: health.healthy === true,
        version: health.version,
        connectedProviders: health.connectedProviders || [],
        ...getOpenCodeApiKeyMetaForClient(),
        ...getOpenCodeZaiApiKeyMetaForClient(),
        ...getOpenCodeMimoApiKeyMetaForClient(),
        opencodeSessionHint: 'Paste an OpenCode Zen, Z.AI, or Xiaomi MiMo API key in Settings → Harness → OpenCode, or set the matching API key environment variable on the server.',
        error: health.error,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/opencode/models', async (req, res) => {
    try {
      const workspaceFolder = typeof req.query.workspaceFolder === 'string'
        ? req.query.workspaceFolder.trim()
        : '';
      const folder = workspaceFolder || ctx.workspaceDirForAgent(null);
      if (!folder) {
        return res.status(400).json({ ok: false, error: 'Missing workspace folder' });
      }
      const health = await getOpenCodeHealth(folder);
      if (!health.opencodeReady) {
        return res.status(503).json({
          ok: false,
          error: health.error || 'OpenCode server is not ready — install opencode and add an API key for a supported provider.',
        });
      }
      const models = await listOpenCodeModels(folder);
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().opencodeChatEnabledModels);
      return res.json({ ok: true, models, chatEnabledModels });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
