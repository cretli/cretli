/**
 * Reviewer-pool round record kept on the delegation workflow row. A pool round
 * is two reviewer jobs for one (leaf, material revision, epoch); the counter /
 * audit / epoch effect is applied once, when the round resolves.
 *
 * A round only resolves PASS when two DISTINCT reviewer identities passed. If
 * the required second distinct reviewer never arrives, a repeated reviewer
 * resolves the round as `DEGRADED` (a bounded, visible block) instead of
 * looping forever or counting a duplicate as a two-reviewer approval.
 */

/** Distinct PASS members a pool round needs before it resolves as PASS. */
export const REVIEWER_POOL_EXPECTED_MEMBERS = 2;

const MAX_IDS = 8;
const MAX_REVIEWERS = 16;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function readIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((id) => String(id || '').trim()).filter(Boolean).slice(-MAX_IDS);
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function readReviewerMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, string>} */
  const map = {};
  for (const [id, key] of Object.entries(value)) {
    const cleanId = String(id || '').trim();
    const cleanKey = String(key || '').trim();
    if (cleanId && cleanKey) map[cleanId] = cleanKey;
  }
  const ids = Object.keys(map);
  if (ids.length <= MAX_REVIEWERS) return map;
  /** @type {Record<string, string>} */
  const bounded = {};
  for (const id of ids.slice(-MAX_REVIEWERS)) bounded[id] = map[id];
  return bounded;
}

/** Membership values a pool member can carry on the round record. */
const REVIEWER_MEMBERSHIPS = new Set(['member', 'learning', 'outside_pool']);

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function readMembershipMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, string>} */
  const map = {};
  for (const [id, membership] of Object.entries(value)) {
    const cleanId = String(id || '').trim();
    const clean = String(membership || '').trim().toLowerCase();
    if (cleanId && REVIEWER_MEMBERSHIPS.has(clean)) map[cleanId] = clean;
  }
  const ids = Object.keys(map);
  if (ids.length <= MAX_REVIEWERS) return map;
  /** @type {Record<string, string>} */
  const bounded = {};
  for (const id of ids.slice(-MAX_REVIEWERS)) bounded[id] = map[id];
  return bounded;
}

/**
 * Normalize a persisted/incoming round record; `null` when absent or malformed.
 *
 * @param {unknown} raw
 * @returns {{
 *   key: string, epoch: number, mode: 'audit' | 'closure', pool: true,
 *   started: string[], results: Record<string, string>, reviewers: Record<string, string>,
 *   memberships: Record<string, string>,
 *   superseded: string[], resolved: '' | 'PASS' | 'FAIL' | 'DEGRADED', degradedReason: string,
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
    reviewers: readReviewerMap(row.reviewers),
    memberships: readMembershipMap(row.memberships),
    superseded: readIdList(row.superseded),
    resolved: resolvedRaw === 'PASS' || resolvedRaw === 'FAIL' || resolvedRaw === 'DEGRADED' ? resolvedRaw : '',
    degradedReason: String(row.degradedReason || '').trim(),
  };
}
