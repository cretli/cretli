import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import {
  COLD_START_BONUS,
  DEFAULT_ROTATION_CONFIG,
  PLAN_LIMIT_PENALTY,
  normalizeRotationConfig,
  loadRotationConfig,
  selectModelPick,
} from '../lib/model-role-profiles.js';

// --- Role matchers: CodeBuddy Hunyuan is a real implement/fix/review candidate ---
const hy3Roles = [
  { id: 'hy3', enabled: true, ready: true, can_delegate: true },
];
const hy3Models = {
  hy3: {
    favorites_configured: true,
    items: [{ id: 'hy3', label: 'Hunyuan 3' }],
  },
};
for (const role of ['implement', 'fix', 'review']) {
  const picked = selectModelPick({ role, harnesses: hy3Roles, modelsByHarness: hy3Models });
  assert.equal(picked.ok, true, `hy3 must be eligible for ${role}`);
  assert.equal(picked.pick.model, 'hy3');
}
assert.equal(
  selectModelPick({
    role: 'plan',
    harnesses: [{ id: 'codebuddy', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codebuddy: { favorites_configured: true, items: [{ id: 'hy3' }] } },
  }).ok,
  false,
  'hy3 stays out of the plan role',
);

// --- Rotation config: object, legacy string, and file loader ---
assert.deepEqual(normalizeRotationConfig(undefined), DEFAULT_ROTATION_CONFIG);
assert.deepEqual(normalizeRotationConfig({ rotation: { band: 0.2, mode: 'explore' } }), { band: 0.2, mode: 'explore' });
assert.deepEqual(normalizeRotationConfig({ delegation: { rotation: 'off' } }), { band: 0.05, mode: 'off' });
assert.deepEqual(normalizeRotationConfig('bogus'), DEFAULT_ROTATION_CONFIG);

const rotationConfigFile = path.join(os.tmpdir(), `model-rotation-${process.pid}.json`);
writeFileSync(rotationConfigFile, JSON.stringify({
  rotation: { band: 0.25, mode: 'explore' },
}), 'utf8');
assert.deepEqual(loadRotationConfig({ filePath: rotationConfigFile }), { band: 0.25, mode: 'explore' });

// --- Equal tiers: usage, not the alphabet, decides ---
const alphabetHarnesses = ['alpha', 'zeta'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const alphabetModels = {
  alpha: { favorites_configured: true, items: [{ id: 'alpha-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  zeta: { favorites_configured: true, items: [{ id: 'zeta-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const flatPick = selectModelPick({ role: 'implement', harnesses: alphabetHarnesses, modelsByHarness: alphabetModels });
assert.equal(flatPick.pick.harness, 'alpha', 'flat history falls back to a stable id key');
const usedAlphaPick = selectModelPick({
  role: 'implement',
  harnesses: alphabetHarnesses,
  modelsByHarness: alphabetModels,
  history: { roleUsage7d: { harness: { alpha: 5 } } },
});
assert.equal(usedAlphaPick.pick.harness, 'zeta', 'least-used harness wins even when its id sorts later');
assert.match(
  usedAlphaPick.pick.reason,
  /harness least-used in role 7d \(0\)/,
  'reason names the harness-7d key that decided the band',
);
assert.equal(typeof flatPick.pick.reason, 'string');
assert.ok(flatPick.pick.reason.length > 0);
assert.equal(typeof flatPick.candidates[0].reason, 'string');

// --- 10 picks with a flat start rotate across harnesses ---
const pool = ['h1', 'h2', 'h3', 'h4'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const poolModels = {};
for (const harness of pool) {
  poolModels[harness.id] = {
    favorites_configured: true,
    items: [{ id: `m-${harness.id}`, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  };
}
const roleUsage = { harness: {}, model: {}, lastAt: {} };
const simulatedPicks = [];
for (let i = 0; i < 10; i += 1) {
  const picked = selectModelPick({
    role: 'implement',
    harnesses: pool,
    modelsByHarness: poolModels,
    history: { roleUsage7d: roleUsage, pickIndex: i },
  });
  assert.equal(picked.ok, true);
  simulatedPicks.push(picked.pick.harness);
  roleUsage.harness[picked.pick.harness] = (roleUsage.harness[picked.pick.harness] || 0) + 1;
}
assert.ok(new Set(simulatedPicks).size >= 3, `expected >=3 harnesses, got ${[...new Set(simulatedPicks)].join(',')}`);

// --- Same chat already used deepseek x4 in this role -> a different harness ---
const dualHarnesses = ['deepseek', 'codebuddy'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const dualModels = {
  deepseek: { favorites_configured: true, items: [{ id: 'deepseek-flash', roles: ['implement'], cost_tier: 1, quality_tier: 4, speed_tier: 5 }] },
  codebuddy: { favorites_configured: true, items: [{ id: 'hy3', roles: ['implement'], cost_tier: 1, quality_tier: 4, speed_tier: 5 }] },
};
const chatPick = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  history: { chatUsage: { models: { 'deepseek/deepseek-flash': { count: 4, lastAt: new Date().toISOString() } } } },
});
assert.equal(chatPick.pick.harness, 'codebuddy');
assert.match(
  chatPick.pick.reason,
  /fewer uses in this chat \(0\)/,
  'reason names the chat-uses key that decided the band',
);

// A next review PASS keeps the proven winner (no rotation away).
const passedPick = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  history: { chatUsage: { models: { 'deepseek/deepseek-flash': { count: 4, next_review_passed: true } } } },
});
assert.equal(passedPick.pick.harness, 'deepseek');
assert.match(
  passedPick.pick.reason,
  /keep winner \(last review PASS in chat\)/,
  'reason names the keep-winner key instead of claiming least-used',
);
assert.equal(passedPick.pick.chat_uses, -1, 'the structured chat_uses stays -1 for a proven winner');
assert.equal(passedPick.pick.keep_winner, true);

// --- Active lockout drops the model, not just deprioritises it ---
const lockoutPick = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  history: { lockouts: [{ harness: 'deepseek', model: 'deepseek-flash', resetAt: '2099-01-01T00:00:00.000Z' }] },
});
assert.equal(lockoutPick.ok, true);
assert.equal(lockoutPick.pick.harness, 'codebuddy');
const expiredLockout = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  history: { lockouts: [{ harness: 'deepseek', model: 'deepseek-flash', resetAt: '2000-01-01T00:00:00.000Z' }] },
});
assert.ok(['deepseek', 'codebuddy'].includes(expiredLockout.pick.harness));
const allLocked = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  history: { lockouts: [{ harness: 'deepseek' }, { harness: 'codebuddy' }] },
});
assert.equal(allLocked.ok, false);
assert.equal(allLocked.code, 'MODEL_UNAVAILABLE');

// --- rotation: off is score-only and ignores usage ---
const offPick = selectModelPick({
  role: 'implement',
  harnesses: dualHarnesses,
  modelsByHarness: dualModels,
  rotation: 'off',
  history: {
    roleUsage7d: {
      harness: { deepseek: 7 },
      model: { 'deepseek/deepseek-flash': 9 },
      lastAt: { 'deepseek/deepseek-flash': '2026-09-30T12:00:00.000Z' },
    },
    chatUsage: { models: { 'deepseek/deepseek-flash': { count: 4, next_review_passed: true } } },
  },
});
assert.equal(offPick.pick.harness, 'deepseek');
assert.equal(offPick.rotation.mode, 'off');
assert.equal(offPick.pick.chat_uses, -1, 'rotation off still exposes the proven-winner chat count');
assert.equal(offPick.pick.keep_winner, true, 'rotation off still exposes keep_winner metadata');
assert.equal(offPick.pick.role_uses_7d, 7, 'rotation off still exposes the role usage count');
assert.equal(offPick.pick.model_uses_7d, 9, 'rotation off still exposes the model usage count');
assert.equal(offPick.pick.last_used_at, '2026-09-30T12:00:00.000Z');
const cheap = { id: 'weak-cheap', roles: ['implement'], cost_tier: 2, quality_tier: 1, speed_tier: 1 };
const strong = { id: 'strong-costly', roles: ['implement'], cost_tier: 3, quality_tier: 5, speed_tier: 5 };
const scoreOrder = selectModelPick({
  role: 'implement',
  harnesses: [{ id: 'sdk', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: { sdk: { favorites_configured: true, items: [cheap, strong] } },
  rotation: 'off',
});
assert.equal(scoreOrder.pick.model, 'strong-costly', 'score (not tier lexicographic) picks the winner');

// --- Cold start: explore bonus lifts a 0-job harness, explore=false disables ---
const exploreHarnesses = ['a', 'b'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const exploreModels = {
  a: { favorites_configured: true, items: [{ id: 'a-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  b: { favorites_configured: true, items: [{ id: 'b-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const exploreOn = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  rotation: 'explore',
  history: { coldStartHarnesses14d: ['b'] },
});
assert.equal(exploreOn.pick.harness, 'b');
assert.equal(exploreOn.rotation.explore_turn, true);
assert.equal(
  Math.abs((exploreOn.pick.rotation_score - exploreOn.candidates[1].rotation_score) - COLD_START_BONUS) < 1e-9,
  true,
);
const exploreOff = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  rotation: 'explore',
  explore: false,
  history: { coldStartHarnesses14d: ['b'] },
});
assert.equal(exploreOff.pick.harness, 'a');

// --- Cold start never applies to plan (spec: implement/fix/review only) ---
const planExploreModels = {
  a: {
    favorites_configured: true,
    items: [{ id: 'grok-4.6::effort=high', roles: ['plan'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
  b: {
    favorites_configured: true,
    items: [{ id: 'claude-sonnet-5', roles: ['plan'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};
const planExplore = selectModelPick({
  role: 'plan',
  harnesses: exploreHarnesses,
  modelsByHarness: planExploreModels,
  rotation: 'explore',
  history: { coldStartHarnesses14d: ['b'] },
});
assert.equal(planExplore.rotation.explore_turn, false, 'plan never enters the cold-start explore turn');
assert.equal(planExplore.pick.harness, 'a', 'the cold-start bonus must not lift harness b for plan');
const planExploreByIndex = selectModelPick({
  role: 'plan',
  harnesses: exploreHarnesses,
  modelsByHarness: planExploreModels,
  history: { coldStartHarnesses14d: ['b'], pickIndex: 5 },
});
assert.equal(planExploreByIndex.rotation.explore_turn, false, 'global role traffic must not explore plan');
assert.equal(planExploreByIndex.pick.harness, 'a');

// Fresh limit history penalises the harness even without a lockout row.
const freshLimit = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  history: { freshLimitHits: { a: 2 } },
});
assert.equal(freshLimit.pick.harness, 'b');
assert.ok(freshLimit.candidates.find((row) => row.harness === 'a').plan_limit_penalty > 0);

// --- Review auto-excludes the last implementer and last reviewer ---
createDelegationRecord({
  parentChatId: 'review-chat',
  workspaceFolder: '/tmp/rotation',
  assignment: 'implement',
  status: 'completed',
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
});
createDelegationRecord({
  parentChatId: 'review-chat',
  workspaceFolder: '/tmp/rotation',
  assignment: 'review',
  status: 'completed',
  executor: { transport: 'codebuddy', model: 'hy3' },
});
const reviewHistory = buildModelPickHistory({
  role: 'review',
  chatId: 'review-chat',
  harnesses: ['deepseek', 'codebuddy'],
});
assert.deepEqual(
  [...reviewHistory.excludeModels].sort(),
  ['deepseek-flash', 'hy3'],
  'review excludes the last implementer and the last reviewer',
);

// --- Handler: chat_id defaults to the calling session chat ---
const deepseekRow = { id: 'deepseek-flash', roles: ['implement'], cost_tier: 1, quality_tier: 4, speed_tier: 5 };
const hy3Row = { id: 'hy3', roles: ['implement'], cost_tier: 1, quality_tier: 4, speed_tier: 5 };
for (let i = 0; i < 4; i += 1) {
  createDelegationRecord({
    parentChatId: 'chat-rotation',
    workspaceFolder: '/tmp/rotation',
    assignment: 'implement',
    status: 'completed',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
  });
}
const mockClient = {
  async listHarnessCatalog() {
    return [
      { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
      { id: 'codebuddy', enabled: true, ready: true, can_delegate: true },
    ];
  },
  async listHarnessModels({ harness }) {
    if (harness === 'deepseek') return { favorites_configured: true, items: [deepseekRow] };
    return { favorites_configured: true, items: [hy3Row] };
  },
};
const deepseekChatUses = (response) => response.structuredContent.candidates
  .find((row) => row.harness === 'deepseek')?.chat_uses;

const handlers = createCretliMcpToolHandlers(mockClient, { chatId: 'chat-rotation', mode: 'agent' });
const handlerPick = await handlers.model_pick({ role: 'implement' });
assert.equal(handlerPick.isError, false);
assert.equal(handlerPick.structuredContent.pick.harness, 'codebuddy');
assert.equal(typeof handlerPick.structuredContent.pick.reason, 'string');
assert.equal(deepseekChatUses(handlerPick), 4, 'session chat id feeds the workflow-diversity history');

const otherChatPick = await createCretliMcpToolHandlers(mockClient, { chatId: 'chat-other', mode: 'agent' })
  .model_pick({ role: 'implement' });
assert.equal(otherChatPick.isError, false);
assert.equal(deepseekChatUses(otherChatPick), 0, 'a different calling chat has no prior model use');

const explicitChatPick = await createCretliMcpToolHandlers(mockClient, { chatId: 'chat-other', mode: 'agent' })
  .model_pick({ role: 'implement', chat_id: 'chat-rotation' });
assert.equal(deepseekChatUses(explicitChatPick), 4, 'explicit chat_id overrides the session chat');

// --- Chat-history auto-exclude is SOFT; explicit excludes stay hard ---
const soloHarnesses = [{ id: 'sdk', enabled: true, ready: true, can_delegate: true }];
const soloReviewModels = {
  sdk: {
    favorites_configured: true,
    items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};
const softReview = selectModelPick({
  role: 'review',
  harnesses: soloHarnesses,
  modelsByHarness: soloReviewModels,
  history: { excludeModels: ['glm-5.3'] },
});
assert.equal(softReview.ok, true, 'history auto-exclude relaxes when it would empty the pool');
assert.equal(softReview.pick.model, 'glm-5.3');
assert.equal(softReview.rotation.history_exclude_relaxed, true);
assert.match(softReview.pick.reason, /history exclude relaxed/);

const hardExcludeModel = selectModelPick({
  role: 'review',
  harnesses: soloHarnesses,
  modelsByHarness: soloReviewModels,
  excludeModel: 'glm-5.3',
  history: { excludeModels: ['glm-5.3'] },
});
assert.equal(hardExcludeModel.ok, false);
assert.equal(hardExcludeModel.code, 'MODEL_UNAVAILABLE');
assert.match(hardExcludeModel.error, /exclude_model/, 'MODEL_UNAVAILABLE explains the explicit exclude');

const hardExcludeHarness = selectModelPick({
  role: 'review',
  harnesses: soloHarnesses,
  modelsByHarness: soloReviewModels,
  excludeHarness: 'sdk',
  history: { excludeModels: ['glm-5.3'] },
});
assert.equal(hardExcludeHarness.ok, false);
assert.match(hardExcludeHarness.error, /exclude_harness/);

const lockedMessage = selectModelPick({
  role: 'review',
  harnesses: soloHarnesses,
  modelsByHarness: soloReviewModels,
  history: { lockouts: [{ harness: 'sdk', model: 'glm-5.3' }] },
});
assert.equal(lockedMessage.ok, false);
assert.match(lockedMessage.error, /lockout/, 'MODEL_UNAVAILABLE explains an active lockout');

const twoReviewModels = {
  sdk: {
    favorites_configured: true,
    items: [
      { id: 'glm-a', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
      { id: 'glm-b', roles: ['review'], cost_tier: 3, quality_tier: 3, speed_tier: 3 },
    ],
  },
};
const noRelaxNeeded = selectModelPick({
  role: 'review',
  harnesses: soloHarnesses,
  modelsByHarness: twoReviewModels,
  history: { excludeModels: ['glm-a'] },
});
assert.equal(noRelaxNeeded.ok, true);
assert.equal(noRelaxNeeded.rotation.history_exclude_relaxed, false, 'no fallback when a candidate survives');
assert.notEqual(noRelaxNeeded.pick.model, 'glm-a');

// --- Cold start: global role traffic drives explore, not the per-chat count ---
const nowMs = Date.now();
const globalImplementRows = (count) => Array.from({ length: count }, (_, index) => ({
  assignment: 'implement',
  executionMode: 'agent',
  parentChatId: 'some-other-chat',
  status: 'completed',
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
  createdAt: new Date(nowMs - ((index + 1) * 60 * 60 * 1000)).toISOString(),
}));
const firstChatHistory = buildModelPickHistory({
  role: 'implement',
  chatId: 'brand-new-chat',
  harnesses: ['a', 'b'],
  delegations: globalImplementRows(2),
  now: nowMs,
});
assert.equal(firstChatHistory.pickIndex, 2, 'pickIndex follows global role traffic, not the chat');
const noChatHistory = buildModelPickHistory({
  role: 'implement',
  chatId: '',
  harnesses: ['a', 'b'],
  delegations: globalImplementRows(2),
  now: nowMs,
});
assert.equal(noChatHistory.pickIndex, 2, 'a missing chat_id does not reset the global explore counter');

const firstPickExplore = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  history: firstChatHistory,
});
assert.equal(firstPickExplore.rotation.explore_turn, false, 'the first pick of a new chat must not always explore');
const noChatPickExplore = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  history: noChatHistory,
});
assert.equal(noChatPickExplore.rotation.explore_turn, false, 'a missing chat_id must not force explore');

const fifthJobHistory = buildModelPickHistory({
  role: 'implement',
  chatId: 'brand-new-chat',
  harnesses: ['a', 'b'],
  delegations: globalImplementRows(5),
  now: nowMs,
});
assert.equal(fifthJobHistory.pickIndex, 5);
const fifthJobPick = selectModelPick({
  role: 'implement',
  harnesses: exploreHarnesses,
  modelsByHarness: exploreModels,
  history: fifthJobHistory,
});
assert.equal(fifthJobPick.rotation.explore_turn, true, 'every 5th global role job explores');

// --- The last reviewer ignores plan-mode jobs ---
const planModeRows = [
  {
    assignment: 'implement',
    executionMode: 'agent',
    parentChatId: 'plan-chat',
    executor: { transport: 'deepseek', model: 'deepseek-flash' },
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    assignment: 'review',
    executionMode: 'plan',
    parentChatId: 'plan-chat',
    executor: { transport: 'codebuddy', model: 'hy3' },
    createdAt: '2026-01-01T00:01:00.000Z',
  },
];
const planOnlyReview = buildModelPickHistory({
  role: 'review',
  chatId: 'plan-chat',
  harnesses: ['deepseek', 'codebuddy'],
  delegations: planModeRows,
});
assert.deepEqual(planOnlyReview.excludeModels, ['deepseek-flash'], 'a plan-mode job is not the last reviewer');
const withRealReview = buildModelPickHistory({
  role: 'review',
  chatId: 'plan-chat',
  harnesses: ['deepseek', 'codebuddy'],
  delegations: [
    ...planModeRows,
    {
      assignment: 'review',
      executionMode: 'agent',
      parentChatId: 'plan-chat',
      executor: { transport: 'qwen', model: 'qwen-max' },
      createdAt: '2026-01-01T00:02:00.000Z',
    },
  ],
});
assert.deepEqual([...withRealReview.excludeModels].sort(), ['deepseek-flash', 'qwen-max']);

// --- next_review_passed binds an implement to its FIRST following review ---
const passReport = 'TASK: review\nVERDICT: PASS';
const superseded = buildModelPickHistory({
  role: 'implement',
  chatId: 'chain-chat',
  harnesses: ['deepseek', 'codebuddy'],
  delegations: [
    {
      assignment: 'implement',
      executionMode: 'agent',
      parentChatId: 'chain-chat',
      executor: { transport: 'deepseek', model: 'deepseek-flash' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      assignment: 'implement',
      executionMode: 'agent',
      parentChatId: 'chain-chat',
      executor: { transport: 'codebuddy', model: 'hy3' },
      createdAt: '2026-01-01T00:01:00.000Z',
    },
    {
      assignment: 'review',
      executionMode: 'agent',
      parentChatId: 'chain-chat',
      executor: { transport: 'qwen', model: 'qwen-max' },
      createdAt: '2026-01-01T00:02:00.000Z',
      report: passReport,
    },
  ],
});
assert.equal(superseded.chatUsage.models['codebuddy/hy3'].next_review_passed, true, 'the newest implement owns the review');
assert.equal(superseded.chatUsage.models['deepseek/deepseek-flash'].next_review_passed, false, 'a superseded implement does not inherit a later review');

const credited = buildModelPickHistory({
  role: 'implement',
  chatId: 'chain-chat-2',
  harnesses: ['deepseek', 'codebuddy'],
  delegations: [
    {
      assignment: 'implement',
      executionMode: 'agent',
      parentChatId: 'chain-chat-2',
      executor: { transport: 'deepseek', model: 'deepseek-flash' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      assignment: 'review',
      executionMode: 'agent',
      parentChatId: 'chain-chat-2',
      executor: { transport: 'qwen', model: 'qwen-max' },
      createdAt: '2026-01-01T00:01:00.000Z',
      report: passReport,
    },
    {
      assignment: 'implement',
      executionMode: 'agent',
      parentChatId: 'chain-chat-2',
      executor: { transport: 'codebuddy', model: 'hy3' },
      createdAt: '2026-01-01T00:02:00.000Z',
    },
  ],
});
assert.equal(credited.chatUsage.models['deepseek/deepseek-flash'].next_review_passed, true, 'a review before the next implement credits the first');
assert.equal(credited.chatUsage.models['codebuddy/hy3'].next_review_passed, false);

// --- next_review_passed reflects the NEWEST implement->review cycle (not monotonic) ---
const failReport = 'TASK: review\nVERDICT: FAIL';
const chainRow = (chat, assignment, at, harness, model, report) => ({
  assignment,
  executionMode: 'agent',
  parentChatId: chat,
  status: 'completed',
  executor: { transport: harness, model },
  createdAt: at,
  ...(report === undefined ? {} : { report }),
});
const passThenNewImplementThenFail = buildModelPickHistory({
  role: 'implement',
  chatId: 'chain-fail',
  harnesses: ['deepseek'],
  delegations: [
    chainRow('chain-fail', 'implement', '2026-01-01T00:00:00.000Z', 'deepseek', 'deepseek-flash'),
    chainRow('chain-fail', 'review', '2026-01-01T00:01:00.000Z', 'qwen', 'qwen-max', passReport),
    chainRow('chain-fail', 'implement', '2026-01-01T00:02:00.000Z', 'deepseek', 'deepseek-flash'),
    chainRow('chain-fail', 'review', '2026-01-01T00:03:00.000Z', 'qwen', 'qwen-max', failReport),
  ],
});
assert.equal(
  passThenNewImplementThenFail.chatUsage.models['deepseek/deepseek-flash'].next_review_passed,
  false,
  'PASS -> new implement -> FAIL must clear the flag',
);

const fanoutCases = [
  { name: 'PASS+FAIL', reports: [passReport, failReport], expected: false },
  { name: 'FAIL+PASS', reports: [failReport, passReport], expected: false },
  { name: 'PASS+PASS', reports: [passReport, passReport], expected: true },
];
for (const [index, fanout] of fanoutCases.entries()) {
  const chat = `fanout-${index}`;
  const history = buildModelPickHistory({
    role: 'implement',
    chatId: chat,
    harnesses: ['deepseek'],
    delegations: [
      chainRow(chat, 'implement', '2026-01-01T00:00:00.000Z', 'deepseek', 'deepseek-flash'),
      ...fanout.reports.map((report, i) => chainRow(
        chat, 'review', `2026-01-01T00:0${i + 1}:00.000Z`, 'qwen', 'qwen-max', report,
      )),
    ],
  });
  assert.equal(
    history.chatUsage.models['deepseek/deepseek-flash'].next_review_passed,
    fanout.expected,
    `a ${fanout.name} review fanout must aggregate conservatively`,
  );
}

// --- Fresh limit hits are scoped to the model/base or the whole harness ---
const limitHarnesses = [{ id: 'a', enabled: true, ready: true, can_delegate: true }];
const limitModels = {
  a: {
    favorites_configured: true,
    items: [{ id: 'a-model', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  },
};
const siblingHit = selectModelPick({
  role: 'implement',
  harnesses: limitHarnesses,
  modelsByHarness: limitModels,
  history: { freshLimitHits: { a: { whole: false, models: ['other-model'] } } },
});
assert.equal(siblingHit.pick.plan_limit_penalty, 0, 'a sibling model incident must not penalise this model');
const sameModelHit = selectModelPick({
  role: 'implement',
  harnesses: limitHarnesses,
  modelsByHarness: limitModels,
  history: { freshLimitHits: { a: { whole: false, models: ['a-model'] } } },
});
assert.equal(sameModelHit.pick.plan_limit_penalty, PLAN_LIMIT_PENALTY, 'a same-base incident penalises the model');
const wholeHarnessHit = selectModelPick({
  role: 'implement',
  harnesses: limitHarnesses,
  modelsByHarness: limitModels,
  history: { freshLimitHits: { a: { whole: true, models: [] } } },
});
assert.equal(wholeHarnessHit.pick.plan_limit_penalty, PLAN_LIMIT_PENALTY, 'a model-less incident penalises the whole harness');

// --- Candidate order: rotation band first, then score; position 1 changes harness ---
const bandHarnesses = ['hx', 'hy', 'hz'].map((id) => ({ id, enabled: true, ready: true, can_delegate: true }));
const bandModels = {};
for (const id of ['hx', 'hy', 'hz']) {
  bandModels[id] = {
    favorites_configured: true,
    items: [{ id: `m-${id}`, roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }],
  };
}
const bandPick = selectModelPick({ role: 'implement', harnesses: bandHarnesses, modelsByHarness: bandModels });
assert.equal(bandPick.candidates.length, 3);
assert.equal(bandPick.candidates[0], bandPick.pick);
assert.deepEqual(
  bandPick.candidates.map((row) => row.harness),
  ['hx', 'hy', 'hz'],
  'the tie band keeps its rotation order',
);
assert.notEqual(bandPick.candidates[1].harness, bandPick.pick.harness, 'the infra fallback prefers a different harness');
assert.equal(bandPick.candidates[1].in_band, true);

// --- Delegations cache self-heals after a store write ---
const cacheChat = `cache-chat-${process.pid}`;
const cacheBefore = buildModelPickHistory({ role: 'implement', chatId: cacheChat, harnesses: ['deepseek'] });
assert.equal(cacheBefore.chatUsage.harnesses.deepseek || 0, 0);
createDelegationRecord({
  parentChatId: cacheChat,
  workspaceFolder: '/tmp/rotation',
  assignment: 'implement',
  status: 'completed',
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
});
const cacheAfter = buildModelPickHistory({ role: 'implement', chatId: cacheChat, harnesses: ['deepseek'] });
assert.equal(cacheAfter.chatUsage.harnesses.deepseek, 1, 'the cache must not hide a new delegation');

removeIsolatedDataDir();
console.log('model-pick-rotation.test.js OK');
