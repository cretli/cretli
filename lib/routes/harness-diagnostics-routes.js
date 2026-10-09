/**
 * Read-only Settings → Harness model diagnostics.
 *
 * `GET /api/harness-diagnostics` reproduces the picker for the current catalog
 * snapshot and returns per-model eligibility/availability/stats plus the
 * explanation of the selected model and candidate order. It never writes and
 * never starts an inference: it only reads the same catalogs, the usage ledger
 * and the delegation aggregate the picker already reads. Restricted callers
 * (widget / MCP integration) get 403, exactly like the harness catalog routes.
 */

import { listHarnessCatalog, listHarnessModelsIncludingLocal } from '../harness-catalog.js';
import { buildModelPickHistory, buildDelegationOutcomes } from '../model-pick-history.js';
import { buildModelPickExploreLedger, listPurposeUses } from '../model-pick-service.js';
import { loadModelPickExploreConfig } from '../model-pick-explore.js';
import { loadUsageSummary } from '../usage/usage-ledger.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { loadDelegations } from '../persist/delegations-persist.js';
import { MODEL_PICK_USAGE_WINDOW_MS } from '../model-pick-policy.js';
import {
  loadAdaptiveConfig,
  loadModelRoleProfiles,
  loadRoleScoreWeights,
  loadRotationConfig,
  MODEL_PICK_ROLES,
} from '../model-role-profiles.js';
import { loadModelPickRecords } from '../persist/model-pick-decisions-persist.js';
import { inspectModelRoleProfilesConfig } from '../model-config-inspect.js';
import { buildModelDiagnostics } from '../model-diagnostics.js';
import { parseUsageRange } from './usage-routes.js';
import { msg } from '../messages.js';

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isRestrictedCaller(req) {
  return Boolean(req?.widgetAccess || req?.mcpIntegration);
}

/**
 * Favorite rows feed the picker (the same `enabledOnly: true` read the MCP
 * `model_pick` uses); the full row set is only for display, so a disabled or
 * non-favorite model stays visible without entering the pick.
 *
 * @param {object[]} harnesses
 * @returns {Promise<{ picker: Record<string, object>, all: Record<string, object>, meta: Record<string, object> }>}
 */
async function collectHarnessModels(harnesses) {
  /** @type {Record<string, object>} */
  const picker = {};
  /** @type {Record<string, object>} */
  const all = {};
  /** @type {Record<string, object>} */
  const meta = {};
  for (const harness of harnesses) {
    const id = String(harness.id || '').trim();
    if (!id) continue;
    // Every catalog row is listed for display, so a disabled harness and its
    // disabled favorites stay visible with an explicit reason.
    const everything = await listHarnessModelsIncludingLocal({ harness: id, enabledOnly: false });
    all[id] = everything;
    const delegatable = harness?.enabled === true && harness?.ready === true && harness?.can_delegate === true;
    const favorites = delegatable
      ? await listHarnessModelsIncludingLocal({ harness: id, enabledOnly: true })
      : null;
    if (favorites) picker[id] = favorites;
    const source = favorites || everything;
    meta[id] = {
      stale: source?.stale === true,
      lastAttemptAt: source?.lastAttemptAt ?? null,
      lastSuccessAt: source?.lastSuccessAt ?? null,
      source: source?.source || '',
      warning: source?.warning || '',
    };
  }
  return { picker, all, meta };
}

/**
 * Newest persisted proposal for a role, if any. Only the already-stored
 * `policyVersion` / `candidates` / `picks` are read back — nothing is written.
 *
 * @param {string} role
 * @returns {object | null}
 */
function latestProposalForRole(role) {
  try {
    const records = loadModelPickRecords();
    let best = null;
    for (const row of Object.values(records || {})) {
      if (!row || typeof row !== 'object') continue;
      if (String(row.role || '').trim().toLowerCase() !== role) continue;
      const at = Date.parse(String(row.createdAt || ''));
      const bestAt = best ? Date.parse(String(best.createdAt || '')) : NaN;
      if (!best || (Number.isFinite(at) && (!Number.isFinite(bestAt) || at > bestAt))) best = row;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string, roleProfilesFile?: string }} [ctx]
 */
export function registerHarnessDiagnosticsRoutes(app, ctx = {}) {
  app.get('/api/harness-diagnostics', async (req, res) => {
    if (isRestrictedCaller(req)) {
      return res.status(403).json({ ok: false, error: msg(req, 'widget.endpointUnavailable') });
    }
    const role = String(req.query?.role || 'implement').trim().toLowerCase();
    if (!MODEL_PICK_ROLES.includes(/** @type {import('../model-role-profiles.js').ModelPickRole} */ (role))) {
      return res.status(400).json({ ok: false, error: 'role must be plan, implement, review, or fix' });
    }
    const range = parseUsageRange(req.query);
    if ('error' in range) return res.status(400).json({ ok: false, error: range.error });
    try {
      const now = Date.now();
      const catalog = await listHarnessCatalog();
      const harnessIds = (Array.isArray(catalog) ? catalog : [])
        .map((row) => String(row?.id || '').trim())
        .filter(Boolean);
      const { picker, all, meta } = await collectHarnessModels(catalog);
      const history = buildModelPickHistory({
        role,
        harnesses: harnessIds,
        extraUses: listPurposeUses('model_pick', { now }),
      });
      const usageSummary = loadUsageSummary({ from: range.from, to: range.to });
      // The canonical stats block needs the same rows and usage events the
      // cycle/cost aggregation already reads; loading them once here keeps the
      // pure builder free of I/O. The usage window matches the pick window
      // `summarizeDelegationCycleCostMetrics` uses internally.
      const delegationRows = loadDelegations();
      const usageEvents = readUsageEvents({
        from: new Date(now - MODEL_PICK_USAGE_WINDOW_MS).toISOString(),
        to: new Date(now).toISOString(),
      });
      const report = buildModelDiagnostics({
        role,
        now,
        harnesses: catalog,
        modelsByHarness: picker,
        allModelsByHarness: all,
        harnessMeta: meta,
        history,
        profiles: loadModelRoleProfiles(),
        weights: loadRoleScoreWeights(),
        rotation: loadRotationConfig(),
        adaptive: loadAdaptiveConfig(),
        exploreLedger: buildModelPickExploreLedger({ now }),
        exploreConfig: loadModelPickExploreConfig(),
        outcomes: buildDelegationOutcomes({ rows: delegationRows, now }),
        delegationRows,
        usageEvents,
        usageSummary,
        usageRange: { from: range.from, to: range.to },
        config: inspectModelRoleProfilesConfig({ filePath: ctx.roleProfilesFile }),
        latestProposal: latestProposalForRole(role),
      });
      return res.json(report);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
