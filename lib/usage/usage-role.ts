/**
 * Effective usage role of a ledger event.
 *
 * Writers stamp `role` from the room (`resolveHarnessRole`). Before schema 4
 * the runtime assignment folded plan authoring into `review` and `fix` into
 * `implement`, and the watcher orchestrator was filed under `chat`. Readers use
 * `resolveEffectiveUsageRole` so history joins back to the delegation's work
 * role and the cycle orchestrator without rewriting persisted events.
 */

/** Usage roles a delegation work role maps to. */
const WORK_ROLE_TO_USAGE_ROLE = Object.freeze({
  plan: 'plan',
  implement: 'implement',
  fix: 'fix',
  review_plan: 'review',
  review_code: 'review',
  review_other: 'review',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Usage role for a delegation row/work role; '' when it cannot be classified.
 * Falls back to the legacy `assignment` for rows written before `workRole`.
 *
 * @param {Record<string, any> | string | null | undefined} rowOrWorkRole
 * @returns {string}
 */
export function delegationWorkRole(rowOrWorkRole) {
  const row = rowOrWorkRole && typeof rowOrWorkRole === 'object' ? rowOrWorkRole : null;
  const workRole = text(row ? row.workRole : rowOrWorkRole);
  if (WORK_ROLE_TO_USAGE_ROLE[workRole]) return WORK_ROLE_TO_USAGE_ROLE[workRole];
  const assignment = text(row?.assignment);
  return assignment === 'implement' || assignment === 'review' ? assignment : '';
}

/**
 * @param {Record<string, any>[] | undefined} delegations
 * @returns {Map<string, string>} delegation id -> usage role
 */
export function buildDelegationRoleIndex(delegations) {
  const index = new Map();
  for (const row of Array.isArray(delegations) ? delegations : []) {
    const id = String(row?.id ?? '').trim();
    const role = delegationWorkRole(row);
    if (id && role) index.set(id, role);
  }
  return index;
}

/**
 * @param {Record<string, any>} event
 * @param {Map<string, string>} [roleIndex] from `buildDelegationRoleIndex`
 * @returns {string} effective role, or the stored one (possibly '') when nothing refines it
 */
export function resolveEffectiveUsageRole(event, roleIndex) {
  const stored = text(event?.role);
  const delegationId = String(event?.delegationId ?? '').trim();
  if (delegationId) return roleIndex?.get(delegationId) || stored;
  if ((!stored || stored === 'chat') && String(event?.cycleId ?? '').trim()) return 'orchestrator';
  return stored;
}
