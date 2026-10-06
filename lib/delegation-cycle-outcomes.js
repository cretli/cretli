/**
 * Delegation workflow cycles, acceptance evidence, and cost-per-accepted metrics.
 */

import { parseDelegationVerdict } from './delegation-verdict.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import {
  delegationCycleRole,
  isInfraDelegationOutcomeForCycle,
  isUserCancelledDelegation,
} from './delegation-cycle-classify.js';
import {
  MODEL_PICK_REQUIRE_VERIFY_FOR_ACCEPTANCE,
  MODEL_PICK_USAGE_WINDOW_MS,
} from './model-pick-policy.js';
import { readUsageEvents } from './persist/usage-persist.js';

/**
 * @param {object} row
 * @returns {[number, number] | null} [start, end] in ms, or null without a usable range
 */
function readInterval(row) {
  const start = Date.parse(String(row?.startedAt || row?.createdAt || ''));
  const end = Date.parse(String(row?.finishedAt || row?.lastTransitionAt || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return [start, end];
}

/**
 * Wall time of a cycle: the length of the union of disjoint job intervals
 * (spec allows span min→max or this union; we use the union). A sequential
 * implement→review adds up (10 + 5 = 15 min); parallel overlapping reviews count
 * once; idle gaps between jobs (e.g. implement then review an hour later) are
 * not counted — unlike a single min-start→max-end span.
 *
 * @param {object[]} rows
 * @returns {number}
 */
export function unionWallMs(rows) {
  const intervals = rows.map(readInterval).filter(Boolean).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const [start, end] of intervals) {
    if (!open) {
      curStart = start;
      curEnd = end;
      open = true;
    } else if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  if (open) total += curEnd - curStart;
  return total;
}

/**
 * @param {object[]} rows
 * @returns {object[]}
 */
function sortRows(rows) {
  return [...rows].sort(
    (left, right) => Date.parse(String(left?.createdAt || '')) - Date.parse(String(right?.createdAt || '')),
  );
}

/**
 * @param {object} row
 * @returns {string}
 */
function cycleCohortKey(row) {
  const parent = String(row?.parentChatId || '').trim();
  const leaf = String(row?.leafId || '').trim();
  return `${parent}\0${leaf}`;
}

/**
 * Build implement/fix→review cycles on one sorted row list (single cohort).
 *
 * @param {object[]} rows
 * @param {boolean} includeOpen
 * @returns {object[]}
 */
function buildDelegationQualityCyclesForRows(rows, includeOpen) {
  /** @type {object[]} */
  const cycles = [];
  /** @type {object | null} */
  let openImplement = null;
  /** @type {'implement' | 'fix'} */
  let openRole = 'implement';
  /** @type {object[]} */
  let openReviews = [];
  const closeCycle = () => {
    if (!openImplement) return;
    const closed = isTerminalDelegationStatus(openImplement.status)
      && openReviews.every((row) => isTerminalDelegationStatus(row?.status));
    cycles.push({
      implement: openImplement,
      implementRole: openRole,
      reviews: openReviews.slice(),
      closed,
      openedAt: String(openImplement.createdAt || ''),
      closedAt: closed && openReviews.length > 0
        ? String(openReviews[openReviews.length - 1]?.finishedAt || openReviews[openReviews.length - 1]?.createdAt || '')
        : String(openImplement.finishedAt || openImplement.createdAt || ''),
    });
    openImplement = null;
    openReviews = [];
    openRole = 'implement';
  };
  for (const row of rows) {
    const role = delegationCycleRole(row);
    if (role === 'implement' || role === 'fix') {
      closeCycle();
      openImplement = row;
      openRole = role;
      openReviews = [];
      continue;
    }
    if (role === 'review' && openImplement) {
      openReviews.push(row);
    }
  }
  closeCycle();
  return cycles.filter((cycle) => includeOpen || cycle.closed);
}

/**
 * Build implement/fix→review cycles for one parent chat cohort.
 *
 * A cycle opens on an `implement`/`fix` job and collects the following review
 * fanout until the next implement/fix. `closed` is true only when the opener
 * and every collected review are terminal; running cycles are returned only
 * with `includeOpen: true` so their accrued usage stays visible without joining
 * the closed denominator.
 *
 * When `parentChatId` is omitted, rows are partitioned by `(parentChatId, leafId)`
 * so reviews from another leaf or chat never attach to a foreign implement.
 *
 * @param {{
 *   rows?: object[],
 *   parentChatId?: string,
 *   leafId?: string,
 *   includeOpen?: boolean,
 *   requireVerify?: boolean,
 *   now?: number,
 * }} [input]
 * @returns {object[]}
 */
export function buildDelegationQualityCycles(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = String(input.leafId || '').trim();
  const includeOpen = input.includeOpen === true;
  const requireVerify = typeof input.requireVerify === 'boolean'
    ? input.requireVerify
    : MODEL_PICK_REQUIRE_VERIFY_FOR_ACCEPTANCE;
  const filtered = (Array.isArray(input.rows) ? input.rows : [])
    .filter((row) => !parentChatId || String(row?.parentChatId || '').trim() === parentChatId)
    .filter((row) => !leafId || String(row?.leafId || '').trim() === leafId);
  /** @type {object[][]} */
  const cohorts = [];
  if (parentChatId) {
    cohorts.push(sortRows(filtered));
  } else {
    /** @type {Map<string, object[]>} */
    const byCohort = new Map();
    for (const row of filtered) {
      const key = cycleCohortKey(row);
      if (!byCohort.has(key)) byCohort.set(key, []);
      byCohort.get(key).push(row);
    }
    for (const group of byCohort.values()) {
      cohorts.push(sortRows(group));
    }
  }
  /** @type {object[]} */
  const rawCycles = [];
  for (const cohortRows of cohorts) {
    rawCycles.push(...buildDelegationQualityCyclesForRows(cohortRows, includeOpen));
  }
  return rawCycles.map((cycle, index) => enrichDelegationCycle(cycle, index, { requireVerify }));
}

/**
 * @param {object} cycle
 * @param {number} index
 * @param {{ requireVerify?: boolean }} [options]
 * @returns {object}
 */
function enrichDelegationCycle(cycle, index, options = {}) {
  const implement = cycle.implement;
  const implementRole = cycle.implementRole || 'implement';
  const reviews = Array.isArray(cycle.reviews) ? cycle.reviews : [];
  const requireVerify = options.requireVerify === true;
  const reviewStatus = (row) => String(row?.status || '').trim().toLowerCase();
  const verdictOf = (row) => parseDelegationVerdict(String(row?.report || ''));
  // A review only counts as a credible verdict when it completed without an
  // infra failure; cancelled/infra/conflict/unspecified siblings are not usable.
  const credibleReview = (row) => isTerminalDelegationStatus(row?.status)
    && !isUserCancelledDelegation(row)
    && !isInfraDelegationOutcomeForCycle(row, 'review');
  const usable = reviews
    .filter(credibleReview)
    .map(verdictOf)
    .filter((verdict) => verdict === 'PASS' || verdict === 'FAIL' || verdict === 'BLOCKED');
  const everyReviewPass = reviews.length > 0
    && reviews.every((row) => credibleReview(row) && verdictOf(row) === 'PASS');
  const verifyStatusOf = (row) => (row?.verifyResult ? String(row.verifyResult.status || '').trim().toLowerCase() : '');
  const verifyBlocked = reviews.some((row) => {
    const status = verifyStatusOf(row);
    if (status) return status !== 'passed';
    return requireVerify;
  });
  const verifyAny = reviews.some((row) => row?.verifyResult != null);
  const verifyPassed = !verifyBlocked && (verifyAny || !requireVerify);
  const technicalSuccess = reviewStatus(implement) === 'completed'
    && !isUserCancelledDelegation(implement)
    && !isInfraDelegationOutcomeForCycle(implement, implementRole);
  // Acceptance needs a technically successful implementation, every final
  // sibling review PASS, and verify per policy.
  const acceptedByReview = technicalSuccess && everyReviewPass && !verifyBlocked;
  // `unreviewed` means no review job at all. A review that ran but produced no
  // credible verdict (infra, unparseable report) leaves the cycle undecided
  // instead of masquerading as "no review".
  const unreviewed = reviews.length === 0;
  const mixedSiblings = usable.some((verdict) => verdict === 'FAIL' || verdict === 'BLOCKED');
  let qualityOutcome = 'undecided';
  if (unreviewed) qualityOutcome = 'unreviewed';
  else if (acceptedByReview) qualityOutcome = 'accepted-by-review';
  else if (mixedSiblings) qualityOutcome = 'rejected-by-review';
  const infra = isInfraDelegationOutcomeForCycle(implement, implementRole)
    || reviews.some((row) => isInfraDelegationOutcomeForCycle(row, 'review'));
  const cancelled = isUserCancelledDelegation(implement) || reviews.some((row) => isUserCancelledDelegation(row));
  let runClass = 'quality';
  if (cancelled) runClass = 'cancel';
  else if (infra) runClass = 'infra';
  // Manual acceptance is an explicit human accept (`reason: 'accepted'`) on a
  // completed job. A plain ack (`reviewed`, `open_child`, failed/interrupted
  // attention) only dismisses a card and is not an acceptance signal.
  const acknowledgedJobs = [implement, ...reviews].filter((row) => (
    String(row?.acknowledgedAt || '').trim()
    && String(row?.acknowledgedReason || '').trim().toLowerCase() === 'accepted'
    && reviewStatus(row) === 'completed'
  ));
  const manualAccepted = acknowledgedJobs.length > 0;
  const manualAcceptedAt = acknowledgedJobs
    .map((row) => String(row?.acknowledgedAt || '').trim())
    .filter(Boolean)
    .sort()[0] || '';
  const wallMs = unionWallMs([implement, ...reviews]);
  const jobIds = [String(implement?.id || ''), ...reviews.map((row) => String(row?.id || ''))].filter(Boolean);
  const childChatIds = [String(implement?.childChatId || ''), ...reviews.map((row) => String(row?.childChatId || ''))].filter(Boolean);
  const closed = cycle.closed !== false;
  const parentChatId = String(implement?.parentChatId || '').trim();
  const leafId = String(implement?.leafId || '').trim();
  // The task revision that was reviewed: plan revision/hash for a plan job,
  // the task-text hash otherwise.
  const taskRevision = String(implement?.planHash || implement?.sourceHash || '').trim();
  return {
    cycleIndex: index,
    parentChatId,
    leafId,
    workflowId: `${parentChatId}:${leafId || 'chat'}`,
    workflowTaskRevision: taskRevision,
    planRevision: Number(implement?.planRevision) || 0,
    qualityOutcome,
    decided: acceptedByReview || qualityOutcome === 'rejected-by-review',
    runClass,
    acceptedByReview,
    manualAccepted,
    manualAcceptedAt,
    manualAcceptedJobIds: acknowledgedJobs.map((row) => String(row?.id || '')).filter(Boolean),
    unreviewed,
    technicalSuccess,
    taskOutcome: String(implement?.taskOutcome || 'unspecified'),
    reviewVerdicts: usable,
    verifyPassed: verifyAny || requireVerify ? verifyPassed : null,
    implementRole: implementRole === 'fix' ? 'fix' : 'implement',
    closed,
    openedAt: String(cycle.openedAt || ''),
    wallTimeMs: wallMs,
    jobIds,
    childChatIds,
    implementId: String(implement?.id || ''),
  };
}

/**
 * @param {object[]} cycles
 * @param {{ now?: number, readUsageEvents?: Function }} [input]
 * @returns {{
 *   acceptedCount: number,
 *   manualAcceptedCount: number,
 *   rejectedCount: number,
 *   closedCycleCount: number,
 *   openCycleCount: number,
 *   undecidedCount: number,
 *   unreviewedCount: number,
 *   totalCostUsd: number | null,
 *   partialCostUsd: number,
 *   pricedEventShare: number | null,
 *   unknownUsageEventCount: number,
 *   subscriptionUsageEventCount: number,
 *   openCyclePartialCostUsd: number,
 *   openCyclePricedEventShare: number | null,
 *   effectiveCostPerAcceptedUsd: number | null,
 *   denominators: object,
 * }}
 */
export function summarizeDelegationCycleCostMetrics(cycles, input = {}) {
  const list = Array.isArray(cycles) ? cycles.filter(Boolean) : [];
  const closed = list.filter((row) => row?.closed === true);
  const open = list.filter((row) => row?.closed !== true);
  const accepted = closed.filter((row) => row.acceptedByReview === true);
  const manualAccepted = closed.filter((row) => row.manualAccepted === true);
  const rejected = closed.filter((row) => row.qualityOutcome === 'rejected-by-review');
  const undecided = closed.filter((row) => row.qualityOutcome === 'undecided').length;
  const unreviewed = closed.filter((row) => row.unreviewed === true).length;
  const closedUsage = sumCycleCohortUsage(closed, input);
  const openUsage = sumCycleCohortUsage(open, input);
  // Effective cost only divides the closed cohort's priced USD by accepted
  // cycles; running cycles stay visible through `openCyclePartialCostUsd` but
  // never join this denominator.
  const effectiveCostPerAcceptedUsd = accepted.length > 0 && closedUsage.totalCostUsd != null
    ? Number((closedUsage.totalCostUsd / accepted.length).toFixed(6))
    : null;
  return {
    acceptedCount: accepted.length,
    manualAcceptedCount: manualAccepted.length,
    rejectedCount: rejected.length,
    closedCycleCount: closed.length,
    openCycleCount: open.length,
    undecidedCount: undecided,
    unreviewedCount: unreviewed,
    totalCostUsd: closedUsage.totalCostUsd,
    partialCostUsd: closedUsage.partialCostUsd,
    pricedEventShare: closedUsage.pricedEventShare,
    pricedCycleCount: closedUsage.pricedCycleCount,
    pricedCycleShare: closedUsage.pricedCycleShare,
    usageRangeTruncated: closedUsage.usageRangeTruncated === true || openUsage.usageRangeTruncated === true,
    usageWindowMs: MODEL_PICK_USAGE_WINDOW_MS,
    unknownUsageEventCount: closedUsage.unknownEvents,
    subscriptionUsageEventCount: closedUsage.subscriptionEvents,
    openCyclePartialCostUsd: openUsage.partialCostUsd,
    openCyclePricedEventShare: openUsage.pricedEventShare,
    effectiveCostPerAcceptedUsd,
    denominators: {
      closedCycles: closed.length,
      openCycles: open.length,
      acceptedByReview: accepted.length,
      manualAccepted: manualAccepted.length,
      rejectedByReview: rejected.length,
      unreviewed,
      pricedEvents: closedUsage.pricedEvents,
      totalEvents: closedUsage.totalEvents,
      unknownUsageEvents: closedUsage.unknownEvents,
      subscriptionUsageEvents: closedUsage.subscriptionEvents,
    },
  };
}

/**
 * @param {object[]} cycles
 * @param {{ now?: number, readUsageEvents?: Function }} [input]
 * @returns {{
 *   totalCostUsd: number | null,
 *   partialCostUsd: number,
 *   pricedEvents: number,
 *   totalEvents: number,
 *   unknownEvents: number,
 *   subscriptionEvents: number,
 *   pricedEventShare: number | null,
 * }}
 */
function sumCycleCohortUsage(cycles, input = {}) {
  const empty = {
    totalCostUsd: null,
    partialCostUsd: 0,
    pricedEvents: 0,
    totalEvents: 0,
    unknownEvents: 0,
    subscriptionEvents: 0,
    pricedEventShare: null,
    pricedCycleCount: 0,
    pricedCycleShare: cycles.length > 0 ? 0 : null,
    usageRangeTruncated: false,
  };
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const delegationIds = new Set();
  const childChatIds = new Set();
  /** @type {Map<string, number>} */
  const cycleByKey = new Map();
  cycles.forEach((cycle, index) => {
    for (const id of cycle.jobIds || []) {
      delegationIds.add(id);
      cycleByKey.set(`d:${id}`, index);
    }
    for (const id of cycle.childChatIds || []) {
      childChatIds.add(id);
      cycleByKey.set(`c:${id}`, index);
    }
  });
  if (delegationIds.size === 0 && childChatIds.size === 0) return empty;
  const reader = typeof input.readUsageEvents === 'function' ? input.readUsageEvents : readUsageEvents;
  let events = [];
  try {
    events = reader({
      from: new Date(now - MODEL_PICK_USAGE_WINDOW_MS).toISOString(),
      to: new Date(now).toISOString(),
    });
  } catch {
    return empty;
  }
  let partialCostUsd = 0;
  let pricedEvents = 0;
  let totalEvents = 0;
  let unknownEvents = 0;
  let subscriptionEvents = 0;
  const pricedCycles = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    if (String(event.eventType || '') === 'run') continue;
    const delegationId = String(event.delegationId || '').trim();
    const chatId = String(event.chatId || '').trim();
    const matchKey = delegationId && delegationIds.has(delegationId)
      ? `d:${delegationId}`
      : (chatId && childChatIds.has(chatId) ? `c:${chatId}` : '');
    if (!matchKey) continue;
    totalEvents += 1;
    const usdValue = Number(event.usd);
    const billingClass = String(event.billingClass || event.billing_class || '').trim().toLowerCase();
    if (billingClass === 'unknown') {
      unknownEvents += 1;
      continue;
    }
    if (billingClass === 'subscription_quota') {
      subscriptionEvents += 1;
      continue;
    }
    if (!Number.isFinite(usdValue) || usdValue <= 0) continue;
    pricedEvents += 1;
    partialCostUsd += usdValue;
    if (cycleByKey.has(matchKey)) pricedCycles.add(cycleByKey.get(matchKey));
  }
  const pricedEventShare = totalEvents > 0 ? pricedEvents / totalEvents : null;
  // The cohort is summed over a bounded window; a cycle opened before it only
  // has a partial sum, which the caller must be able to see.
  const windowStart = now - MODEL_PICK_USAGE_WINDOW_MS;
  const usageRangeTruncated = cycles.some((cycle) => {
    const opened = Date.parse(String(cycle?.openedAt || ''));
    return Number.isFinite(opened) && opened < windowStart;
  });
  return {
    usageRangeTruncated,
    totalCostUsd: pricedEvents > 0 ? Number(partialCostUsd.toFixed(6)) : null,
    partialCostUsd: Number(partialCostUsd.toFixed(6)),
    pricedEvents,
    totalEvents,
    unknownEvents,
    subscriptionEvents,
    pricedEventShare: pricedEventShare == null ? null : Number(pricedEventShare.toFixed(4)),
    pricedCycleCount: pricedCycles.size,
    pricedCycleShare: cycles.length > 0 ? Number((pricedCycles.size / cycles.length).toFixed(4)) : null,
  };
}
