/**
 * Pure usage insights: disjoint token buckets, honest coverage, executed
 * automatic choices, cost provenance and cohort shares.
 *
 * No I/O and no DOM. Every derived number either carries its denominator or is
 * `null`; a missing measurement is never rendered as a measured zero. The
 * module deliberately separates:
 * - usage *events* (measurements) from *requests*,
 * - delegation *runs* from model *picks*,
 * - `own` from `consolidated` accounting scope,
 * - technical success, review verdict, accepted-by-review and manualAccept.
 */

import {
  USAGE_CONTRACT_REVISION,
  USAGE_NORMALIZATION_VERSION,
  USAGE_SCHEMA_VERSION,
  PROVIDER_HARNESS_FALLBACK,
  additiveTokenTotal,
  hasTokenMeasurement,
  partitionUsageTokens,
  resolveAccountingScope,
} from './usage-contract.js';
import { addZoneDays, formatZoneDay, zoneDayStartMs, zoneMonthStartMs } from './usage-window.js';

/** Version block every insights payload carries (scope/coverage/version). */
export const USAGE_INSIGHTS_VERSION = Object.freeze({
  schemaVersion: USAGE_SCHEMA_VERSION,
  normalizationVersion: USAGE_NORMALIZATION_VERSION,
  contractRevision: USAGE_CONTRACT_REVISION,
});

/** Token buckets that are additive; reasoning is separate and may be diagnostic. */
export const DISJOINT_TOKEN_KEYS = Object.freeze([
  'inputWithoutCache',
  'cacheRead',
  'cacheWrite',
  'outputWithoutReasoning',
  'reasoning',
  'audioInput',
  'audioOutput',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function harnessOf(event) {
  const explicit = text(event?.harness).toLowerCase();
  if (explicit) return explicit;
  const provider = text(event?.provider).toLowerCase();
  return PROVIDER_HARNESS_FALLBACK[provider] || 'other';
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function msOf(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Every delegation row counts as an executed start; a proposal that never
 * started is reported separately as `proposals` and can never inflate
 * `executed`. Filters are applied here so the counters and the per-model rows
 * always see the same cohort.
 *
 * @param {object} row
 * @param {{ role?: string, origin?: string, workspace?: string, fromMs?: number, toMs?: number }} [filters]
 * @returns {boolean}
 */
export function delegationRowMatchesFilters(row, filters = {}) {
  if (!row || typeof row !== 'object') return false;
  const role = text(filters.role).toLowerCase();
  if (role && text(row.pickRole || row.assignment || row.role).toLowerCase() !== role) return false;
  const origin = text(filters.origin).toLowerCase();
  if (origin && text(row.pickOrigin).toLowerCase() !== origin) return false;
  const workspace = text(filters.workspace);
  if (workspace) {
    const rowWorkspace = text(row.workspaceFolder || row.workspace);
    if (rowWorkspace !== workspace) return false;
  }
  if (Number.isFinite(Number(filters.fromMs)) || Number.isFinite(Number(filters.toMs))) {
    const at = msOf(row.createdAt || row.startedAt);
    if (!Number.isFinite(at)) return false;
    if (Number.isFinite(Number(filters.fromMs)) && at < Number(filters.fromMs)) return false;
    if (Number.isFinite(Number(filters.toMs)) && at >= Number(filters.toMs)) return false;
  }
  return true;
}

/**
 * @param {object} event
 * @param {{ role?: string, harness?: string, workspaceFile?: string, scope?: string, chatId?: string, subject?: string }} [filters]
 * @returns {boolean}
 */
export function usageEventMatchesFilters(event, filters = {}) {
  if (!event || typeof event !== 'object') return false;
  const role = text(filters.role).toLowerCase();
  if (role && text(event.role).toLowerCase() !== role) return false;
  const harness = text(filters.harness).toLowerCase();
  if (harness && harnessOf(event) !== harness) return false;
  const workspace = text(filters.workspaceFile);
  if (workspace && text(event.workspaceFile) !== workspace) return false;
  const scope = text(filters.scope).toLowerCase();
  if (scope && resolveAccountingScope(event) !== scope) return false;
  const chatId = text(filters.chatId);
  if (chatId && text(event.chatId) !== chatId) return false;
  const subject = text(filters.subject).toLowerCase();
  if (subject && usageEventSubject(event) !== subject) return false;
  return true;
}

/**
 * Classify what a usage event belongs to. This is a display taxonomy, not a
 * replacement for run identity: usage events are measurements, never requests.
 *
 * @param {object} event
 * @returns {'chat'|'delegation'|'internal'}
 */
export function usageEventSubject(event) {
  if (text(event?.delegationId)) return 'delegation';
  if (resolveAccountingScope(event) === 'consolidated' || text(event?.cycleId)) return 'internal';
  return 'chat';
}

/**
 * @param {object[]} events
 * @param {object} [filters]
 * @returns {object[]}
 */
export function filterUsageEvents(events, filters = {}) {
  return (Array.isArray(events) ? events : []).filter((event) => usageEventMatchesFilters(event, filters));
}

/**
 * Aggregate the disjoint token buckets. Cache read/write and reasoning are
 * never folded back into input/output.
 *
 * @param {object[]} events
 * @returns {object}
 */
export function sumUsageTokenBuckets(events) {
  const totals = {
    inputWithoutCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    outputWithoutReasoning: 0,
    reasoning: 0,
    audioInput: 0,
    audioOutput: 0,
  };
  let reasoningDiagnostic = 0;
  let measurementEvents = 0;
  let eventsWithCache = 0;
  let eventsWithReasoning = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.eventType === 'run') continue;
    const buckets = partitionUsageTokens(event.tokens || {}, harnessOf(event));
    totals.inputWithoutCache += buckets.inputWithoutCache;
    totals.cacheRead += buckets.cacheRead;
    totals.cacheWrite += buckets.cacheWrite;
    totals.outputWithoutReasoning += buckets.outputWithoutReasoning;
    totals.audioInput += buckets.audioInput;
    totals.audioOutput += buckets.audioOutput;
    if (buckets.reasoningDiagnostic) reasoningDiagnostic += buckets.reasoning;
    else totals.reasoning += buckets.reasoning;
    if (buckets.cacheRead > 0 || buckets.cacheWrite > 0) eventsWithCache += 1;
    if (buckets.reasoning > 0) eventsWithReasoning += 1;
    if (hasTokenMeasurement(event.tokens)) measurementEvents += 1;
  }
  const totalTokens = additiveTokenTotal({ ...totals, reasoningDiagnostic: false });
  const cacheTokens = totals.cacheRead + totals.cacheWrite;
  return {
    ...totals,
    // Reasoning whose relation to output is unknown is already inside output:
    // it stays a separate diagnostic subcounter and is not added again.
    reasoningDiagnosticTokens: reasoningDiagnostic,
    totalTokens,
    cacheTokens,
    cacheShare: totalTokens > 0 ? Number((cacheTokens / totalTokens).toFixed(6)) : null,
    events: Array.isArray(events) ? events.length : 0,
    measurementEvents,
    eventsWithCache,
    eventsWithReasoning,
  };
}

/**
 * Cost provenance split. `partial` is true whenever an unpriced event or an
 * estimated amount is present, so a caller can refuse to present the total as a
 * fully comparable price.
 *
 * @param {object[]} events
 * @returns {object}
 */
export function sumUsageCost(events) {
  let actualUsd = 0;
  let estimatedUsd = 0;
  let pricedEvents = 0;
  let estimatedEvents = 0;
  let subscriptionEvents = 0;
  let unpricedEvents = 0;
  let actualReportedEvents = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.eventType === 'run') continue;
    const usd = finiteOrNull(event.usd);
    const subscription = event.billingMode === 'subscription';
    if (subscription) subscriptionEvents += 1;
    if (usd == null) {
      unpricedEvents += 1;
      continue;
    }
    pricedEvents += 1;
    if (event.estimated === true) {
      estimatedUsd += usd;
      estimatedEvents += 1;
    } else {
      actualUsd += usd;
      if (event.provenance === 'reported' || event.reportedUsd != null) actualReportedEvents += 1;
    }
  }
  const round = (value) => Number(value.toFixed(6));
  return {
    actualUsd: round(actualUsd),
    estimatedUsd: round(estimatedUsd),
    pricedEvents,
    estimatedEvents,
    actualReportedEvents,
    subscriptionEvents,
    unpricedEvents,
    totalEvents: Array.isArray(events) ? events.length : 0,
    partial: unpricedEvents > 0 || estimatedEvents > 0,
  };
}

/**
 * Identity keys that let a usage event be correlated to its run. Only durable
 * run/attempt ids are used; a source session alone is a weak fallback that is
 * used only when the run has no runId.
 *
 * @param {object} run
 * @returns {string[]}
 */
function runIdentityKeys(run) {
  const keys = [];
  if (text(run?.runId)) keys.push(`run:${text(run.runId)}`);
  if (text(run?.attemptId)) keys.push(`attempt:${text(run.attemptId)}`);
  if (keys.length === 0 && text(run?.sourceSessionId)) keys.push(`session:${text(run.sourceSessionId)}`);
  return keys;
}

/**
 * @param {object} event
 * @returns {string[]}
 */
function eventIdentityKeys(event) {
  const keys = [];
  if (text(event?.runId)) keys.push(`run:${text(event.runId)}`);
  if (text(event?.attemptId)) keys.push(`attempt:${text(event.attemptId)}`);
  if (text(event?.sourceSessionId)) keys.push(`session:${text(event.sourceSessionId)}`);
  return keys;
}

/**
 * Two coverage ratios that must never be conflated:
 * - `endedWithUsage`: ended runs with any reported measurement / all ended runs;
 * - `endedComplete`: ended runs whose coverage proof is complete / all ended runs.
 *
 * Active, unsupported, partial, legacy and estimated runs are reported
 * separately. A zero denominator yields `null`, never a fake 0%.
 *
 * @param {{ runs?: object[], events?: object[], window?: { fromMs?: number, toMs?: number }, filters?: object }} [input]
 * @returns {object}
 */
export function buildUsageCoverage(input = {}) {
  const fromMs = finiteOrNull(input.window?.fromMs);
  const toMs = finiteOrNull(input.window?.toMs);
  const role = text(input.filters?.role).toLowerCase();
  const harness = text(input.filters?.harness).toLowerCase();
  const runs = (Array.isArray(input.runs) ? input.runs : []).filter((run) => {
    if (!run || typeof run !== 'object') return false;
    if (role && text(run.role).toLowerCase() !== role) return false;
    if (harness && text(run.harness).toLowerCase() !== harness) return false;
    if (fromMs != null || toMs != null) {
      const at = msOf(run.endedAt || run.startedAt);
      if (!Number.isFinite(at)) return false;
      if (fromMs != null && at < fromMs) return false;
      if (toMs != null && at >= toMs) return false;
    }
    return true;
  });
  const events = Array.isArray(input.events) ? input.events : [];
  const measuredRunKeys = new Set();
  const estimatedRunKeys = new Set();
  /** @type {Map<string, object[]>} */
  const eventsByKey = new Map();
  let estimatedEvents = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.eventType === 'run') continue;
    const keys = eventIdentityKeys(event);
    for (const key of keys) {
      if (!eventsByKey.has(key)) eventsByKey.set(key, []);
      eventsByKey.get(key).push(event);
    }
    if (event.estimated === true || event.provenance === 'estimated') {
      estimatedEvents += 1;
      for (const key of keys) estimatedRunKeys.add(key);
    }
    if (hasTokenMeasurement(event.tokens)) {
      for (const key of keys) measuredRunKeys.add(key);
    }
  }
  const runHasUsage = (run) => {
    if (run.measurementPresent === true) return true;
    return runIdentityKeys(run).some((key) => measuredRunKeys.has(key));
  };

  let active = 0;
  let ended = 0;
  let endedWithUsage = 0;
  let endedComplete = 0;
  let endedEstimated = 0;
  let endedReportedZero = 0;
  const byCompleteness = { complete: 0, partial: 0, missing: 0, unsupported: 0, unknown: 0 };
  let legacy = 0;
  let inferredWithoutRunStart = 0;
  let withCoverageProof = 0;
  let withoutCoverageProof = 0;
  for (const run of runs) {
    if (run.inferredWithoutRunStart === true) inferredWithoutRunStart += 1;
    if (run.status !== 'ended') {
      active += 1;
      continue;
    }
    ended += 1;
    if (run.inferredWithoutRunStart === true) legacy += 1;
    const hasUsage = runHasUsage(run);
    if (hasUsage) endedWithUsage += 1;
    const completeness = ['complete', 'partial', 'missing', 'unsupported'].includes(run.completeness)
      ? run.completeness
      : 'unknown';
    byCompleteness[completeness] += 1;
    if (completeness === 'complete') endedComplete += 1;
    if (run.coverage?.proof === true) withCoverageProof += 1;
    else withoutCoverageProof += 1;
    if (runIdentityKeys(run).some((key) => estimatedRunKeys.has(key))) endedEstimated += 1;
    if (hasUsage && !run.inferredWithoutRunStart) {
      const runEvents = [];
      const seen = new Set();
      for (const key of runIdentityKeys(run)) {
        for (const event of eventsByKey.get(key) || []) {
          if (seen.has(event)) continue;
          seen.add(event);
          runEvents.push(event);
        }
      }
      const buckets = sumUsageTokenBuckets(runEvents);
      if (runEvents.length === 0 || buckets.totalTokens === 0) endedReportedZero += 1;
    }
  }
  const ratio = (numerator, denominator) => (denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null);
  return {
    ...USAGE_INSIGHTS_VERSION,
    scope: 'own',
    window: fromMs != null || toMs != null ? { from: new Date(fromMs ?? 0).toISOString(), to: toMs != null ? new Date(toMs).toISOString() : null } : null,
    runs: { total: runs.length, active, ended },
    endedWithUsage: { n: endedWithUsage, denominator: ended, ratio: ratio(endedWithUsage, ended) },
    endedComplete: { n: endedComplete, denominator: ended, ratio: ratio(endedComplete, ended) },
    byCompleteness,
    legacy: { inferredWithoutRunStart, of_ended: legacy },
    estimated: { events: estimatedEvents, runs: endedEstimated },
    reportedZero: { runs: endedReportedZero },
    coverageProof: { withProof: withCoverageProof, withoutProof: withoutCoverageProof },
    note: 'runs are correlated per durable run/attempt id; usage events are not requests',
  };
}

/**
 * Extract the review/manual acceptance signals from the existing cycle
 * aggregate without inventing a second denominator.
 *
 * @param {object} [cycleMetrics]
 * @param {{ verdicts?: object }} [extra]
 * @returns {object}
 */
export function buildUsageSignals(cycleMetrics = {}, extra = {}) {
  const closed = Number(cycleMetrics?.closedCycleCount) || 0;
  const open = Number(cycleMetrics?.openCycleCount) || 0;
  const ratio = (value) => (closed > 0 ? Number((Number(value || 0) / closed).toFixed(6)) : null);
  const cost = {
    actualUsd: Number.isFinite(Number(cycleMetrics?.totalCostUsd)) ? Number(cycleMetrics.totalCostUsd) : null,
    estimatedUsd: null,
    subscriptionEvents: Number(cycleMetrics?.subscriptionUsageEventCount) || 0,
    unpricedEvents: Number(cycleMetrics?.unknownUsageEventCount) || 0,
    pricedEvents: Number(cycleMetrics?.denominators?.pricedEvents) || 0,
    totalEvents: Number(cycleMetrics?.denominators?.totalEvents) || 0,
    pricedEventShare: finiteOrNull(cycleMetrics?.pricedEventShare),
    partial: Number(cycleMetrics?.unknownUsageEventCount) > 0
      || finiteOrNull(cycleMetrics?.pricedEventShare) == null
      || (finiteOrNull(cycleMetrics?.pricedEventShare) ?? 1) < 1,
    effectiveCostPerAcceptedUsd: Number.isFinite(Number(cycleMetrics?.effectiveCostPerAcceptedUsd))
      ? Number(cycleMetrics.effectiveCostPerAcceptedUsd)
      : null,
  };
  const verdicts = extra.verdicts && typeof extra.verdicts === 'object' ? extra.verdicts : {};
  const verdictTotal = ['pass', 'fail', 'blocked', 'undecided']
    .reduce((sum, key) => sum + (Number(verdicts[key]) || 0), 0);
  return {
    // Technical success is the delegation row outcome; it is not the same as a
    // review acceptance, so it is reported with its own denominator.
    technicalSuccess: {
      n: Number(extra.technicalSuccess) || 0,
      denominator: Number(extra.technicalSuccessDenominator) || Number(extra.executedRuns) || 0,
      ratio: null,
    },
    acceptedByReview: {
      n: Number(cycleMetrics?.acceptedCount) || 0,
      denominator: closed,
      ratio: ratio(cycleMetrics?.acceptedCount),
    },
    rejectedByReview: {
      n: Number(cycleMetrics?.rejectedCount) || 0,
      denominator: closed,
      ratio: ratio(cycleMetrics?.rejectedCount),
    },
    manualAccepted: {
      n: Number(cycleMetrics?.manualAcceptedCount) || 0,
      denominator: closed,
      ratio: ratio(cycleMetrics?.manualAcceptedCount),
    },
    undecided: { n: Number(cycleMetrics?.undecidedCount) || 0, denominator: closed },
    unreviewed: { n: Number(cycleMetrics?.unreviewedCount) || 0, denominator: closed },
    openCycles: { n: open, denominator: Number(cycleMetrics?.denominators?.openCycles) || open },
    reviewVerdicts: {
      pass: Number(verdicts.pass) || 0,
      fail: Number(verdicts.fail) || 0,
      blocked: Number(verdicts.blocked) || 0,
      undecided: Number(verdicts.undecided) || 0,
      n: verdictTotal,
    },
    cost,
    note: 'technical success, review verdict, accepted-by-review and manualAccept are separate signals; cost is partial when prices are incomplete',
  };
}

/**
 * Executed automatic choices. `proposals` (durable pick records) and
 * `diagnosticPicks` (proposals that never started a delegation) are reported
 * next to `executed` but never added to it.
 *
 * @param {object[]} rows delegation rows
 * @param {{ filters?: object, proposals?: number|null, originDetails?: object }} [options]
 * @returns {object}
 */
export function summarizeExecutedChoices(rows, options = {}) {
  const filters = options.filters || {};
  const list = (Array.isArray(rows) ? rows : []).filter((row) => delegationRowMatchesFilters(row, filters));
  let auto = 0;
  let manual = 0;
  let unknown = 0;
  const originDetails = {};
  const linkStatuses = {};
  const byModel = new Map();
  for (const row of list) {
    const origin = text(row.pickOrigin).toLowerCase();
    if (origin === 'auto') auto += 1;
    else if (origin === 'manual') manual += 1;
    else unknown += 1;
    const detail = text(row.pickOriginDetail).toLowerCase() || 'none';
    originDetails[detail] = (originDetails[detail] || 0) + 1;
    const link = text(row.pickLinkStatus).toLowerCase() || 'none';
    linkStatuses[link] = (linkStatuses[link] || 0) + 1;

    const harness = text(row.executor?.transport || row.harness).toLowerCase() || 'unknown';
    const model = text(row.executor?.model || row.model) || 'unknown';
    const key = `${harness}/${model}`;
    if (!byModel.has(key)) {
      byModel.set(key, {
        key,
        harness,
        model,
        executed: 0,
        auto: 0,
        manual: 0,
        unknown: 0,
        originDetails: {},
        linkStatuses: {},
        technicalSuccess: 0,
        technicalOutcomeKnown: 0,
      });
    }
    const group = byModel.get(key);
    group.executed += 1;
    if (origin === 'auto') group.auto += 1;
    else if (origin === 'manual') group.manual += 1;
    else group.unknown += 1;
    group.originDetails[detail] = (group.originDetails[detail] || 0) + 1;
    group.linkStatuses[link] = (group.linkStatuses[link] || 0) + 1;
    const outcome = text(row.status || row.taskOutcome).toLowerCase();
    if (outcome) {
      group.technicalOutcomeKnown += 1;
      if (outcome === 'completed' || outcome === 'success' || outcome === 'ok') group.technicalSuccess += 1;
    }
  }
  const proposals = options.proposals === undefined ? null : options.proposals;
  const linkedPickIds = new Set(list.map((row) => text(row.pickId)).filter(Boolean));
  const diagnosticPicks = proposals == null ? null : Math.max(0, proposals - linkedPickIds.size);
  const groups = [...byModel.values()]
    .map((group) => ({
      ...group,
      technicalSuccessRate: group.technicalOutcomeKnown > 0
        ? Number((group.technicalSuccess / group.technicalOutcomeKnown).toFixed(6))
        : null,
    }))
    .sort((left, right) => right.executed - left.executed || left.key.localeCompare(right.key));
  return {
    ...USAGE_INSIGHTS_VERSION,
    executed: list.length,
    auto,
    manual,
    unknown,
    // Proposals and diagnostic picks are reported beside execution, never in it.
    proposals,
    diagnosticPicks,
    originDetails,
    linkStatuses,
    groups,
    note: 'proposals are not execution; diagnostic picks never count as an executed choice',
  };
}

/**
 * Shares relative to the cohort sum of one metric. `share_ratio` values sum to
 * 1 across the returned rows (subject to rounding); the leader bar is exposed
 * separately as `leader`.
 *
 * @param {object[]} rows
 * @param {(row: object) => number} valueOf
 * @param {{ keyOf?: (row: object) => string }} [options]
 * @returns {{ metricTotal: number, rows: object[], leader: { key: string, value: number, share_ratio: number } | null }}
 */
export function buildCohortShares(rows, valueOf, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const keyOf = typeof options.keyOf === 'function' ? options.keyOf : (row) => String(row?.key ?? row?.label ?? '');
  const valued = list.map((row) => ({ row, value: Math.max(0, Number(valueOf(row)) || 0) }));
  const metricTotal = valued.reduce((sum, entry) => sum + entry.value, 0);
  let leader = null;
  const out = valued.map((entry) => {
    const shareRatio = metricTotal > 0 ? entry.value / metricTotal : 0;
    if (!leader || entry.value > leader.value) {
      leader = { key: keyOf(entry.row), value: entry.value, share_ratio: shareRatio };
    }
    return {
      ...entry.row,
      share_value: entry.value,
      share_ratio: Number(shareRatio.toFixed(6)),
      share_percent: metricTotal > 0 ? Number((shareRatio * 100).toFixed(2)) : null,
    };
  });
  return {
    metricTotal,
    rows: out,
    leader: metricTotal > 0 ? leader : null,
  };
}

/**
 * Zone-local day groups for the KPI cards. Mirrors the summary group shape so
 * the UI can swap `byDay` for `byZoneDay` without new formatting rules.
 *
 * @param {object[]} events
 * @param {string} [tz]
 * @returns {Record<string, object>}
 */
export function groupEventsByZoneDay(events, tz = 'UTC') {
  const groups = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const ms = msOf(event.at);
    const day = Number.isFinite(ms) ? formatZoneDay(ms, tz) : 'unknown';
    if (!groups[day]) {
      groups[day] = { usd: 0, estimatedUsd: 0, unpricedEvents: 0, tokens: 0, events: 0, runs: 0, okRuns: 0 };
    }
    const row = groups[day];
    if (event.eventType === 'run') {
      row.runs += 1;
      if (String(event.outcome || '').toLowerCase() === 'ok') row.okRuns += 1;
      continue;
    }
    row.events += 1;
    const usd = finiteOrNull(event.usd);
    if (usd == null) row.unpricedEvents += 1;
    else if (event.estimated === true) row.estimatedUsd += usd;
    else row.usd += usd;
    row.tokens += sumUsageTokenBuckets([event]).totalTokens;
  }
  return groups;
}

/**
 * Today / rolling 7 days / calendar month KPIs, resolved in the caller zone
 * from a zone-day map. Missing days simply contribute zero to a sum that the
 * caller requested; the KPI window itself is always explicit.
 *
 * @param {Record<string, object>} byZoneDay
 * @param {{ now?: number, tz?: string }} [options]
 * @returns {{ today: object, week: object, month: object }}
 */
export function buildUsageKpis(byZoneDay, options = {}) {
  const days = byZoneDay && typeof byZoneDay === 'object' ? byZoneDay : {};
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const tz = options.tz || 'UTC';
  const dayKey = (ms) => formatZoneDay(ms, tz);
  const todayKey = dayKey(now);
  const weekStartKey = dayKey(addZoneDays(zoneDayStartMs(now, tz), -6, tz));
  const monthStartKey = dayKey(zoneMonthStartMs(now, tz));
  const sumRange = (fromKey, toKey) => {
    let usd = 0;
    let estimatedUsd = 0;
    let unpricedEvents = 0;
    let tokens = 0;
    let runs = 0;
    let okRuns = 0;
    for (const [day, row] of Object.entries(days)) {
      if (day < fromKey || day > toKey) continue;
      usd += Number(row?.usd) || 0;
      estimatedUsd += Number(row?.estimatedUsd) || 0;
      unpricedEvents += Number(row?.unpricedEvents) || 0;
      tokens += Number(row?.tokens) || 0;
      runs += Number(row?.runs) || 0;
      okRuns += Number(row?.okRuns) || 0;
    }
    return {
      usd: Number(usd.toFixed(6)),
      estimatedUsd: Number(estimatedUsd.toFixed(6)),
      unpricedEvents,
      tokens,
      runs,
      okRuns,
      successRate: runs > 0 ? Number((okRuns / runs).toFixed(4)) : null,
    };
  };
  return {
    today: sumRange(todayKey, todayKey),
    week: sumRange(weekStartKey, todayKey),
    month: sumRange(monthStartKey, todayKey),
  };
}

/**
 * One payload that the API, chart, table and CSV all read, so the filters and
 * sums cannot diverge between them.
 *
 * @param {{
 *   events?: object[],
 *   runs?: object[],
 *   window?: object,
 *   filters?: object,
 *   choicesRows?: object[],
 *   proposals?: number|null,
 *   cycleMetrics?: object,
 *   verdicts?: object,
 * }} [input]
 * @returns {object}
 */
export function buildUsageInsights(input = {}) {
  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const scopedEvents = filterUsageEvents(input.events, filters);
  const tokens = sumUsageTokenBuckets(scopedEvents);
  const cost = sumUsageCost(scopedEvents);
  const coverage = buildUsageCoverage({
    runs: input.runs,
    events: scopedEvents,
    window: input.window,
    filters,
  });
  const choices = summarizeExecutedChoices(input.choicesRows, {
    filters,
    proposals: input.proposals,
  });
  const signals = buildUsageSignals(input.cycleMetrics, {
    verdicts: input.verdicts,
    technicalSuccess: choices.groups.reduce((sum, group) => sum + group.technicalSuccess, 0),
    technicalSuccessDenominator: choices.groups.reduce((sum, group) => sum + group.technicalOutcomeKnown, 0),
    executedRuns: choices.executed,
  });
  return {
    ...USAGE_INSIGHTS_VERSION,
    tz: text(input.window?.tz) || 'UTC',
    range: input.window ? {
      from: text(input.window.from),
      to: text(input.window.to),
      definition: text(input.window.definition),
      input_kind: text(input.window.inputKind),
    } : null,
    filters,
    tokens,
    cost,
    coverage,
    choices,
    signals,
  };
}
