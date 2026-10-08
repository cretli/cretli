import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNKNOWN_FAMILY_FALLBACK,
  compileModelNameRule,
  compileModelNameRules,
  matchesModelFamily,
  matchesModelNameRule,
  modelRuleFamilies,
  normalizeModelNameHaystack,
  resolveModelFamily,
} from '../lib/model-alias-policy.js';
import {
  buildModelPickFavoriteDiagnosis,
  describeRoleRejection,
  listRolesForModel,
  selectModelPick,
} from '../lib/model-role-profiles.js';

test('name boundaries: sol does not match resolution, solar, or solomon', () => {
  assert.equal(matchesModelFamily('resolution-7b', 'sol'), false);
  assert.equal(matchesModelFamily('solar-v2', 'sol'), false);
  assert.equal(matchesModelFamily('gpt-6-solomon', 'sol'), false);
  assert.equal(matchesModelFamily('gpt-5.6-sol', 'sol'), true);
});

test('exact alias gpt-5.6 is Sol; gpt-5.6-luna is Luna', () => {
  assert.equal(resolveModelFamily('gpt-5.6').family, 'sol');
  assert.equal(resolveModelFamily('gpt-5.6-luna').family, 'luna');
  assert.notEqual(resolveModelFamily('gpt-5.6-luna').family, 'sol');
});

test('override grammar: sub, exact, re, and deny', () => {
  const deny = compileModelNameRule({ pattern: '!sol', operator: true, priority: 0 });
  assert.ok(deny);
  assert.equal(matchesModelNameRule(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (deny), 'gpt-5.6-sol'), true);
  const exact = compileModelNameRule({ pattern: 'exact:gpt-5.6-sol', operator: true, priority: 1 });
  assert.equal(matchesModelNameRule(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (exact), 'gpt-5.6-sol'), true);
  assert.equal(matchesModelNameRule(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (exact), 'gpt-5.6-sol-extra'), false);
  const sub = compileModelNameRule({ pattern: 'sub:resolution', operator: true, priority: 2 });
  assert.equal(matchesModelNameRule(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (sub), 'my-resolution-model'), true);
  const re = compileModelNameRule({ pattern: 're:^gpt-6[.-]', operator: true, priority: 3 });
  assert.equal(matchesModelNameRule(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (re), 'gpt-6-foo'), true);
  assert.equal(modelRuleFamilies(/** @type {import('../lib/model-alias-policy.js').ModelNameRule} */ (re)).length, 1);
});

test('effort and variant narrowing on compiled rules', () => {
  const rules = compileModelNameRules([
    { pattern: 'sol', effort: ['low'], variant: ['preview'], operator: true, priority: 0 },
  ]);
  assert.equal(matchesModelNameRule(rules[0], 'gpt-5.6-sol-preview::effort=low'), true);
  assert.equal(matchesModelNameRule(rules[0], 'gpt-5.6-sol-preview::effort=high'), false);
  assert.equal(matchesModelNameRule(rules[0], 'gpt-5.6-sol::effort=low'), false, 'variant gate requires preview token');
});

test('unknown-family fallback: no autonomous role and neutral tier reason', () => {
  assert.equal(describeRoleRejection('totally-unknown-model-xyz', 'implement'), UNKNOWN_FAMILY_FALLBACK.reason);
  assert.equal(listRolesForModel('totally-unknown-model-xyz').length, 0);
  assert.equal(UNKNOWN_FAMILY_FALLBACK.tier, 3);
  assert.equal(normalizeModelNameHaystack('  GPT-6-SOL  '), 'gpt-6-sol');
});

test('verified Sol/Luna/Astra get implement; unverified nano grants no role from name', () => {
  assert.ok(listRolesForModel('gpt-5.6').includes('implement'));
  assert.ok(listRolesForModel('gpt-5.6-luna').includes('implement'));
  assert.ok(listRolesForModel('gpt-6-astra::effort=medium').includes('implement'));
  assert.equal(listRolesForModel('nano-hypothetical-9b').includes('implement'), false);
  assert.equal(describeRoleRejection('nano-hypothetical-9b', 'implement'), 'unverified-alias');
});

test('diagnosis lists rejection causes for non-selected favorites', () => {
  const ready = { id: 'sdk', enabled: true, ready: true, can_delegate: true };
  const disabled = { id: 'off', enabled: false, ready: true, can_delegate: true };
  const picked = selectModelPick({
    role: 'implement',
    excludeModel: 'blocked-model',
    harnesses: [ready, disabled],
    modelsByHarness: {
      sdk: {
        favorites_configured: true,
        items: [
          { id: 'blocked-model', roles: ['implement'] },
          { id: 'gpt-5.6', roles: ['implement'], cost_tier: 3, quality_tier: 5, speed_tier: 3 },
          { id: 'unknown-xyz', roles: [] },
        ],
      },
      off: {
        favorites_configured: true,
        items: [{ id: 'ignored', roles: ['implement'] }],
      },
    },
    rotation: 'off',
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, 'gpt-5.6');
  assert.ok(String(picked.policyVersion).includes('cohort=alias-policy-2026-10-08+role-policy-2026-10-08'));
  const blocked = picked.diagnosis.rows.find((row) => row.model === 'blocked-model');
  const unknown = picked.diagnosis.rows.find((row) => row.model === 'unknown-xyz');
  const winner = picked.diagnosis.rows.find((row) => row.model === 'gpt-5.6');
  const disabledRow = picked.diagnosis.rows.find((row) => row.harness === 'off');
  assert.deepEqual(blocked.filter_reasons, ['caller-excluded']);
  assert.deepEqual(unknown.filter_reasons, ['unknown-family']);
  assert.equal(winner.selected, true);
  assert.equal(winner.ranking_note, 'selected');
  assert.deepEqual(disabledRow.filter_reasons, ['harness-disabled']);
});

test('active lockout and flash-for-review never become the pick', () => {
  const ready = { id: 'sdk', enabled: true, ready: true, can_delegate: true };
  const future = new Date(Date.now() + 3600_000).toISOString();
  const locked = selectModelPick({
    role: 'implement',
    harnesses: [ready],
    modelsByHarness: {
      sdk: {
        favorites_configured: true,
        items: [
          { id: 'locked-model', roles: ['implement'] },
          { id: 'free-model', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 },
        ],
      },
    },
    history: { lockouts: [{ harness: 'sdk', model: 'locked-model', resetAt: future }] },
    rotation: 'off',
  });
  assert.equal(locked.ok, true);
  assert.equal(locked.pick.model, 'free-model');
  const lockedRow = locked.diagnosis.rows.find((row) => row.model === 'locked-model');
  assert.deepEqual(lockedRow.filter_reasons, ['active-lockout']);
  const flashReview = selectModelPick({
    role: 'review',
    harnesses: [ready],
    modelsByHarness: {
      sdk: {
        favorites_configured: true,
        items: [
          { id: 'glm-5.3-flash', roles: ['implement', 'review'] },
          { id: 'grok-4.6', roles: ['review'], cost_tier: 3, quality_tier: 4, speed_tier: 4 },
        ],
      },
    },
    rotation: 'off',
  });
  assert.equal(flashReview.pick.model, 'grok-4.6');
  const flashRow = flashReview.diagnosis.rows.find((row) => row.model === 'glm-5.3-flash');
  assert.deepEqual(flashRow.filter_reasons, ['flash-for-review']);
});

test('fresh-limit-penalty is separate from active-lockout hard filter', () => {
  const ready = { id: 'sdk', enabled: true, ready: true, can_delegate: true };
  const result = selectModelPick({
    role: 'implement',
    harnesses: [ready],
    modelsByHarness: {
      sdk: {
        favorites_configured: true,
        items: [{ id: 'gpt-5.6', roles: ['implement'], cost_tier: 3, quality_tier: 5, speed_tier: 3 }],
      },
    },
    history: { freshLimitHits: { sdk: { whole: false, models: ['gpt-5.6'] } } },
    rotation: 'off',
  });
  assert.equal(result.ok, true);
  const row = result.diagnosis.rows.find((r) => r.model === 'gpt-5.6');
  assert.equal(row.eligible, true);
  assert.deepEqual(row.filter_reasons, []);
  assert.deepEqual(row.penalties, ['fresh-limit-penalty']);
});

test('review-adapter-blocked when only favorites sit on uncertified harness', () => {
  delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
  const codex = { id: 'codex', enabled: true, ready: true, can_delegate: true };
  const blocked = selectModelPick({
    role: 'review',
    harnesses: [codex],
    modelsByHarness: {
      codex: {
        favorites_configured: true,
        items: [{ id: 'glm-5.3', roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 4 }],
      },
    },
    diagnosisInput: { checkReviewAdapter: true },
    rotation: 'off',
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /review adapter guarantee/);
  assert.doesNotMatch(blocked.error, /no delegatable harness has Settings favorites/);
  const row = blocked.diagnosis.rows.find((r) => r.harness === 'codex');
  assert.deepEqual(row.filter_reasons, ['review-adapter-blocked']);
});

test('rejection causes stay distinct: harness-disabled, no-favorites, lockout, adapter', () => {
  delete process.env.CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED;
  const disabled = { id: 'off', enabled: false, ready: true, can_delegate: true };
  const codex = { id: 'codex', enabled: true, ready: true, can_delegate: true };
  const sdk = { id: 'sdk', enabled: true, ready: true, can_delegate: true };
  const future = new Date(Date.now() + 3600_000).toISOString();
  const mixed = selectModelPick({
    role: 'review',
    harnesses: [disabled, codex, sdk],
    modelsByHarness: {
      off: {
        favorites_configured: true,
        items: [{ id: 'ignored', roles: ['review'] }],
      },
      codex: {
        favorites_configured: true,
        items: [{ id: 'glm-5.3', roles: ['review'] }],
      },
      sdk: {
        favorites_configured: false,
        items: [{ id: 'grok-4.6', roles: ['review'] }],
      },
    },
    history: { lockouts: [{ harness: 'sdk', model: 'locked-only', resetAt: future }] },
    diagnosisInput: { checkReviewAdapter: true },
    rotation: 'off',
  });
  assert.equal(mixed.ok, false);
  assert.deepEqual(
    mixed.diagnosis.rows.find((r) => r.harness === 'off').filter_reasons,
    ['harness-disabled'],
  );
  assert.deepEqual(
    mixed.diagnosis.rows.find((r) => r.harness === 'codex').filter_reasons,
    ['review-adapter-blocked'],
  );
  assert.deepEqual(
    mixed.diagnosis.rows.find((r) => r.harness === 'sdk').filter_reasons,
    ['no-favorites'],
  );
});
