/**
 * Codex SDK HTTP routes — health, model catalog, ChatGPT device login.
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';
import { getCodexAuthMode } from '../codex/codex-auth-mode.js';
import { getCodexApiKeyMetaForClient } from '../codex/codex-api-key.js';
import { getCodexChatGptAuthMetaForClient } from '../codex/codex-chatgpt-auth.js';
import { hasCodexCredentials } from '../codex/codex-credentials.js';
import {
  cancelCodexDeviceLogin,
  getCodexLoginState,
  logoutCodexChatGpt,
  startCodexDeviceLogin,
} from '../codex/codex-device-login.js';
import { isCodexCliFound, resolveCodexCli, getCodexCliMissingHint } from '../codex/codex-cli.js';
import { isCodexSdkAvailable } from '../codex/codex-sdk.js';
import {
  listCodexModels,
  resolveDefaultCodexModel,
} from '../codex/codex-models.js';
import { loadSettings } from '../persist/settings.js';

/**
 * @param {import('express').Express} app
 */
export function registerCodexRoutes(app) {
  app.get('/api/codex/status', async (_req, res) => {
    try {
      const sdkAvailable = await isCodexSdkAvailable();
      const cliFound = isCodexCliFound();
      const keyMeta = getCodexApiKeyMetaForClient();
      const chatgptMeta = getCodexChatGptAuthMetaForClient();
      const authMode = getCodexAuthMode();
      const ready = sdkAvailable && cliFound && hasCodexCredentials();
      return res.json({
        ok: true,
        ready,
        sdkAvailable,
        cliFound,
        cliPath: resolveCodexCli(),
        cliHint: cliFound ? '' : getCodexCliMissingHint(),
        defaultModel: resolveDefaultCodexModel(),
        codexAuthMode: authMode,
        login: getCodexLoginState(),
        ...keyMeta,
        ...chatgptMeta,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/codex/models', async (_req, res) => {
    try {
      const listed = await listCodexModels();
      const chatEnabledModels = normalizeChatEnabledModels(loadSettings().codexChatEnabledModels);
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

  app.post('/api/codex/login/start', (_req, res) => {
    const started = startCodexDeviceLogin();
    if (!started.ok) {
      return res.status(503).json({ ok: false, error: started.error || 'Unable to start Codex login.' });
    }
    return res.json({ ok: true, login: getCodexLoginState() });
  });

  app.get('/api/codex/login/status', (_req, res) => {
    return res.json({
      ok: true,
      login: getCodexLoginState(),
      ...getCodexChatGptAuthMetaForClient(),
      ready: hasCodexCredentials(),
    });
  });

  app.post('/api/codex/login/cancel', (_req, res) => {
    cancelCodexDeviceLogin();
    return res.json({ ok: true, login: getCodexLoginState() });
  });

  app.post('/api/codex/logout', (_req, res) => {
    const result = logoutCodexChatGpt();
    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error || 'Logout failed.' });
    }
    return res.json({
      ok: true,
      ...getCodexChatGptAuthMetaForClient(),
      login: getCodexLoginState(),
    });
  });
}
