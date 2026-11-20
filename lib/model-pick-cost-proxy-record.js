/**
 * Journal shape of the `cost_proxy` fact (plan v10 §2.2).
 *
 * Deliberately dependency-free so the decision-log persistence can import it
 * without pulling in the history/usage modules. The proxy is a relative cost
 * index in RCU (USD-equivalent per 1M tokens), never money: no `usd` field is
 * ever stored or returned, so it cannot be mistaken for a metered cost.
 */

export const COST_PROXY_UNIT = 'rcu';

/** How the per-million rate was obtained. `empty` means no tier and no rate. */
export const COST_PROXY_BASES = Object.freeze(['rate', 'tier_table', 'empty']);

/** Where the token volume came from. */
export const COST_PROXY_TOKEN_SOURCES = Object.freeze(['history', 'role', 'constant']);

const MAX_ENTRIES = 12;

/**
 * @param {unknown} input
 * @returns {{ candidateId: string, value: number | null, basis: string, tokenSource: string, tier: number | null } | null}
 */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const row = /** @type {any} */ (input);
  const basis = String(row.basis || '').trim().toLowerCase();
  const tokenSource = String(row.tokenSource || '').trim().toLowerCase();
  if (!COST_PROXY_BASES.includes(basis) || !COST_PROXY_TOKEN_SOURCES.includes(tokenSource)) return null;
  const candidateId = String(row.candidateId || '').trim();
  if (!candidateId) return null;
  const raw = Number(row.value);
  const value = row.value != null && Number.isFinite(raw) && raw >= 0 ? Number(raw.toFixed(4)) : null;
  const tierRaw = Number(row.tier);
  const tier = row.tier != null && Number.isFinite(tierRaw) ? tierRaw : null;
  return { candidateId, value, basis, tokenSource, tier };
}

/**
 * Reduce a stored/returned cost-proxy block to the closed field list.
 *
 * @param {unknown} input
 * @returns {{ unit: 'rcu', level: string, selected: object | null, candidates: object[] } | null}
 */
export function normalizeCostProxy(input) {
  if (!input || typeof input !== 'object') return null;
  const block = /** @type {any} */ (input);
  const candidates = (Array.isArray(block.candidates) ? block.candidates : [])
    .map(normalizeEntry)
    .filter(Boolean)
    .slice(0, MAX_ENTRIES);
  const selected = normalizeEntry(block.selected);
  if (!selected && candidates.length === 0) return null;
  return {
    unit: COST_PROXY_UNIT,
    level: String(block.level || '').trim().toLowerCase(),
    selected,
    candidates,
  };
}
