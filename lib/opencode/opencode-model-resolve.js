/**
 * OpenCode model aliases and dedup — Zen lists duplicate display names under
 * opencode-go/* (paid zen/go API) and opencode/* (free tier). Prefer opencode/*.
 * Z.AI lists the same GLM names under zai/* (pay as you go) and zai-coding-plan/*.
 */

import { getOpenCodeZaiProvider, normalizeOpenCodeZaiProvider } from './opencode-zai-api-key.js';

/** @type {Record<string, string>} */
export const OPENCODE_MODEL_ALIASES = {
  'opencode-go/ox-alpha-free': 'opencode/x-preview-f-free',
};

const ZAI_PAYG_PROVIDERS = new Set(['zai', 'zhipuai']);
const ZAI_PLAN_PROVIDERS = new Set(['zai-coding-plan', 'zhipuai-coding-plan']);

/**
 * Map a Z.AI model id onto the configured plan (pay as you go vs Coding Plan).
 *
 * @param {string} modelValue
 * @param {'zai-coding-plan' | 'zai'} [preferredProvider]
 * @returns {string}
 */
export function remapOpenCodeZaiModel(modelValue, preferredProvider = 'zai-coding-plan') {
  const raw = String(modelValue || '').trim();
  if (!raw) return raw;
  const slashIndex = raw.indexOf('/');
  if (slashIndex <= 0) return raw;
  const providerId = raw.slice(0, slashIndex);
  const modelId = raw.slice(slashIndex + 1);
  if (!modelId) return raw;
  const preferred = normalizeOpenCodeZaiProvider(preferredProvider);
  if (preferred === 'zai-coding-plan' && providerId === 'zai') {
    return `zai-coding-plan/${modelId}`;
  }
  if (preferred === 'zai' && providerId === 'zai-coding-plan') {
    return `zai/${modelId}`;
  }
  if (preferred === 'zai-coding-plan' && providerId === 'zhipuai') {
    return `zhipuai-coding-plan/${modelId}`;
  }
  if (preferred === 'zai' && providerId === 'zhipuai-coding-plan') {
    return `zhipuai/${modelId}`;
  }
  return raw;
}

/**
 * @param {string} modelValue
 * @returns {string}
 */
export function resolveOpenCodeModelForPrompt(modelValue) {
  const raw = String(modelValue || '').trim();
  if (!raw) return raw;
  const aliased = OPENCODE_MODEL_ALIASES[raw] || raw;
  return remapOpenCodeZaiModel(aliased, getOpenCodeZaiProvider());
}

/**
 * @param {Array<{ id: string, name: string, providerId?: string, modelId?: string, contextWindowTokens?: number | null }>} models
 * @param {{ preferredZaiProvider?: 'zai-coding-plan' | 'zai' }} [options]
 * @returns {Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>}
 */
export function dedupeOpenCodeModelsForChat(models, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const preferredZaiProvider = normalizeOpenCodeZaiProvider(options.preferredZaiProvider);
  /** @type {Map<string, { id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>} */
  const byName = new Map();
  for (const row of models) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const slashIndex = id.indexOf('/');
    if (slashIndex <= 0) continue;
    const providerId = String(row?.providerId || id.slice(0, slashIndex)).trim();
    const modelId = String(row?.modelId || id.slice(slashIndex + 1)).trim();
    const name = String(row?.name || modelId).trim() || modelId;
    const normalized = {
      id,
      name,
      providerId,
      modelId,
      contextWindowTokens: Number.isFinite(Number(row?.contextWindowTokens))
        ? Math.round(Number(row.contextWindowTokens))
        : null,
    };
    const nameKey = name.toLowerCase();
    const existing = byName.get(nameKey);
    if (!existing) {
      byName.set(nameKey, normalized);
      continue;
    }
    if (shouldPreferOpenCodeModel(normalized, existing, preferredZaiProvider)) {
      byName.set(nameKey, normalized);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {{ providerId: string }} candidate
 * @param {{ providerId: string }} incumbent
 * @param {'zai-coding-plan' | 'zai'} preferredZaiProvider
 * @returns {boolean}
 */
function shouldPreferOpenCodeModel(candidate, incumbent, preferredZaiProvider) {
  const candidateIsGo = candidate.providerId === 'opencode-go';
  const incumbentIsGo = incumbent.providerId === 'opencode-go';
  if (incumbentIsGo && !candidateIsGo) return true;
  if (candidateIsGo && !incumbentIsGo) return false;
  const candidateRank = rankZaiProvider(candidate.providerId, preferredZaiProvider);
  const incumbentRank = rankZaiProvider(incumbent.providerId, preferredZaiProvider);
  return candidateRank > incumbentRank;
}

/**
 * @param {string} providerId
 * @param {'zai-coding-plan' | 'zai'} preferredZaiProvider
 * @returns {number}
 */
function rankZaiProvider(providerId, preferredZaiProvider) {
  const isPayg = ZAI_PAYG_PROVIDERS.has(providerId);
  const isPlan = ZAI_PLAN_PROVIDERS.has(providerId);
  if (!isPayg && !isPlan) return 0;
  if (preferredZaiProvider === 'zai-coding-plan') return isPlan ? 2 : 1;
  return isPayg ? 2 : 1;
}
