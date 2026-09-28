import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import {
  listRolesForModel,
  loadModelRoleProfiles,
  loadRoleScoreWeights,
  normalizeRoleScoreWeights,
  selectModelPick,
} from '../lib/model-role-profiles.js';

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

removeIsolatedDataDir();
console.log('model-role-profiles.test.js OK');
