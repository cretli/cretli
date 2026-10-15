/**
 * Two-phase code review per leaf: one scoped audit, then closure rounds that
 * re-check open findings and regressions only.
 */

import { resolveDelegationEnv, resolveReviewerPool } from './delegation-settings.js';
import { REVIEWER_POOL_EXPECTED_MEMBERS, normalizeCodeReviewPoolRound } from './delegation-pool-round.js';
import { delegationController } from './delegation-control.js';
import { parseDelegationVerdict } from './delegation-verdict.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import {
  delegationPersistedRole,
  isInfraDelegationOutcomeForCycle,
  isUserCancelledDelegation,
} from './delegation-cycle-classify.js';

/** Matches `DELEGATION_WORKFLOW_RESUME_ROUND_STEP` in delegation-workflow.js. */
const CODE_REVIEW_RESUME_CLOSURE_STEP = 1;

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
function readDelegationExecutorKey(row) {
  const transport = String(row?.executor?.transport || row?.harness || '').trim().toLowerCase();
  const model = String(row?.executor?.model || row?.model || '').trim();
  if (!transport || !model) return '';
  return `${transport}/${model}`;
}

export const DELEGATION_CODE_REVIEW_MODES = Object.freeze(['audit', 'closure']);
export const DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED = 'closure_rounds_exhausted';
export const DEFAULT_MAX_CODE_REVIEW_CLOSURES = 2;

/**
 * Workspace-aware env for the code-review options: the explicit workspace of
 * the start input, else the workflow row's workspace, else `process.env`.
 *
 * @param {{ workspaceFolder?: unknown, workflow?: object | null }} input
 * @returns {Record<string, string | undefined>}
 */
function codeReviewEnvFor(input) {
  return resolveDelegationEnv(input?.workspaceFolder || input?.workflow?.workspaceFolder);
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isDelegationCodeReviewPhaseEnabled(env = process.env) {
  const raw = String(env?.CRETLI_DELEGATION_CODE_REVIEW_PHASE || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

/**
 * @param {unknown} value
 * @returns {'' | 'audit' | 'closure'}
 */
export function normalizeDelegationCodeReviewMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'audit' || raw === 'closure') return raw;
  return '';
}

/**
 * @param {object | null | undefined} workflow
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function readMaxCodeReviewClosures(workflow, env = resolveDelegationEnv(workflow?.workspaceFolder)) {
  const fromRow = Number(workflow?.maxCodeReviewClosures ?? workflow?.max_code_review_closures);
  if (Number.isFinite(fromRow) && fromRow >= 0) return Math.floor(fromRow);
  const fromEnv = Number(env?.CRETLI_DELEGATION_CODE_REVIEW_MAX_CLOSURES);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv);
  return DEFAULT_MAX_CODE_REVIEW_CLOSURES;
}

/**
 * @param {object | null | undefined} workflow
 * @returns {{ auditDone: boolean, closureCount: number, auditReviewer: string }}
 */
export function readCodeReviewPhaseCounters(workflow) {
  return {
    auditDone: workflow?.codeReviewAuditDone === true,
    closureCount: Math.max(0, Math.floor(Number(workflow?.codeReviewClosureCount) || 0)),
    auditReviewer: String(workflow?.codeReviewAuditReviewer || workflow?.code_review_audit_reviewer || '').trim(),
  };
}

/**
 * Monotonic generation counter for closure workflow patches. Incremented when
 * audit completes or counters reset after PASS so idempotency keys do not replay
 * across audit cycles while round=0 degenerate slots repeat (`0::0`, `0::1`, …).
 *
 * @param {object | null | undefined} workflow
 * @returns {number}
 */
export function readCodeReviewClosureEpoch(workflow) {
  return Math.max(0, Math.floor(Number(workflow?.codeReviewClosureEpoch) || 0));
}

/**
 * @param {object | null | undefined} workflow
 * @returns {number}
 */
function bumpCodeReviewClosureEpoch(workflow) {
  return readCodeReviewClosureEpoch(workflow) + 1;
}

/**
 * Closure dedup key when workflow round and material revision are both absent.
 * Uses the next slot index (`0::${closureCount}`). A new closure pass clears
 * `codeReviewLastClosureRoundKey` so fanout finishes can still replay the prior slot.
 *
 * @param {object | null | undefined} workflow
 * @returns {string}
 */
function buildDegenerateClosureRoundKey(workflow) {
  const closureCount = readCodeReviewPhaseCounters(workflow).closureCount;
  const prior = String(workflow?.codeReviewLastClosureRoundKey || '').trim();
  const priorMatch = prior.match(/^0::(\d+)$/);
  if (priorMatch && closureCount > Number(priorMatch[1])) {
    return prior;
  }
  return `0::${closureCount}`;
}

/**
 * @param {object | null | undefined} workflow
 * @param {object | null | undefined} [delegation]
 * @returns {string}
 */
export function buildCodeReviewClosureRoundKey(workflow, delegation = null) {
  const round = Math.max(0, Math.floor(Number(workflow?.round) || 0));
  const material = String(
    delegation?.verifyResult?.materialRevision
    || delegation?.materialRevision
    || workflow?.materialRevision
    || '',
  ).trim();
  if (material) return `${round}:${material}`;
  if (round === 0) return buildDegenerateClosureRoundKey(workflow);
  return `${round}:`;
}

/**
 * @param {object | null | undefined} delegation
 * @param {object | null | undefined} [workflow]
 * @returns {string}
 */
export function resolveCodeReviewPhaseWorkflowIdempotencyKey(delegation, workflow = null) {
  const mode = normalizeDelegationCodeReviewMode(delegation?.reviewMode);
  // Every pool member finish mutates the round record, so it needs its own slot.
  if (findPoolRoundForDelegation(workflow, delegation?.id)) {
    return `code-review-phase-pool-${String(delegation?.id || '').trim()}`;
  }
  if (mode !== 'closure') {
    return `code-review-phase-${String(delegation?.id || '').trim()}`;
  }
  const roundKey = buildCodeReviewClosureRoundKey(workflow, delegation);
  const epoch = readCodeReviewClosureEpoch(workflow);
  return `code-review-phase-${epoch}-${roundKey}`;
}

/**
 * Clear stale closure round keys before a new closure delegation starts.
 *
 * @param {object | null | undefined} workflow
 * @returns {Record<string, unknown> | null}
 */
export function buildCodeReviewWorkflowPatchOnClosureStart(workflow) {
  if (!workflow || typeof workflow !== 'object') return null;
  const prior = String(workflow.codeReviewLastClosureRoundKey || '').trim();
  if (!prior) return null;
  return { codeReviewLastClosureRoundKey: '' };
}

/**
 * Pool round record the delegation belongs to (matching the current epoch), or
 * null. The record is captured when the round starts, so a settings flip or a
 * closure start in between cannot reclassify the round.
 *
 * @param {object | null | undefined} workflow
 * @param {unknown} delegationId
 * @returns {ReturnType<typeof normalizeCodeReviewPoolRound>}
 */
function findPoolRoundForDelegation(workflow, delegationId) {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  const record = normalizeCodeReviewPoolRound(workflow?.codeReviewPoolRound);
  if (!record || record.epoch !== readCodeReviewClosureEpoch(workflow)) return null;
  return record.started.includes(id) ? record : null;
}

/**
 * Workflow patch applied when a code-review delegation (audit or closure) is
 * about to start. Without the opt-in pool this is exactly the closure-start
 * clearing of the last closure round key. With the pool on it opens (or joins)
 * the per-round record; an unresolved record is never cleared by a start.
 *
 * @param {object | null | undefined} workflow
 * @param {{ delegationId?: unknown, mode?: unknown, workspaceFolder?: unknown }} [input]
 * @returns {Record<string, unknown> | null}
 */
export function buildCodeReviewWorkflowPatchOnStart(workflow, input = {}) {
  const mode = normalizeDelegationCodeReviewMode(input.mode);
  if (!mode) return null;
  const legacy = mode === 'closure' ? buildCodeReviewWorkflowPatchOnClosureStart(workflow) : null;
  const delegationId = String(input.delegationId || '').trim();
  if (!delegationId) return legacy;
  const epoch = readCodeReviewClosureEpoch(workflow);
  const record = normalizeCodeReviewPoolRound(workflow?.codeReviewPoolRound);
  const key = buildCodeReviewClosureRoundKey(workflow);
  const degenerate = key.startsWith('0::');
  if (record && record.epoch === epoch && record.key === key) {
    if (record.started.includes(delegationId)) return null;
    // A resolved record is joined only by a late sibling of the same
    // (round, material); without material info the next round is
    // indistinguishable, so it opens a new record.
    const joinable = record.resolved ? !degenerate && record.started.length < REVIEWER_POOL_EXPECTED_MEMBERS : true;
    if (joinable) {
      return { codeReviewPoolRound: { ...record, started: [...record.started, delegationId] } };
    }
  }
  const poolActive = resolveReviewerPool(input.workspaceFolder || workflow?.workspaceFolder).active;
  if (!poolActive) {
    // Switch off at round start: drop any stale record; behaviour stays legacy.
    if (!record) return legacy;
    return { ...(legacy || {}), codeReviewPoolRound: null };
  }
  const superseded = record ? [...record.superseded, ...record.started].slice(-8) : [];
  return {
    ...(legacy || {}),
    codeReviewPoolRound: {
      key,
      epoch,
      mode,
      pool: true,
      started: [delegationId],
      results: {},
      superseded,
      resolved: '',
    },
  };
}

/**
 * Pool member finish: record the result and apply the counter/audit/epoch
 * effect exactly once, when the round resolves (any FAIL, or two PASS).
 *
 * @param {NonNullable<ReturnType<typeof normalizeCodeReviewPoolRound>>} record
 * @param {object} delegation
 * @param {object | null | undefined} workflow
 * @param {Record<string, unknown>} patch
 * @param {string} verdict
 * @param {string} reviewerKey
 * @returns {Record<string, unknown> | null}
 */
function buildPoolRoundFinishPatch(record, delegation, workflow, patch, verdict, reviewerKey) {
  // Late sibling of an already resolved round: its result changes nothing.
  if (record.resolved) return null;
  const id = String(delegation.id).trim();
  const results = { ...record.results, [id]: verdict === 'PASS' ? 'PASS' : verdict || 'FAIL' };
  const failed = Object.values(results).some((value) => value !== 'PASS');
  const passes = Object.values(results).filter((value) => value === 'PASS').length;
  if (!failed && passes < REVIEWER_POOL_EXPECTED_MEMBERS) {
    return { ...patch, codeReviewPoolRound: { ...record, results } };
  }
  const nextEpoch = bumpCodeReviewClosureEpoch(workflow);
  if (!failed) {
    return {
      ...patch,
      codeReviewAuditDone: false,
      codeReviewClosureCount: 0,
      codeReviewAuditReviewer: '',
      codeReviewLastClosureRoundKey: '',
      codeReviewClosureEpoch: nextEpoch,
      codeReviewPoolRound: { ...record, results, resolved: 'PASS', epoch: nextEpoch },
    };
  }
  if (record.mode === 'audit') {
    return {
      ...patch,
      codeReviewAuditDone: true,
      codeReviewClosureCount: 0,
      codeReviewLastClosureRoundKey: '',
      codeReviewClosureEpoch: nextEpoch,
      ...(reviewerKey ? { codeReviewAuditReviewer: reviewerKey } : {}),
      codeReviewPoolRound: { ...record, results, resolved: 'FAIL', epoch: nextEpoch },
    };
  }
  const nextClosureCount = readCodeReviewPhaseCounters(workflow).closureCount + 1;
  patch.codeReviewClosureCount = nextClosureCount;
  patch.codeReviewLastClosureRoundKey = record.key;
  patch.codeReviewPoolRound = { ...record, results, resolved: 'FAIL' };
  const maxClosures = readMaxCodeReviewClosures(
    workflow,
    resolveDelegationEnv(delegation.workspaceFolder || workflow?.workspaceFolder),
  );
  if (Object.values(results).includes('FAIL') && nextClosureCount >= maxClosures) {
    patch.stopReason = DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED;
  }
  return patch;
}

/**
 * Terminal code-review finish that should advance audit/closure counters.
 *
 * @param {object | null | undefined} delegation
 * @returns {boolean}
 */
export function isCredibleCodeReviewTerminal(delegation) {
  if (!delegation || typeof delegation !== 'object') return false;
  if (!isTerminalDelegationStatus(delegation.status)) return false;
  if (isUserCancelledDelegation(delegation)) return false;
  const role = delegationPersistedRole(delegation);
  if (isInfraDelegationOutcomeForCycle(delegation, role)) return false;
  const verdict = resolveEffectiveCodeReviewReportVerdict(delegation);
  if (!verdict || verdict === 'unspecified' || verdict === 'conflict') return false;
  return true;
}

/**
 * @param {unknown} report
 * @returns {number}
 */
function readFollowUpSectionStart(report) {
  const text = String(report || '');
  const match = text.match(/\[FOLLOW[_\s-]?UP\]/i);
  if (!match || match.index == null) return -1;
  return match.index;
}

/**
 * Server-side closure verdict contract: non-P1 items confined to FOLLOW_UP do
 * not block PASS when every reconciled finding is FIXED.
 *
 * @param {unknown} report
 * @param {unknown} verdict
 * @returns {string}
 */
export function reconcileClosureReviewVerdict(report, verdict) {
  const text = String(report || '');
  const normalized = String(verdict || '').trim().toUpperCase();
  if (!text || (normalized !== 'PASS' && normalized !== 'FAIL')) {
    return String(verdict || '').trim() || normalized;
  }
  if (/\bSTILL_OPEN\b/i.test(text)) return 'FAIL';
  const followUpStart = readFollowUpSectionStart(text);
  const reconciliation = followUpStart >= 0 ? text.slice(0, followUpStart) : text;
  if (/\bSTILL_OPEN\b/i.test(reconciliation)) return 'FAIL';
  const blockingP1 = /(?:^|\n)\s*(?:F\d+|finding)\b[^\n]*\bSTILL_OPEN\b[^\n]*(?:\(P1\)|\bP1\b)/im.test(reconciliation)
    || /(?:^|\n)\s*(?:F\d+|finding)\b[^\n]*(?:\(P1\)|\bP1\b)[^\n]*\bSTILL_OPEN\b/im.test(reconciliation)
    || /(?:^|\n)\s*(?:NEW|REGRESSION)\b[^\n]*(?:\(P1\)|\bP1\b)/im.test(reconciliation);
  if (blockingP1) return 'FAIL';
  if (normalized === 'FAIL' && followUpStart >= 0) {
    const followUp = text.slice(followUpStart);
    const hasFollowUpNonP1 = /\(P2\)|\(P3\)|non-P1/i.test(followUp);
    const mainHasOpenP1 = /(?:\(P1\)|\bP1\b)/i.test(reconciliation) && /\bSTILL_OPEN\b/i.test(reconciliation);
    if (hasFollowUpNonP1 && !mainHasOpenP1) return 'PASS';
  }
  return normalized;
}

/**
 * Persisted reportVerdict for a delegation row, including closure reconciliation.
 *
 * @param {object | null | undefined} delegation
 * @param {unknown} [rawVerdict] assessDelegationReport().verdict when finishing
 * @returns {string}
 */
export function resolveEffectiveCodeReviewReportVerdict(delegation, rawVerdict = '') {
  const report = String(delegation?.report || '');
  let verdict = String(rawVerdict || delegation?.reportVerdict || '').trim()
    || parseDelegationVerdict(report)
    || '';
  const mode = normalizeDelegationCodeReviewMode(delegation?.reviewMode);
  if (mode === 'closure' && String(delegation?.reviewSubject || '').trim() === 'code') {
    verdict = reconcileClosureReviewVerdict(report, verdict);
  }
  return verdict;
}

/**
 * Effective closure cap after an optional resume (mirrors workflow patch).
 *
 * @param {object | null | undefined} workflow
 * @param {boolean} [resumeRounds]
 * @param {Record<string, string | undefined>} [env] Defaults to the workflow workspace env.
 * @returns {number}
 */
export function readEffectiveMaxCodeReviewClosures(workflow, resumeRounds = false, env = undefined) {
  const maxClosures = readMaxCodeReviewClosures(workflow, env);
  if (!resumeRounds) return maxClosures;
  const { closureCount } = readCodeReviewPhaseCounters(workflow);
  const stop = String(workflow?.stopReason || '').trim();
  if (stop !== DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED && closureCount < maxClosures) {
    return maxClosures;
  }
  return Math.max(maxClosures, closureCount) + CODE_REVIEW_RESUME_CLOSURE_STEP;
}

/**
 * @param {{
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   workflow?: object | null,
 *   workspaceFolder?: unknown,
 * }} input
 * @returns {'' | 'audit' | 'closure'}
 */
export function resolveDelegationCodeReviewMode(input = {}) {
  if (!isDelegationCodeReviewPhaseEnabled(codeReviewEnvFor(input))) return '';
  if (String(input.assignment || '').trim() !== 'review') return '';
  if (String(input.reviewSubject || '').trim() !== 'code') return '';
  if (!String(input.leafId || '').trim()) return '';
  const { auditDone } = readCodeReviewPhaseCounters(input.workflow);
  return auditDone ? 'closure' : 'audit';
}

/**
 * @param {{
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   leafId?: unknown,
 *   workflow?: object | null,
 *   workspaceFolder?: unknown,
 *   resumeRounds?: unknown,
 *   resume_rounds?: unknown,
 * }} input
 * @returns {{ ok: true, mode: '' | 'audit' | 'closure' } | { ok: false, status: number, code: string, error: string, mode: '' | 'audit' | 'closure' }}
 */
export function inspectDelegationCodeReviewStart(input = {}) {
  const mode = resolveDelegationCodeReviewMode(input);
  if (!mode) return { ok: true, mode: '' };
  const resumeRounds = input.resumeRounds === true || input.resume_rounds === true;
  const stop = String(input.workflow?.stopReason || '').trim();
  if (stop === DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED && !resumeRounds) {
    return {
      ok: false,
      status: 409,
      code: 'workflow_stopped',
      error: `Workflow is stopped (${DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED}). Pass resume_rounds on workflow_update to continue.`,
      mode,
    };
  }
  const { closureCount } = readCodeReviewPhaseCounters(input.workflow);
  const maxClosures = readEffectiveMaxCodeReviewClosures(input.workflow, resumeRounds, codeReviewEnvFor(input));
  if (mode === 'closure' && maxClosures >= 0 && closureCount >= maxClosures && !resumeRounds) {
    return {
      ok: false,
      status: 409,
      code: 'closure_rounds_exhausted',
      error: `Code review closure cap reached (${closureCount}/${maxClosures}). Pass resume_rounds on workflow_update to continue.`,
      mode,
    };
  }
  return { ok: true, mode };
}

/**
 * @param {object | null | undefined} delegation
 * @param {object | null | undefined} [workflow]
 * @returns {Record<string, unknown> | null}
 */
export function buildCodeReviewWorkflowPatchOnFinish(delegation, workflow = null) {
  if (!delegation || typeof delegation !== 'object') return null;
  const mode = normalizeDelegationCodeReviewMode(delegation.reviewMode);
  if (!mode) return null;
  if (String(delegation.reviewSubject || '').trim() !== 'code') return null;
  if (!isTerminalDelegationStatus(delegation.status)) return null;
  const leafId = String(delegation.leafId || delegation.leaf_id || '').trim();
  if (!leafId) return null;
  if (!isCredibleCodeReviewTerminal(delegation)) return null;
  const verdict = resolveEffectiveCodeReviewReportVerdict(delegation);
  const reviewerKey = readDelegationExecutorKey(delegation);
  /** @type {Record<string, unknown>} */
  const patch = {
    parentChatId: delegationController(delegation),
    leafId,
    lastReviewer: reviewerKey || undefined,
  };
  const poolRecord = findPoolRoundForDelegation(workflow, delegation.id);
  if (poolRecord) return buildPoolRoundFinishPatch(poolRecord, delegation, workflow, patch, verdict, reviewerKey);
  if (verdict === 'PASS') {
    patch.codeReviewAuditDone = false;
    patch.codeReviewClosureCount = 0;
    patch.codeReviewAuditReviewer = '';
    patch.codeReviewLastClosureRoundKey = '';
    patch.codeReviewClosureEpoch = bumpCodeReviewClosureEpoch(workflow);
    return patch;
  }
  if (mode === 'audit') {
    patch.codeReviewAuditDone = true;
    patch.codeReviewClosureCount = 0;
    patch.codeReviewLastClosureRoundKey = '';
    patch.codeReviewClosureEpoch = bumpCodeReviewClosureEpoch(workflow);
    if (reviewerKey) patch.codeReviewAuditReviewer = reviewerKey;
    return patch;
  }
  const roundKey = buildCodeReviewClosureRoundKey(workflow, delegation);
  const priorRoundKey = String(workflow?.codeReviewLastClosureRoundKey || '').trim();
  if (priorRoundKey && priorRoundKey === roundKey) {
    return null;
  }
  const counters = readCodeReviewPhaseCounters(workflow);
  const nextClosureCount = counters.closureCount + 1;
  patch.codeReviewClosureCount = nextClosureCount;
  patch.codeReviewLastClosureRoundKey = roundKey;
  if (verdict === 'FAIL') {
    const maxClosures = readMaxCodeReviewClosures(
      workflow,
      resolveDelegationEnv(delegation.workspaceFolder || workflow?.workspaceFolder),
    );
    if (nextClosureCount >= maxClosures) {
      patch.stopReason = DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED;
    }
  }
  return patch;
}

/**
 * @param {unknown} acceptanceText
 * @returns {string}
 */
export function buildAuditReviewPromptBlock(acceptanceText) {
  const acceptance = String(acceptanceText || '').trim();
  return [
    '[CODE REVIEW AUDIT]',
    'This is the first code review of this leaf. Perform a full scoped audit against the leaf acceptance criteria below.',
    'Record every in-scope finding with a stable ID (for example F1, F2) and a priority (P1 blocking, P2/P3 non-blocking).',
    'Mark observations outside this leaf scope as OUT_OF_SCOPE; they must not change your VERDICT.',
    'Do not perform a closure-only pass; inspect the implementation and tests needed to judge the leaf criteria.',
    acceptance ? `[LEAF ACCEPTANCE CRITERIA]\n${acceptance}` : '',
    'Tell the orchestrator to create separate todos for any OUT_OF_SCOPE follow-ups instead of fixing them in this leaf.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object | null | undefined} workflow
 * @param {unknown} [extraFindingsText]
 * @returns {string}
 */
export function buildClosureReviewPromptBlock(workflow, extraFindingsText = '') {
  const open = [
    String(workflow?.openFindingsText || workflow?.findingsText || '').trim(),
    String(extraFindingsText || '').trim(),
  ].filter(Boolean).join('\n\n');
  const openBlock = open
    ? ['[OPEN FINDINGS]', open].join('\n')
    : 'No open findings were recorded for this closure pass. Verify only regressions introduced by the fix; do not run a fresh full audit of the whole leaf.';
  return [
    '[CODE REVIEW CLOSURE]',
    'This is a closure review after a fix. Do not run a fresh full audit of the whole leaf.',
    'Work only from the open findings table below: for each prior finding state FIXED or STILL_OPEN with file/test evidence.',
    'Re-check regressions introduced by the fix. New findings block VERDICT: PASS only when they are P1 or a regression caused by the fix.',
    'Other new findings belong in a FOLLOW_UP section and must not change VERDICT when all audit findings are FIXED.',
    'Tell the orchestrator to create separate todos for FOLLOW_UP and OUT_OF_SCOPE items instead of expanding this leaf.',
    openBlock,
  ].join('\n');
}

/**
 * @param {string} auditReviewerKey
 * @returns {{ key: string, harness: string, model: string } | null}
 */
export function parseAuditReviewerStickyKey(auditReviewerKey) {
  const raw = String(auditReviewerKey || '').trim();
  if (!raw || !raw.includes('/')) return null;
  const slash = raw.indexOf('/');
  const harness = raw.slice(0, slash).trim().toLowerCase();
  const model = raw.slice(slash + 1).trim();
  if (!harness || !model) return null;
  return { key: `${harness}/${model}`, harness, model };
}
