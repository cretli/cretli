/**
 * Contract: ONE shared hard-gate validator for every model-selection path.
 *
 * `model_pick` (automatic), the Workspace Watcher orchestrator (explicit and
 * automatic), the fallback/exclude retry and `delegation_start` without
 * `pick_id` (named start) must refuse the same (harness, model, role) under the
 * same gate. The suite exercises each gate code on its own, proves picker
 * parity on one fixture, and confirms the Watcher close attribution stays
 * disjoint between the orchestrator and its children.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MODEL_PICK_HARD_GATE_CODES,
  evaluateModelPickHardGates,
} from '../lib/model-pick-hard-gates.js';
import { DELEGATION_MODEL_GATE_CODES, evaluateDelegationModelGate } from '../lib/delegation-model-gates.js';
import { selectModelPick } from '../lib/model-role-profiles.js';
import { resolveWorkspaceWatcherOrchestrator } from '../lib/workspace-watcher-orchestrator.js';
import { MCP_CAPABILITY_DENIED } from '../lib/mcp/mcp-orchestrator-contract.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.js';
import { noteHarnessUsageLimit } from '../lib/harness-usage-limits.js';
import {
  beginWorkspaceWatcherCycleMetric,
  finalizeWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetric,
  stampWorkspaceWatcherCycleMetricRequest,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import { correlateWorkspaceWatcherCycleUsage } from '../lib/workspace-watcher-cycle-metrics.js';

// Deterministic default review policy, independent of an operator escape hatch.
delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;

const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const FUTURE = new Date(Date.now() + HOUR).toISOString();
const PAST = new Date(Date.now() - HOUR).toISOString();

test('gate 1-2: role and model id are validated first', () => {
  assert.equal(
    evaluateModelPickHardGates({ role: 'audit', model: 'm' }).code,
    MODEL_PICK_HARD_GATE_CODES.ROLE_INVALID,
  );
  assert.equal(
    evaluateModelPickHardGates({ role: 'implement' }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_REQUIRED,
  );
});

test('gate 3: flash review needs the explicit confirmation', () => {
  assert.equal(
    evaluateModelPickHardGates({ role: 'review', harness: 'deepseek', model: 'deepseek-flash' }).code,
    MODEL_PICK_HARD_GATE_CODES.FLASH_REVIEW,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'review',
      harness: 'deepseek',
      model: 'deepseek-flash',
      checkReviewAdapter: false,
      allowFlashReview: true,
    }).ok,
    true,
  );
  // Implement may still use a flash id.
  assert.equal(
    evaluateModelPickHardGates({ role: 'implement', harness: 'deepseek', model: 'deepseek-flash' }).ok,
    true,
  );
  // The legacy façade maps to the historical code and message.
  assert.equal(
    evaluateDelegationModelGate({
      assignment: 'review',
      executionMode: 'agent',
      harness: 'deepseek',
      model: 'deepseek-flash',
    }).code,
    DELEGATION_MODEL_GATE_CODES.FLASH_REVIEW,
  );
});

test('gate 4: review-adapter certification is injectable and skippable', () => {
  const refusal = { ok: false, status: 409, code: 'review_uncertified', error: 'no guarantee', capabilities: {} };
  assert.equal(
    evaluateModelPickHardGates({ role: 'review', harness: 'codex', model: 'gpt-6-astra', reviewAdapter: refusal }).code,
    MODEL_PICK_HARD_GATE_CODES.REVIEW_UNCERTIFIED,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'review',
      harness: 'codex',
      model: 'gpt-6-astra',
      checkReviewAdapter: false,
      allowPremium: true,
    }).ok,
    true,
  );
  const allowed = evaluateModelPickHardGates({
    role: 'review',
    harness: 'codex',
    model: 'gpt-6-astra',
    allowPremium: true,
    reviewAdapter: { ok: true, reviewUncertified: true },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reviewUncertified, true, 'the opt-in is surfaced, not hidden');
});

test('gate 5: premium review needs a justification or an explicit override', () => {
  const base = {
    role: 'review',
    harness: 'sdk',
    model: 'grok-4.7',
    costTier: 5,
    sourceKind: 'text',
    checkReviewAdapter: false,
  };
  assert.equal(
    evaluateModelPickHardGates(base).code,
    MODEL_PICK_HARD_GATE_CODES.PREMIUM_JUSTIFICATION,
  );
  assert.equal(evaluateModelPickHardGates({ ...base, pickReason: 'Unusually complex migration review' }).ok, true);
  assert.equal(evaluateModelPickHardGates({ ...base, allowPremium: true }).ok, true);
  // A plan-source job is a build, not a reviewer.
  assert.equal(evaluateModelPickHardGates({ ...base, sourceKind: 'plan' }).ok, true);
});

test('gate 6-7: harness allow-list and enabled/ready/delegatable', () => {
  const base = { role: 'implement', harness: 'hb', model: 'm' };
  assert.equal(
    evaluateModelPickHardGates({ ...base, allowedHarnesses: ['ha'] }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_NOT_ALLOWED,
  );
  assert.equal(evaluateModelPickHardGates({ ...base, allowedHarnesses: ['ha', 'hb'] }).ok, true);
  assert.equal(
    evaluateModelPickHardGates({ ...base, harnessRow: { enabled: true, ready: false, can_delegate: true } }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_UNAVAILABLE,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, harnessRow: { enabled: true, ready: true, can_delegate: true } }).ok,
    true,
  );
});

test('gate 8: favorites configured and the model is an enabled favorite', () => {
  const base = { role: 'implement', harness: 'h', model: 'm' };
  assert.equal(
    evaluateModelPickHardGates({ ...base, favoritesConfigured: false }).code,
    MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, favoriteModels: [] }).code,
    MODEL_PICK_HARD_GATE_CODES.FAVORITES_MISSING,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, favoritesConfigured: true, favoriteModels: ['x'] }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_NOT_FAVORITE,
  );
  assert.equal(evaluateModelPickHardGates({ ...base, favoritesConfigured: true, favoriteModels: ['m'] }).ok, true);
});

test('gate 9: caller/history excludes are hard; the soft exclude is review-only', () => {
  const base = { role: 'implement', harness: 'h', model: 'm' };
  assert.equal(
    evaluateModelPickHardGates({ ...base, excludeModels: ['m'] }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, excludeHarnesses: ['h'] }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, historyExcludeModels: ['m'] }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED,
  );
  // The soft history preference never reaches implement.
  assert.equal(evaluateModelPickHardGates({ ...base, softExcludeModels: ['m'] }).ok, true);
  const review = { role: 'review', harness: 'h', model: 'm', checkReviewAdapter: false };
  assert.equal(
    evaluateModelPickHardGates({ ...review, softExcludeModels: ['m'] }).code,
    MODEL_PICK_HARD_GATE_CODES.HISTORY_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...review, softExcludeModels: ['m'], applySoftExcludes: false }).ok,
    true,
  );
});

test('gate 10-11: active lockout and quota are base-model aware', () => {
  const base = { role: 'implement', harness: 'h', model: 'model-x', now: Date.now() };
  assert.equal(
    evaluateModelPickHardGates({ ...base, lockouts: [{ harness: 'h', model: 'model-x', resetAt: FUTURE }] }).code,
    MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, lockouts: [{ harness: 'h', model: 'model-x', resetAt: PAST }] }).ok,
    true,
    'an expired lockout never blocks',
  );
  // A harness-wide quota row blocks every model of that harness.
  assert.equal(
    evaluateModelPickHardGates({ ...base, usageLimits: [{ harness: 'h', model: '', resetAt: FUTURE }] }).code,
    MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT,
  );
  // A sibling model row must not block.
  assert.equal(
    evaluateModelPickHardGates({ ...base, usageLimits: [{ harness: 'h', model: 'other', resetAt: FUTURE }] }).ok,
    true,
  );
  // Base-model aware: a lockout on the base id blocks a variant.
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'h',
      model: 'model-x::effort=high',
      usageLimits: [{ harness: 'h', model: 'model-x', resetAt: FUTURE }],
    }).code,
    MODEL_PICK_HARD_GATE_CODES.USAGE_LIMIT,
  );
});

test('gate 12: orchestrator MCP capability is required only when asked', () => {
  const base = { role: 'implement', harness: 'h', model: 'm', requireMcp: true };
  assert.equal(
    evaluateModelPickHardGates({
      ...base,
      mcpCapabilityProbe: () => ({ ok: false, reason: MCP_CAPABILITY_DENIED.TOOLS }),
    }).code,
    MODEL_PICK_HARD_GATE_CODES.MCP_CAPABILITY,
  );
  assert.equal(
    evaluateModelPickHardGates({ ...base, mcpCapabilityDenial: MCP_CAPABILITY_DENIED.TOOLS }).reason,
    MCP_CAPABILITY_DENIED.TOOLS,
  );
  assert.equal(evaluateModelPickHardGates({ ...base, mcpCapabilityProbe: () => ({ ok: true }) }).ok, true);
  // Skipped unless required.
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'h',
      model: 'm',
      mcpCapabilityProbe: () => ({ ok: false, reason: MCP_CAPABILITY_DENIED.TOOLS }),
    }).ok,
    true,
  );
});

test('picker parity: selectModelPick rejects exactly the candidates the validator rejects', () => {
  const harnesses = [
    { id: 'ha', enabled: true, ready: true, can_delegate: true },
    { id: 'hb', enabled: true, ready: true, can_delegate: true },
  ];
  const modelsByHarness = {
    ha: {
      favorites_configured: true,
      items: [
        { id: 'model-ok', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
        { id: 'deepseek-flash', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
      ],
    },
    hb: {
      favorites_configured: true,
      items: [
        { id: 'model-locked', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
        { id: 'model-excluded', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
      ],
    },
  };
  const lockouts = [{ harness: 'hb', model: 'model-locked', resetAt: FUTURE }];
  const pick = selectModelPick({
    role: 'review',
    harnesses,
    modelsByHarness,
    history: { lockouts },
    excludeModel: 'model-excluded',
  });
  assert.equal(pick.ok, true, pick.error);
  const admitted = new Set((pick.candidates || []).map((candidate) => `${candidate.harness}/${candidate.model}`));
  const pairs = [
    ['ha', 'model-ok'],
    ['ha', 'deepseek-flash'],
    ['hb', 'model-locked'],
    ['hb', 'model-excluded'],
  ];
  for (const [harness, model] of pairs) {
    const verdict = evaluateModelPickHardGates({
      role: 'review',
      harness,
      model,
      checkReviewAdapter: false,
      allowPremium: true,
      excludeModels: ['model-excluded'],
      lockouts,
    });
    assert.equal(admitted.has(`${harness}/${model}`), verdict.ok, `${harness}/${model} parity`);
  }
  assert.equal(admitted.has('ha/model-ok'), true);
  assert.equal(admitted.has('ha/deepseek-flash'), false, 'the picker skips flash for review');
  assert.equal(admitted.has('hb/model-locked'), false, 'the picker skips an active lockout');
  assert.equal(admitted.has('hb/model-excluded'), false, 'the picker honors caller excludes');
});

test('fallback path: exclude_model and exclude_harness are the same hard gate', () => {
  const harnesses = [
    { id: 'ha', enabled: true, ready: true, can_delegate: true },
    { id: 'hb', enabled: true, ready: true, can_delegate: true },
  ];
  const modelsByHarness = {
    ha: { favorites_configured: true, items: [{ id: 'model-a', roles: ['implement'] }] },
    hb: { favorites_configured: true, items: [{ id: 'model-b', roles: ['implement'] }] },
  };
  const pick = selectModelPick({
    role: 'implement',
    harnesses,
    modelsByHarness,
    excludeModel: 'model-a',
  });
  assert.equal(pick.ok, true, pick.error);
  assert.equal(pick.pick.model, 'model-b', 'the fallback retries without the excluded model');
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'ha',
      model: 'model-a',
      excludeModels: ['model-a'],
    }).code,
    MODEL_PICK_HARD_GATE_CODES.MODEL_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: 'ha',
      model: 'model-a',
      excludeHarnesses: ['ha'],
    }).code,
    MODEL_PICK_HARD_GATE_CODES.HARNESS_EXCLUDED,
  );
  assert.equal(
    evaluateModelPickHardGates({
      role: 'implement',
      harness: pick.pick.harness,
      model: pick.pick.model,
      excludeModels: ['model-a'],
    }).ok,
    true,
  );
});

test('explicit orchestrator path: allow-list, lockout, quota and excludes share the validator', async () => {
  const catalog = [{ id: 'mock', enabled: true, ready: true, can_delegate: true }];
  const models = async () => ({
    favorites_configured: true,
    items: [{ id: 'cheap', roles: ['implement'] }],
  });
  const deps = {
    listHarnessCatalog: async () => catalog,
    listHarnessModels: models,
    mcpCapabilityProbe: () => ({ ok: true }),
  };
  const explicitPolicy = { policy: { orchestrator: { harness: 'mock', model: 'cheap' } } };

  const ok = await resolveWorkspaceWatcherOrchestrator({ watcher: explicitPolicy, deps });
  assert.equal(ok.ok, true, ok.reason);

  const notAllowed = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['other'], orchestrator: { harness: 'mock', model: 'cheap' } } },
    deps,
  });
  assert.equal(notAllowed.reason, 'orchestrator_harness_not_allowed');

  const locked = await resolveWorkspaceWatcherOrchestrator({
    watcher: explicitPolicy,
    lockouts: [{ harness: 'mock', model: 'cheap', resetAt: FUTURE }],
    deps,
  });
  assert.equal(locked.reason, 'orchestrator_model_usage_limited', 'a lockout now blocks the explicit pair');

  const quota = await resolveWorkspaceWatcherOrchestrator({
    watcher: explicitPolicy,
    activeUsageLimits: [{ harness: 'mock', resetAt: FUTURE }],
    deps,
  });
  assert.equal(quota.reason, 'orchestrator_model_usage_limited');

  const excluded = await resolveWorkspaceWatcherOrchestrator({
    watcher: explicitPolicy,
    excludeModels: ['cheap'],
    deps,
  });
  assert.equal(excluded.reason, 'orchestrator_model_excluded', 'the exclusion gate is now wired in');
});

test('named start without pick_id cannot bypass an active lockout', async () => {
  resetMockChatRuns();
  registerMockChatRunAdapter('deepseek');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hard-gates-'));
  const service = createDelegationService({
    workspaceDirForAgent: () => project,
    isModelAvailable: () => true,
  });
  const parent = addChat('hard-gates-parent', 'Hard gates parent', null, project, 'planner-model', {
    agentTransport: 'sdk',
    sdkMode: 'agent',
  });
  noteHarnessUsageLimit({
    harness: 'deepseek',
    model: 'locked-model',
    message: 'usage limit reached; resets at 2099-01-01T00:00:00Z',
  });
  const refused = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'deepseek', model: 'locked-model' },
    sourceKind: 'text',
    taskText: 'Implement the change.',
    assignment: 'implement',
    idempotencyKey: 'hard-gates-lockout-refused',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, MODEL_PICK_HARD_GATE_CODES.ACTIVE_LOCKOUT);
  fs.rmSync(project, { recursive: true, force: true });
});

test('orchestrator attribution: model identity, mode, outcome, duration and disjoint cost', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hard-gates-attrib-'));
  const cycleId = 'cyc-attrib';
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId,
    workspaceFolder: '/w',
    mode: 'implement',
    orchestratorChatId: 'orch-1',
    todoIds: ['t1'],
    startedAt: iso(T0),
  });
  stampWorkspaceWatcherCycleMetricRequest({
    dataDir,
    cycleId,
    requestedHarness: 'mock',
    requestedModel: 'cheap',
    requestedSource: 'implement_pick',
  });
  finalizeWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId,
    closeSource: 'report',
    closeOutcome: 'success',
    reportedOutcome: 'success',
    closedAt: iso(T0 + 60_000),
    reachedRunning: true,
  });
  const row = getWorkspaceWatcherCycleMetric(cycleId, { dataDir });
  assert.equal(row.mode, 'implement');
  assert.equal(row.requestedHarness, 'mock');
  assert.equal(row.requestedModel, 'cheap');
  assert.equal(row.reportedOutcome, 'success');
  assert.equal(row.closeOutcome, 'success');
  assert.equal(Date.parse(row.closedAt) - Date.parse(row.startedAt), 60_000, 'duration comes from startedAt/closedAt');

  const usage = correlateWorkspaceWatcherCycleUsage({
    cycleId,
    orchestratorChatId: 'orch-1',
    orchestratorRunIds: ['run-1'],
    startedAt: row.startedAt,
    closedAt: row.closedAt,
  }, {
    events: [
      {
        id: 'e1', at: iso(T0 + 1000), eventType: 'delta', harness: 'mock', identityClass: 'durable_sequence',
        logicalEventKey: 'o1', cycleId, chatId: 'orch-1', runId: 'run-1', tokens: { textInput: 100 }, usd: 1,
      },
      {
        id: 'e2', at: iso(T0 + 2000), eventType: 'delta', harness: 'mock', identityClass: 'durable_sequence',
        logicalEventKey: 'c1', cycleId, delegationId: 'del-1', chatId: 'child-1', runId: 'child-run-1',
        tokens: { textInput: 50 }, usd: 0.5,
      },
    ],
    delegations: [{
      id: 'del-1', parentChatId: 'orch-1', childChatId: 'child-1', runId: 'child-run-1',
      attemptId: 'a1', status: 'completed',
    }],
    now: T0 + 2 * HOUR,
  });
  assert.equal(usage.orchestrator.own.totalTokens, 100, 'orchestrator bucket holds only its own run');
  assert.equal(usage.children.own.totalTokens, 50, 'child cost stays in its own bucket');
  assert.equal(usage.tree.own.totalTokens, 150, 'tree = orchestrator own + child own');
  assert.equal(usage.orchestrator.own.cost.reportedUsd, 1);
  assert.equal(usage.children.own.cost.reportedUsd, 0.5);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

console.log('model-pick-hard-gates.test.js OK');
