/**
 * Resolve which harness/model runs a Workspace Watcher orchestrator cycle.
 * Loads the same catalog inputs as MCP `model_pick` (enabled favorites, ready,
 * can_delegate) and never falls back to an empty server default.
 */

import { assertReviewAdapterAllowed } from './delegation-adapter-capabilities.js';
import { listHarnessCatalog, listHarnessModelsIncludingLocal } from './harness-catalog.js';
import { decodeModelValue } from './model-catalog.js';
import { selectModelPick } from './model-role-profiles.js';
import { pickModelForPurpose } from './model-pick-service.js';
import { MCP_CAPABILITY_DENIED, createMcpCapabilityProbe } from './mcp/mcp-orchestrator-contract.js';

/**
 * @param {string} model
 * @returns {string}
 */
function baseModelId(model) {
  return decodeModelValue(String(model || '').trim()).modelId.toLowerCase();
}

/**
 * Active usage limit rows scoped to one harness/model pair (base-model aware).
 *
 * @param {string} harness
 * @param {string} model
 * @param {object[]} activeUsageLimits
 * @returns {boolean}
 */
export function isWorkspaceWatcherOrchestratorModelUsageLimited(harness, model, activeUsageLimits) {
  const wantedHarness = String(harness || '').trim().toLowerCase();
  const wantedModel = String(model || '').trim().toLowerCase();
  const wantedBase = baseModelId(model);
  for (const row of Array.isArray(activeUsageLimits) ? activeUsageLimits : []) {
    if (String(row?.harness ?? '').trim().toLowerCase() !== wantedHarness) continue;
    if (new Date(row.resetAt).getTime() <= Date.now()) continue;
    const limitedModel = String(row.model || '').trim().toLowerCase();
    if (!limitedModel) return true;
    if (limitedModel === wantedModel) return true;
    if (baseModelId(row.model) === wantedBase) return true;
  }
  return false;
}

/**
 * @param {string} harness
 * @param {object[]} items
 * @param {object[]} activeUsageLimits
 * @returns {object[]}
 */
function eligibleFavoriteModels(harness, items, activeUsageLimits) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((row) => {
    const id = String(row?.id ?? '').trim();
    if (!id) return false;
    return !isWorkspaceWatcherOrchestratorModelUsageLimited(harness, id, activeUsageLimits);
  });
}

/**
 * @param {object[]} harnesses
 * @param {string[]} allowedHarnesses
 * @returns {object[]}
 */
function filterHarnessCatalog(harnesses, allowedHarnesses) {
  const allowed = Array.isArray(allowedHarnesses)
    ? allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  return harnesses.filter((row) => {
    const id = String(row?.id ?? '').trim();
    if (!id || !row?.enabled || !row?.ready || !row?.can_delegate) return false;
    if (allowed.length > 0 && !allowed.includes(id)) return false;
    return true;
  });
}

/**
 * @param {object} client
 * @param {object[]} harnesses
 * @param {object[]} activeUsageLimits
 * @returns {Promise<Record<string, object>>}
 */
async function collectModelsByHarness(client, harnesses, activeUsageLimits) {
  /** @type {Record<string, object>} */
  const modelsByHarness = {};
  for (const harness of harnesses) {
    const id = String(harness?.id ?? '').trim();
    if (!id) continue;
    const catalog = await client.listHarnessModels({
      harness: id,
      enabledOnly: true,
    });
    const items = eligibleFavoriteModels(id, Array.isArray(catalog?.items) ? catalog.items : [], activeUsageLimits);
    modelsByHarness[id] = { ...catalog, items };
  }
  return modelsByHarness;
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {Record<string, object>} modelsByHarness
 * @returns {boolean}
 */
function isFavoriteModel(harness, model, modelsByHarness) {
  const catalog = modelsByHarness[harness];
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const id = String(model ?? '').trim();
  if (!id) return items.length > 0;
  return items.some((row) => String(row?.id ?? '').trim() === id);
}

/**
 * Whether one harness can deliver the Cretli MCP orchestrator contract in this
 * workspace. Returns the denial code, or '' when the harness is capable.
 *
 * @param {(input: { harness: string, workspaceFolder: string }) => { ok?: boolean, reason?: string } | null} probe
 * @param {string} harness
 * @param {string} workspaceFolder
 * @returns {string}
 */
function readMcpCapabilityDenial(probe, harness, workspaceFolder) {
  let verdict;
  try {
    verdict = probe({ harness, workspaceFolder });
  } catch {
    return MCP_CAPABILITY_DENIED.CONFIG;
  }
  if (verdict?.ok) return '';
  return String(verdict?.reason || '').trim() || MCP_CAPABILITY_DENIED.CONFIG;
}

/**
 * Keep only harnesses that channel have the Cretli MCP tools an orchestrator
 * needs. The first denial reason per harness is kept for the blocked decision.
 *
 * @param {object[]} harnesses
 * @param {(input: { harness: string, workspaceFolder: string }) => { ok?: boolean, reason?: string } | null} probe
 * @param {string} workspaceFolder
 * @returns {{ capable: object[], denied: Map<string, string> }}
 */
function splitHarnessesByMcpCapability(harnesses, probe, workspaceFolder) {
  /** @type {object[]} */
  const capable = [];
  /** @type {Map<string, string>} */
  const denied = new Map();
  for (const row of harnesses) {
    const id = String(row?.id ?? '').trim();
    if (!id) continue;
    const reason = readMcpCapabilityDenial(probe, id, workspaceFolder);
    if (reason) denied.set(id, reason);
    else capable.push(row);
  }
  return { capable, denied };
}

/**
 * The decision reason when every otherwise-eligible harness was rejected for a
 * missing MCP bridge. Distinct codes for adapter / config / tools let the
 * operator see what to fix; a mixed set stays deterministic (catalog order).
 *
 * @param {object[]} eligibleHarnesses
 * @param {Map<string, string>} denied
 * @returns {string}
 */
function resolveMcpCapabilityBlockReason(eligibleHarnesses, denied) {
  for (const row of eligibleHarnesses) {
    const reason = denied.get(String(row?.id ?? '').trim());
    if (reason) return reason;
  }
  return MCP_CAPABILITY_DENIED.CONFIG;
}

/**
 * @param {{
 *   watcher: object,
 *   workspaceFolder?: string,
 *   activeUsageLimits?: object[],
 *   purpose?: string,
 *   deps?: {
 *     listHarnessCatalog?: () => Promise<object[]>,
 *     listHarnessModels?: (input: object) => Promise<object>,
 *     selectModelPick?: typeof selectModelPick,
 *     mcpCapabilityProbe?: (input: { harness: string, workspaceFolder: string }) => { ok?: boolean, reason?: string } | null,
 *     mcpCapabilityDeps?: object,
 *   },
 * }} input
 * @returns {Promise<{ ok: true, harness: string, model: string, source: string } | { ok: false, reason: string, source: string }>}
 */
export async function resolveWorkspaceWatcherOrchestrator(input) {
  const watcher = input.watcher || {};
  const policy = watcher?.policy && typeof watcher.policy === 'object' ? watcher.policy : {};
  const explicit = policy.orchestrator && typeof policy.orchestrator === 'object'
    ? policy.orchestrator
    : {};
  const explicitHarness = String(explicit.harness ?? '').trim();
  const explicitModel = String(explicit.model ?? '').trim();
  const allowedHarnesses = Array.isArray(policy.allowedHarnesses)
    ? policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  const limits = Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [];
  const deps = input.deps || {};
  const listCatalog = typeof deps.listHarnessCatalog === 'function'
    ? deps.listHarnessCatalog
    : listHarnessCatalog;
  const listModels = typeof deps.listHarnessModels === 'function'
    ? deps.listHarnessModels
    : listHarnessModelsIncludingLocal;
  const picker = typeof deps.selectModelPick === 'function' ? deps.selectModelPick : selectModelPick;
  const capabilityProbe = typeof deps.mcpCapabilityProbe === 'function'
    ? deps.mcpCapabilityProbe
    : createMcpCapabilityProbe(deps.mcpCapabilityDeps && typeof deps.mcpCapabilityDeps === 'object' ? deps.mcpCapabilityDeps : {});
  // Only the Watcher cycle orchestrator must prove the full Cretli MCP
  // contract; Scout shares this resolver but neither delegates nor reports, so
  // it keeps its previous selection behaviour.
  const requiresOrchestratorMcp = input.requireOrchestratorMcpContract === true
    || (input.requireOrchestratorMcpContract !== false && String(input.purpose || '').trim() !== 'scout');
  const workspaceFolder = String(input.workspaceFolder || watcher.workspaceFolder || '').trim();
  const client = { listHarnessModels: listModels };
  const allHarnesses = await listCatalog();
  const eligibleHarnesses = filterHarnessCatalog(allHarnesses, allowedHarnesses);
  const modelsByHarness = await collectModelsByHarness(client, eligibleHarnesses, limits);
  if (explicitHarness) {
    if (allowedHarnesses.length > 0 && !allowedHarnesses.includes(explicitHarness)) {
      return { ok: false, reason: 'orchestrator_harness_not_allowed', source: 'policy' };
    }
    const harnessRow = allHarnesses.find((row) => String(row?.id ?? '').trim() === explicitHarness);
    if (!harnessRow?.enabled || !harnessRow?.ready || !harnessRow?.can_delegate) {
      return { ok: false, reason: 'orchestrator_harness_unavailable', source: 'policy' };
    }
    // `ready`/`can_delegate` do not prove the Cretli MCP bridge: an orchestrator
    // on a harness without it would edit files itself and never report.
    if (requiresOrchestratorMcp) {
      const denial = readMcpCapabilityDenial(capabilityProbe, explicitHarness, workspaceFolder);
      if (denial) {
        return { ok: false, reason: denial, source: 'policy' };
      }
    }
    const favorites = modelsByHarness[explicitHarness]?.items || [];
    if (favorites.length === 0) {
      return { ok: false, reason: 'orchestrator_model_usage_limited', source: 'policy' };
    }
    const resolvedModel = explicitModel || String(favorites[0]?.id ?? '').trim();
    if (!resolvedModel || !isFavoriteModel(explicitHarness, resolvedModel, modelsByHarness)) {
      return { ok: false, reason: explicitModel ? 'orchestrator_model_not_favorite' : 'orchestrator_model_usage_limited', source: 'policy' };
    }
    return {
      ok: true,
      harness: explicitHarness,
      model: resolvedModel,
      source: 'policy',
      modelSelection: {
        role: 'implement',
        mode: 'explicit',
        selected: { harness: explicitHarness, model: resolvedModel, favorite: true },
        candidates: [{
          harness: explicitHarness,
          model: resolvedModel,
          rank: 1,
          favorite: true,
        }],
      },
    };
  }
  const { capable: capableHarnesses, denied: capabilityDenied } = requiresOrchestratorMcp
    ? splitHarnessesByMcpCapability(eligibleHarnesses, capabilityProbe, workspaceFolder)
    : { capable: eligibleHarnesses, denied: new Map() };
  if (requiresOrchestratorMcp && eligibleHarnesses.length > 0 && capableHarnesses.length === 0) {
    return {
      ok: false,
      reason: resolveMcpCapabilityBlockReason(eligibleHarnesses, capabilityDenied),
      source: 'implement_pick',
      mcpDeniedHarnesses: eligibleHarnesses.map((row) => ({
        harness: String(row?.id ?? '').trim(),
        reason: capabilityDenied.get(String(row?.id ?? '').trim()) || '',
      })).filter((row) => row.harness && row.reason),
    };
  }
  const excludeHarnesses = capableHarnesses
    .map((row) => String(row?.id ?? '').trim())
    .filter((id) => {
      const items = modelsByHarness[id]?.items;
      return !Array.isArray(items) || items.length === 0;
    });
  const picked = pickModelForPurpose({
    purpose: String(input.purpose || '').trim() || 'watcher-orchestrator',
    role: 'implement',
    workspaceFolder: String(input.workspaceFolder || input.cwd || '').trim(),
    selectModelPick: picker,
    harnesses: capableHarnesses.filter((row) => !excludeHarnesses.includes(String(row?.id ?? '').trim())),
    modelsByHarness,
    excludeHarnesses,
  });
  if (!picked?.ok || !picked.pick) {
    return {
      ok: false,
      reason: String(picked?.error || picked?.code || 'no_orchestrator_candidate'),
      source: 'implement_pick',
    };
  }
  const harness = String(picked.pick.harness ?? '').trim();
  const model = String(picked.pick.model ?? '').trim();
  if (!harness) {
    return { ok: false, reason: 'no_orchestrator_candidate', source: 'implement_pick' };
  }
  if (!assertReviewAdapterAllowed(harness).ok && !modelsByHarness[harness]) {
    return { ok: false, reason: 'orchestrator_harness_uncertified', source: 'implement_pick' };
  }
  return {
    ok: true,
    harness,
    model,
    source: 'implement_pick',
    modelSelection: buildModelSelectionAudit({ eligibleHarnesses, modelsByHarness, excludeHarnesses, picked }),
  };
}

/**
 * Keep a bounded, prompt-free explanation of the automatic choice.
 * @param {{ eligibleHarnesses: object[], modelsByHarness: Record<string, object>, excludeHarnesses: string[], picked: object }} input
 * @returns {object}
 */
function buildModelSelectionAudit({ eligibleHarnesses, modelsByHarness, excludeHarnesses, picked }) {
  const selected = picked?.pick || {};
  const candidates = Array.isArray(picked?.candidates) ? picked.candidates : [];
  return {
    role: 'implement',
    mode: 'automatic',
    rotation: picked?.rotation?.mode || '',
    selected: {
      harness: String(selected.harness || '').trim(),
      model: String(selected.model || '').trim(),
      score: Number.isFinite(Number(selected.score)) ? Number(selected.score) : null,
      reason: String(selected.reason || '').slice(0, 240),
      favorite: true,
    },
    candidates: candidates.slice(0, 8).map((candidate, index) => ({
      harness: String(candidate?.harness || '').trim(),
      model: String(candidate?.model || '').trim(),
      rank: index + 1,
      score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
      reason: String(candidate?.reason || '').slice(0, 240),
      favorite: true,
      roleUses7d: Number(candidate?.role_uses_7d) || 0,
      modelUses7d: Number(candidate?.model_uses_7d) || 0,
    })).filter((candidate) => candidate.harness && candidate.model),
    excludedHarnesses: eligibleHarnesses
      .map((row) => String(row?.id || '').trim())
      .filter((harness) => excludeHarnesses.includes(harness))
      .slice(0, 12)
      .map((harness) => ({
        harness,
        reason: (Array.isArray(modelsByHarness[harness]?.items) && modelsByHarness[harness].items.length > 0)
          ? 'all_favorites_usage_limited'
          : 'no_favorites',
      })),
  };
}
