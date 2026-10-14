/**
 * Net-savings benchmark model and go/no-go gate for the paid keep-alive.
 *
 * Scope (decision of plan version 3): the benchmark measures the CAPABILITY of
 * resuming a reviewer pair on one task fixture. It is not a real review loop,
 * because the pair is not wired into any loop, so no conclusion about savings
 * in loops may be drawn from it. A negative result is a valid outcome and
 * gates the automatic scheduler off.
 *
 * Everything here is a pure function over caller-supplied observations. An
 * unknown tariff yields an UNKNOWN cost (`null`), never a number and never a
 * savings promise.
 */

/** Compared arms: fresh chats, resumed pair, resumed pair plus keep-alive pings. */
export const KEEP_ALIVE_BENCHMARK_ARMS = Object.freeze(['fresh', 'reuse', 'reuse_keep_alive']);

/** The fixed participants measured in every arm. */
export const KEEP_ALIVE_BENCHMARK_ROLES = Object.freeze(['reviewerA', 'reviewerB', 'coordinator']);

export const KEEP_ALIVE_GATE_DECISION = Object.freeze({
  GO: 'go',
  NO_GO: 'no_go',
});

/** Stable gate reason ids (what blocked a `go`). */
export const KEEP_ALIVE_GATE_REASON = Object.freeze({
  MISSING_REPORT: 'report_missing',
  NOT_MEASURED: 'not_measured',
  FIXTURE_MISMATCH: 'fixture_version_mismatch',
  INCOMPLETE_ROLES: 'roles_incomplete',
  MISSING_ARM: 'arm_missing',
  COST_UNKNOWN: 'cost_unknown',
  NO_NET_SAVING: 'no_net_saving',
  NO_GAIN_OVER_REUSE: 'no_gain_over_reuse',
  QUALITY_LOSS: 'quality_loss',
  PINGS_INEFFECTIVE: 'pings_ineffective',
  NO_PINGS: 'no_pings',
});

/** The scope statement every report carries so it cannot be quoted out of context. */
export const KEEP_ALIVE_BENCHMARK_SCOPE = Object.freeze({
  kind: 'fixture_capability',
  loopConclusion: null,
  note: 'Measures resume capability on one fixture; the pair is not wired into review loops, so no saving in loops is concluded.',
});

const MIN_EFFECTIVE_PING_RATIO = 0.5;

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number|null} left
 * @param {number|null} right
 * @returns {number|null}
 */
function minus(left, right) {
  return left == null || right == null ? null : Number((left - right).toFixed(6));
}

/**
 * Sums a list of nullable costs: any unknown part makes the total unknown.
 *
 * @param {Array<number|null>} costs
 * @returns {{ usd: number|null, knownParts: number, unknownParts: number }}
 */
function sumCosts(costs) {
  let usd = 0;
  let known = 0;
  let unknown = 0;
  for (const cost of costs) {
    const value = num(cost);
    if (value == null) unknown += 1;
    else {
      known += 1;
      usd += value;
    }
  }
  return {
    usd: unknown > 0 || known === 0 ? null : Number(usd.toFixed(6)),
    knownParts: known,
    unknownParts: unknown,
  };
}

/**
 * Totals for one arm, pings INCLUDED. A ping without a measured cost makes the
 * whole arm cost unknown on purpose: leaving it out would fake a saving.
 *
 * @param {object} arm
 * @param {string[]} seeded Seeded bug ids of the fixture.
 * @returns {object}
 */
function summarizeArm(arm, seeded) {
  const roles = {};
  const turnCosts = [];
  const found = new Set();
  const tokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  let tokensComplete = true;
  const add = (row) => {
    for (const key of Object.keys(tokens)) {
      const value = num(row?.[key]);
      if (value == null) tokensComplete = false;
      else tokens[key] += value;
    }
  };
  for (const role of KEEP_ALIVE_BENCHMARK_ROLES) {
    const turns = Array.isArray(arm?.roles?.[role]?.turns) ? arm.roles[role].turns : [];
    roles[role] = { turns: turns.length };
    for (const turn of turns) {
      add(turn);
      turnCosts.push(turn?.costUsd);
      for (const id of Array.isArray(turn?.bugsFound) ? turn.bugsFound : []) {
        if (seeded.includes(String(id))) found.add(String(id));
      }
    }
  }
  const pings = Array.isArray(arm?.pings) ? arm.pings : [];
  for (const ping of pings) add(ping);
  const effective = pings.filter((ping) => ping?.effective === true).length;
  const turnCost = sumCosts(turnCosts);
  const pingCost = sumCosts(pings.map((ping) => ping?.costUsd));
  const total = sumCosts([...turnCosts, ...pings.map((ping) => ping?.costUsd)]);
  return {
    roles,
    wallTimeMs: num(arm?.wallTimeMs),
    tokens: tokensComplete ? tokens : null,
    cost: {
      turnsUsd: turnCost.usd,
      pingsUsd: pingCost.usd,
      totalUsd: total.usd,
      unknownParts: total.unknownParts,
      known: total.usd != null,
    },
    pings: { count: pings.length, effective, costKnown: pingCost.unknownParts === 0 },
    seededBugsFound: [...found].sort(),
    seededBugsTotal: seeded.length,
    recall: seeded.length > 0 ? Number((found.size / seeded.length).toFixed(4)) : null,
  };
}

/**
 * Builds the comparison report from measured (or simulated) observations.
 *
 * @param {{
 *   fixture?: { id?: string, version?: string|number, materialIds?: string[], seededBugs?: string[] },
 *   source?: string,
 *   tariff?: { known?: boolean, note?: string } | null,
 *   arms?: Record<string, object>,
 * }} input
 * @returns {object}
 */
export function buildKeepAliveBenchmarkReport(input = {}) {
  const fixture = input.fixture || {};
  const seeded = (Array.isArray(fixture.seededBugs) ? fixture.seededBugs : []).map(String);
  const armsInput = input.arms && typeof input.arms === 'object' ? input.arms : {};
  const arms = {};
  const fixtureVersions = new Set();
  const materials = new Set();
  for (const name of KEEP_ALIVE_BENCHMARK_ARMS) {
    const arm = armsInput[name];
    if (!arm) continue;
    arms[name] = summarizeArm(arm, seeded);
    fixtureVersions.add(String(arm.fixtureVersion ?? fixture.version ?? ''));
    materials.add(JSON.stringify([...(arm.materialIds || fixture.materialIds || [])].sort()));
  }
  const fresh = arms.fresh;
  const reuse = arms.reuse;
  const keep = arms.reuse_keep_alive;
  const delta = (a, b) => ({
    costUsd: minus(a?.cost?.totalUsd ?? null, b?.cost?.totalUsd ?? null),
    wallTimeMs: minus(a?.wallTimeMs ?? null, b?.wallTimeMs ?? null),
    recall: minus(a?.recall ?? null, b?.recall ?? null),
  });
  return {
    schema: 1,
    scope: KEEP_ALIVE_BENCHMARK_SCOPE,
    source: String(input.source || 'unknown'),
    fixture: { id: String(fixture.id || ''), version: String(fixture.version ?? '') },
    tariff: { known: input.tariff?.known === true, note: String(input.tariff?.note || '') },
    consistency: {
      sameFixtureVersion: fixtureVersions.size <= 1 && !fixtureVersions.has(''),
      sameMaterial: materials.size <= 1,
    },
    arms,
    // Positive costUsd = the first arm is MORE expensive; null = unknown.
    comparison: {
      reuseVsFresh: delta(reuse, fresh),
      keepAliveVsReuse: delta(keep, reuse),
      keepAliveVsFresh: delta(keep, fresh),
    },
  };
}

/**
 * Go/no-go gate. `go` needs a MEASURED report, identical fixture versions, all
 * three participants measured in every arm, a known tariff for every cost
 * including every ping, a net saving against both baselines, no quality loss
 * on the seeded bugs and mostly effective pings. Anything else is `no_go` with
 * the list of reasons.
 *
 * @param {object|null|undefined} report
 * @returns {{ decision: string, reasons: string[], measuredAt?: string }}
 */
export function evaluateKeepAliveGate(report) {
  const R = KEEP_ALIVE_GATE_REASON;
  const reasons = [];
  if (!report || typeof report !== 'object' || !report.arms) {
    return { decision: KEEP_ALIVE_GATE_DECISION.NO_GO, reasons: [R.MISSING_REPORT] };
  }
  if (report.source !== 'measured') reasons.push(R.NOT_MEASURED);
  if (report.consistency?.sameFixtureVersion !== true || report.consistency?.sameMaterial !== true) {
    reasons.push(R.FIXTURE_MISMATCH);
  }
  const arms = report.arms;
  for (const name of KEEP_ALIVE_BENCHMARK_ARMS) {
    if (!arms[name]) {
      reasons.push(R.MISSING_ARM);
      break;
    }
  }
  const complete = KEEP_ALIVE_BENCHMARK_ARMS.every((name) => arms[name]);
  if (complete) {
    const rolesOk = KEEP_ALIVE_BENCHMARK_ARMS.every((name) => KEEP_ALIVE_BENCHMARK_ROLES
      .every((role) => (arms[name].roles?.[role]?.turns || 0) > 0));
    if (!rolesOk) reasons.push(R.INCOMPLETE_ROLES);
    const costsKnown = KEEP_ALIVE_BENCHMARK_ARMS.every((name) => arms[name].cost?.known === true)
      && report.tariff?.known === true;
    if (!costsKnown) reasons.push(R.COST_UNKNOWN);
    const keep = arms.reuse_keep_alive;
    if (!(keep.pings?.count > 0)) reasons.push(R.NO_PINGS);
    else if (keep.pings.effective / keep.pings.count < MIN_EFFECTIVE_PING_RATIO) {
      reasons.push(R.PINGS_INEFFECTIVE);
    }
    if (costsKnown) {
      const vsFresh = report.comparison?.keepAliveVsFresh?.costUsd;
      const vsReuse = report.comparison?.keepAliveVsReuse?.costUsd;
      if (!(vsFresh < 0)) reasons.push(R.NO_NET_SAVING);
      if (!(vsReuse < 0)) reasons.push(R.NO_GAIN_OVER_REUSE);
    }
    const baseline = Math.max(arms.fresh.recall ?? 0, arms.reuse.recall ?? 0);
    if ((keep.recall ?? 0) < baseline) reasons.push(R.QUALITY_LOSS);
  }
  const unique = [...new Set(reasons)];
  return {
    decision: unique.length === 0 ? KEEP_ALIVE_GATE_DECISION.GO : KEEP_ALIVE_GATE_DECISION.NO_GO,
    reasons: unique,
  };
}

/**
 * Deterministic offline stand-in used to exercise the pipeline when no real
 * measurement exists. It is labelled `source: 'simulated'`, so the gate can
 * never return `go` for it, and it has no tariff, so every cost is unknown.
 *
 * @param {{ id?: string, version?: string|number, rounds?: number, seededBugs?: string[], materialIds?: string[] }} fixture
 * @returns {object} observations input for `buildKeepAliveBenchmarkReport`
 */
export function simulateKeepAliveObservations(fixture = {}) {
  const seeded = (Array.isArray(fixture.seededBugs) ? fixture.seededBugs : []).map(String);
  const rounds = Math.max(1, Math.floor(Number(fixture.rounds)) || 3);
  const arm = (name) => {
    const resumed = name !== 'fresh';
    const roles = {};
    KEEP_ALIVE_BENCHMARK_ROLES.forEach((role, roleIndex) => {
      const turns = [];
      for (let round = 1; round <= rounds; round += 1) {
        const warm = resumed && round > 1;
        turns.push({
          round,
          input: warm ? 400 : 4000,
          cachedInput: warm ? 3600 : 0,
          cacheWrite: warm ? 0 : 3600,
          output: 300,
          costUsd: null,
          // Bugs are spread deterministically over roles; every arm sees all.
          bugsFound: seeded.filter((_, i) => i % KEEP_ALIVE_BENCHMARK_ROLES.length === roleIndex),
        });
      }
      roles[role] = { turns };
    });
    const pings = name === 'reuse_keep_alive'
      ? KEEP_ALIVE_BENCHMARK_ROLES.map((role) => ({
        role, input: 50, cachedInput: 3600, cacheWrite: 0, output: 8, costUsd: null, effective: true,
      }))
      : [];
    return {
      fixtureVersion: String(fixture.version ?? ''),
      materialIds: fixture.materialIds || [],
      wallTimeMs: null,
      roles,
      pings,
    };
  };
  const arms = {};
  for (const name of KEEP_ALIVE_BENCHMARK_ARMS) arms[name] = arm(name);
  return { fixture, source: 'simulated', tariff: { known: false, note: 'no tariff supplied' }, arms };
}
