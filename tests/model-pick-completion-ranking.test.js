/**
 * Leaf 1: implement/fix ranking uses terminal completion rate and median duration;
 * sticky leaf executor after a completed job on the same leaf.
 */

// Must run before lib imports so CRETLI_DATA_DIR points at a fresh temp dir:
// real data/ lockouts would otherwise empty the picker pool (MODEL_UNAVAILABLE).
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const harnesses = [
  { id: 'sdk', enabled: true, ready: true, can_delegate: true },
  { id: 'qwen', enabled: true, ready: true, can_delegate: true },
];
const modelsByHarness = {
  sdk: {
    favorites_configured: true,
    items: [{ id: 'composer-2.5', roles: ['implement', 'fix'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
  qwen: {
    favorites_configured: true,
    items: [{ id: 'qwen3.8-flash', roles: ['implement', 'fix'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};

const observedFast = {
  'sdk/composer-2.5': {
    n: 103,
    completion_rate: 0.99,
    pass_rate: 0.99,
    infra_fail_rate: 0,
    median_min: 1.9,
    quality: 4.96,
  },
  'qwen/qwen3.8-flash': {
    n: 103,
    completion_rate: 0.65,
    pass_rate: 0.65,
    infra_fail_rate: 0,
    median_min: 13.6,
    quality: 3.6,
  },
};

const baseHistory = {
  prior: { infra_fail_rate: 0, role: 'implement' },
  observed: observedFast,
  chatUsage: {
    models: {
      'qwen/qwen3.8-flash': { count: 8, lastAt: '2026-10-01T09:00:00.000Z' },
      'sdk/composer-2.5': { count: 0, lastAt: '' },
    },
  },
};

const implementPick = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: baseHistory,
  rotation: 'balanced',
});
assert.equal(implementPick.ok, true);
assert.equal(implementPick.pick.harness, 'sdk', 'fast high-completion model wins implement');
assert.equal(implementPick.pick.model, 'composer-2.5');
assert.notEqual(implementPick.candidates[0].harness, 'qwen', 'slow low-completion model is not top-1');
assert.match(implementPick.pick.reason, /completion=99%/);

const fixPick = selectModelPick({
  role: 'fix',
  harnesses,
  modelsByHarness,
  history: baseHistory,
  rotation: 'balanced',
});
assert.equal(fixPick.pick.harness, 'sdk', 'fix shares implement observed stats');

const smallSampleObserved = {
  'sdk/composer-2.5': { n: 5, completion_rate: 0.99, infra_fail_rate: 0, median_min: 2, quality: 4 },
  'qwen/qwen3.8-flash': { n: 5, completion_rate: 0.4, infra_fail_rate: 0, median_min: 20, quality: 4 },
};
const smallSampleAdaptiveOn = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: { prior: { infra_fail_rate: 0 }, observed: smallSampleObserved },
  adaptive: true,
});
const smallSampleAdaptiveOff = selectModelPick({
  role: 'implement',
  harnesses,
  modelsByHarness,
  history: { prior: { infra_fail_rate: 0 }, observed: smallSampleObserved },
  adaptive: false,
});
const smallQwen = smallSampleAdaptiveOn.candidates.find((row) => row.harness === 'qwen');
const smallSdk = smallSampleAdaptiveOn.candidates.find((row) => row.harness === 'sdk');
assert.equal(smallQwen?.low_completion_risk, false, 'n below completionMinN: no low-completion demotion flag');
assert.equal(smallSdk?.low_completion_risk, false);
assert.deepEqual(
  smallSampleAdaptiveOn.pick.harness,
  smallSampleAdaptiveOff.pick.harness,
  'n below completionMinN: completion/median terms inactive, pick matches heuristic baseline',
);

const reviewHarnesses = [
  { id: 'a', enabled: true, ready: true, can_delegate: true },
  { id: 'b', enabled: true, ready: true, can_delegate: true },
];
const reviewModels = {
  a: { favorites_configured: true, items: [{ id: 'm-a', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  b: { favorites_configured: true, items: [{ id: 'm-b', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const reviewObserved = {
  'a/m-a': { n: 50, completion_rate: 0.2, infra_fail_rate: 0, median_min: 30, quality: 5 },
  'b/m-b': { n: 50, completion_rate: 0.99, infra_fail_rate: 0, median_min: 1, quality: 5 },
};
const reviewLowCompletion = selectModelPick({
  role: 'review',
  harnesses: reviewHarnesses,
  modelsByHarness: reviewModels,
  history: { observed: reviewObserved },
});
assert.equal(reviewLowCompletion.candidates[0].low_completion_risk, false);
assert.equal(reviewLowCompletion.candidates[1].low_completion_risk, false);
assert.equal(
  reviewLowCompletion.candidates.find((row) => row.harness === 'a').score,
  reviewLowCompletion.candidates.find((row) => row.harness === 'b').score,
  'review scores ignore implement completion/median terms',
);

const chatId = 'sticky-leaf-chat';
const leafId = 'leaf-abc-123';
const delegations = [
  {
    parentChatId: chatId,
    leafId,
    assignment: 'implement',
    status: 'completed',
    executionMode: 'agent',
    createdAt: '2026-10-01T10:00:00.000Z',
    executor: { transport: 'sdk', model: 'composer-2.5' },
  },
];
const stickyHistory = buildModelPickHistory({
  role: 'fix',
  chatId,
  leafId,
  delegations,
  harnesses: ['sdk', 'qwen'],
  now: Date.parse('2026-10-01T12:00:00.000Z'),
  // Inject empty stores so the result never depends on the machine's data/
  // (active usage lockouts, plan limits, fresh limit hits, ratings).
  lockouts: [],
  planLimits: [],
  freshLimitHits: {},
  ratings: [],
});
assert.ok(stickyHistory.leafSticky, 'leaf sticky executor is resolved');
assert.equal(stickyHistory.leafSticky.key, 'sdk/composer-2.5');

const stickyFix = selectModelPick({
  role: 'fix',
  harnesses,
  modelsByHarness,
  history: {
    ...stickyHistory,
    observed: observedFast,
    prior: { infra_fail_rate: 0, role: 'implement' },
    chatUsage: {
      models: { 'qwen/qwen3.8-flash': { count: 0, lastAt: '' } },
    },
  },
});
assert.equal(stickyFix.pick.harness, 'sdk', 'sticky leaf keeps last completed executor');
assert.equal(stickyFix.pick.chat_uses, -2, 'sticky leaf sets chat_uses=-2');

const stickyExcluded = selectModelPick({
  role: 'fix',
  harnesses,
  modelsByHarness,
  excludeModel: 'composer-2.5',
  history: {
    ...stickyHistory,
    observed: observedFast,
    prior: { infra_fail_rate: 0, role: 'implement' },
  },
});
assert.equal(stickyExcluded.pick.harness, 'qwen', 'exclude_model overrides sticky leaf');

console.log('model-pick-completion-ranking.test.js OK');

const sessionModel = 'composer-2.5::effort=high';
const sessionRow = {
  ...delegations[0],
  workRole: 'implement',
  executor: { transport: 'sdk', model: sessionModel },
};
const sessionInput = {
  role: 'implement',
  chatId,
  leafId: 'new-leaf',
  delegations: [sessionRow],
  harnesses: ['sdk', 'qwen'],
  now: Date.parse('2026-10-01T12:00:00.000Z'),
  lockouts: [], planLimits: [], freshLimitHits: {}, ratings: [],
  workSessionPolicy: { enabled: true, scope: 'orchestrator' },
};
const expectedSessionExecutor = { key: `sdk/${sessionModel}`, harness: 'sdk', model: sessionModel };

test('orchestrator preference preserves the complete executor for implement and fix, with or without a leaf', () => {
  for (const role of ['implement', 'fix']) {
    for (const leafId of ['new-leaf', '']) {
      assert.deepEqual(buildModelPickHistory({ ...sessionInput, role, leafId }).leafSticky, expectedSessionExecutor);
    }
  }
});

test('chat preference requires enabled orchestrator policy and never applies to review', () => {
  for (const workSessionPolicy of [
    { enabled: true, scope: 'leaf' },
    { enabled: false, scope: 'fresh' },
    { enabled: false, scope: 'orchestrator' },
    undefined,
  ]) {
    assert.equal(buildModelPickHistory({ ...sessionInput, workSessionPolicy }).leafSticky, null);
  }
  assert.equal(buildModelPickHistory({ ...sessionInput, role: 'review' }).leafSticky, null);
});

test('newest terminal implementation work controls chat preference; running, review, plan and other chats do not', () => {
  const newer = { ...sessionRow, createdAt: '2026-10-01T11:00:00.000Z' };
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    assert.equal(buildModelPickHistory({
      ...sessionInput, delegations: [{ ...newer, status }, sessionRow],
    }).leafSticky, null);
  }
  for (const ignored of [
    { ...newer, status: 'running' },
    { ...newer, workRole: 'review_code', assignment: 'review' },
    { ...newer, workRole: 'plan', executionMode: 'plan' },
    { ...newer, parentChatId: 'other-chat' },
  ]) {
    assert.deepEqual(buildModelPickHistory({
      ...sessionInput, delegations: [ignored, sessionRow],
    }).leafSticky, expectedSessionExecutor);
  }
});

test('own terminal leaf work prevents inheritance even after failure', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const ownRow = { ...sessionRow, leafId: ' NEW-LEAF ', status };
    const otherCompleted = { ...sessionRow, createdAt: '2026-10-01T11:00:00.000Z' };
    assert.equal(buildModelPickHistory({
      ...sessionInput, delegations: [ownRow, otherCompleted],
    }).leafSticky, null);
  }
  const ownCompleted = { ...sessionRow, leaf_id: 'NEW-LEAF', leafId: undefined, executor: { transport: 'qwen', model: 'qwen3.8-flash' } };
  assert.equal(buildModelPickHistory({
    ...sessionInput, delegations: [ownCompleted, { ...sessionRow, createdAt: '2026-10-01T11:00:00.000Z' }],
  }).leafSticky.key, 'qwen/qwen3.8-flash');
  assert.deepEqual(buildModelPickHistory({
    ...sessionInput, delegations: [{ ...sessionRow, leafId: 'new-leaf', status: 'running' }, sessionRow],
  }).leafSticky, expectedSessionExecutor);
});

test('workspace continuation settings are read when policy is not injected', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-pick-session-'));
  const workspaceFolder = path.join(dataDir, 'my-app');
  const input = { ...sessionInput, workSessionPolicy: undefined, dataDir, workspaceFolder };
  try {
    assert.deepEqual(buildModelPickHistory(input).leafSticky, expectedSessionExecutor, 'default orchestrator scope');
    saveDelegationSettings(workspaceFolder, { implement_session_scope: 'leaf' }, { dataDir });
    assert.equal(buildModelPickHistory(input).leafSticky, null, 'saved leaf scope');
    assert.deepEqual(buildModelPickHistory({ ...input, workSessionPolicy: sessionInput.workSessionPolicy }).leafSticky, expectedSessionExecutor, 'injected policy overrides saved settings');
    saveDelegationSettings(workspaceFolder, { implement_session_scope: 'orchestrator', continue_implement_sessions: false }, { dataDir });
    assert.equal(buildModelPickHistory(input).leafSticky, null, 'disabled saved continuation');
    for (const broken of ['{', '{}', '{"items": []}']) {
      fs.writeFileSync(path.join(dataDir, 'delegation-settings.json'), broken);
      assert.equal(buildModelPickHistory(input).leafSticky, null, 'corrupt settings do not enable default preference');
    }
    fs.rmSync(path.join(dataDir, 'delegation-settings.json'));
    fs.mkdirSync(path.join(dataDir, 'delegation-settings.json'));
    assert.equal(buildModelPickHistory(input).leafSticky, null, 'unreadable settings do not enable default preference');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('exclude_model overrides an orchestrator preference including effort', () => {
  const history = buildModelPickHistory(sessionInput);
  const sessionModels = {
    ...modelsByHarness,
    sdk: { ...modelsByHarness.sdk, items: [{ ...modelsByHarness.sdk.items[0], id: sessionModel }] },
  };
  const input = { role: 'implement', harnesses, modelsByHarness: sessionModels, history };
  const preferred = selectModelPick(input);
  assert.equal(preferred.ok, true);
  assert.equal(preferred.pick.model, sessionModel);
  assert.equal(preferred.pick.chat_uses, -2);
  const excluded = selectModelPick({ ...input, excludeModel: sessionModel });
  assert.equal(excluded.ok, true);
  assert.equal(excluded.pick.harness, 'qwen');
});
