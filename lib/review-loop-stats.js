/**
 * Read-only review-loop baseline: rounds to PASS, first-pass rate and finding
 * counts per workspace. Pure over a delegation list and workflow rows; the
 * caller (route/test) supplies the data and the clock. Definitions live in
 * `docs/review-lessons.md`.
 */

import { resolveReviewRounds, listCredibleReviewsForLeaf, indexDelegationsByLeaf } from './review-round-resolution.js';
import { resolveEffectiveCodeReviewReportVerdict } from './delegation-code-review-phase.js';
import { isImplementationWorkDelegationRow } from './delegation-work-role.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_LOOP_STATS_WINDOWS = Object.freeze({ '7d': 7, '30d': 30, '90d': 90 });
const STOP_REASONS = Object.freeze(['same_findings', 'closure_rounds_exhausted']);

/**
 * @param {number} ms
 * @returns {string} Monday 00:00 UTC of the week as YYYY-MM-DD
 */
function utcWeekStartKey(ms) {
  const date = new Date(ms);
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset))
    .toISOString().slice(0, 10);
}

/**
 * @param {Record<string, any>} row
 * @returns {number}
 */
function rowMs(row) {
  const at = Date.parse(String(row?.finishedAt || row?.updatedAt || row?.createdAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
function executorKey(row) {
  const transport = String(row?.executor?.transport || row?.harness || '').trim().toLowerCase();
  const model = String(row?.executor?.model || row?.model || '').trim();
  return transport && model ? `${transport}/${model}` : (model || transport || 'unknown');
}

/**
 * @param {number[]} values
 * @returns {{ mean: number | null, median: number | null, max: number | null }}
 */
function summarize(values) {
  if (!values.length) return { mean: null, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
  return { mean, median, max: sorted[sorted.length - 1] };
}

/**
 * @param {number} n
 * @param {number} d
 * @returns {number | null}
 */
function ratio(n, d) {
  return d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null;
}

/**
 * Finding ids (F1, F2) and priorities (P1/P2/P3) mentioned in a review report.
 *
 * @param {unknown} report
 * @returns {{ total: number, P1: number, P2: number, P3: number }}
 */
export function countReviewFindings(report) {
  const text = String(report || '');
  const ids = new Set((text.match(/\bF\d+\b/g) || []).map((id) => id.toUpperCase()));
  const count = (re) => (text.match(re) || []).length;
  return {
    total: ids.size,
    P1: count(/\bP1\b/g),
    P2: count(/\bP2\b/g),
    P3: count(/\bP3\b/g),
  };
}

/**
 * Plan rounds of one todo: one round per plan revision key; PASS when every
 * credible reviewer of that revision PASSed.
 *
 * @param {Record<string, any>[]} planReviews credible plan reviews, oldest first
 * @returns {{ rounds: number, passed: boolean, revisions: number }}
 */
function planRounds(planReviews) {
  /** @type {Map<string, string[]>} */
  const byRevision = new Map();
  for (const row of planReviews) {
    const key = String(row.todoPlanRevisionKey || '').trim() || '(unversioned)';
    const verdicts = byRevision.get(key) || [];
    verdicts.push(String(resolveEffectiveCodeReviewReportVerdict(row)).toUpperCase());
    byRevision.set(key, verdicts);
  }
  let index = 0;
  for (const verdicts of byRevision.values()) {
    index += 1;
    if (verdicts.length && verdicts.every((v) => v === 'PASS')) {
      return { rounds: index, passed: true, revisions: byRevision.size };
    }
  }
  return { rounds: byRevision.size, passed: false, revisions: byRevision.size };
}

/**
 * @param {string} workspaceFolder
 * @param {Record<string, any>[]} rows delegations of that workspace
 * @param {Map<string, Record<string, any>>} workflowsByLeaf
 * @param {number} sinceMs
 * @param {Map<string, Record<string, any>[]>} rowsByLeaf rows grouped by lower-cased leaf id
 * @returns {Record<string, any>}
 */
function buildWindow(workspaceFolder, rows, workflowsByLeaf, sinceMs, rowsByLeaf) {
  const leafIds = new Set();
  for (const [leaf, leafRows] of rowsByLeaf) {
    if (leafRows.some((row) => String(row.assignment) === 'review')) leafIds.add(leaf);
  }
  const code = { leaves: 0, passed: 0, firstPass: 0, rounds: /** @type {number[]} */ ([]) };
  const plan = { todos: 0, passed: 0, firstPass: 0, rounds: /** @type {number[]} */ ([]) };
  const findings = { reviews: 0, withFindings: 0, total: 0, P1: 0, P2: 0, P3: 0 };
  /** @type {Record<string, number>} */
  const stopReasons = Object.fromEntries(STOP_REASONS.map((r) => [r, 0]));
  /** @type {Record<string, {leaves: number, rounds: number, passed: number}>} */
  const byImplementerModel = {};
  /** @type {Record<string, {reviews: number, findings: number}>} */
  const byReviewerModel = {};
  /** @type {Record<string, {leaves: number, rounds: number}>} */
  const weekly = {};
  for (const leafId of leafIds) {
    const leafRows = rowsByLeaf.get(leafId) || [];
    const reviews = listCredibleReviewsForLeaf(leafRows, leafId);
    if (!reviews.length || rowMs(reviews[reviews.length - 1]) < sinceMs) continue;
    const codeReviews = reviews.filter((row) => row.reviewSubject === 'code');
    const planReviews = reviews.filter((row) => row.reviewSubject === 'plan');
    const workflow = workflowsByLeaf.get(leafId) || null;
    if (codeReviews.length) {
      code.leaves += 1;
      const { rounds } = resolveReviewRounds({ delegations: rows, leafDelegations: leafRows, leafId, workflow });
      const passIndex = rounds.findIndex((round) => round.verdict === 'PASS');
      const implementer = leafRows
        .filter((row) => isImplementationWorkDelegationRow(row))
        .sort((a, b) => rowMs(a) - rowMs(b)).pop();
      const model = implementer ? executorKey(implementer) : String(workflow?.lastImplementer || 'unknown') || 'unknown';
      const slot = byImplementerModel[model] || { leaves: 0, rounds: 0, passed: 0 };
      slot.leaves += 1;
      if (passIndex >= 0) {
        code.passed += 1;
        code.rounds.push(passIndex + 1);
        if (passIndex === 0) code.firstPass += 1;
        slot.rounds += passIndex + 1;
        slot.passed += 1;
        const week = weekly[utcWeekStartKey(Date.parse(rounds[passIndex].resolvedAt) || rowMs(codeReviews[codeReviews.length - 1]))]
          || { leaves: 0, rounds: 0 };
        week.leaves += 1;
        week.rounds += passIndex + 1;
        weekly[utcWeekStartKey(Date.parse(rounds[passIndex].resolvedAt) || rowMs(codeReviews[codeReviews.length - 1]))] = week;
      }
      byImplementerModel[model] = slot;
    }
    if (planReviews.length) {
      plan.todos += 1;
      const result = planRounds(planReviews);
      if (result.passed) {
        plan.passed += 1;
        plan.rounds.push(result.rounds);
        if (result.rounds === 1) plan.firstPass += 1;
      }
    }
    for (const row of reviews) {
      const counts = countReviewFindings(row.report);
      findings.reviews += 1;
      if (counts.total > 0) findings.withFindings += 1;
      findings.total += counts.total;
      findings.P1 += counts.P1;
      findings.P2 += counts.P2;
      findings.P3 += counts.P3;
      const key = executorKey(row);
      const slot = byReviewerModel[key] || { reviews: 0, findings: 0 };
      slot.reviews += 1;
      slot.findings += counts.total;
      byReviewerModel[key] = slot;
    }
    const reason = String(workflow?.stopReason || '').trim();
    if (STOP_REASONS.includes(reason)) stopReasons[reason] += 1;
  }
  return {
    since: new Date(sinceMs).toISOString(),
    workspaceFolder,
    codeReview: {
      leaves: code.leaves,
      leavesPassed: code.passed,
      firstPassLeaves: code.firstPass,
      firstPassRate: ratio(code.firstPass, code.passed),
      roundsToPass: summarize(code.rounds),
    },
    planReview: {
      todos: plan.todos,
      todosPassed: plan.passed,
      firstPassTodos: plan.firstPass,
      firstPassRate: ratio(plan.firstPass, plan.passed),
      roundsToPass: summarize(plan.rounds),
    },
    findings: {
      ...findings,
      perReview: findings.reviews ? Math.round((findings.total / findings.reviews) * 100) / 100 : null,
    },
    stopReasons,
    byImplementerModel,
    byReviewerModel,
    weekly: Object.entries(weekly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekStart, value]) => ({ weekStart, ...value })),
  };
}

/**
 * @param {{
 *   delegations?: any[], workflows?: any[], now?: number,
 *   workspaceFolder?: string,
 * }} [input]
 * @returns {{ generatedAt: string, windows: string[], workspaces: Record<string, any>[] }}
 */
export function buildReviewLoopStats(input = {}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const workflows = Array.isArray(input.workflows) ? input.workflows : [];
  const only = String(input.workspaceFolder || '').trim();
  /** @type {Map<string, Record<string, any>[]>} */
  const byWorkspace = new Map();
  for (const row of delegations) {
    if (!row || typeof row !== 'object') continue;
    const folder = String(row.workspaceFolder || '').trim();
    if (!folder || (only && folder !== only)) continue;
    const list = byWorkspace.get(folder) || [];
    list.push(row);
    byWorkspace.set(folder, list);
  }
  const workspaces = [...byWorkspace.entries()].map(([workspaceFolder, rows]) => {
    /** @type {Map<string, Record<string, any>>} */
    const workflowsByLeaf = new Map();
    for (const wf of workflows) {
      const leaf = String(wf?.leafId || '').trim().toLowerCase();
      if (leaf && String(wf.workspaceFolder || '').trim() === workspaceFolder) workflowsByLeaf.set(leaf, wf);
    }
    const rowsByLeaf = indexDelegationsByLeaf(rows);
    const windows = {};
    for (const [name, days] of Object.entries(REVIEW_LOOP_STATS_WINDOWS)) {
      windows[name] = buildWindow(workspaceFolder, rows, workflowsByLeaf, now - days * DAY_MS, rowsByLeaf);
    }
    return { workspaceFolder, windows };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    windows: Object.keys(REVIEW_LOOP_STATS_WINDOWS),
    workspaces,
  };
}
