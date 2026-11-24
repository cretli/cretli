/**
 * Usage capture coverage per harness x role (pure read model).
 *
 * Unit = one terminal delegation attempt (or one watcher cycle for the
 * orchestrator). A run belongs to an attempt when its event carries the same
 * delegationId + attemptId; an attempt has 0..N runs (e.g. a resume). The model
 * reads the already corrected, persisted completeness of each run
 * (`applyUsageCoverageCorrection` runs at write time, docs/usage-contract.md
 * section 5): it never corrects coverage itself and never adds a run, so a late
 * measurement inside the 24 h window is visible and one after it stays stale.
 */

import { USAGE_FINAL_USAGE_GRACE_MS, USAGE_HARNESS_MATRIX, resolveUsageContract } from './usage-contract.js';
import { delegationWorkRole } from './usage-role.ts';
import { listDelegationAttempts } from '../delegation-attempt.js';
import { USAGE_LIFECYCLE_OUTCOMES, classifyAttemptLifecycleOutcome, classifyCycleLifecycleOutcome } from './usage-lifecycle-outcome.ts';

export const USAGE_COVERAGE_TARGET = 0.8;
export const USAGE_COVERAGE_MIN_SAMPLE = 20;
export const USAGE_COVERAGE_ROLES = Object.freeze(['plan', 'implement', 'review', 'fix', 'orchestrator']);
export const USAGE_COVERAGE_QUALITIES = Object.freeze(['ok', 'low_coverage', 'insufficient_sample', 'no_traffic', 'unsupported']);

const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed', 'interrupted']);
const MEASURED = new Set(['complete', 'partial']);
const RANK = { unsupported: 0, missing: 1, partial: 2, complete: 3 };

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {Record<string, any>[]} events
 * @returns {Map<string, { runs: Map<string, Record<string, any>>, output: boolean }>}
 */
function indexEventsByAttempt(events) {
  const byAttempt = new Map();
  for (const e of events) {
    const delegationId = text(e?.delegationId);
    const attemptId = text(e?.attemptId);
    if (!delegationId || !attemptId) continue;
    const key = `${delegationId}|${attemptId}`;
    const entry = byAttempt.get(key) || { runs: new Map(), output: false };
    byAttempt.set(key, entry);
    if (e.eventType !== 'run') {
      entry.output = true;
      continue;
    }
    // A replayed logical event is one run; keep the best (corrected) state.
    const runKey = text(e.runId) || text(e.logicalEventKey) || `${text(e.at)}|${entry.runs.size}`;
    const prev = entry.runs.get(runKey);
    if (!prev || (RANK[text(e.completeness)] ?? 0) > (RANK[text(prev.completeness)] ?? 0)) entry.runs.set(runKey, e);
  }
  return byAttempt;
}

/**
 * @param {{ runs: Map<string, Record<string, any>>, output: boolean } | undefined} entry
 * @returns {{ runCount: number, anyMeasured: boolean, allMeasured: boolean, reason: string }}
 */
function classifyRuns(entry) {
  const runs = entry ? [...entry.runs.values()] : [];
  const unmeasured = runs.filter((r) => !MEASURED.has(text(r.completeness)));
  const reason = unmeasured.length > 0
    ? text(unmeasured[0].usageMissingReason) || 'run_missing'
    : (runs.length === 0 && entry?.output ? 'no_run_event' : '');
  return {
    runCount: runs.length,
    anyMeasured: runs.length > unmeasured.length,
    allMeasured: runs.length > 0 && unmeasured.length === 0,
    reason,
  };
}

/**
 * @param {{
 *   events?: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 *   cycles?: { cycleId: string, harness: string, finishedAt: string }[],
 *   fromMs?: number, toMs?: number, now?: number,
 * }} input
 * @returns {{ target: number, minSample: number, graceMs: number, rows: Record<string, any>[] }}
 */
export function buildUsageCoverage(input: Partial<{ events: Record<string, any>[], delegations: Record<string, any>[], cycles: { cycleId: string, harness: string, finishedAt: string, closeOutcome?: string, closeSource?: string }[], fromMs: number, toMs: number, now: number }> = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const fromMs = Number.isFinite(input.fromMs) ? input.fromMs : -Infinity;
  const toMs = Number.isFinite(input.toMs) ? input.toMs : Infinity;
  const events = Array.isArray(input.events) ? input.events : [];
  const byAttempt = indexEventsByAttempt(events);

  /** @type {{ harness: string, role: string, endMs: number, entry: any, outcome: string }[]} */
  const units = [];
  for (const row of Array.isArray(input.delegations) ? input.delegations : []) {
    const role = delegationWorkRole(row);
    const id = text(row?.id);
    if (!id || !role) continue;
    const attemptList = listDelegationAttempts(row);
    for (const [index, attempt] of attemptList.entries()) {
      if (!TERMINAL_STATUSES.has(text(attempt.status))) continue;
      const endMs = Date.parse(text(attempt.finishedAt));
      if (!Number.isFinite(endMs) || endMs < fromMs || endMs > toMs) continue;
      const harness = text(attempt.transport || row?.executor?.transport || row?.harness).toLowerCase();
      if (!harness) continue;
      units.push({ harness, role, endMs, entry: byAttempt.get(`${id}|${text(attempt.attemptId)}`), outcome: classifyAttemptLifecycleOutcome(attempt, { hasSuccessor: index < attemptList.length - 1 }) });
    }
  }
  // Orchestrator: one unit per watcher cycle; its runs are the cycle's events without a delegation.
  const cycleRuns = new Map();
  for (const e of events) {
    if (text(e?.delegationId) || !text(e?.cycleId)) continue;
    const entry = cycleRuns.get(text(e.cycleId)) || { runs: new Map(), output: false };
    cycleRuns.set(text(e.cycleId), entry);
    if (e.eventType !== 'run') { entry.output = true; continue; }
    const runKey = text(e.runId) || text(e.logicalEventKey) || `${text(e.at)}|${entry.runs.size}`;
    const prev = entry.runs.get(runKey);
    if (!prev || (RANK[text(e.completeness)] ?? 0) > (RANK[text(prev.completeness)] ?? 0)) entry.runs.set(runKey, e);
  }
  for (const cycle of Array.isArray(input.cycles) ? input.cycles : []) {
    const endMs = Date.parse(text(cycle?.finishedAt));
    const harness = text(cycle?.harness).toLowerCase();
    if (!text(cycle?.cycleId) || !harness || !Number.isFinite(endMs) || endMs < fromMs || endMs > toMs) continue;
    units.push({ harness, role: 'orchestrator', endMs, entry: cycleRuns.get(text(cycle.cycleId)), outcome: classifyCycleLifecycleOutcome(cycle) });
  }

  const rows = new Map();
  const rowFor = (harness, role) => {
    const key = `${harness}|${role}`;
    let row = rows.get(key);
    if (!row) {
      row = { harness, role, supported: resolveUsageContract(harness).supported === true, attempts: 0, byOutcome: Object.fromEntries(USAGE_LIFECYCLE_OUTCOMES.map((k) => [k, 0])), unclassified: 0, withRunEvent: 0, noOutput: 0, pending: 0, eligible: 0, measured: 0, coverage: null, missingReasons: {}, quality: 'no_traffic' };
      rows.set(key, row);
    }
    return row;
  };
  for (const harness of Object.keys(USAGE_HARNESS_MATRIX)) {
    if (resolveUsageContract(harness).supported !== true) continue;
    for (const role of USAGE_COVERAGE_ROLES) rowFor(harness, role);
  }
  for (const unit of units) {
    const row = rowFor(unit.harness, unit.role);
    row.attempts += 1;
    if (unit.outcome) row.byOutcome[unit.outcome] += 1;
    else row.unclassified += 1;
    if (!row.supported) continue;
    const c = classifyRuns(unit.entry);
    if (c.runCount > 0) row.withRunEvent += 1;
    if (c.runCount === 0 && !unit.entry?.output) { row.noOutput += 1; continue; }
    if (!c.anyMeasured && now - unit.endMs < USAGE_FINAL_USAGE_GRACE_MS) { row.pending += 1; continue; }
    row.eligible += 1;
    if (c.allMeasured) row.measured += 1;
    else row.missingReasons[c.reason || 'run_missing'] = (row.missingReasons[c.reason || 'run_missing'] || 0) + 1;
  }
  const out = [...rows.values()].map((row) => {
    row.coverage = row.eligible > 0 ? Number((row.measured / row.eligible).toFixed(4)) : null;
    row.quality = !row.supported
      ? 'unsupported'
      : row.attempts === 0
        ? 'no_traffic'
        : row.eligible < USAGE_COVERAGE_MIN_SAMPLE
          ? 'insufficient_sample'
          : row.coverage >= USAGE_COVERAGE_TARGET ? 'ok' : 'low_coverage';
    return row;
  }).sort((a, b) => a.harness.localeCompare(b.harness) || USAGE_COVERAGE_ROLES.indexOf(a.role) - USAGE_COVERAGE_ROLES.indexOf(b.role));
  return {
    target: USAGE_COVERAGE_TARGET,
    minSample: USAGE_COVERAGE_MIN_SAMPLE,
    graceMs: USAGE_FINAL_USAGE_GRACE_MS,
    rows: out,
    hostVerify: buildHostVerifyUsage(input.delegations, fromMs, toMs),
  };
}

/**
 * Host review-verify cost: wall/step time per harness x role x source, read from
 * each delegation's bounded `verifyRuns[]` (one entry per execution id, so a
 * replay is never counted twice and a rerun always is). Host time only: no
 * tokens or USD, and nothing is added to the usage ledger or its totals.
 *
 * @param {Record<string, any>[] | undefined} delegations
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {{ note: string, tokens: null, usd: null, rows: Record<string, any>[] }}
 */
export function buildHostVerifyUsage(delegations, fromMs = -Infinity, toMs = Infinity) {
  const groups = new Map();
  for (const row of Array.isArray(delegations) ? delegations : []) {
    const role = delegationWorkRole(row);
    const harness = text(row?.executor?.transport || row?.harness).toLowerCase();
    if (!role || !harness) continue;
    const seen = new Set();
    for (const run of Array.isArray(row.verifyRuns) ? row.verifyRuns : []) {
      const executionId = text(run?.executionId);
      const at = Date.parse(text(run?.recordedAt));
      if (!executionId || seen.has(executionId) || !Number.isFinite(at) || at < fromMs || at > toMs) continue;
      seen.add(executionId);
      const source = text(run.source) || 'unknown';
      const key = `${harness}|${role}|${source}`;
      const g = groups.get(key) || { harness, role, source, runs: 0, passed: 0, failed: 0, stale: 0, wallMs: 0, stepMs: 0, cachedSteps: 0, queueWaitMs: 0 };
      groups.set(key, g);
      g.runs += 1;
      if (run.stale === true) g.stale += 1;
      else if (run.outcome === 'passed') g.passed += 1;
      else g.failed += 1;
      g.wallMs += Number(run.timing?.durationMs) || 0;
      g.stepMs += Number(run.timing?.sumStepMs) || 0;
      g.cachedSteps += Number(run.timing?.cached) || 0;
      g.queueWaitMs += Number(run.queueWaitMs) || 0;
    }
  }
  return { note: 'host_time_only', tokens: null, usd: null, rows: [...groups.values()].sort((a, b) => `${a.harness}|${a.role}|${a.source}`.localeCompare(`${b.harness}|${b.role}|${b.source}`)) };
}
