/**
 * Pure read-model: one row per delegation leaf (todo/chat cohort) with rounds,
 * roles, verdicts, verify, workflow stop state, and wall/cost aggregates.
 */

import { parseDelegationVerdict } from './delegation-verdict.js';
import {
  buildDelegationQualityCycles,
  sumCycleCohortUsage,
  unionWallMs,
} from './delegation-cycle-outcomes.js';
import { delegationCycleRole } from './delegation-cycle-classify.js';
import {
  loadDelegationWorkflows,
  normalizeDelegationWorkflowRow,
} from './persist/delegation-workflows-persist.js';

const LOOP_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix']);

/**
 * @param {object} row
 * @returns {{ harness: string, model: string }}
 */
function readExecutor(row) {
  return {
    harness: String(row?.executor?.transport || '').trim().toLowerCase(),
    model: String(row?.executor?.model || '').trim(),
  };
}

/**
 * @param {string} parentChatId
 * @param {string} leafId
 * @returns {string}
 */
function cohortKey(parentChatId, leafId) {
  return `${String(parentChatId || '').trim()}\0${String(leafId || '').trim()}`;
}

/**
 * @param {object | null | undefined} leaf
 * @returns {string}
 */
export function formatDelegationLoopSummaryLine(leaf) {
  if (!leaf || typeof leaf !== 'object') return '';
  const verify = leaf.verify?.passed === true
    ? 'passed'
    : (leaf.verify?.required === true ? 'required' : 'none');
  const wallMin = Number.isFinite(Number(leaf.cost?.wallTimeMs))
    ? (Number(leaf.cost.wallTimeMs) / 60000).toFixed(1)
    : '-';
  const costUsd = leaf.cost?.costKnown === true && leaf.cost?.costUsd != null
    ? Number(leaf.cost.costUsd)
    : '-';
  const verdicts = Array.isArray(leaf.verdicts) ? leaf.verdicts.join(',') : '';
  const leafLabel = String(leaf.leafId || '').trim() || 'chat';
  return `loop leaf=${leafLabel} rounds=${leaf.rounds ?? 0} jobs=${leaf.jobsTotal ?? 0} verdicts=${verdicts} verify=${verify} stop=${leaf.stopReason || '-'} wall=${wallMin}min cost_usd=${costUsd}`;
}

/**
 * @param {{
 *   rows?: object[],
 *   cycles?: object[],
 *   workflows?: object[],
 *   leafId?: string,
 *   parentChatId?: string,
 *   now?: number,
 *   readUsageEvents?: Function,
 * }} [input]
 * @returns {object[]}
 */
export function buildDelegationLoopReport(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafIdFilter = String(input.leafId || '').trim();
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  let rows = Array.isArray(input.rows) ? input.rows : [];
  rows = rows.filter((row) => !parentChatId || String(row?.parentChatId || '').trim() === parentChatId);
  rows = rows.filter((row) => !leafIdFilter || String(row?.leafId || '').trim() === leafIdFilter);
  const cycles = Array.isArray(input.cycles)
    ? input.cycles.filter((cycle) => !leafIdFilter || String(cycle?.leafId || '').trim() === leafIdFilter)
    : buildDelegationQualityCycles({
      rows,
      includeOpen: true,
      parentChatId,
      leafId: leafIdFilter,
    });
  const workflows = Array.isArray(input.workflows)
    ? input.workflows
    : loadDelegationWorkflows();
  /** @type {Map<string, object>} */
  const workflowByKey = new Map();
  for (const entry of workflows) {
    const norm = normalizeDelegationWorkflowRow(entry);
    if (parentChatId && norm.parentChatId !== parentChatId) continue;
    workflowByKey.set(cohortKey(norm.parentChatId, norm.leafId), norm);
  }
  /** @type {Map<string, object[]>} */
  const byLeaf = new Map();
  for (const row of rows) {
    const key = cohortKey(String(row?.parentChatId || '').trim(), String(row?.leafId || '').trim());
    if (!byLeaf.has(key)) byLeaf.set(key, []);
    byLeaf.get(key).push(row);
  }
  /** @type {object[]} */
  const leaves = [];
  for (const [, leafRows] of byLeaf) {
    const sorted = [...leafRows].sort(
      (left, right) => Date.parse(String(left?.createdAt || '')) - Date.parse(String(right?.createdAt || '')),
    );
    const parentId = String(sorted[0]?.parentChatId || '').trim();
    const leafId = String(sorted[0]?.leafId || '').trim();
    const workflowId = `${parentId}:${leafId || 'chat'}`;
    const leafCycles = cycles.filter(
      (cycle) => String(cycle.parentChatId || '').trim() === parentId
        && String(cycle.leafId || '').trim() === leafId,
    );
    const rounds = leafCycles.length;
    /** @type {Record<string, object[]>} */
    const roles = { plan: [], implement: [], review: [], fix: [] };
    /** @type {string[]} */
    const verdicts = [];
    for (const row of sorted) {
      const role = delegationCycleRole(row);
      if (!LOOP_ROLES.includes(role)) continue;
      const verdict = parseDelegationVerdict(String(row?.report || '')) || 'unspecified';
      verdicts.push(verdict);
      const executor = readExecutor(row);
      roles[role].push({
        model: executor.model,
        harness: executor.harness,
        verdict,
        status: String(row?.status || '').trim(),
        finishedAt: String(row?.finishedAt || row?.lastTransitionAt || '').trim(),
        delegationId: String(row?.id || '').trim(),
      });
    }
    const reviewRows = sorted.filter((row) => delegationCycleRole(row) === 'review');
    const verifyRequiredOf = (row) => row?.verifyRequired === true
      || (row?.verifyRequired === undefined && row?.reviewCanRunTests === false);
    const verifyRequired = reviewRows.some((row) => verifyRequiredOf(row));
    const verifyRecorded = reviewRows.some((row) => row?.verifyResult != null);
    const verifyPassed = reviewRows.length === 0
      ? false
      : !reviewRows.some((row) => {
        const status = String(row?.verifyResult?.status || '').trim().toLowerCase();
        if (status) return status !== 'passed';
        return verifyRequiredOf(row);
      });
    const verifyIds = reviewRows
      .filter((row) => row?.verifyRequired === true || row?.verifyResult != null)
      .map((row) => String(row?.id || '').trim())
      .filter(Boolean);
    const wf = workflowByKey.get(cohortKey(parentId, leafId)) || null;
    const lastActivityAt = sorted.reduce((max, row) => {
      const at = Date.parse(String(row?.finishedAt || row?.createdAt || ''));
      return Number.isFinite(at) && at > max ? at : max;
    }, 0);
    const wallTimeMs = unionWallMs(sorted);
    const usage = sumCycleCohortUsage(leafCycles, {
      now,
      readUsageEvents: input.readUsageEvents,
    });
    const costKnown = usage.totalCostUsd != null;
    const latestCycle = leafCycles.length > 0 ? leafCycles[leafCycles.length - 1] : null;
    leaves.push({
      leafId,
      parentChatId: parentId,
      workflowId,
      rounds,
      jobsTotal: sorted.length,
      roles,
      verdicts,
      verify: {
        required: verifyRequired,
        recorded: verifyRecorded,
        passed: verifyPassed,
        ids: verifyIds,
      },
      stopReason: String(wf?.stopReason || '').trim(),
      round: wf?.round ?? 0,
      maxRounds: wf?.maxRounds ?? 4,
      deadlineAt: String(wf?.deadlineAt || '').trim(),
      consecutiveSameFail: wf?.consecutiveSameFail ?? 0,
      materialRevision: String(wf?.materialRevision || '').trim(),
      cost: {
        wallTimeMs,
        costUsd: usage.totalCostUsd,
        costKnown,
        pricedEventShare: usage.pricedEventShare,
      },
      qualityOutcome: String(latestCycle?.qualityOutcome || 'undecided'),
      accepted: latestCycle?.acceptedByReview === true,
      manualAccepted: leafCycles.some((cycle) => cycle.manualAccepted === true),
      stopped: Boolean(String(wf?.stopReason || '').trim()),
      highRounds: rounds >= 4,
      lastActivityAt,
    });
  }
  leaves.sort((left, right) => {
    const diff = (Number(right.lastActivityAt) || 0) - (Number(left.lastActivityAt) || 0);
    if (diff !== 0) return diff;
    return String(left.leafId || '').localeCompare(String(right.leafId || ''));
  });
  return leaves.map(({ lastActivityAt: _drop, ...rest }) => rest);
}
