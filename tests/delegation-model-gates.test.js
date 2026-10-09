/**
 * Contract: `model_pick` and `delegation_start` must agree on the start gates.
 *
 * The picker filters candidates before proposing one; a named start must not
 * silently bypass a rule the picker enforces. This suite exercises the shared
 * `evaluateDelegationModelGate` decision next to the real `selectModelPick`
 * behaviour for the same inputs, plus the observed high-infra ordering and the
 * real limit-store feeding.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectModelPick, isHighInfraRiskObserved } from '../lib/model-role-profiles.js';
import {
  DELEGATION_MODEL_GATE_CODES,
  evaluateDelegationModelGate,
  resolveDelegationGateRole,
} from '../lib/delegation-model-gates.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { isDelegationModelAvailable } from '../lib/delegation-executor.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import {
  listHarnessUsageLimits,
  noteHarnessUsageLimit,
  readHarnessUsageLimitHistory,
} from '../lib/harness-usage-limits.js';
import { noteHarnessPlanLimit, readHarnessPlanLimits } from '../lib/usage/harness-health.js';

// Deterministic default review policy, independent of an operator escape hatch
// set in the parent process.
delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;

const deepseekHarness = { id: 'deepseek', enabled: true, ready: true, can_delegate: true };
const sdkHarness = { id: 'sdk', enabled: true, ready: true, can_delegate: true };

// --- Role resolution ---------------------------------------------------------
assert.equal(resolveDelegationGateRole({ assignment: 'review', executionMode: 'agent' }), 'review');
assert.equal(resolveDelegationGateRole({ assignment: 'review', executionMode: 'plan' }), 'plan');
assert.equal(resolveDelegationGateRole({ assignment: 'implement', executionMode: 'agent' }), 'implement');
assert.equal(resolveDelegationGateRole({ role: 'fix', assignment: 'implement' }), 'fix');

// --- Flash review: both sides reject without the explicit confirmation --------
const flashModels = {
  deepseek: { favorites_configured: true, items: [{ id: 'deepseek-flash', roles: ['review'] }] },
};
const flashGate = evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  harness: 'deepseek',
  model: 'deepseek-flash',
});
assert.equal(flashGate.ok, false);
assert.equal(flashGate.code, DELEGATION_MODEL_GATE_CODES.FLASH_REVIEW);
const flashPick = selectModelPick({ role: 'review', harnesses: [deepseekHarness], modelsByHarness: flashModels });
assert.equal(flashPick.ok, false, 'the picker never proposes a flash reviewer');
assert.equal(flashPick.code, 'MODEL_UNAVAILABLE');
assert.match(flashPick.error, /flash model\(s\) skipped for review/);
// The named path may proceed only with the explicit opt-in; the picker still
// never proposes flash (a flash id is a person's deliberate named choice).
assert.equal(evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  harness: 'deepseek',
  model: 'deepseek-flash',
  allowFlashReview: true,
}).ok, true);
assert.equal(selectModelPick({ role: 'review', harnesses: [deepseekHarness], modelsByHarness: flashModels }).ok, false);
// Implement may use flash on both sides.
assert.equal(evaluateDelegationModelGate({
  assignment: 'implement',
  executionMode: 'agent',
  harness: 'deepseek',
  model: 'deepseek-flash',
}).ok, true);

// --- Uncertified review harness: both sides reject by default ----------------
const codexHarness = { id: 'codex', enabled: true, ready: true, can_delegate: true };
const codexModels = {
  codex: { favorites_configured: true, items: [{ id: 'gpt-6-astra', roles: ['review'] }] },
};
const codexGate = evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  harness: 'codex',
  model: 'gpt-6-astra',
});
assert.equal(codexGate.ok, false);
assert.equal(codexGate.code, 'review_uncertified');
const codexPick = selectModelPick({
  role: 'review',
  checkReviewAdapter: true,
  harnesses: [codexHarness],
  modelsByHarness: codexModels,
});
assert.equal(codexPick.ok, false, 'the picker skips an uncertified review harness');
assert.match(codexPick.error, /review adapter guarantee/);
// The operator escape hatch flips both sides together.
process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED = '1';
try {
  const allowedGate = evaluateDelegationModelGate({
    assignment: 'review',
    executionMode: 'agent',
    harness: 'codex',
    model: 'gpt-6-astra',
    allowPremium: true,
  });
  assert.equal(allowedGate.ok, true);
  assert.equal(allowedGate.reviewUncertified, true, 'the opt-in is surfaced, not hidden');
  assert.equal(allowedGate.costTier, 5);
  const allowedPick = selectModelPick({
    role: 'review',
    checkReviewAdapter: true,
    harnesses: [codexHarness],
    modelsByHarness: codexModels,
  });
  assert.equal(allowedPick.ok, true, 'the picker admits it under the same opt-in');
  assert.equal(allowedPick.pick.model, 'gpt-6-astra');
} finally {
  delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
}

// --- High infra: demoted out of the top-2 unless the exception is passed ------
const triHarnesses = [
  { id: 'ha', enabled: true, ready: true, can_delegate: true },
  { id: 'hb', enabled: true, ready: true, can_delegate: true },
  { id: 'hc', enabled: true, ready: true, can_delegate: true },
];
const triModels = {
  ha: { favorites_configured: true, items: [{ id: 'model-a', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  hb: { favorites_configured: true, items: [{ id: 'model-b', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
  hc: { favorites_configured: true, items: [{ id: 'model-c', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 }] },
};
const infraHistory = {
  prior: { infra_fail_rate: 0 },
  observed: { 'ha/model-a': { n: 13, infra_fail_rate: 0.69, quality: 4 } },
};
assert.equal(isHighInfraRiskObserved(infraHistory.observed['ha/model-a']), true);
assert.equal(isHighInfraRiskObserved({ n: 2, infra_fail_rate: 1 }), false, 'a two-job rate is noise');
const gatedPick = selectModelPick({
  role: 'review',
  harnesses: triHarnesses,
  modelsByHarness: triModels,
  history: infraHistory,
  adaptive: false,
});
assert.equal(gatedPick.pick.harness, 'hb', 'the high-infra leader is not the pick');
const topTwo = gatedPick.candidates.slice(0, 2).map((row) => row.harness);
assert.equal(topTwo.includes('ha'), false, 'the high-infra model is not in the top-2 candidates');
assert.match(gatedPick.pick.reason, /high-infra-risk band leader demoted/);
const exceptionPick = selectModelPick({
  role: 'review',
  harnesses: triHarnesses,
  modelsByHarness: triModels,
  history: infraHistory,
  adaptive: false,
  allowHighInfra: true,
});
assert.equal(exceptionPick.pick.harness, 'ha', 'the explicit exception restores the score order');
assert.equal(exceptionPick.candidates[0].harness, 'ha');

// --- Premium review: named start needs a justification, picker names it -------
const premiumModels = {
  sdk: { favorites_configured: true, items: [{ id: 'grok-4.7', roles: ['review'], cost_tier: 4, quality_tier: 5, speed_tier: 3 }] },
};
const premiumPick = selectModelPick({ role: 'review', harnesses: [sdkHarness], modelsByHarness: premiumModels });
assert.equal(premiumPick.ok, true);
assert.match(premiumPick.pick.reason, /premium cost tier 4 review pick/);
const premiumGate = evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  harness: 'sdk',
  model: 'grok-4.7',
});
assert.equal(premiumGate.ok, false);
assert.equal(premiumGate.code, DELEGATION_MODEL_GATE_CODES.PREMIUM_JUSTIFICATION);
assert.equal(evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'text',
  harness: 'sdk',
  model: 'grok-4.7',
  pickReason: 'Unusually complex migration; premium reviewer justified by the failure history',
}).ok, true);
// A plan-source job is a build, not a reviewer: premium restraint does not apply.
assert.equal(evaluateDelegationModelGate({
  assignment: 'review',
  executionMode: 'agent',
  sourceKind: 'plan',
  harness: 'sdk',
  model: 'grok-4.7',
}).ok, true);

// --- Empty favorites: both sides refuse --------------------------------------
{
  const previousEmptyPolicy = process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
  process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'deny';
  try {
    assert.equal(
      isDelegationModelAvailable({
        transport: 'opencode',
        model: 'opencode/test',
        settings: { opencodeChatEnabledModels: [] },
      }),
      false,
      'the named start refuses an empty-favorites harness',
    );
    const emptyPick = selectModelPick({
      role: 'implement',
      harnesses: [{ id: 'opencode', enabled: true, ready: true, can_delegate: true }],
      modelsByHarness: { opencode: { favorites_configured: false, items: [] } },
    });
    assert.equal(emptyPick.ok, false, 'the picker refuses an empty-favorites harness');
    assert.equal(emptyPick.code, 'MODEL_UNAVAILABLE');
  } finally {
    if (previousEmptyPolicy == null) delete process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
    else process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = previousEmptyPolicy;
  }
}

// --- Real limit events actually reach the picker's history ---------------------
const lockRecorded = noteHarnessUsageLimit({
  harness: 'deepseek',
  model: 'glm-5.3',
  message: 'usage limit reached; resets at 2099-01-01T00:00:00Z',
});
assert.equal(lockRecorded, true);
assert.ok(
  listHarnessUsageLimits().some((row) => row.harness === 'deepseek' && row.model === 'glm-5.3'),
  'the lockout store carries the real event',
);
const historyRows = readHarnessUsageLimitHistory({ harness: 'deepseek' });
assert.equal(historyRows.length >= 1, true, 'the fresh limit-hit history carries the event');
const realHistory = buildModelPickHistory({ role: 'review', harnesses: ['deepseek'] });
assert.ok(realHistory.lockouts.length >= 1, 'buildModelPickHistory reads the real lockout store');
const lockedPick = selectModelPick({
  role: 'review',
  harnesses: [deepseekHarness],
  modelsByHarness: { deepseek: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'] }] } },
  history: realHistory,
});
assert.equal(lockedPick.ok, false, 'a model under a real lockout is dropped');

// Plan-limit events carry utilization, so the penalty fires from the store.
noteHarnessPlanLimit({
  harness: 'sdk',
  status: 'allowed',
  utilization: 95,
  rateLimitType: 'five_hour',
  resetsAt: '2099-01-01T00:00:00Z',
  observedAt: new Date().toISOString(),
});
const planLimits = readHarnessPlanLimits('sdk');
assert.equal(planLimits[0].utilization, 95);
const planHistory = buildModelPickHistory({ role: 'review', harnesses: ['sdk'] });
assert.ok(planHistory.planLimits.some((row) => Number(row.utilization) >= 90), 'the plan store feeds the history');
const planPick = selectModelPick({
  role: 'review',
  harnesses: [sdkHarness],
  modelsByHarness: { sdk: { favorites_configured: true, items: [{ id: 'glm-5.3', roles: ['review'] }] } },
  history: planHistory,
});
assert.ok(planPick.ok);
assert.ok(planPick.pick.plan_limit_penalty > 0, 'the fresh plan limit penalises the pick');

// --- delegation_start enforces the same flash gate end to end ----------------
resetMockChatRuns();
registerMockChatRunAdapter('deepseek');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-model-gates-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});
const parent = addChat('gates-review-parent', 'Gates review parent', null, project, 'planner-model', {
  agentTransport: 'sdk',
  sdkMode: 'agent',
});
const refusedStart = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
  sourceKind: 'text',
  taskText: 'Review the change for correctness.',
  assignment: 'review',
  idempotencyKey: 'gates-flash-review-refused',
});
assert.equal(refusedStart.ok, false);
assert.equal(refusedStart.code, DELEGATION_MODEL_GATE_CODES.FLASH_REVIEW);
const confirmedStart = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
  sourceKind: 'text',
  taskText: 'Review the change for correctness.',
  assignment: 'review',
  allowFlashReview: true,
  idempotencyKey: 'gates-flash-review-confirmed',
});
assert.equal(confirmedStart.ok, true, confirmedStart.error || '');
assert.equal(confirmedStart.delegation.assignment, 'review');
// Replaying the same key without the confirmation still returns the existing
// job: the gate runs after the idempotency replay.
const replayedStart = await service.createAndStart({
  parentChatId: parent.id,
  executor: { transport: 'deepseek', model: 'deepseek-flash' },
  sourceKind: 'text',
  taskText: 'Review the change for correctness.',
  assignment: 'review',
  idempotencyKey: 'gates-flash-review-confirmed',
});
assert.equal(replayedStart.ok, true, replayedStart.error || '');
assert.equal(replayedStart.replayed, true);
fs.rmSync(project, { recursive: true, force: true });

console.log('delegation-model-gates.test.js OK');
