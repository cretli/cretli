/**
 * Frozen 2026-09 heuristic cost/quality/speed tiers for catalog ids.
 * Never scraped from the network. Optional disk override lives in
 * model-score-heuristics-fs.js (Node only — this file is bundled in the UI).
 */

/**
 * @typedef {{ pattern: string, cost: number, quality: number, speed: number }} ModelScoreRow
 */

/** @type {Readonly<ModelScoreRow[]>} */
export const DEFAULT_MODEL_SCORE_ROWS = Object.freeze([
  Object.freeze({ pattern: 'glm-5.3-flash', cost: 1, quality: 4, speed: 5 }),
  Object.freeze({ pattern: 'deepseek-flash', cost: 1, quality: 4, speed: 5 }),
  Object.freeze({ pattern: 'gpt-5.3-codex', cost: 2, quality: 3, speed: 4 }),
  Object.freeze({ pattern: 'astra', cost: 5, quality: 5, speed: 4 }),
  Object.freeze({ pattern: 'fable', cost: 5, quality: 5, speed: 1 }),
  Object.freeze({ pattern: 'sol', cost: 4, quality: 5, speed: 4 }),
  Object.freeze({ pattern: 'luna', cost: 3, quality: 4, speed: 4 }),
  Object.freeze({ pattern: 'terra', cost: 3, quality: 4, speed: 3 }),
  Object.freeze({ pattern: 'mythos', cost: 4, quality: 4, speed: 2 }),
  Object.freeze({ pattern: 'grok', cost: 4, quality: 5, speed: 4 }),
  Object.freeze({ pattern: 'opus-5', cost: 4, quality: 5, speed: 2 }),
  Object.freeze({ pattern: 'opus', cost: 4, quality: 4, speed: 2 }),
  Object.freeze({ pattern: 'sonnet-5', cost: 2, quality: 5, speed: 3 }),
  Object.freeze({ pattern: 'sonnet', cost: 2, quality: 4, speed: 3 }),
  Object.freeze({ pattern: 'mimo-v2.6-pro', cost: 3, quality: 5, speed: 3 }),
  Object.freeze({ pattern: 'hy3', cost: 2, quality: 4, speed: 4 }),
  Object.freeze({ pattern: 'hy4', cost: 3, quality: 4, speed: 3 }),
  Object.freeze({ pattern: 'composer', cost: 2, quality: 3, speed: 5 }),
  Object.freeze({ pattern: 'glm-5.3', cost: 2, quality: 4, speed: 3 }),
  Object.freeze({ pattern: 'glm', cost: 2, quality: 3, speed: 3 }),
  Object.freeze({ pattern: 'deepseek', cost: 3, quality: 4, speed: 3 }),
  Object.freeze({ pattern: 'qwen', cost: 2, quality: 3, speed: 3 }),
  Object.freeze({ pattern: 'kimi', cost: 3, quality: 4, speed: 1 }),
  Object.freeze({ pattern: 'flash', cost: 1, quality: 3, speed: 5 }),
  Object.freeze({ pattern: 'mini', cost: 1, quality: 2, speed: 5 }),
  Object.freeze({ pattern: 'nano', cost: 1, quality: 2, speed: 5 }),
  Object.freeze({ pattern: 'haiku', cost: 1, quality: 2, speed: 5 }),
]);

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampTier(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(5, Math.round(n)));
}

/**
 * @param {unknown} raw
 * @returns {ModelScoreRow[]}
 */
export function normalizeModelScoreRows(raw) {
  const source = raw && typeof raw === 'object' && Array.isArray(/** @type {{ rows?: unknown }} */ (raw).rows)
    ? /** @type {{ rows: unknown[] }} */ (raw).rows
    : Array.isArray(raw) ? raw : [];
  /** @type {ModelScoreRow[]} */
  const out = [];
  for (const row of source) {
    const pattern = String(row?.pattern || '').trim().toLowerCase();
    if (!pattern) continue;
    out.push({
      pattern,
      cost: clampTier(row.cost, 3),
      quality: clampTier(row.quality, 3),
      speed: clampTier(row.speed, 3),
    });
  }
  return out.length > 0 ? out : [...DEFAULT_MODEL_SCORE_ROWS];
}

function rowMatchesModelId(hay, pattern) {
  if (hay.includes(pattern)) return true;
  const parts = pattern.split(/[-_./]/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => hay.includes(part));
}

/**
 * Longest substring (or hyphen-token) match wins (e.g. deepseek-v4.1-flash
 * uses the deepseek-flash row).
 *
 * @param {string} modelId
 * @param {ModelScoreRow[]} [rows]
 * @returns {ModelScoreRow | null}
 */
export function matchModelScoreRow(modelId, rows = DEFAULT_MODEL_SCORE_ROWS) {
  const hay = String(modelId || '').trim().toLowerCase();
  if (!hay || hay === 'auto' || hay === 'default') return null;
  /** @type {ModelScoreRow | null} */
  let best = null;
  for (const row of rows) {
    if (!rowMatchesModelId(hay, row.pattern)) continue;
    if (!best || row.pattern.length > best.pattern.length) best = row;
  }
  return best;
}
