/**
 * Budget accounting for a model-selection start.
 *
 * This module deliberately does NOT invent a spend decision. The existing
 * per-cycle usage correlation (`lib/workspace-watcher-cycle-usage.js`) already
 * keeps `own` and `consolidated` buckets separate and classifies every event as
 * `reported` / `estimated` / `subscription` / `unknown`. This module projects
 * that source onto the two questions a cap needs answered:
 *
 * - **How much is known?** The known sum is a lower bound while any event is
 *   `unknown`; it is never labelled a "total cost". A partial reading exposes
 *   the known sum plus its priced-event coverage.
 * - **Can a cap actually stop a start?** A hard cap requires an enforceable
 *   per-execution bound AND an atomic reservation. Without both, the reading can
 *   only be `observational`: it may stop *future* starts once the measured sum
 *   crosses the threshold, but it cannot guarantee that the current execution
 *   never exceeds the budget.
 *
 * An `unknown` event never counts as a zero-dollar event. A subscription has no
 * marginal USD but still consumes its quota.
 *
 * `PREMIUM_REVIEW_COST_TIER` (`lib/model-pick-gate-primitives.js`) is the cost
 * threshold above which a review needs a justification. It is NOT a global
 * concurrency limit; general parallelism caps stay in the existing admission /
 * slot path and apply regardless of cost tier.
 */

/**
 * How much a cap can rely on the reading.
 * - `enforceable` — trustworthy price + upstream/hard bound + atomic reservation.
 * - `observational` — a measurement exists, so future starts can stop, but the
 *   current execution is not bounded.
 * - `unavailable` — no measurement at all; nothing can be enforced or observed.
 */
export const MODEL_PICK_BUDGET_CAP_STATUS = Object.freeze([
  'enforceable',
  'observational',
  'unavailable',
]);

/** Cost kinds, in the same vocabulary as the cycle usage contract. */
export const MODEL_PICK_BUDGET_COST_KINDS = Object.freeze([
  'reported',
  'estimated',
  'subscription',
  'unknown',
]);

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * @typedef {{
 *   reportedUsd?: unknown,
 *   estimatedUsd?: unknown,
 *   subscriptionEventCount?: unknown,
 *   unknownEventCount?: unknown,
 *   pricedEventCount?: unknown,
 * }} ModelPickBudgetCostInput
 */

/**
 * Read the separable cost states out of a `finalizeCycleUsageCost` block (or an
 * equivalent caller-provided snapshot). Missing values stay `null`, never `0`.
 *
 * @param {ModelPickBudgetCostInput} [cost]
 * @returns {{
 *   reportedUsd: number | null,
 *   estimatedUsd: number | null,
 *   subscriptionEventCount: number,
 *   unknownEventCount: number,
 *   pricedEventCount: number,
 * }}
 */
export function readModelPickBudgetStates(cost = {}) {
  const source = cost && typeof cost === 'object' ? cost : {};
  return {
    reportedUsd: finiteOrNull(source.reportedUsd),
    estimatedUsd: finiteOrNull(source.estimatedUsd),
    subscriptionEventCount: count(source.subscriptionEventCount),
    unknownEventCount: count(source.unknownEventCount),
    pricedEventCount: count(source.pricedEventCount),
  };
}

/**
 * Evaluate the budget reading and the cap status. `capUsd` is the configured
 * ceiling; `priceTrusted` / `enforced` / `atomicReservation` are the conditions
 * under which that ceiling can actually bind one execution.
 *
 * @param {{
 *   cost?: ModelPickBudgetCostInput,
 *   capUsd?: number | null,
 *   priceTrusted?: boolean,
 *   enforced?: boolean,
 *   atomicReservation?: boolean,
 *   enforcement?: string,
 * }} [input]
 * @returns {{
 *   reportedUsd: number | null,
 *   estimatedUsd: number | null,
 *   subscriptionEventCount: number,
 *   unknownEventCount: number,
 *   pricedEventCount: number,
 *   knownUsd: number | null,
 *   label: 'total' | 'known-subset' | 'subscription' | 'unknown',
 *   partial: boolean,
 *   coverage: number | null,
 *   hasMeasurement: boolean,
 *   cap: {
 *     status: 'enforceable' | 'observational' | 'unavailable',
 *     limitUsd: number,
 *     overThreshold: boolean,
 *     remainingUsd: number | null,
 *     remainingIsLowerBound: boolean,
 *     reason: string,
 *   },
 *   stopFutureStarts: boolean,
 * }}
 */
export function evaluateModelPickBudget(input = {}) {
  const states = readModelPickBudgetStates(input.cost);
  const hasPriced = states.pricedEventCount > 0
    && (states.reportedUsd != null || states.estimatedUsd != null);
  const knownUsd = hasPriced
    ? Number(((states.reportedUsd || 0) + (states.estimatedUsd || 0)).toFixed(6))
    : null;
  const partial = states.unknownEventCount > 0;
  /** @type {'total' | 'known-subset' | 'subscription' | 'unknown'} */
  let label = 'unknown';
  if (hasPriced) label = partial ? 'known-subset' : 'total';
  else if (states.subscriptionEventCount > 0 && states.unknownEventCount === 0) label = 'subscription';

  const classified = states.pricedEventCount + states.unknownEventCount;
  const coverage = classified > 0
    ? Number((states.pricedEventCount / classified).toFixed(4))
    : (states.subscriptionEventCount > 0 && states.unknownEventCount === 0 ? 1 : null);
  const hasMeasurement = states.pricedEventCount > 0
    || states.subscriptionEventCount > 0
    || states.unknownEventCount > 0;

  const limitUsd = Math.max(0, finiteOrNull(input.capUsd) || 0);
  const priceTrusted = input.priceTrusted === true;
  const enforced = input.enforced === true
    || String(input.enforcement || '').trim().toLowerCase() === 'upstream_limit'
    || String(input.enforcement || '').trim().toLowerCase() === 'hard_bound';
  const atomicReservation = input.atomicReservation === true;

  let status = 'unavailable';
  let reason = 'no usage measurement is available';
  if (hasMeasurement && priceTrusted && enforced && atomicReservation && limitUsd > 0) {
    status = 'enforceable';
    reason = 'trusted price, enforceable single-execution bound and atomic reservation';
  } else if (hasMeasurement) {
    status = 'observational';
    if (!priceTrusted) reason = 'the price is not trusted';
    else if (!enforced) reason = 'no enforceable single-execution bound';
    else if (!atomicReservation) reason = 'no atomic reservation protects the cap';
    else reason = 'no positive cap is configured';
  }

  const measured = knownUsd != null ? knownUsd : 0;
  const overThreshold = limitUsd > 0 && measured >= limitUsd;
  const remainingUsd = status === 'enforceable'
    ? Number(Math.max(0, limitUsd - measured).toFixed(6))
    : null;
  return {
    ...states,
    knownUsd,
    label,
    partial,
    coverage,
    hasMeasurement,
    cap: {
      status: /** @type {'enforceable'|'observational'|'unavailable'} */ (status),
      limitUsd,
      overThreshold,
      remainingUsd,
      // A partial reading gives a lower-bound remainder: more cost may exist
      // that the measurement did not see.
      remainingIsLowerBound: partial,
      reason,
    },
    // The measurement may stop future work, never guarantee the current bill.
    stopFutureStarts: overThreshold,
  };
}
