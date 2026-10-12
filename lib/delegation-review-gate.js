/**
 * Review prompt blocks for fix-loop regression gate and leaf acceptance.
 */

export const DELEGATION_OPEN_FINDINGS_MAX = 8000;
export const DELEGATION_LEAF_ACCEPTANCE_MAX = 4000;

/** Return the same durable findings to both the fixer and the reviewer. */
function readPriorFindings(workflow, extraFindingsText) {
  return [
    String(workflow?.openFindingsText || workflow?.findingsText || '').trim(),
    String(extraFindingsText || '').trim(),
  ].filter(Boolean).join('\n\n');
}

/** Build the repair checklist without granting the executor a review verdict. */
export function buildFixFindingsPromptBlock(workflow, extraFindingsText = '') {
  const open = readPriorFindings(workflow, extraFindingsText);
  if (!open) return '';
  return [
    '[FIX CHECKLIST]',
    'Reconcile every prior finding below with the current code and assigned scope before editing. Preserve stable finding IDs.',
    'Fix the root cause through production callers and consumers, not just a helper or test stub. Preserve already-fixed behavior.',
    'Report each finding as FIXED or STILL_OPEN with file/behavior and focused regression-test evidence. Explain any out-of-scope finding instead of silently dropping it.',
    'Do not claim PASS while an in-scope blocking finding remains open. Your completion report is not independent review approval.',
    '[PRIOR FINDINGS]',
    open,
  ].join('\n');
}

/**
 * @param {unknown} existing
 * @param {unknown} findingsText
 * @param {unknown} findingsHash
 * @returns {string}
 */
export function mergeDelegationOpenFindings(existing, findingsText, findingsHash) {
  const hash = String(findingsHash || '').trim();
  const text = String(findingsText || '').trim();
  if (!text) return String(existing || '').trim();
  const prior = String(existing || '').trim();
  const marker = hash ? `[finding ${hash.slice(0, 12)}]` : '[finding]';
  if (prior.includes(marker)) return prior;
  const block = `${marker}\n${text}`;
  const merged = prior ? `${prior}\n\n${block}` : block;
  if (merged.length <= DELEGATION_OPEN_FINDINGS_MAX) return merged;
  return merged.slice(merged.length - DELEGATION_OPEN_FINDINGS_MAX);
}

/**
 * @param {object | null | undefined} workflow
 * @param {unknown} [extraFindingsText] Durable per-leaf findings (e.g. the
 *   Workspace Watcher store) that must survive an orchestrator chat change.
 * @returns {string}
 */
export function buildRegressionGatePromptBlock(workflow, extraFindingsText = '') {
  const open = readPriorFindings(workflow, extraFindingsText);
  if (!open) return '';
  const stop = String(workflow?.stopReason || '').trim();
  const stopLine = stop === 'same_findings'
    ? 'The parent loop is stopped for no progress (same_findings): identical FAIL with unchanged material. Report BLOCKED unless you see new evidence.'
    : '';
  return [
    '[REGRESSION GATE]',
    'This review follows a fix round. You must re-check every prior finding below, not only the latest diff.',
    'For each prior finding line, state FIXED or STILL_OPEN with evidence (file, test, or behavior).',
    'Run regression tests that were added for prior findings when named or discoverable in the diff.',
    'VERDICT must be FAIL if any prior finding regressed or remains STILL_OPEN without justification.',
    stopLine,
    '[PRIOR FINDINGS]',
    open,
  ].filter(Boolean).join('\n');
}

/**
 * @param {unknown} body
 * @returns {string}
 */
export function extractLeafAcceptanceCriteria(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  const markers = [
    /\*\*Kryteria akceptacji\.?\*\*/i,
    /\*\*Acceptance criteria\.?\*\*/i,
    /##\s*Kryteria akceptacji/i,
    /##\s*Acceptance criteria/i,
  ];
  for (const re of markers) {
    const match = re.exec(raw);
    if (!match) continue;
    const tail = raw.slice(match.index + match[0].length).trim();
    const nextHeading = tail.search(/\n##\s+|\n\*\*[A-Z]/);
    const section = nextHeading >= 0 ? tail.slice(0, nextHeading).trim() : tail;
    if (section) return section.slice(0, DELEGATION_LEAF_ACCEPTANCE_MAX);
  }
  return raw.slice(0, Math.min(1200, DELEGATION_LEAF_ACCEPTANCE_MAX));
}

/**
 * @param {unknown} acceptanceText
 * @returns {string}
 */
export {
  buildAuditReviewPromptBlock,
  buildClosureReviewPromptBlock,
} from './delegation-code-review-phase.js';

export function buildLeafAcceptancePromptBlock(acceptanceText) {
  const text = String(acceptanceText || '').trim();
  if (!text) return '';
  return [
    '[LEAF ACCEPTANCE]',
    'Judge PASS/FAIL against these leaf criteria in addition to code-level checks.',
    text,
  ].join('\n');
}
