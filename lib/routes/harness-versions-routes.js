/**
 * GET /api/harness/versions — read-only CLI/SDK version inventory per harness.
 *
 * The payload comes from local package manifests plus, only when a harness
 * resolves its CLI outside Cretli's own npm trees (env, settings or PATH), one
 * cached `<bin> --version` probe. Nothing here reaches a vendor network and
 * nothing is applied.
 *
 * Upstream checks are opt-in and read-only:
 * - `?check=1` consults the registry only when the cached snapshot is stale
 *   (~6 h); a fresh snapshot is returned untouched with `updateFromCache: true`.
 * - `?force=1` (used together with `check=1`) bypasses the cache TTL and the
 *   failure backoff so the caller gets a guaranteed network round trip.
 */

import { getHarnessVersionInventoryWithUpdates } from '../harness-updates.js';
import { msg } from '../messages.js';
import { spawn } from 'child_process';

let mistralInstallInFlight = false;

/**
 * Widget and MCP bearer tokens clear `requireAuth` before the CSRF gate, so a
 * session-only route has to reject them itself (same guard as the catalog routes).
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * @param {import('express').Express} app
 * @param {{ inventory?: typeof getHarnessVersionInventoryWithUpdates }} [ctx]
 */
export function registerHarnessVersionsRoutes(app, ctx = {}) {
  const inventory = ctx.inventory || getHarnessVersionInventoryWithUpdates;

  /** `?persist=0` answers without rewriting the snapshot file; `?force=1` skips the update cache. */
  app.get('/api/harness/versions', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const persist = !(req.query?.persist === '0' || req.query?.persist === 'false');
    const check = req.query?.check === '1' || req.query?.check === 'true';
    const force = req.query?.force === '1' || req.query?.force === 'true';
    try {
      const result = await inventory({ persist, check, force });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/api/harness/mistral/install', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    if (mistralInstallInFlight) {
      return res.status(409).json({ ok: false, error: 'A Mistral package installation is already running.' });
    }
    const projectRoot = String(ctx.projectRoot || process.cwd());
    mistralInstallInFlight = true;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('npm', ['install', '--no-save', '--package-lock=false', '@mistralai/mistralai'], {
          cwd: projectRoot,
          env: process.env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `npm install exited with code ${code}`));
        });
      });
      return res.json({ ok: true, restartRequired: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    } finally {
      mistralInstallInFlight = false;
    }
  });
}
