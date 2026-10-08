import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import {
  buildModelPickEligibilityCohort,
  buildModelPickFavoriteDiagnosis,
  listRolesForModel,
  loadModelRoleProfiles,
  loadRoleScoreWeights,
  normalizeRoleScoreWeights,
  selectModelPick,
} from '../lib/model-role-profiles.js';
import {
  HARNESS_DELEGATION_TRAITS,
  resolveHarnessDelegationTraits,
} from '../lib/delegation-adapter-capabilities.js';

// This suite documents the default review policy. Ignore an operator escape
// hatch set in the parent process so the assertions stay deterministic.
delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;

const readySdk = { id: 'sdk', enabled: true, ready: true, can_delegate: true };
const unreadyOpenCode = { id: 'opencode', enabled: true, ready: false, can_delegate: true };
const noAdapterDeepSeek = { id: 'deepseek', enabled: true, ready: true, can_delegate: false };
const disabledCodex = { id: 'codex', enabled: false, ready: true, can_delegate: true };

const astraItem = { id: 'gpt-6-astra::effort=medium', label: 'Astra', roles: ['implement'], cost_tier: 3 };
const composerItem = { id: 'composer-2.5', label: 'Composer 2.5', roles: ['implement', 'fix'], cost_tier: 2 };
const grokItem = { id: 'grok-4.6::effort=high', label: 'Grok', roles: ['plan', 'review', 'fix'], cost_tier: 4 };

assert.deepEqual(listRolesForModel('grok-4.6::effort=high').sort(), ['fix', 'plan', 'review']);
assert.ok(listRolesForModel('gpt-6-astra').includes('implement'));
assert.ok(listRolesForModel('glm-5.3-flash').includes('implement'));
assert.equal(listRolesForModel('glm-5.3-flash').includes('review'), false);
assert.ok(listRolesForModel('glm-5.3').includes('review'));
assert.deepEqual(
  listRolesForModel('cretli-mimo/mimo-v2.6-pro').sort(),
  ['implement', 'plan', 'review'],
);
assert.deepEqual(listRolesForModel('cretli-mimo/mimo-v2.6-flash').sort(), ['fix', 'implement']);
assert.equal(listRolesForModel('unknown-model').length, 0);

// CodeBuddy Hunyuan favorites must be eligible (they had no matcher before).
assert.deepEqual(listRolesForModel('hy3').sort(), ['fix', 'implement', 'review']);
assert.deepEqual(listRolesForModel('hy4-preview-f').sort(), ['fix', 'implement', 'review']);
assert.ok(listRolesForModel('claude-opus-5').includes('implement'));
assert.deepEqual(listRolesForModel('claude-sonnet-5').sort(), ['fix', 'implement', 'plan', 'review']);

const inputAstraMissing = selectModelPick({
  role: 'implement',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [composerItem, grokItem] },
  },
});
assert.equal(inputAstraMissing.ok, true);
assert.equal(inputAstraMissing.pick.model, 'composer-2.5');

const inputAstraPresent = selectModelPick({
  role: 'implement',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [astraItem, composerItem] },
  },
});
assert.equal(inputAstraPresent.ok, true);
assert.equal(inputAstraPresent.pick.model, 'composer-2.5');

const inputEmptyFavorites = selectModelPick({
  role: 'implement',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: false, items: [astraItem, composerItem] },
  },
});
assert.equal(inputEmptyFavorites.ok, false);
assert.equal(inputEmptyFavorites.code, 'MODEL_UNAVAILABLE');

const inputJoin = selectModelPick({
  role: 'implement',
  harnesses: [unreadyOpenCode, noAdapterDeepSeek, disabledCodex, readySdk],
  modelsByHarness: {
    opencode: { favorites_configured: true, items: [astraItem] },
    deepseek: { favorites_configured: true, items: [astraItem] },
    codex: { favorites_configured: true, items: [astraItem] },
    sdk: { favorites_configured: true, items: [composerItem] },
  },
});
assert.equal(inputJoin.ok, true);
assert.equal(inputJoin.pick.harness, 'sdk');
assert.equal(inputJoin.pick.model, 'composer-2.5');

const inputReviewExclude = selectModelPick({
  role: 'review',
  excludeModel: 'composer-2.5',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [composerItem, grokItem] },
  },
});
assert.equal(inputReviewExclude.ok, true);
assert.equal(inputReviewExclude.pick.model, 'grok-4.6::effort=high');

const unknownRole = selectModelPick({ role: 'orchestrate', harnesses: [readySdk], modelsByHarness: {} });
assert.equal(unknownRole.ok, false);
assert.equal(unknownRole.code, 'VALIDATION');

const overrideFile = path.join(os.tmpdir(), `model-role-profiles-${process.pid}.json`);
writeFileSync(overrideFile, JSON.stringify({
  implement: [{ pattern: 'grok', priority: 0 }],
}), 'utf8');
const overridden = loadModelRoleProfiles({ filePath: overrideFile });
assert.ok(listRolesForModel('grok-4.6', overridden).includes('implement'));

const weightsSafeFile = path.join(os.tmpdir(), `model-role-weights-${process.pid}.json`);
writeFileSync(weightsSafeFile, JSON.stringify({
  implement: [{ pattern: 'grok', priority: 0 }],
  weights: { implement: { cost: 0.9, quality: 0.05, speed: 0.05 } },
  tiers: { note: 'ignored' },
}), 'utf8');
const profilesWithExtraKeys = loadModelRoleProfiles({ filePath: weightsSafeFile });
assert.ok(listRolesForModel('grok-4.6', profilesWithExtraKeys).includes('implement'));
const customWeights = loadRoleScoreWeights({ filePath: weightsSafeFile });
assert.equal(customWeights.implement.cost, 0.9);
assert.equal(normalizeRoleScoreWeights({ weights: { tiers: { cost: 1 } } }).implement.cost, 0.6);

const composerCheap = { id: 'composer-2.5', label: 'Composer 2.5', roles: ['implement'], cost_tier: 1 };
const composerCostly = { id: 'composer-2.5::effort=max', label: 'Composer max', roles: ['implement'], cost_tier: 5 };
const sameBandPick = selectModelPick({
  role: 'implement',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [composerCostly, composerCheap] },
  },
});
assert.equal(sameBandPick.ok, true);
assert.equal(sameBandPick.pick.model, 'composer-2.5');

// Score beats the old tier-lexicographic order: the cheap-but-weak model is
// tier-cheaper (cost 2 < 3) yet loses on the weighted implement score.
const weakCheap = { id: 'weak-cheap', roles: ['implement'], cost_tier: 2, quality_tier: 1, speed_tier: 1 };
const strongCostly = { id: 'strong-costly', roles: ['implement'], cost_tier: 3, quality_tier: 5, speed_tier: 5 };
const scoreOrderPick = selectModelPick({
  role: 'implement',
  rotation: 'off',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [weakCheap, strongCostly] },
  },
});
assert.equal(scoreOrderPick.ok, true);
assert.equal(scoreOrderPick.pick.model, 'strong-costly');
assert.ok(scoreOrderPick.pick.score > scoreOrderPick.candidates[1].score);

const flashItem = { id: 'deepseek-v4.1-flash', label: 'DeepSeek Flash', roles: ['implement'] };
const mixedImplement = selectModelPick({
  role: 'implement',
  harnesses: [readySdk, { id: 'deepseek', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [astraItem, composerItem] },
    deepseek: { favorites_configured: true, items: [flashItem] },
  },
});
assert.equal(mixedImplement.ok, true);
assert.equal(mixedImplement.pick.model, 'deepseek-v4.1-flash');

const mixedPlan = selectModelPick({
  role: 'plan',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: {
      favorites_configured: true,
      items: [
        { id: 'grok-4.6::effort=high' },
        { id: 'gpt-6-astra::effort=medium' },
        { id: 'deepseek-v4.1-flash' },
      ],
    },
  },
});
assert.equal(mixedPlan.ok, true);
assert.ok(['grok-4.6::effort=high', 'gpt-6-astra::effort=medium'].includes(mixedPlan.pick.model));

const readyCodex = { id: 'codex', enabled: true, ready: true, can_delegate: true };
const afterCodexQuota = selectModelPick({
  role: 'implement',
  excludeModel: 'gpt-6-astra::effort=medium',
  excludeHarness: 'codex',
  harnesses: [readyCodex, readySdk],
  modelsByHarness: {
    codex: { favorites_configured: true, items: [astraItem] },
    sdk: { favorites_configured: true, items: [composerItem] },
  },
});
assert.equal(afterCodexQuota.ok, true);
assert.equal(afterCodexQuota.pick.harness, 'sdk');
assert.equal(afterCodexQuota.pick.model, 'composer-2.5');

const reviewHighQuality = { id: 'glm-quality', label: 'GLM quality', roles: ['review'], cost_tier: 2, quality_tier: 5, speed_tier: 3 };
const reviewLowQuality = { id: 'glm-cheap', label: 'GLM cheap', roles: ['review'], cost_tier: 2, quality_tier: 2, speed_tier: 3 };
const reviewQualityPick = selectModelPick({
  role: 'review',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: { favorites_configured: true, items: [reviewLowQuality, reviewHighQuality] },
  },
});
assert.equal(reviewQualityPick.ok, true);
assert.equal(reviewQualityPick.pick.model, 'glm-quality');

const flashReviewOnly = selectModelPick({
  role: 'review',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: {
      favorites_configured: true,
      items: [{ id: 'deepseek-flash', label: 'Flash', roles: ['review', 'implement'] }],
    },
  },
});
assert.equal(flashReviewOnly.ok, false);
assert.equal(flashReviewOnly.code, 'MODEL_UNAVAILABLE');

const flashSkippedForReview = selectModelPick({
  role: 'review',
  harnesses: [readySdk],
  modelsByHarness: {
    sdk: {
      favorites_configured: true,
      items: [
        { id: 'deepseek-flash', label: 'Flash', roles: ['review'] },
        grokItem,
      ],
    },
  },
});
assert.equal(flashSkippedForReview.ok, true);
assert.equal(flashSkippedForReview.pick.model, 'grok-4.6::effort=high');

function createPickHandlers(client) {
  return createCretliMcpToolHandlers(client, { mode: 'agent' });
}

const mockJoinClient = {
  async listHarnessCatalog() {
    return [unreadyOpenCode, readySdk];
  },
  async listHarnessModels({ harness }) {
    if (harness === 'opencode') {
      return { favorites_configured: true, items: [astraItem] };
    }
    return { favorites_configured: true, items: [composerItem] };
  },
};
const actualJoinMcp = await createPickHandlers(mockJoinClient).model_pick({ role: 'implement' });
assert.equal(actualJoinMcp.isError, false);
assert.equal(actualJoinMcp.structuredContent.pick.model, 'composer-2.5');
assert.equal(actualJoinMcp.structuredContent.pick.harness, 'sdk');

const actualEmptyMcp = await createPickHandlers({
  async listHarnessCatalog() {
    return [readySdk];
  },
  async listHarnessModels() {
    return { favorites_configured: false, items: [astraItem] };
  },
}).model_pick({ role: 'implement' });
assert.equal(actualEmptyMcp.isError, true);
assert.match(actualEmptyMcp.content[0].text, /MODEL_UNAVAILABLE/);
assert.match(actualEmptyMcp.content[0].text, /favorites/, 'MODEL_UNAVAILABLE explains the missing favorites');

const actualExcludeHarnessMcp = await createPickHandlers({
  async listHarnessCatalog() {
    return [readySdk, { id: 'codex', enabled: true, ready: true, can_delegate: true }];
  },
  async listHarnessModels({ harness }) {
    if (harness === 'codex') {
      return { favorites_configured: true, items: [astraItem] };
    }
    return { favorites_configured: true, items: [composerItem] };
  },
}).model_pick({ role: 'implement', exclude_harness: 'codex', exclude_model: 'gpt-6-astra::effort=medium' });
assert.equal(actualExcludeHarnessMcp.isError, false);
assert.equal(actualExcludeHarnessMcp.structuredContent.pick.model, 'composer-2.5');
assert.equal(actualExcludeHarnessMcp.structuredContent.pick.harness, 'sdk');

const reviewAstra = {
  id: 'gpt-6-astra::effort=medium',
  label: 'Astra',
  roles: ['review'],
  cost_tier: 5,
  quality_tier: 5,
};
const reviewGlm = {
  id: 'glm-5.3',
  label: 'GLM',
  roles: ['review'],
  cost_tier: 2,
  quality_tier: 4,
};
const actualReviewSkipCodex = await createPickHandlers({
  async listHarnessCatalog() {
    return [
      { id: 'codex', enabled: true, ready: true, can_delegate: true },
      { id: 'opencode', enabled: true, ready: true, can_delegate: true },
    ];
  },
  async listHarnessModels({ harness }) {
    if (harness === 'codex') {
      return { favorites_configured: true, items: [reviewAstra] };
    }
    return { favorites_configured: true, items: [reviewGlm] };
  },
}).model_pick({ role: 'review' });
assert.equal(actualReviewSkipCodex.isError, false);
assert.equal(actualReviewSkipCodex.structuredContent.pick.harness, 'opencode');
assert.equal(actualReviewSkipCodex.structuredContent.pick.model, 'glm-5.3');

// --- Task 5A: count / diverse fanout picks --------------------------------
const fanoutHarnesses = [
  { id: 'sdk', enabled: true, ready: true, can_delegate: true },
  { id: 'claude', enabled: true, ready: true, can_delegate: true },
  { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
];
const fanoutModels = {
  sdk: { favorites_configured: true, items: [{ id: 'grok-4.6', label: 'Grok', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 }] },
  claude: { favorites_configured: true, items: [{ id: 'claude-sonnet-5', label: 'Sonnet', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 }] },
  codebuddy: { favorites_configured: true, items: [{ id: 'hy3', label: 'Hunyuan 3', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 }] },
};

const baselineReview = selectModelPick({ role: 'review', harnesses: fanoutHarnesses, modelsByHarness: fanoutModels });
const countOneReview = selectModelPick({ role: 'review', harnesses: fanoutHarnesses, modelsByHarness: fanoutModels, count: 1 });
assert.equal(countOneReview.picks.length, 1, 'count defaults to a single pick');
assert.equal(countOneReview.picks[0], countOneReview.pick, 'pick is always picks[0]');
assert.equal(countOneReview.pick.model, baselineReview.pick.model, 'count=1 is identical to the legacy pick');

// Two harnesses with different providers (no review-trait tie): both picks,
// different harness and different provider.
const providerHarnesses = fanoutHarnesses.filter((row) => row.id !== 'codebuddy');
const providerModels = { sdk: fanoutModels.sdk, claude: fanoutModels.claude };
const diverseReview = selectModelPick({
  role: 'review',
  harnesses: providerHarnesses,
  modelsByHarness: providerModels,
  count: 2,
  diverse: true,
});
assert.equal(diverseReview.picks.length, 2);
assert.notEqual(diverseReview.picks[0].harness, diverseReview.picks[1].harness, 'diverse picks span harnesses');
assert.notEqual(diverseReview.picks[0].provider, diverseReview.picks[1].provider, 'diverse picks span providers');
assert.deepEqual(
  diverseReview.picks.map((row) => row.provider).sort(),
  ['anthropic', 'xai'],
);
assert.equal(diverseReview.pick, diverseReview.picks[0]);

// Without `diverse`, extra picks still prefer another harness.
const harnessOnlyReview = selectModelPick({
  role: 'review',
  harnesses: providerHarnesses,
  modelsByHarness: providerModels,
  count: 2,
});
assert.equal(harnessOnlyReview.picks.length, 2);
assert.notEqual(harnessOnlyReview.picks[0].harness, harnessOnlyReview.picks[1].harness);

// `diverse: true` never duplicates a harness: one harness yields a shorter set.
const twoModelsOneHarness = {
  sdk: {
    favorites_configured: true,
    items: [
      { id: 'grok-4.6', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 },
      { id: 'grok-4.6-mini', roles: ['review'], cost_tier: 2, quality_tier: 3, speed_tier: 5 },
    ],
  },
};
const singleHarnessDiverse = selectModelPick({
  role: 'review',
  harnesses: [{ id: 'sdk', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: twoModelsOneHarness,
  count: 2,
  diverse: true,
});
assert.equal(singleHarnessDiverse.picks.length, 1, 'diverse never repeats a harness');
assert.equal(singleHarnessDiverse.pick, singleHarnessDiverse.picks[0]);

// Without `diverse`, `count` fills the set with a second model on the same harness.
const singleHarnessFill = selectModelPick({
  role: 'review',
  harnesses: [{ id: 'sdk', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: twoModelsOneHarness,
  count: 2,
});
assert.equal(singleHarnessFill.picks.length, 2, 'without diverse a same-harness model fills count');
assert.equal(singleHarnessFill.picks[0].harness, singleHarnessFill.picks[1].harness);

// --- Task 6: plural excludes merge with the single fields -----------------
const arrayExcludePick = selectModelPick({
  role: 'review',
  harnesses: fanoutHarnesses,
  modelsByHarness: fanoutModels,
  excludeModels: ['grok-4.6'],
  excludeHarnesses: ['codebuddy'],
});
assert.equal(arrayExcludePick.ok, true);
assert.equal(arrayExcludePick.pick.harness, 'claude', 'exclude_models/exclude_harnesses are hard');
assert.equal(
  selectModelPick({
    role: 'review',
    harnesses: fanoutHarnesses,
    modelsByHarness: fanoutModels,
    excludeModel: 'claude-sonnet-5',
    excludeModels: ['grok-4.6'],
    excludeHarness: 'codebuddy',
  }).ok,
  false,
  'single and plural excludes are merged (all candidates excluded)',
);

// --- Task 6: harness delegation traits ------------------------------------
assert.equal(HARNESS_DELEGATION_TRAITS.claude.review_can_run_tests, true);
assert.equal(HARNESS_DELEGATION_TRAITS.sdk.review_can_run_tests, false);
assert.equal(HARNESS_DELEGATION_TRAITS.deepseek.review_can_run_tests, false);
assert.equal(HARNESS_DELEGATION_TRAITS.opencode.review_can_run_tests, true);
assert.equal(HARNESS_DELEGATION_TRAITS.codebuddy.review_can_run_tests, true);
assert.equal(HARNESS_DELEGATION_TRAITS.openrouter.review_can_run_tests, true);
assert.equal(HARNESS_DELEGATION_TRAITS.qwen.review_can_run_tests, true);
assert.equal(HARNESS_DELEGATION_TRAITS.codex.review_can_run_tests, true);
assert.deepEqual([...resolveHarnessDelegationTraits('codex').known_failure_modes], ['usage_limit']);
assert.deepEqual([...resolveHarnessDelegationTraits('opencode').known_failure_modes], ['adapter_incomplete']);
assert.deepEqual([...resolveHarnessDelegationTraits('qwen').known_failure_modes], ['slow_read_loop']);
assert.equal(resolveHarnessDelegationTraits('unknown-harness').review_can_run_tests, false);

// Prior vs observation: two agreeing signals override, one or a tie does not.
assert.equal(resolveHarnessDelegationTraits('claude').review_can_run_tests_source, 'prior');
assert.equal(resolveHarnessDelegationTraits('deepseek', { positive: 2 }).review_can_run_tests, true);
assert.equal(resolveHarnessDelegationTraits('deepseek', { positive: 2 }).review_can_run_tests_source, 'observed');
assert.equal(resolveHarnessDelegationTraits('opencode', { negative: 2 }).review_can_run_tests, false);
assert.equal(resolveHarnessDelegationTraits('opencode', { negative: 2 }).review_can_run_tests_source, 'observed');
assert.equal(resolveHarnessDelegationTraits('opencode', { positive: 1 }).review_can_run_tests_source, 'prior');
assert.equal(resolveHarnessDelegationTraits('opencode', { positive: 2, negative: 2 }).review_can_run_tests_source, 'prior');

// Injected history observation flips the effective band tie-break.
const observedTraitHarnesses = [
  { id: 'sdk', enabled: true, ready: true, can_delegate: true },
  { id: 'claude', enabled: true, ready: true, can_delegate: true },
];
const observedTraitModels = {
  sdk: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  claude: { favorites_configured: true, items: [{ id: 'claude-sonnet-5', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const priorTraitPick = selectModelPick({
  role: 'review',
  harnesses: observedTraitHarnesses,
  modelsByHarness: observedTraitModels,
});
assert.equal(priorTraitPick.pick.harness, 'claude', 'the claude prior wins the default band tie');
const observedTraitPick = selectModelPick({
  role: 'review',
  harnesses: observedTraitHarnesses,
  modelsByHarness: observedTraitModels,
  history: { reviewTestObservations: { sdk: { positive: 2 }, claude: { negative: 2 } } },
});
assert.equal(observedTraitPick.pick.harness, 'sdk', 'observed signals override the priors');
assert.equal(observedTraitPick.pick.traits.review_can_run_tests_source, 'observed');
assert.equal(
  observedTraitPick.candidates.find((row) => row.harness === 'claude').traits.review_can_run_tests,
  false,
);
assert.equal(
  observedTraitPick.candidates.find((row) => row.harness === 'claude').traits.review_can_run_tests_source,
  'observed',
);

// --- Task 6: review prefers a harness that can run review-verify -----------
const traitHarnesses = [
  { id: 'sdk', enabled: true, ready: true, can_delegate: true },
  { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
];
const traitModels = {
  sdk: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  codebuddy: { favorites_configured: true, items: [{ id: 'hy3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const traitPick = selectModelPick({ role: 'review', harnesses: traitHarnesses, modelsByHarness: traitModels });
assert.equal(traitPick.ok, true);
assert.equal(traitPick.pick.harness, 'codebuddy', 'review prefers review_can_run_tests: true on a band tie');
assert.match(traitPick.pick.reason, /review can run tests/);
assert.equal(traitPick.pick.traits.review_can_run_tests, true);
assert.equal(
  traitPick.candidates.find((row) => row.harness === 'sdk').traits.review_can_run_tests,
  false,
);

const mockFanoutModels = {
  sdk: {
    favorites_configured: true,
    items: [
      { id: 'grok-4.6', label: 'Grok', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 },
      { id: 'grok-4.6-mini', label: 'Grok mini', roles: ['review'], cost_tier: 2, quality_tier: 3, speed_tier: 5 },
    ],
  },
  claude: fanoutModels.claude,
  codebuddy: fanoutModels.codebuddy,
};
const mockFanoutClient = {
  async listHarnessCatalog() {
    return [
      { id: 'sdk', enabled: true, ready: true, can_delegate: true },
      { id: 'claude', enabled: true, ready: true, can_delegate: true },
      { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
    ];
  },
  async listHarnessModels({ harness }) {
    return mockFanoutModels[harness];
  },
};
const actualFanoutMcp = await createPickHandlers(mockFanoutClient).model_pick({
  role: 'review',
  count: 2,
  diverse: true,
  exclude_models: ['grok-4.6'],
  exclude_harnesses: ['codebuddy'],
});
assert.equal(actualFanoutMcp.isError, false);
assert.equal(actualFanoutMcp.structuredContent.picks.length, 2, 'fanout returns each pick');
assert.deepEqual(
  actualFanoutMcp.structuredContent.picks.map((row) => row.harness).sort(),
  ['claude', 'sdk'],
  'plural excludes remove their harness/model from the fanout',
);
assert.match(actualFanoutMcp.content[0].text, /claude-sonnet-5/);
assert.equal(actualFanoutMcp.content[0].text.split('\n').length, 2, 'one short line per pick');
assert.match(actualFanoutMcp.content[0].text, /tests=no/);
assert.match(actualFanoutMcp.content[0].text, /reason=/);

assert.match(buildModelPickEligibilityCohort(), /alias-policy-2026-10-08\+role-policy-2026-10-08/);

const auditTable = buildModelPickFavoriteDiagnosis({
  role: 'review',
  harnesses: fanoutHarnesses,
  modelsByHarness: fanoutModels,
  checkReviewAdapter: true,
}, { checkReviewAdapter: true });
assert.ok(auditTable.rows.length >= 3);
assert.ok(auditTable.rows.every((row) => Array.isArray(row.roles) && Array.isArray(row.filter_reasons)));

const noFavoriteDiagnosis = selectModelPick({
  role: 'implement',
  harnesses: [readySdk],
  modelsByHarness: { sdk: { favorites_configured: false, items: [{ id: 'x', roles: ['implement'] }] } },
});
assert.equal(noFavoriteDiagnosis.ok, false);
assert.deepEqual(
  noFavoriteDiagnosis.diagnosis.rows.find((row) => row.harness === 'sdk').filter_reasons,
  ['no-favorites'],
);

const onlyUncertifiedReviewMcp = await createPickHandlers({
  async listHarnessCatalog() {
    return [{ id: 'codex', enabled: true, ready: true, can_delegate: true }];
  },
  async listHarnessModels() {
    return {
      favorites_configured: true,
      items: [{ id: 'glm-5.3', label: 'GLM', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 4 }],
    };
  },
}).model_pick({ role: 'review' });
assert.equal(onlyUncertifiedReviewMcp.isError, true);
assert.match(onlyUncertifiedReviewMcp.content[0].text, /MODEL_UNAVAILABLE/);
assert.match(onlyUncertifiedReviewMcp.content[0].text, /review adapter guarantee/);
assert.ok(onlyUncertifiedReviewMcp.structuredContent.diagnosis);
assert.deepEqual(
  onlyUncertifiedReviewMcp.structuredContent.diagnosis.rows.find((row) => row.harness === 'codex').filter_reasons,
  ['review-adapter-blocked'],
);

removeIsolatedDataDir();
console.log('model-role-profiles.test.js OK');
