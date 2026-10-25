/**
 * Rule-based optimization findings derived from the top-consumers read model.
 * Pure: callers pass the already aggregated `usage_top` / limit-burn results.
 * Every finding carries its evidence numbers so it can be checked, not trusted.
 */

export const ADVICE_UNCACHED_MIN_FRESH = 20_000_000;
export const ADVICE_UNCACHED_MIN_EVENTS = 50;
export const ADVICE_UNCACHED_MAX_CACHE_SHARE = 0.1;
export const ADVICE_LEAF_MIN_PER_ATTEMPT = 1_000_000;
export const ADVICE_LEAF_MIN_ATTEMPTS = 5;
export const ADVICE_BURN_MIN_BLAMED = 2;
export const ADVICE_RESUME_MIN_DELEGATIONS = 10;
/** Share of delegations that must have a measured usage event, else the comparison is skipped. */
export const ADVICE_RESUME_MIN_COVERAGE = 0.5;
export const ADVICE_COVERAGE_MIN_SEEN = 20;
export const ADVICE_RESUME_HURT_RATIO = 1.25;

/**
 * @param {{ models?: Record<string, any>, leaves?: Record<string, any>, chats?: Record<string, any>, burn?: Record<string, any>, resume?: Record<string, any> }} input
 *   `models`/`leaves`/`chats` are `buildUsageTop` results for those axes.
 * @returns {Array<{ kind: string, severity: 'high'|'medium', subject: string, label?: string, evidence: Record<string, any>, suggestion: string }>}
 */
export function buildUsageAdvice(input: Partial<{ models?: Record<string, any>, leaves?: Record<string, any>, chats?: Record<string, any>, burn?: Record<string, any>, resume?: Record<string, any> }> = {}) {
  const findings = [];
  for (const row of input.models?.rows || []) {
    if (row.fresh < ADVICE_UNCACHED_MIN_FRESH || row.events < ADVICE_UNCACHED_MIN_EVENTS) continue;
    if ((row.cacheShare ?? 0) > ADVICE_UNCACHED_MAX_CACHE_SHARE) continue;
    findings.push({
      kind: 'uncached_model',
      severity: row.shareOfFresh >= 0.1 ? 'high' : 'medium',
      subject: row.key,
      evidence: { fresh: row.fresh, shareOfFresh: row.shareOfFresh, cacheShare: row.cacheShare, events: row.events, roles: row.roles },
      suggestion: 'The provider reports almost no cache hits, so every message re-bills the whole prompt. Shorten the standing prompt and diff context, avoid fanout/pair reviews on it, or route these roles to a model that caches.',
    });
  }
  for (const row of input.leaves?.rows || []) {
    if (!row.key.startsWith('(') && row.attempts >= ADVICE_LEAF_MIN_ATTEMPTS && (row.freshPerAttempt ?? 0) >= ADVICE_LEAF_MIN_PER_ATTEMPT) {
      findings.push({
        kind: 'costly_leaf',
        severity: row.freshPerAttempt >= 2 * ADVICE_LEAF_MIN_PER_ATTEMPT ? 'high' : 'medium',
        subject: row.key,
        evidence: { fresh: row.fresh, attempts: row.attempts, freshPerAttempt: row.freshPerAttempt, limitHits: row.limitHits, cacheShare: row.cacheShare },
        suggestion: 'Many rounds with a large uncached prompt each. Split the leaf, tighten acceptance criteria, or resume the reviewer session instead of starting a new one per round.',
      });
    }
  }
  for (const row of input.chats?.rows || []) {
    if (!row.flags?.includes('heavy_context')) continue;
    findings.push({
      kind: 'heavy_context_chat',
      severity: 'medium',
      subject: row.key,
      label: row.label,
      evidence: { fresh: row.fresh, avgContextPerEvent: row.avgContextPerEvent, events: row.events, harnesses: row.harnesses },
      suggestion: 'Prompt volume per event is far above peer chats on the same harness. Restart or compact this chat and move finished work into a fresh one.',
    });
  }
  for (const row of input.burn?.culprits || []) {
    if (row.hitsBlamed < ADVICE_BURN_MIN_BLAMED) continue;
    findings.push({
      kind: 'limit_hotspot',
      severity: 'high',
      subject: row.chatId,
      label: row.label,
      evidence: { harness: row.harness, hitsBlamed: row.hitsBlamed, freshSummedOverWindows: row.fresh },
      suggestion: 'Repeatedly among the heaviest same-harness consumers right before usage limits were hit. Move it to another harness or schedule it outside the busy window.',
    });
  }
  findings.push(...findCoverageGaps(input.resume?.rows || []));
  findings.push(...findResumeHurts(input.resume?.rows || []));
  return findings;
}

/**
 * Delegations that have run markers but no token measurement make every
 * per-delegation number for that harness and role an undercount.
 *
 * @param {Record<string, any>[]} rows `resume` axis rows (`harness|role|resumed|fresh`)
 * @returns {Record<string, any>[]}
 */
function findCoverageGaps(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const [harness, role, mode] = String(row.key).split('|');
    if (!mode) continue;
    const agg = byPair.get(`${harness}|${role}`) || { seen: 0, measured: 0 };
    agg.seen += row.delegationsSeen;
    agg.measured += row.delegations;
    byPair.set(`${harness}|${role}`, agg);
  }
  const out = [];
  for (const [subject, agg] of byPair) {
    if (agg.seen < ADVICE_COVERAGE_MIN_SEEN || agg.measured / agg.seen >= ADVICE_RESUME_MIN_COVERAGE) continue;
    out.push({
      kind: 'low_measurement_coverage',
      severity: 'high',
      subject,
      evidence: { delegationsSeen: agg.seen, delegationsMeasured: agg.measured, coverage: Number((agg.measured / agg.seen).toFixed(3)) },
      suggestion: 'Most delegations of this harness and role have no token usage event, so its totals and per-delegation costs are undercounted. Fix usage capture for this adapter before drawing cost conclusions.',
    });
  }
  return out;
}

/**
 * @param {Record<string, any>} row resume-axis row
 * @returns {boolean}
 */
function hasLowCoverage(row) {
  return row.delegationsSeen > 0 && row.delegations / row.delegationsSeen < ADVICE_RESUME_MIN_COVERAGE;
}

/**
 * Session reuse should lower the cost-like `weighted` index per delegation
 * (fresh tokens plus discounted cache reads), so a harness that caches well is
 * not blamed for a larger cached prefix. Only measured delegations count; a
 * comparison is skipped when too few delegations have usage events.
 *
 * @param {Record<string, any>[]} rows `resume` axis rows (`harness|role|resumed|fresh`)
 * @returns {Record<string, any>[]}
 */
function findResumeHurts(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const [harness, role, mode] = String(row.key).split('|');
    if (!mode) continue;
    const pair = byPair.get(`${harness}|${role}`) || {};
    pair[mode] = row;
    byPair.set(`${harness}|${role}`, pair);
  }
  const out = [];
  for (const [subject, pair] of byPair) {
    const resumed = pair.resumed;
    const fresh = pair.fresh;
    if (!resumed || !fresh) continue;
    if (resumed.delegations < ADVICE_RESUME_MIN_DELEGATIONS || fresh.delegations < ADVICE_RESUME_MIN_DELEGATIONS) continue;
    if (hasLowCoverage(resumed) || hasLowCoverage(fresh)) continue;
    const ratio = resumed.weightedPerDelegation / Math.max(1, fresh.weightedPerDelegation);
    if (ratio < ADVICE_RESUME_HURT_RATIO) continue;
    out.push({
      kind: 'resume_hurts',
      severity: 'medium',
      subject,
      evidence: {
        resumedWeightedPerDelegation: resumed.weightedPerDelegation,
        newSessionWeightedPerDelegation: fresh.weightedPerDelegation,
        resumedFreshPerDelegation: resumed.freshPerDelegation,
        newSessionFreshPerDelegation: fresh.freshPerDelegation,
        ratio: Number(ratio.toFixed(2)),
        resumedDelegations: resumed.delegations,
        freshDelegations: fresh.delegations,
        resumedCacheShare: resumed.cacheShare,
      },
      suggestion: 'Resumed sessions cost more fresh tokens than new ones on this harness and role. Disable session reuse for it, or cap the number of rounds/context size before starting a new session.',
    });
  }
  return out;
}
