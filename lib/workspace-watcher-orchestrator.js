/**
 * Resolve which harness/model runs a Workspace Watcher orchestrator cycle.
 * Loads the same catalog inputs as MCP `model_pick` (enabled favorites, ready,
 * can_delegate) and never falls back to an empty server default.
 */

import { listHarnessCatalog, listHarnessModelsIncludingLocal } from './harness-catalog.js';
import { selectModelPick } from './model-role-profiles.js';
import { pickModelForPurpose } from './model-pick-service.js';
import { MCP_CAPABILITY_DENIED, createMcpCapabilityProbe } from './mcp/mcp-orchestrator-contract.js';
import {
  MODEL_PICK_HARD_GATE_CODES,
  evaluateModelPickHardGates,
  isModelUsageLimited,
  readModelPickMcpCapabilityDenial,
} from './model-pick-hard-gates.js';

/**
 * Active usage limit rows scoped to one harness/model pair (base-model aware).
 *
 * @param {string} harness
 * @param {string} model
 * @param {object[]} activeUsageLimits
 * @returns {boolean}
 */
export function isWorkspaceWatcherOrchestratorModelUsageLimited(harness, model, activeUsageLimits) {
  return isModelUsageLimited(harness, model, activeUsageLimits);
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
 * Map a shared hard-gate refusal to the Watcher's stable decision reason. The
 * reason strings are part of the persisted decision log, so they stay stable
 * even though the decision itself now comes from one validator.
 *
 * @param {object} verdict
 * @param {{ explicitModel?: string }} [context]
 * @returns {string}
 */
function mapHardGateRefusal(verdict, context = {}) {
  switch (verdict.code) {
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_NOT_ALLOWED:
      return 'orchestrator_harness_not_allowed';
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_UNAVAILABLE:
      return 'orchestrator_harness_unavailable';
    case MODEL_PICK_HARD_GATE_CODES.MCP_CAPABILITY:
      return String(verdict.mcpDenial || verdict.reason || MCP_CAPABILITY_DENIED.CONFIG);
    case MODEL_PICK_HARD_GATE_CODES.MODEL_NOT_FAVORITE:
      return context.explicitModel ? 'orchestrator_model_not_favorite' : 'orchestrator_model_usage_limited';
    case MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING:
    case MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT:
    case MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT:
    case MODEL_PICK_HARD_GATE_CODES.MODEL_REQUIRED:
      return 'orchestrator_model_usage_limited';
    case MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED:
    case MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED:
    case MODEL_PICK_HARD_GATE_CODES.HISTORY_EXCLUDED:
      return 'orchestrator_model_excluded';
    default:
      return String(verdict.reason || 'orchestrator_model_unavailable');
  }
}

/**
 * Build the shared-validator input for one resolver call. Centralised so the
 * explicit and automatic paths inject exactly the same store data and cannot
 * drift apart again.
 *
 * @param {{
 *   harness: string,
 *   model: string,
 *   allowedHarnesses: string[],
 *   harnessRow?: object,
 *   listed?: object,
 *   limits: object[],
 *   lockouts?: object[],
 *   excludeModels?: string[],
 *   excludeHarnesses?: string[],
 *   requireMcp: boolean,
 *   capabilityProbe: Function,
 *   workspaceFolder: string,
 * }} input
 * @returns {object}
 */
function buildHardGateInput(input) {
  const items = Array.isArray(input.listed?.items) ? input.listed.items : [];
  return {
    role: 'implement',
    harness: input.harness,
    model: input.model,
    allowedHarnesses: input.allowedHarnesses,
    harnessRow: input.harnessRow,
    favoritesConfigured: items.length > 0,
    favoriteModels: items.map((row) => String(row?.id ?? '').trim()).filter(Boolean),
    excludeModels: input.excludeModels,
    excludeHarnesses: input.excludeHarnesses,
    lockouts: input.lockouts,
    usageLimits: input.limits,
    requireMcp: input.requireMcp,
    mcpCapabilityProbe: input.capabilityProbe,
    workspaceFolder: input.workspaceFolder,
  };
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
  return readModelPickMcpCapabilityDenial(probe, harness, workspaceFolder);
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
 *   lockouts?: object[],
 *   excludeModels?: string[],
 *   excludeHarnesses?: string[],
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
    const harnessRow = allHarnesses.find((row) => String(row?.id ?? '').trim() === explicitHarness);
    const favorites = modelsByHarness[explicitHarness]?.items || [];
    const resolvedModel = explicitModel || String(favorites[0]?.id ?? '').trim();
    const verdict = evaluateModelPickHardGates(buildHardGateInput({
      harness: explicitHarness,
      model: resolvedModel,
      allowedHarnesses,
      harnessRow,
      listed: modelsByHarness[explicitHarness],
      limits,
      lockouts: input.lockouts,
      excludeModels: input.excludeModels,
      excludeHarnesses: input.excludeHarnesses,
      requireMcp: requiresOrchestratorMcp,
      capabilityProbe,
      workspaceFolder,
    }));
    if (!verdict.ok) {
      return { ok: false, reason: mapHardGateRefusal(verdict, { explicitModel }), source: 'policy' };
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
  // Re-run the same hard gates on the winner. The picker already filters its
  // candidates, so this is a cheap contract check: an automatic pick can never
  // slip past a rule the explicit/named paths enforce.
  const verdict = evaluateModelPickHardGates(buildHardGateInput({
    harness,
    model,
    allowedHarnesses,
    harnessRow: capableHarnesses.find((row) => String(row?.id ?? '').trim() === harness),
    listed: modelsByHarness[harness],
    limits,
    lockouts: input.lockouts,
    excludeModels: input.excludeModels,
    excludeHarnesses: [...(Array.isArray(input.excludeHarnesses) ? input.excludeHarnesses : []), ...excludeHarnesses],
    requireMcp: requiresOrchestratorMcp,
    capabilityProbe,
    workspaceFolder,
  }));
  if (!verdict.ok) {
    return { ok: false, reason: mapHardGateRefusal(verdict), source: 'implement_pick' };
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
