/** HTTP routes for the Z.AI SDK harness. */

import { spawn } from 'node:child_process';
import { msg } from '../../lib/messages.js';
import { resolveProjectPath } from '../../lib/runtime-paths.js';
import { getZaiSdkApiKeyMetaForClient } from './zai-api-key.js';
import { invalidateZaiSdkAvailability, isZaiSdkAvailable } from './zai-sdk-runtime.js';
import { listZaiModels, resolveDefaultZaiModel } from './zai-models.js';
import { buildAgentChildEnv } from '../../lib/agent-env.js';

let zaiInstallInFlight = false;

/** @param {string[]} names */
function pickDefinedEnv(names) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value) out[name] = value;
  }
  return out;
}

/**
 * @param {import('express').Express} app
 * @param {{ projectRoot?: string }} [options] Where `scripts/setup-zai-sdk.sh` lives (default: the project root).
 */
export function registerZaiRoutes(app, options = {}) {
  app.get('/api/zai/status', (_req, res) => {
    const sdkAvailable = isZaiSdkAvailable();
    const keyMeta = getZaiSdkApiKeyMetaForClient();
    return res.json({
      ok: true,
      ready: sdkAvailable && keyMeta.zaiApiKeyEffective,
      sdkAvailable,
      defaultModel: resolveDefaultZaiModel(),
      ...keyMeta,
    });
  });
  app.get('/api/zai/models', (_req, res) => res.json({
    ok: true,
    models: listZaiModels().map(({ value, label, contextWindowTokens }) => ({
      id: value,
      name: label,
      contextWindowTokens,
    })),
    catalog: listZaiModels(),
    chatEnabledModels: listZaiModels().map((row) => row.value),
    defaultModel: resolveDefaultZaiModel(),
    modelsSource: 'fallback',
  }));

  // Explicit Settings action; widget and MCP bearer tokens clear requireAuth first, so reject them here.
  app.post('/api/harness/zai/install', async (req, res) => {
    if (req?.widgetAccess || req?.mcpIntegration) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    if (zaiInstallInFlight) {
      return res.status(409).json({ ok: false, error: 'A Z.AI SDK installation is already running.' });
    }
    const projectRoot = String(options.projectRoot || resolveProjectPath());
    zaiInstallInFlight = true;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('bash', ['scripts/setup-zai-sdk.sh'], {
          cwd: projectRoot,
          // setup-zai-sdk.sh reads ZAI_PYTHON_BIN / PYTHON_BIN; keep them under the allowlist.
          env: buildAgentChildEnv('tool', { overrides: pickDefinedEnv(['ZAI_PYTHON_BIN', 'PYTHON_BIN']) }),
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(stderr.trim() || `Z.AI SDK setup exited with code ${code}`));
        });
      });
      invalidateZaiSdkAvailability();
      return res.json({ ok: true, sdkAvailable: isZaiSdkAvailable() });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    } finally {
      zaiInstallInFlight = false;
    }
  });
}
