/**
 * Reviewer-pool round record kept on the delegation workflow row. A pool round
 * is two reviewer jobs for one (leaf, material revision, epoch); the counter /
 * audit / epoch effect is applied once, when the round resolves.
 */

/** Distinct PASS members a pool round needs before it resolves as PASS. */
export const REVIEWER_POOL_EXPECTED_MEMBERS = 2;

const MAX_IDS = 8;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function readIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((id) => String(id || '').trim()).filter(Boolean).slice(-MAX_IDS);
}

/**
 * Normalize a persisted/incoming round record; `null` when absent or malformed.
 *
 * @param {unknown} raw
 * @returns {{
 *   key: string, epoch: number, mode: 'audit' | 'closure', pool: true,
 *   started: string[], results: Record<string, string>, superseded: string[],
 *   resolved: '' | 'PASS' | 'FAIL',
 * } | null}
 */
export function normalizeCodeReviewPoolRound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const key = String(row.key || '').trim();
  const mode = String(row.mode || '').trim() === 'audit' ? 'audit' : String(row.mode || '').trim() === 'closure' ? 'closure' : '';
  if (!key || !mode) return null;
  /** @type {Record<string, string>} */
  const results = {};
  if (row.results && typeof row.results === 'object') {
    for (const [id, verdict] of Object.entries(row.results)) {
      const cleanId = String(id || '').trim();
      const cleanVerdict = String(verdict || '').trim().toUpperCase();
      if (cleanId && cleanVerdict) results[cleanId] = cleanVerdict;
    }
  }
  const resolvedRaw = String(row.resolved || '').trim().toUpperCase();
  return {
    key,
    epoch: Math.max(0, Math.floor(Number(row.epoch) || 0)),
    mode,
    pool: true,
    started: readIdList(row.started),
    results,
    superseded: readIdList(row.superseded),
    resolved: resolvedRaw === 'PASS' || resolvedRaw === 'FAIL' ? resolvedRaw : '',
  };
}
