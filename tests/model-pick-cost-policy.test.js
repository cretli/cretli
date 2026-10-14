import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canaryBucketOf,
  evaluateCandidatePolicy,
  evaluateCanaryRollback,
  isCanaryEligible,
  loadCostPolicyState,
  normalizeCostPolicyConfig,
  normalizeCostPolicyRecord,
  resolveEffectivePolicyMode,
} from '../lib/model-pick-cost-policy.js';
import { applyCostPolicyLayer, loadCanaryOutcomeCounters } from '../lib/model-pick-cost-policy-layer.js';
import { summarizeCostPolicy } from '../lib/mcp/builtin/catalog-tools.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import { buildCostProxyForPick } from '../lib/model-pick-cost-proxy.js';

const cand = (model, cost, quality, extra = {}) => ({
  harness: 'claude', model, cost_tier: cost, quality_tier: quality, ...extra,
});

/** Picker stub: first non-excluded fixture wins, the rest are candidates. */
function makeSelect(fixture) {
  return (input) => {
    const ex = new Set((input.excludePairs || []).map((r) => `${r.harness}/${r.model}`));
    const left = fixture.filter((c) => !ex.has(`${c.harness}/${c.model}`));
    if (left.length === 0) return { ok: false, code: 'MODEL_UNAVAILABLE', error: 'none' };
    return { ok: true, pick: left[0], picks: [left[0]], candidates: left };
  };
}

const base = (fixture, extra = {}) => ({
  role: 'implement',
  selectModelPick: makeSelect(fixture),
  history: {},
  explore: false,
  shadow: false,
  overrides: false,
  leafBody: '',
  leafSize: 'small',
  leafExists: () => true,
  costPolicyState: { canaryStartedAt: '', rolledBackAt: '', rollbackReasons: [], counters: { canary: { n: 0, noCandidate: 0 }, control: { n: 0, noCandidate: 0 } } },
  ...extra,
});
const enforce = normalizeCostPolicyConfig({ mode: 'enforce', canary: { enabled: false } });
const shadow = normalizeCostPolicyConfig({ mode: 'shadow' });

test('default mode is shadow', () => {
  assert.equal(normalizeCostPolicyConfig(null).mode, 'shadow');
  assert.equal(normalizeCostPolicyConfig({ mode: 'bogus' }).mode, 'shadow');
});

test('(a) shadow: 200 decisions are recorded and selection is unchanged', () => {
  const fixture = [cand('opus-x', 4, 5), cand('sonnet-x', 3, 4), cand('haiku-x', 1, 3)];
  let changed = 0;
  for (let i = 0; i < 200; i += 1) {
    const r = pickModelForPurpose(base(fixture, { costPolicyConfig: shadow, chatId: `c${i}`, leafId: `l${i}` }));
    assert.equal(r.pick.model, 'opus-x');
    assert.equal(r.cost_policy.mode, 'shadow');
    assert.equal(r.cost_policy.applied, false);
    assert.ok(r.cost_policy.policyPick);
    if (r.cost_policy.wouldChange) changed += 1;
  }
  assert.equal(changed, 200); // trivial ceiling is 2, so opus-x would be filtered
});

test('(b) median cost_proxy of trivial/standard implement drops >=30% under the policy', () => {
  const fixture = [cand('opus-x', 4, 5), cand('sonnet-x', 3, 4), cand('haiku-x', 1, 3)];
  const cfg = {};
  const rcu = (model) => buildCostProxyForPick({
    pickResult: { picks: [cand(model, { 'opus-x': 4, 'sonnet-x': 3, 'haiku-x': 1 }[model], 3)], candidates: [] },
    role: 'implement', level: 'trivial', rows: [], roleOfRow: () => '', config: cfg.c,
  }).selected.value;
  const before = [];
  const after = [];
  for (let i = 0; i < 20; i += 1) {
    const r = pickModelForPurpose(base(fixture, { costPolicyConfig: enforce, chatId: `c${i}` }));
    before.push(rcu(r.cost_policy.counterfactualPick.split('/').slice(1).join('/')));
    after.push(rcu(r.pick.model));
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  assert.ok(median(after) <= median(before) * 0.7, `${median(after)} vs ${median(before)}`);
});

test('(b2) review/plan/demanding never pick flash, effort<medium or quality<4', () => {
  const fixture = [
    cand('glm-flash', 2, 5),
    cand('grok-4.7::reasoning_effort=low', 3, 5),
    cand('weak', 2, 3),
    cand('sonnet-x::effort=medium', 3, 4),
  ];
  for (const role of ['review', 'plan']) {
    const r = pickModelForPurpose(base(fixture, { role, costPolicyConfig: enforce }));
    assert.equal(r.pick.model, 'sonnet-x::effort=medium');
  }
  const d = pickModelForPurpose(base(fixture, { role: 'implement', complexity: 'demanding', costPolicyConfig: enforce }));
  assert.equal(d.pick.model, 'sonnet-x::effort=medium');
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: fixture[1], role: 'review', level: 'standard', config: enforce,
  }).reasons, ['effort_floor']);
});

test('(b3) canary: deterministic 20% bucket, eligibility, automatic rollback', () => {
  let inBucket = 0;
  for (let i = 0; i < 1000; i += 1) if (canaryBucketOf(`k${i}`) < 20) inBucket += 1;
  assert.ok(inBucket > 150 && inBucket < 250, String(inBucket));
  assert.equal(canaryBucketOf('same'), canaryBucketOf('same'));
  assert.equal(isCanaryEligible({ role: 'implement', level: 'trivial' }), true);
  assert.equal(isCanaryEligible({ role: 'review', level: 'standard' }), false);
  assert.equal(isCanaryEligible({ role: 'fix', level: 'demanding' }), false);

  const cfg = normalizeCostPolicyConfig({ mode: 'enforce' });
  const saved = [];
  const now = Date.parse('2026-10-14T10:00:00Z');
  const first = resolveEffectivePolicyMode({
    config: cfg, state: loadCostPolicyState({ file: '/nonexistent' }), role: 'implement', level: 'standard',
    pickKey: 'k1', now, persistState: (s) => saved.push(s),
  });
  assert.equal(first.phase, 'canary');
  assert.ok(saved[0].canaryStartedAt);
  // Review is never enforced during the canary window.
  const review = resolveEffectivePolicyMode({
    config: cfg, state: saved[0], role: 'review', level: 'standard', pickKey: 'k', now,
  });
  assert.equal(review.mode, 'shadow');
  // Window over -> full enforce.
  const later = resolveEffectivePolicyMode({
    config: cfg, state: saved[0], role: 'review', level: 'standard', pickKey: 'k', now: now + 8 * 86400000,
  });
  assert.equal(later.mode, 'enforce');
  // Metrics breach -> rollback to shadow, state persisted with the reason.
  const bad = { canary: { n: 40, failReview: 20, noCandidate: 0, infraFail: 0 }, control: { n: 40, failReview: 4, noCandidate: 0, infraFail: 0 } };
  assert.deepEqual(evaluateCanaryRollback({ ...bad, config: cfg }).reasons, ['fail_review_increase']);
  const next = [];
  const rolled = resolveEffectivePolicyMode({
    config: cfg, state: saved[0], role: 'implement', level: 'standard', pickKey: 'k', now, metrics: bad,
    persistState: (s) => next.push(s),
  });
  assert.equal(rolled.mode, 'shadow');
  assert.equal(rolled.phase, 'rolled_back');
  assert.deepEqual(next[0].rollbackReasons, ['fail_review_increase']);
  const after = resolveEffectivePolicyMode({ config: cfg, state: next[0], role: 'implement', level: 'standard', pickKey: 'k', now });
  assert.equal(after.mode, 'shadow');
  assert.equal(evaluateCanaryRollback({ canary: { n: 3 }, control: { n: 3 }, config: cfg }).insufficient, true);
});

test('(c) review: MODEL_UNAVAILABLE reason cost_ceiling instead of a silent expensive pick', () => {
  const only = [cand('astra', 5, 5), cand('weak', 2, 3)];
  const r = pickModelForPurpose(base(only, { role: 'review', costPolicyConfig: enforce }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MODEL_UNAVAILABLE');
  assert.equal(r.reason, 'cost_ceiling');
  assert.ok(r.cost_policy.rejected.length >= 1);
  // Two different base models stay available for a refine loop.
  const pool = [cand('opus-x', 4, 5), cand('sonnet-x', 3, 4), cand('weak', 2, 3)];
  const p = pickModelForPurpose(base(pool, { role: 'review', costPolicyConfig: enforce }));
  const ok = p.candidates.map((c) => c.model).filter((m) => m !== 'weak');
  assert.deepEqual(ok.sort(), ['opus-x', 'sonnet-x']);
});

test('(c) quality floor relaxes by one only for implement/fix trivial/standard', () => {
  const pool = [cand('q2', 2, 2)];
  const impl = pickModelForPurpose(base(pool, { complexity: 'standard', costPolicyConfig: enforce }));
  assert.equal(impl.ok, true);
  assert.equal(impl.cost_policy.qualityRelaxed, true);
  const rev = pickModelForPurpose(base(pool, { role: 'review', costPolicyConfig: enforce }));
  assert.equal(rev.ok, false);
  // The ceiling is never relaxed.
  const exp = pickModelForPurpose(base([cand('opus-x', 4, 5)], { costPolicyConfig: enforce }));
  assert.equal(exp.ok, false);
  assert.equal(exp.reason, 'cost_ceiling');
});

test('(d) enforce: tier 5 only for demanding + heavy/premium; manual_only never', () => {
  const pool = [cand('astra', 5, 5), cand('sonnet-x', 3, 4)];
  const cfg = normalizeCostPolicyConfig({ mode: 'enforce', canary: { enabled: false } });
  const plain = pickModelForPurpose(base(pool, { role: 'review', costPolicyConfig: cfg }));
  assert.equal(plain.pick.model, 'sonnet-x');
  const standardPremium = pickModelForPurpose(base(pool, { role: 'review', premium: true, costPolicyConfig: cfg }));
  assert.equal(standardPremium.pick.model, 'sonnet-x'); // not demanding
  const heavy = pickModelForPurpose(base(pool, { role: 'review', heavy: true, costPolicyConfig: cfg }));
  assert.equal(heavy.pick.model, 'astra');
  const prem = pickModelForPurpose(base(pool, { role: 'review', complexity: 'demanding', premium: true, costPolicyConfig: cfg }));
  assert.equal(prem.pick.model, 'astra');
  const manual = normalizeCostPolicyConfig({
    mode: 'enforce', canary: { enabled: false }, modelPolicy: { models: { astra: 'manual_only', 'heavy-x': 'heavy_only' } },
  });
  const m = pickModelForPurpose(base(pool, { role: 'review', heavy: true, premium: true, costPolicyConfig: manual }));
  assert.equal(m.pick.model, 'sonnet-x');
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: cand('heavy-x', 3, 4), role: 'review', level: 'standard', config: manual,
  }).reasons, ['model_policy_heavy_only']);
  const neverTier5 = normalizeCostPolicyConfig({ mode: 'enforce', canary: { enabled: false }, autoPremium: 'never' });
  const h = pickModelForPurpose(base(pool, { role: 'review', heavy: true, costPolicyConfig: neverTier5 }));
  assert.equal(h.pick.model, 'sonnet-x');
});

test('(e) resolved effort variant passes through ceiling/policy/floor', () => {
  const opus = (effort, cost) => cand(`claude-opus-5-5::effort=${effort}`, cost, 5);
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: opus('low', 4), role: 'review', level: 'standard', config: enforce,
  }).reasons, ['effort_floor']);
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: opus('max', 5), role: 'review', level: 'standard', config: enforce,
  }).reasons, ['tier5_not_allowed']);
  assert.equal(evaluateCandidatePolicy({
    candidate: opus('max', 5), role: 'review', level: 'demanding', heavy: true, config: enforce,
  }).allowed, true);
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: opus('high', 4), role: 'implement', level: 'trivial', config: enforce,
  }).reasons, ['cost_ceiling']);
});

test('(f) fixture: infra 43% over n=23 is degraded for review but not implement', () => {
  const flaky = cand('astra-like', 3, 5, { observed: { n: 23, infra_fail_rate: 0.43 } });
  assert.deepEqual(evaluateCandidatePolicy({
    candidate: flaky, role: 'review', level: 'standard', config: enforce,
  }).reasons, ['infra_fail_ceiling']);
  assert.equal(evaluateCandidatePolicy({
    candidate: flaky, role: 'implement', level: 'standard', config: enforce,
  }).allowed, true);
  const r = pickModelForPurpose(base([flaky, cand('sonnet-x', 3, 4)], { role: 'review', costPolicyConfig: enforce }));
  assert.equal(r.pick.model, 'sonnet-x');
});

test('record normalizer keeps only closed codes and ids', () => {
  const rec = normalizeCostPolicyRecord({
    mode: 'shadow', pickReasons: ['cost_ceiling', 'free text'], policyPick: 'a/b',
    rejected: [{ candidateId: 'x', reasons: ['quality_floor', 'prompt text'] }], leaf: 'secret',
  });
  assert.deepEqual(rec.pickReasons, ['cost_ceiling']);
  assert.deepEqual(rec.rejected[0].reasons, ['quality_floor']);
  assert.equal('leaf' in rec, false);
  assert.equal(normalizeCostPolicyRecord({ mode: 'x' }), null);
});

test('off mode leaves the result without cost_policy', () => {
  const r = pickModelForPurpose(base([cand('a', 4, 5)], { costPolicyConfig: normalizeCostPolicyConfig({ mode: 'off' }) }));
  assert.equal(r.cost_policy, undefined);
  assert.equal(r.pick.model, 'a');
});

test('config loads from the operator file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify({ complexityPolicy: { mode: 'enforce', ceilings: { implement: { trivial: 1 } } } }));
  return import('../lib/model-pick-cost-policy.js').then(({ loadCostPolicyConfig }) => {
    const c = loadCostPolicyConfig({ filePath: file });
    assert.equal(c.mode, 'enforce');
    assert.equal(c.ceilings.implement.trivial, 1);
    assert.equal(c.ceilings.implement.standard, 3);
  });
});

// ---- L3 fix round: outcome wiring, bucket key, summary, invalid start ----

const enforceCanary = normalizeCostPolicyConfig({ mode: 'enforce' });
const t0 = Date.parse('2026-10-14T10:00:00Z');
const startedState = () => ({
  canaryStartedAt: new Date(t0).toISOString(),
  rolledBackAt: '',
  rollbackReasons: [],
  counters: { canary: { n: 0, noCandidate: 0 }, control: { n: 0, noCandidate: 0 } },
});
const firstOk = { ok: true, pick: cand('cheap', 1, 3), picks: [cand('cheap', 1, 3)], candidates: [] };

/** Stored pick records + delegation rows: `failing` of 25 per bucket go bad. */
function storedOutcomes(kind, canaryBad, controlBad) {
  const records = [];
  const delegations = [];
  for (const [bucket, bad] of [['canary', canaryBad], ['control', controlBad]]) {
    for (let i = 0; i < 25; i += 1) {
      const id = `${bucket}-${i}`;
      records.push({
        id, role: 'implement', leafId: `leaf-${id}`, createdAt: new Date(t0 + 1000 + i).toISOString(),
        costPolicy: { bucket },
      });
      const isBad = i < bad;
      if (kind === 'infra') {
        delegations.push({
          pickId: id, assignment: 'implement', status: isBad ? 'failed' : 'completed',
          report: isBad ? '' : 'Done. All criteria met.',
        });
      } else {
        delegations.push({ pickId: id, assignment: 'implement', status: 'completed', report: 'Done.' });
        delegations.push({
          assignment: 'review', leafId: `leaf-${id}`, status: 'completed',
          report: isBad ? 'findings\nVERDICT: FAIL' : 'VERDICT: PASS',
        });
      }
    }
  }
  return { records, delegations };
}

for (const kind of ['review', 'infra']) {
  test(`(L3 F1) rollback fires from stored ${kind} outcomes, not injected metrics`, () => {
    const { records, delegations } = storedOutcomes(kind, 15, 2);
    const saved = [];
    const out = applyCostPolicyLayer({
      role: 'implement', chatId: 'c', complexityLevel: 'standard', costPolicyConfig: enforceCanary,
      costPolicyState: startedState(), costPolicyRecords: records, costPolicyDelegations: delegations,
      now: t0 + 60_000, leafExists: false,
    }, firstOk, () => firstOk);
    assert.equal(out.cost_policy.phase, 'rolled_back');
    assert.equal(out.cost_policy.mode, 'shadow');
    assert.deepEqual(out.cost_policy.rollbackReasons, [kind === 'review' ? 'fail_review_increase' : 'infra_fail_increase']);
    assert.equal(saved.length, 0);
  });
}

test('(L3 F1) healthy stored outcomes keep the canary; unreadable stores never fail a pick', () => {
  const { records, delegations } = storedOutcomes('infra', 2, 2);
  const ok = applyCostPolicyLayer({
    role: 'implement', chatId: 'c', complexityLevel: 'standard', costPolicyConfig: enforceCanary,
    costPolicyState: startedState(), costPolicyRecords: records, costPolicyDelegations: delegations,
    now: t0 + 60_000,
  }, firstOk, () => firstOk);
  assert.equal(ok.cost_policy.phase, 'canary');
  assert.equal(loadCanaryOutcomeCounters({ startedAtMs: t0, records: [{ get costPolicy() { throw new Error('boom'); } }] }), null);
});

test('(L3 F2) bucket key spreads over workspaces and leaves', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) {
    const out = applyCostPolicyLayer({
      role: 'implement', workspaceFolder: `/ws/${i}`, leafId: `leaf-${i}`, complexityLevel: 'standard',
      costPolicyConfig: normalizeCostPolicyConfig({ mode: 'enforce', canary: { percent: 50 } }),
      costPolicyState: startedState(), costPolicyOutcomes: null, now: t0 + 1000,
    }, firstOk, () => firstOk);
    seen.add(out.cost_policy.bucket);
  }
  assert.ok(seen.has('canary') && seen.has('control'), [...seen].join());
});

test('(L3 F5) invalid canaryStartedAt fails safe to shadow/rolled_back', () => {
  const persisted = [];
  const r = resolveEffectivePolicyMode({
    config: enforceCanary, state: { ...startedState(), canaryStartedAt: 'not-a-date' },
    role: 'implement', level: 'standard', pickKey: 'k', now: t0, persistState: (s) => persisted.push(s),
  });
  assert.equal(r.mode, 'shadow');
  assert.equal(r.phase, 'rolled_back');
  assert.ok(persisted[0].rolledBackAt);
});

test('(L3 F3) MCP cost_policy summary is compact and closed', () => {
  const s = summarizeCostPolicy({ mode: 'enforce', configured: 'enforce', bucket: 'canary', wouldChange: true, applied: true, rejected: [{}] });
  assert.deepEqual(s, { mode: 'enforce', configured: 'enforce', canary_bucket: true, decision: 'changed' });
});
