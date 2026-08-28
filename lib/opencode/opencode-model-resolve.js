/**
 * OpenCode model aliases and dedup — Zen lists duplicate display names under
 * opencode-go/* (paid zen/go API) and opencode/* (free tier). Prefer opencode/*.
 */

/** @type {Record<string, string>} */
export const OPENCODE_MODEL_ALIASES = {
  'opencode-go/ox-alpha-free': 'opencode/x-preview-f-free',
};

/**
 * @param {string} modelValue
 * @returns {string}
 */
export function resolveOpenCodeModelForPrompt(modelValue) {
  const raw = String(modelValue || '').trim();
  if (!raw) return raw;
  return OPENCODE_MODEL_ALIASES[raw] || raw;
}

/**
 * @param {Array<{ id: string, name: string, providerId?: string, modelId?: string, contextWindowTokens?: number | null }>} models
 * @returns {Array<{ id: string, name: string, providerId: string, modelId: string, contextWindowTokens: number | null }>}
 */
export function dedupeOpenCodeModelsForChat(models) {
  if (!Array.isArray(models) || models.length === 0) return [];
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
    if (shouldPreferOpenCodeModel(normalized, existing)) {
      byName.set(nameKey, normalized);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {{ providerId: string }} candidate
 * @param {{ providerId: string }} incumbent
 * @returns {boolean}
 */
function shouldPreferOpenCodeModel(candidate, incumbent) {
  const candidateIsGo = candidate.providerId === 'opencode-go';
  const incumbentIsGo = incumbent.providerId === 'opencode-go';
  if (incumbentIsGo && !candidateIsGo) return true;
  if (candidateIsGo && !incumbentIsGo) return false;
  return false;
}
