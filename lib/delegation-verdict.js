/**
 * Parent-loop verdict contract. The server does not sequence roles; it only
 * parses the child's report line and aggregates optional review fanout.
 */

export const DELEGATION_VERDICTS = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCKED',
  'unspecified',
  'conflict',
]);

const VERDICT_LINE = /^VERDICT:\s*(PASS|FAIL|BLOCKED)\s*$/i;
const COMPACT_TASK_VERDICT = /(?:^|[^A-Z])TASK\s*:\s*(?:audit|implement|review)\s*VERDICT\s*:\s*(PASS|FAIL|BLOCKED)(?:$|[^A-Z])/i;
const INCOMPLETE_REPORT_MAX_CHARS = 400;
const INCOMPLETE_REPORT_MIN_SPACE_RATIO = 0.04;

/**
 * Map a skill role onto the server assignment. Plan stays read-only so a
 * planner cannot write the workspace; the parent saves the plan. Fix is a
 * mutating implement follow-up.
 *
 * @param {unknown} role
 * @returns {'review' | 'implement' | ''}
 */
export function mapDelegationRoleToAssignment(role) {
  const raw = String(role || '').trim().toLowerCase();
  if (raw === 'review' || raw === 'plan') return 'review';
  if (raw === 'implement' || raw === 'fix') return 'implement';
  return '';
}

/**
 * Review adapter finished without a usable report (one-liner, empty, or
 * compacted thinking dump). A real VERDICT line is never incomplete.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isIncompleteDelegationReport(text) {
  if (parseDelegationVerdict(text) !== 'unspecified') return false;
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (raw.length < INCOMPLETE_REPORT_MAX_CHARS) return true;
  const spaces = (raw.match(/\s/g) || []).length;
  return (spaces / raw.length) < INCOMPLETE_REPORT_MIN_SPACE_RATIO;
}

/**
 * Last matching `VERDICT:` line wins unless two distinct values appear.
 *
 * @param {unknown} text
 * @returns {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'}
 */
export function parseDelegationVerdict(text) {
  const hits = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line.trim());
    if (!match) continue;
    hits.push(String(match[1] || '').toUpperCase());
  }
  if (hits.length === 0) {
    const compact = COMPACT_TASK_VERDICT.exec(String(text || ''));
    if (compact?.[1]) return /** @type {'PASS' | 'FAIL' | 'BLOCKED'} */ (compact[1].toUpperCase());
    return 'unspecified';
  }
  const unique = [...new Set(hits)];
  if (unique.length > 1) return 'conflict';
  return /** @type {'PASS' | 'FAIL' | 'BLOCKED'} */ (unique[0]);
}

/**
 * Conservative fanout: any BLOCKED wins, then FAIL, then conflict.
 * PASS only when every review is PASS. Missing lines stay unspecified.
 *
 * @param {unknown[]} verdicts
 * @returns {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'}
 */
export function aggregateReviewFanoutVerdicts(verdicts) {
  const parsed = (Array.isArray(verdicts) ? verdicts : []).map((value) => {
    const raw = String(value || '').trim();
    if (raw === 'PASS' || raw === 'FAIL' || raw === 'BLOCKED' || raw === 'unspecified' || raw === 'conflict') {
      return raw;
    }
    return parseDelegationVerdict(value);
  });
  if (parsed.length === 0) return 'unspecified';
  if (parsed.some((row) => row === 'BLOCKED')) return 'BLOCKED';
  if (parsed.some((row) => row === 'FAIL')) return 'FAIL';
  if (parsed.some((row) => row === 'conflict')) return 'conflict';
  if (parsed.every((row) => row === 'PASS')) return 'PASS';
  return 'unspecified';
}

/**
 * Next-step rule for the parent skill. Conflict is not PASS.
 *
 * @param {unknown} verdict
 * @returns {'continue' | 'fix' | 'stop'}
 */
export function resolveVerdictNextStep(verdict) {
  const value = String(verdict || '').trim();
  if (value === 'PASS') return 'continue';
  if (value === 'FAIL' || value === 'conflict') return 'fix';
  return 'stop';
}
