import './helpers/isolated-data-dir.js';
/**
 * Stage-9 acceptance/conformance suite, scenarios 7-10.
 *
 * Exercises production functions only (no re-implemented logic) against the
 * shared frozen fixture: model roles and hard eligibility (7), controlled
 * out-of-band exploration (8), shadow parity/overhead (9), and the
 * API/UI/CSV/usage-window sums (10).
 *
 * Every scenario shares `ACCEPTANCE_CUTOFF*` from
 * `tests/helpers/usage-acceptance-fixture.js`; time-dependent APIs get an
 * explicit `now` so nothing here reads the wall clock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  ACCEPTANCE_CUTOFF,
  ACCEPTANCE_CUTOFF_MS,
  ACCEPTANCE_TIME_ZONE,
  cutoffMinus,
  cutoffPlus,
} from './helpers/usage-acceptance-fixture.js';

import {
  DEFAULT_MODEL_ROLE_PROFILES,
  DEFAULT_ROLE_SCORE_WEIGHTS,
  MODEL_ROLE_UNKNOWN_FAMILY_REASON,
  describeModelRoleMatchers,
  describeRoleRejection,
  hasPremiumPickJustification,
  isFlashDelegationModel,
  listRolesForModel,
  normalizeModelRoleProfiles,
  selectModelPick,
} from '../lib/model-role-profiles.js';
import {
  MODEL_PICK_HARD_GATE_CODES,
  evaluateModelPickHardGates,
} from '../lib/model-pick-hard-gates.js';
import {
  MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
  MODEL_PICK_SHADOW_CONFIG_DEFAULTS,
  MODEL_PICK_SHADOW_MAX_OVERHEAD_MS,
  MODEL_PICK_SHADOW_POLICY_VERSION,
  composeModelPickExploreSegment,
  normalizeModelPickExploreConfig,
} from '../lib/model-pick-policy.js';
import {
  computeModelPickExploreCredits,
  countAutoExecutedWorkload,
  evaluateModelPickExploration,
  exploreCandidateBlocks,
  exploreTaskBlocks,
  finishModelPickExploreAttemptForDelegation,
  modelPickExploreCooldownMs,
  releaseModelPickExploreAttemptForDelegation,
  reserveModelPickExploreBudget,
  startModelPickExploreAttemptForDelegation,
} from '../lib/model-pick-explore.js';
import {
  loadModelPickExploreAttempts,
  reserveModelPickExploreAttempt,
} from '../lib/persist/model-pick-explore-persist.js';
import {
  applyShadowLayer,
  blendedPricePerMillion,
  reviewPassRateInfluencesScore,
  scoreShadowCandidates,
} from '../lib/model-pick-shadow.js';
import { evaluateShadowRolloutGate } from '../lib/model-pick-shadow-gates.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import { resolveUsageWindow } from '../lib/usage/usage-window.js';
import {
  buildUsageCoverage,
  buildUsageInsights,
  filterUsageEvents,
  sumUsageTokenBuckets,
} from '../lib/usage/usage-insights.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import {
  buildCsv,
  coverageViewRows,
  exportMetaRows,
  tokenBucketRows,
} from '../app_front/features/usage/usageCharts.js';

const NOW = ACCEPTANCE_CUTOFF_MS;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scenario 7 fixtures: frozen harnesses / favorites / history
// ---------------------------------------------------------------------------

const S7_HARNESSES = Object.freeze([
  Object.freeze({ id: 'sdk', enabled: true, ready: true, can_delegate: true }),
  Object.freeze({ id: 'codex', enabled: true, ready: true, can_delegate: true }),
]);

const S7_MODELS = Object.freeze({
  sdk: Object.freeze({
    favorites_configured: true,
    items: Object.freeze([
      Object.freeze({ id: 'grok-4.6::effort=high', cost_tier: 2, quality_tier: 4, speed_tier: 4 }),
      Object.freeze({ id: 'glm-5.3', cost_tier: 2, quality_tier: 4, speed_tier: 3 }),
      Object.freeze({ id: 'mystery-model-9000', cost_tier: 2, quality_tier: 4, speed_tier: 3 }),
    ]),
  }),
});

const S7_SOL_ONLY_MODELS = Object.freeze({
  sdk: Object.freeze({
    favorites_configured: true,
    items: Object.freeze([
      Object.freeze({ id: 'gpt-5.6-sol', cost_tier: 2, quality_tier: 4, speed_tier: 4 }),
      Object.freeze({ id: 'mystery-model-9000', cost_tier: 2, quality_tier: 3, speed_tier: 3 }),
    ]),
  }),
});

const S7_HISTORY = Object.freeze({ pickIndex: 0 });

// ---------------------------------------------------------------------------
// Scenario 8 helpers / fixtures
// ---------------------------------------------------------------------------

/**
 * @param {{ task?: object }} [overrides]
 * @returns {object}
 */
function s8Context(overrides = {}) {
  return {
    task: {
      kind: 'implement',
      boundedChanges: true,
      reviewMandatory: true,
      remainingDeadlineMs: HOUR_MS,
      executorMaxMs: 3 * 60 * 1000,
      ...overrides.task,
    },
  };
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {number} n
 * @returns {object}
 */
function s8OutOfBandCandidate(harness, model, n) {
  return { harness, model, in_band: false, observed: { n }, cost_tier: 3, score: 0.1 };
}

// ---------------------------------------------------------------------------
// Scenario 9 helpers / fixtures
// ---------------------------------------------------------------------------

const S9_HARNESSES = Object.freeze([
  Object.freeze({ id: 'codex', enabled: true, ready: true, can_delegate: true }),
]);
const S9_MODELS = Object.freeze({
  codex: Object.freeze({
    favorites_configured: true,
    items: Object.freeze([
      Object.freeze({ id: 'gpt-5.6-sol' }),
      Object.freeze({ id: 'gpt-6.1-sol' }),
    ]),
  }),
});
const S9_HISTORY = Object.freeze({ pickIndex: 0 });

/**
 * @param {string} harness
 * @param {string} model
 * @param {number} score
 * @param {object | null} [observed]
 * @returns {object}
 */
function s9Candidate(harness, model, score, observed = null) {
  return {
    harness,
    model,
    label: model,
    provider: 'openai',
    cost_tier: 2,
    quality_tier: 3,
    speed_tier: 3,
    score,
    observed,
  };
}

/** @param {{ harness?: string, model?: string }} input */
function s9IdentityOf(input) {
  if (input.harness === 'matched') {
    return {
      aliasStatus: 'matched',
      aliasReason: 'exact-match',
      provider: 'openai',
      externalModelId: input.model,
      harness: input.harness,
      model: input.model,
    };
  }
  return {
    aliasStatus: 'unmatched',
    aliasReason: 'no-exact-alias',
    provider: null,
    externalModelId: null,
    harness: input.harness,
    model: input.model,
  };
}

/**
 * @param {string} model
 * @param {string} [prompt]
 * @param {string} [completion]
 * @returns {object}
 */
function s9EndpointEntry(model, prompt = '0.000001', completion = '0.000002') {
  const fetchedAt = new Date(NOW).toISOString();
  return {
    modelId: model,
    name: model,
    pricing: { prompt, completion },
    kind: 'estimate',
    source: 'openrouter-catalog',
    source_class: 'endpoint_catalog',
    source_version: 'openrouter-model-pricing-2026-10-08',
    billing_class: 'api_metered',
    attribution: 'acceptance fixture',
    fetched_at: fetchedAt,
    observed_at: fetchedAt,
    stale_after_ms: NOW,
  };
}

// ---------------------------------------------------------------------------
// Scenario 10 fixtures: frozen usage events and runs
// ---------------------------------------------------------------------------

/**
 * @param {object} partial
 * @param {object} [overrides]
 * @returns {object}
 */
function s10Event(partial, overrides = {}) {
  return Object.freeze({ ...createUsageEvent(partial), ...overrides });
}

const S10_EVENTS = Object.freeze([
  s10Event({
    id: 's10-actual-cache',
    at: cutoffMinus(2 * HOUR_MS),
    provider: 'cursor',
    harness: 'sdk',
    role: 'implement',
    feature: 'chat',
    eventType: 'delta',
    runId: 's10-run-impl',
    tokens: { textInput: 1000, textOutput: 100, cachedInput: 900, cacheWrite: 50, reasoning: 20 },
  }, { usd: 1.5, estimated: false }),
  s10Event({
    id: 's10-estimated',
    at: cutoffMinus(HOUR_MS),
    provider: 'cursor',
    harness: 'sdk',
    role: 'implement',
    feature: 'chat',
    eventType: 'delta',
    runId: 's10-run-impl',
    tokens: { textInput: 200, textOutput: 20 },
  }, { usd: 0.5, estimated: true }),
  s10Event({
    id: 's10-subscription',
    at: cutoffMinus(30 * 60 * 1000),
    provider: 'other',
    harness: 'claude',
    role: 'review',
    feature: 'chat',
    eventType: 'delta',
    runId: 's10-run-review',
    billingMode: 'subscription',
    tokens: { textInput: 40 },
  }),
  s10Event({
    id: 's10-reported',
    at: cutoffMinus(20 * 60 * 1000),
    provider: 'other',
    harness: 'claude',
    role: 'review',
    feature: 'chat',
    eventType: 'delta',
    runId: 's10-run-review',
    reportedUsd: 2,
    tokens: { textInput: 10 },
  }, { usd: 2, estimated: false }),
]);

const S10_RUNS = Object.freeze([
  Object.freeze({
    runId: 's10-run-impl',
    role: 'implement',
    harness: 'sdk',
    status: 'ended',
    completeness: 'complete',
    coverage: Object.freeze({ proof: true }),
  }),
  Object.freeze({
    runId: 's10-run-review',
    role: 'review',
    harness: 'claude',
    status: 'ended',
    completeness: 'partial',
    coverage: Object.freeze({ proof: false }),
  }),
]);

// ===========================================================================
// SCENARIO 7 — model roles and eligibility
// ===========================================================================

test('scenario 7: role eligibility matches verified families, variants, aliases and the unknown-family fallback', () => {
  // A verified, role-capable family appears for the right role.
  assert.deepEqual([...listRolesForModel('grok-4.6::effort=high')].sort(), ['fix', 'plan', 'review']);
  // Variants collapse to the base family (params are stripped before matching).
  assert.deepEqual(listRolesForModel('grok-4.6::effort=high'), listRolesForModel('grok-4.6'));
  // A *flash* model keeps implement/fix but never autonomous review.
  assert.ok(listRolesForModel('glm-5.3-flash').includes('implement'));
  assert.equal(listRolesForModel('glm-5.3-flash').includes('review'), false);
  // An exact alias resolves to the Sol family.
  assert.deepEqual([...listRolesForModel('gpt-5.6')].sort(), ['fix', 'implement', 'plan']);
  // Provenance is readable: a built-in policy family, verified.
  const matchers = describeModelRoleMatchers('grok-4.6::effort=high');
  assert.equal(matchers.review.eligible, true);
  assert.equal(matchers.review.matched[0].source, 'policy');
  assert.equal(matchers.review.matched[0].verified, true);

  // A role-incapable verified family is excluded with a readable cause.
  assert.equal(describeRoleRejection('gpt-5.6-sol', 'review'), 'role-mismatch');
  // An unknown family gets the documented fallback reason and no role at all.
  assert.equal(MODEL_ROLE_UNKNOWN_FAMILY_REASON, 'unknown-family');
  assert.equal(describeRoleRejection('mystery-model-9000', 'implement'), MODEL_ROLE_UNKNOWN_FAMILY_REASON);
  assert.deepEqual(listRolesForModel('mystery-model-9000'), []);
  assert.equal(DEFAULT_MODEL_ROLE_PROFILES.implement.length > 0, true);

  // An explicit operator override is an assertion: it grants a role to an id the
  // alias policy does not know, without leaking into the other roles.
  const overridden = normalizeModelRoleProfiles({
    implement: Object.freeze([Object.freeze({ pattern: 'mystery-model', priority: 0 })]),
  });
  assert.ok(listRolesForModel('mystery-model-9000', overridden).includes('implement'));
  assert.equal(listRolesForModel('mystery-model-9000', overridden).includes('review'), false);

  const planPick = selectModelPick({
    role: 'plan',
    harnesses: S7_HARNESSES,
    modelsByHarness: S7_MODELS,
    history: S7_HISTORY,
    now: NOW,
  });
  assert.equal(planPick.ok, true, planPick.error);
  assert.ok(['grok-4.6::effort=high', 'glm-5.3'].includes(planPick.pick.model));
  assert.ok(!planPick.candidates.some((candidate) => candidate.model === 'mystery-model-9000'));

  // Role review has no capable favorite in this frozen set: MODEL_UNAVAILABLE
  // names the role mismatch instead of silently picking something else.
  const reviewPick = selectModelPick({
    role: 'review',
    harnesses: S7_HARNESSES,
    modelsByHarness: S7_SOL_ONLY_MODELS,
    history: S7_HISTORY,
    now: NOW,
  });
  assert.equal(reviewPick.ok, false);
  assert.equal(reviewPick.code, 'MODEL_UNAVAILABLE');
  assert.match(reviewPick.error, /not eligible for role "review"/);
});

test('scenario 7: hard gates (favorites, readiness, lockout, excludes) stay hard and match the picker', () => {
  const future = cutoffPlus(HOUR_MS);
  const past = cutoffMinus(HOUR_MS);

  // Favorites: an empty/unconfigured store is a hard refusal, and a model that
  // is not an enabled favorite is refused even when the store is configured.
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement', harness: 'sdk', model: 'grok-4.6', favoritesConfigured: false, checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement', harness: 'sdk', model: 'grok-4.6', favoriteModels: [], checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'sdk',
      model: 'grok-4.6',
      favoritesConfigured: true,
      favoriteModels: ['gpt-5.6-sol'],
      checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_NOT_FAVORITE,
  );

  // enabled / ready / delegatable.
  for (const harnessRow of [
    { enabled: false, ready: true, can_delegate: true },
    { enabled: true, ready: false, can_delegate: true },
    { enabled: true, ready: true, can_delegate: false },
  ]) {
    assert.equal(
      evaluateModelPickHardGates({
        role: 'implement', harness: 'sdk', model: 'grok-4.6', harnessRow, checkReviewAdapter: false,
      }).code,
      MODEL_PICK_HARD_GATE_CODES.HARNESS_UNAVAILABLE,
    );
  }

  // Lockout is hard while active, and an expired row never blocks.
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'sdk',
      model: 'grok-4.6',
      lockouts: [{ harness: 'sdk', model: 'grok-4.6', resetAt: future }],
      now: NOW,
      checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'sdk',
      model: 'grok-4.6',
      lockouts: [{ harness: 'sdk', model: 'grok-4.6', resetAt: past }],
      now: NOW,
      checkReviewAdapter: false,
    }).ok,
    true,
  );

  // Caller excludes and the allow-list.
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement', harness: 'sdk', model: 'grok-4.6', excludeModels: ['grok-4.6'], checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement', harness: 'sdk', model: 'grok-4.6', excludeHarnesses: ['sdk'], checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement', harness: 'sdk', model: 'grok-4.6', allowedHarnesses: ['codex'], checkReviewAdapter: false,
    }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_NOT_ALLOWED,
  );

  // Picker parity: the picker admits exactly the pairs the validator accepts.
  const harnesses = [
    { id: 'sdk', enabled: true, ready: true, can_delegate: true },
    { id: 'codex', enabled: true, ready: true, can_delegate: true },
  ];
  const modelsByHarness = {
    sdk: {
      favorites_configured: true,
      items: [{ id: 'grok-4.6', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 4 }],
    },
    codex: {
      favorites_configured: true,
      items: [
        { id: 'gpt-5.6-sol', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 4 },
        { id: 'gpt-5.6-luna', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 4 },
      ],
    },
  };
  const lockouts = [{ harness: 'codex', model: 'gpt-5.6-sol', resetAt: future }];
  const picked = selectModelPick({
    role: 'implement',
    harnesses,
    modelsByHarness,
    history: { pickIndex: 0, lockouts },
    excludeModel: 'grok-4.6',
    now: NOW,
  });
  assert.equal(picked.ok, true, picked.error);
  assert.deepEqual(picked.candidates.map((candidate) => `${candidate.harness}/${candidate.model}`), ['codex/gpt-5.6-luna']);
  const pairs = [
    ['sdk', 'grok-4.6'],
    ['codex', 'gpt-5.6-sol'],
    ['codex', 'gpt-5.6-luna'],
  ];
  for (const [harness, model] of pairs) {
    const verdict = evaluateModelPickHardGates({
      role: 'implement',
      harness,
      model,
      harnessRow: harnesses.find((row) => row.id === harness),
      favoritesConfigured: true,
      favoriteModels: modelsByHarness[harness].items.map((row) => row.id),
      excludeModels: ['grok-4.6'],
      lockouts,
      now: NOW,
    });
    const admitted = picked.candidates.some((candidate) => candidate.harness === harness && candidate.model === model);
    assert.equal(admitted, verdict.ok, `${harness}/${model} picker/validator parity`);
  }
});

test('scenario 7: autonomous review never picks flash; named flash and premium review need the confirmation gate', () => {
  assert.equal(isFlashDelegationModel('deepseek-v4.1-flash'), true);
  assert.equal(isFlashDelegationModel('glm-5.3-flashx'), true);
  assert.equal(isFlashDelegationModel('flashlight-9b'), false);

  // The automatic picker drops the only flash reviewer: MODEL_UNAVAILABLE.
  const flashPick = selectModelPick({
    role: 'review',
    harnesses: S7_HARNESSES,
    modelsByHarness: {
      sdk: {
        favorites_configured: true,
        items: [{ id: 'deepseek-v4.1-flash', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 4 }],
      },
    },
    history: S7_HISTORY,
    now: NOW,
  });
  assert.equal(flashPick.ok, false);
  assert.equal(flashPick.code, 'MODEL_UNAVAILABLE');
  assert.match(flashPick.error, /flash model\(s\) skipped for review/);

  // A named flash review is refused without the explicit confirmation gate.
  const refused = evaluateModelPickHardGates({
    role: 'review',
    harness: 'deepseek',
    model: 'deepseek-v4.1-flash',
    checkReviewAdapter: false,
    now: NOW,
  });
  assert.equal(refused.code, MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW);
  assert.match(refused.error, /confirm_flash_review/);
  // ...and allowed only with the confirmation (adapter guarantee still separate).
  assert.equal(
    evaluateModelPickHardGates({
      role: 'review',
      harness: 'deepseek',
      model: 'deepseek-v4.1-flash',
      checkReviewAdapter: false,
      allowFlashReview: true,
      now: NOW,
    }).ok,
    true,
  );

  // Premium review needs a substantive justification or an explicit override.
  assert.equal(hasPremiumPickJustification(''), false);
  assert.equal(hasPremiumPickJustification('   '), false);
  assert.equal(hasPremiumPickJustification('Unusually complex migration review'), true);
  const premiumBase = {
    role: 'review',
    harness: 'sdk',
    model: 'grok-4.7',
    costTier: 5,
    checkReviewAdapter: false,
    now: NOW,
  };
  assert.equal(evaluateModelPickHardGates(premiumBase).code, MODEL_PICK_HARD_GATE_CODES.PREMIUM_JUSTIFICATION);
  assert.equal(evaluateModelPickHardGates({ ...premiumBase, pickReason: 'Unusually complex migration review' }).ok, true);
  assert.equal(evaluateModelPickHardGates({ ...premiumBase, allowPremium: true }).ok, true);
});

// ===========================================================================
// SCENARIO 8 — controlled exploration
// ===========================================================================

test('scenario 8: cold-start out-of-band pair reports would-explore in dry-run; off omits explore and the pick is unchanged', () => {
  const harnesses = Object.freeze([
    Object.freeze({ id: 'band-a', enabled: true, ready: true, can_delegate: true }),
    Object.freeze({ id: 'explore-b', enabled: true, ready: true, can_delegate: true }),
  ]);
  const modelsByHarness = Object.freeze({
    'band-a': Object.freeze({
      favorites_configured: true,
      items: Object.freeze([
        Object.freeze({ id: 'winner-model', roles: Object.freeze(['implement']), cost_tier: 1, quality_tier: 5, speed_tier: 4 }),
      ]),
    }),
    'explore-b': Object.freeze({
      favorites_configured: true,
      items: Object.freeze([
        Object.freeze({ id: 'glm-4.6', roles: Object.freeze(['implement']), cost_tier: 3, quality_tier: 2, speed_tier: 2 }),
      ]),
    }),
  });
  const history = Object.freeze({
    pickIndex: 0,
    observed: Object.freeze({ 'explore-b/glm-4.6': Object.freeze({ n: 2, infra_fail_rate: 0, pass_rate: 0.5 }) }),
    lockouts: Object.freeze([]),
    planLimits: Object.freeze([]),
  });
  const base = Object.freeze({
    role: 'implement',
    harnesses,
    modelsByHarness,
    history,
    now: NOW,
    rotation: 'balanced',
    adaptive: true,
    weights: DEFAULT_ROLE_SCORE_WEIGHTS,
  });
  const exploreLedger = Object.freeze({ attempts: Object.freeze([]), autoExecuted: 20, workspaceKey: 'ws-acceptance' });
  const exploreContext = Object.freeze(s8Context());

  const normal = selectModelPick({ ...base });
  const dry = selectModelPick({
    ...base,
    exploreConfig: normalizeModelPickExploreConfig({ mode: 'dry-run' }),
    exploreLedger,
    exploreContext,
  });
  assert.equal(dry.explore?.wouldExplore, true);
  assert.equal(dry.explore?.started, false);
  assert.equal(dry.explore?.candidate?.harness, 'explore-b');
  assert.equal(dry.pick.harness, normal.pick.harness);
  assert.equal(dry.pick.model, normal.pick.model);
  assert.equal(dry.rotation.out_of_band_explore, false);

  const off = selectModelPick({
    ...base,
    exploreConfig: normalizeModelPickExploreConfig({ mode: 'off' }),
    exploreLedger,
    exploreContext,
  });
  assert.equal(off.explore, undefined, 'mode off keeps the pre-exploration shape');
  assert.deepEqual(off.pick, normal.pick);
});

test('scenario 8: deterministic ordering and task/time/cost guards', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const candidates = [s8OutOfBandCandidate('h', 'a', 1), s8OutOfBandCandidate('h', 'b', 1)];
  const input = {
    role: 'implement',
    pick: { harness: 'x', model: 'w', in_band: true, keep_winner: false },
    candidates,
    config,
    attempts: [],
    autoExecuted: 50,
    workspaceKey: 'ws',
    context: s8Context(),
    now: NOW,
  };
  const first = evaluateModelPickExploration(input);
  const second = evaluateModelPickExploration({ ...input, candidates: [...candidates], attempts: [] });
  assert.deepEqual(second, first);
  assert.equal(first.pairKey, 'h/a/implement', 'stable tie order by pair key');

  // Plan and review roles never explore.
  for (const role of ['plan', 'review']) {
    const assessment = evaluateModelPickExploration({
      role,
      pick: null,
      candidates,
      config,
      attempts: [],
      autoExecuted: 100,
      workspaceKey: 'ws',
      context: s8Context({ task: { kind: role, boundedChanges: true, reviewMandatory: true } }),
      now: NOW,
    });
    assert.equal(assessment?.wouldExplore, false, `${role} must not explore`);
  }

  // Workflow guards: no fix-after-fail, no last round.
  assert.ok(
    exploreTaskBlocks({
      role: 'fix',
      config,
      context: s8Context({ task: { kind: 'fix', afterFail: true, boundedChanges: true, reviewMandatory: true } }),
      now: NOW,
    }).includes('fix_after_fail'),
  );
  assert.ok(
    exploreTaskBlocks({
      role: 'implement',
      config,
      context: s8Context({ task: { kind: 'implement', lastRound: true, boundedChanges: true, reviewMandatory: true } }),
      now: NOW,
    }).includes('last_round'),
  );

  // Cost guard: a metered pair needs a trustworthy, enforceable upper bound.
  assert.ok(
    exploreCandidateBlocks({
      candidate: s8OutOfBandCandidate('h', 'm', 1),
      pick: { in_band: true },
      config,
      metering: { billing: 'metered', priceTrusted: false, enforcement: 'none' },
    }).includes('cost_not_enforceable'),
  );
  // A subscription pair above the fallback tier needs the explicit premium opt-in.
  const expensive = { ...s8OutOfBandCandidate('h', 'm', 1), cost_tier: 5 };
  const blocks = exploreCandidateBlocks({
    candidate: expensive,
    pick: { in_band: true },
    config,
    metering: { billing: 'subscription' },
  });
  assert.ok(blocks.includes('cost_tier_above_fallback'));
  assert.ok(blocks.includes('premium_opt_in'));
});

test('scenario 8: atomic idempotent budget reserve and a refused start releases the slot', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's8-explore-')), 'model-pick-explore.json');
  const config = normalizeModelPickExploreConfig({ mode: 'real', everyAutoExecuted: 1 });
  const marker = Object.freeze({
    pairKey: 'h/m/implement',
    harness: 'h',
    model: 'm',
    baseModel: 'm',
    role: 'implement',
    segment: composeModelPickExploreSegment(config),
    budgetUsd: 0.5,
    maxExecutorMs: 300000,
  });
  const base = Object.freeze({
    marker,
    pickId: 'pick-s8',
    workspaceKey: 'ws-s8',
    config,
    delegations: Object.freeze([
      Object.freeze({ pickOrigin: 'auto', pickRole: 'implement', status: 'completed', startedAt: new Date(NOW).toISOString() }),
    ]),
    context: s8Context(),
    file,
    now: NOW,
  });

  const first = await reserveModelPickExploreBudget({ ...base, delegationId: 'd1', idempotencyKey: 'k1' });
  assert.equal(first.ok, true, first.error);
  const second = await reserveModelPickExploreBudget({ ...base, delegationId: 'd2', idempotencyKey: 'k2' });
  assert.equal(second.ok, false, 'a second start cannot take the same credit');
  const replay = await reserveModelPickExploreBudget({ ...base, delegationId: 'd1', idempotencyKey: 'k1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(loadModelPickExploreAttempts({ file }).length, 1);

  // A refused start rolls the reservation back: no open slot is left behind.
  assert.equal(releaseModelPickExploreAttemptForDelegation({ delegationId: 'd1', file }), true);
  const open = loadModelPickExploreAttempts({ file })
    .filter((row) => row.status === 'reserved' || row.status === 'started');
  assert.equal(open.length, 0);
});

test('scenario 8: cooldown follows infra_fail/timeout, never cancelled; cancel is not quality evidence', async () => {
  const config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  assert.equal(modelPickExploreCooldownMs({ outcome: 'infra_fail', config }), config.infraCooldownMs);
  assert.equal(modelPickExploreCooldownMs({ outcome: 'timeout', config }), Math.max(config.minPairIntervalMs, config.infraCooldownMs));
  assert.equal(modelPickExploreCooldownMs({ outcome: 'cancelled', config }), 0);
  assert.equal(modelPickExploreCooldownMs({ outcome: 'completed', config }), 0);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's8-cooldown-')), 'model-pick-explore.json');
  const marker = Object.freeze({ mode: 'real', pairKey: 'h/m/implement', harness: 'h', model: 'm', role: 'implement' });
  await reserveModelPickExploreAttempt({
    pairKey: 'h/m/implement',
    harness: 'h',
    model: 'm',
    role: 'implement',
    delegationId: 'd-cancel',
    idempotencyKey: 'cancel-1',
    file,
    now: NOW,
  });
  const started = startModelPickExploreAttemptForDelegation({ delegationId: 'd-cancel', marker, file, now: NOW });
  assert.equal(started?.status, 'started');
  const cancelled = finishModelPickExploreAttemptForDelegation({
    delegationId: 'd-cancel',
    outcome: 'cancelled',
    marker,
    file,
    now: NOW,
  });
  assert.equal(cancelled?.outcome, 'cancelled');
  assert.ok(!cancelled?.cooldownUntil, 'a user cancel does not lock the pair out or rate quality');

  const failMarker = Object.freeze({ mode: 'real', pairKey: 'h/m2/implement', harness: 'h', model: 'm2', role: 'implement' });
  await reserveModelPickExploreAttempt({
    pairKey: 'h/m2/implement',
    harness: 'h',
    model: 'm2',
    role: 'implement',
    delegationId: 'd-infra',
    idempotencyKey: 'infra-1',
    file,
    now: NOW,
  });
  startModelPickExploreAttemptForDelegation({ delegationId: 'd-infra', marker: failMarker, file, now: NOW });
  const failed = finishModelPickExploreAttemptForDelegation({
    delegationId: 'd-infra',
    outcome: 'infra_fail',
    marker: failMarker,
    file,
    now: NOW,
  });
  assert.equal(failed?.outcome, 'infra_fail');
  assert.ok(failed?.cooldownUntil, 'an infra fail locks the pair for the configured cooldown');
});

test('scenario 8: credits earn one slot per ten auto jobs and exclude manual jobs', () => {
  assert.deepEqual(
    computeModelPickExploreCredits({ autoExecuted: 25, consumed: 2, everyAutoExecuted: 10 }),
    { earned: 2, consumed: 2, remaining: 0 },
  );
  assert.deepEqual(
    computeModelPickExploreCredits({ autoExecuted: 9, consumed: 0, everyAutoExecuted: 10 }),
    { earned: 0, consumed: 0, remaining: 0 },
  );
  assert.deepEqual(
    computeModelPickExploreCredits({ autoExecuted: 10, consumed: 0, everyAutoExecuted: 10 }),
    { earned: 1, consumed: 0, remaining: 1 },
  );

  // Manual, queued/rejected and non-working roles never enter the denominator.
  const rows = [
    { pickOrigin: 'manual', pickRole: 'implement', status: 'completed', startedAt: new Date(NOW).toISOString() },
    { pickOrigin: 'auto', pickRole: 'implement', status: 'queued', startedAt: new Date(NOW).toISOString() },
    { pickOrigin: 'auto', pickRole: 'implement', status: 'running', startedAt: new Date(NOW).toISOString() },
    { pickOrigin: 'auto', pickRole: 'review', status: 'completed', startedAt: new Date(NOW).toISOString() },
  ];
  assert.equal(countAutoExecutedWorkload(rows, { now: NOW }), 1);
});

// ===========================================================================
// SCENARIO 9 — shadow parity and overhead
// ===========================================================================

test('scenario 9: shadow policy version and flags are stable and the observer is selection-neutral', () => {
  assert.equal(MODEL_PICK_SHADOW_POLICY_VERSION, 'shadow-policy-2026-10-09');
  assert.equal(MODEL_PICK_SHADOW_CONFIG_DEFAULTS.mode, 'shadow');
  assert.equal(MODEL_PICK_SHADOW_CONFIG_DEFAULTS.promotion, false);
  assert.equal(MODEL_PICK_SHADOW_CONFIG_DEFAULTS.maxOverheadMs, MODEL_PICK_SHADOW_MAX_OVERHEAD_MS);
  assert.equal(MODEL_PICK_SHADOW_MAX_OVERHEAD_MS, 20);

  const base = Object.freeze({
    role: 'implement',
    harnesses: S9_HARNESSES,
    modelsByHarness: S9_MODELS,
    history: S9_HISTORY,
    now: NOW,
    explore: false,
  });
  const plain = pickModelForPurpose({ ...base, shadow: false });
  const shadowed = pickModelForPurpose({ ...base, shadowConfig: { mode: 'shadow' } });
  assert.equal(plain.ok, true);
  assert.equal(shadowed.ok, true);
  assert.deepEqual(shadowed.pick, plain.pick, 'the primary pick is identical');
  assert.deepEqual(shadowed.picks, plain.picks);
  assert.deepEqual(shadowed.candidates, plain.candidates, 'candidate order/scores are identical');
  assert.equal(JSON.stringify(shadowed.candidates), JSON.stringify(plain.candidates), 'byte-identical candidates');
  assert.equal(plain.shadow_top, undefined, 'the observer off adds nothing');

  // applyShadowLayer is additive and never mutates its input.
  const raw = selectModelPick({
    role: 'implement',
    harnesses: S9_HARNESSES,
    modelsByHarness: S9_MODELS,
    history: S9_HISTORY,
    now: NOW,
    rotation: 'balanced',
    adaptive: true,
    weights: DEFAULT_ROLE_SCORE_WEIGHTS,
  });
  const before = JSON.stringify(raw.candidates);
  const layered = applyShadowLayer(raw, { role: 'implement', now: NOW, config: { mode: 'shadow' } });
  assert.equal(JSON.stringify(raw.candidates), before, 'applyShadowLayer must not mutate candidates');
  assert.equal(layered.pick, raw.pick);
  assert.deepEqual(layered.pick, raw.pick);
  assert.ok(layered.shadow_top, 'shadow_top is added');
  assert.ok(layered.shadow_explanation, 'an explanation is added');
  assert.ok(layered.shadow_agreement, 'an agreement record is added');
  assert.equal(layered.shadow_explanation.eligibility_parity, true);
  assert.equal(layered.shadow_explanation.selected_unchanged, true);
});

test('scenario 9: the shadow layer makes zero network requests', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('network is forbidden inside model_pick');
  };
  try {
    const picked = pickModelForPurpose({
      role: 'implement',
      harnesses: S9_HARNESSES,
      modelsByHarness: S9_MODELS,
      history: S9_HISTORY,
      now: NOW,
      explore: false,
      shadowConfig: { mode: 'shadow' },
    });
    assert.equal(picked.ok, true, picked.error);
    assert.ok(picked.shadow_top, 'the observer ran');
    assert.ok(picked.shadow_agreement);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, 'the whole pick path with the observer on makes zero requests');
});

test('scenario 9: shadow p99 overhead stays within the 20 ms budget over 300 calls', () => {
  const candidates = [];
  for (let i = 0; i < 12; i += 1) {
    candidates.push(s9Candidate('matched', i % 2 === 0 ? 'cheap' : 'pricey', 0.5 - (i * 0.001), {
      n: 10,
      median_min: 2 + i,
      median_tokens_per_sec: 50 - i,
    }));
  }
  const priceFor = (_candidate, identity) => (
    identity.externalModelId === 'cheap'
      ? s9EndpointEntry('cheap', '0.000001', '0.000002')
      : s9EndpointEntry('pricey', '0.000010', '0.000020')
  );
  const run = () => scoreShadowCandidates({
    role: 'implement',
    selected: candidates[0],
    candidates,
    now: NOW,
    config: { mode: 'shadow' },
    priceFor,
    identityOf: s9IdentityOf,
  });
  for (let warm = 0; warm < 20; warm += 1) run();
  const samples = [];
  for (let i = 0; i < 300; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p99 = samples[Math.min(samples.length - 1, Math.ceil(0.99 * samples.length) - 1)];
  assert.ok(
    p99 <= MODEL_PICK_SHADOW_MAX_OVERHEAD_MS,
    `shadow p99 ${p99.toFixed(3)}ms must be <= ${MODEL_PICK_SHADOW_MAX_OVERHEAD_MS}ms`,
  );
});

test('scenario 9: the 2584cd05 rollout gate stays dormant and review pass-rate never enters the score', () => {
  const strongArm = {
    promotionEnabled: true,
    decidedCycles: 25,
    passRate: { successes: 80, n: 100 },
    baselinePassRate: { successes: 50, n: 100 },
    infraFailRate: 0.1,
    baselineInfraFailRate: 0.1,
    usdPerSuccess: 1,
    baselineUsdPerSuccess: 1,
  };
  const dormant = evaluateShadowRolloutGate({ ...strongArm, promotionEnabled: false });
  assert.equal(dormant.dormant, true);
  assert.equal(dormant.eligible, false);
  assert.ok(dormant.reasons.includes('promotion-disabled'));
  assert.equal(evaluateShadowRolloutGate(strongArm).eligible, true, 'the numbers qualify, promotion does not');

  const high = s9Candidate('matched', 'cheap', 0.5, { n: 10, pass_rate: 0.9, quality: 4.6, median_min: 2 });
  const low = s9Candidate('matched', 'cheap', 0.5, { n: 10, pass_rate: 0.1, quality: 1.4, median_min: 2 });
  const shadowHigh = scoreShadowCandidates({
    role: 'review', selected: high, candidates: [high], now: NOW, config: { mode: 'shadow' }, priceFor: () => null, identityOf: s9IdentityOf,
  });
  const shadowLow = scoreShadowCandidates({
    role: 'review', selected: low, candidates: [low], now: NOW, config: { mode: 'shadow' }, priceFor: () => null, identityOf: s9IdentityOf,
  });
  assert.equal(shadowHigh.scores[0].shadow_score, shadowLow.scores[0].shadow_score, 'verdict pass-rate never moves the score');
  assert.equal(shadowHigh.explanation.review_pass_rate_in_quality_score, false);
  assert.equal(reviewPassRateInfluencesScore('review', [{ quality_source: 'pass_rate' }]), true);
  assert.equal(reviewPassRateInfluencesScore('review', [{ quality_source: 'existing-observed-blend' }]), false);
  assert.equal(reviewPassRateInfluencesScore('implement', [{ quality_source: 'pass_rate' }]), false);
});

test('scenario 9: subscription/local/unknown pairs are never charged a hypothetical API price', () => {
  const candidate = s9Candidate('matched', 'cheap', 0.5, { n: 4, median_min: 2 });
  const priceFor = () => s9EndpointEntry('cheap', '0.000001', '0.000002');
  assert.equal(blendedPricePerMillion({ prompt: '0.000001' }), 1);
  assert.equal(blendedPricePerMillion({ prompt: '0.000001', completion: '0.000003' }), 2);
  assert.equal(blendedPricePerMillion({}), null);
  assert.equal(blendedPricePerMillion(null), null);

  for (const billingClass of ['subscription_quota', 'local', 'unknown']) {
    const shadow = scoreShadowCandidates({
      role: 'implement',
      selected: candidate,
      candidates: [candidate],
      now: NOW,
      config: { mode: 'shadow' },
      priceFor,
      billingClassOf: () => billingClass,
      identityOf: s9IdentityOf,
    });
    assert.equal(shadow.scores[0].applied, false, `${billingClass} must not use an API price`);
    assert.equal(shadow.scores[0].skipped_reason, `billing-class-${billingClass}`);
    assert.equal(shadow.scores[0].cost_adjustment, 0);
    assert.equal(shadow.scores[0].cost_source, 'missing', 'a missing price is not a cheap zero');
    assert.equal(shadow.scores[0].shadow_score, shadow.scores[0].base_score);
  }
});

// ===========================================================================
// SCENARIO 10 — API/UI/CSV/window sums
// ===========================================================================

test('scenario 10: resolveUsageWindow distinguishes today/24h and month/30d in the acceptance zone', () => {
  const today = resolveUsageWindow({ range: 'today', tz: ACCEPTANCE_TIME_ZONE, now: NOW });
  const rolling24h = resolveUsageWindow({ range: '24h', tz: ACCEPTANCE_TIME_ZONE, now: NOW });
  assert.equal(today.ok, true);
  assert.equal(rolling24h.ok, true);
  assert.equal(today.from, '2026-10-09T22:00:00.000Z');
  assert.equal(today.to, '2026-10-10T22:00:00.000Z');
  assert.equal(rolling24h.from, '2026-10-09T12:00:00.000Z');
  assert.equal(rolling24h.to, ACCEPTANCE_CUTOFF);
  assert.notEqual(today.from, rolling24h.from);
  assert.notEqual(today.to, rolling24h.to);
  assert.equal(today.tz, ACCEPTANCE_TIME_ZONE);
  assert.equal(rolling24h.range, '24h');

  const month = resolveUsageWindow({ range: 'month', tz: ACCEPTANCE_TIME_ZONE, now: NOW });
  const rolling30d = resolveUsageWindow({ range: '30d', tz: ACCEPTANCE_TIME_ZONE, now: NOW });
  assert.equal(month.ok, true);
  assert.equal(rolling30d.ok, true);
  assert.equal(month.from, '2026-09-30T22:00:00.000Z');
  assert.equal(month.to, '2026-10-31T23:00:00.000Z');
  assert.equal(rolling30d.from, '2026-09-10T12:00:00.000Z');
  assert.equal(rolling30d.to, ACCEPTANCE_CUTOFF);
  assert.notEqual(month.from, rolling30d.from);
  assert.notEqual(month.to, rolling30d.to);
});

test('scenario 10: date-only endpoints are inclusive days, ISO instants are exact, and an invalid zone is rejected', () => {
  const dayRange = resolveUsageWindow({ from: '2026-10-01', to: '2026-10-02', tz: ACCEPTANCE_TIME_ZONE });
  assert.equal(dayRange.ok, true);
  assert.equal(dayRange.inputKind, 'day');
  assert.equal(dayRange.from, '2026-09-30T22:00:00.000Z');
  assert.equal(dayRange.to, '2026-10-02T22:00:00.000Z', 'a date-only `to` is exclusive at the next zone midnight');
  assert.equal(dayRange.legacyDayFrom, '2026-10-01');
  assert.equal(dayRange.legacyDayTo, '2026-10-02');

  const instantRange = resolveUsageWindow({
    from: '2026-10-01T10:15:00.000Z',
    to: '2026-10-01T11:00:00.000Z',
    tz: ACCEPTANCE_TIME_ZONE,
  });
  assert.equal(instantRange.ok, true);
  assert.equal(instantRange.inputKind, 'instant');
  assert.equal(instantRange.from, '2026-10-01T10:15:00.000Z');
  assert.equal(instantRange.to, '2026-10-01T11:00:00.000Z');
  assert.equal(instantRange.fromMs, Date.parse('2026-10-01T10:15:00.000Z'));

  const invalid = resolveUsageWindow({ from: '2026-10-01', to: '2026-10-02', tz: 'Mars/Olympus' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Invalid tz/);
});

test('scenario 10: DST spring-forward and fall-back windows are correct', () => {
  const spring = resolveUsageWindow({
    range: 'today',
    tz: ACCEPTANCE_TIME_ZONE,
    now: Date.parse('2026-03-29T12:00:00.000Z'),
  });
  assert.equal(spring.ok, true);
  assert.equal(spring.from, '2026-03-28T23:00:00.000Z');
  assert.equal(spring.to, '2026-03-29T22:00:00.000Z');
  assert.equal(spring.toMs - spring.fromMs, 23 * HOUR_MS, 'the spring-forward day is 23 hours long');
  assert.equal(spring.days, 1);

  const fall = resolveUsageWindow({
    range: 'today',
    tz: ACCEPTANCE_TIME_ZONE,
    now: Date.parse('2026-10-25T12:00:00.000Z'),
  });
  assert.equal(fall.ok, true);
  assert.equal(fall.from, '2026-10-24T22:00:00.000Z');
  assert.equal(fall.to, '2026-10-25T23:00:00.000Z');
  assert.equal(fall.toMs - fall.fromMs, 25 * HOUR_MS, 'the fall-back day is 25 hours long');
});

test('scenario 10: buildUsageInsights composes one filter-consistent payload with coverage ratios', () => {
  const all = buildUsageInsights({ events: S10_EVENTS, runs: S10_RUNS, filters: {} });
  assert.deepEqual(all.tokens, sumUsageTokenBuckets(S10_EVENTS));

  // Disjoint buckets: the additive sum equals the reported total.
  const disjointKeys = [
    'inputWithoutCache',
    'cacheRead',
    'cacheWrite',
    'outputWithoutReasoning',
    'reasoning',
    'audioInput',
    'audioOutput',
  ];
  const disjointSum = disjointKeys.reduce((sum, key) => sum + all.tokens[key], 0);
  assert.equal(all.tokens.totalTokens, disjointSum);
  assert.ok(all.tokens.cacheTokens > 0);
  assert.ok(all.tokens.reasoning > 0);

  // Cost provenance splits actual / estimated / unpriced / subscription.
  assert.equal(all.cost.actualUsd, 3.5);
  assert.equal(all.cost.estimatedUsd, 0.5);
  assert.equal(all.cost.unpricedEvents, 1);
  assert.equal(all.cost.subscriptionEvents, 1);
  assert.equal(all.cost.estimatedEvents, 1);
  assert.equal(all.cost.partial, true);

  // Both coverage ratios with their explicit n and denominator.
  assert.equal(all.coverage.endedWithUsage.n, 2);
  assert.equal(all.coverage.endedWithUsage.denominator, 2);
  assert.equal(all.coverage.endedWithUsage.ratio, 1);
  assert.equal(all.coverage.endedComplete.n, 1);
  assert.equal(all.coverage.endedComplete.denominator, 2);
  assert.equal(all.coverage.endedComplete.ratio, 0.5);

  const directCoverage = buildUsageCoverage({ runs: S10_RUNS, events: S10_EVENTS });
  assert.deepEqual(directCoverage.endedWithUsage, all.coverage.endedWithUsage);
  assert.deepEqual(directCoverage.endedComplete, all.coverage.endedComplete);

  // A filter narrows events and coverage consistently.
  const implementOnly = buildUsageInsights({ events: S10_EVENTS, runs: S10_RUNS, filters: { role: 'implement' } });
  assert.deepEqual(
    implementOnly.tokens,
    sumUsageTokenBuckets(filterUsageEvents(S10_EVENTS, { role: 'implement' })),
  );
  assert.equal(implementOnly.tokens.events, 2);
  assert.equal(implementOnly.cost.actualUsd, 1.5);
  assert.equal(implementOnly.cost.estimatedUsd, 0.5);
  assert.equal(implementOnly.coverage.endedWithUsage.denominator, 1);
});

test('scenario 10: CSV export carries meta and the exact insights numbers with n and a share', () => {
  const window = resolveUsageWindow({ range: 'month', tz: ACCEPTANCE_TIME_ZONE, now: NOW });
  assert.equal(window.ok, true);
  const filters = { scope: 'own', role: 'implement', harness: 'sdk' };
  const insights = buildUsageInsights({ events: S10_EVENTS, runs: S10_RUNS, filters, window });

  const bucketView = tokenBucketRows(insights.tokens);
  const dataRows = [
    ...bucketView.rows.map((row) => [
      row.key,
      row.value,
      row.share_percent == null ? '' : `${row.share_percent}%`,
    ]),
    ['totalTokens', bucketView.totalTokens, '100%'],
  ];
  const meta = exportMetaRows({
    window,
    filters,
    coverage: insights.coverage,
    version: insights,
  });
  const csv = buildCsv(['bucket', 'value', 'share'], [...meta, [], ...dataRows]);

  const metaMap = Object.fromEntries(meta);
  assert.equal(metaMap.scope, 'own');
  assert.equal(metaMap.tz, ACCEPTANCE_TIME_ZONE);
  assert.equal(metaMap.range, 'month');
  assert.equal(metaMap.role, 'implement');
  assert.equal(metaMap.harness, 'sdk');
  assert.match(metaMap.from, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(metaMap.to, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(metaMap.coverage_ended_with_usage), /^\d+\/\d+$/);
  assert.match(String(metaMap.coverage_ended_complete), /^\d+\/\d+$/);
  assert.equal(String(metaMap.schema_version), String(insights.schemaVersion));
  assert.equal(String(metaMap.normalization_version), String(insights.normalizationVersion));
  assert.equal(String(metaMap.contract_revision), String(insights.contractRevision));

  // Exported numbers equal the API/insights numbers.
  const exported = new Map(dataRows.map(([key, value]) => [key, value]));
  const exportedKeys = [
    'inputWithoutCache',
    'cacheRead',
    'cacheWrite',
    'outputWithoutReasoning',
    'reasoning',
    'audioInput',
    'audioOutput',
    'totalTokens',
  ];
  for (const key of exportedKeys) {
    assert.equal(Number(exported.get(key)), Number(insights.tokens[key]), `exported ${key}`);
  }
  assert.equal(Number(exported.get('totalTokens')), insights.tokens.totalTokens);

  // `n` and a share percentage both appear in the exported file.
  const withUsage = coverageViewRows(insights.coverage).find((row) => row.key === 'endedWithUsage');
  assert.ok(withUsage.n != null);
  assert.ok(csv.includes(`${withUsage.n}/${withUsage.denominator}`), 'the coverage n appears in the CSV');
  assert.ok(csv.includes('%'), 'a share percentage appears in the CSV');
  const cacheReadRow = bucketView.rows.find((row) => row.key === 'cacheRead');
  assert.ok(csv.includes(`${cacheReadRow.share_percent}%`), 'the per-bucket share percentage is exported');
});

console.log('usage-acceptance-policy.test.js OK');
