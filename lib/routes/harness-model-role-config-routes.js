/**
 * Settings → Harness: audited model-role config write route.
 *
 * `GET    /api/harness-model-role-config`         read state + ETag + editable view
 * `PUT    /api/harness-model-role-config`         apply a delta (If-Match; `?dryRun=1` previews)
 * `POST   /api/harness-model-role-config/reset`   backup + reset to built-in defaults
 *
 * Access mirrors the other Harness admin routes: a full cookie session with the
 * CSRF header (enforced globally by `requireAuth`). Widget and MCP-integration
 * callers get 403 before any read or write. A stale `If-Match` is a 409, a
 * structurally invalid on-disk config is a 409 that refuses to overwrite, and
 * an invalid delta is a 400.
 */

import {
  ModelRoleConfigError,
  previewModelRoleConfig,
  readModelRoleConfig,
  resetModelRoleConfig,
  writeModelRoleConfig,
} from '../model-role-config-store.js';
import {
  DEFAULT_ADAPTIVE_CONFIG,
  DEFAULT_ROLE_SCORE_WEIGHTS,
  DEFAULT_ROTATION_CONFIG,
} from '../model-role-profiles.js';
import { msg } from '../messages.js';
import { loadModelPickExploreAttempts } from '../persist/model-pick-explore-persist.js';
import { summarizeModelPickExploreAttempts } from '../model-pick-explore.js';
import { registerModelPickOverrideRoutes } from './model-pick-override-routes.js';
import { registerBenchmarkSourcesRoutes } from './benchmark-sources-routes.js';

/**
 * Bounded, prompt-free explore status for the read-only Settings panel. It
 * keeps the rotation cold-start (a ranking signal, exposed via `rotation`) and
 * the out-of-band attempt ledger (a durable reservation list) visibly separate.
 *
 * @param {{ filePath?: string }} [input]
 * @returns {object}
 */
export function buildModelPickExploreStatus(input = {}) {
  let attempts = [];
  try {
    attempts = loadModelPickExploreAttempts({ file: input.filePath });
  } catch {
    attempts = [];
  }
  const ledger = summarizeModelPickExploreAttempts(attempts);
  const open = Object.values(ledger.openByPair).map((row) => ({
    pairKey: row.pairKey,
    harness: row.harness,
    baseModel: row.baseModel,
    role: row.role,
    status: row.status,
    startedAt: row.startedAt,
  }));
  return {
    attemptCount: attempts.length,
    consumed: ledger.consumed,
    open,
    recent: attempts.slice(-20),
  };
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeIfMatch(value) {
  const header = Array.isArray(value) ? value[0] : value;
  return String(header || '').trim();
}

/**
 * Project the store snapshot onto the public admin payload. The absolute path
 * is not exposed; the UI only needs the state, ETag and editable values.
 *
 * @param {ReturnType<typeof readModelRoleConfig>} snapshot
 * @returns {object}
 */
function publicSnapshot(snapshot) {
  return {
    ok: true,
    state: snapshot.state,
    error: snapshot.error,
    etag: snapshot.etag,
    roles: snapshot.editable,
    weights: snapshot.weights,
    defaultWeights: DEFAULT_ROLE_SCORE_WEIGHTS,
    rotation: snapshot.rotation,
    defaultRotation: DEFAULT_ROTATION_CONFIG,
    adaptive: snapshot.adaptive,
    defaultAdaptive: DEFAULT_ADAPTIVE_CONFIG,
    // Explore policy is read-only here; a later task owns its editing.
    explore: snapshot.explore,
    defaultExplore: snapshot.defaultExplore,
    unknownTopLevelKeys: snapshot.unknownTopLevelKeys,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ roleProfilesFile?: string }} [ctx]
 */
export function registerHarnessModelRoleConfigRoutes(app, ctx = {}) {
  const filePath = String(ctx.roleProfilesFile || '').trim() || undefined;

  app.get('/api/harness-model-role-config', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    try {
      const snapshot = readModelRoleConfig({ filePath });
      return res.json({
        ...publicSnapshot(snapshot),
        // The out-of-band attempt ledger is a different mechanism from the
        // rotation cold-start. Expose it read-only so the panel can show an
        // active reservation, a dry-run proposal and an assessed result.
        exploreStatus: buildModelPickExploreStatus({
          filePath: ctx.exploreFile,
        }),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put('/api/harness-model-role-config', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const dryRun = String(req.query?.dryRun || '').trim().toLowerCase();
    const isDryRun = dryRun === '1' || dryRun === 'true' || dryRun === 'yes';
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    const delta = req.body && typeof req.body === 'object' && !Array.isArray(req.body) && 'delta' in req.body
      ? req.body.delta
      : req.body;
    try {
      if (isDryRun) {
        return res.json({ ok: true, dryRun: true, ...previewModelRoleConfig({ filePath, delta }) });
      }
      if (!ifMatch) {
        const current = readModelRoleConfig({ filePath });
        return res.status(428).json({
          ok: false,
          error: 'If-Match header is required',
          state: current.state,
          etag: current.etag,
        });
      }
      const result = writeModelRoleConfig({ filePath, delta, ifMatch });
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
        });
      }
      return res.json({ ok: true, state: result.state, etag: result.etag, diff: result.diff });
    } catch (err) {
      if (err instanceof ModelRoleConfigError) {
        return res.status(400).json({ ok: false, error: err.message, code: err.code });
      }
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/harness-model-role-config/reset', (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const ifMatch = normalizeIfMatch(req.headers?.['if-match']);
    try {
      const result = resetModelRoleConfig({ filePath, ifMatch: ifMatch || undefined });
      if (!result.ok) {
        return res.status(409).json({
          ok: false,
          state: result.state,
          error: result.error,
          etag: result.etag,
          conflict: result.conflict === true,
        });
      }
      return res.json({
        ok: true,
        state: result.state,
        etag: result.etag,
        backupPath: result.backupPath,
        diff: result.diff,
      });
    } catch (err) {
      if (err instanceof ModelRoleConfigError) {
        return res.status(400).json({ ok: false, error: err.message, code: err.code });
      }
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Audited global overrides live in their own store, next to (not inside) the
  // role config, so a role delta can never rewrite them and vice versa.
  registerModelPickOverrideRoutes(app, {
    basePath: '/api/harness-model-role-config/overrides',
    scope: 'global',
    filePath: ctx.modelOverridesFile,
    source: 'settings-ui',
  });
  registerBenchmarkSourcesRoutes(app, {
    benchmarkSnapshotsFile: ctx.benchmarkSnapshotsFile,
  });
}
