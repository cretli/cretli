/**
 * Claude Agent SDK HTTP routes — health and model catalog.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getClaudeApiKeyMetaForClient, isClaudeHarnessConfigured } from '../claude/claude-api-key.js';
import { getClaudeAuthMode } from '../claude/claude-auth-mode.js';
import { hasClaudeSubscriptionAuth } from '../claude/claude-subscription.js';
import {
  cancelClaudePlanLogin,
  completeClaudePlanLogin,
  getClaudePlanLoginState,
  startClaudePlanLogin,
} from '../claude/claude-plan-login.js';
import { isClaudeSdkAvailable } from '../claude/claude-sdk.js';
import {
  listClaudeModels,
  resolveDefaultClaudeModel,
} from '../claude/claude-models.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerClaudeRoutes(app) {
  app.get('/api/claude/status', async (_req, res) => {
    try {
      const sdkAvailable = await isClaudeSdkAvailable();
      const keyMeta = getClaudeApiKeyMetaForClient();
      const credentialsConfigured = isClaudeHarnessConfigured();
      const claudeAuthMode = getClaudeAuthMode();
      const claudeSubscriptionSignedIn = claudeAuthMode === 'subscription'
        && hasClaudeSubscriptionAuth();
      const ready = sdkAvailable && credentialsConfigured;
      return res.json({
        ok: true,
        ready,
        sdkAvailable,
        credentialsConfigured,
        claudeAuthMode,
        claudeSubscriptionSignedIn,
        login: getClaudePlanLoginState(),
        defaultModel: resolveDefaultClaudeModel(),
        ...keyMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/claude/models', async (_req, res) => {
    try {
      const listed = await listClaudeModels();
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().claudeChatEnabledModels);
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

  app.post('/api/claude/login/start', (_req, res) => {
    const started = startClaudePlanLogin();
    return res.json({ ok: true, login: started.login });
  });

  app.post('/api/claude/login/complete', async (req, res) => {
    const result = await completeClaudePlanLogin(req.body?.code);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, login: result.login });
    }
    return res.json({
      ok: true,
      login: result.login,
      claudeAuthMode: 'subscription',
      claudeSubscriptionSignedIn: true,
    });
  });

  app.post('/api/claude/login/cancel', (_req, res) => {
    const cancelled = cancelClaudePlanLogin();
    return res.json({ ok: true, login: cancelled.login });
  });

}
