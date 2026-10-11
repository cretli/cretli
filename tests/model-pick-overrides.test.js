/**
 * Pure contract for the audited model-selection overrides.
 *
 * Covers the mandatory server-owned fields and bounded TTL, the scope/role
 * matching, the workspace > global precedence, the combined excludes, the
 * equal-precedence explicit conflict, and the rule that an override never
 * bypasses a shared hard gate. No file is read or written here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_PICK_OVERRIDE_AUDIT_TYPES,
  MODEL_PICK_OVERRIDE_ERROR_CODES,
  MODEL_PICK_OVERRIDE_MAX_TTL_MS,
  ModelPickOverrideError,
  applyModelPickOverridePreference,
  buildModelPickOverrideAuditEvent,
  collectModelPickOverrideEffects,
  evaluateModelPickStartOverrides,
  isModelPickOverrideActive,
  isModelPickPairExcluded,
  normalizeModelPickOverride,
  resolveModelPickOverrideDecision,
} from '../lib/model-pick-overrides.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

/**
 * @param {object} [overrides]
 * @param {number} [ttlMs]
 * @returns {object}
 */
function baseOverride(overrides = {}, ttlMs = 60 * 60 * 1000) {
  return {
    action: 'exclude',
    targetHarness: 'codex',
    reason: 'planned maintenance window',
    expiresAt: new Date(NOW + ttlMs).toISOString(),
    ...overrides,
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function serverContext(overrides = {}) {
  return { now: NOW, createdBy: 'operator', source: 'test', generateId: () => 'ov-1', ...overrides };
}

test('the server owns identity and time; a body cannot forge them', () => {
  const record = normalizeModelPickOverride(baseOverride({
    id: 'client-id-ignored',
    createdBy: 'hacker',
    source: 'hacker',
    createdAt: '1999-01-01T00:00:00.000Z',
    now: 12345,
  }), serverContext());
  assert.equal(record.id, 'ov-1');
  assert.equal(record.createdBy, 'operator');
  assert.equal(record.source, 'test');
  assert.equal(record.createdAt, new Date(NOW).toISOString());
  assert.equal(record.scope, 'global');
  assert.equal(record.now, undefined);
});

test('TTL is mandatory and bounded to the configured window', () => {
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ expiresAt: undefined }), serverContext()),
    (err) => err instanceof ModelPickOverrideError && err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TTL,
  );
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ expiresAt: new Date(NOW - 1000).toISOString() }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TTL,
  );
  assert.throws(
    () => normalizeModelPickOverride(
      baseOverride({ expiresAt: new Date(NOW + MODEL_PICK_OVERRIDE_MAX_TTL_MS + 1000).toISOString() }),
      serverContext(),
    ),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TTL,
  );
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ expiresAt: new Date(NOW + 1000).toISOString() }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TTL,
  );
});

test('action, target and reason are validated', () => {
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ action: 'approve' }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.ACTION,
  );
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ targetHarness: '', targetModel: '', targetRole: '' }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TARGET,
  );
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ action: 'explicit-orchestrator', targetHarness: '' }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.TARGET,
  );
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ reason: '' }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.REASON,
  );
});

test('a workspace override requires and matches its folder', () => {
  const record = normalizeModelPickOverride(
    baseOverride({ scope: 'workspace', workspaceFolder: '/w/App' }),
    serverContext(),
  );
  assert.equal(record.scope, 'workspace');
  assert.equal(record.workspaceFolder, '/w/app');
  const here = collectModelPickOverrideEffects({ overrides: [record], now: NOW, workspaceFolder: '/w/app/', role: 'implement' });
  assert.deepEqual(here.excludedHarnesses, ['codex']);
  const elsewhere = collectModelPickOverrideEffects({ overrides: [record], now: NOW, workspaceFolder: '/w/other', role: 'implement' });
  assert.deepEqual(elsewhere.excludedHarnesses, []);
  assert.throws(
    () => normalizeModelPickOverride(baseOverride({ scope: 'workspace', workspaceFolder: '' }), serverContext()),
    (err) => err.code === MODEL_PICK_OVERRIDE_ERROR_CODES.WORKSPACE,
  );
});

test('expired and revoked overrides are inactive and audited', () => {
  const expired = normalizeModelPickOverride(
    baseOverride({ id: 'expired', expiresAt: new Date(NOW + 60 * 1000).toISOString() }),
    { now: NOW, generateId: () => 'expired' },
  );
  assert.equal(isModelPickOverrideActive(expired, NOW + 120 * 1000), false);
  const effects = collectModelPickOverrideEffects({ overrides: [expired], now: NOW + 120 * 1000, role: 'implement' });
  assert.equal(effects.active.length, 0);
  assert.equal(effects.expired.length, 1);
  assert.ok(effects.audit.some((row) => row.type === 'expire'));

  const revoked = { ...expired, revokedAt: new Date(NOW).toISOString() };
  assert.equal(isModelPickOverrideActive(revoked, NOW), false);
  const revokedEffects = collectModelPickOverrideEffects({ overrides: [revoked], now: NOW, role: 'implement' });
  assert.equal(revokedEffects.active.length, 0);
  assert.equal(revokedEffects.expired.length, 0);
});

test('role scoping leaves other roles untouched', () => {
  const reviewOnly = normalizeModelPickOverride(
    baseOverride({ id: 'rev', targetRole: 'review' }),
    { now: NOW, generateId: () => 'rev' },
  );
  const review = collectModelPickOverrideEffects({ overrides: [reviewOnly], now: NOW, role: 'review' });
  assert.deepEqual(review.excludedHarnesses, ['codex']);
  const implement = collectModelPickOverrideEffects({ overrides: [reviewOnly], now: NOW, role: 'implement' });
  assert.deepEqual(implement.excludedHarnesses, []);
});

test('pair exclude is harness+model scoped, not harness-wide or model-wide', () => {
  const pairOnly = normalizeModelPickOverride(
    baseOverride({ id: 'pair', targetHarness: 'codex', targetModel: 'gpt-5' }),
    { now: NOW, generateId: () => 'pair' },
  );
  const effects = collectModelPickOverrideEffects({ overrides: [pairOnly], now: NOW, role: 'implement' });
  assert.deepEqual(effects.excludedHarnesses, []);
  assert.deepEqual(effects.excludedModels, []);
  assert.deepEqual(effects.excludedPairs, [{ harness: 'codex', model: 'gpt-5' }]);
  assert.equal(isModelPickPairExcluded([pairOnly], {
    harness: 'codex', model: 'gpt-5', role: 'implement', now: NOW,
  }), true);
  assert.equal(isModelPickPairExcluded([pairOnly], {
    harness: 'codex', model: 'gpt-4', role: 'implement', now: NOW,
  }), false);
  assert.equal(isModelPickPairExcluded([pairOnly], {
    harness: 'qwen', model: 'gpt-5', role: 'implement', now: NOW,
  }), false);

  const harnessOnly = normalizeModelPickOverride(
    baseOverride({ id: 'h', targetHarness: 'codex', targetModel: '' }),
    { now: NOW, generateId: () => 'h' },
  );
  const harnessFx = collectModelPickOverrideEffects({ overrides: [harnessOnly], now: NOW, role: 'implement' });
  assert.deepEqual(harnessFx.excludedHarnesses, ['codex']);
  assert.deepEqual(harnessFx.excludedPairs, []);

  const modelOnly = normalizeModelPickOverride(
    baseOverride({ id: 'm', targetHarness: '', targetModel: 'gpt-5' }),
    { now: NOW, generateId: () => 'm' },
  );
  const modelFx = collectModelPickOverrideEffects({ overrides: [modelOnly], now: NOW, role: 'implement' });
  assert.deepEqual(modelFx.excludedModels, ['gpt-5']);
  assert.deepEqual(modelFx.excludedPairs, []);
});

test('pair exclude flows through the shared hard gate without blocking siblings', () => {
  const pairOnly = normalizeModelPickOverride(
    baseOverride({ id: 'pair', targetHarness: 'a', targetModel: 'm-a' }),
    { now: NOW, generateId: () => 'pair' },
  );
  const blocked = evaluateModelPickStartOverrides({
    overrides: [pairOnly],
    now: NOW,
    role: 'implement',
    harness: 'a',
    model: 'm-a',
    hardGateInput: {},
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.verdict.code, 'model_excluded');
  const siblingModel = evaluateModelPickStartOverrides({
    overrides: [pairOnly],
    now: NOW,
    role: 'implement',
    harness: 'a',
    model: 'm-b',
    hardGateInput: {},
  });
  assert.equal(siblingModel.ok, true);
  const otherHarness = evaluateModelPickStartOverrides({
    overrides: [pairOnly],
    now: NOW,
    role: 'implement',
    harness: 'b',
    model: 'm-a',
    hardGateInput: {},
  });
  assert.equal(otherHarness.ok, true);
});

test('excludes from every active scope are combined', () => {
  const global = normalizeModelPickOverride(
    baseOverride({ id: 'g', targetHarness: 'codex' }),
    { now: NOW, generateId: () => 'g' },
  );
  const workspace = normalizeModelPickOverride(
    baseOverride({ id: 'w', scope: 'workspace', workspaceFolder: '/w/app', targetHarness: 'qwen' }),
    { now: NOW, generateId: () => 'w' },
  );
  const decision = resolveModelPickOverrideDecision({
    overrides: [global, workspace],
    now: NOW,
    role: 'implement',
    workspaceFolder: '/w/app',
  });
  assert.deepEqual([...decision.excludedHarnesses].sort(), ['codex', 'qwen']);
  assert.equal(isModelPickPairExcluded([global, workspace], {
    harness: 'qwen', model: 'qwen-max', role: 'implement', workspaceFolder: '/w/app', now: NOW,
  }), true);
  assert.equal(isModelPickPairExcluded([global, workspace], {
    harness: 'qwen', model: 'qwen-max', role: 'implement', workspaceFolder: '/w/other', now: NOW,
  }), false);
});

test('workspace explicit outranks global explicit, equal precedence conflicts', () => {
  const global = normalizeModelPickOverride(
    baseOverride({ id: 'g', action: 'explicit-orchestrator', targetHarness: 'codex', targetModel: 'gpt-5' }),
    { now: NOW, generateId: () => 'g' },
  );
  const workspace = normalizeModelPickOverride(
    baseOverride({ id: 'w', scope: 'workspace', workspaceFolder: '/w/app', action: 'explicit-orchestrator', targetHarness: 'qwen', targetModel: 'qwen-max' }),
    { now: NOW, generateId: () => 'w' },
  );
  const decision = resolveModelPickOverrideDecision({
    overrides: [global, workspace],
    now: NOW,
    workspaceFolder: '/w/app',
    role: 'implement',
  });
  assert.equal(decision.conflict, null);
  assert.equal(decision.explicit.harness, 'qwen');
  assert.equal(decision.explicit.overrideId, 'w');

  const secondGlobal = normalizeModelPickOverride(
    baseOverride({ id: 'g2', action: 'explicit-orchestrator', targetHarness: 'mistral', targetModel: 'm-large' }),
    { now: NOW, generateId: () => 'g2' },
  );
  const conflict = resolveModelPickOverrideDecision({
    overrides: [global, secondGlobal],
    now: NOW,
    role: 'implement',
  });
  assert.ok(conflict.conflict);
  assert.equal(conflict.conflict.code, MODEL_PICK_OVERRIDE_ERROR_CODES.CONFLICT);
  assert.ok(conflict.refusals.length >= 2);
});

test('an override never bypasses a shared hard gate', () => {
  const explicit = normalizeModelPickOverride(
    baseOverride({ id: 'exp', action: 'explicit-orchestrator', targetHarness: 'codex', targetModel: 'gpt-5' }),
    { now: NOW, generateId: () => 'exp' },
  );
  // The model does not claim the role, so the shared validator must refuse even
  // though an explicit override names it.
  const result = evaluateModelPickStartOverrides({
    overrides: [explicit],
    now: NOW,
    role: 'implement',
    harness: 'codex',
    model: 'gpt-5',
    hardGateInput: { modelRoles: ['plan'] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.code, 'role_membership');

  // An active exclude is enforced by the same validator as an exclusion.
  const exclude = normalizeModelPickOverride(
    baseOverride({ id: 'ex', action: 'exclude', targetHarness: 'codex' }),
    { now: NOW, generateId: () => 'ex' },
  );
  const excluded = evaluateModelPickStartOverrides({
    overrides: [exclude],
    now: NOW,
    role: 'implement',
    harness: 'codex',
    model: 'gpt-5',
    hardGateInput: {},
  });
  assert.equal(excluded.ok, false);
  assert.equal(excluded.verdict.code, 'harness_excluded');
});

test('prefer only reorders candidates that already survived the gates', () => {
  const prefer = normalizeModelPickOverride(
    baseOverride({ id: 'p', action: 'prefer', targetHarness: 'b', targetModel: 'm-b' }),
    { now: NOW, generateId: () => 'p' },
  );
  const decision = resolveModelPickOverrideDecision({ overrides: [prefer], now: NOW, role: 'implement' });
  const candidateA = { harness: 'a', model: 'm-a' };
  const candidateB = { harness: 'b', model: 'm-b' };
  const picked = { ok: true, pick: candidateA, picks: [candidateA], candidates: [candidateA, candidateB] };
  const promoted = applyModelPickOverridePreference(picked, decision);
  assert.equal(promoted.pick.harness, 'b');
  assert.equal(promoted.overrides.preferred_applied, true);

  // A preferred pair absent from the eligible list cannot be resurrected.
  const noB = { ok: true, pick: candidateA, picks: [candidateA], candidates: [candidateA] };
  const unchanged = applyModelPickOverridePreference(noB, decision);
  assert.equal(unchanged.pick.harness, 'a');
  assert.equal(unchanged.overrides.preferred_applied, false);
});

test('a workspace prefer outranks a global prefer', () => {
  const global = normalizeModelPickOverride(
    baseOverride({ id: 'pg', action: 'prefer', targetHarness: 'codex', targetModel: 'gpt-5' }),
    { now: NOW, generateId: () => 'pg' },
  );
  const workspace = normalizeModelPickOverride(
    baseOverride({ id: 'pw', scope: 'workspace', workspaceFolder: '/w/app', action: 'prefer', targetHarness: 'qwen', targetModel: 'qwen-max' }),
    { now: NOW, generateId: () => 'pw' },
  );
  const decision = resolveModelPickOverrideDecision({
    overrides: [global, workspace],
    now: NOW,
    role: 'implement',
    workspaceFolder: '/w/app',
  });
  assert.equal(decision.preferredPairs[0].overrideId, 'pw');
  assert.equal(decision.preferredPairs[0].scope, 'workspace');
});

test('audit event builder only accepts the closed type set', () => {
  assert.ok(MODEL_PICK_OVERRIDE_AUDIT_TYPES.includes('refuse'));
  const event = buildModelPickOverrideAuditEvent({ type: 'teleport', id: 'x' });
  assert.equal(event.type, 'refuse');
  assert.equal(event.id, 'x');
});
