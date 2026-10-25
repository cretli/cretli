import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  computeModelPickExploreCredits,
  countAutoExecutedWorkload,
  evaluateModelPickExploration,
  exploreCandidateBlocks,
  exploreTaskBlocks,
  modelPickExplorePairKey,
  modelPickExploreCooldownMs,
  reserveModelPickExploreBudget,
  releaseModelPickExploreAttemptForDelegation,
  startModelPickExploreAttemptForDelegation,
  finishModelPickExploreAttemptForDelegation,
} from '../lib/model-pick-explore.js';
import {
  composeModelPickExploreSegment,
  MODEL_PICK_EXPLORE_CONFIG_DEFAULTS,
  normalizeModelPickExploreConfig,
} from '../lib/model-pick-policy.js';
import { selectModelPick } from '../lib/model-role-profiles.js';
import {
  loadModelPickExploreAttempts,
  reserveModelPickExploreAttempt,
} from '../lib/persist/model-pick-explore-persist.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const EXPLORE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explore-')), 'model-pick-explore.json');

function exploreContext(overrides = {}) {
  return {
    task: {
      kind: 'implement',
      boundedChanges: true,
      reviewMandatory: true,
      remainingDeadlineMs: 60 * 60 * 1000,
      executorMaxMs: 3 * 60 * 1000,
      ...overrides.task,
    },
    ...overrides,
  };
}

function outOfBandCandidate(harness, model, n = 2) {
  return {
    harness,
    model,
    in_band: false,
    observed: { n },
    cost_tier: 3,
    score: 0.1,
  };
}

test('grants would-explore to a low-n out-of-band pair in dry-run', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const assessment = evaluateModelPickExploration({
    role: 'implement',
    pick: { harness: 'a', model: 'winner', keep_winner: false, in_band: true },
    candidates: [outOfBandCandidate('b', 'glm-4.6', 3)],
    config,
    attempts: [],
    autoExecuted: 20,
    workspaceKey: 'ws-a',
    context: exploreContext(),
    now: NOW,
  });
  assert.equal(assessment?.decision, 'would-explore');
  assert.equal(assessment?.started, false);
  assert.equal(assessment?.wouldExplore, true);
  assert.match(assessment?.logLine || '', /pair=b\/glm-4\.6\/implement/);
  assert.match(assessment?.logLine || '', /^would-explore /);
});

test('variant models collapse to one pair key', () => {
  const high = modelPickExplorePairKey('h', 'glm-4.6::effort=high', 'implement');
  const low = modelPickExplorePairKey('h', 'glm-4.6', 'implement');
  assert.equal(high, low);
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const assessment = evaluateModelPickExploration({
    role: 'implement',
    pick: { harness: 'a', model: 'w', in_band: true },
    candidates: [
      outOfBandCandidate('h', 'glm-4.6::effort=high', 1),
      outOfBandCandidate('h', 'glm-4.6::effort=low', 1),
    ],
    config,
    attempts: [],
    autoExecuted: 30,
    workspaceKey: 'ws',
    context: exploreContext(),
    now: NOW,
  });
  assert.equal(assessment?.pairKey, high);
});

test('sample_sufficient blocks exploration at n>=minObservedN', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const blocked = exploreCandidateBlocks({
    candidate: outOfBandCandidate('h', 'm', 10),
    pick: { in_band: true },
    config,
  });
  assert.ok(blocked.includes('sample_sufficient'));
});

test('deterministic ordering prefers fewer completed attempts then smaller n', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const attempts = [
    {
      id: '1',
      pairKey: 'h/a/implement',
      harness: 'h',
      baseModel: 'a',
      model: 'a',
      role: 'implement',
      workspaceKey: 'ws',
      segment: composeModelPickExploreSegment(config),
      status: 'finished',
      outcome: 'completed',
      reservedAt: new Date(NOW - 5 * 86400000).toISOString(),
      startedAt: new Date(NOW - 5 * 86400000).toISOString(),
      finishedAt: new Date(NOW - 4 * 86400000).toISOString(),
    },
  ];
  const first = evaluateModelPickExploration({
    role: 'implement',
    pick: { harness: 'x', model: 'w', in_band: true },
    candidates: [
      outOfBandCandidate('h', 'a', 1),
      outOfBandCandidate('h', 'b', 1),
    ],
    config,
    attempts,
    autoExecuted: 50,
    workspaceKey: 'ws',
    context: exploreContext(),
    now: NOW,
  });
  assert.equal(first?.pairKey, 'h/b/implement');
});

test('keep_winner never explores the chat proven winner', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  const assessment = evaluateModelPickExploration({
    role: 'implement',
    pick: { harness: 'h', model: 'keep-me', keep_winner: true, in_band: true },
    candidates: [outOfBandCandidate('h', 'keep-me', 1)],
    config,
    attempts: [],
    autoExecuted: 40,
    workspaceKey: 'ws',
    context: exploreContext(),
    now: NOW,
  });
  assert.equal(assessment?.wouldExplore, false);
});

test('credits: one slot per ten auto jobs; manual excluded from denominator', () => {
  const credits = computeModelPickExploreCredits({ autoExecuted: 25, consumed: 2, everyAutoExecuted: 10 });
  assert.deepEqual(credits, { earned: 2, consumed: 2, remaining: 0 });
  const rows = [
    { pickOrigin: 'manual', pickRole: 'implement', status: 'completed', startedAt: new Date(NOW).toISOString() },
    { pickOrigin: 'auto', pickRole: 'implement', status: 'queued', startedAt: new Date(NOW).toISOString() },
    { pickOrigin: 'auto', pickRole: 'implement', status: 'running', startedAt: new Date(NOW).toISOString() },
  ];
  assert.equal(countAutoExecutedWorkload(rows, { now: NOW }), 1);
});

test('atomic reserve: concurrent starts only one succeeds; idempotency replays', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explore-lock-')), 'model-pick-explore.json');
  const config = normalizeModelPickExploreConfig({ mode: 'real', everyAutoExecuted: 1 });
  const marker = {
    pairKey: 'h/m/implement',
    harness: 'h',
    model: 'm',
    baseModel: 'm',
    role: 'implement',
    segment: 'real+explore-policy-2026-10-08',
    budgetUsd: 0.5,
    maxExecutorMs: 300000,
  };
  const base = {
    marker,
    pickId: 'pick-1',
    workspaceKey: 'ws',
    config,
    delegations: [{ pickOrigin: 'auto', pickRole: 'implement', status: 'completed', startedAt: new Date(NOW).toISOString() }],
    context: exploreContext(),
    file,
    now: NOW,
  };
  const first = await reserveModelPickExploreBudget({ ...base, delegationId: 'd1', idempotencyKey: 'k1' });
  const second = await reserveModelPickExploreBudget({ ...base, delegationId: 'd2', idempotencyKey: 'k2' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  const replay = await reserveModelPickExploreBudget({ ...base, delegationId: 'd1', idempotencyKey: 'k1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(loadModelPickExploreAttempts({ file }).length, 1);
});

test('cooldown: infra_fail and timeout lock; cancelled does not', () => {
  const config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  assert.equal(modelPickExploreCooldownMs({ outcome: 'infra_fail', config }), config.infraCooldownMs);
  assert.equal(modelPickExploreCooldownMs({ outcome: 'timeout', config }), Math.max(config.minPairIntervalMs, config.infraCooldownMs));
  assert.equal(modelPickExploreCooldownMs({ outcome: 'cancelled', config }), 0);
});

test('rollback after refused start releases budget slot', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explore-rb-')), 'model-pick-explore.json');
  await reserveModelPickExploreAttempt({
    pairKey: 'h/m/implement',
    harness: 'h',
    model: 'm',
    role: 'implement',
    delegationId: 'd-rb',
    idempotencyKey: 'rb-1',
    file,
    now: NOW,
  });
  assert.equal(releaseModelPickExploreAttemptForDelegation({ delegationId: 'd-rb', file }), true);
  assert.equal(countOpenAttempts(file), 0);
});

function countOpenAttempts(file) {
  return loadModelPickExploreAttempts({ file }).filter((row) => row.status === 'reserved' || row.status === 'started').length;
}

/** Shared inputs: in-band winner plus a low-n out-of-band pair that earns an explore credit. */
function buildDryRunSelectedUnchangedFixture() {
  const harnesses = [
    { id: 'band-a', enabled: true, ready: true, can_delegate: true },
    { id: 'explore-b', enabled: true, ready: true, can_delegate: true },
  ];
  const modelsByHarness = {
    'band-a': {
      favorites_configured: true,
      items: [{ id: 'winner-model', roles: ['implement'], cost_tier: 1, quality_tier: 5, speed_tier: 4 }],
    },
    'explore-b': {
      favorites_configured: true,
      items: [{ id: 'glm-4.6', roles: ['implement'], cost_tier: 3, quality_tier: 2, speed_tier: 2 }],
    },
  };
  const history = {
    pickIndex: 0,
    harnessUses7d: {},
    modelUses7d: {},
    lastUsedAt: {},
    coldStartHarnesses: new Set(),
    planLimits: {},
    observed: {
      'explore-b/glm-4.6': { n: 2, infra_fail_rate: 0, pass_rate: 0.5 },
    },
    chatUses: {},
  };
  const pickBase = {
    role: 'implement',
    harnesses,
    modelsByHarness,
    history,
    now: NOW,
  };
  const exploreLedger = {
    attempts: [],
    autoExecuted: 20,
    workspaceKey: 'ws-clause8-dry-run',
  };
  return { pickBase, exploreLedger, exploreContext: exploreContext() };
}

test('dry-run assessment does not start; mode off omits explore key', () => {
  const { pickBase, exploreLedger, exploreContext: ctx } = buildDryRunSelectedUnchangedFixture();
  const normal = selectModelPick({ ...pickBase });
  const dry = selectModelPick({
    ...pickBase,
    exploreConfig: normalizeModelPickExploreConfig({ mode: 'dry-run' }),
    exploreLedger,
    exploreContext: ctx,
  });
  assert.equal(dry.explore?.wouldExplore, true);
  assert.ok(dry.explore?.candidate);
  assert.notEqual(dry.explore.candidate.harness, dry.pick.harness);
  assert.notEqual(dry.explore.candidate.model, dry.pick.model);
  assert.equal(dry.explore.started, false);
  assert.equal(dry.pick.harness, normal.pick.harness);
  assert.equal(dry.pick.model, normal.pick.model);
  const off = selectModelPick({
    ...pickBase,
    exploreConfig: normalizeModelPickExploreConfig({ mode: 'off' }),
    exploreLedger,
    now: NOW,
  });
  assert.equal(off.explore, undefined);
});

test('task gate rejects fix-after-fail and last round', () => {
  const config = MODEL_PICK_EXPLORE_CONFIG_DEFAULTS;
  assert.ok(exploreTaskBlocks({
    role: 'fix',
    config,
    context: exploreContext({ task: { kind: 'fix', afterFail: true, boundedChanges: true, reviewMandatory: true, remainingDeadlineMs: 600000, executorMaxMs: 60000 } }),
    now: NOW,
  }).includes('fix_after_fail'));
  assert.ok(exploreTaskBlocks({
    role: 'implement',
    config,
    context: exploreContext({ task: { lastRound: true } }),
    now: NOW,
  }).includes('last_round'));
});

test('plan and review roles are not explored', () => {
  const config = normalizeModelPickExploreConfig({ mode: 'dry-run' });
  for (const role of ['plan', 'review']) {
    const assessment = evaluateModelPickExploration({
      role,
      pick: null,
      candidates: [outOfBandCandidate('h', 'm', 1)],
      config,
      attempts: [],
      autoExecuted: 100,
      workspaceKey: 'ws',
      context: exploreContext({ task: { kind: role, boundedChanges: true, reviewMandatory: true, remainingDeadlineMs: 600000, executorMaxMs: 60000 } }),
      now: NOW,
    });
    assert.equal(assessment?.wouldExplore, false);
  }
});

test('real lifecycle start and finish close attempt with cooldown', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'explore-lc-')), 'model-pick-explore.json');
  const marker = { mode: 'real', pairKey: 'h/m/implement', harness: 'h', model: 'm', role: 'implement' };
  await reserveModelPickExploreAttempt({
    pairKey: marker.pairKey,
    harness: 'h',
    model: 'm',
    role: 'implement',
    delegationId: 'd-lc',
    idempotencyKey: 'lc-1',
    file,
    now: NOW,
  });
  const started = startModelPickExploreAttemptForDelegation({ delegationId: 'd-lc', marker, file, now: NOW });
  assert.equal(started?.status, 'started');
  const finished = finishModelPickExploreAttemptForDelegation({
    delegationId: 'd-lc',
    outcome: 'infra_fail',
    marker,
    file,
    now: NOW,
  });
  assert.equal(finished?.outcome, 'infra_fail');
  assert.ok(finished?.cooldownUntil);
});
