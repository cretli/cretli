/**
 * Closed registry of named predicates for the `condition_check` wake-up kind.
 * A stored check references a predicate by id plus plain-JSON params; no code
 * or expression is ever stored. Every predicate is pure and read-only, and its
 * cost per tick is bounded by one pass over the delegation records.
 */

export const MIN_COUNT_BOUNDS = Object.freeze([1, 1000]);

const TRANSPORT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const validateDelegationsFinishedSince = (raw) => {
  const params = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const transport = String(params.transport || '').trim().toLowerCase();
  if (!TRANSPORT_RE.test(transport)) return { ok: false, error: 'params.transport is required' };
  const assignment = String(params.assignment || '').trim().toLowerCase();
  if (assignment && !TRANSPORT_RE.test(assignment)) return { ok: false, error: 'params.assignment is invalid' };
  const sinceMs = Number(params.sinceMs);
  if (!Number.isFinite(sinceMs) || sinceMs < 0) return { ok: false, error: 'params.sinceMs must be a non-negative number' };
  const minCount = Number(params.minCount);
  if (!Number.isInteger(minCount) || minCount < MIN_COUNT_BOUNDS[0] || minCount > MIN_COUNT_BOUNDS[1]) {
    return { ok: false, error: `params.minCount must be an integer in ${MIN_COUNT_BOUNDS[0]}..${MIN_COUNT_BOUNDS[1]}` };
  }
  return { ok: true, value: { transport, ...(assignment ? { assignment } : {}), sinceMs: Math.floor(sinceMs), minCount } };
};

/**
 * @param {{ transport: string, assignment?: string, sinceMs: number, minCount: number }} params
 * @param {{ loadDelegations: () => Record<string, any>[] }} deps
 * @returns {{ met: boolean, current: number, target: number }}
 */
const evaluateDelegationsFinishedSince = (params, deps) => {
  let current = 0;
  for (const row of deps.loadDelegations()) {
    if (!row || !row.finishedAt) continue;
    if (String(row.executor?.transport || '').toLowerCase() !== params.transport) continue;
    if (params.assignment && String(row.assignment || row.requestedRole || '').toLowerCase() !== params.assignment) continue;
    const finishedMs = Date.parse(row.finishedAt);
    if (Number.isFinite(finishedMs) && finishedMs > params.sinceMs) current += 1;
  }
  return { met: current >= params.minCount, current, target: params.minCount };
};

export const CONDITION_PREDICATES = Object.freeze({
  delegations_finished_since: Object.freeze({
    description: 'At least minCount delegations of one transport finished after sinceMs.',
    validate: validateDelegationsFinishedSince,
    evaluate: evaluateDelegationsFinishedSince,
  }),
});

/**
 * @param {string} id
 * @returns {{ validate: Function, evaluate: Function, description: string }|null}
 */
export function getConditionPredicate(id) {
  const key = String(id || '');
  return Object.prototype.hasOwnProperty.call(CONDITION_PREDICATES, key) ? CONDITION_PREDICATES[key] : null;
}
